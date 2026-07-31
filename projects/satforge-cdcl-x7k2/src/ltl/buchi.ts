// LTL → (state-labeled, generalized) Büchi automaton, by the classic tableau
// construction of Gerth, Peled, Vardi & Wolper (1995) — the algorithm at the
// heart of every explicit-state model checker (SPIN's `ltl2ba`).
//
// The automaton reads infinite words over the alphabet 2^AP (subsets of the
// atomic propositions) and accepts exactly the words that satisfy the formula.
// It is *state-labeled*: each state carries a set of literals that the current
// input letter must satisfy for the state to be entered. Because a Kripke
// structure is itself state-labeled, the synchronous product in `product.ts` is
// then immediate.
//
// The tableau grows a graph of nodes, each a tuple (Incoming, New, Old, Next):
//   · New  — obligations for the *current* state still to be decomposed,
//   · Old  — obligations already decomposed (the literals here are the label),
//   · Next — obligations pushed to the *successor* state (from X and the
//            "unrolled" tails of U/R).
// Splitting a node on U/R/∨ is exactly the fixpoint unrolling
//   a U b ≡ b ∨ (a ∧ X(a U b)),   a R b ≡ b ∧ (a ∨ X(a R b)).
// Generalized acceptance forces every `U` eventuality to be discharged.

import type { Ltl } from './ast'
import { key } from './ast'
import { simplify, toNnf } from './nnf'

/** A literal constraint on a state's label. */
export interface Gba {
  /** States, indexed by id (0..states.length-1). */
  states: GbaState[]
  /** Ids of initial states. */
  initial: number[]
  /** Successor adjacency: edges[i] = ids reachable from state i. */
  edges: number[][]
  /**
   * Generalized-Büchi acceptance: a run is accepting iff, for every set here, it
   * visits some member infinitely often. An empty outer array means "no
   * eventualities" — every run is accepting.
   */
  accept: number[][]
  /** The NNF formula this automaton recognizes. */
  formula: Ltl
}

export interface GbaState {
  id: number
  /** Atoms that must be TRUE in the current letter to enter this state. */
  pos: string[]
  /** Atoms that must be FALSE in the current letter to enter this state. */
  neg: string[]
}

const INIT = -1 // sentinel predecessor marking an initial node

interface Node {
  id: number
  incoming: Set<number>
  neu: Map<string, Ltl>
  old: Map<string, Ltl>
  next: Map<string, Ltl>
}

function cloneMap(m: Map<string, Ltl>): Map<string, Ltl> {
  return new Map(m)
}

function sameKeys(a: Map<string, Ltl>, b: Map<string, Ltl>): boolean {
  if (a.size !== b.size) return false
  for (const k of a.keys()) if (!b.has(k)) return false
  return true
}

function negLiteralKey(lit: Ltl): string {
  // key of the boolean negation of a literal (atom or ¬atom)
  if (lit.k === 'atom') return key({ k: 'not', a: lit })
  if (lit.k === 'not') return key(lit.a)
  return '' // not a literal
}

function isLiteral(f: Ltl): boolean {
  return f.k === 'atom' || (f.k === 'not' && f.a.k === 'atom')
}

/** Build the state-labeled generalized Büchi automaton for `phi`. */
export function buildGba(phi: Ltl, maxNodes = 20000): Gba {
  const nnf = simplify(toNnf(phi, false))
  let counter = 0
  const finished: Node[] = []

  const fresh = (incoming: Set<number>, neu: Map<string, Ltl>, old: Map<string, Ltl>, nxt: Map<string, Ltl>): Node => ({
    id: counter++,
    incoming,
    neu,
    old,
    next: nxt,
  })

  // Iterative expansion with an explicit work stack (avoids deep recursion on
  // large formulas). Each item is a partially-expanded node to process.
  const work: Node[] = [fresh(new Set([INIT]), new Map([[key(nnf), nnf]]), new Map(), new Map())]

  while (work.length > 0) {
    if (finished.length + work.length > maxNodes) throw new Error('LTL automaton too large (formula too complex)')
    const nd = work.pop() as Node

    if (nd.neu.size === 0) {
      // Fully expanded: merge into an existing twin (same Old & Next) or keep.
      const twin = finished.find((r) => sameKeys(r.old, nd.old) && sameKeys(r.next, nd.next))
      if (twin) {
        for (const p of nd.incoming) twin.incoming.add(p)
        continue
      }
      finished.push(nd)
      // Spawn the successor whose obligations are this node's Next.
      const succ = fresh(new Set([nd.id]), cloneMap(nd.next), new Map(), new Map())
      work.push(succ)
      continue
    }

    // Pop one obligation from New.
    const it = nd.neu.entries().next().value as [string, Ltl]
    const [ek, eta] = it
    const neu2 = cloneMap(nd.neu)
    neu2.delete(ek)

    if (eta.k === 'true') {
      // Trivially satisfied; drop it.
      work.push({ ...nd, neu: neu2 })
      continue
    }
    if (eta.k === 'false') {
      // Contradiction: this branch dies.
      continue
    }
    if (isLiteral(eta)) {
      const nk = negLiteralKey(eta)
      if (nd.old.has(nk)) continue // clash with an existing literal → die
      const old2 = cloneMap(nd.old)
      old2.set(ek, eta)
      work.push({ ...nd, neu: neu2, old: old2 })
      continue
    }

    // Compound: record η in Old, then decompose.
    const old2 = cloneMap(nd.old)
    old2.set(ek, eta)

    if (eta.k === 'and') {
      const add = cloneMap(neu2)
      for (const c of [eta.a, eta.b]) {
        const ck = key(c)
        if (!old2.has(ck)) add.set(ck, c)
      }
      work.push({ ...nd, neu: add, old: old2 })
      continue
    }
    if (eta.k === 'X') {
      const nxt2 = cloneMap(nd.next)
      nxt2.set(key(eta.a), eta.a)
      work.push({ ...nd, neu: neu2, old: old2, next: nxt2 })
      continue
    }

    // Split rules: or / U / R  (New1 + Next1 | New2)
    let new1: Ltl[]
    let next1: Ltl[] = []
    let new2: Ltl[]
    if (eta.k === 'or') {
      new1 = [eta.a]
      new2 = [eta.b]
    } else if (eta.k === 'U') {
      new1 = [eta.a]
      next1 = [eta] // a U b ≡ b ∨ (a ∧ X(a U b))
      new2 = [eta.b]
    } else if (eta.k === 'R') {
      // a R b ≡ b ∧ (a ∨ X(a R b))
      new1 = [eta.b]
      next1 = [eta]
      new2 = [eta.a, eta.b]
    } else {
      // Unreachable: NNF + constant folding leaves only the kinds handled above.
      continue
    }

    const branch = (adds: Ltl[], nexts: Ltl[]): Node => {
      const neuB = cloneMap(neu2)
      for (const c of adds) {
        const ck = key(c)
        if (!old2.has(ck)) neuB.set(ck, c)
      }
      const nxtB = cloneMap(nd.next)
      for (const c of nexts) nxtB.set(key(c), c)
      return fresh(new Set(nd.incoming), neuB, cloneMap(old2), nxtB)
    }

    // Push node2 first so node1 (the "b now" branch for U) is explored first —
    // order is irrelevant to correctness, only to state numbering.
    work.push(branch(new2, []))
    work.push(branch(new1, next1))
  }

  return assemble(finished, nnf)
}

function assemble(finished: Node[], nnf: Ltl): Gba {
  // Compact node ids to a dense 0..n-1 range.
  const idOf = new Map<number, number>()
  finished.forEach((nd, i) => idOf.set(nd.id, i))

  const states: GbaState[] = finished.map((nd, i) => {
    const pos: string[] = []
    const neg: string[] = []
    for (const lit of nd.old.values()) {
      if (lit.k === 'atom') pos.push(lit.name)
      else if (lit.k === 'not' && lit.a.k === 'atom') neg.push(lit.a.name)
    }
    return { id: i, pos: [...new Set(pos)].sort(), neg: [...new Set(neg)].sort() }
  })

  const edges: number[][] = finished.map(() => [])
  const initial: number[] = []
  finished.forEach((nd, i) => {
    for (const p of nd.incoming) {
      if (p === INIT) initial.push(i)
      else {
        const from = idOf.get(p)
        if (from !== undefined) edges[from].push(i)
      }
    }
  })
  for (let i = 0; i < edges.length; i++) edges[i] = [...new Set(edges[i])].sort((a, b) => a - b)

  // Acceptance: one set per distinct `U` subformula. F_{aUb} = { q : (a U b) ∉
  // Old(q)  ∨  b ∈ Old(q) } — a state is "good" for this eventuality unless the
  // until is pending there without its right-hand side yet satisfied.
  const untils = collectUntils(nnf)
  const accept: number[][] = []
  for (const u of untils) {
    const uk = key(u)
    const bk = key(u.b)
    const set: number[] = []
    finished.forEach((nd, i) => {
      if (!nd.old.has(uk) || nd.old.has(bk)) set.push(i)
    })
    accept.push(set)
  }

  return { states, initial: [...new Set(initial)].sort((a, b) => a - b), edges, accept, formula: nnf }
}

function collectUntils(f: Ltl): Array<{ k: 'U'; a: Ltl; b: Ltl }> {
  const seen = new Set<string>()
  const out: Array<{ k: 'U'; a: Ltl; b: Ltl }> = []
  const walk = (g: Ltl): void => {
    switch (g.k) {
      case 'true':
      case 'false':
      case 'atom':
        return
      case 'not':
      case 'X':
      case 'F':
      case 'G':
        walk(g.a)
        return
      case 'U': {
        const k = key(g)
        if (!seen.has(k)) {
          seen.add(k)
          out.push(g)
        }
        walk(g.a)
        walk(g.b)
        return
      }
      default:
        walk(g.a)
        walk(g.b)
    }
  }
  walk(f)
  return out
}

/** Does a Kripke label (the set of true atoms) satisfy a state's literals? */
export function labelMatches(s: GbaState, trueAtoms: ReadonlySet<string>): boolean {
  for (const p of s.pos) if (!trueAtoms.has(p)) return false
  for (const p of s.neg) if (trueAtoms.has(p)) return false
  return true
}
