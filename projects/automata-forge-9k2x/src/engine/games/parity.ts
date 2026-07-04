// Parity games, solved by McNaughton–Zielonka recursion — the most expressive condition here, and
// the one that subsumes the others: it is polynomial-time inter-reducible with µ-calculus model
// checking, and every parity game is *positionally determined* (each vertex is won by exactly one
// player, who wins with a single memoryless strategy).
//
// Player 0 (Even) wins a play iff the **highest priority seen infinitely often is even**.
//
// Zielonka's idea: let `d` be the top priority present and `p = d mod 2` the player it favours.
// Player `p` attracts all top-priority vertices `U` into a region `A`, then we recurse on the rest.
// If the opponent wins nothing in the sub-game, `p` wins everything (revisit `U` forever, or fall
// into the sub-game where `p` already wins). Otherwise the opponent's sub-game win is *real*: `p`
// can never keep the opponent out of it, so the opponent attracts it out (region `B`), and we
// recurse once more on `present \ B`. Each strategy is stitched together from the sub-results and
// the two attractor strategies.

import type { Arena, Player, Solution, Subgame } from './types'
import { isEmpty, maskAndNot, maskOr, other } from './types'
import { attractor } from './attractor'

interface ZResult {
  win: [Subgame, Subgame]
  strat: [number[], number[]]
}

function emptyResult(n: number): ZResult {
  return {
    win: [new Array(n).fill(false), new Array(n).fill(false)],
    strat: [new Array(n).fill(-1), new Array(n).fill(-1)],
  }
}

function maxPriority(a: Arena, present: Subgame): number {
  let m = -1
  for (let v = 0; v < a.n; v++) if (present[v] && a.priority[v] > m) m = a.priority[v]
  return m
}

function zielonka(a: Arena, present: Subgame): ZResult {
  if (isEmpty(present)) return emptyResult(a.n)

  const d = maxPriority(a, present)
  const p = (d % 2) as Player
  const opp = other(p)

  const U: Subgame = new Array(a.n).fill(false)
  for (let v = 0; v < a.n; v++) if (present[v] && a.priority[v] === d) U[v] = true

  const { region: A, strat: aStrat } = attractor(a, present, p, U)
  const sub = zielonka(a, maskAndNot(present, A))

  const res = emptyResult(a.n)

  if (isEmpty(sub.win[opp])) {
    // Player p wins the whole sub-arena `present`.
    res.win[p] = present.slice()
    // p's strategy: sub's on present\A; the attractor on A\U; on p-owned top vertices keep the
    // play inside `present` (any successor works — a play that revisits U ∞-often gives max-inf d,
    // and one that does not is eventually confined to present\A where sub already wins).
    for (let v = 0; v < a.n; v++) {
      if (!present[v] || a.owner[v] !== p) continue
      if (sub.win[p][v] && sub.strat[p][v] !== -1) res.strat[p][v] = sub.strat[p][v]
      else if (aStrat[v] !== -1) res.strat[p][v] = aStrat[v]
      else {
        const w = a.edges[v].find((x) => present[x])
        if (w !== undefined) res.strat[p][v] = w
      }
    }
    return res
  }

  // The opponent's sub-game win is genuine: attract it out and recurse on what is left.
  const WoppSub = sub.win[opp]
  const { region: B, strat: bStrat } = attractor(a, present, opp, WoppSub)
  const sub2 = zielonka(a, maskAndNot(present, B))

  res.win[opp] = maskOr(sub2.win[opp], B)
  res.win[p] = sub2.win[p].slice()

  // p keeps sub2's winning strategy on its (smaller) region.
  for (let v = 0; v < a.n; v++) {
    if (a.owner[v] === p && res.win[p][v] && sub2.strat[p][v] !== -1) res.strat[p][v] = sub2.strat[p][v]
  }
  // opp: sub2's strategy on its sub2-region; the attractor on B\WoppSub; sub's strategy on WoppSub.
  for (let v = 0; v < a.n; v++) {
    if (a.owner[v] !== opp || !res.win[opp][v]) continue
    if (sub2.win[opp][v] && sub2.strat[opp][v] !== -1) res.strat[opp][v] = sub2.strat[opp][v]
    else if (WoppSub[v] && sub.strat[opp][v] !== -1) res.strat[opp][v] = sub.strat[opp][v]
    else if (bStrat[v] !== -1) res.strat[opp][v] = bStrat[v]
  }
  return res
}

/** Solve a parity game on the whole arena, returning winners and both positional strategies. */
export function solveParity(a: Arena): Solution {
  const present: Subgame = new Array(a.n).fill(true)
  const r = zielonka(a, present)
  const winner = new Array(a.n).fill(0) as (0 | 1)[]
  for (let v = 0; v < a.n; v++) winner[v] = r.win[0][v] ? 0 : 1
  return { winner, strat0: r.strat[0], strat1: r.strat[1] }
}
