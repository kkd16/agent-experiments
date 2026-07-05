// Zwick–Paterson (1996) — the exact value of every vertex of a mean-payoff game.
//
// Play the *finite* k-step game: fₖ(v) is the best total weight the mover can guarantee over the
// next k edges, Max maximising and Min minimising. It obeys the one-step recurrence
//   f₀(v) = 0,   fₖ(v) = opt_{(v,u)} [ w(v,u) + f_{k-1}(u) ]     (opt = max if v∈Max else min).
// Zwick & Paterson proved fₖ(v)/k → ν(v), the mean-payoff value, and — crucially — that once
// k > 4·n³·W the estimate is within 1/(2n²) of ν(v). Because the value is a rational with
// denominator ≤ n and any two such rationals are ≥ 1/n² apart, rounding fₖ(v)/k to the nearest
// small-denominator rational recovers ν(v) *exactly*. No floating point survives into the answer.

import type { WArena } from './types'
import { bestRational, rat, type Rational } from './rational'

export interface MeanPayoffValues {
  /** The exact mean-payoff value ν(v) of every vertex. */
  value: Rational[]
  /** The final k-step optimum fₖ(v) (integer) and the horizon k it was taken at. */
  iterate: number[]
  horizon: number
}

/**
 * Compute ν(v) for all v by Zwick–Paterson value iteration. Deterministic and exact.
 * The horizon 4·n³·W + 1 is the theoretical sufficiency bound; with W = 0 the value is 0 everywhere.
 */
export function meanPayoffValues(a: WArena): MeanPayoffValues {
  const n = a.n
  let W = 0
  for (const es of a.out) for (const e of es) W = Math.max(W, Math.abs(e.w))

  if (W === 0) {
    return { value: new Array(n).fill(0).map(() => rat(0)), iterate: new Array(n).fill(0), horizon: 0 }
  }

  const K = 4 * n * n * n * W + 1
  let prev = new Array(n).fill(0)
  let cur = new Array(n).fill(0)
  for (let k = 1; k <= K; k++) {
    for (let v = 0; v < n; v++) {
      const es = a.out[v]
      let best = a.owner[v] === 0 ? -Infinity : Infinity
      for (const e of es) {
        const val = e.w + prev[e.to]
        if (a.owner[v] === 0) {
          if (val > best) best = val
        } else if (val < best) best = val
      }
      cur[v] = best
    }
    ;[prev, cur] = [cur, prev]
  }
  const iterate = prev // after the swap, `prev` holds f_K
  const value: Rational[] = iterate.map((f) => bestRational(f, K, n))
  return { value, iterate, horizon: K }
}

/** The threshold decision "is ν(v) ≥ 0?" read straight off the exact values. */
export function nonNegativeValue(vals: Rational[]): boolean[] {
  return vals.map((r) => r.p >= 0)
}
