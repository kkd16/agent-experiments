// A head-to-head "race": run every incomplete solver (and, as the ground-truth
// referee, the complete CDCL engine) on one instance under a shared budget, then
// report who found a model, how fast, and — crucially — cross-check every model
// against the original CNF. This is the studio's correctness backbone: the
// complete solver decides SAT/UNSAT authoritatively, and any stochastic solver
// that claims SAT must produce an assignment that `verifyModel` accepts.

import type { CNF } from '../sat/cnf'
import { verifyModel } from '../sat/cnf'
import { solve } from '../sat/solver'
import { localSearch, type SlsAlgorithm } from './localsearch'
import { anneal } from './anneal'
import { surveyPropagate } from './surveyprop'

export interface RacerResult {
  name: string
  kind: 'complete' | 'sls' | 'anneal' | 'sp'
  status: 'sat' | 'unsat' | 'unknown'
  /** Work performed — flips (SLS), steps (anneal), conflicts (CDCL), rounds (SP). */
  work: number
  workUnit: string
  timeMs: number
  /** SAT only: did the produced model satisfy the original formula? */
  verified: boolean | null
  model?: boolean[]
  note?: string
}

export interface RaceResult {
  racers: RacerResult[]
  /** The authoritative verdict from the complete solver. */
  truth: 'sat' | 'unsat' | 'unknown'
  /** True iff no stochastic solver disagreed with the truth or returned a bad model. */
  consistent: boolean
  numVars: number
  numClauses: number
}

export interface RaceOptions {
  /** Per-solver wall-clock budget in ms (default 3000). */
  budgetMs?: number
  seed?: number
  /** Which SLS variants to race (default all four). */
  slsAlgorithms?: SlsAlgorithm[]
  includeAnneal?: boolean
  includeSp?: boolean
}

const SLS_LABEL: Record<SlsAlgorithm, string> = {
  gsat: 'GSAT',
  walksat: 'WalkSAT/SKC',
  probsat: 'ProbSAT',
  novelty: 'Novelty+',
}

/** Race all configured solvers on `cnf` and assemble a cross-checked report. */
export function race(cnf: CNF, opts: RaceOptions = {}): RaceResult {
  const budget = opts.budgetMs ?? 3000
  const seed = opts.seed ?? 1
  const algs = opts.slsAlgorithms ?? ['gsat', 'walksat', 'probsat', 'novelty']
  const racers: RacerResult[] = []

  // Ground truth first.
  const cdcl = solve(cnf, { maxConflicts: 5_000_000, maxTimeMs: budget, restartBase: 100, randomSeed: seed })
  const truth = cdcl.status
  racers.push({
    name: 'CDCL (complete)',
    kind: 'complete',
    status: cdcl.status,
    work: cdcl.stats.conflicts,
    workUnit: 'conflicts',
    timeMs: cdcl.stats.timeMs,
    verified: cdcl.status === 'sat' && cdcl.model ? verifyModel(cnf, cdcl.model).ok : null,
    model: cdcl.model,
  })

  for (const a of algs) {
    const r = localSearch(cnf, { algorithm: a, seed, maxTimeMs: budget, maxTries: 1_000_000 })
    racers.push({
      name: SLS_LABEL[a],
      kind: 'sls',
      status: r.status,
      work: r.flips,
      workUnit: 'flips',
      timeMs: r.timeMs,
      verified: r.status === 'sat' && r.model ? verifyModel(cnf, r.model).ok : null,
      model: r.model,
    })
  }

  if (opts.includeAnneal !== false) {
    const r = anneal(cnf, { seed, maxTimeMs: budget })
    racers.push({
      name: 'Simulated annealing',
      kind: 'anneal',
      status: r.status,
      work: r.steps,
      workUnit: 'steps',
      timeMs: r.timeMs,
      verified: r.status === 'sat' && r.model ? verifyModel(cnf, r.model).ok : null,
      model: r.model,
    })
  }

  if (opts.includeSp !== false) {
    const r = surveyPropagate(cnf, { seed, maxTimeMs: budget })
    racers.push({
      name: 'Survey propagation',
      kind: 'sp',
      status: r.status === 'sat' ? 'sat' : 'unknown',
      work: r.rounds,
      workUnit: 'rounds',
      timeMs: r.timeMs,
      verified: r.status === 'sat' && r.model ? verifyModel(cnf, r.model).ok : null,
      model: r.model,
      note: r.message,
    })
  }

  // Consistency: nobody may claim SAT with a bad model, and nobody may claim SAT
  // when the complete solver proved UNSAT.
  let consistent = true
  for (const r of racers) {
    if (r.status === 'sat' && r.verified === false) consistent = false
    if (r.status === 'sat' && truth === 'unsat') consistent = false
  }

  return { racers, truth, consistent, numVars: cnf.numVars, numClauses: cnf.clauses.length }
}
