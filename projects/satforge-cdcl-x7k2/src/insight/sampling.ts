// Almost-uniform witness sampling — a from-scratch UniGen.
//
// Counting a formula's models (see ./approxmc) and *drawing one at random* are the
// two faces of the same coin. A uniform SAT witness generator is the workhorse behind
// constrained-random hardware verification, statistical software testing, and Bayesian
// inference by weighted sampling: you want a solution nobody hand-picked, drawn with
// exactly the odds the solution space assigns it.
//
// The naive idea — "ask the solver for a model" — fails badly: a CDCL (or any DPLL)
// search returns whatever its heuristics stumble into first, so its answers pile up on
// a handful of solutions and starve the rest (the `naiveSample` baseline below makes
// this visible). UniGen (Chakraborty, Meel & Vardi, 2014/2015) fixes it with the same
// gorgeous trick ApproxMC uses to *count*: hash the 2ⁿ-dimensional solution space into
// 2^q random cells with q XOR (parity) constraints from a pairwise-independent family,
// so each solution lands in a cell almost independently of every other. Pick the hash
// count q so a typical cell holds a *small, bounded* number of survivors — few enough
// to enumerate exactly — then return one of those survivors chosen uniformly at random.
// Composed, the two uniform choices (which cell the XORs carve, which survivor inside)
// give an almost-uniform draw over the whole space, with a tunable tolerance κ.
//
// Everything reuses machinery already in this module: `appendXor` (the Tseitin XOR
// gate, shared with the counter), `approxModelCount` (to size the hash count q), and
// `projectedModels` (to enumerate a cell's survivors, projected onto the sampling set).
// The selftest module cross-checks the output distribution against exact enumeration —
// so the studio can *prove*, live, that the samples come out flat.

import type { CNF } from '../sat/cnf'
import { solve } from '../sat/solver'
import { projectedModels } from './enumerate'
import { appendXor, mulberry32 } from './approxmc'
import { approxModelCount } from './approxmc'

const nowFn = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** A drawn witness, as a 1-based boolean array over the sampling variables (every
 *  non-sampling index is left `false`). */
export type Sample = boolean[]

export interface UniGenOptions {
  /** How many witnesses to draw (default 20). */
  numSamples?: number
  /** Almost-uniformity tolerance κ > 0: each witness's probability lands within a
   *  (1+κ) factor of 1/#models. Smaller κ ⇒ larger cells ⇒ more work (default 0.9). */
  kappa?: number
  /** RNG seed for reproducibility (default 0x5a1f). */
  seed?: number
  /** Independent support: sample only these variables (others are functionally
   *  determined). Defaults to all variables. */
  sampling?: number[]
  /** Hard cap on how many survivors a cell may be enumerated to before it is judged
   *  "too big" and rejected (default 512 — keeps the browser responsive). */
  cellCap?: number
  /** Bounded retries per witness when cells keep landing out of the accept band
   *  (default 12). */
  maxAttemptsPerSample?: number
  /** Override the model-count estimate feeding the hash-count choice (skips ApproxMC
   *  when the caller already knows it, e.g. from the exact counter). */
  countHint?: number
}

export interface UniGenResult {
  /** The drawn witnesses (each a 1-based boolean array over the sampling set). */
  samples: Sample[]
  /** The sampling variables actually used (sorted, de-duplicated, in range). */
  samplingVars: number[]
  /** True when the whole formula fit in one accept-band cell, so it was enumerated and
   *  sampled *exactly* uniformly — no hashing needed. */
  fastPath: boolean
  /** The model-count estimate that sized the hash count. */
  estimate: number
  /** Nominal number of XOR hashes q the algorithm centred its search on. */
  hashBits: number
  /** The pivot (target cell size) and the [loThresh, hiThresh] accept band. */
  pivot: number
  loThresh: number
  hiThresh: number
  /** Cell-enumeration calls made (a proxy for cost). */
  attempts: number
  /** Rejected cells (out of the accept band or empty) across all draws. */
  rejects: number
  /** Draws that exhausted their retries and fell back to a best-effort cell (0 ideally). */
  fallbacks: number
  timeMs: number
}

function sanitizeSampling(cnf: CNF, sampling?: number[]): number[] {
  const src = sampling ?? Array.from({ length: cnf.numVars }, (_, i) => i + 1)
  return [...new Set(src.filter((v) => v >= 1 && v <= cnf.numVars))].sort((a, b) => a - b)
}

/** Enumerate the survivors of `cnf ∧ (the first q XOR hashes)`, projected onto the
 *  sampling set, capped at `cap`+1 so an over-full cell is detectable. Returns the
 *  distinct sampling-assignments (as full boolean arrays over the sampling vars). */
function cellSurvivors(
  cnf: CNF,
  hashes: { vars: number[]; parity: 0 | 1 }[],
  q: number,
  samplingVars: number[],
  cap: number,
): Sample[] {
  const xorClauses: number[][] = []
  let nextVar = cnf.numVars + 1
  for (let k = 0; k < q; k++) nextVar = appendXor(xorClauses, hashes[k].vars, hashes[k].parity, nextVar)
  const augVars = nextVar - 1
  const aug: CNF = { numVars: augVars, clauses: cnf.clauses.concat(xorClauses) }
  const res = projectedModels(aug, samplingVars, { maxModels: cap + 1 })
  // Restrict each returned model to the sampling variables (drop XOR aux + non-sampling).
  return res.models.map((full) => {
    const s: Sample = new Array<boolean>(cnf.numVars + 1).fill(false)
    for (const v of samplingVars) s[v] = full[v]
    return s
  })
}

/**
 * Draw `numSamples` almost-uniform witnesses of `cnf` over the sampling set.
 */
export function uniGen(cnf: CNF, opts: UniGenOptions = {}): UniGenResult {
  const start = nowFn()
  const numSamples = opts.numSamples ?? 20
  const kappa = opts.kappa ?? 0.9
  const seed = opts.seed ?? 0x5a1f
  const cellCap = opts.cellCap ?? 512
  const maxAttempts = opts.maxAttemptsPerSample ?? 12
  const samplingVars = sanitizeSampling(cnf, opts.sampling)
  const nSamp = samplingVars.length
  const rng = mulberry32(seed)

  // Accept band around a pivot cell size. The pivot grows as κ shrinks (tighter
  // uniformity needs larger, more-averaged cells). Constants are tuned for the small,
  // interactive instances the studio explores and validated against the exact oracle
  // in the selftest — the shape follows UniGen's 1+(1+κ)·pivot / pivot/(1+κ) band.
  const pivot = Math.max(2, Math.ceil(2 * (1 + 1 / kappa) * (1 + 1 / kappa)))
  const hiThresh = Math.min(cellCap, Math.ceil(1 + (1 + kappa) * pivot))
  const loThresh = Math.max(1, Math.floor(pivot / (1 + kappa)))

  // Size q: aim for cells of ~pivot survivors, i.e. 2^q ≈ estimate / pivot.
  let estimate: number
  if (opts.countHint !== undefined && opts.countHint > 0) {
    estimate = opts.countHint
  } else {
    // A light ApproxMC pass is plenty to size the hash count (we only need log₂).
    const amc = approxModelCount(cnf, { epsilon: 0.8, delta: 0.3, seed, sampling: samplingVars, rounds: 7 })
    estimate = Math.max(1, amc.estimate)
  }

  // Fast path: the whole space already fits one accept-band cell ⇒ enumerate & pick
  // uniformly for an *exactly* uniform draw.
  const q0 = Math.round(Math.log2(Math.max(1, estimate) / pivot))
  const clampQ = (q: number) => Math.max(0, Math.min(nSamp, q))
  const qNominal = clampQ(q0)

  let attempts = 0
  let rejects = 0
  let fallbacks = 0

  if (estimate <= hiThresh || nSamp === 0) {
    const all = cellSurvivors(cnf, [], 0, samplingVars, cellCap)
    attempts++
    const samples: Sample[] = []
    if (all.length > 0) {
      for (let i = 0; i < numSamples; i++) samples.push(all[Math.floor(rng() * all.length)])
    }
    return {
      samples,
      samplingVars,
      fastPath: true,
      estimate,
      hashBits: 0,
      pivot,
      loThresh,
      hiThresh,
      attempts,
      rejects,
      fallbacks,
      timeMs: nowFn() - start,
    }
  }

  const samples: Sample[] = []
  for (let s = 0; s < numSamples; s++) {
    let drawn: Sample | null = null
    // Each witness gets its own fresh family of XOR hashes.
    for (let attempt = 0; attempt < maxAttempts && drawn === null; attempt++) {
      // Draw up to nSamp parity constraints; using the first q of them gives 2^q cells.
      const hashes: { vars: number[]; parity: 0 | 1 }[] = []
      for (let i = 0; i < nSamp; i++) {
        const vars: number[] = []
        for (const v of samplingVars) if (rng() < 0.5) vars.push(v)
        hashes.push({ vars, parity: rng() < 0.5 ? 1 : 0 })
      }
      // Search a small window of hash counts around q for an accept-band cell. Walk
      // outward (q, q+1, q-1, q+2, …) so we prefer the nominal cell size.
      const order: number[] = [qNominal]
      for (let d = 1; d <= 3; d++) {
        order.push(clampQ(qNominal + d))
        order.push(clampQ(qNominal - d))
      }
      let best: Sample[] | null = null
      for (const q of order) {
        const cell = cellSurvivors(cnf, hashes, q, samplingVars, hiThresh)
        attempts++
        if (cell.length >= loThresh && cell.length <= hiThresh) {
          drawn = cell[Math.floor(rng() * cell.length)]
          break
        }
        rejects++
        // Remember any non-empty cell as a fallback if the whole window misses.
        if (cell.length > 0 && (best === null || cell.length < best.length)) best = cell
      }
      if (drawn === null && attempt === maxAttempts - 1 && best !== null) {
        drawn = best[Math.floor(rng() * best.length)]
        fallbacks++
      }
    }
    if (drawn !== null) samples.push(drawn)
  }

  return {
    samples,
    samplingVars,
    fastPath: false,
    estimate,
    hashBits: qNominal,
    pivot,
    loThresh,
    hiThresh,
    attempts,
    rejects,
    fallbacks,
    timeMs: nowFn() - start,
  }
}

// ---------------------------------------------------------------------------
// A deliberately *biased* baseline, for contrast.
// ---------------------------------------------------------------------------

export interface NaiveResult {
  samples: Sample[]
  samplingVars: number[]
  solverCalls: number
  timeMs: number
}

/**
 * The "just ask the solver" sampler. A CDCL search branches with a fixed default
 * polarity, so on its own it returns the same few models over and over. To make it a
 * *sampler* at all — and to expose its bias honestly rather than as a single spike —
 * we randomise the polarity per draw with a zero-cost trick that needs no change to the
 * core engine: pick a random flip mask f ∈ {0,1}ⁿ, rewrite every literal on a flipped
 * variable to its negation, solve the flipped formula (whose models are the real ones
 * XOR f), and map the model back through f. The solver now explores from a random
 * corner each time, so it reaches many models — but with the lumpy, search-order-driven
 * frequencies that make it *not* uniform. That lumpiness, next to UniGen's flat bars, is
 * the whole point.
 */
export function naiveSample(cnf: CNF, opts: { numSamples?: number; seed?: number; sampling?: number[] } = {}): NaiveResult {
  const start = nowFn()
  const numSamples = opts.numSamples ?? 20
  const seed = opts.seed ?? 0x5a1f
  const samplingVars = sanitizeSampling(cnf, opts.sampling)
  const rng = mulberry32(seed)
  const n = cnf.numVars
  const samples: Sample[] = []
  let calls = 0

  for (let s = 0; s < numSamples; s++) {
    const flip = new Array<boolean>(n + 1).fill(false)
    for (let v = 1; v <= n; v++) flip[v] = rng() < 0.5
    const flipped = cnf.clauses.map((c) => c.map((l) => (flip[Math.abs(l)] ? -l : l)))
    // A fresh, well-mixed seed per draw so the random branch order varies.
    const randomSeed = (Math.floor(rng() * 0xffffffff) ^ (s * 2654435761)) >>> 0
    const r = solve({ numVars: n, clauses: flipped }, { branch: 'random', randomSeed })
    calls++
    if (r.status !== 'sat') continue
    const real: Sample = new Array<boolean>(n + 1).fill(false)
    for (const v of samplingVars) real[v] = flip[v] ? !r.model![v] : r.model![v]
    samples.push(real)
  }

  return { samples, samplingVars, solverCalls: calls, timeMs: nowFn() - start }
}
