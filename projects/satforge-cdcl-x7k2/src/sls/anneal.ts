// Simulated annealing for SAT — the most literal reading of "SAT as a physics
// problem". The energy of an assignment is its number of unsatisfied clauses;
// we sample flips by the Metropolis rule (always accept a flip that lowers the
// energy, accept an uphill flip of cost ΔE with probability e^{−ΔE/T}) while a
// geometric schedule cools the temperature T from `tStart` toward `tEnd`. At
// high T the walk is ergodic (it tunnels through barriers); as T → 0 it freezes
// into a local — ideally global, i.e. zero-energy — minimum.
//
// We use *focused* annealing: candidate flips are drawn from variables of
// currently-unsatisfied clauses, which is dramatically more effective than
// flipping a uniformly random variable (most of which sit in already-satisfied
// clauses and only do harm).

import type { CNF } from '../sat/cnf'
import { WorkingFormula, SearchState, mulberry32 } from './working'

export interface AnnealOptions {
  /** Initial temperature (default 0.3). */
  tStart?: number
  /** Final temperature (default 0.05). */
  tEnd?: number
  /** Metropolis steps per cooling cycle (default 300·n). */
  steps?: number
  /** Max reheating cycles before giving up (default 40); each cools tStart→tEnd afresh. */
  cycles?: number
  /** Wall-clock budget in ms; 0 = unlimited (default 5000). */
  maxTimeMs?: number
  /** RNG seed (default 1). */
  seed?: number
  /** Trajectory samples kept for plotting (default 1500). */
  maxSamples?: number
}

export interface AnnealResult {
  status: 'sat' | 'unknown'
  model?: boolean[]
  steps: number
  bestEnergy: number
  /** Sampled unsatisfied-clause count over the run. */
  trajectory: number[]
  /** The temperature at each trajectory sample (same length as `trajectory`). */
  temperature: number[]
  sampleEvery: number
  /** Fraction of proposed uphill moves that were accepted (a "did it tunnel?" gauge). */
  acceptUphill: number
  timeMs: number
  numVars: number
  numClauses: number
}

/** Anneal `cnf`. Returns `'sat'` with a model, or `'unknown'` on budget exhaustion. */
export function anneal(cnf: CNF, opts: AnnealOptions = {}): AnnealResult {
  const f = new WorkingFormula(cnf)
  const n = f.numVars
  const tStart = opts.tStart ?? 0.7
  const tEnd = opts.tEnd ?? 0.1
  const cycleSteps = opts.steps ?? Math.max(3000, 300 * n)
  const maxCycles = opts.cycles ?? 40
  const maxTimeMs = opts.maxTimeMs ?? 5000
  const rand = mulberry32(opts.seed ?? 1)
  const maxSamples = opts.maxSamples ?? 1500
  const start = performance.now()

  const state = new SearchState(f)
  state.randomize(rand)

  if (f.clauses.length === 0) {
    return {
      status: 'sat',
      model: state.model(),
      steps: 0,
      bestEnergy: 0,
      trajectory: [0],
      temperature: [tStart],
      sampleEvery: 1,
      acceptUphill: 0,
      timeMs: performance.now() - start,
      numVars: n,
      numClauses: 0,
    }
  }

  // Geometric cooling within one cycle: T_k = tStart · ratio^k reaching tEnd.
  const ratio = Math.pow(tEnd / tStart, 1 / Math.max(1, cycleSteps - 1))

  const trajectory: number[] = []
  const temperature: number[] = []
  // Sample across the whole budget (all cycles), capped at maxSamples.
  const sampleEvery = Math.max(1, Math.floor((cycleSteps * maxCycles) / maxSamples))

  let best = Infinity
  let bestModel = state.model()
  let uphillProposed = 0
  let uphillAccepted = 0
  let totalDone = 0

  // Reheating with diversification: each cycle cools tStart→tEnd from a fresh
  // random assignment (multi-start SA), which reliably escapes the single-clause
  // local minima that trap a from-best restart. The global best is always kept.
  for (let cycle = 0; cycle < maxCycles; cycle++) {
    if (cycle > 0) state.randomize(rand)
    let T = tStart
    for (let step = 0; step < cycleSteps; step++) {
      if (state.energy < best) {
        best = state.energy
        bestModel = state.model()
      }
      if (totalDone % sampleEvery === 0 && trajectory.length < maxSamples) {
        trajectory.push(state.energy)
        temperature.push(T)
      }
      if (state.energy === 0) {
        trajectory.push(0)
        temperature.push(T)
        return finish('sat', state.model(), totalDone)
      }

      // Focused proposal: a random variable from a random unsatisfied clause.
      const clause = f.clauses[state.unsat[(rand() * state.unsat.length) | 0]]
      const v = Math.abs(clause[(rand() * clause.length) | 0])
      const dE = state.delta(v) // break − make: change in unsatisfied count
      if (dE > 0) uphillProposed++
      if (dE <= 0 || rand() < Math.exp(-dE / T)) {
        state.flip(v)
        if (dE > 0) uphillAccepted++
      }

      T *= ratio
      totalDone++
      if ((totalDone & 1023) === 0 && performance.now() - start > maxTimeMs) {
        return finish('unknown', bestModel, totalDone)
      }
    }
  }

  return finish('unknown', bestModel, totalDone)

  function finish(status: 'sat' | 'unknown', model: boolean[], steps: number): AnnealResult {
    return {
      status,
      model: status === 'sat' ? model : undefined,
      steps,
      bestEnergy: status === 'sat' ? 0 : best,
      trajectory,
      temperature,
      sampleEvery,
      acceptUphill: uphillProposed > 0 ? uphillAccepted / uphillProposed : 0,
      timeMs: performance.now() - start,
      numVars: n,
      numClauses: f.clauses.length,
    }
  }
}
