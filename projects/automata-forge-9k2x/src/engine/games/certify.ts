// Certificates — an *independent* proof that a computed solution is exactly right.
//
// A solver is only worth trusting if its answer can be checked by machinery that shares none of its
// logic. For positionally-determined games that check is cheap and complete: pin each player to its
// returned memoryless strategy and confirm it wins against *every* opponent reply. With one player
// pinned, the opponent controls all branching, so "the opponent can win from here" becomes a plain
// graph question:
//   • parity — the opponent wins iff it can reach a cycle whose maximum priority has *its* parity;
//   • reachability — Player 0's strategy is winning iff, with Player 0 pinned, no cycle avoids the
//     target (so every infinite play must fall into it).
// If Player 0's strategy admits no opponent win on W0, and Player 1's admits none on W1, and W0 ⊎ W1
// covers every vertex, the partition is provably exact. This is the app's "two roads, one machine"
// discipline: the solver drives, the certificate refutes.

import type { Arena, Player, Solution, Subgame } from './types'
import { other } from './types'

/** Tarjan SCC restricted to the vertex set `inSet`, using only edges that stay inside it. */
function nontrivialMembers(a: Arena, inSet: boolean[], adj: (v: number) => number[]): boolean[] {
  const index = new Array(a.n).fill(-1)
  const low = new Array(a.n).fill(0)
  const onStack = new Array(a.n).fill(false)
  const stack: number[] = []
  const comp = new Array(a.n).fill(-1)
  const compSize: number[] = []
  let idx = 0
  let nc = 0

  // Iterative Tarjan to avoid deep recursion on large arenas.
  for (let s = 0; s < a.n; s++) {
    if (!inSet[s] || index[s] !== -1) continue
    const work: { v: number; i: number }[] = [{ v: s, i: 0 }]
    index[s] = low[s] = idx++
    stack.push(s)
    onStack[s] = true
    while (work.length) {
      const top = work[work.length - 1]
      const v = top.v
      const succ = adj(v)
      if (top.i < succ.length) {
        const w = succ[top.i++]
        if (index[w] === -1) {
          index[w] = low[w] = idx++
          stack.push(w)
          onStack[w] = true
          work.push({ v: w, i: 0 })
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], index[w])
        }
      } else {
        if (low[v] === index[v]) {
          let size = 0
          for (;;) {
            const w = stack.pop() as number
            onStack[w] = false
            comp[w] = nc
            size++
            if (w === v) break
          }
          compSize[nc++] = size
        }
        work.pop()
        if (work.length) {
          const parent = work[work.length - 1].v
          low[parent] = Math.min(low[parent], low[v])
        }
      }
    }
  }

  const out = new Array(a.n).fill(false)
  for (let v = 0; v < a.n; v++) {
    if (!inSet[v]) continue
    if (compSize[comp[v]] > 1) out[v] = true
    else if (adj(v).includes(v)) out[v] = true // a self-loop is a nontrivial cycle too
  }
  return out
}

/**
 * With player `p` pinned to `stratP` on `region`, build the fixed graph and report whether the game
 * is *closed* there (p always has its move inside `region`; the opponent can never escape `region`).
 * Returns the graph's adjacency (as a function) and a `closed` flag.
 */
function pinned(
  a: Arena,
  region: Subgame,
  p: Player,
  stratP: number[],
): { adj: (v: number) => number[]; closed: boolean } {
  let closed = true
  const cache: number[][] = Array.from({ length: a.n }, () => [])
  for (let v = 0; v < a.n; v++) {
    if (!region[v]) continue
    if (a.owner[v] === p) {
      const w = stratP[v]
      if (w < 0 || !region[w]) {
        closed = false
      } else {
        cache[v] = [w]
      }
    } else {
      // Opponent keeps every move; if any leaves `region`, it has escaped to its own turf.
      for (const w of a.edges[v]) {
        if (!region[w]) {
          closed = false
          break
        }
      }
      cache[v] = a.edges[v].filter((w) => region[w])
    }
  }
  return { adj: (v) => cache[v], closed }
}

/** Does the pinned graph contain a cycle whose maximum priority has parity `badParity`? */
function hasBadMaxCycle(
  a: Arena,
  region: Subgame,
  adj: (v: number) => number[],
  priority: number[],
  badParity: 0 | 1,
): boolean {
  const prios = new Set<number>()
  for (let v = 0; v < a.n; v++) if (region[v] && priority[v] % 2 === badParity) prios.add(priority[v])
  for (const m of prios) {
    const H = region.map((inR, v) => inR && priority[v] <= m)
    const bad = nontrivialMembers(a, H, (v) => adj(v).filter((w) => H[w]))
    for (let v = 0; v < a.n; v++) if (H[v] && priority[v] === m && bad[v]) return true
  }
  return false
}

export interface Certificate {
  ok: boolean
  /** Human-readable reason when a check fails. */
  reason: string
}

/** Certify a parity solution (also used for Büchi via effective priorities `2/1`). */
export function certifyParity(a: Arena, priority: number[], sol: Solution): Certificate {
  const W: [Subgame, Subgame] = [
    sol.winner.map((w) => w === 0),
    sol.winner.map((w) => w === 1),
  ]
  for (let v = 0; v < a.n; v++) if (sol.winner[v] !== 0 && sol.winner[v] !== 1) return { ok: false, reason: `vertex ${v} unassigned` }

  for (const p of [0, 1] as Player[]) {
    const strat = p === 0 ? sol.strat0 : sol.strat1
    const { adj, closed } = pinned(a, W[p], p, strat)
    if (!closed) return { ok: false, reason: `Player ${p}'s strategy is not closed on its region` }
    const badParity: 0 | 1 = p === 0 ? 1 : 0
    if (hasBadMaxCycle(a, W[p], adj, priority, badParity))
      return { ok: false, reason: `Player ${p}'s region admits a Player ${other(p)} cycle` }
  }
  return { ok: true, reason: 'both memoryless strategies win against every reply' }
}

/**
 * Certify that, with player `p` pinned to `stratP`, every play from `region` reaches `goal`.
 * `goal` vertices are winning sinks — we never require them to stay in `region`; every *other*
 * `p`-owned vertex must move inside `region`, no opponent vertex may escape `region`, and the
 * `region \ goal` subgraph must be acyclic (any cycle there would be a play that dodges `goal`).
 */
function forcesGoal(a: Arena, region: Subgame, goal: Subgame, p: Player, stratP: number[]): Certificate {
  const opp = other(p)
  for (let v = 0; v < a.n; v++) {
    if (!region[v] || goal[v]) continue
    if (a.owner[v] === p) {
      if (stratP[v] < 0 || !region[stratP[v]]) return { ok: false, reason: `Player ${p} has no in-region move at ${v}` }
    } else {
      for (const w of a.edges[v]) if (!region[w]) return { ok: false, reason: `Player ${opp} escapes the region at ${v}` }
    }
  }
  const off = region.map((inR, v) => inR && !goal[v])
  const adj = (v: number): number[] => (a.owner[v] === p ? [stratP[v]] : a.edges[v]).filter((w) => off[w])
  const looping = nontrivialMembers(a, off, adj)
  for (let v = 0; v < a.n; v++) if (looping[v]) return { ok: false, reason: 'a play cycles without ever reaching the goal' }
  return { ok: true, reason: '' }
}

/** Certify a reachability solution: Player 0 forces the target, Player 1 dodges it forever. */
export function certifyReachability(a: Arena, target: Subgame, sol: Solution): Certificate {
  const W0 = sol.winner.map((w) => w === 0)
  const W1 = sol.winner.map((w) => w === 1)

  const p0 = forcesGoal(a, W0, target, 0, sol.strat0)
  if (!p0.ok) return { ok: false, reason: `Player 0: ${p0.reason}` }

  // Player 1 dodges forever: W1 must be closed and hold no target.
  for (let v = 0; v < a.n; v++) if (W1[v] && target[v]) return { ok: false, reason: 'a target vertex is claimed for Player 1' }
  const { closed } = pinned(a, W1, 1, sol.strat1)
  if (!closed) return { ok: false, reason: "Player 1's dodging strategy is not closed on W1" }

  return { ok: true, reason: 'Player 0 forces the target; Player 1 traps the play away from it' }
}

/** Certify a safety solution: Player 0 stays out of the bad set forever, Player 1 forces into it. */
export function certifySafety(a: Arena, bad: Subgame, sol: Solution): Certificate {
  const W0 = sol.winner.map((w) => w === 0)
  const W1 = sol.winner.map((w) => w === 1)

  // Player 0 stays safe: W0 must be closed and hold no bad vertex.
  for (let v = 0; v < a.n; v++) if (W0[v] && bad[v]) return { ok: false, reason: 'a bad vertex is claimed safe for Player 0' }
  const { closed } = pinned(a, W0, 0, sol.strat0)
  if (!closed) return { ok: false, reason: "Player 0's safe strategy is not closed on W0" }

  // Player 1 forces the hazard.
  const p1 = forcesGoal(a, W1, bad, 1, sol.strat1)
  if (!p1.ok) return { ok: false, reason: `Player 1: ${p1.reason}` }

  return { ok: true, reason: 'Player 0 stays safe; Player 1 forces the bad set' }
}
