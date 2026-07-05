// The weighted game arena — the model for *quantitative* infinite games (mean-payoff & energy).
//
// The board is the same kind of finite graph as the qualitative Games mode, but now every **edge**
// carries an integer weight (a reward/cost the mover collects when the token crosses it). Player 0
// is **Max** (the protagonist / maximiser), Player 1 is **Min** (the antagonist / minimiser).
//
//  - Mean-payoff game: the payoff of an infinite play is the long-run average edge weight,
//    liminf_{k} (1/k) Σ_{i<k} w(eᵢ). Max wants it high, Min low. A deep theorem (Ehrenfeucht &
//    Mycielski 1979) says the game has a **value** ν(v) that both players secure with a single
//    *positional* (memoryless) strategy, and liminf = limsup under optimal play.
//  - Energy game: Max additionally must keep the running sum ≥ 0 forever from some finite starting
//    credit; the least sufficient credit per vertex is the *energy value*. Deciding "can Max keep
//    energy ≥ 0?" is exactly deciding ν(v) ≥ 0, which is why one solver answers both.

import type { WEdge } from './rational'
export type { WEdge } from './rational'

export type Player = 0 | 1
export function other(p: Player): Player {
  return (1 - p) as Player
}

/**
 * A weighted arena. Vertices are `0..n-1`; `out[v]` are the weighted out-edges (the arena is kept
 * **total** — every vertex has at least one). `owner[v]` says who moves the token at `v`.
 */
export interface WArena {
  n: number
  owner: Player[]
  out: WEdge[][]
  labels: string[]
  pos: { x: number; y: number }[]
}

export function cloneWArena(a: WArena): WArena {
  return {
    n: a.n,
    owner: a.owner.slice(),
    out: a.out.map((es) => es.map((e) => ({ ...e }))),
    labels: a.labels.slice(),
    pos: a.pos.map((p) => ({ ...p })),
  }
}

/** The largest |weight| in the arena — the W that bounds every value-iteration horizon. */
export function maxAbsWeight(a: WArena): number {
  let w = 0
  for (const es of a.out) for (const e of es) w = Math.max(w, Math.abs(e.w))
  return w
}

/** Validate a weighted arena: totality and in-range edges. Returns an error string or null. */
export function validateWArena(a: WArena): string | null {
  if (a.n <= 0) return 'arena has no vertices'
  if (a.owner.length !== a.n || a.out.length !== a.n) return 'arena arrays disagree on size'
  for (let v = 0; v < a.n; v++) {
    if (a.owner[v] !== 0 && a.owner[v] !== 1) return `vertex ${v} has no valid owner`
    if (a.out[v].length === 0) return `vertex ${v} is a dead end (arena must be total)`
    for (const e of a.out[v]) if (e.to < 0 || e.to >= a.n) return `vertex ${v} has an out-of-range edge to ${e.to}`
  }
  return null
}

/** Add a constant to every edge weight (used to demonstrate shift-invariance: ν ↦ ν + c). */
export function shiftWeights(a: WArena, c: number): WArena {
  const b = cloneWArena(a)
  for (const es of b.out) for (const e of es) e.w += c
  return b
}

/** Scale every edge weight by a factor (positive λ scales the value: ν ↦ λ·ν). */
export function scaleWeights(a: WArena, lambda: number): WArena {
  const b = cloneWArena(a)
  for (const es of b.out) for (const e of es) e.w *= lambda
  return b
}

/** Convenience view: the plain successor list (drops weights), for reachability/graph routines. */
export function succ(a: WArena, v: number): number[] {
  return a.out[v].map((e) => e.to)
}
