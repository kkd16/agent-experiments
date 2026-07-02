// Model enumeration, projected enumeration, and backbones.
//
// A SAT solver answers "is there a solution?". These routines answer the follow-up
// questions a modeller actually cares about:
//
//   • allModels     — enumerate *every* satisfying assignment (AllSAT) by repeatedly
//     solving and adding a *blocking clause* that forbids the model just found.
//   • projectedModels — enumerate the distinct assignments to a chosen subset P of
//     variables that extend to *some* full model (projected / ∃-quantified AllSAT).
//     Blocking only the P-projection makes each observable behaviour appear once.
//   • backbone      — the literals true in *every* model. Computed the model-based
//     way (Marques-Silva, Janota, Lynce, Marques-Silva 2010): seed candidates from
//     one model, then for each candidate ask "can it be false?"; a returned model
//     prunes many candidates at once, an UNSAT answer certifies a backbone literal.
//   • minimalModel  — a subset-minimal model: a solution in which no true variable
//     can be turned off without losing satisfiability.
//
// The CDCL core has no public incremental clause API, so each step re-solves a CNF
// grown by one clause. That is linear-per-model and perfectly exact — ideal for the
// small, illustrative instances the studio explores.

import type { CNF } from '../sat/cnf'
import { solve } from '../sat/solver'
import type { SolverOptions } from '../sat/solver'

export interface EnumOptions {
  /** Stop after this many models (safety valve; AllSAT can be exponential). Default 2000. */
  maxModels?: number
  /** Passed through to the underlying solver. */
  solverOpts?: SolverOptions
}

export interface EnumResult {
  /** Each model is a 1-based boolean array (index v is variable v's value). */
  models: boolean[][]
  /** True when enumeration was exhaustive (hit the empty formula), false if capped. */
  complete: boolean
  solverCalls: number
  timeMs: number
}

const nowFn = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** Enumerate all satisfying assignments over every variable. */
export function allModels(cnf: CNF, opts: EnumOptions = {}): EnumResult {
  const allVars = Array.from({ length: cnf.numVars }, (_, i) => i + 1)
  return projectedModels(cnf, allVars, opts)
}

/**
 * Enumerate the distinct assignments to the projection variables `proj` that extend
 * to a full model. Duplicate projections are impossible: each found projection is
 * forbidden by a blocking clause over exactly those variables.
 */
export function projectedModels(cnf: CNF, proj: number[], opts: EnumOptions = {}): EnumResult {
  const maxModels = opts.maxModels ?? 2000
  const start = nowFn()
  const projSet = [...new Set(proj.filter((v) => v >= 1 && v <= cnf.numVars))]
  const clauses = cnf.clauses.map((c) => c.slice())
  const models: boolean[][] = []
  let calls = 0
  let complete = true

  for (;;) {
    if (models.length >= maxModels) {
      complete = false
      break
    }
    calls++
    const res = solve({ numVars: cnf.numVars, clauses }, opts.solverOpts)
    if (res.status === 'unknown') {
      complete = false
      break
    }
    if (res.status === 'unsat') break // no more models — exhaustive
    const model = res.model!
    models.push(model.slice())
    // Blocking clause: forbid this exact projection. A projection variable set true in
    // the model contributes ¬v; set false contributes v. Some proj var may be a
    // don't-care (defaulted false) — pinning it false here still forbids only this
    // specific projection, so the complementary projection surfaces on a later round.
    const block: number[] = []
    for (const v of projSet) block.push(model[v] ? -v : v)
    if (block.length === 0) break // no projection variables ⇒ at most one "behaviour"
    clauses.push(block)
  }

  return { models, complete, solverCalls: calls, timeMs: nowFn() - start }
}

export interface BackboneResult {
  status: 'sat' | 'unsat'
  /** Backbone literals (DIMACS signed): each is true in every model. Empty if UNSAT. */
  literals: number[]
  solverCalls: number
  timeMs: number
}

/** Compute the backbone: literals forced to a single value across all models. */
export function backbone(cnf: CNF, opts: { solverOpts?: SolverOptions } = {}): BackboneResult {
  const start = nowFn()
  let calls = 1
  const first = solve(cnf, opts.solverOpts)
  if (first.status === 'unsat') return { status: 'unsat', literals: [], solverCalls: calls, timeMs: nowFn() - start }
  if (first.status === 'unknown') return { status: 'sat', literals: [], solverCalls: calls, timeMs: nowFn() - start }

  // Seed one candidate literal per variable from the first model.
  const model0 = first.model!
  let candidates: number[] = []
  for (let v = 1; v <= cnf.numVars; v++) candidates.push(model0[v] ? v : -v)

  const fixed: number[] = [] // confirmed backbone literals (asserted as units)
  const base = cnf.clauses.map((c) => c.slice())

  while (candidates.length > 0) {
    const lit = candidates.pop()!
    // Ask: can `lit` be false? Assert ¬lit alongside everything already forced.
    const trial: number[][] = base.concat(fixed.map((l) => [l]))
    trial.push([-lit])
    calls++
    const res = solve({ numVars: cnf.numVars, clauses: trial }, opts.solverOpts)
    if (res.status === 'unsat') {
      // ¬lit is impossible ⇒ lit holds in every model: a backbone literal.
      fixed.push(lit)
    } else if (res.status === 'sat') {
      // A model with ¬lit exists ⇒ lit is not backbone; use the model to prune others.
      const m = res.model!
      candidates = candidates.filter((c) => (m[Math.abs(c)] ? Math.abs(c) : -Math.abs(c)) === c)
    } else {
      break // unknown — stop early, report what is proven so far
    }
  }
  fixed.sort((a, b) => Math.abs(a) - Math.abs(b))
  return { status: 'sat', literals: fixed, solverCalls: calls, timeMs: nowFn() - start }
}

export interface MinimalModelResult {
  status: 'sat' | 'unsat'
  /** A subset-minimal model (1-based booleans), or null if UNSAT. */
  model: boolean[] | null
  /** The variables true in that model. */
  trueVars: number[]
  solverCalls: number
}

/** Find a subset-minimal model: greedily switch true variables off while SAT holds. */
export function minimalModel(cnf: CNF, opts: { solverOpts?: SolverOptions } = {}): MinimalModelResult {
  let calls = 1
  const first = solve(cnf, opts.solverOpts)
  if (first.status !== 'sat') return { status: first.status === 'unsat' ? 'unsat' : 'sat', model: null, trueVars: [], solverCalls: calls }
  let model = first.model!
  const forcedFalse: number[] = [] // variables we have pinned to false so far
  for (let v = 1; v <= cnf.numVars; v++) {
    if (!model[v]) {
      forcedFalse.push(v)
      continue
    }
    // Try to turn v off (and keep every already-off var off).
    const trial: number[][] = cnf.clauses.map((c) => c.slice())
    for (const f of forcedFalse) trial.push([-f])
    trial.push([-v])
    calls++
    const res = solve({ numVars: cnf.numVars, clauses: trial }, opts.solverOpts)
    if (res.status === 'sat') {
      model = res.model!
      forcedFalse.push(v)
    }
    // else: v is required to be true in any model that keeps the rest off.
  }
  const trueVars: number[] = []
  for (let v = 1; v <= cnf.numVars; v++) if (model[v]) trueVars.push(v)
  return { status: 'sat', model, trueVars, solverCalls: calls }
}
