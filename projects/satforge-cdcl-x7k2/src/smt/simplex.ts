// The arithmetic theory: a from-scratch *general simplex* in the style of
// Dutertre & de Moura, "A Fast Linear-Arithmetic Solver for DPLL(T)" (2006).
//
// • Exact arithmetic throughout — no floats. Strict inequalities are handled by
//   δ-rationals: a bound value is c + k·δ where δ is a symbolic infinitesimal,
//   so `x < 3` becomes `x ≤ 3 − δ` and the ordering stays total and exact.
// • Each atom Σcⱼxⱼ + k ⋈ 0 becomes a *bound* on a variable: directly on xᵥ when
//   the combination is a single variable, otherwise on a fresh auxiliary sₐ with
//   a tableau row sₐ = Σcⱼxⱼ. Pivoting (Bland's rule, so no cycling) restores a
//   feasible assignment or proves infeasibility.
// • On infeasibility the violated row yields a **minimal explanation**: the bound
//   that can't be met plus the opposing bound of every non-basic in that row.
// • Integers (QF_LIA) are decided by branch-and-bound on top of the rational
//   relaxation.

import { Rational } from './rational'
import type { Atom, LinExpr, Term } from './term'
import type { TheoryLit, TheoryResult } from './euf'

// ---- δ-rationals -------------------------------------------------------------
class Delta {
  readonly c: Rational
  readonly k: Rational
  constructor(c: Rational, k: Rational) {
    this.c = c
    this.k = k
  }
  static of(c: Rational, k: Rational = Rational.ZERO): Delta {
    return new Delta(c, k)
  }
  add(o: Delta): Delta {
    return new Delta(this.c.add(o.c), this.k.add(o.k))
  }
  sub(o: Delta): Delta {
    return new Delta(this.c.sub(o.c), this.k.sub(o.k))
  }
  scale(r: Rational): Delta {
    return new Delta(this.c.mul(r), this.k.mul(r))
  }
  cmp(o: Delta): number {
    const dc = this.c.cmp(o.c)
    return dc !== 0 ? dc : this.k.cmp(o.k)
  }
  lt(o: Delta) {
    return this.cmp(o) < 0
  }
  gt(o: Delta) {
    return this.cmp(o) > 0
  }
  eq(o: Delta) {
    return this.cmp(o) === 0
  }
}

interface Bound {
  val: Delta
  reason: TheoryLit
}

export interface ArithModel {
  values: Map<number, Rational> // problem-variable term id → value
}

export class SimplexSolver {
  private tm: { arithVars: Map<number, Term> }
  constructor(tm: { arithVars: Map<number, Term> }) {
    this.tm = tm
  }

  owns(atom: Atom): boolean {
    return atom.kind === 'arith'
  }

  // per-check state -----------------------------------------------------------
  private idx = new Map<string, number>() // external key → internal var index
  private isInt: boolean[] = []
  private termId: (number | null)[] = [] // internal var → problem term id (null for aux)
  private lower: (Bound | null)[] = []
  private upper: (Bound | null)[] = []
  private beta: Delta[] = []
  private basic: boolean[] = []
  private row: Map<number, Rational>[] = [] // for basic vars: var → coeffs over non-basics
  private nVars = 0

  private fresh(key: string, isInt: boolean, tid: number | null): number {
    const hit = this.idx.get(key)
    if (hit !== undefined) return hit
    const i = this.nVars++
    this.idx.set(key, i)
    this.isInt[i] = isInt
    this.termId[i] = tid
    this.lower[i] = null
    this.upper[i] = null
    this.beta[i] = Delta.of(Rational.ZERO)
    this.basic[i] = false
    this.row[i] = new Map()
    return i
  }

  private reset(): void {
    this.idx.clear()
    this.isInt = []
    this.termId = []
    this.lower = []
    this.upper = []
    this.beta = []
    this.basic = []
    this.row = []
    this.nVars = 0
  }

  // ---- public model (after a satisfiable check) ------------------------------
  lastModel: ArithModel | null = null

  describeModel(lits: TheoryLit[]): string[] {
    const r = this.check(lits)
    if (!r.ok || !this.lastModel) return []
    const out: string[] = []
    for (const [tid, v] of this.lastModel.values) {
      const t = this.tm.arithVars.get(tid)
      if (t) out.push(`${'op' in t ? (t as Term).op : tid} = ${v.toString()}`)
    }
    return out.sort()
  }

  // ---- main check ------------------------------------------------------------
  check(lits: TheoryLit[]): TheoryResult {
    this.reset()
    this.lastModel = null
    const arithLits = lits.filter((l) => l.atom.kind === 'arith') as {
      atom: Extract<Atom, { kind: 'arith' }>
      value: boolean
    }[]

    // 1) create problem variables for every term id mentioned.
    const varIsInt = (tid: number): boolean => this.tm.arithVars.get(tid)?.sort === 'Int'
    for (const l of arithLits) for (const v of l.atom.lin.coeffs.keys()) this.fresh(`x${v}`, varIsInt(v), v)

    // 2) translate each literal to a bound; collect conflicts from constants.
    interface Pending {
      v: number
      isUpper: boolean
      val: Delta
      reason: TheoryLit
    }
    const pend: Pending[] = []
    for (const l of arithLits) {
      const { atom, value } = l
      if (atom.rel === 'eq0' && !value) continue // ≠ handled by the trilemma split
      const b = this.toBound(atom.lin, atom.rel, value)
      if (b === 'unsat-const') return { ok: false, conflict: [l] }
      if (b === 'taut-const') continue
      pend.push(...b.map((x) => ({ ...x, reason: l })))
    }

    // 3) assert bounds (non-basic only at this point); detect direct l>u clashes.
    for (const p of pend) {
      const clash = this.assertBound(p.v, p.isUpper, p.val, p.reason)
      if (clash) return { ok: false, conflict: clash }
    }

    // 4) restore feasibility by pivoting.
    const conflict = this.solveRational()
    if (conflict) return { ok: false, conflict }

    // 5) integer feasibility (branch & bound) if any integer variables exist.
    if (this.isInt.some(Boolean)) {
      const intRes = this.branchAndBound(0)
      if (intRes === 'unsat') return { ok: false, conflict: this.allLits(arithLits) }
      if (intRes === 'unknown') return { ok: false, unknown: true }
    }

    // 6) record the model.
    const values = new Map<number, Rational>()
    for (let i = 0; i < this.nVars; i++) {
      const tid = this.termId[i]
      if (tid !== null) values.set(tid, this.beta[i].c)
    }
    this.lastModel = { values }
    return { ok: true }
  }

  private allLits(arithLits: { atom: Atom; value: boolean }[]): TheoryLit[] {
    return arithLits.map((l) => ({ atom: l.atom, value: l.value }))
  }

  // Translate (lin rel 0, value) into bound(s) on a variable.
  private toBound(
    lin: LinExpr,
    rel: 'le' | 'lt' | 'eq0',
    value: boolean,
  ): { v: number; isUpper: boolean; val: Delta }[] | 'unsat-const' | 'taut-const' {
    const entries = [...lin.coeffs.entries()]
    const rhs = lin.constant.neg() // Σcⱼxⱼ ⋈ rhs
    if (entries.length === 0) {
      return this.constHolds(Rational.ZERO, rhs, rel, value) ? 'taut-const' : 'unsat-const'
    }
    let v: number
    let value0: Rational
    let flip: boolean
    if (entries.length === 1) {
      const [tid, c] = entries[0]
      v = this.idx.get(`x${tid}`)!
      value0 = rhs.div(c) // c·x ⋈ rhs → x ⋈' rhs/c
      flip = c.sign() < 0 // dividing by a negative flips the comparator
    } else {
      const key = 'a' + entries.map(([t, c]) => `${t}:${c.toString()}`).join(',')
      const allInt = entries.every(([t]) => this.tm.arithVars.get(t)?.sort === 'Int')
      v = this.idx.get(key) ?? this.makeAux(key, entries, allInt)
      value0 = rhs
      flip = false
    }
    // Comparator on the (single, coeff-1) variable.
    let cmp: 'le' | 'lt' | 'ge' | 'gt' | 'eq'
    if (rel === 'eq0') cmp = 'eq'
    else if (rel === 'le') cmp = value ? 'le' : 'gt'
    else cmp = value ? 'lt' : 'ge'
    if (flip) cmp = flipCmp(cmp)
    switch (cmp) {
      case 'le':
        return [{ v, isUpper: true, val: Delta.of(value0) }]
      case 'lt':
        return [{ v, isUpper: true, val: Delta.of(value0, Rational.of(-1n)) }]
      case 'ge':
        return [{ v, isUpper: false, val: Delta.of(value0) }]
      case 'gt':
        return [{ v, isUpper: false, val: Delta.of(value0, Rational.ONE) }]
      case 'eq':
        return [
          { v, isUpper: true, val: Delta.of(value0) },
          { v, isUpper: false, val: Delta.of(value0) },
        ]
    }
  }

  private makeAux(key: string, entries: [number, Rational][], allInt: boolean): number {
    const s = this.fresh(key, allInt, null)
    // s is basic with row s = Σ cⱼ xⱼ over the (non-basic) problem vars.
    const r = new Map<number, Rational>()
    for (const [tid, c] of entries) r.set(this.idx.get(`x${tid}`)!, c)
    this.basic[s] = true
    this.row[s] = r
    // β(s) = Σ cⱼ β(xⱼ)
    let val = Delta.of(Rational.ZERO)
    for (const [j, c] of r) val = val.add(this.beta[j].scale(c))
    this.beta[s] = val
    return s
  }

  private constHolds(lhs: Rational, rhs: Rational, rel: 'le' | 'lt' | 'eq0', value: boolean): boolean {
    let holds: boolean
    if (rel === 'eq0') holds = lhs.eq(rhs)
    else if (rel === 'le') holds = lhs.le(rhs)
    else holds = lhs.lt(rhs)
    return value ? holds : !holds
  }

  // assertBound: tighten l/u of variable v. Returns a conflict (two lits) if the
  // bounds cross. Updates β of non-basic v (and dependent basics) to stay within.
  private assertBound(v: number, isUpper: boolean, val: Delta, reason: TheoryLit): TheoryLit[] | null {
    if (isUpper) {
      if (this.upper[v] && !val.lt(this.upper[v]!.val)) {
        /* not tighter */
      } else this.upper[v] = { val, reason }
      if (this.lower[v] && this.upper[v]!.val.lt(this.lower[v]!.val))
        return dedupe([this.lower[v]!.reason, this.upper[v]!.reason])
      if (!this.basic[v] && this.beta[v].gt(this.upper[v]!.val)) this.updateBeta(v, this.upper[v]!.val)
    } else {
      if (this.lower[v] && !val.gt(this.lower[v]!.val)) {
        /* not tighter */
      } else this.lower[v] = { val, reason }
      if (this.upper[v] && this.upper[v]!.val.lt(this.lower[v]!.val))
        return dedupe([this.lower[v]!.reason, this.upper[v]!.reason])
      if (!this.basic[v] && this.beta[v].lt(this.lower[v]!.val)) this.updateBeta(v, this.lower[v]!.val)
    }
    return null
  }

  // Set non-basic v to value `to`, updating every basic that depends on it.
  private updateBeta(v: number, to: Delta): void {
    const delta = to.sub(this.beta[v])
    for (let i = 0; i < this.nVars; i++) {
      if (this.basic[i]) {
        const c = this.row[i].get(v)
        if (c) this.beta[i] = this.beta[i].add(delta.scale(c))
      }
    }
    this.beta[v] = to
  }

  // ---- the simplex feasibility loop (Bland's rule) --------------------------
  private solveRational(): TheoryLit[] | null {
    const MAX = 100000
    for (let iter = 0; iter < MAX; iter++) {
      // find the smallest-index basic var violating a bound.
      let vi = -1
      let below = false
      for (let i = 0; i < this.nVars; i++) {
        if (!this.basic[i]) continue
        if (this.lower[i] && this.beta[i].lt(this.lower[i]!.val)) {
          vi = i
          below = true
          break
        }
        if (this.upper[i] && this.beta[i].gt(this.upper[i]!.val)) {
          vi = i
          below = false
          break
        }
      }
      if (vi === -1) return null // feasible

      const r = this.row[vi]
      // pick smallest-index suitable non-basic to pivot.
      let xj = -1
      let inc = false // are we increasing xj?
      for (const [j, a] of [...r.entries()].sort((x, y) => x[0] - y[0])) {
        const aPos = a.sign() > 0
        // to raise β(vi) (below): increase xj if a>0 (and xj can rise) or decrease if a<0
        // to lower β(vi) (above): decrease xj if a>0 or increase if a<0
        const raise = below
        const wantIncrease = raise ? aPos : !aPos
        if (wantIncrease) {
          if (!this.upper[j] || this.beta[j].lt(this.upper[j]!.val)) {
            xj = j
            inc = true
            break
          }
        } else {
          if (!this.lower[j] || this.beta[j].gt(this.lower[j]!.val)) {
            xj = j
            inc = false
            break
          }
        }
      }
      if (xj === -1) {
        // no suitable pivot → infeasible. Build explanation.
        return this.explain(vi, below)
      }
      void inc
      this.pivotAndUpdate(vi, xj, below)
    }
    return null // give up (treat as feasible; shouldn't happen with Bland's rule)
  }

  // Move non-basic xj so basic xi reaches `target`, update every β using the OLD
  // tableau, then algebraically pivot xi out / xj in (Dutertre & de Moura).
  private pivotAndUpdate(xi: number, xj: number, below: boolean): void {
    const target = below ? this.lower[xi]!.val : this.upper[xi]!.val
    const aij = this.row[xi].get(xj)!
    const theta = target.sub(this.beta[xi]).scale(Rational.ONE.div(aij))
    this.beta[xi] = target
    this.beta[xj] = this.beta[xj].add(theta)
    for (let k = 0; k < this.nVars; k++) {
      if (k === xi || !this.basic[k]) continue
      const akj = this.row[k].get(xj)
      if (akj) this.beta[k] = this.beta[k].add(theta.scale(akj))
    }
    this.pivot(xi, xj)
  }

  // Algebraic pivot: swap roles of basic xi and non-basic xj in the tableau.
  private pivot(xi: number, xj: number): void {
    const r = this.row[xi]
    const a = r.get(xj)!
    // xi = Σ_{k} a_k x_k  (k over non-basics incl. xj)
    // ⇒ xj = (1/a)(xi − Σ_{k≠j} a_k x_k)
    const newRow = new Map<number, Rational>()
    const invA = Rational.ONE.div(a)
    newRow.set(xi, invA)
    for (const [k, ak] of r) {
      if (k === xj) continue
      newRow.set(k, ak.mul(invA).neg())
    }
    this.basic[xi] = false
    this.row[xi] = new Map()
    this.basic[xj] = true
    this.row[xj] = newRow
    // substitute xj's new expression into every other basic row that referenced xj.
    for (let i = 0; i < this.nVars; i++) {
      if (i === xj || !this.basic[i]) continue
      const ri = this.row[i]
      const coeff = ri.get(xj)
      if (!coeff) continue
      ri.delete(xj)
      for (const [k, v] of newRow) {
        const cur = ri.get(k) ?? Rational.ZERO
        const sum = cur.add(v.mul(coeff))
        if (sum.isZero()) ri.delete(k)
        else ri.set(k, sum)
      }
    }
  }

  // Build the conflict explanation for an infeasible basic xi.
  private explain(xi: number, below: boolean): TheoryLit[] {
    const out: TheoryLit[] = []
    out.push(below ? this.lower[xi]!.reason : this.upper[xi]!.reason)
    for (const [j, a] of this.row[xi]) {
      const aPos = a.sign() > 0
      // mirror of the pivot-selection: the non-basics that are "stuck".
      const wantIncrease = below ? aPos : !aPos
      if (wantIncrease) {
        if (this.upper[j]) out.push(this.upper[j]!.reason)
      } else {
        if (this.lower[j]) out.push(this.lower[j]!.reason)
      }
    }
    return dedupe(out)
  }

  // ---- integer branch & bound -----------------------------------------------
  private branchAndBound(depth: number): 'sat' | 'unsat' | 'unknown' {
    if (depth > 64) return 'unknown'
    // find an integer var with a fractional value.
    let v = -1
    for (let i = 0; i < this.nVars; i++) {
      if (this.isInt[i] && this.beta[i].k.isZero() && !this.beta[i].c.isInteger()) {
        v = i
        break
      }
    }
    if (v === -1) {
      // also reject δ-valued integer vars (shouldn't be integral)
      for (let i = 0; i < this.nVars; i++) if (this.isInt[i] && !this.beta[i].k.isZero()) v = i
      if (v === -1) return 'sat'
    }
    const frac = this.beta[v].c
    const fl = frac.floor()
    const ce = frac.ceil()
    // Snapshot, branch x ≤ floor.
    const snap = this.snapshot()
    const dummy: TheoryLit = { atom: { id: -1, kind: 'arith', rel: 'le', lin: { coeffs: new Map(), constant: Rational.ZERO } }, value: true }
    if (!this.assertBound(v, true, Delta.of(Rational.of(fl)), dummy)) {
      if (!this.solveRational()) {
        const res = this.branchAndBound(depth + 1)
        if (res !== 'unsat') return res
      }
    }
    this.restore(snap)
    // branch x ≥ ceil.
    if (!this.assertBound(v, false, Delta.of(Rational.of(ce)), dummy)) {
      if (!this.solveRational()) {
        const res = this.branchAndBound(depth + 1)
        if (res !== 'unsat') return res
      }
    }
    this.restore(snap)
    return 'unsat'
  }

  private snapshot() {
    return {
      lower: this.lower.slice(),
      upper: this.upper.slice(),
      beta: this.beta.slice(),
      basic: this.basic.slice(),
      row: this.row.map((m) => new Map(m)),
    }
  }
  private restore(s: ReturnType<SimplexSolver['snapshot']>): void {
    this.lower = s.lower.slice()
    this.upper = s.upper.slice()
    this.beta = s.beta.slice()
    this.basic = s.basic.slice()
    this.row = s.row.map((m) => new Map(m))
  }
}

function flipCmp(c: 'le' | 'lt' | 'ge' | 'gt' | 'eq'): 'le' | 'lt' | 'ge' | 'gt' | 'eq' {
  switch (c) {
    case 'le':
      return 'ge'
    case 'ge':
      return 'le'
    case 'lt':
      return 'gt'
    case 'gt':
      return 'lt'
    case 'eq':
      return 'eq'
  }
}

function dedupe(lits: TheoryLit[]): TheoryLit[] {
  const seen = new Set<string>()
  const out: TheoryLit[] = []
  for (const l of lits) {
    if (l.atom.id < 0) continue
    const k = `${l.atom.id}:${l.value}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(l)
  }
  return out
}
