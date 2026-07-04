// A brute-force oracle — the ground truth the fast solvers are measured against on small arenas.
//
// These games are positionally determined, so `v` is won by Player 0 iff Player 0 has *some*
// memoryless strategy that beats *every* memoryless reply by Player 1. This module simply
// enumerates all such strategy pairs and simulates the (now deterministic) play to its inevitable
// cycle. It shares no reasoning with the attractor/Zielonka machinery — it only knows the rules —
// which is exactly what makes it a trustworthy referee.

import type { Arena, Player } from './types'

/** Vertices owned by `p`, with their available moves — the axes of the strategy space. */
function choiceAxes(a: Arena, p: Player): { v: number; opts: number[] }[] {
  const axes: { v: number; opts: number[] }[] = []
  for (let v = 0; v < a.n; v++) if (a.owner[v] === p) axes.push({ v, opts: a.edges[v] })
  return axes
}

function spaceSize(axes: { opts: number[] }[]): number {
  return axes.reduce((n, ax) => n * ax.opts.length, 1)
}

/** Decode the k-th memoryless strategy into a `next[]` override for `p`'s vertices. */
function decode(axes: { v: number; opts: number[] }[], k: number, next: number[]): void {
  let r = k
  for (const ax of axes) {
    const i = r % ax.opts.length
    r = Math.floor(r / ax.opts.length)
    next[ax.v] = ax.opts[i]
  }
}

/** Follow a deterministic `next` from `v` until a vertex repeats; return the cycle's vertex set. */
function cycleFrom(next: number[], v: number): number[] {
  const seen = new Map<number, number>()
  let u = v
  let step = 0
  while (!seen.has(u)) {
    seen.set(u, step++)
    u = next[u]
  }
  const start = seen.get(u) as number
  const cyc: number[] = []
  for (const [vertex, when] of seen) if (when >= start) cyc.push(vertex)
  return cyc
}

/** True iff `v`'s deterministic play reaches a `target` vertex before it starts cycling. */
function reaches(next: number[], target: boolean[], v: number): boolean {
  const seen = new Set<number>()
  let u = v
  while (!seen.has(u)) {
    if (target[u]) return true
    seen.add(u)
    u = next[u]
  }
  return target[u]
}

export type OracleKind = 'parity' | 'reachability' | 'safety'

/**
 * The oracle's per-vertex winner. `priority` is used for parity; `marked` is the target
 * (reachability) or bad set (safety). Returns `null` if the strategy space is too large to brute
 * force (the caller then simply skips this instance).
 */
export function oracleWinners(
  a: Arena,
  kind: OracleKind,
  opts: { priority?: number[]; marked?: boolean[] },
  budget = 400_000,
): Player[] | null {
  const ax0 = choiceAxes(a, 0)
  const ax1 = choiceAxes(a, 1)
  const size0 = spaceSize(ax0)
  const size1 = spaceSize(ax1)
  if (size0 * size1 > budget) return null

  const priority = opts.priority ?? a.priority
  const marked = opts.marked ?? new Array(a.n).fill(false)
  const win0 = new Array(a.n).fill(false)
  const next = new Array(a.n).fill(0)

  for (let k0 = 0; k0 < size0; k0++) {
    decode(ax0, k0, next)
    const beatsAll = new Array(a.n).fill(true)
    for (let k1 = 0; k1 < size1; k1++) {
      decode(ax1, k1, next)
      for (let v = 0; v < a.n; v++) {
        if (!beatsAll[v]) continue
        let player0Wins: boolean
        if (kind === 'parity') {
          const cyc = cycleFrom(next, v)
          let mx = -1
          for (const u of cyc) if (priority[u] > mx) mx = priority[u]
          player0Wins = mx % 2 === 0
        } else if (kind === 'reachability') {
          player0Wins = reaches(next, marked, v)
        } else {
          player0Wins = !reaches(next, marked, v) // safety: never touch the bad set
        }
        if (!player0Wins) beatsAll[v] = false
      }
    }
    for (let v = 0; v < a.n; v++) if (beatsAll[v]) win0[v] = true
  }

  return win0.map((w) => (w ? 0 : 1)) as Player[]
}
