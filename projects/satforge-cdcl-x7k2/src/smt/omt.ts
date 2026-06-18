// Optimization Modulo Theories (OMT) and MaxSMT — the optimization layer that
// sits *on top* of the DPLL(T) decision procedure, exactly as SatForge's MaxSAT
// sits on top of CDCL.
//
// SMT answers "is there a model?"; OMT answers "what is the *best* model?" — it
// minimizes or maximizes a linear-arithmetic objective subject to a first-order
// formula over any combination of the engine's theories (EUF, LIA/LRA, arrays,
// datatypes, strings, …). MaxSMT is the special case where the objective is the
// total weight of *soft* constraints you'd like to satisfy but may have to give
// up: minimize that weight ⇒ satisfy as much as possible.
//
// Both are built **black-box** on the existing `checkSat`, so the entire decision
// engine is reused unchanged:
//
//   • Integer-valued objectives (QF_LIA, and every MaxSMT instance — a sum of
//     integer weights is always integer) are solved by an *exact* bracket +
//     binary search on the objective bound. Each probe is one `checkSat` of
//     `φ ∧ (obj ≤ k)`; because the objective is integer the search is finite and
//     returns the true optimum (no tolerance, no floating point).
//
//   • Real-valued objectives (QF_LRA) are handled in `omt-lra.ts` by genuine
//     linear-programming optimization inside the simplex, which finds exact
//     rational vertex optima and detects open infima/suprema.

import { Rational } from './rational'
import { addLin, scaleLin, type Formula, type LinExpr, type Term, type TermManager } from './term'
import { checkSat, type FullSmtResult } from './smt'
import type { SmtOptions } from './dpllt'
import { optimizeReal } from './omt-lra'

export type OmtStatus = 'optimal' | 'unbounded' | 'infeasible' | 'unknown'

/** One step of the objective-bound search (for the UI trace). */
export interface OmtStep {
  bound: string
  sat: boolean
  value?: string
}

export interface OmtResult {
  status: OmtStatus
  /** Optimal objective value (exact rational), present when status === 'optimal'. */
  value?: Rational
  /** A model achieving the optimum. */
  model?: FullSmtResult
  /** Whether the optimum is attained (closed) or an open infimum/supremum (LRA). */
  attained?: boolean
  /** How the optimum was found: integer bracket+binary search, or LRA simplex LP. */
  method?: 'integer-search' | 'lra-simplex'
  /** Number of underlying decision-procedure calls (search effort). */
  calls: number
  /** Bound-tightening search trace. */
  trace: OmtStep[]
  message?: string
  id?: string
}

export interface MaxSmtSoft {
  formula: Formula
  weight: number
  id?: string
}

export interface MaxSmtResult {
  status: OmtStatus
  /** Minimum total weight of *violated* soft constraints (= the MaxSMT cost). */
  cost?: Rational
  soft: { id: string; weight: number; violated: boolean }[]
  model?: FullSmtResult
  calls: number
  trace: OmtStep[]
  message?: string
}

// ---- helpers ---------------------------------------------------------------

/** Evaluate a LinExpr at a numeric arithmetic model (missing vars are 0). */
export function evalLin(model: Map<number, Rational> | undefined, lin: LinExpr): Rational {
  let acc = lin.constant
  if (model) for (const [v, c] of lin.coeffs) acc = acc.add(c.mul(model.get(v) ?? Rational.ZERO))
  return acc
}

/** Is the objective integer-valued? (all coeffs/constant integral, all vars Int) */
function objectiveIsIntegral(tm: TermManager, lin: LinExpr): boolean {
  if (!lin.constant.isInteger()) return false
  for (const [v, c] of lin.coeffs) {
    if (!c.isInteger()) return false
    if (tm.arithVars.get(v)?.sort !== 'Int') return false
  }
  return true
}

/** Build the arithmetic atom `obj ⋈ k` (k a constant). */
function boundFormula(tm: TermManager, objLin: LinExpr, k: Rational, op: 'le' | 'lt' | 'ge' | 'gt'): Formula {
  // obj ≤ k  ⟺  obj − k ≤ 0 ; obj ≥ k ⟺ k − obj ≤ 0 ; strict similarly.
  if (op === 'le' || op === 'lt') {
    const lin = addLin(objLin, { coeffs: new Map(), constant: k.neg() })
    return tm.arithAtom(op === 'le' ? 'le' : 'lt', lin)
  }
  const lin = addLin({ coeffs: new Map(), constant: k }, scaleLin(objLin, Rational.of(-1n)))
  return tm.arithAtom(op === 'ge' ? 'le' : 'lt', lin)
}

interface Probe {
  sat: boolean
  unknown?: boolean
  value?: Rational
  full?: FullSmtResult
}

// ---- the public OMT entry point --------------------------------------------

/**
 * Optimize a single linear objective over a formula. `dir` is 'min' or 'max'.
 * Routes integer objectives to the exact bracket+binary search and real
 * objectives to the LRA simplex optimizer.
 */
export function optimize(
  tm: TermManager,
  root: Formula,
  objective: Term,
  dir: 'min' | 'max',
  opts: SmtOptions = {},
): OmtResult {
  let objLin: LinExpr
  try {
    objLin = tm.linearize(objective)
  } catch (e) {
    return { status: 'unknown', calls: 0, trace: [], message: `objective is not linear: ${(e as Error).message}` }
  }
  if (objectiveIsIntegral(tm, objLin)) {
    return optimizeIntegerObjective(tm, root, objLin, dir, opts)
  }
  return optimizeReal(tm, root, objLin, dir, opts)
}

/**
 * Exact optimization of an integer-valued objective by bracketing the optimum and
 * binary-searching the bound. Optional `loHint`/`hiHint` (inclusive integer
 * bounds known a priori, e.g. [0, Σweights] for MaxSMT) skip the exponential
 * bracket and make the search pure binary.
 */
export function optimizeIntegerObjective(
  tm: TermManager,
  root: Formula,
  objLin: LinExpr,
  dir: 'min' | 'max',
  opts: SmtOptions = {},
  loHint?: bigint,
  hiHint?: bigint,
): OmtResult {
  // Reduce maximization to minimization of the negated objective.
  const lin = dir === 'max' ? scaleLin(objLin, Rational.of(-1n)) : objLin
  const flip = dir === 'max'
  const trace: OmtStep[] = []
  let calls = 0
  const CAP = 1n << 80n

  // Solve φ ∧ (lin ≤ k); record the achieved (minimized) objective value.
  const probeLe = (k: bigint): Probe => {
    calls++
    const f = tm.and([root, boundFormula(tm, lin, Rational.of(k), 'le')])
    const r = checkSat(tm, f, opts)
    const human = `obj ${flip ? '≥' : '≤'} ${(flip ? -k : k).toString()}`
    if (r.status === 'unknown') {
      trace.push({ bound: human, sat: false })
      return { sat: false, unknown: true }
    }
    if (r.status === 'unsat') {
      trace.push({ bound: human, sat: false })
      return { sat: false }
    }
    const v = evalLin(r.arithModel, lin)
    trace.push({ bound: human, sat: true, value: (flip ? v.neg() : v).toString() })
    return { sat: true, value: v, full: r }
  }

  // Anchor feasibility (and an initial achievable value) when no hints given.
  let anchor: bigint
  let bestModel: FullSmtResult | undefined
  if (hiHint !== undefined) {
    anchor = hiHint
  } else {
    calls++
    const r0 = checkSat(tm, root, opts)
    if (r0.status === 'unsat') return { status: 'infeasible', calls, trace }
    if (r0.status === 'unknown') return { status: 'unknown', calls, trace, message: r0.message }
    const v0 = evalLin(r0.arithModel, lin)
    anchor = v0.floor()
    bestModel = r0
    trace.push({ bound: '(feasible)', sat: true, value: (flip ? v0.neg() : v0).toString() })
  }

  // Bracket a lower bound `lo` such that (lin ≤ lo−1) is UNSAT.
  let lo: bigint
  if (loHint !== undefined) {
    lo = loHint
  } else {
    let d = 1n
    for (;;) {
      const probe = anchor - d
      const r = probeLe(probe)
      if (r.unknown) return { status: 'unknown', calls, trace, message: 'theory undecided during search' }
      if (r.sat) {
        anchor = r.value!.floor()
        if (r.full) bestModel = r.full
        d *= 2n
        if (d > CAP) return { status: 'unbounded', calls, trace, attained: false }
      } else {
        lo = probe + 1n
        break
      }
    }
  }
  let hi = anchor

  // If hints were given we still need a feasible witness at hi for `bestModel`.
  if (hiHint !== undefined && bestModel === undefined) {
    const r = probeLe(hi)
    if (r.unknown) return { status: 'unknown', calls, trace }
    if (!r.sat) return { status: 'infeasible', calls, trace }
    hi = r.value!.floor()
    bestModel = r.full
  }

  // Binary-search the optimum in [lo, hi].
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2n
    const r = probeLe(mid)
    if (r.unknown) return { status: 'unknown', calls, trace }
    if (r.sat) {
      hi = mid
      if (r.full) bestModel = r.full
    } else {
      lo = mid + 1n
    }
  }

  // lo === hi is the optimal *minimized* value of `lin`.
  const optMin = Rational.of(lo)
  // Make sure bestModel actually realizes the optimum (obj ≤ optMin).
  const fin = probeLe(lo)
  const model = fin.sat ? fin.full : bestModel
  const value = flip ? optMin.neg() : optMin
  return { status: 'optimal', value, model, attained: true, method: 'integer-search', calls, trace }
}

// ---- MaxSMT ----------------------------------------------------------------

let penaltyCounter = 0

/**
 * Weighted MaxSMT: given hard constraints and a list of weighted soft
 * constraints, find an assignment that satisfies the hard part and minimizes the
 * total weight of violated soft constraints. Reduces to integer OMT: each soft
 * `fᵢ` gets a 0/1 penalty variable `pᵢ` with `fᵢ ∨ pᵢ ≥ 1`, and we minimize
 * `Σ wᵢ·pᵢ` (an integer objective, so the search is exact). Works over *every*
 * theory, because the hard part `fᵢ` may be any formula — only the penalty
 * bookkeeping is arithmetic.
 */
export function maxsmt(
  tm: TermManager,
  hard: Formula,
  soft: MaxSmtSoft[],
  opts: SmtOptions = {},
): MaxSmtResult {
  if (soft.length === 0) {
    const r = checkSat(tm, hard, opts)
    return {
      status: r.status === 'sat' ? 'optimal' : r.status === 'unsat' ? 'infeasible' : 'unknown',
      cost: r.status === 'sat' ? Rational.ZERO : undefined,
      soft: [],
      model: r.status === 'sat' ? r : undefined,
      calls: 1,
      trace: [],
    }
  }

  const zero = tm.num(Rational.of(0n), 'Int')
  const one = tm.num(Rational.of(1n), 'Int')
  const penalties: { tid: number; weight: number; id: string }[] = []
  const conjuncts: Formula[] = [hard]
  let objLin: LinExpr = { coeffs: new Map(), constant: Rational.ZERO }
  let totalWeight = 0n

  soft.forEach((s, i) => {
    const w = Math.max(1, Math.round(s.weight))
    const name = `__omt_pen_${penaltyCounter++}`
    tm.declareFun({ name, argSorts: [], retSort: 'Int' })
    const p = tm.app(name)
    // 0 ≤ p ≤ 1
    conjuncts.push(tm.rel('le', zero, p))
    conjuncts.push(tm.rel('le', p, one))
    // fᵢ ∨ (p ≥ 1):  if the soft constraint fails, the penalty must be paid.
    conjuncts.push(tm.or([s.formula, tm.rel('ge', p, one)]))
    // accumulate w·p into the objective.
    objLin = addLin(objLin, scaleLin(tm.linearize(p), Rational.of(BigInt(w))))
    totalWeight += BigInt(w)
    penalties.push({ tid: p.id, weight: w, id: s.id ?? `soft#${i + 1}` })
  })

  const root = tm.and(conjuncts)
  const omt = optimizeIntegerObjective(tm, root, objLin, 'min', opts, 0n, totalWeight)

  if (omt.status !== 'optimal') {
    return { status: omt.status, soft: [], model: omt.model, calls: omt.calls, trace: omt.trace, message: omt.message }
  }
  const model = omt.model
  const am = model?.arithModel
  const softReport = penalties.map((p) => ({
    id: p.id,
    weight: p.weight,
    violated: (am?.get(p.tid) ?? Rational.ZERO).sign() > 0,
  }))
  return { status: 'optimal', cost: omt.value, soft: softReport, model, calls: omt.calls, trace: omt.trace }
}
