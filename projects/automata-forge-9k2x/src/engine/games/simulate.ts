// Turning strategies into plays — the bridge from "who wins" to "watch them win".

import type { Arena, Player, Solution } from './types'

/** The move the owner of `v` makes when both players follow their winning strategies. */
export function jointNext(a: Arena, sol: Solution, v: number): number {
  const strat = a.owner[v] === 0 ? sol.strat0 : sol.strat1
  const w = strat[v]
  return w >= 0 ? w : a.edges[v][0]
}

export interface Lasso {
  prefix: number[]
  loop: number[]
}

/** Follow a deterministic `next` from `start` until a vertex repeats, splitting into prefix + loop. */
export function lasso(next: (v: number) => number, start: number): Lasso {
  const order: number[] = []
  const at = new Map<number, number>()
  let u = start
  while (!at.has(u)) {
    at.set(u, order.length)
    order.push(u)
    u = next(u)
  }
  const cut = at.get(u) as number
  return { prefix: order.slice(0, cut), loop: order.slice(cut) }
}

/** The winner of a parity play that eventually loops on `loop` (max priority decides). */
export function lassoWinnerParity(priority: number[], loop: number[]): Player {
  let mx = -1
  for (const v of loop) if (priority[v] > mx) mx = priority[v]
  return (mx % 2) as Player
}

/** The move prescribed for the owner of `v` in the current solution, or `null` if none. */
export function prescribedMove(a: Arena, sol: Solution, v: number): number | null {
  const strat = a.owner[v] === 0 ? sol.strat0 : sol.strat1
  return strat[v] >= 0 ? strat[v] : null
}
