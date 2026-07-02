// **Symbolic** CTL model checking — the same Clarke–Emerson–Sistla fixpoints as the Branching mode's
// `ctl/modelcheck.ts`, but with every *set of states* represented as a **BDD** instead of a boolean
// array, and the pre-image step done by BDD **relational-product** (`∃ next. T ∧ Y[next]`) instead of
// an explicit scan. This is exactly the leap NuSMV/SMV make: the transition relation and every
// intermediate `Sat` set is a BDD over the state bits, so a model with astronomically many states can
// still be checked whenever those sets have small BDDs.
//
// Encoding. A model with `n` states needs `k = ⌈log₂ n⌉` bits. We use `2k` variables in the classic
// **interleaved** order `s₀, s₀′, s₁, s₁′, …` (current bit, then its next-state primed copy), which
// keeps the transition-relation BDD small. A *set of states* is a BDD over the current bits; the
// *transition relation* `T(s, s′)` is a BDD over both. When `n` is not a power of two some bit
// patterns are unused, so a `valid` BDD pins every set inside the real state space — that is what makes
// "complement" (`¬`) and the greatest-fixpoint seed agree with the explicit checker state-for-state.
//
// The whole point is proved in `selftest.ts`: on random models × random formulas the decoded symbolic
// `Sat` set equals the explicit `satVector` at **every** state.

import type { Ctl } from '../ctl/formula'
import { ctlKey, subformulas, showCtl } from '../ctl/formula'
import type { CtlModel } from '../ctl/modelcheck'
import { Bdd } from './bdd'
import type { BddId } from './bdd'

/** The symbolic encoding of a (totalized) Kripke model: the BDD manager plus the relation and helpers. */
export class SymbolicModel {
  readonly m: Bdd
  readonly n: number
  readonly k: number // state bits
  readonly curVars: number[] // levels of the current-state bits (even levels)
  readonly nextVars: number[] // levels of the next-state bits (odd levels)
  readonly valid: BddId // the set of bit patterns that name a real state (⊤ when n is a power of two)
  readonly T: BddId // the transition relation T(s, s′)
  readonly init: BddId // the set of initial states
  private curToNext = new Map<number, number>()
  private nextToCur = new Map<number, number>()
  readonly model: CtlModel

  constructor(model: CtlModel) {
    this.model = model
    this.n = model.n
    this.k = Math.max(1, Math.ceil(Math.log2(Math.max(2, model.n))))
    // Interleaved variable order s0, s0', s1, s1', …
    const vars: string[] = []
    this.curVars = []
    this.nextVars = []
    for (let b = 0; b < this.k; b++) {
      this.curVars.push(vars.length)
      vars.push('s' + b)
      this.nextVars.push(vars.length)
      vars.push('s' + b + '′')
    }
    for (let b = 0; b < this.k; b++) {
      this.curToNext.set(this.curVars[b], this.nextVars[b])
      this.nextToCur.set(this.nextVars[b], this.curVars[b])
    }
    const m = new Bdd(vars)
    this.m = m

    // valid = ⋁ real state cubes over the current bits.
    let valid = 0 as BddId
    for (let i = 0; i < this.n; i++) valid = m.or(valid, this.cube(i, false))
    this.valid = valid

    // T = ⋁_{i→j} cube_i(cur) ∧ cube_j(next).
    let T = 0 as BddId
    for (let i = 0; i < this.n; i++) {
      const ci = this.cube(i, false)
      for (const j of model.succ[i]) T = m.or(T, m.and(ci, this.cube(j, true)))
    }
    this.T = T

    let init = 0 as BddId
    for (const i of model.initial) init = m.or(init, this.cube(i, false))
    this.init = init
  }

  /** The cube (conjunction of literals) that pins the state bits to state index `i`. */
  cube(i: number, next: boolean): BddId {
    const m = this.m
    const levels = next ? this.nextVars : this.curVars
    let c = 1 as BddId // ⊤
    for (let b = 0; b < this.k; b++) {
      const bit = (i >> b) & 1
      c = m.and(c, bit ? m.ithVar(levels[b]) : m.nithVar(levels[b]))
    }
    return c
  }

  /** The BDD (over current bits) of the states where atomic proposition `name` holds. */
  propBdd(name: string): BddId {
    const m = this.m
    let s = 0 as BddId
    for (let i = 0; i < this.n; i++) if (this.model.props[i].has(name)) s = m.or(s, this.cube(i, false))
    return s
  }

  // --- the set algebra, kept inside `valid` so ¬ matches the explicit checker ---

  setNot(a: BddId): BddId {
    return this.m.and(this.valid, this.m.not(a))
  }
  setAnd(a: BddId, b: BddId): BddId {
    return this.m.and(a, b)
  }
  setOr(a: BddId, b: BddId): BddId {
    return this.m.or(a, b)
  }

  /** pre∃(Y) — states with *some* successor in Y:  ∃ s′. T(s,s′) ∧ Y(s′). */
  preE(Y: BddId): BddId {
    const m = this.m
    const Ynext = m.rename(Y, this.curToNext)
    return m.exists(m.and(this.T, Ynext), this.nextVars)
  }
  /** pre∀(Y) — states *all* of whose successors are in Y (= ¬pre∃(¬Y), within `valid`). */
  preA(Y: BddId): BddId {
    return this.m.and(this.valid, this.m.not(this.preE(this.setNot(Y))))
  }
  /** post∃(X) — the forward image: states reachable in one step from X. */
  postE(X: BddId): BddId {
    const m = this.m
    const img = m.exists(m.and(X, this.T), this.curVars) // over next bits
    return m.rename(img, this.nextToCur)
  }

  /** Decode a set-BDD (over current bits) back to the list of real state indices it contains. */
  decode(set: BddId): number[] {
    const m = this.m
    const out: number[] = []
    for (let i = 0; i < this.n; i++) {
      let r = set
      for (let b = 0; b < this.k; b++) r = m.restrict(r, this.curVars[b], ((i >> b) & 1) === 1)
      if (r === 1) out.push(i) // the cube of state i is entirely inside `set`
    }
    return out
  }

  /** Is real state `i` a member of the set-BDD? */
  contains(set: BddId, i: number): boolean {
    const m = this.m
    let r = set
    for (let b = 0; b < this.k; b++) r = m.restrict(r, this.curVars[b], ((i >> b) & 1) === 1)
    return r === 1
  }
}

// ---------------------------------------------------------------------------
// Symbolic reachability — the forward state-space exploration, drawn as a chain.
// ---------------------------------------------------------------------------

export interface ReachStep {
  states: number[]
  nodes: number // BDD node count of this approximant
}
export interface Reachability {
  frontier: BddId
  chain: ReachStep[]
  states: number[]
}

/** reach = μZ. init ∨ post∃(Z) — the set of states reachable from the initial states, symbolically. */
export function symbolicReachable(sm: SymbolicModel): Reachability {
  const m = sm.m
  let Z = sm.init
  const chain: ReachStep[] = [{ states: sm.decode(Z), nodes: m.nodeCount(Z) }]
  for (;;) {
    const next = m.or(Z, sm.postE(Z))
    chain.push({ states: sm.decode(next), nodes: m.nodeCount(next) })
    if (next === Z) break // canonical ids ⇒ equality is a single comparison
    Z = next
  }
  return { frontier: Z, chain, states: sm.decode(Z) }
}

// ---------------------------------------------------------------------------
// Symbolic CTL labelling — Sat(ψ) as a BDD for every subformula.
// ---------------------------------------------------------------------------

export interface SymbolicApprox {
  states: number[]
  nodes: number
}
export interface SymbolicSub {
  key: string
  text: string
  kind: Ctl['k']
  bdd: BddId
  sat: number[] // decoded satisfying states
  nodes: number // BDD node count of Sat(ψ)
  approx?: SymbolicApprox[] // the fixpoint approximant chain (U/R/F/G)
  fixpoint?: 'least' | 'greatest'
}

export interface SymbolicLabelling {
  subs: SymbolicSub[]
  top: BddId
  holds: boolean
  initialVerdict: { state: number; holds: boolean }[]
  peakNodes: number // largest per-subformula BDD (a symbolic "cost" gauge)
}

const FIX_LEAST = new Set<Ctl['k']>(['EU', 'AU', 'EF', 'AF'])
const FIX_GREATEST = new Set<Ctl['k']>(['EG', 'AG', 'ER', 'AR'])

/** μZ. f(Z): least fixpoint over BDDs, from ⊥ upward, capturing every approximant. */
function leastFix(sm: SymbolicModel, f: (z: BddId) => BddId): [BddId, SymbolicApprox[]] {
  const m = sm.m
  let cur = 0 as BddId // ⊥
  const chain: SymbolicApprox[] = [{ states: sm.decode(cur), nodes: m.nodeCount(cur) }]
  for (;;) {
    const next = f(cur)
    chain.push({ states: sm.decode(next), nodes: m.nodeCount(next) })
    if (next === cur) return [next, chain]
    cur = next
  }
}

/** νZ. f(Z): greatest fixpoint, from `valid` (the symbolic "all states") downward. */
function greatestFix(sm: SymbolicModel, f: (z: BddId) => BddId): [BddId, SymbolicApprox[]] {
  const m = sm.m
  let cur = sm.valid
  const chain: SymbolicApprox[] = [{ states: sm.decode(cur), nodes: m.nodeCount(cur) }]
  for (;;) {
    const next = f(cur)
    chain.push({ states: sm.decode(next), nodes: m.nodeCount(next) })
    if (next === cur) return [next, chain]
    cur = next
  }
}

/** Run symbolic labelling: compute `Sat` as a BDD for every subformula, bottom-up. */
export function symbolicLabel(formula: Ctl, sm: SymbolicModel): SymbolicLabelling {
  const m = sm.m
  const byKey = new Map<string, BddId>()
  const subs: SymbolicSub[] = []

  for (const node of subformulas(formula)) {
    const key = ctlKey(node)
    if (byKey.has(key)) continue
    const A = (x: Ctl) => byKey.get(ctlKey(x))!
    let set: BddId
    let approx: SymbolicApprox[] | undefined
    switch (node.k) {
      case 'true':
        set = sm.valid
        break
      case 'false':
        set = 0
        break
      case 'atom':
        set = sm.propBdd(node.name)
        break
      case 'not':
        set = sm.setNot(A(node.a))
        break
      case 'and':
        set = sm.setAnd(A(node.a), A(node.b))
        break
      case 'or':
        set = sm.setOr(A(node.a), A(node.b))
        break
      case 'imp':
        set = sm.setOr(sm.setNot(A(node.a)), A(node.b))
        break
      case 'iff':
        set = sm.setOr(sm.setAnd(A(node.a), A(node.b)), sm.setAnd(sm.setNot(A(node.a)), sm.setNot(A(node.b))))
        break
      case 'EX':
        set = sm.preE(A(node.a))
        break
      case 'AX':
        set = sm.preA(A(node.a))
        break
      case 'EF':
        ;[set, approx] = leastFix(sm, (Z) => sm.setOr(A(node.a), sm.preE(Z)))
        break
      case 'AF':
        ;[set, approx] = leastFix(sm, (Z) => sm.setOr(A(node.a), sm.preA(Z)))
        break
      case 'EU':
        ;[set, approx] = leastFix(sm, (Z) => sm.setOr(A(node.b), sm.setAnd(A(node.a), sm.preE(Z))))
        break
      case 'AU':
        ;[set, approx] = leastFix(sm, (Z) => sm.setOr(A(node.b), sm.setAnd(A(node.a), sm.preA(Z))))
        break
      case 'EG':
        ;[set, approx] = greatestFix(sm, (Z) => sm.setAnd(A(node.a), sm.preE(Z)))
        break
      case 'AG':
        ;[set, approx] = greatestFix(sm, (Z) => sm.setAnd(A(node.a), sm.preA(Z)))
        break
      case 'ER':
        ;[set, approx] = greatestFix(sm, (Z) => sm.setAnd(A(node.b), sm.setOr(A(node.a), sm.preE(Z))))
        break
      case 'AR':
        ;[set, approx] = greatestFix(sm, (Z) => sm.setAnd(A(node.b), sm.setOr(A(node.a), sm.preA(Z))))
        break
    }
    byKey.set(key, set)
    subs.push({
      key,
      text: showCtl(node),
      kind: node.k,
      bdd: set,
      sat: sm.decode(set),
      nodes: m.nodeCount(set),
      approx,
      fixpoint: FIX_LEAST.has(node.k) ? 'least' : FIX_GREATEST.has(node.k) ? 'greatest' : undefined,
    })
  }

  const top = byKey.get(ctlKey(formula))!
  const initialVerdict = sm.model.initial.map((s) => ({ state: s, holds: sm.contains(top, s) }))
  return {
    subs,
    top,
    holds: initialVerdict.every((v) => v.holds),
    initialVerdict,
    peakNodes: subs.reduce((a, s) => Math.max(a, s.nodes), 0),
  }
}

/** Convenience: decode Sat(φ) to a boolean vector, for the differential self-test. */
export function symbolicSatVector(formula: Ctl, model: CtlModel): boolean[] {
  const sm = new SymbolicModel(model)
  const lab = symbolicLabel(formula, sm)
  const vec = new Array<boolean>(model.n).fill(false)
  for (const i of sm.decode(lab.top)) vec[i] = true
  return vec
}
