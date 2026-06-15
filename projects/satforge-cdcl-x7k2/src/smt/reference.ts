// Independent reference decision procedures, used only by the test harness to
// cross-check the DPLL(T) solver. They are deliberately written with totally
// different algorithms than the solver, so agreement is real evidence.
//
//   • EUF: enumerate *every* congruence on the set of subterms (all set
//     partitions, filtered to those closed under congruence) and check whether
//     any makes the formula true. This is a sound & complete decision procedure
//     for ground equality logic — and shares no code with congruence closure.
//
//   • Arithmetic: enumerate every truth assignment to the relation atoms and
//     test the resulting conjunction of linear constraints for feasibility by
//     Fourier–Motzkin elimination over the rationals — again, nothing in common
//     with the simplex.

import { Rational } from './rational'
import type { Atom, Formula, LinExpr, Term } from './term'

// ---- generic formula evaluation ---------------------------------------------
export function evalFormula(f: Formula, atomVal: (a: Atom) => boolean): boolean {
  switch (f.kind) {
    case 'const':
      return f.val
    case 'not':
      return !evalFormula(f.arg, atomVal)
    case 'and':
      return f.args.every((g) => evalFormula(g, atomVal))
    case 'or':
      return f.args.some((g) => evalFormula(g, atomVal))
    case 'imp':
      return !evalFormula(f.a, atomVal) || evalFormula(f.b, atomVal)
    case 'iff':
      return evalFormula(f.a, atomVal) === evalFormula(f.b, atomVal)
    case 'xor':
      return evalFormula(f.a, atomVal) !== evalFormula(f.b, atomVal)
    case 'ite':
      return evalFormula(f.c, atomVal) ? evalFormula(f.t, atomVal) : evalFormula(f.e, atomVal)
    case 'pred':
    case 'eq':
    case 'arith':
      return atomVal(f)
  }
}

/** Collect the distinct atoms in a formula. */
export function collectAtoms(f: Formula, out: Atom[] = [], seen = new Set<number>()): Atom[] {
  switch (f.kind) {
    case 'const':
      break
    case 'not':
      collectAtoms(f.arg, out, seen)
      break
    case 'and':
    case 'or':
      f.args.forEach((g) => collectAtoms(g, out, seen))
      break
    case 'imp':
    case 'iff':
    case 'xor':
      collectAtoms(f.a, out, seen)
      collectAtoms(f.b, out, seen)
      break
    case 'ite':
      collectAtoms(f.c, out, seen)
      collectAtoms(f.t, out, seen)
      collectAtoms(f.e, out, seen)
      break
    case 'pred':
    case 'eq':
    case 'arith':
      if (!seen.has(f.id)) {
        seen.add(f.id)
        out.push(f)
      }
      break
  }
  return out
}

// ---- EUF reference via congruence enumeration --------------------------------
function subterms(t: Term, out: Map<number, Term>): void {
  if (out.has(t.id)) return
  out.set(t.id, t)
  for (const a of t.args) subterms(a, out)
}

/** Generate all set partitions of [0..n) as restricted-growth assignments. */
function* partitions(n: number): Generator<number[]> {
  const a = new Array(n).fill(0)
  const b = new Array(n).fill(0) // b[i] = max block id usable at position i
  const rec = function* (i: number): Generator<number[]> {
    if (i === n) {
      yield a.slice()
      return
    }
    for (let v = 0; v <= b[i] + 1; v++) {
      a[i] = v
      b[i + 1] = Math.max(b[i], v)
      yield* rec(i + 1)
    }
  }
  if (n === 0) {
    yield []
    return
  }
  yield* rec(0)
}

/** Reference SAT for an equality-only (no predicate) ground formula. */
export function referenceSatEUF(f: Formula): boolean {
  const atoms = collectAtoms(f)
  const terms = new Map<number, Term>()
  for (const a of atoms) {
    if (a.kind === 'eq') {
      subterms(a.a, terms)
      subterms(a.b, terms)
    } else {
      throw new Error('referenceSatEUF only handles equality atoms')
    }
  }
  const ids = [...terms.keys()]
  const index = new Map<number, number>()
  ids.forEach((id, i) => index.set(id, i))
  const list = ids.map((id) => terms.get(id)!)
  // Precompute, for congruence checking, groups of same-op same-arity terms.
  const apps = list.filter((t) => t.args.length > 0)

  for (const part of partitions(ids.length)) {
    // congruence closure check: f(a)~f(b) whenever args pairwise ~
    let ok = true
    for (let i = 0; i < apps.length && ok; i++) {
      for (let j = i + 1; j < apps.length; j++) {
        const u = apps[i]
        const v = apps[j]
        if (u.op !== v.op || u.args.length !== v.args.length) continue
        let argsEqual = true
        for (let k = 0; k < u.args.length; k++) {
          if (part[index.get(u.args[k].id)!] !== part[index.get(v.args[k].id)!]) {
            argsEqual = false
            break
          }
        }
        if (argsEqual && part[index.get(u.id)!] !== part[index.get(v.id)!]) {
          ok = false
          break
        }
      }
    }
    if (!ok) continue
    const val = (a: Atom): boolean => {
      if (a.kind !== 'eq') throw new Error('unexpected')
      return part[index.get(a.a.id)!] === part[index.get(a.b.id)!]
    }
    if (evalFormula(f, val)) return true
  }
  return false
}

// ---- arithmetic reference via Fourier–Motzkin --------------------------------
// A constraint is Σ cᵢ·xᵢ + k  R  0 where R ∈ {<=, <, =}.
interface Constraint {
  coeffs: Map<number, Rational>
  constant: Rational
  strict: boolean // true for <
}

function linToConstraints(lin: LinExpr, rel: 'le' | 'lt' | 'eq0', value: boolean): Constraint[] {
  // value=true asserts the relation; value=false asserts its negation.
  if (rel === 'eq0') {
    if (value) {
      // L = 0  ↔  L ≤ 0 ∧ -L ≤ 0
      return [
        { coeffs: lin.coeffs, constant: lin.constant, strict: false },
        { coeffs: negCoeffs(lin.coeffs), constant: lin.constant.neg(), strict: false },
      ]
    }
    // L ≠ 0 is not a conjunction; the caller must branch. Represent as two options
    // handled by the enumerator: we return a marker via throwing is ugly — instead
    // the enumerator never calls this with eq0 false directly; see referenceSatArith.
    throw new Error('eq0-false handled by enumerator')
  }
  const strict = rel === 'lt'
  if (value) return [{ coeffs: lin.coeffs, constant: lin.constant, strict }]
  // ¬(L ≤ 0) = L > 0 = -L < 0 ; ¬(L < 0) = L ≥ 0 = -L ≤ 0
  return [{ coeffs: negCoeffs(lin.coeffs), constant: lin.constant.neg(), strict: !strict }]
}

function negCoeffs(m: Map<number, Rational>): Map<number, Rational> {
  const out = new Map<number, Rational>()
  for (const [k, v] of m) out.set(k, v.neg())
  return out
}

/** Feasibility of a conjunction of linear constraints over ℚ by Fourier–Motzkin. */
export function feasibleFM(constraints: Constraint[], vars: number[]): boolean {
  let cs = constraints.map((c) => ({ coeffs: new Map(c.coeffs), constant: c.constant, strict: c.strict }))
  for (const x of vars) {
    const pos: Constraint[] = [] // coeff of x > 0
    const neg: Constraint[] = [] // coeff of x < 0
    const zero: Constraint[] = []
    for (const c of cs) {
      const a = c.coeffs.get(x)
      if (!a || a.isZero()) zero.push(c)
      else if (a.sign() > 0) pos.push(c)
      else neg.push(c)
    }
    const next = [...zero]
    // Eliminate x: combine each positive with each negative bound.
    for (const p of pos) {
      const ap = p.coeffs.get(x)!
      for (const n of neg) {
        const an = n.coeffs.get(x)!.abs()
        // p: ap·x + rp ≤/< 0  → x ≤ -rp/ap ; n: -an·x + rn ≤/< 0 → x ≥ rn/an
        // combine: an·p + ap·n  eliminates x.
        const coeffs = new Map<number, Rational>()
        const allVars = new Set([...p.coeffs.keys(), ...n.coeffs.keys()])
        for (const v of allVars) {
          const cv = (p.coeffs.get(v) ?? Rational.ZERO).mul(an).add((n.coeffs.get(v) ?? Rational.ZERO).mul(ap))
          if (!cv.isZero()) coeffs.set(v, cv)
        }
        coeffs.delete(x)
        const constant = p.constant.mul(an).add(n.constant.mul(ap))
        next.push({ coeffs, constant, strict: p.strict || n.strict })
      }
    }
    cs = next
  }
  // No variables left: every constraint is k R 0 with k constant.
  for (const c of cs) {
    if (c.coeffs.size > 0) continue // shouldn't happen
    const k = c.constant
    if (c.strict ? k.sign() >= 0 : k.sign() > 0) return false
  }
  return true
}

/** Reference SAT for a quantifier-free linear-arithmetic formula over ℚ. */
export function referenceSatArith(f: Formula): boolean {
  const atoms = collectAtoms(f).filter((a) => a.kind === 'arith') as Extract<Atom, { kind: 'arith' }>[]
  const vars = new Set<number>()
  for (const a of atoms) for (const v of a.lin.coeffs.keys()) vars.add(v)
  const varList = [...vars]
  const n = atoms.length
  for (let mask = 0; mask < 1 << n; mask++) {
    const val = new Map<number, boolean>()
    atoms.forEach((a, i) => val.set(a.id, (mask & (1 << i)) !== 0))
    if (!evalFormula(f, (a) => val.get(a.id)!)) continue
    // Build constraint conjunction; eq0=false needs a disjunctive branch.
    const branches: Constraint[][] = [[]]
    let feasibleBranchExists = false
    const eqFalse: Extract<Atom, { kind: 'arith' }>[] = []
    const base: Constraint[] = []
    let consistent = true
    for (const a of atoms) {
      const v = val.get(a.id)!
      if (a.rel === 'eq0' && !v) {
        eqFalse.push(a)
        continue
      }
      try {
        base.push(...linToConstraints(a.lin, a.rel, v))
      } catch {
        consistent = false
      }
    }
    if (!consistent) continue
    // Expand each L≠0 into the two strict branches L<0 or L>0.
    let frontier: Constraint[][] = [base]
    for (const a of eqFalse) {
      const nextFrontier: Constraint[][] = []
      for (const b of frontier) {
        nextFrontier.push([...b, { coeffs: a.lin.coeffs, constant: a.lin.constant, strict: true }])
        nextFrontier.push([...b, { coeffs: negCoeffs(a.lin.coeffs), constant: a.lin.constant.neg(), strict: true }])
      }
      frontier = nextFrontier
    }
    branches.length = 0
    branches.push(...frontier)
    for (const br of branches) {
      if (feasibleFM(br, varList)) {
        feasibleBranchExists = true
        break
      }
    }
    if (feasibleBranchExists) return true
  }
  return false
}
