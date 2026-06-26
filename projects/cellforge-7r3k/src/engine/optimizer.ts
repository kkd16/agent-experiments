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
export type OptMethod = 'simplex' | 'branch-and-bound' | 'nelder-mead'

export interface OptimizeResult {
  status: OptStatus
  method: OptMethod
  x: number[]
  fx: number // the objective value at x (in the original sense)
  feasible: boolean
  maxViolation: number
  iterations: number
  /** Branch-and-bound nodes explored (only for integer models). */
  nodes?: number
  /** LP post-optimal sensitivity report (only for pure-continuous linear models). */
  sensitivity?: LPSensitivity
  /** Per-variable integrality flags echoed back (only for integer models). */
  integer?: boolean[]
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

/** Post-optimal sensitivity for one constraint (the "shadow price" / dual report). */
export interface ConstraintSensitivity {
  /** Marginal value of relaxing this constraint: ∂z/∂b (the slope of the optimum in the RHS). */
  shadowPrice: number
  lhs: number // A_k · x* at the optimum
  rhs: number // the constraint's right-hand side
  /** Signed slack: rhs − lhs. ~0 ⇒ the constraint is binding. */
  slack: number
  binding: boolean
  /** RHS range [rhsLow, rhsHigh] over which the shadow price stays constant. */
  rhsLow: number
  rhsHigh: number
}

/** Post-optimal sensitivity for one variable (the "reduced cost" report). */
export interface VariableSensitivity {
  value: number // x_j* at the optimum
  /** Rate the objective would change per forced unit of a variable held at its bound. */
  reducedCost: number
  /** Objective-coefficient range [objLow, objHigh] over which the basis stays optimal. */
  objLow: number
  objHigh: number
}

export interface LPSensitivity {
  constraints: ConstraintSensitivity[]
  variables: VariableSensitivity[]
}

export interface LPFullResult extends LPResult {
  /** One dual value per original constraint (the shadow prices), when optimal. */
  duals?: number[]
  sensitivity?: LPSensitivity
}

const LP_TOL = 1e-9

/** A reconstruction of one original variable from the non-negative working variables:
 *  `x_i = const + Σ coeff·w[idx]`. */
interface Recon {
  const: number
  terms: Array<{ idx: number; coeff: number }>
}

/** The standard form a `LPProblem` is reduced to before the simplex runs, plus the
 *  bookkeeping needed to map dual prices back onto the original constraints. */
interface StandardForm {
  recon: Recon[]
  cost: number[]
  rows: SimplexRow[]
  /** For each pushed row: +1 if it kept its orientation, −1 if `pushRow` negated it
   *  (RHS made non-negative). Only the first `p.A.length` rows are user constraints. */
  rowFlip: number[]
  nw: number
  objSign: number
}

/** Reduce a (bounded, mixed-relation) LP to `min cost·w, rows, w ≥ 0` standard form.
 *  Variables are substituted onto the non-negative orthant: a finite lower bound shifts
 *  the variable; a one-sided upper bound flips it; a free variable splits into a difference
 *  of two non-negatives. Finite upper bounds become extra `≤` rows. */
function buildStandardForm(p: LPProblem): StandardForm {
  const n = p.c.length
  const lo = p.lo ?? Array(n).fill(0)
  const hi = p.hi ?? Array(n).fill(Infinity)

  const recon: Recon[] = []
  const extraRows: { coeffs: Map<number, number>; rel: Relation; rhs: number }[] = []
  let nw = 0
  const newVar = (): number => nw++

  for (let i = 0; i < n; i++) {
    const L = lo[i]
    const H = hi[i]
    if (Number.isFinite(L)) {
      const t = newVar()
      recon.push({ const: L, terms: [{ idx: t, coeff: 1 }] })
      if (Number.isFinite(H)) extraRows.push({ coeffs: new Map([[t, 1]]), rel: '<=', rhs: H - L })
    } else if (Number.isFinite(H)) {
      const t = newVar()
      recon.push({ const: H, terms: [{ idx: t, coeff: -1 }] })
    } else {
      const pi = newVar()
      const qi = newVar()
      recon.push({ const: 0, terms: [{ idx: pi, coeff: 1 }, { idx: qi, coeff: -1 }] })
    }
  }

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

  const objSign = p.maximize ? -1 : 1
  const objT = translate(p.c)
  const cost = Array(nw).fill(0)
  for (const [idx, v] of objT.w) cost[idx] = objSign * v

  const rows: SimplexRow[] = []
  const rowFlip: number[] = []
  const pushRow = (wmap: Map<number, number>, rel: Relation, rhs: number) => {
    const a = Array(nw).fill(0)
    for (const [idx, v] of wmap) a[idx] = v
    let bb = rhs
    let rr = rel
    let flip = 1
    if (bb < 0) {
      for (let k = 0; k < nw; k++) a[k] = -a[k]
      bb = -bb
      rr = rel === '<=' ? '>=' : rel === '>=' ? '<=' : '='
      flip = -1
    }
    rows.push({ a, rel: rr, b: bb })
    rowFlip.push(flip)
  }

  for (let k = 0; k < p.A.length; k++) {
    const t = translate(p.A[k])
    pushRow(t.w, p.rel[k], p.b[k] - t.constant)
  }
  for (const er of extraRows) pushRow(er.coeffs, er.rel, er.rhs)

  return { recon, cost, rows, rowFlip, nw, objSign }
}

/** Reconstruct the original variables `x` from the non-negative working solution `w`. */
function reconstruct(recon: Recon[], w: number[]): number[] {
  return recon.map((r) => r.const + r.terms.reduce((s, t) => s + t.coeff * (w[t.idx] ?? 0), 0))
}

/**
 * Solve a linear program to its exact optimum (or report infeasible / unbounded) by the
 * classic two-phase primal simplex over the non-negative standard form.
 */
export function solveLP(p: LPProblem): LPResult {
  const sf = buildStandardForm(p)
  const sol = twoPhaseSimplex(sf.nw, sf.cost, sf.rows)
  if (sol.status !== 'optimal') return { status: sol.status, x: [], z: NaN, iterations: sol.iterations }
  const x = reconstruct(sf.recon, sol.w)
  const z = (p.c0 ?? 0) + x.reduce((s, xi, i) => s + p.c[i] * xi, 0)
  return { status: 'optimal', x, z, iterations: sol.iterations }
}

/**
 * Solve a linear program AND read off its post-optimal **sensitivity** report — the
 * dual / shadow prices, reduced costs, and right-hand-side / objective-coefficient
 * ranges. This is what Excel's "Sensitivity Report" gives you.
 *
 * Dual prices come straight off the optimal simplex tableau: the reduced cost of a
 * constraint's slack (≤), surplus (≥) or artificial (=) column equals ±yᵢ, which we
 * map back through the variable substitution and the max/min sense to get ∂z/∂bᵢ.
 * The *ranges* — over which a shadow price (RHS) or the optimal basis (objective coef)
 * stays put — are found by a robust parametric re-solve that walks the parameter out
 * until the dual (resp. the variable's optimal value) breaks, then bisects the kink.
 */
export function solveLPFull(p: LPProblem, opts: { ranging?: boolean } = {}): LPFullResult {
  const ranging = opts.ranging ?? true
  const sf = buildStandardForm(p)
  const sol = twoPhaseSimplex(sf.nw, sf.cost, sf.rows)
  if (sol.status !== 'optimal' || !sol.T || !sol.basis || sol.nCols === undefined || !sol.slackOf || !sol.artOf) {
    return { status: sol.status === 'optimal' ? 'infeasible' : sol.status, x: [], z: NaN, iterations: sol.iterations }
  }
  const x = reconstruct(sf.recon, sol.w)
  const z = (p.c0 ?? 0) + x.reduce((s, xi, i) => s + p.c[i] * xi, 0)

  const { T, basis, nCols, slackOf, artOf } = sol
  const m = basis.length
  // Phase-2 cost: the real objective on structural columns, 0 on slack/surplus/artificial.
  const fullCost = Array(nCols).fill(0)
  for (let j = 0; j < sf.nw; j++) fullCost[j] = sf.cost[j]
  const reducedCost = (j: number): number => {
    let rc = fullCost[j]
    for (let i = 0; i < m; i++) rc -= fullCost[basis[i]] * T[i][j]
    return rc
  }

  // ---- Dual / shadow prices, one per ORIGINAL constraint. ----
  const nUser = p.A.length
  const duals: number[] = []
  for (let k = 0; k < nUser; k++) {
    const rel = sf.rows[k].rel // possibly flipped relative to p.rel[k]
    let yInt: number // ∂Z_int/∂(internal rhs of row k)
    if (rel === '<=') yInt = -reducedCost(slackOf[k])
    else if (rel === '>=') yInt = reducedCost(slackOf[k]) // surplus column (initial −eₖ)
    else yInt = -reducedCost(artOf[k]) // equality: read the artificial column (initial +eₖ)
    // Map back: ∂z_user/∂b_k = objSign · rowFlip_k · yInt.
    duals.push(sf.objSign * sf.rowFlip[k] * yInt)
  }

  let sensitivity: LPSensitivity | undefined
  if (ranging) {
    const constraints: ConstraintSensitivity[] = []
    for (let k = 0; k < nUser; k++) {
      const lhs = p.A[k].reduce((s, a, j) => s + a * x[j], 0)
      const rhs = p.b[k]
      const slack = rhs - lhs
      const binding = Math.abs(slack) <= 1e-6 || Math.abs(duals[k]) > 1e-7
      // RHS range: walk b_k until the shadow price changes basis.
      const measure = (d: number): number | null => {
        const r = solveLPFull({ ...p, b: p.b.map((bb, i) => (i === k ? bb + d : bb)) }, { ranging: false })
        return r.status === 'optimal' && r.duals ? r.duals[k] : null
      }
      const { dec, inc } = allowableRange(duals[k], measure)
      constraints.push({
        shadowPrice: duals[k],
        lhs,
        rhs,
        slack,
        binding,
        rhsLow: Number.isFinite(dec) ? rhs - dec : -Infinity,
        rhsHigh: Number.isFinite(inc) ? rhs + inc : Infinity,
      })
    }

    const variables: VariableSensitivity[] = []
    for (let j = 0; j < p.c.length; j++) {
      // Reduced cost is well-defined for a "clean" lower-bounded variable (single working
      // column with coefficient +1 — the x ≥ L case, which is the overwhelming common one).
      const rc = sf.recon[j]
      let reduced = 0
      if (rc.terms.length === 1 && rc.terms[0].coeff === 1) reduced = sf.objSign * reducedCost(rc.terms[0].idx)
      // Objective-coefficient range: walk c_j until x_j*'s optimal value moves.
      const measure = (d: number): number | null => {
        const r = solveLP({ ...p, c: p.c.map((cc, i) => (i === j ? cc + d : cc)) })
        return r.status === 'optimal' ? r.x[j] : null
      }
      const { dec, inc } = allowableRange(x[j], measure)
      variables.push({
        value: x[j],
        reducedCost: Math.abs(reduced) < 1e-9 ? 0 : reduced,
        objLow: Number.isFinite(dec) ? p.c[j] - dec : -Infinity,
        objHigh: Number.isFinite(inc) ? p.c[j] + inc : Infinity,
      })
    }
    sensitivity = { constraints, variables }
  }

  return { status: 'optimal', x, z, iterations: sol.iterations, duals, sensitivity }
}

/** How far a parameter can move (up `inc`, down `dec`) before the quantity `measure(δ)`
 *  — which is *constant within an optimal basis* — deviates from its value at δ=0. */
function allowableRange(base: number, measure: (d: number) => number | null): { dec: number; inc: number } {
  return { dec: stableExtent(base, (d) => measure(-d)), inc: stableExtent(base, measure) }
}

/** Largest δ ≥ 0 with `measure(δ) ≈ base` (basis still optimal); `Infinity` if unbounded. */
function stableExtent(base: number, measure: (d: number) => number | null): number {
  const tol = 1e-6 * (1 + Math.abs(base))
  const stable = (d: number): boolean => {
    const v = measure(d)
    return v !== null && Math.abs(v - base) <= tol
  }
  const CAP = 1e12
  let lastStable = 0
  let step = 1e-4
  while (step <= CAP) {
    if (stable(step)) {
      lastStable = step
      step *= 8
    } else break
  }
  if (lastStable >= CAP) return Infinity
  if (lastStable === 0 && !stable(1e-4)) return 0
  // Bisect between the last stable point and the first unstable one.
  let lo = lastStable
  let hi = Math.min(step, CAP)
  if (stable(hi)) return Infinity // never broke up to the cap
  for (let it = 0; it < 32; it++) {
    const mid = (lo + hi) / 2
    if (stable(mid)) lo = mid
    else hi = mid
  }
  return lo
}

// ===========================================================================
//  Mixed-integer programming: LP-based branch & bound
// ===========================================================================

export interface MILPResult {
  /** `feasible` ⇒ an integer solution was found but the search hit its node cap before
   *  proving optimality. */
  status: 'optimal' | 'feasible' | 'infeasible' | 'unbounded'
  x: number[]
  z: number
  /** Branch-and-bound nodes explored (LP relaxations solved). */
  nodes: number
  iterations: number
  /** Whether the search tree was exhausted (so the incumbent is provably optimal). */
  complete: boolean
}

/**
 * Solve a **mixed-integer linear program**: the LP `p`, with the variables flagged in
 * `integer` required to take integer values. Classic LP-based **branch & bound** — solve
 * the continuous relaxation, and if an integer variable comes back fractional, branch into
 * two subproblems (`x_j ≤ ⌊x_j⌋` and `x_j ≥ ⌈x_j⌉`) by tightening that variable's bounds.
 * An incumbent integer solution prunes any subtree whose relaxation can't beat it (the
 * "bound" in branch & bound), so we never enumerate the exponential lattice in full.
 *
 * Binary variables are simply integers with bounds `[0, 1]` (set by the caller). Most-
 * fractional branching with a depth-first stack keeps memory flat and finds incumbents fast.
 */
export function solveMILP(
  p: LPProblem,
  integer: boolean[],
  opts: { maxNodes?: number; intTol?: number } = {},
): MILPResult {
  const maxNodes = opts.maxNodes ?? 50000
  const intTol = opts.intTol ?? 1e-6
  const n = p.c.length
  const baseLo = (p.lo ?? Array(n).fill(0)).slice()
  const baseHi = (p.hi ?? Array(n).fill(Infinity)).slice()

  const root = solveLP(p)
  if (root.status === 'unbounded') return { status: 'unbounded', x: [], z: NaN, nodes: 1, iterations: root.iterations, complete: true }
  if (root.status === 'infeasible') return { status: 'infeasible', x: [], z: NaN, nodes: 1, iterations: root.iterations, complete: true }

  let nodes = 0
  let iterations = root.iterations
  let complete = true
  let bestX: number[] | null = null
  let bestZ = p.maximize ? -Infinity : Infinity
  const canImprove = (z: number): boolean => (p.maximize ? z > bestZ + 1e-9 : z < bestZ - 1e-9)

  const stack: Array<{ lo: number[]; hi: number[] }> = [{ lo: baseLo, hi: baseHi }]
  while (stack.length) {
    if (nodes >= maxNodes) {
      complete = false
      break
    }
    const node = stack.pop()!
    nodes++
    const r = solveLP({ ...p, lo: node.lo, hi: node.hi })
    iterations += r.iterations
    if (r.status === 'unbounded') return { status: 'unbounded', x: [], z: NaN, nodes, iterations, complete: true }
    if (r.status !== 'optimal') continue // infeasible subtree → prune
    if (bestX && !canImprove(r.z)) continue // bound: can't beat the incumbent

    // Most-fractional integer variable.
    let frac = -1
    let fracDist = intTol
    for (let j = 0; j < n; j++) {
      if (!integer[j]) continue
      const f = Math.abs(r.x[j] - Math.round(r.x[j]))
      if (f > fracDist) {
        fracDist = f
        frac = j
      }
    }
    if (frac === -1) {
      // Integer-feasible leaf — snap integers to whole numbers and update the incumbent.
      if (!bestX || canImprove(r.z)) {
        bestZ = r.z
        bestX = r.x.map((v, j) => (integer[j] ? Math.round(v) : v))
      }
      continue
    }

    const xf = r.x[frac]
    const floorChild = { lo: node.lo.slice(), hi: node.hi.slice() }
    floorChild.hi[frac] = Math.min(floorChild.hi[frac], Math.floor(xf))
    const ceilChild = { lo: node.lo.slice(), hi: node.hi.slice() }
    ceilChild.lo[frac] = Math.max(ceilChild.lo[frac], Math.ceil(xf))
    // Explore the nearer branch first (LIFO ⇒ push the farther one first).
    if (xf - Math.floor(xf) > 0.5) {
      stack.push(floorChild)
      stack.push(ceilChild)
    } else {
      stack.push(ceilChild)
      stack.push(floorChild)
    }
  }

  if (!bestX) return { status: 'infeasible', x: [], z: NaN, nodes, iterations, complete }
  const z = (p.c0 ?? 0) + bestX.reduce((s, xi, i) => s + p.c[i] * xi, 0)
  return { status: complete ? 'optimal' : 'feasible', x: bestX, z, nodes, iterations, complete }
}

interface SimplexRow {
  a: number[]
  rel: Relation
  b: number
}

/** The full state of a finished two-phase simplex — enough to read dual prices off. */
interface SimplexSolution {
  status: 'optimal' | 'infeasible' | 'unbounded'
  w: number[]
  iterations: number
  /** Final tableau (m × nCols+1), basis, and column map — only set when `status === 'optimal'`. */
  T?: number[][]
  basis?: number[]
  nCols?: number
  /** For row i: the slack/surplus column (or −1), and the artificial column (or −1). */
  slackOf?: number[]
  artOf?: number[]
}

/** Two-phase primal simplex over `min cost·w, rows, w ≥ 0`. Returns the optimal `w`. */
function twoPhaseSimplex(
  nStruct: number,
  cost: number[],
  rows: SimplexRow[],
): SimplexSolution {
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
  return { status: 'optimal', w, iterations, T, basis, nCols, slackOf, artOf }
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
  /** Per-variable integrality flags. When any are set on a linear model, the Solver runs
   *  branch & bound (mixed-integer programming) instead of a plain simplex. */
  integer?: boolean[]
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
    const lp: LPProblem = {
      c: spec.linear.c,
      c0: spec.linear.c0,
      maximize: spec.sense === 'max',
      A: spec.linear.A,
      rel: spec.linear.rel,
      b: spec.linear.b,
      lo: spec.bounds.map((b) => b.lo),
      hi: spec.bounds.map((b) => b.hi),
    }
    const anyInteger = spec.integer?.some(Boolean) ?? false

    // ---- Mixed-integer model: branch & bound. ----
    if (anyInteger) {
      const mip = solveMILP(lp, spec.integer!)
      if (mip.status === 'optimal' || mip.status === 'feasible') {
        const viol = violation(mip.x, spec.bounds, spec.constraints)
        return {
          status: mip.status,
          method: 'branch-and-bound',
          x: mip.x,
          fx: spec.objective(mip.x),
          feasible: viol <= 1e-6,
          maxViolation: viol,
          iterations: mip.iterations,
          nodes: mip.nodes,
          integer: spec.integer,
        }
      }
      const st = mip.status // 'infeasible' | 'unbounded'
      return { status: st, method: 'branch-and-bound', x: spec.x0, fx: spec.objective(spec.x0), feasible: false, maxViolation: Infinity, iterations: mip.iterations, nodes: mip.nodes, integer: spec.integer }
    }

    // ---- Pure continuous LP: simplex + a post-optimal sensitivity report. ----
    const full = solveLPFull(lp, { ranging: lp.c.length + lp.A.length <= 24 })
    if (full.status === 'optimal') {
      const viol = violation(full.x, spec.bounds, spec.constraints)
      return {
        status: 'optimal',
        method: 'simplex',
        x: full.x,
        fx: spec.objective(full.x),
        feasible: viol <= 1e-6,
        maxViolation: viol,
        iterations: full.iterations,
        sensitivity: full.sensitivity,
      }
    }
    if (full.status === 'unbounded') {
      return { status: 'unbounded', method: 'simplex', x: spec.x0, fx: spec.objective(spec.x0), feasible: false, maxViolation: Infinity, iterations: full.iterations }
    }
    // infeasible → report it (a linear model that's infeasible stays infeasible).
    return { status: 'infeasible', method: 'simplex', x: spec.x0, fx: spec.objective(spec.x0), feasible: false, maxViolation: Infinity, iterations: full.iterations }
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
