// The synchronous product of a Kripke structure K with the (state-labeled,
// generalized) Büchi automaton B(¬φ), degeneralized on the fly into a plain
// Büchi automaton.
//
// A product state pairs a system state s with an automaton state q whose label
// is satisfied by L(s). A run of the product is simultaneously a path of K and a
// run of B over that path's trace — so an *accepting* product run is a system
// behaviour accepted by B(¬φ), i.e. a witness that φ is violated. Model checking
// is therefore emptiness of this product.
//
// Degeneralization (Baier & Katoen): a generalized-Büchi acceptance
// {F_0,…,F_{k-1}} becomes ordinary Büchi by k copies of the state space. In copy
// c we wait to visit F_c; on doing so we advance to copy (c+1) mod k. Accepting
// states are F_0 × {0}: cycling back to copy 0 proves every F_c was met.

import type { Gba } from './buchi'
import { labelMatches } from './buchi'
import type { Kripke } from './kripke'

export interface ProductBa {
  /** Number of degeneralized product states. */
  n: number
  /** Ids of initial product states. */
  init: number[]
  /** Successor adjacency. */
  edges: number[][]
  /** Whether each product state is accepting. */
  accepting: boolean[]
  /** Kripke state id backing each product state (for counterexample projection). */
  kripkeOf: number[]
  /** Büchi state id backing each product state. */
  buchiOf: number[]
  /** Degeneralization copy index of each product state. */
  copyOf: number[]
  /** Number of acceptance sets used in the degeneralization (k ≥ 1). */
  copies: number
}

/** Build the degeneralized product Büchi automaton of `k` and `b`. */
export function buildProduct(k: Kripke, b: Gba): ProductBa {
  const numSets = b.accept.length
  const copies = Math.max(1, numSets)

  // Membership of a Büchi state in acceptance set c.
  const inSet: (q: number, c: number) => boolean =
    numSets === 0
      ? () => true // no eventualities: every state is "good" in the single copy
      : (() => {
          const sets = b.accept.map((arr) => new Set(arr))
          return (q: number, c: number) => sets[c].has(q)
        })()

  const labelSets = k.states.map((s) => new Set(s.labels))
  const match = (q: number, s: number): boolean => labelMatches(b.states[q], labelSets[s])

  const idOf = new Map<string, number>()
  const kripkeOf: number[] = []
  const buchiOf: number[] = []
  const copyOf: number[] = []
  const edges: number[][] = []

  const intern = (s: number, q: number, c: number): number => {
    const key = s + '|' + q + '|' + c
    let id = idOf.get(key)
    if (id === undefined) {
      id = kripkeOf.length
      idOf.set(key, id)
      kripkeOf.push(s)
      buchiOf.push(q)
      copyOf.push(c)
      edges.push([])
    }
    return id
  }

  const init: number[] = []
  const queue: number[] = []
  for (const s of k.init) {
    for (const q of b.initial) {
      if (match(q, s)) {
        const id = intern(s, q, 0)
        if (!init.includes(id)) {
          init.push(id)
          queue.push(id)
        }
      }
    }
  }

  const enqueued = new Set<number>(init)
  while (queue.length > 0) {
    const id = queue.shift() as number
    const s = kripkeOf[id]
    const q = buchiOf[id]
    const c = copyOf[id]
    const advance = inSet(q, c)
    const nextCopy = advance ? (c + 1) % copies : c
    for (const s2 of k.edges[s]) {
      for (const q2 of b.edges[q]) {
        if (!match(q2, s2)) continue
        const tid = intern(s2, q2, nextCopy)
        edges[id].push(tid)
        if (!enqueued.has(tid)) {
          enqueued.add(tid)
          queue.push(tid)
        }
      }
    }
  }

  const n = kripkeOf.length
  const accepting: boolean[] = []
  for (let i = 0; i < n; i++) accepting.push(copyOf[i] === 0 && inSet(buchiOf[i], 0))
  // Dedup adjacency for tidy output.
  for (let i = 0; i < n; i++) edges[i] = [...new Set(edges[i])]

  return { n, init, edges, accepting, kripkeOf, buchiOf, copyOf, copies }
}
