// The phase-transition explorer — arguably the most famous empirical picture in
// all of SAT. Hold the variable count n fixed and sweep the clause-to-variable
// ratio α = m/n of uniform random 3-SAT. Two curves emerge together:
//
//   • The *satisfiability threshold*: the probability that a random instance is
//     satisfiable drops sharply from ≈1 to ≈0 around α ≈ 4.267 (sharper as n
//     grows) — a genuine phase transition between a SAT phase and an UNSAT phase.
//
//   • The *easy–hard–easy* pattern: solver effort (here, CDCL conflicts and SLS
//     flips) is tiny in the under- and over-constrained regimes and spikes into a
//     pronounced peak right at the threshold, where instances are critically
//     constrained.
//
// We measure the truth (SAT/UNSAT) with the complete CDCL solver and the
// stochastic effort with WalkSAT, so the explorer simultaneously demonstrates the
// physics *and* cross-validates the two engines against each other.

import type { CNF } from '../sat/cnf'
import { solve } from '../sat/solver'
import { randomKSat } from '../sat/encoders/random3sat'
import { localSearch } from './localsearch'

export interface PhasePoint {
  alpha: number
  /** Fraction of sampled instances the complete solver found satisfiable. */
  satFraction: number
  /** Median CDCL conflicts across all samples at this α. */
  medianConflicts: number
  /** Median WalkSAT flips across the satisfiable samples (0 if none). */
  medianFlips: number
  /** Fraction of satisfiable instances WalkSAT also solved within budget. */
  slsAgreement: number
  samples: number
}

export interface PhaseOptions {
  numVars?: number // default 80
  k?: number // clause width (default 3)
  alphaMin?: number // default 3.0
  alphaMax?: number // default 6.0
  steps?: number // number of α points (default 16)
  samplesPerPoint?: number // random instances per α (default 12)
  seed?: number // base RNG seed (default 1)
  /** Per-instance CDCL conflict budget (default 200000). */
  cdclConflicts?: number
  /** Per-instance WalkSAT flip budget multiplier (× n²-ish); see code. */
  slsMaxFlips?: number
  /** Overall wall-clock budget in ms; sweep stops early if exceeded (default 12000). */
  maxTimeMs?: number
}

export interface PhaseResult {
  points: PhasePoint[]
  numVars: number
  k: number
  /** The classic critical ratio for 3-SAT, for drawing a reference line. */
  threshold: number
  timeMs: number
  completed: boolean
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Run the α-sweep. Deterministic for a given seed; honours a wall-clock budget. */
export function sweepPhase(opts: PhaseOptions = {}): PhaseResult {
  const n = opts.numVars ?? 80
  const k = opts.k ?? 3
  const alphaMin = opts.alphaMin ?? 3.0
  const alphaMax = opts.alphaMax ?? 6.0
  const steps = opts.steps ?? 16
  const samples = opts.samplesPerPoint ?? 12
  const seed = opts.seed ?? 1
  const cdclConflicts = opts.cdclConflicts ?? 200000
  const slsMaxFlips = opts.slsMaxFlips ?? Math.max(20000, 200 * n)
  const maxTimeMs = opts.maxTimeMs ?? 12000
  const start = performance.now()

  const points: PhasePoint[] = []
  let completed = true
  for (let i = 0; i < steps; i++) {
    const alpha = steps === 1 ? alphaMin : alphaMin + ((alphaMax - alphaMin) * i) / (steps - 1)
    let satCount = 0
    let decided = 0
    const conflicts: number[] = []
    const flips: number[] = []
    let satInstances = 0
    let slsSolved = 0

    for (let s = 0; s < samples; s++) {
      const instSeed = seed * 100003 + i * 9176 + s * 31 + 1
      const cnf: CNF = randomKSat(n, alpha, k, instSeed)
      const r = solve(cnf, { maxConflicts: cdclConflicts, maxTimeMs: 1500, restartBase: 100, randomSeed: instSeed })
      conflicts.push(r.stats.conflicts)
      if (r.status === 'sat') {
        satCount++
        decided++
        satInstances++
        const ls = localSearch(cnf, {
          algorithm: 'walksat',
          seed: instSeed,
          maxFlips: slsMaxFlips,
          maxTries: 10,
          maxTimeMs: 800,
        })
        if (ls.status === 'sat') {
          slsSolved++
          flips.push(ls.flips)
        }
      } else if (r.status === 'unsat') {
        decided++
      }

      if (performance.now() - start > maxTimeMs) {
        completed = false
        break
      }
    }

    points.push({
      alpha,
      satFraction: decided > 0 ? satCount / decided : 0,
      medianConflicts: median(conflicts),
      medianFlips: median(flips),
      slsAgreement: satInstances > 0 ? slsSolved / satInstances : 1,
      samples,
    })
    if (!completed) break
  }

  return { points, numVars: n, k, threshold: k === 3 ? 4.267 : 0, timeMs: performance.now() - start, completed }
}
