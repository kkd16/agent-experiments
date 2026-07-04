// Reachability & safety games — the two simplest conditions, both solved by one attractor.
//
// Reachability: Player 0 wins iff the play reaches the target set T. Its winning region is exactly
//   Attr_0(T): from there Player 0 forces T; from the complement Player 1 can dodge T forever.
// Safety: Player 0 wins iff the play *never* touches the bad set B — the dual game. Player 1 is
//   trying to *reach* B, so Player 0's winning region is V \ Attr_1(B).

import type { Arena, Solution, Subgame } from './types'
import { allPresent, maskNot } from './types'
import { attractor, trapStrategy } from './attractor'

/** Solve a reachability game with target set `target` (a mask over vertices). */
export function solveReachability(a: Arena, target: Subgame): Solution {
  const present = allPresent(a.n)
  const { region: W0, strat } = attractor(a, present, 0, target)
  const W1 = maskNot(W0)
  const winner = W0.map((w) => (w ? 0 : 1)) as (0 | 1)[]

  // Player 0's reachability strategy is `strat`; on target vertices it has already won, but for
  // an interactive play give it *some* forward move that stays in W0 (W0 is a trap for Player 1,
  // and target ⊆ W0, so a W0-successor exists).
  const strat0 = strat.slice()
  for (let v = 0; v < a.n; v++) {
    if (W0[v] && a.owner[v] === 0 && strat0[v] === -1) {
      const w = a.edges[v].find((x) => W0[x])
      if (w !== undefined) strat0[v] = w
    }
  }
  // Player 1 dodges forever inside W1 (a trap for Player 0).
  const strat1 = trapStrategy(a, W1, 1)
  return { winner, strat0, strat1 }
}

/** Solve a safety game where Player 0 must avoid the `bad` set forever. */
export function solveSafety(a: Arena, bad: Subgame): Solution {
  const present = allPresent(a.n)
  const { region: reachBad, strat: reachStrat } = attractor(a, present, 1, bad)
  const W0 = maskNot(reachBad)
  const winner = W0.map((w) => (w ? 0 : 1)) as (0 | 1)[]

  // Player 0 stays inside W0 forever (W0 is a trap for Player 1).
  const strat0 = trapStrategy(a, W0, 0)
  // Player 1 forces the token into `bad`; `reachStrat` is exactly that attractor strategy.
  const strat1 = reachStrat.slice()
  for (let v = 0; v < a.n; v++) {
    if (reachBad[v] && a.owner[v] === 1 && strat1[v] === -1) {
      const w = a.edges[v].find((x) => reachBad[x])
      if (w !== undefined) strat1[v] = w
    }
  }
  return { winner, strat0, strat1 }
}
