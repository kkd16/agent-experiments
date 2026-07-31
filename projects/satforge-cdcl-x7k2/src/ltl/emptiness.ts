// Emptiness of a Büchi automaton — does it accept any word? Equivalently, is
// there a reachable accepting state that lies on a cycle? We answer this two
// independent ways and (in the self-check) require them to agree:
//
//  1. `nestedDfs` — the textbook Courcoubetis–Vardi–Wolper–Yannakakis (1992)
//     nested depth-first search that every explicit-state model checker runs. An
//     outer DFS, on finishing an accepting state s, launches an inner DFS from s
//     that succeeds the moment it touches a state still on the outer DFS stack —
//     proving a cycle back through s. Linear time, no cycle enumeration.
//
//  2. `findLasso` — a breadth-first witness extractor: the shortest stem to some
//     accepting state that sits on a cycle, plus the shortest cycle. Used to hand
//     the UI and the semantic oracle a concrete, minimal counterexample.
//
// Both are run iteratively (explicit stacks) so deep products can't overflow.

import type { ProductBa } from './product'

export interface NestedDfsResult {
  /** True iff the automaton accepts no word (no reachable accepting cycle). */
  empty: boolean
  /** States touched by the outer search. */
  outerVisited: number
  /** States touched by the inner search. */
  innerVisited: number
}

/** Decide emptiness by the nested depth-first search. */
export function nestedDfs(p: ProductBa): NestedDfsResult {
  const visited1 = new Array<boolean>(p.n).fill(false)
  const onStack1 = new Array<boolean>(p.n).fill(false)
  const visited2 = new Array<boolean>(p.n).fill(false)
  let found = false

  interface Frame {
    node: number
    i: number
  }

  const innerSearch = (seed: number): void => {
    const stack: Frame[] = [{ node: seed, i: 0 }]
    visited2[seed] = true
    while (stack.length > 0) {
      const fr = stack[stack.length - 1]
      if (fr.i < p.edges[fr.node].length) {
        const t = p.edges[fr.node][fr.i++]
        if (onStack1[t]) {
          found = true
          return
        }
        if (!visited2[t]) {
          visited2[t] = true
          stack.push({ node: t, i: 0 })
        }
      } else {
        stack.pop()
      }
    }
  }

  for (const start of p.init) {
    if (found) break
    if (visited1[start]) continue
    const stack: Frame[] = [{ node: start, i: 0 }]
    visited1[start] = true
    onStack1[start] = true
    while (stack.length > 0 && !found) {
      const fr = stack[stack.length - 1]
      if (fr.i < p.edges[fr.node].length) {
        const t = p.edges[fr.node][fr.i++]
        if (!visited1[t]) {
          visited1[t] = true
          onStack1[t] = true
          stack.push({ node: t, i: 0 })
        }
      } else {
        // Post-order: launch the inner search from an accepting state.
        if (p.accepting[fr.node]) innerSearch(fr.node)
        onStack1[fr.node] = false
        stack.pop()
      }
    }
    if (found) break
  }

  const outerVisited = visited1.reduce((a, v) => a + (v ? 1 : 0), 0)
  const innerVisited = visited2.reduce((a, v) => a + (v ? 1 : 0), 0)
  return { empty: !found, outerVisited, innerVisited }
}

export interface ProductLasso {
  /** Product states strictly before the loop (may be empty). */
  stem: number[]
  /** Product states of the repeating block; loop[0] is the cycle entry. */
  loop: number[]
}

/** Shortest counterexample lasso, or null if the automaton is empty. */
export function findLasso(p: ProductBa): ProductLasso | null {
  // BFS from all initial states → shortest stem to every reachable state.
  const parent = new Array<number>(p.n).fill(-2) // -2 unseen, -1 root
  const reached: number[] = []
  const q: number[] = []
  for (const s of p.init) {
    if (parent[s] === -2) {
      parent[s] = -1
      q.push(s)
      reached.push(s)
    }
  }
  let head = 0
  while (head < q.length) {
    const u = q[head++]
    for (const t of p.edges[u]) {
      if (parent[t] === -2) {
        parent[t] = u
        q.push(t)
        reached.push(t)
      }
    }
  }

  const pathFromInit = (target: number): number[] => {
    const rev: number[] = []
    let x = target
    while (x !== -1) {
      rev.push(x)
      x = parent[x]
    }
    rev.reverse()
    return rev // [init … target]
  }

  // Try accepting reachable states, nearest first, for one lying on a cycle.
  const candidates = reached.filter((s) => p.accepting[s]).sort((a, b) => pathFromInit(a).length - pathFromInit(b).length)

  for (const a of candidates) {
    const cyclePath = shortestCycle(p, a)
    if (cyclePath) {
      const toA = pathFromInit(a) // [init … a]
      const stem = toA.slice(0, toA.length - 1) // drop the final `a`; it starts the loop
      return { stem, loop: cyclePath } // loop = [a, …] repeating block
    }
  }
  return null
}

/** Shortest cycle a → … → a (≥1 edge), returned as the repeating block [a, …]. */
function shortestCycle(p: ProductBa, a: number): number[] | null {
  // BFS over successors; success is an edge back into `a`.
  const parent = new Map<number, number>()
  const q: number[] = []
  for (const t of p.edges[a]) {
    if (t === a) return [a] // self-loop: repeating block is just [a]
    if (!parent.has(t)) {
      parent.set(t, a)
      q.push(t)
    }
  }
  let head = 0
  while (head < q.length) {
    const u = q[head++]
    for (const t of p.edges[u]) {
      if (t === a) {
        // Reconstruct a → … → u, then u → a closes the loop.
        const back: number[] = [u]
        let x = u
        while (parent.get(x) !== a) {
          x = parent.get(x) as number
          back.push(x)
        }
        back.reverse() // [firstSucc … u]
        return [a, ...back]
      }
      if (t !== a && !parent.has(t)) {
        parent.set(t, u)
        q.push(t)
      }
    }
  }
  return null
}
