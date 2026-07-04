// Infinite two-player games on finite graphs — the shared arena model.
//
// A *game arena* is a finite directed graph whose vertices are partitioned between two players.
// A single token sits on a vertex; the owner of that vertex chooses one outgoing edge; the token
// moves; and this repeats forever, tracing an infinite path (a *play*). A *winning condition*
// says which infinite plays Player 0 wins — everything else Player 1 wins. These games are the
// algorithmic heart of the µ-calculus, of reactive-controller synthesis, and of automata over
// infinite words, so they sit exactly one floor above this app's LTL/CTL model checkers.
//
// Player 0 is the protagonist ("Even" / the system we synthesise for); Player 1 is the antagonist
// ("Odd" / the adversarial environment). We keep every arena **total** (every vertex has at least
// one outgoing edge) so a play is always infinite and no dead-end conventions are needed.

/** The two players. 0 = protagonist / Even; 1 = antagonist / Odd. */
export type Player = 0 | 1

export function other(p: Player): Player {
  return (1 - p) as Player
}

/** The four winning conditions this lab solves, from simplest to most expressive. */
export type Condition = 'reachability' | 'safety' | 'buchi' | 'parity'

/**
 * A game arena. Vertices are `0 .. n-1`.
 *
 * `accent` carries the "coloured" vertices whose meaning depends on the condition:
 *  - reachability: the **target** set T — Player 0 wins iff the play reaches some target.
 *  - safety:       the **bad** set B — Player 0 wins iff the play *never* touches a bad vertex.
 *  - buchi:        the **accepting** set F — Player 0 wins iff some accepting vertex recurs ∞-often.
 *  - parity:       unused (the per-vertex `priority` drives the condition instead).
 *
 * `priority[v]` is the parity priority (≥ 0). Player 0 wins a parity play iff the **highest**
 * priority seen infinitely often is **even**.
 */
export interface Arena {
  n: number
  owner: Player[]
  edges: number[][]
  priority: number[]
  accent: boolean[]
  labels: string[]
  /** Layout hints, in a roughly [0,100]² box; the view may override by dragging. */
  pos: { x: number; y: number }[]
}

/** A sub-arena is just a membership mask over the original vertex set. */
export type Subgame = boolean[]

export function allPresent(n: number): Subgame {
  return new Array(n).fill(true)
}

/** Successors of `v` that lie inside the sub-arena `present`. */
export function succIn(a: Arena, present: Subgame, v: number): number[] {
  return a.edges[v].filter((w) => present[w])
}

export function maskAnd(a: Subgame, b: Subgame): Subgame {
  return a.map((x, i) => x && b[i])
}

export function maskAndNot(a: Subgame, b: Subgame): Subgame {
  return a.map((x, i) => x && !b[i])
}

export function maskOr(a: Subgame, b: Subgame): Subgame {
  return a.map((x, i) => x || b[i])
}

export function maskNot(a: Subgame): Subgame {
  return a.map((x) => !x)
}

export function isEmpty(m: Subgame): boolean {
  return !m.some(Boolean)
}

export function count(m: Subgame): number {
  let c = 0
  for (const x of m) if (x) c++
  return c
}

/**
 * The result of solving a game: which player wins from each vertex, and a **positional**
 * (memoryless — one fixed successor per owned vertex) winning strategy for each player on its own
 * winning region. `strat[p][v] = w` means "when the token is on `v` (owned by `p`, in `p`'s
 * winning region), move to `w`"; `-1` means "no move prescribed here".
 */
export interface Solution {
  winner: Player[]
  strat0: number[]
  strat1: number[]
}

export function emptyStrat(n: number): number[] {
  return new Array(n).fill(-1)
}

/** Validate an arena: totality, in-range edges, non-negative priorities. Returns an error or null. */
export function validateArena(a: Arena): string | null {
  if (a.n <= 0) return 'arena has no vertices'
  if (a.owner.length !== a.n || a.edges.length !== a.n || a.priority.length !== a.n)
    return 'arena arrays disagree on size'
  for (let v = 0; v < a.n; v++) {
    if (a.owner[v] !== 0 && a.owner[v] !== 1) return `vertex ${v} has no valid owner`
    if (a.edges[v].length === 0) return `vertex ${v} is a dead end (arena must be total)`
    for (const w of a.edges[v]) if (w < 0 || w >= a.n) return `vertex ${v} has an out-of-range edge to ${w}`
    if (a.priority[v] < 0) return `vertex ${v} has a negative priority`
  }
  return null
}

/** The parity priority actually in force for a play, derived from the condition (for display / play). */
export function effectivePriority(a: Arena, cond: Condition, v: number): number {
  switch (cond) {
    case 'parity':
      return a.priority[v]
    case 'buchi':
      return a.accent[v] ? 2 : 1
    default:
      return a.priority[v]
  }
}
