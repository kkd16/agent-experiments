// Weighted (partial) MaxSAT — the optimization layer on top of SAT.
//
// A MaxSAT instance has *hard* clauses (must hold) and weighted *soft* clauses (each may be
// violated at a cost equal to its weight). The goal is an assignment satisfying every hard
// clause while minimizing the total weight of violated soft clauses. This is the engine
// behind planning, scheduling, and combinatorial optimization.
//
// Two independent, complete algorithms are implemented on top of the same CDCL core. They
// approach the optimum from opposite directions and (in the test harness) must agree with
// each other and with brute force:
//
//   • Linear SAT-UNSAT (model-guided): relax every soft clause with a fresh variable, encode
//     the total cost with a Generalized Totalizer, then repeatedly demand a *strictly better*
//     model until the solver proves none exists — the upper bound ratchets down to the
//     optimum. One incremental solver; the budget is just a growing set of assumptions.
//
//   • Core-guided (WPM1 / weighted Fu-Malik): assume every soft clause holds; each unsat core
//     is a set of soft clauses that cannot all hold, so we relax them with fresh blockers + an
//     at-most-one and raise the lower bound by the core's minimum weight, splitting heavier
//     clauses. The lower bound climbs to the optimum from below.

import { CdclSolver } from './solver'
import { encodeGTE, atMostBound, PBBuilder } from './cardinality'
import type { CNF } from './cnf'

export interface SoftClause {
  /** Disjunction of signed DIMACS literals over the original variables. */
  lits: number[]
  /** Positive integer cost incurred when this clause is violated. */
  weight: number
}

export interface MaxSatInstance {
  numVars: number
  hard: number[][]
  soft: SoftClause[]
}

export interface MaxSatProgress {
  iteration: number
  /** Best proven lower bound on the optimum so far. */
  lb: number
  /** Best feasible cost found so far (an upper bound), or null if none yet. */
  ub: number | null
  timeMs: number
}

export interface MaxSatResult {
  status: 'optimal' | 'unsat-hard' | 'unknown'
  /** Minimum total weight of violated soft clauses (the optimum when status==='optimal'). */
  cost: number
  /** 1-based assignment over the original variables. */
  model?: boolean[]
  iterations: number
  strategy: 'linear' | 'core-guided'
  progress: MaxSatProgress[]
  timeMs: number
}

export interface MaxSatOptions {
  strategy?: 'linear' | 'core-guided'
  maxConflicts?: number
  maxTimeMs?: number
  maxIterations?: number
}

/** Does `model` (1-based booleans) satisfy a clause? */
export function clauseSat(lits: number[], model: boolean[]): boolean {
  for (const l of lits) {
    const v = Math.abs(l)
    if (l > 0 ? model[v] : !model[v]) return true
  }
  return false
}

/** Total weight of the soft clauses violated by `model`. */
export function softCost(soft: SoftClause[], model: boolean[]): number {
  let c = 0
  for (const s of soft) if (!clauseSat(s.lits, model)) c += s.weight
  return c
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export function solveMaxSat(inst: MaxSatInstance, opts: MaxSatOptions = {}): MaxSatResult {
  return (opts.strategy ?? 'linear') === 'core-guided'
    ? maxsatCoreGuided(inst, opts)
    : maxsatLinear(inst, opts)
}

// ---- Linear SAT-UNSAT (model-improving) -------------------------------------------------
function maxsatLinear(inst: MaxSatInstance, opts: MaxSatOptions): MaxSatResult {
  const start = now()
  const progress: MaxSatProgress[] = []
  const builder = new PBBuilder(inst.numVars)
  const clauses: number[][] = inst.hard.map((c) => c.slice())

  // Relax every soft clause: (Cᵢ ∨ rᵢ). rᵢ true ⇒ clause Cᵢ may be violated; we minimize Σ wᵢ·rᵢ.
  const relax: { lit: number; weight: number }[] = []
  for (const s of inst.soft) {
    const r = builder.fresh()
    clauses.push([...s.lits, r])
    relax.push({ lit: r, weight: s.weight })
  }
  const gte = encodeGTE(builder, relax)
  for (const c of builder.clauses) clauses.push(c)

  const cnf: CNF = { numVars: builder.numVars, clauses }
  const solver = new CdclSolver(cnf, {
    maxConflicts: opts.maxConflicts ?? 0,
    maxTimeMs: opts.maxTimeMs ?? 0,
  })

  // Feasibility of the hard clauses (no cost bound).
  let res = solver.solveAssuming([])
  let iterations = 1
  if (res.status === 'unsat') return finishUnsatHard(start, progress)
  if (res.status === 'unknown' || !res.model) return unknown('linear', start, progress, iterations)

  let bestModel = res.model
  let ub = softCost(inst.soft, res.model)
  let lb = 0
  progress.push({ iteration: iterations, lb, ub, timeMs: now() - start })

  const maxIter = opts.maxIterations ?? 100000
  while (ub > lb && iterations < maxIter) {
    if (opts.maxTimeMs && now() - start >= opts.maxTimeMs)
      return { status: 'unknown', cost: ub, model: trim(bestModel, inst.numVars), iterations, strategy: 'linear', progress, timeMs: now() - start }
    // Demand a strictly cheaper assignment: cost ≤ ub-1.
    res = solver.solveAssuming(atMostBound(gte, ub - 1))
    iterations++
    if (res.status === 'unknown') return { status: 'unknown', cost: ub, model: trim(bestModel, inst.numVars), iterations, strategy: 'linear', progress, timeMs: now() - start }
    if (res.status === 'unsat') {
      lb = ub // no cheaper model exists — current ub is optimal
      progress.push({ iteration: iterations, lb, ub, timeMs: now() - start })
      break
    }
    bestModel = res.model!
    ub = softCost(inst.soft, res.model!)
    progress.push({ iteration: iterations, lb, ub, timeMs: now() - start })
  }

  return { status: 'optimal', cost: ub, model: trim(bestModel, inst.numVars), iterations, strategy: 'linear', progress, timeMs: now() - start }
}

// ---- Core-guided WPM1 (weighted Fu-Malik) -----------------------------------------------
interface ActiveSoft {
  baseLits: number[] // original clause literals (fixed)
  relaxors: number[] // blocker vars accumulated from previous core relaxations
  weight: number
}

function maxsatCoreGuided(inst: MaxSatInstance, opts: MaxSatOptions): MaxSatResult {
  const start = now()
  const progress: MaxSatProgress[] = []
  let numVars = inst.numVars
  const fresh = () => ++numVars

  // Permanent clauses: hard ∪ all at-most-one constraints accumulated across rounds.
  const permanent: number[][] = inst.hard.map((c) => c.slice())
  let active: ActiveSoft[] = inst.soft
    .filter((s) => s.weight > 0)
    .map((s) => ({ baseLits: s.lits.slice(), relaxors: [], weight: s.weight }))

  let cost = 0
  let iterations = 0
  const maxIter = opts.maxIterations ?? 100000

  for (;;) {
    if (iterations >= maxIter) return unknown('core-guided', start, progress, iterations)
    if (opts.maxTimeMs && now() - start >= opts.maxTimeMs) return unknown('core-guided', start, progress, iterations)
    iterations++

    // Mint a fresh selector per active soft and build the round's CNF + assumptions.
    const selectors: number[] = active.map(() => fresh())
    const clauses: number[][] = permanent.map((c) => c.slice())
    for (let i = 0; i < active.length; i++) {
      clauses.push([...active[i].baseLits, ...active[i].relaxors, selectors[i]])
    }
    const cnf: CNF = { numVars, clauses }
    const solver = new CdclSolver(cnf, { maxConflicts: opts.maxConflicts ?? 0, maxTimeMs: opts.maxTimeMs ?? 0 })
    const assumptions = selectors.map((s) => -s) // ¬selector ⇒ this soft clause must hold
    const res = solver.solveAssuming(assumptions)

    if (res.status === 'unknown') return unknown('core-guided', start, progress, iterations)
    if (res.status === 'sat') {
      const model = trim(res.model!, inst.numVars)
      progress.push({ iteration: iterations, lb: cost, ub: cost, timeMs: now() - start })
      return { status: 'optimal', cost, model, iterations, strategy: 'core-guided', progress, timeMs: now() - start }
    }
    // UNSAT: a core of soft clauses that cannot all hold.
    const core = res.core ?? []
    if (core.length === 0) return finishUnsatHard(start, progress) // hard clauses alone are UNSAT

    // Map core selector literals (¬sᵢ) back to active-soft indices.
    const selToIdx = new Map<number, number>()
    selectors.forEach((s, i) => selToIdx.set(s, i))
    const coreIdx: number[] = []
    for (const lit of core) {
      const idx = selToIdx.get(Math.abs(lit))
      if (idx !== undefined) coreIdx.push(idx)
    }
    if (coreIdx.length === 0) return finishUnsatHard(start, progress)

    const wMin = Math.min(...coreIdx.map((i) => active[i].weight))
    cost += wMin
    progress.push({ iteration: iterations, lb: cost, ub: null, timeMs: now() - start })

    // Relax the core: fresh blocker per clause + at-most-one over them, splitting heavier clauses.
    const blockers: number[] = []
    const newRemainders: ActiveSoft[] = []
    for (const i of coreIdx) {
      const s = active[i]
      if (s.weight > wMin) {
        // Keep an unrelaxed remainder with the leftover weight.
        newRemainders.push({ baseLits: s.baseLits.slice(), relaxors: s.relaxors.slice(), weight: s.weight - wMin })
      }
      const b = fresh()
      blockers.push(b)
      s.relaxors = [...s.relaxors, b]
      s.weight = wMin
    }
    // At-most-one over the fresh blockers (cores are small ⇒ pairwise is fine).
    for (let a = 0; a < blockers.length; a++)
      for (let b = a + 1; b < blockers.length; b++) permanent.push([-blockers[a], -blockers[b]])

    active = active.concat(newRemainders)
  }
}

function trim(model: boolean[], numVars: number): boolean[] {
  return model.slice(0, numVars + 1)
}

function finishUnsatHard(start: number, progress: MaxSatProgress[]): MaxSatResult {
  return { status: 'unsat-hard', cost: Infinity, iterations: progress.length, strategy: 'linear', progress, timeMs: now() - start }
}

function unknown(strategy: 'linear' | 'core-guided', start: number, progress: MaxSatProgress[], iterations: number): MaxSatResult {
  return { status: 'unknown', cost: Infinity, iterations, strategy, progress, timeMs: now() - start }
}
