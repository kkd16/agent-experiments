// CTL model checking by the **labelling algorithm** (Clarke–Emerson–Sistla). For each subformula ψ
// of φ, in increasing size, we compute `Sat(ψ)` — the set of states where ψ holds — bottom-up. The
// Boolean connectives are set operations; the temporal operators are *fixpoints* of a pre-image
// operator over the transition relation:
//
//     Sat(EX ψ)      = pre∃(Sat ψ)                          one existential step
//     Sat(AX ψ)      = pre∀(Sat ψ)                          one universal step
//     Sat(E[φ U ψ])  = μZ. Sat ψ ∪ (Sat φ ∩ pre∃ Z)         least fixpoint
//     Sat(A[φ U ψ])  = μZ. Sat ψ ∪ (Sat φ ∩ pre∀ Z)
//     Sat(EF ψ)      = μZ. Sat ψ ∪ pre∃ Z                   ( = E[⊤ U ψ] )
//     Sat(AF ψ)      = μZ. Sat ψ ∪ pre∀ Z
//     Sat(EG ψ)      = νZ. Sat ψ ∩ pre∃ Z                   greatest fixpoint
//     Sat(AG ψ)      = νZ. Sat ψ ∩ pre∀ Z
//     Sat(E[φ R ψ])  = νZ. Sat ψ ∩ (Sat φ ∪ pre∃ Z)
//     Sat(A[φ R ψ])  = νZ. Sat ψ ∩ (Sat φ ∪ pre∀ Z)
//
// where  pre∃(Y) = { s : some successor of s is in Y }  and  pre∀(Y) = { s : every successor is in Y }.
// We record the whole approximant chain Z₀, Z₁, … of each fixpoint so the Labelling tab can animate
// the convergence — the visual heart of this mode.
//
// CTL is interpreted over a *total* transition relation (every state has an infinite future). A
// deadlock state in the source Kripke structure is given a self-loop by `totalize` (the standard
// "stuttering" convention), and the added loops are surfaced in the UI.

import type { Ctl } from './formula'
import { ctlKey, subformulas } from './formula'
import { showCtl } from './formula'
import type { Kripke } from '../ltl/kripke'

/** A Kripke structure prepared for CTL: a total relation plus the bookkeeping the UI shows. */
export interface CtlModel {
  n: number
  succ: number[][] // total adjacency (self-loops added at former deadlocks)
  initial: number[]
  props: Set<string>[]
  names: string[]
  addedSelfLoops: number[] // states that were deadlocks and received a self-loop
}

/** Make the transition relation total: every deadlock state gets a self-loop. */
export function totalize(k: Kripke): CtlModel {
  const added: number[] = []
  const succ = k.edges.map((e, i) => {
    if (e.length === 0) {
      added.push(i)
      return [i]
    }
    return e.slice()
  })
  return {
    n: k.states.length,
    succ,
    initial: k.initial.slice(),
    props: k.states.map((s) => new Set(s.props)),
    names: k.states.map((s) => s.name),
    addedSelfLoops: added,
  }
}

// --- set helpers (states as boolean[]) -------------------------------------

const all = (n: number) => new Array<boolean>(n).fill(true)
const none = (n: number) => new Array<boolean>(n).fill(false)
const toList = (b: boolean[]): number[] => {
  const out: number[] = []
  for (let i = 0; i < b.length; i++) if (b[i]) out.push(i)
  return out
}
const equalSet = (a: boolean[], b: boolean[]): boolean => a.every((v, i) => v === b[i])

/** pre∃(Y): states with at least one successor in Y. */
function preExists(m: CtlModel, y: boolean[]): boolean[] {
  return m.succ.map((s) => s.some((t) => y[t]))
}
/** pre∀(Y): states all of whose successors are in Y (total relation ⇒ "all" is non-vacuous). */
function preForall(m: CtlModel, y: boolean[]): boolean[] {
  return m.succ.map((s) => s.every((t) => y[t]))
}

// --- the per-subformula label --------------------------------------------

export interface SubLabel {
  key: string
  text: string
  kind: Ctl['k']
  sat: number[] // sorted state indices where the subformula holds
  /** The fixpoint approximant chain (each entry a sorted state list); present for U/R/F/G operators. */
  approx?: number[][]
  fixpoint?: 'least' | 'greatest'
}

export interface Labelling {
  subs: SubLabel[] // post-order: children before parents
  satByKey: Map<string, boolean[]>
  top: boolean[] // Sat(φ)
  holds: boolean // every initial state is in Sat(φ)
  initialVerdict: { state: number; holds: boolean }[]
}

const FIX_LEAST = new Set<Ctl['k']>(['EU', 'AU', 'EF', 'AF'])
const FIX_GREATEST = new Set<Ctl['k']>(['EG', 'AG', 'ER', 'AR'])

/** Run the labelling algorithm: compute `Sat` for every subformula and the overall verdict. */
export function labelModel(formula: Ctl, model: CtlModel): Labelling {
  const n = model.n
  const satByKey = new Map<string, boolean[]>()
  const subs: SubLabel[] = []

  for (const node of subformulas(formula)) {
    const key = ctlKey(node)
    if (satByKey.has(key)) continue
    const A = (x: Ctl) => satByKey.get(ctlKey(x))!
    let set: boolean[]
    let approx: number[][] | undefined
    switch (node.k) {
      case 'true':
        set = all(n)
        break
      case 'false':
        set = none(n)
        break
      case 'atom': {
        const name = node.name
        set = model.props.map((p) => p.has(name))
        break
      }
      case 'not':
        set = A(node.a).map((v) => !v)
        break
      case 'and':
        set = A(node.a).map((v, i) => v && A(node.b)[i])
        break
      case 'or':
        set = A(node.a).map((v, i) => v || A(node.b)[i])
        break
      case 'imp':
        set = A(node.a).map((v, i) => !v || A(node.b)[i])
        break
      case 'iff':
        set = A(node.a).map((v, i) => v === A(node.b)[i])
        break
      case 'EX':
        set = preExists(model, A(node.a))
        break
      case 'AX':
        set = preForall(model, A(node.a))
        break
      case 'EF':
        ;[set, approx] = leastFixpoint(n, (Z) => union(A(node.a), preExists(model, Z)))
        break
      case 'AF':
        ;[set, approx] = leastFixpoint(n, (Z) => union(A(node.a), preForall(model, Z)))
        break
      case 'EU':
        ;[set, approx] = leastFixpoint(n, (Z) =>
          union(A(node.b), inter(A(node.a), preExists(model, Z))),
        )
        break
      case 'AU':
        ;[set, approx] = leastFixpoint(n, (Z) =>
          union(A(node.b), inter(A(node.a), preForall(model, Z))),
        )
        break
      case 'EG':
        ;[set, approx] = greatestFixpoint(n, (Z) => inter(A(node.a), preExists(model, Z)))
        break
      case 'AG':
        ;[set, approx] = greatestFixpoint(n, (Z) => inter(A(node.a), preForall(model, Z)))
        break
      case 'ER':
        ;[set, approx] = greatestFixpoint(n, (Z) =>
          inter(A(node.b), union(A(node.a), preExists(model, Z))),
        )
        break
      case 'AR':
        ;[set, approx] = greatestFixpoint(n, (Z) =>
          inter(A(node.b), union(A(node.a), preForall(model, Z))),
        )
        break
    }
    satByKey.set(key, set)
    subs.push({
      key,
      text: showCtl(node),
      kind: node.k,
      sat: toList(set),
      approx,
      fixpoint: FIX_LEAST.has(node.k) ? 'least' : FIX_GREATEST.has(node.k) ? 'greatest' : undefined,
    })
  }

  const top = satByKey.get(ctlKey(formula))!
  const initialVerdict = model.initial.map((s) => ({ state: s, holds: top[s] }))
  return { subs, satByKey, top, holds: model.initial.every((s) => top[s]), initialVerdict }
}

const union = (a: boolean[], b: boolean[]) => a.map((v, i) => v || b[i])
const inter = (a: boolean[], b: boolean[]) => a.map((v, i) => v && b[i])

/** μZ.f(Z): iterate from ∅ upward to the least fixpoint, capturing every approximant. */
function leastFixpoint(n: number, f: (z: boolean[]) => boolean[]): [boolean[], number[][]] {
  let cur = none(n)
  const chain: number[][] = [toList(cur)]
  for (;;) {
    const next = f(cur)
    chain.push(toList(next))
    if (equalSet(next, cur)) return [next, chain]
    cur = next
  }
}

/** νZ.f(Z): iterate from the full set downward to the greatest fixpoint, capturing every approximant. */
function greatestFixpoint(n: number, f: (z: boolean[]) => boolean[]): [boolean[], number[][]] {
  let cur = all(n)
  const chain: number[][] = [toList(cur)]
  for (;;) {
    const next = f(cur)
    chain.push(toList(next))
    if (equalSet(next, cur)) return [next, chain]
    cur = next
  }
}

/** Compute just the satisfying-state vector of a formula (used by the witness engine and tests). */
export function satVector(formula: Ctl, model: CtlModel): boolean[] {
  return labelModel(formula, model).satByKey.get(ctlKey(formula))!
}

export interface MCResult {
  holds: boolean
  labelling: Labelling
}

/** Model-check φ against a Kripke structure: holds iff every initial state satisfies φ. */
export function modelCheckCtl(formula: Ctl, k: Kripke): MCResult {
  const model = totalize(k)
  const labelling = labelModel(formula, model)
  return { holds: labelling.holds, labelling }
}

export { preExists, preForall }
