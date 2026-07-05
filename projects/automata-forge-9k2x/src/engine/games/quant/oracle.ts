// The brute-force referee — the ground truth the fast solvers are measured against on small arenas.
//
// Mean-payoff games are *positionally* determined: both players have an optimal memoryless strategy.
// So the value is computable by naked enumeration — fix a memoryless strategy for each player, and
// the arena collapses to a single deterministic path from every start, which spirals into exactly
// one cycle whose mean *is* the payoff. The **lower** value is max over Max's strategies of the min
// over Min's (Max commits first); the **upper** value is min-then-max (Min commits first). A theorem
// says they coincide — and this module checks that coincidence rather than assuming it. It shares no
// reasoning with value-iteration or the energy fixpoint, which is what makes it a trustworthy oracle.

import type { WArena, Player } from './types'
import { rat, ratCmp, type Rational } from './rational'

interface Axis {
  v: number
  opts: number[]
}

function axes(a: WArena, p: Player): Axis[] {
  const out: Axis[] = []
  for (let v = 0; v < a.n; v++) if (a.owner[v] === p) out.push({ v, opts: a.out[v].map((e) => e.to) })
  return out
}

function spaceSize(ax: Axis[]): number {
  return ax.reduce((n, x) => n * x.opts.length, 1)
}

function decode(ax: Axis[], k: number, next: number[]): void {
  let r = k
  for (const x of ax) {
    const i = r % x.opts.length
    r = Math.floor(r / x.opts.length)
    next[x.v] = x.opts[i]
  }
}

/** Weight of the edge (v → next[v]). */
function edgeWeight(a: WArena, v: number, to: number): number {
  return a.out[v].find((e) => e.to === to)?.w ?? 0
}

/** The mean of the cycle that the deterministic walk from `v` falls into (exact rational). */
function cyclePayoff(a: WArena, next: number[], v: number): Rational {
  const seen = new Map<number, number>()
  let u = v
  let step = 0
  while (!seen.has(u)) {
    seen.set(u, step++)
    u = next[u]
  }
  const start = seen.get(u) as number
  // Sum the edge weights once around the cycle (from the first repeated vertex).
  let sum = 0
  let len = 0
  let x = u
  do {
    sum += edgeWeight(a, x, next[x])
    x = next[x]
    len++
  } while (x !== u && len <= a.n + 1)
  void start
  return rat(sum, len)
}

export interface OracleValues {
  lower: Rational[]
  upper: Rational[]
}

/**
 * Enumerate every memoryless strategy pair and return the lower (max-min) and upper (min-max)
 * values per vertex. Returns `null` if the strategy space exceeds `budget` (caller skips the case).
 */
export function oracleValues(a: WArena, budget = 400_000): OracleValues | null {
  const ax0 = axes(a, 0)
  const ax1 = axes(a, 1)
  const s0 = spaceSize(ax0)
  const s1 = spaceSize(ax1)
  if (s0 * s1 > budget) return null

  const next = new Array(a.n).fill(0)
  // payoff[k0][k1][v] would be huge; instead accumulate the two values on the fly.
  const lower: (Rational | null)[] = new Array(a.n).fill(null) // max over σ of (min over τ)
  const upper: (Rational | null)[] = new Array(a.n).fill(null) // min over τ of (max over σ)

  // Lower value: Max commits first.
  for (let k0 = 0; k0 < s0; k0++) {
    decode(ax0, k0, next)
    const minOverTau: (Rational | null)[] = new Array(a.n).fill(null)
    for (let k1 = 0; k1 < s1; k1++) {
      decode(ax1, k1, next)
      for (let v = 0; v < a.n; v++) {
        const pay = cyclePayoff(a, next, v)
        if (minOverTau[v] === null || ratCmp(pay, minOverTau[v] as Rational) < 0) minOverTau[v] = pay
      }
    }
    for (let v = 0; v < a.n; v++) {
      const m = minOverTau[v] as Rational
      if (lower[v] === null || ratCmp(m, lower[v] as Rational) > 0) lower[v] = m
    }
  }

  // Upper value: Min commits first.
  for (let k1 = 0; k1 < s1; k1++) {
    decode(ax1, k1, next)
    const maxOverSigma: (Rational | null)[] = new Array(a.n).fill(null)
    for (let k0 = 0; k0 < s0; k0++) {
      decode(ax0, k0, next)
      for (let v = 0; v < a.n; v++) {
        const pay = cyclePayoff(a, next, v)
        if (maxOverSigma[v] === null || ratCmp(pay, maxOverSigma[v] as Rational) > 0) maxOverSigma[v] = pay
      }
    }
    for (let v = 0; v < a.n; v++) {
      const m = maxOverSigma[v] as Rational
      if (upper[v] === null || ratCmp(m, upper[v] as Rational) < 0) upper[v] = m
    }
  }

  return { lower: lower as Rational[], upper: upper as Rational[] }
}
