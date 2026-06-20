// Stochastic Local Search (SLS) for SAT — the incomplete, "physics-flavoured"
// counterpart to the complete CDCL engine. None of these algorithms can prove
// UNSAT; what they can do is find a satisfying assignment astonishingly fast on
// instances where systematic search drowns, by hill-climbing the number of
// unsatisfied clauses and escaping local minima with calibrated randomness.
//
// All four share one incremental substrate (`SearchState`) and differ only in
// how they pick the variable to flip:
//
//   • GSAT (+ random walk)  — greedily flip the globally best variable.
//   • WalkSAT / SKC         — focus on one unsatisfied clause; flip its
//                             least-damaging ("min-break") variable, taking a
//                             "freebie" (break = 0) when one exists.
//   • ProbSAT               — focus on a clause; flip a variable with
//                             probability ∝ a smooth function of its break-count
//                             (Balint & Schöning, 2012). No greedy "best".
//   • Novelty+              — focus on a clause; flip the best-by-score variable
//                             unless it is the most-recently-flipped, in which
//                             case take the second-best — with a random-walk
//                             escape hatch (Hoos, 1999).
//
// The model returned (when status = 'sat') is independently re-checked by the
// caller with the same `verifyModel` the complete solver uses.

import type { CNF } from '../sat/cnf'
import { WorkingFormula, SearchState, mulberry32 } from './working'

export type SlsAlgorithm = 'gsat' | 'walksat' | 'probsat' | 'novelty'

export interface SlsOptions {
  algorithm?: SlsAlgorithm
  /** Restart with a fresh random assignment after this many flips (default 50·n). */
  maxFlips?: number
  /** Number of random restarts before giving up (default 20). */
  maxTries?: number
  /** Wall-clock budget in ms; 0 = unlimited (default 5000). */
  maxTimeMs?: number
  /** Noise / random-walk probability in [0,1] (WalkSAT, GSAT-walk, Novelty). Default 0.4 (WalkSAT) / 0.5 (Novelty). */
  noise?: number
  /** ProbSAT break-weight base `cb` (default 2.3 — good for 3-SAT). */
  cb?: number
  /** RNG seed (default 1). */
  seed?: number
  /** Keep at most this many trajectory samples for plotting (default 1500). */
  maxSamples?: number
  /** Start from this assignment (1-based) instead of a random one on the first try. */
  warmStart?: boolean[]
}

export interface SlsResult {
  algorithm: SlsAlgorithm
  status: 'sat' | 'unknown'
  /** 1-based; only present when status === 'sat'. */
  model?: boolean[]
  flips: number
  tries: number
  /** Restarts that were *used* (= tries − 1 when it succeeded mid-run). */
  restarts: number
  /** Fewest unsatisfied clauses ever reached (0 ⇔ solved). */
  bestEnergy: number
  /** Sampled unsatisfied-clause count over the run, for the trajectory chart. */
  trajectory: number[]
  /** Flips between successive trajectory samples. */
  sampleEvery: number
  timeMs: number
  numVars: number
  numClauses: number
}

/**
 * Run a stochastic local search over `cnf`. Returns `'sat'` with a verified-able
 * model, or `'unknown'` if the flip/try/time budget is exhausted (which says
 * nothing about satisfiability — SLS never reports UNSAT).
 */
export function localSearch(cnf: CNF, opts: SlsOptions = {}): SlsResult {
  const algorithm = opts.algorithm ?? 'walksat'
  const f = new WorkingFormula(cnf)
  const n = f.numVars
  const maxFlips = opts.maxFlips ?? Math.max(1000, 50 * n)
  const maxTries = opts.maxTries ?? 20
  const maxTimeMs = opts.maxTimeMs ?? 5000
  const noise = opts.noise ?? (algorithm === 'novelty' ? 0.5 : 0.4)
  const cb = opts.cb ?? 2.3
  const rand = mulberry32(opts.seed ?? 1)
  const maxSamples = opts.maxSamples ?? 1500
  const start = performance.now()

  const state = new SearchState(f)
  // ProbSAT precomputes break-weights cb^{-b}; b never exceeds the max clause width.
  let maxWidth = 0
  for (const c of f.clauses) if (c.length > maxWidth) maxWidth = c.length
  const breakWeight: number[] = []
  for (let b = 0; b <= Math.max(maxWidth, n); b++) breakWeight.push(Math.pow(cb, -b))

  // A trivially-true formula (no clauses) is satisfied by anything.
  if (f.clauses.length === 0) {
    state.randomize(rand)
    return done('sat', state, 0, 1, 0, [0], 1)
  }

  // `lastFlip[v]` — the flip index at which v was last flipped (for Novelty's age test).
  const lastFlip = new Int32Array(n + 1).fill(-1)
  const trajectory: number[] = []
  // Aim for ~maxSamples points across the whole budget.
  const sampleEvery = Math.max(1, Math.floor((maxFlips * maxTries) / maxSamples))
  let totalFlips = 0
  let bestEnergy = Infinity

  for (let attempt = 0; attempt < maxTries; attempt++) {
    if (attempt === 0 && opts.warmStart) state.setAssignment(opts.warmStart)
    else state.randomize(rand)
    lastFlip.fill(-1)

    for (let step = 0; step < maxFlips; step++) {
      if (state.energy < bestEnergy) bestEnergy = state.energy
      if (totalFlips % sampleEvery === 0 && trajectory.length < maxSamples) trajectory.push(state.energy)

      if (state.energy === 0) {
        trajectory.push(0)
        return done('sat', state, totalFlips, attempt + 1, attempt, trajectory, sampleEvery)
      }

      const v = pick(algorithm, state, rand, noise, breakWeight, lastFlip, n)
      if (v > 0) {
        state.flip(v)
        lastFlip[v] = totalFlips
      }
      totalFlips++

      // Check the wall-clock budget occasionally (cheap modulo, not every flip).
      if ((totalFlips & 1023) === 0 && performance.now() - start > maxTimeMs) {
        if (state.energy < bestEnergy) bestEnergy = state.energy
        return done('unknown', state, totalFlips, attempt + 1, attempt, trajectory, sampleEvery, bestEnergy)
      }
    }
  }

  return done('unknown', state, totalFlips, maxTries, maxTries - 1, trajectory, sampleEvery, bestEnergy)

  function done(
    status: 'sat' | 'unknown',
    s: SearchState,
    flips: number,
    tries: number,
    restarts: number,
    traj: number[],
    every: number,
    best = 0,
  ): SlsResult {
    return {
      algorithm,
      status,
      model: status === 'sat' ? s.model() : undefined,
      flips,
      tries,
      restarts,
      bestEnergy: status === 'sat' ? 0 : best,
      trajectory: traj,
      sampleEvery: every,
      timeMs: performance.now() - start,
      numVars: n,
      numClauses: f.clauses.length,
    }
  }
}

/** Choose the variable to flip this step; returns 0 to flip nothing (shouldn't happen). */
function pick(
  algorithm: SlsAlgorithm,
  state: SearchState,
  rand: () => number,
  noise: number,
  breakWeight: number[],
  lastFlip: Int32Array,
  n: number,
): number {
  if (algorithm === 'gsat') return pickGsat(state, rand, noise, n)
  const clause = state.f.clauses[state.unsat[(rand() * state.unsat.length) | 0]]
  if (algorithm === 'walksat') return pickWalksat(state, clause, rand, noise)
  if (algorithm === 'probsat') return pickProbsat(state, clause, rand, breakWeight)
  return pickNovelty(state, clause, rand, noise, lastFlip)
}

// GSAT: with probability `noise`, take a random walk (flip a random variable of a
// random unsatisfied clause); otherwise flip the variable whose flip most reduces
// the unsatisfied-clause count, breaking ties at random.
function pickGsat(state: SearchState, rand: () => number, noise: number, n: number): number {
  if (rand() < noise) {
    const clause = state.f.clauses[state.unsat[(rand() * state.unsat.length) | 0]]
    return Math.abs(clause[(rand() * clause.length) | 0])
  }
  let best = -Infinity
  let chosen = 0
  let ties = 0
  for (let v = 1; v <= n; v++) {
    const score = state.makeCount(v) - state.breakCount(v) // higher = better
    if (score > best) {
      best = score
      chosen = v
      ties = 1
    } else if (score === best) {
      // Reservoir tie-break so every equally-good variable is equiprobable.
      ties++
      if (rand() < 1 / ties) chosen = v
    }
  }
  return chosen
}

// WalkSAT / SKC: inside the chosen unsatisfied clause, if some variable breaks no
// clause (a "freebie") flip it; otherwise flip a random variable with prob `noise`,
// else the minimum-break variable (ties broken at random).
function pickWalksat(state: SearchState, clause: number[], rand: () => number, noise: number): number {
  let minBreak = Infinity
  let chosen = 0
  let ties = 0
  for (const lit of clause) {
    const v = Math.abs(lit)
    const b = state.breakCount(v)
    if (b === 0) return v // freebie — strictly improves, take it immediately
    if (b < minBreak) {
      minBreak = b
      chosen = v
      ties = 1
    } else if (b === minBreak) {
      ties++
      if (rand() < 1 / ties) chosen = v
    }
  }
  if (rand() < noise) return Math.abs(clause[(rand() * clause.length) | 0])
  return chosen
}

// ProbSAT: flip variable v of the chosen clause with probability ∝ cb^{-break(v)}.
// No greedy step at all — pure break-driven sampling (Balint & Schöning 2012).
function pickProbsat(state: SearchState, clause: number[], rand: () => number, breakWeight: number[]): number {
  let total = 0
  // Reuse small scratch via the clause length.
  const weights: number[] = []
  for (const lit of clause) {
    const v = Math.abs(lit)
    const b = state.breakCount(v)
    const w = b < breakWeight.length ? breakWeight[b] : Math.pow(2.3, -b)
    weights.push(w)
    total += w
  }
  let r = rand() * total
  for (let i = 0; i < clause.length; i++) {
    r -= weights[i]
    if (r <= 0) return Math.abs(clause[i])
  }
  return Math.abs(clause[clause.length - 1])
}

// Novelty+: with probability `wp` (here noise/2) take a pure random walk; otherwise
// pick the best-scoring variable in the clause unless it is the most recently
// flipped, in which case take the second-best (escaping flip-cycles).
function pickNovelty(
  state: SearchState,
  clause: number[],
  rand: () => number,
  noise: number,
  lastFlip: Int32Array,
): number {
  const wp = noise * 0.4
  if (rand() < wp) return Math.abs(clause[(rand() * clause.length) | 0])

  let best = -Infinity
  let second = -Infinity
  let bestV = 0
  let secondV = 0
  for (const lit of clause) {
    const v = Math.abs(lit)
    const score = state.makeCount(v) - state.breakCount(v)
    if (score > best) {
      second = best
      secondV = bestV
      best = score
      bestV = v
    } else if (score > second) {
      second = score
      secondV = v
    }
  }
  if (secondV === 0) return bestV
  // If the best is also the youngest (just flipped), prefer the runner-up with prob `noise`.
  const bestIsYoungest = lastFlip[bestV] >= lastFlip[secondV]
  if (bestIsYoungest && rand() < noise) return secondV
  return bestV
}
