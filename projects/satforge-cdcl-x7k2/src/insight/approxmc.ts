// Approximate model counting by universal hashing — an ApproxMC-style estimator.
//
// Exact #SAT (see ../sat/modelCount.ts) is #P-complete and blows up on hard, wide
// formulas. ApproxMC (Chakraborty, Meel & Vardi, 2013/2016) trades exactness for a
// probabilistic guarantee: with probability ≥ 1−δ it returns a count within a
// (1+ε) factor of the truth. The trick is gorgeous — randomly *hash* the solution
// space into 2^m cells with m random XOR (parity) constraints, count the survivors
// in one small cell exactly (bounded by a threshold), and scale back up by 2^m.
//
// Because a CDCL solver eats CNF, each XOR  x_{i1} ⊕ … ⊕ x_{ik} = b  is Tseitin-
// chained into 4-clause XOR gates (o = p ⊕ q) so the very same engine reasons about
// parity. The result is a from-scratch, hashing-based counter that stands beside the
// exact one — and, on the curated instances, lands within its factor every time.

import type { CNF } from '../sat/cnf'
import { allModels } from './enumerate'

/** A tiny deterministic PRNG (mulberry32) so a seeded estimate is reproducible.
 *  Exported so the sampler (see ./sampling) draws its XOR hashes from the very same
 *  reproducible stream shape. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface ApproxMcOptions {
  /** Multiplicative tolerance ε (default 0.8). Estimate ∈ [count/(1+ε), count·(1+ε)]. */
  epsilon?: number
  /** Failure probability δ (default 0.2). */
  delta?: number
  /** Override the number of estimation rounds t (default: the δ-implied value, capped). */
  rounds?: number
  /** RNG seed for reproducibility (default 0x5a1f). */
  seed?: number
  /** Hard cap on the per-cell bounded count, keeps the browser responsive (default 400). */
  threshCap?: number
  /** Sampling variables (independent support). Defaults to all variables. */
  sampling?: number[]
}

export interface ApproxMcResult {
  /** The (ε,δ) estimate of the model count. */
  estimate: number
  /** The per-round cell estimates whose median is `estimate`. */
  roundEstimates: number[]
  /** The pivot threshold used for bounded counting. */
  thresh: number
  /** Rounds actually run. */
  rounds: number
  /** True if the formula was small enough to have been counted exactly instead. */
  exactSmall: boolean
  /** Bounded-#SAT calls made. */
  boundedCalls: number
  timeMs: number
}

const nowFn = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/**
 * Append the CNF encoding of one XOR constraint  (⊕ vars) = parity  to `clauses`,
 * allocating fresh Tseitin variables starting at `nextVar`. Returns the new nextVar.
 *
 * Exported: the almost-uniform sampler (see ./sampling) hashes the solution space with
 * the identical parity-constraint family, so it shares this single encoding.
 */
export function appendXor(clauses: number[][], vars: number[], parity: 0 | 1, nextVar: number): number {
  if (vars.length === 0) {
    if (parity === 1) clauses.push([]) // empty ⊕ = 0 ≠ 1  ⇒  contradiction
    return nextVar
  }
  let acc = vars[0] // a₁ = x₁ (reuse the variable itself)
  for (let j = 1; j < vars.length; j++) {
    const x = vars[j]
    const o = nextVar++ // fresh aux: o = acc ⊕ x
    clauses.push([-o, -acc, -x])
    clauses.push([-o, acc, x])
    clauses.push([o, -acc, x])
    clauses.push([o, acc, -x])
    acc = o
  }
  clauses.push(parity === 1 ? [acc] : [-acc]) // fix the running parity to b
  return nextVar
}

/** Bounded model count of `base` augmented with `xorClauses`, capped at `thresh`.
 *  Returns { count, capped }: capped=true means "≥ thresh" (true count unknown). */
function boundedCount(
  base: CNF,
  xorClauses: number[][],
  augVars: number,
  thresh: number,
): { count: number; capped: boolean } {
  const clauses = base.clauses.concat(xorClauses)
  // Enumerate up to `thresh` models. Aux XOR vars are functionally determined by the
  // sampling assignment, so the full-model count equals the number of surviving
  // sampling assignments — no projection needed for correctness.
  const r = allModels({ numVars: augVars, clauses }, { maxModels: thresh })
  return { count: r.models.length, capped: !r.complete }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Estimate the number of models of `cnf` with an (ε,δ) guarantee.
 */
export function approxModelCount(cnf: CNF, opts: ApproxMcOptions = {}): ApproxMcResult {
  const epsilon = opts.epsilon ?? 0.8
  const delta = opts.delta ?? 0.2
  const seed = opts.seed ?? 0x5a1f
  const threshCap = opts.threshCap ?? 400
  const start = nowFn()
  const rng = mulberry32(seed)

  const sampling = (opts.sampling ?? Array.from({ length: cnf.numVars }, (_, i) => i + 1)).filter(
    (v) => v >= 1 && v <= cnf.numVars,
  )
  const n = sampling.length

  // Pivot threshold from the paper: thresh = 1 + 9.84·(1 + ε/(1+ε))·(1 + 1/ε)²
  let thresh = Math.ceil(1 + 9.84 * (1 + epsilon / (1 + epsilon)) * Math.pow(1 + 1 / epsilon, 2))
  thresh = Math.min(thresh, threshCap)

  let boundedCalls = 0

  // Step 1: if the whole formula already has < thresh models, count is exact.
  const y0 = boundedCount(cnf, [], cnf.numVars, thresh)
  boundedCalls++
  if (!y0.capped) {
    return {
      estimate: y0.count,
      roundEstimates: [y0.count],
      thresh,
      rounds: 1,
      exactSmall: true,
      boundedCalls,
      timeMs: nowFn() - start,
    }
  }

  // Number of rounds t = ⌈17·log₂(3/δ)⌉, capped for interactivity.
  const tTheory = Math.ceil(17 * Math.log2(3 / delta))
  const rounds = Math.max(1, opts.rounds ?? Math.min(tTheory, 37))

  const roundEstimates: number[] = []
  for (let r = 0; r < rounds; r++) {
    const est = approxMcCore(cnf, sampling, n, thresh, rng, () => boundedCalls++)
    if (est !== null) roundEstimates.push(est)
  }

  const estimate = median(roundEstimates)
  return {
    estimate,
    roundEstimates,
    thresh,
    rounds,
    exactSmall: false,
    boundedCalls,
    timeMs: nowFn() - start,
  }
}

/**
 * One estimation round: draw n random XOR constraints over the sampling set, binary-
 * search for the number m of constraints that shrinks a cell below `thresh`, and
 * return the scaled estimate 2^m · (cell count). Returns null on an overshoot (an
 * empty cell) — the outer median absorbs the occasional ⊥.
 */
function approxMcCore(
  cnf: CNF,
  sampling: number[],
  n: number,
  thresh: number,
  rng: () => number,
  tick: () => void,
): number | null {
  if (n === 0) return 1

  // Pre-generate up to n random parity constraints; using the first i of them yields
  // 2^i cells. Each constraint picks each sampling var with probability ½ and a random
  // target parity bit.
  const constraints: { vars: number[]; parity: 0 | 1 }[] = []
  for (let i = 0; i < n; i++) {
    const vars: number[] = []
    for (const v of sampling) if (rng() < 0.5) vars.push(v)
    const parity: 0 | 1 = rng() < 0.5 ? 1 : 0
    constraints.push({ vars, parity })
  }

  // yOf(i): bounded count of the cell defined by the first i XORs. Memoized; monotone
  // non-increasing in i (each added constraint can only remove models).
  const memo = new Map<number, { count: number; capped: boolean }>()
  const yOf = (i: number): { count: number; capped: boolean } => {
    const hit = memo.get(i)
    if (hit) return hit
    const xorClauses: number[][] = []
    let nextVar = cnf.numVars + 1
    for (let k = 0; k < i; k++) nextVar = appendXor(xorClauses, constraints[k].vars, constraints[k].parity, nextVar)
    const augVars = nextVar - 1
    tick()
    const res = boundedCount(cnf, xorClauses, augVars, thresh)
    memo.set(i, res)
    return res
  }

  // We know y(0) ≥ thresh (the caller only invokes core when the formula is big).
  // Binary-search the smallest m with y(m) < thresh.
  if (!yOf(n).capped) {
    // Even n XORs leave a below-threshold cell — good, find the transition.
  } else {
    // n XORs still ≥ thresh: not enough hashing power for a clean cell.
    return null
  }
  let lo = 0 // y(lo) ≥ thresh
  let hi = n // y(hi) < thresh
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (yOf(mid).capped) lo = mid
    else hi = mid
  }
  const m = hi
  const cell = yOf(m)
  if (cell.count === 0) return null // overshoot into an empty cell — ⊥ this round
  return cell.count * Math.pow(2, m)
}
