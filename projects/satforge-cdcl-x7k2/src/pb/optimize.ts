// Pseudo-Boolean optimization — minimize a linear objective subject to PB constraints.
//
// The strategy is **solution-improving (linear SAT-UNSAT) search**: find any feasible point,
// record its objective value `v`, add the bounding constraint `objective ≤ v − 1`, and solve
// again; each success strictly improves the incumbent. When the bounded problem finally goes
// UNSAT, the last incumbent is provably optimal (nothing better exists). Every intermediate
// solution is kept so the studio can show the optimization *converging*.
//
// It runs on the native cutting-plane solver, with the brute-force optimum as the oracle in
// the verification harness.

import { normalizeLinear, type SignedTerm } from './constraint'
import type { PbInstance } from './instance'
import { objectiveValue, cloneInstance } from './instance'
import { solvePb, type PbStats } from './solver'

export interface OptStep {
  value: bigint
  model: boolean[]
}

export interface OptimizeResult {
  status: 'optimal' | 'unsat' | 'unbounded' | 'unknown'
  optimum?: bigint
  model?: boolean[]
  /** The strictly-improving incumbents found along the way (ascending search order). */
  steps: OptStep[]
  iterations: number
  stats: PbStats // stats of the final (proving) solve
}

export interface OptimizeOptions {
  maxConflicts?: number
  maxTimeMs?: number
  maxIterations?: number
}

/**
 * Add `objective ≤ bound` to a copy of the instance (objective constant folded into `bound`).
 */
function withObjectiveBound(inst: PbInstance, bound: bigint): PbInstance {
  const copy = cloneInstance(inst)
  const terms: SignedTerm[] = (inst.objective ?? []).map((t) => ({ lit: t.lit, coef: t.coef }))
  // objConst + Σ coef·ℓ ≤ bound  ⇔  Σ coef·ℓ ≤ bound − objConst
  const rhs = bound - (inst.objConst ?? 0n)
  copy.constraints = [...copy.constraints, ...normalizeLinear(terms, '<=', rhs)]
  return copy
}

/** Minimize the instance's objective. Requires `inst.objective` to be present. */
export function optimize(inst: PbInstance, opts: OptimizeOptions = {}): OptimizeResult {
  const maxIterations = opts.maxIterations ?? 100000
  const solveOpts = { maxConflicts: opts.maxConflicts, maxTimeMs: opts.maxTimeMs }
  const steps: OptStep[] = []

  // initial feasibility
  let res = solvePb(inst, solveOpts)
  if (res.status === 'unknown') return { status: 'unknown', steps, iterations: 0, stats: res.stats }
  if (res.status === 'unsat') return { status: 'unsat', steps, iterations: 1, stats: res.stats }

  let incumbent = res.model!
  let best = objectiveValue(inst, incumbent)
  steps.push({ value: best, model: incumbent })

  let iterations = 1
  for (; iterations < maxIterations; iterations++) {
    const bounded = withObjectiveBound(inst, best - 1n)
    res = solvePb(bounded, solveOpts)
    if (res.status === 'unknown') return { status: 'unknown', optimum: best, model: incumbent, steps, iterations, stats: res.stats }
    if (res.status === 'unsat') {
      // nothing better than `best` exists ⇒ optimal
      return { status: 'optimal', optimum: best, model: incumbent, steps, iterations, stats: res.stats }
    }
    incumbent = res.model!
    best = objectiveValue(inst, incumbent)
    steps.push({ value: best, model: incumbent })
  }
  return { status: 'unknown', optimum: best, model: incumbent, steps, iterations, stats: res.stats }
}
