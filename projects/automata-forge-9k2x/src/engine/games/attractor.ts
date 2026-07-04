// The attractor — the single primitive every game solver is built from.
//
// `Attr_p(goal)` is the set of vertices from which player `p` can **force** the token into `goal`
// in finitely many steps, no matter what the opponent does. It is computed as a least fixpoint:
// start from `goal`, then repeatedly add a vertex `v` when
//   • `v` is owned by `p` and *some* successor is already attracted (p steers into it), or
//   • `v` is owned by the opponent and *every* successor is already attracted (p is unavoidable).
// The order in which vertices enter the set is a rank: a vertex added at step k can always move to
// one added earlier, so following the recorded choice strictly decreases the rank and reaches
// `goal`. That recorded choice is player `p`'s positional **reachability strategy**.

import type { Arena, Player, Subgame } from './types'
import { other, succIn } from './types'

export interface Attractor {
  /** Membership mask of Attr_p(goal) within `present`. */
  region: Subgame
  /** `strat[v] = w`: for a `p`-owned vertex in the attractor (outside `goal`), the move toward `goal`. */
  strat: number[]
}

/**
 * Compute `Attr_p(goal)` inside the sub-arena `present`. `goal` is intersected with `present`.
 * Runs a worklist to a fixpoint; O(edges · iterations), plenty fast for interactive arenas.
 */
export function attractor(a: Arena, present: Subgame, p: Player, goal: Subgame): Attractor {
  const opp = other(p)
  const region: Subgame = new Array(a.n).fill(false)
  const strat = new Array(a.n).fill(-1)

  // Seed with goal ∩ present.
  for (let v = 0; v < a.n; v++) if (present[v] && goal[v]) region[v] = true

  // For opponent vertices we add them once *all* present-successors are in the region. Track how
  // many still lie outside so each becomes cheap to test.
  const remaining = new Array(a.n).fill(0)
  for (let v = 0; v < a.n; v++) {
    if (!present[v] || region[v]) continue
    if (a.owner[v] === opp) remaining[v] = succIn(a, present, v).length
  }

  // Reverse adjacency within `present`, to know who to reconsider when a vertex is attracted.
  const preds: number[][] = Array.from({ length: a.n }, () => [])
  for (let v = 0; v < a.n; v++) {
    if (!present[v]) continue
    for (const w of a.edges[v]) if (present[w]) preds[w].push(v)
  }

  const queue: number[] = []
  for (let v = 0; v < a.n; v++) if (region[v]) queue.push(v)

  while (queue.length) {
    const u = queue.pop() as number
    for (const v of preds[u]) {
      if (region[v]) continue
      if (a.owner[v] === p) {
        // p steers into the just-attracted u.
        region[v] = true
        strat[v] = u
        queue.push(v)
      } else {
        remaining[v]--
        if (remaining[v] === 0) {
          region[v] = true
          queue.push(v)
        }
      }
    }
  }

  return { region, strat }
}

/**
 * A **trap** strategy: on a set `region` that is a trap for the opponent (the opponent can never
 * leave it), give player `p` a positional strategy that keeps the token inside `region` forever.
 * Each `p`-owned vertex in `region` picks a successor that stays in `region` (one must exist, else
 * the vertex would not be trap-safe). Used for safety wins and to keep Büchi/parity plays alive.
 */
export function trapStrategy(a: Arena, region: Subgame, p: Player): number[] {
  const strat = new Array(a.n).fill(-1)
  for (let v = 0; v < a.n; v++) {
    if (!region[v] || a.owner[v] !== p) continue
    const w = a.edges[v].find((x) => region[x])
    if (w !== undefined) strat[v] = w
  }
  return strat
}
