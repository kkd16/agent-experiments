// Integer linear optimization on top of the Omega test.
//
// Given a QF_LIA feasible region `{ x ∈ ℤⁿ : A x ▷ b }` and a linear objective
// `f(x) = Σ cᵢ xᵢ + c₀`, find the integer optimum (min or max). The decision
// procedure (omega.ts) only answers feasibility, so we lift it to optimization
// the same way the MaxSAT engine does — a **linear SAT–UNSAT descent**:
//
//   1. Decide feasibility. UNSAT ⇒ the problem is infeasible.
//   2. Decide (in)finiteness EXACTLY. The objective is unbounded below over ℤ iff
//      the feasible region is nonempty *and* its recession cone holds an integer
//      ray `d` with `A d ▷₀ 0` and `c·d ≤ −1` (then `x + k·d` stays feasible for
//      all integer `k ≥ 0` and drives `f → −∞`). That ray question is itself a
//      QF_LIA feasibility query — the homogeneous system with `c·d ≤ −1` — so we
//      answer it with a *second* Omega call. No floating point, fully exact.
//   3. Otherwise the optimum is finite. Anchor an incumbent at the first feasible
//      point and repeatedly assert `f ≤ incumbent − 1`; each SAT tightens the
//      incumbent to the new (possibly far lower) value, each UNSAT certifies the
//      incumbent optimal. Because the value strictly drops by ≥ 1 each round and
//      is bounded below, the descent terminates.
//
// Maximization is minimization of `−f`; the public API negates and flips back so
// the caller always sees the natural objective value. Every optimum is returned
// with a witness model the studio re-checks against the *original* constraints,
// and the self-check cross-validates the whole thing against exhaustive brute
// force over bounded boxes (where brute force is a complete oracle).

import { type Lin, cloneLin, evalLin, negate } from './lin'
import { type Cons, type OmegaOptions, OmegaBudgetError, omegaTest } from './omega'

export type Dir = 'min' | 'max'

export interface OptimizeOptions extends OmegaOptions {
  /** Cap on SAT–UNSAT descent rounds before bailing (each drops the value ≥1). */
  maxSteps?: number
}

/** One incumbent improvement recorded during the descent. */
export interface OptStep {
  value: bigint
  model: Map<number, bigint>
}

export type OptimizeResult =
  | { status: 'infeasible'; nodes: number }
  | {
      // The objective runs to ±∞. `ray` is an integer recession direction with
      // `f(point + k·ray)` strictly improving (toward the optimization sense) as
      // k grows; `point` is a concrete feasible anchor.
      status: 'unbounded'
      point: Map<number, bigint>
      ray: Map<number, bigint>
      nodes: number
    }
  | {
      status: 'optimal'
      value: bigint
      model: Map<number, bigint>
      steps: OptStep[]
      nodes: number
    }

/** Build the homogeneous recession constraint for `c` (drop its constant). */
function recession(c: Cons): Cons {
  return { lin: { c: 0n, t: new Map(c.lin.t) }, op: c.op }
}

/**
 * Minimize `Σ cᵢ xᵢ + c₀` (`obj`) over the integer feasible region. Internal —
 * the public `optimize` handles `max` by minimizing the negation.
 */
function minimize(
  constraints: Cons[],
  numVars: number,
  obj: Lin,
  names: (v: number) => string,
  opts: OptimizeOptions,
): OptimizeResult {
  const base = constraints.map((c) => ({ lin: cloneLin(c.lin), op: c.op }) as Cons)
  let nodes = 0

  // ---- 1. Feasibility. ----
  const feas = omegaTest(base, numVars, names, opts)
  nodes += feas.nodes
  if (feas.status === 'unsat') return { status: 'infeasible', nodes }
  const point = feas.model

  // ---- 2. Exact unboundedness via the recession cone. ----
  // Reinterpret x as a direction d: every constraint contributes its homogeneous
  // part, and we ask for c·d ≤ −1 (strict improvement that scales without limit).
  const objHom: Lin = { c: 0n, t: new Map(obj.t) }
  const recess: Cons[] = [
    ...base.map(recession),
    { lin: { c: -1n, t: negate(objHom).t }, op: 'ge' }, // −c·d − 1 ≥ 0  ⇔  c·d ≤ −1
  ]
  const ray = omegaTest(recess, numVars, names, opts)
  nodes += ray.nodes
  if (ray.status === 'sat') {
    return { status: 'unbounded', point, ray: ray.model, nodes }
  }

  // ---- 3. Bounded ⇒ linear SAT–UNSAT descent. ----
  const maxSteps = opts.maxSteps ?? 200_000
  let bestModel = point
  let bestVal = evalLin(obj, point)
  const steps: OptStep[] = [{ value: bestVal, model: new Map(bestModel) }]
  for (let i = 0; i < maxSteps; i++) {
    // Assert f ≤ bestVal − 1  ⇔  (bestVal − 1 − c₀) − Σ cᵢ xᵢ ≥ 0.
    const cut: Cons = { lin: { c: bestVal - 1n - obj.c, t: negate(objHom).t }, op: 'ge' }
    const res = omegaTest([...base, cut], numVars, names, opts)
    nodes += res.nodes
    if (res.status === 'unsat') {
      return { status: 'optimal', value: bestVal, model: bestModel, steps, nodes }
    }
    bestModel = res.model
    bestVal = evalLin(obj, res.model)
    steps.push({ value: bestVal, model: new Map(bestModel) })
  }
  throw new OmegaBudgetError(nodes)
}

/**
 * Optimize a linear objective over a QF_LIA region. `dir` selects min/max; the
 * returned `value` and `ray` are always expressed in the natural (un-negated)
 * objective.
 */
export function optimize(
  constraints: Cons[],
  numVars: number,
  obj: Lin,
  dir: Dir,
  names: (v: number) => string,
  opts: OptimizeOptions = {},
): OptimizeResult {
  if (dir === 'min') return minimize(constraints, numVars, obj, names, opts)
  // Maximize f = minimize (−f); flip the reported value back.
  const neg = negate(obj)
  const r = minimize(constraints, numVars, neg, names, opts)
  if (r.status === 'optimal') return { ...r, value: -r.value }
  return r
}

/** Evaluate the objective at a model (absent vars default to 0). */
export function objectiveValue(obj: Lin, model: Map<number, bigint>): bigint {
  return evalLin(obj, model)
}

/**
 * Exhaustive integer optimum over a finite box — the independent oracle. Shares
 * no code with `optimize`: it enumerates every lattice point, keeps the feasible
 * ones, and returns the best objective value. When the system bounds every
 * variable into the box this is the *true* optimum, certifying both the value
 * and the infeasible verdict.
 */
export function bruteOptimum(
  constraints: Cons[],
  numVars: number,
  obj: Lin,
  dir: Dir,
  lo: bigint,
  hi: bigint,
): { feasible: false } | { feasible: true; value: bigint; model: Map<number, bigint> } {
  const span = hi - lo + 1n
  if (span <= 0n) return { feasible: false }
  let total = 1n
  for (let k = 0; k < numVars; k++) total *= span
  const assign = new Array<bigint>(numVars).fill(lo)
  const model = new Map<number, bigint>()
  let best: { value: bigint; model: Map<number, bigint> } | null = null
  for (let idx = 0n; idx < total; idx++) {
    let rem = idx
    for (let k = 0; k < numVars; k++) {
      assign[k] = lo + (rem % span)
      rem /= span
    }
    model.clear()
    for (let k = 0; k < numVars; k++) model.set(k, assign[k])
    let ok = true
    for (const c of constraints) {
      const v = evalLin(c.lin, model)
      if (c.op === 'eq' ? v !== 0n : v < 0n) {
        ok = false
        break
      }
    }
    if (!ok) continue
    const val = evalLin(obj, model)
    if (best === null || (dir === 'min' ? val < best.value : val > best.value)) {
      best = { value: val, model: new Map(model) }
    }
  }
  if (best === null) return { feasible: false }
  return { feasible: true, value: best.value, model: best.model }
}
