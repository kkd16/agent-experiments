// Seeded random weighted arenas — fuel for the differential fuzzer. Deterministic from a seed, so
// any solver disagreement is one permalink away from replay.

import type { WArena, Player } from './types'
import type { WEdge } from './rational'

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x9e3779b9) >>> 0
    let z = s
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0
    return ((z ^ (z >>> 15)) >>> 0) / 4294967296
  }
}

export interface RandomWOptions {
  n: number
  maxOut?: number
  /** Weights are drawn uniformly from [−maxWeight, maxWeight]. */
  maxWeight?: number
}

export function randomWArena(seed: number, o: RandomWOptions): WArena {
  const r = rng(seed)
  const n = o.n
  const maxOut = Math.max(1, o.maxOut ?? 2)
  const maxWeight = Math.max(1, o.maxWeight ?? 4)

  const owner: Player[] = []
  const out: WEdge[][] = []
  const labels: string[] = []
  const pos: { x: number; y: number }[] = []

  for (let v = 0; v < n; v++) {
    owner.push((r() < 0.5 ? 0 : 1) as Player)
    const deg = 1 + Math.floor(r() * maxOut)
    const targets = new Set<number>()
    while (targets.size < deg) targets.add(Math.floor(r() * n))
    out.push(
      [...targets].map((to) => ({ to, w: Math.floor(r() * (2 * maxWeight + 1)) - maxWeight })),
    )
    labels.push(String(v))
    const ang = (2 * Math.PI * v) / n - Math.PI / 2
    pos.push({ x: 50 + 40 * Math.cos(ang), y: 50 + 40 * Math.sin(ang) })
  }

  return { n, owner, out, labels, pos }
}
