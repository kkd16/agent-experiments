// A from-scratch numerical *optimizer* — the engine behind the multi-cell Solver
// ("find the values of these changing cells that maximize / minimize / hit a target
// in this cell, subject to these constraints"). Like `solver.ts` (Goal Seek) it knows
// nothing about spreadsheets: a model is supplied as black-box functions of a variable
// vector, which in practice set the changing cells, recompute the workbook, and read
// the objective / constraint cells back. That keeps every algorithm here trivially
// unit-testable in isolation.
//
// Two complementary engines live here:
//
//   • `solveLP` — an EXACT two-phase primal **simplex** for linear programs. It handles
//     ≤ / ≥ / = constraints and arbitrary lower/upper variable bounds (finite, one-sided,
//     or free) by a standard substitution into non-negative variables, then runs phase-1
//     (drive out artificials) and phase-2 with **Bland's rule** so it never cycles. When
//     the Solver detects a model is linear it extracts the coefficients by probing and
//     solves it to the exact vertex optimum — including detecting infeasible / unbounded.
//
//   • `minimizeConstrained` — a derivative-free **Nelder–Mead** simplex wrapped in a
//     **quadratic penalty / multi-start** method for general *nonlinear* models. It needs
//     no gradients (the model is a black box), respects bounds, and restarts from several
//     points with an escalating penalty weight to escape local minima and home in on a
//     feasible optimum. This is the GRG-Nonlinear / Evolutionary analogue.
//
// `optimize` is the front door: it tries the exact LP path when the caller says the model
// is linear, and otherwise (or on LP failure) falls back to the nonlinear search.

export type Relation = '<=' | '>=' | '='

// ---- shared types -----------------------------------------------------------

export interface VarBound {
  lo: number // may be -Infinity
  hi: number // may be +Infinity
}

/** A constraint `fn(x) {rel} rhs`, where `fn` is a black box over the variable vector. */
export interface Constraint {
  fn: (x: number[]) => number
  rel: Relation
  rhs: number
}

export type OptStatus = 'optimal' | 'feasible' | 'infeasible' | 'unbounded' | 'error'
export type OptMethod = 'simplex' | 'nelder-mead'

export interface OptimizeResult {
  status: OptStatus
  method: OptMethod
  x: number[]
  fx: number // the objective value at x (in the original sense)
  feasible: boolean
  maxViolation: number
  iterations: number
}

// ===========================================================================
//  Linear programming: an exact two-phase primal simplex
// ===========================================================================

export interface LPProblem {
  /** Objective coefficients over the original variables. */
  c: number[]
  /** Constant added to the objective (folded out of the LHS during extraction). */
  c0?: number
  maximize: boolean
  /** Constraint matrix rows over the original variables. */
  A: number[][]
  rel: Relation[]
  b: number[]
  /** Per-variable bounds (default `[0, +∞)` when omitted). */
  lo: number[]
  hi: number[]
}

export interface LPResult {
  status: 'optimal' | 'infeasible' | 'unbounded'
  x: number[]
  z: number
  iterations: number
}

const LP_TOL = 1e-9

/** A reconstruction of one original variable from the non-negative working variables:
 *  `x_i = const + Σ coeff·w[idx]`. */
interface Recon {
  const: number
  terms: Array<{ idx: number; coeff: number }>
}

/**
 * Solve a linear program to its exact optimum (or report infeasible / unbounded).
 *
 * Variables are first substituted onto the non-negative orthant: a finite lower bound
 * shifts the variable; a one-sided upper bound flips it; a free variable splits into a
 * difference of two non-negatives. Finite upper bounds become extra `≤` rows. The result
 * is a standard-form program solved by the classic two-phase method.
 */
export function solveLP(p: LPProblem): LPResult {
  const n = p.c.length
  const lo = p.lo ?? Array(n).fill(0)
  const hi = p.hi ?? Array(n).fill(Infinity)

  // Build the substitution: working variables w (all ≥ 0) and how each x_i reads off them.
  const recon: Recon[] = []
  const extraRows: { coeffs: Map<number, number>; rel: Relation; rhs: number }[] = []
  let nw = 0
  const newVar = (): number => nw++

  for (let i = 0; i < n; i++) {
    const L = lo[i]
    const H = hi[i]
    if (Number.isFinite(L)) {
      // x = t + L, t ≥ 0; add t ≤ H−L when H is finite.
      const t = newVar()
      recon.push({ const: L, terms: [{ idx: t, coeff: 1 }] })
      if (Number.isFinite(H)) extraRows.push({ coeffs: new Map([[t, 1]]), rel: '<=', rhs: H - L })
    } else if (Number.isFinite(H)) {
      // lo = −∞, hi finite: x = H − t, t ≥ 0.
      const t = newVar()
      recon.push({ const: H, terms: [{ idx: t, coeff: -1 }] })
    } else {
      // free: x = p − q, p,q ≥ 0.
      const pi = newVar()
      const qi = newVar()
      recon.push({ const: 0, terms: [{ idx: pi, coeff: 1 }, { idx: qi, coeff: -1 }] })
    }
  }

  // Translate a linear form over original vars into one over working vars (+ a constant).
  const translate = (coeffsByVar: number[]): { w: Map<number, number>; constant: number } => {
    const w = new Map<number, number>()
    let constant = 0
    for (let i = 0; i < n; i++) {
      const a = coeffsByVar[i]
      if (a === 0) continue
      constant += a * recon[i].const
      for (const { idx, coeff } of recon[i].terms) w.set(idx, (w.get(idx) ?? 0) + a * coeff)
    }
    return { w, constant }
  }

  // Objective (we always minimize internally; flip sign for maximize).
  const objSign = p.maximize ? -1 : 1
  const objT = translate(p.c)
  const cost = Array(nw).fill(0)
  for (const [idx, v] of objT.w) cost[idx] = objSign * v

  // Constraints over working variables, RHS made non-negative.
  interface Row {
    a: number[]
    rel: Relation
    b: number
  }
  const rows: Row[] = []
  const pushRow = (wmap: Map<number, number>, rel: Relation, rhs: number) => {
    const a = Array(nw).fill(0)
    for (const [idx, v] of wmap) a[idx] = v
    let bb = rhs
    let rr = rel
    if (bb < 0) {
      for (let k = 0; k < nw; k++) a[k] = -a[k]
      bb = -bb
      rr = rel === '<=' ? '>=' : rel === '>=' ? '<=' : '='
    }
    rows.push({ a, rel: rr, b: bb })
  }

  for (let k = 0; k < p.A.length; k++) {
    const t = translate(p.A[k])
    pushRow(t.w, p.rel[k], p.b[k] - t.constant)
  }
  for (const er of extraRows) pushRow(er.coeffs, er.rel, er.rhs)

  const sol = twoPhaseSimplex(nw, cost, rows)
  if (sol.status !== 'optimal') return { status: sol.status, x: [], z: NaN, iterations: sol.iterations }

  // Reconstruct the original variables and the objective in the original sense.
  const x = recon.map((r) => r.const + r.terms.reduce((s, t) => s + t.coeff * (sol.w[t.idx] ?? 0), 0))
  const z = (p.c0 ?? 0) + x.reduce((s, xi, i) => s + p.c[i] * xi, 0)
  return { status: 'optimal', x, z, iterations: sol.iterations }
}

interface SimplexRow {
  a: number[]
  rel: Relation
  b: number
}

/** Two-phase primal simplex over `min cost·w, rows, w ≥ 0`. Returns the optimal `w`. */
function twoPhaseSimplex(
  nStruct: number,
  cost: number[],
  rows: SimplexRow[],
): { status: 'optimal' | 'infeasible' | 'unbounded'; w: number[]; iterations: number } {
  const m = rows.length
  // Column layout: [structural | slack/surplus per row | artificial per row].
  const slackOf: number[] = []
  const artOf: number[] = []
  let nCols = nStruct
  for (let i = 0; i < m; i++) {
    if (rows[i].rel === '<=') {
      slackOf[i] = nCols++
      artOf[i] = -1
    } else if (rows[i].rel === '>=') {
      slackOf[i] = nCols++ // surplus (−1 coefficient)
      artOf[i] = nCols++
    } else {
      slackOf[i] = -1
      artOf[i] = nCols++
    }
  }

  // Tableau: m rows × (nCols + 1) with the RHS in the last column.
  const T: number[][] = rows.map(() => Array(nCols + 1).fill(0))
  const basis: number[] = Array(m).fill(-1)
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < nStruct; j++) T[i][j] = rows[i].a[j]
    T[i][nCols] = rows[i].b
    if (rows[i].rel === '<=') {
      T[i][slackOf[i]] = 1
      basis[i] = slackOf[i]
    } else if (rows[i].rel === '>=') {
      T[i][slackOf[i]] = -1
      T[i][artOf[i]] = 1
      basis[i] = artOf[i]
    } else {
      T[i][artOf[i]] = 1
      basis[i] = artOf[i]
    }
  }

  const artificialCols = new Set<number>(artOf.filter((a) => a >= 0))
  const hasArtificials = artificialCols.size > 0
  let iterations = 0

  // ---- Phase 1: minimize the sum of artificials, if any. ----
  if (hasArtificials) {
    const phase1Cost = Array(nCols).fill(0)
    for (const a of artificialCols) phase1Cost[a] = 1
    const res1 = optimizeTableau(T, basis, phase1Cost, nCols)
    iterations += res1.iters
    // Sum of artificials at optimum; > 0 ⇒ no feasible point. (Phase 1 is always bounded.)
    let phase1Obj = 0
    for (let i = 0; i < m; i++) phase1Obj += phase1Cost[basis[i]] * T[i][nCols]
    if (res1.status === 'unbounded' || phase1Obj > 1e-7) return { status: 'infeasible', w: [], iterations }

    // Drive any artificial still in the basis (at value ~0) out, to free phase 2.
    for (let i = 0; i < m; i++) {
      if (artificialCols.has(basis[i])) {
        let pivotCol = -1
        for (let j = 0; j < nStruct; j++) {
          if (Math.abs(T[i][j]) > LP_TOL) {
            pivotCol = j
            break
          }
        }
        if (pivotCol >= 0) pivot(T, basis, i, pivotCol)
      }
    }
  }

  // ---- Phase 2: minimize the real objective. Artificials are forbidden from re-entering. ----
  const fullCost = Array(nCols).fill(0)
  for (let j = 0; j < nStruct; j++) fullCost[j] = cost[j]
  const res2 = optimizeTableau(T, basis, fullCost, nCols, artificialCols)
  iterations += res2.iters
  if (res2.status === 'unbounded') return { status: 'unbounded', w: [], iterations }

  const w = Array(nStruct).fill(0)
  for (let i = 0; i < m; i++) if (basis[i] < nStruct) w[basis[i]] = T[i][nCols]
  return { status: 'optimal', w, iterations }
}

/**
 * Drive a tableau to optimality for `min cost·x` using Bland's anti-cycling rule.
 * Mutates `T` and `basis` in place. Returns the status and the iteration count.
 */
function optimizeTableau(
  T: number[][],
  basis: number[],
  cost: number[],
  nCols: number,
  forbidden?: Set<number>,
): { status: 'optimal' | 'unbounded'; iters: number } {
  const m = T.length
  const MAX_ITERS = 5000
  let iters = 0
  for (; iters < MAX_ITERS; iters++) {
    // Reduced costs: c_j − c_B · B⁻¹ A_j, read straight off the tableau columns.
    let entering = -1
    for (let j = 0; j < nCols; j++) {
      if (forbidden?.has(j)) continue
      let reduced = cost[j]
      for (let i = 0; i < m; i++) reduced -= cost[basis[i]] * T[i][j]
      if (reduced < -1e-9) {
        entering = j // Bland: smallest index with a negative reduced cost
        break
      }
    }
    if (entering === -1) break // optimal

    // Ratio test: smallest non-negative RHS/column ratio; tie-break to smallest basis index.
    let leaving = -1
    let best = Infinity
    for (let i = 0; i < m; i++) {
      const a = T[i][entering]
      if (a > 1e-9) {
        const ratio = T[i][nCols] / a
        if (ratio < best - 1e-12 || (Math.abs(ratio - best) <= 1e-12 && (leaving < 0 || basis[i] < basis[leaving]))) {
          best = ratio
          leaving = i
        }
      }
    }
    if (leaving === -1) return { status: 'unbounded', iters }
    pivot(T, basis, leaving, entering)
  }
  return { status: 'optimal', iters }
}

/** Gaussian pivot on (row, col): normalize the pivot row, eliminate the column elsewhere. */
function pivot(T: number[][], basis: number[], row: number, col: number): void {
  const m = T.length
  const cols = T[0].length
  const pv = T[row][col]
  for (let j = 0; j < cols; j++) T[row][j] /= pv
  for (let i = 0; i < m; i++) {
    if (i === row) continue
    const factor = T[i][col]
    if (factor === 0) continue
    for (let j = 0; j < cols; j++) T[i][j] -= factor * T[row][j]
  }
  basis[row] = col
}

// ===========================================================================
//  Nonlinear: Nelder–Mead + quadratic penalty + multi-start
// ===========================================================================

export interface NelderMeadOptions {
  maxIter?: number
  tol?: number
  initialStep?: number
}

/** Minimize a black-box `f` from `x0` with the Nelder–Mead downhill simplex method. */
export function nelderMead(
  f: (x: number[]) => number,
  x0: number[],
  opts: NelderMeadOptions = {},
): { x: number[]; fx: number; iterations: number } {
  const n = x0.length
  if (n === 0) return { x: [], fx: f([]), iterations: 0 }
  const maxIter = opts.maxIter ?? 400 * n
  const tol = opts.tol ?? 1e-10
  const step = opts.initialStep ?? 1

  const alpha = 1 // reflection
  const gamma = 2 // expansion
  const rho = 0.5 // contraction
  const sigma = 0.5 // shrink

  const safe = (x: number[]): number => {
    const v = f(x)
    return Number.isFinite(v) ? v : 1e18
  }

  // Build the initial simplex: x0 plus a step along each axis.
  const simplex: { x: number[]; fx: number }[] = []
  simplex.push({ x: x0.slice(), fx: safe(x0) })
  for (let i = 0; i < n; i++) {
    const xi = x0.slice()
    const h = xi[i] !== 0 ? step * 0.05 * Math.abs(xi[i]) + step * 0.1 : step
    xi[i] += h
    simplex.push({ x: xi, fx: safe(xi) })
  }

  let iterations = 0
  for (; iterations < maxIter; iterations++) {
    simplex.sort((a, b) => a.fx - b.fx)
    const best = simplex[0]
    const worst = simplex[n]
    const secondWorst = simplex[n - 1]

    // Convergence: simplex has collapsed in both domain and value.
    const fspread = Math.abs(worst.fx - best.fx)
    if (fspread <= tol * (Math.abs(best.fx) + tol)) break

    // Centroid of all but the worst vertex.
    const centroid = Array(n).fill(0)
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i].x[j] / n

    const reflect = centroid.map((c, j) => c + alpha * (c - worst.x[j]))
    const fr = safe(reflect)

    if (fr < best.fx) {
      const expand = centroid.map((c, j) => c + gamma * (reflect[j] - c))
      const fe = safe(expand)
      simplex[n] = fe < fr ? { x: expand, fx: fe } : { x: reflect, fx: fr }
    } else if (fr < secondWorst.fx) {
      simplex[n] = { x: reflect, fx: fr }
    } else {
      // Contraction (outside if reflection improved on the worst, else inside).
      const useOutside = fr < worst.fx
      const base = useOutside ? reflect : worst.x
      const contract = centroid.map((c, j) => c + rho * (base[j] - c))
      const fc = safe(contract)
      if (fc < Math.min(worst.fx, fr)) {
        simplex[n] = { x: contract, fx: fc }
      } else {
        // Shrink the whole simplex toward the best vertex.
        for (let i = 1; i <= n; i++) {
          const xs = simplex[i].x.map((xi, j) => best.x[j] + sigma * (xi - best.x[j]))
          simplex[i] = { x: xs, fx: safe(xs) }
        }
      }
    }
  }
  simplex.sort((a, b) => a.fx - b.fx)
  return { x: simplex[0].x, fx: simplex[0].fx, iterations }
}

export interface ConstrainedSpec {
  objective: (x: number[]) => number
  sense: 'min' | 'max'
  /** For a 'value' target, supply `objective` as `(model − target)²` and sense 'min'. */
  x0: number[]
  bounds: VarBound[]
  constraints: Constraint[]
  maxRestarts?: number
  /** A deterministic RNG in [0,1); injected so results are reproducible. */
  rng?: () => number
}

/** Total constraint + bound violation at `x` (0 when feasible). */
export function violation(x: number[], bounds: VarBound[], constraints: Constraint[]): number {
  let v = 0
  for (let i = 0; i < x.length; i++) {
    if (x[i] < bounds[i].lo - 1e-9) v += bounds[i].lo - x[i]
    if (x[i] > bounds[i].hi + 1e-9) v += x[i] - bounds[i].hi
  }
  for (const c of constraints) {
    const g = c.fn(x)
    if (!Number.isFinite(g)) {
      v += 1e6
      continue
    }
    if (c.rel === '<=') v += Math.max(0, g - c.rhs)
    else if (c.rel === '>=') v += Math.max(0, c.rhs - g)
    else v += Math.abs(g - c.rhs)
  }
  return v
}

/**
 * Minimize/maximize a nonlinear black-box objective subject to bounds and constraints,
 * via a quadratic **penalty method**: each outer round folds the constraints into the
 * objective with a growing weight μ and re-optimizes with Nelder–Mead from the previous
 * best. Several **random restarts** within the bounds guard against local minima.
 */
export function minimizeConstrained(spec: ConstrainedSpec): OptimizeResult {
  const n = spec.x0.length
  const sign = spec.sense === 'max' ? -1 : 1 // internally always minimize
  const rng = spec.rng ?? mulberry32(0x9e3779b9)
  const restarts = spec.maxRestarts ?? 6

  const clampToBox = (x: number[]): number[] =>
    x.map((xi, i) => Math.min(spec.bounds[i].hi, Math.max(spec.bounds[i].lo, xi)))

  // Penalized objective at penalty weight μ.
  const penalized = (mu: number) => (x: number[]): number => {
    const xc = clampToBox(x)
    let p = sign * spec.objective(xc)
    if (!Number.isFinite(p)) return 1e18
    // Bound penalty (soft; the clamp above keeps evaluation in-box but we still push back).
    for (let i = 0; i < n; i++) {
      const below = spec.bounds[i].lo - x[i]
      const above = x[i] - spec.bounds[i].hi
      if (below > 0) p += mu * below * below
      if (above > 0) p += mu * above * above
    }
    for (const c of spec.constraints) {
      const g = c.fn(xc)
      if (!Number.isFinite(g)) return 1e18
      const viol = c.rel === '<=' ? Math.max(0, g - c.rhs) : c.rel === '>=' ? Math.max(0, c.rhs - g) : g - c.rhs
      p += mu * viol * viol
    }
    return p
  }

  const runFrom = (start: number[]): { x: number[]; viol: number; obj: number; iters: number } => {
    let x = clampToBox(start)
    let totalIters = 0
    let mu = 10
    for (let round = 0; round < 8; round++) {
      const res = nelderMead(penalized(mu), x, { maxIter: 300 * Math.max(1, n), initialStep: 1 })
      x = clampToBox(res.x)
      totalIters += res.iterations
      mu *= 8
    }
    return { x, viol: violation(x, spec.bounds, spec.constraints), obj: spec.objective(x), iters: totalIters }
  }

  // Seed points: the supplied start, then random points inside the (finite) bounds.
  const starts: number[][] = [spec.x0.slice()]
  for (let s = 0; s < restarts; s++) {
    const pt = spec.x0.map((x0i, i) => {
      const lo = Number.isFinite(spec.bounds[i].lo) ? spec.bounds[i].lo : x0i - 10
      const hi = Number.isFinite(spec.bounds[i].hi) ? spec.bounds[i].hi : x0i + 10
      return lo + rng() * (hi - lo)
    })
    starts.push(pt)
  }

  let bestX: number[] | null = null
  let bestObj = Infinity
  let bestViol = Infinity
  let iterations = 0
  for (const st of starts) {
    const r = runFrom(st)
    iterations += r.iters
    const objInternal = sign * r.obj
    // Prefer feasibility first, then objective; a tiny tolerance treats near-feasible as feasible.
    const feasibleNow = r.viol <= 1e-6
    const bestFeasible = bestViol <= 1e-6
    let better: boolean
    if (feasibleNow && !bestFeasible) better = true
    else if (!feasibleNow && bestFeasible) better = false
    else if (feasibleNow && bestFeasible) better = objInternal < bestObj - 1e-12
    else better = r.viol < bestViol - 1e-9
    if (better || bestX === null) {
      bestX = r.x
      bestObj = objInternal
      bestViol = r.viol
    }
  }

  const x = bestX ?? clampToBox(spec.x0)
  const feasible = bestViol <= 1e-6
  return {
    status: feasible ? 'optimal' : 'infeasible',
    method: 'nelder-mead',
    x,
    fx: spec.objective(x),
    feasible,
    maxViolation: bestViol,
    iterations,
  }
}

/** A small, deterministic PRNG (mulberry32) so the multi-start search is reproducible. */
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

// ===========================================================================
//  Front door
// ===========================================================================

export interface OptimizeSpec {
  objective: (x: number[]) => number
  sense: 'min' | 'max' | 'value'
  target?: number // for sense === 'value'
  x0: number[]
  bounds: VarBound[]
  constraints: Constraint[]
  /** When the model is known to be linear, the caller may supply extracted coefficients
   *  so we can solve it exactly with the simplex method. */
  linear?: {
    c: number[]
    c0: number
    A: number[][]
    rel: Relation[]
    b: number[]
  }
  rng?: () => number
}

/**
 * The Solver entry point. If a linear extraction is supplied it is solved exactly with
 * the simplex; the LP optimum is then handed back (re-evaluated through the real model so
 * the reported objective matches the spreadsheet exactly). Otherwise — or if the LP turns
 * out infeasible/unbounded — the nonlinear penalty/Nelder–Mead search runs.
 */
export function optimize(spec: OptimizeSpec): OptimizeResult {
  // 'value' sense ⇒ minimize squared distance of the model to the target.
  if (spec.sense === 'value') {
    const target = spec.target ?? 0
    const sq = (x: number[]): number => {
      const m = spec.objective(x)
      return (m - target) * (m - target)
    }
    const res = minimizeConstrained({
      objective: sq,
      sense: 'min',
      x0: spec.x0,
      bounds: spec.bounds,
      constraints: spec.constraints,
      rng: spec.rng,
    })
    return { ...res, fx: spec.objective(res.x) }
  }

  if (spec.linear) {
    const lp = solveLP({
      c: spec.linear.c,
      c0: spec.linear.c0,
      maximize: spec.sense === 'max',
      A: spec.linear.A,
      rel: spec.linear.rel,
      b: spec.linear.b,
      lo: spec.bounds.map((b) => b.lo),
      hi: spec.bounds.map((b) => b.hi),
    })
    if (lp.status === 'optimal') {
      const viol = violation(lp.x, spec.bounds, spec.constraints)
      return {
        status: 'optimal',
        method: 'simplex',
        x: lp.x,
        fx: spec.objective(lp.x),
        feasible: viol <= 1e-6,
        maxViolation: viol,
        iterations: lp.iterations,
      }
    }
    if (lp.status === 'unbounded') {
      return { status: 'unbounded', method: 'simplex', x: spec.x0, fx: spec.objective(spec.x0), feasible: false, maxViolation: Infinity, iterations: lp.iterations }
    }
    // infeasible → report it (a linear model that's infeasible stays infeasible).
    return { status: 'infeasible', method: 'simplex', x: spec.x0, fx: spec.objective(spec.x0), feasible: false, maxViolation: Infinity, iterations: lp.iterations }
  }

  return minimizeConstrained({
    objective: spec.objective,
    sense: spec.sense,
    x0: spec.x0,
    bounds: spec.bounds,
    constraints: spec.constraints,
    rng: spec.rng,
  })
}
