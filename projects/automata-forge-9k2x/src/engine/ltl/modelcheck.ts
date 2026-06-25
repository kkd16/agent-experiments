// Automata-theoretic LTL model checking (Vardi & Wolper, 1986) — the punchline of the whole mode.
//
// To decide whether every behaviour of a Kripke structure M satisfies a formula φ, we ask the dual
// question and try to *refute* it:
//
//   1. Build a Büchi automaton A(¬φ) accepting exactly the ω-words that violate φ  (translate.ts).
//   2. Form the synchronous product A(¬φ) ⊗ M: a run is a path of M whose label-word A(¬φ) accepts.
//   3. If that product has an accepting run (a reachable accepting state on a cycle), its projection
//      onto M is a concrete counterexample — a path of M that violates φ, shaped as a *lasso*
//      (a finite stem leading into a cycle repeated forever). If there is none, M ⊨ φ.
//
// The product is built on the fly and the lasso is found by a search for a reachable accepting state
// that lies on a cycle — the educational equivalent of the nested DFS, returning a concrete witness.

import type { Core } from './formula'
import { toCore } from './formula'
import type { BA, GBA } from './buchi'
import { degeneralize, satGuard } from './buchi'
import { gpvw } from './translate'
import type { Ltl } from './formula'
import type { Kripke } from './kripke'

/** A system to check against: a labelled transition graph (a Kripke structure, or a lasso word). */
export interface System {
  n: number
  initial: number[]
  succ: (i: number) => number[]
  holds: (state: number, atom: string) => boolean
}

/** Build both the generalized and degeneralized Büchi automata for a Core (NNF) formula. */
export function buildBuchi(core: Core): { gba: GBA; ba: BA; overflow: boolean } {
  const { gba, overflow } = gpvw(core)
  const ba = degeneralize(gba)
  return { gba, ba, overflow }
}

/** Wrap a Kripke structure as a System for the product. */
export function kripkeSystem(m: Kripke): System {
  return {
    n: m.states.length,
    initial: m.initial,
    succ: (i) => m.edges[i],
    holds: (state, atom) => m.states[state].props.has(atom),
  }
}

/**
 * Wrap an ultimately-periodic word — a finite `prefix` followed by a forever-repeated `loop` of
 * letters (each letter a set of true atoms) — as a System whose single path is exactly that word.
 */
export function lassoSystem(prefix: Set<string>[], loop: Set<string>[]): System {
  const letters = [...prefix, ...loop]
  const p = prefix.length
  const total = letters.length
  return {
    n: total,
    initial: [0],
    succ: (i) => (i + 1 < total ? [i + 1] : [p]), // last letter loops back to the start of `loop`
    holds: (state, atom) => letters[state]?.has(atom) ?? false,
  }
}

/** A product state: a Büchi state `b` synchronised with a system state `m`. */
interface Prod {
  b: number
  m: number
}

export interface EmptinessResult {
  empty: boolean
  /** When non-empty: the lasso, as product states. `prefix` leads into `loop`; `loop` repeats. */
  prefix?: Prod[]
  loop?: Prod[]
  productStates: number
}

/**
 * Is L(A ⊗ S) empty? If not, return a lasso witness. A product state (b,m) is *valid* only when m's
 * valuation satisfies b's guard; we only ever build valid states, so reaching an accepting one on a
 * cycle is exactly a non-empty acceptance.
 */
export function checkEmptiness(ba: BA, sys: System): EmptinessResult {
  const M = sys.n
  const enc = (b: number, m: number): number => b * M + m
  const dec = (id: number): Prod => ({ b: Math.floor(id / M), m: id % M })

  const valid = (b: number, m: number): boolean =>
    satGuard(ba.states[b].label, (atom) => sys.holds(m, atom))

  const prodSucc = (id: number): number[] => {
    const { b, m } = dec(id)
    const out: number[] = []
    for (const b2 of ba.states[b].next) {
      for (const m2 of sys.succ(m)) {
        if (valid(b2, m2)) out.push(enc(b2, m2))
      }
    }
    return out
  }

  // Initial product states.
  const inits: number[] = []
  for (const b of ba.initial) {
    for (const m of sys.initial) {
      if (valid(b, m)) inits.push(enc(b, m))
    }
  }

  // BFS over the reachable product, recording a parent for stem reconstruction.
  const parent = new Map<number, number>()
  const order: number[] = []
  const queue: number[] = []
  for (const s of inits) {
    if (!parent.has(s)) {
      parent.set(s, -1)
      queue.push(s)
    }
  }
  while (queue.length) {
    const u = queue.shift()!
    order.push(u)
    for (const v of prodSucc(u)) {
      if (!parent.has(v)) {
        parent.set(v, u)
        queue.push(v)
      }
    }
  }

  const stemTo = (target: number): number[] => {
    const path: number[] = []
    let cur: number | undefined = target
    while (cur !== undefined && cur !== -1) {
      path.push(cur)
      cur = parent.get(cur)
    }
    return path.reverse()
  }

  // A cycle through `a`: BFS from a's successors back to a.
  const findLoop = (a: number): number[] | null => {
    const back = new Map<number, number>()
    const q: number[] = []
    for (const v of prodSucc(a)) {
      if (v === a) return [a] // self-loop: the repeating segment is just [a]
      if (!back.has(v)) {
        back.set(v, a)
        q.push(v)
      }
    }
    while (q.length) {
      const u = q.shift()!
      for (const v of prodSucc(u)) {
        if (v === a) {
          // reconstruct a → … → u, then the repeating segment (anchor a first) is [a, …, u].
          const seg: number[] = [u]
          let cur = u
          while (back.get(cur) !== a) {
            cur = back.get(cur)!
            seg.push(cur)
          }
          seg.push(a)
          seg.reverse() // [a, firstSucc, …, u]
          return seg
        }
        if (!back.has(v)) {
          back.set(v, u)
          q.push(v)
        }
      }
    }
    return null
  }

  // Reachable accepting states, nearest first (shortest stems make the prettiest counterexamples).
  const accepting = order.filter((id) => ba.accept.has(dec(id).b))
  for (const a of accepting) {
    const loop = findLoop(a)
    if (loop) {
      const stem = stemTo(a) // ends at a
      const prefix = stem.slice(0, -1).map(dec) // everything before the loop anchor
      return {
        empty: false,
        prefix,
        loop: loop.map(dec),
        productStates: parent.size,
      }
    }
  }
  return { empty: true, productStates: parent.size }
}

/** Does the Büchi automaton accept the given ultimately-periodic ω-word? */
export function acceptsLasso(ba: BA, prefix: Set<string>[], loop: Set<string>[]): boolean {
  if (loop.length === 0) return false // not an ω-word
  return !checkEmptiness(ba, lassoSystem(prefix, loop)).empty
}

export interface MCResult {
  holds: boolean
  /** Büchi automaton for ¬φ that drove the check (degeneralized). */
  negBa: BA
  negGba: GBA
  overflow: boolean
  productStates: number
  /** When the property fails: a counterexample path of the model, as a lasso of state indices. */
  counterexample?: { prefix: number[]; loop: number[] }
}

/** Check whether every behaviour of `model` satisfies `formula`. */
export function modelCheck(formula: Ltl, model: Kripke): MCResult {
  const neg = toCore(formula, true) // NNF of ¬φ
  const { gba, ba, overflow } = buildBuchi(neg)
  const sys = kripkeSystem(model)
  const res = checkEmptiness(ba, sys)
  if (res.empty) {
    return { holds: true, negBa: ba, negGba: gba, overflow, productStates: res.productStates }
  }
  return {
    holds: false,
    negBa: ba,
    negGba: gba,
    overflow,
    productStates: res.productStates,
    counterexample: {
      prefix: (res.prefix ?? []).map((p) => p.m),
      loop: (res.loop ?? []).map((p) => p.m),
    },
  }
}
