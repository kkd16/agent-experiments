// Myhill–Nerode: distinguishing states by the table-filling algorithm, the algebraic dual of
// Hopcroft's minimization.
//
// Two states p, q of a complete DFA are *equivalent* when no string separates them — running from
// p and from q always agrees on acceptance. The table-filling algorithm computes the complement of
// that relation constructively: first mark every pair where ε already separates them (one accepts,
// the other doesn't); then repeatedly mark (p, q) whenever some symbol a sends them to an
// already-marked pair (δ(p,a), δ(q,a)). At the fixpoint the unmarked pairs are exactly the
// equivalent ones, and the number of equivalence classes is |minimal DFA| — the Myhill–Nerode
// theorem, made concrete. We additionally carry, for every marked pair, a shortest *witness* string
// that actually distinguishes the two states, so each filled cell is a proof rather than a tick.

import type { Dfa, Sym } from './types'
import { completeDfa } from './product'

export interface NerodeResult {
  /** The complete DFA the analysis ran on (its trap, if any, is included as a real state). */
  dfa: Dfa
  n: number
  /** marked[i][j] (i < j): are states i and j distinguishable? */
  marked: boolean[][]
  /** The round (0 = the ε accept/reject split) at which pair (i,j) was first marked; -1 if never. */
  round: number[][]
  /** A shortest distinguishing string for pair (i,j) as alphabet symbols; null if equivalent. */
  witness: (Sym[] | null)[][]
  /** Equivalence classes: groups of mutually indistinguishable states (each sorted). */
  classes: number[][]
  /** classOf[state] = index into `classes`. */
  classOf: number[]
  /** A shortest access string (from the start state) reaching each state, as symbols. */
  access: Sym[][]
  /** Number of refinement rounds the table-filling performed (excluding the initial split). */
  rounds: number
}

/** Shortest access strings from the start state to every state (BFS), as alphabet symbols. */
function accessStrings(dfa: Dfa): Sym[][] {
  const access: (Sym[] | null)[] = new Array(dfa.numStates).fill(null)
  access[dfa.start] = []
  const queue = [dfa.start]
  while (queue.length) {
    const s = queue.shift()!
    for (let c = 0; c < dfa.alphabet.length; c++) {
      const t = dfa.trans[s][c]
      if (t === undefined || t < 0 || access[t] !== null) continue
      access[t] = [...access[s]!, dfa.alphabet[c]]
      queue.push(t)
    }
  }
  // Unreachable states (shouldn't happen on a reachable DFA) get an empty placeholder.
  return access.map((a) => a ?? [])
}

/**
 * Run the table-filling algorithm on a DFA. The input is totalised first so every (state, symbol)
 * has a target; pass the full subset-construction DFA (already complete and all-reachable) for the
 * cleanest correspondence with Hopcroft's classes.
 */
export function nerode(dfaIn: Dfa): NerodeResult {
  const dfa = completeDfa(dfaIn)
  const n = dfa.numStates
  const L = dfa.alphabet.length

  const marked: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false))
  const round: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(-1))
  const witness: (Sym[] | null)[][] = Array.from({ length: n }, () =>
    new Array<Sym[] | null>(n).fill(null),
  )

  const setMark = (i: number, j: number, r: number, w: Sym[]) => {
    marked[i][j] = true
    round[i][j] = r
    witness[i][j] = w
  }

  // Round 0: ε distinguishes a pair iff exactly one of the two is accepting.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (dfa.accepting.has(i) !== dfa.accepting.has(j)) setMark(i, j, 0, [])
    }
  }

  // Propagate: (i,j) is distinguishable if some symbol sends it to an already-marked pair.
  let r = 0
  let changed = true
  while (changed) {
    changed = false
    r++
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (marked[i][j]) continue
        for (let c = 0; c < L; c++) {
          let ti = dfa.trans[i][c]
          let tj = dfa.trans[j][c]
          if (ti === tj) continue
          if (ti > tj) [ti, tj] = [tj, ti]
          if (marked[ti][tj]) {
            // c followed by the witness for (ti,tj) separates i and j.
            setMark(i, j, r, [dfa.alphabet[c], ...(witness[ti][tj] ?? [])])
            changed = true
            break
          }
        }
      }
    }
  }
  const rounds = r - 1 // the final sweep that made no change doesn't count

  // Equivalence classes: states connected by "not marked" via union-find.
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const unite = (a: number, b: number) => {
    parent[find(a)] = find(b)
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!marked[i][j]) unite(i, j)
    }
  }
  const byRoot = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    const arr = byRoot.get(root)
    if (arr) arr.push(i)
    else byRoot.set(root, [i])
  }
  // Order classes by their smallest member for a stable display.
  const classes = [...byRoot.values()]
    .map((c) => c.sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0])
  const classOf = new Array<number>(n)
  classes.forEach((cls, ci) => {
    for (const s of cls) classOf[s] = ci
  })

  return {
    dfa,
    n,
    marked,
    round,
    witness,
    classes,
    classOf,
    access: accessStrings(dfa),
    rounds,
  }
}
