// Seeded random arenas — fuel for the differential fuzzer that pits the solvers against the oracle
// and the certificate. Deterministic from a seed, so any failure is a permalink away from replay.

import type { Arena, Condition, Player } from './types'

/** splitmix32 — a tiny deterministic PRNG; good enough to shake out solver bugs. */
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

export interface RandomOptions {
  n: number
  /** Highest parity priority (inclusive); ignored for non-parity conditions. */
  maxPriority?: number
  /** Maximum out-degree per vertex (at least 1). */
  maxOut?: number
}

/** Build a total random arena for the given condition. */
export function randomArena(seed: number, cond: Condition, o: RandomOptions): Arena {
  const r = rng(seed)
  const n = o.n
  const maxOut = Math.max(1, o.maxOut ?? 3)
  const maxPriority = o.maxPriority ?? 3

  const owner: Player[] = []
  const edges: number[][] = []
  const priority: number[] = []
  const accent: boolean[] = []
  const labels: string[] = []
  const pos: { x: number; y: number }[] = []

  for (let v = 0; v < n; v++) {
    owner.push((r() < 0.5 ? 0 : 1) as Player)
    const deg = 1 + Math.floor(r() * maxOut)
    const succ = new Set<number>()
    while (succ.size < deg) succ.add(Math.floor(r() * n))
    edges.push([...succ])
    priority.push(cond === 'parity' ? Math.floor(r() * (maxPriority + 1)) : 0)
    accent.push(cond === 'parity' ? false : r() < 0.35)
    labels.push(String(v))
    const ang = (2 * Math.PI * v) / n - Math.PI / 2
    pos.push({ x: 50 + 40 * Math.cos(ang), y: 50 + 40 * Math.sin(ang) })
  }

  // Guarantee at least one target for a reachability arena, so the game is not vacuous.
  if (cond === 'reachability' && !accent.some(Boolean)) accent[n - 1] = true

  return { n, owner, edges, priority, accent, labels, pos }
}
