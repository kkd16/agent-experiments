// Numerical linear algebra and least-squares regression — pure, dependency-free,
// zero React, in the same spirit as `solver.ts`, `optimizer.ts` and `distributions.ts`.
//
// Two layers live here:
//   1. A small dense-matrix core over `number[][]`: multiply, LU decomposition with
//      partial pivoting (→ determinant, inverse, linear solve), and a thin Householder
//      QR (→ a numerically-stable least-squares solver).
//   2. A real ordinary-least-squares **regression** engine built on the QR solver. It
//      returns the coefficients *and* the full statistics block — standard errors, R²,
//      the standard error of the estimate, the F statistic, the regression/residual
//      degrees of freedom, and the regression/residual sums of squares — exactly the
//      numbers Excel's LINEST reports, derived from the same decomposition (the
//      coefficient covariance is σ²·R⁻¹R⁻ᵀ, read straight off the QR factor R).
//
// Everything is hand-derived; nothing here imports a math library.

export type Mat = number[][]

const EPS = 1e-12

// ---- basic ops --------------------------------------------------------------
export function matMul(a: Mat, b: Mat): Mat | null {
  const n = a.length
  const k = a[0]?.length ?? 0
  const k2 = b.length
  const m = b[0]?.length ?? 0
  if (k !== k2) return null
  const out: Mat = Array.from({ length: n }, () => new Array(m).fill(0))
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < k; p++) {
      const aip = a[i][p]
      if (aip === 0) continue
      const brow = b[p]
      const orow = out[i]
      for (let j = 0; j < m; j++) orow[j] += aip * brow[j]
    }
  }
  return out
}

export function identity(n: number): Mat {
  const out: Mat = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) out[i][i] = 1
  return out
}

export function transpose(a: Mat): Mat {
  const n = a.length
  const m = a[0]?.length ?? 0
  const out: Mat = Array.from({ length: m }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) out[j][i] = a[i][j]
  return out
}

// ---- LU with partial pivoting → det / inverse / solve -----------------------
interface LU {
  lu: Mat
  piv: number[]
  sign: number
}

function luDecompose(a: Mat): LU | null {
  const n = a.length
  if (n === 0 || a[0].length !== n) return null
  const lu = a.map((row) => row.slice())
  const piv = Array.from({ length: n }, (_, i) => i)
  let sign = 1
  for (let col = 0; col < n; col++) {
    // partial pivot: pick the largest magnitude in this column at/below the diagonal
    let max = Math.abs(lu[col][col])
    let pivRow = col
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(lu[r][col])
      if (v > max) {
        max = v
        pivRow = r
      }
    }
    if (max < EPS) return null // singular
    if (pivRow !== col) {
      ;[lu[col], lu[pivRow]] = [lu[pivRow], lu[col]]
      ;[piv[col], piv[pivRow]] = [piv[pivRow], piv[col]]
      sign = -sign
    }
    const pivotVal = lu[col][col]
    for (let r = col + 1; r < n; r++) {
      const factor = (lu[r][col] /= pivotVal)
      if (factor === 0) continue
      for (let c = col + 1; c < n; c++) lu[r][c] -= factor * lu[col][c]
    }
  }
  return { lu, piv, sign }
}

/** det(A) via LU (product of the U diagonal times the permutation sign). */
export function determinant(a: Mat): number | null {
  if (a.length === 0 || a.length !== a[0].length) return null
  const f = luDecompose(a)
  if (!f) return 0 // singular ⇒ determinant 0
  let det = f.sign
  for (let i = 0; i < a.length; i++) det *= f.lu[i][i]
  return det
}

/** Solve A x = b for a single right-hand side using a prefactored LU. */
function luSolve(f: LU, b: number[]): number[] {
  const n = f.lu.length
  const x = new Array(n).fill(0)
  for (let i = 0; i < n; i++) x[i] = b[f.piv[i]]
  // forward substitution (unit lower triangular)
  for (let i = 0; i < n; i++) {
    let sum = x[i]
    for (let j = 0; j < i; j++) sum -= f.lu[i][j] * x[j]
    x[i] = sum
  }
  // back substitution (upper triangular)
  for (let i = n - 1; i >= 0; i--) {
    let sum = x[i]
    for (let j = i + 1; j < n; j++) sum -= f.lu[i][j] * x[j]
    x[i] = sum / f.lu[i][i]
  }
  return x
}

/** A⁻¹ via LU, solving against each identity column. Returns null when singular. */
export function inverse(a: Mat): Mat | null {
  const n = a.length
  if (n === 0 || a[0].length !== n) return null
  const f = luDecompose(a)
  if (!f) return null
  const inv: Mat = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let col = 0; col < n; col++) {
    const e = new Array(n).fill(0)
    e[col] = 1
    const x = luSolve(f, e)
    for (let row = 0; row < n; row++) inv[row][col] = x[row]
  }
  return inv
}

/** Solve A x = b (square A). Returns null when A is singular. */
export function solve(a: Mat, b: number[]): number[] | null {
  const f = luDecompose(a)
  if (!f) return null
  return luSolve(f, b)
}

// ---- thin Householder QR → least squares ------------------------------------
/** In-place thin QR of an n×p matrix (n ≥ p). Returns R (p×p) and the means to
 *  apply Qᵀ to vectors via the stored Householder reflectors. */
interface QR {
  qt: (v: number[]) => number[] // applies Qᵀ to a length-n vector
  r: Mat // p×p upper-triangular factor
  rank: number
}

function householderQR(aIn: Mat): QR {
  const n = aIn.length
  const p = aIn[0]?.length ?? 0
  const a = aIn.map((row) => row.slice())
  const vs: number[][] = [] // the Householder vectors
  let rank = 0
  for (let k = 0; k < p; k++) {
    // build the reflector for column k over rows k..n-1
    let norm = 0
    for (let i = k; i < n; i++) norm += a[i][k] * a[i][k]
    norm = Math.sqrt(norm)
    if (norm < EPS) {
      vs.push(new Array(n).fill(0))
      continue
    }
    rank++
    const alpha = a[k][k] >= 0 ? -norm : norm
    const v = new Array(n).fill(0)
    v[k] = a[k][k] - alpha
    for (let i = k + 1; i < n; i++) v[i] = a[i][k]
    let vnorm = 0
    for (let i = k; i < n; i++) vnorm += v[i] * v[i]
    if (vnorm < EPS) {
      vs.push(new Array(n).fill(0))
      continue
    }
    // apply (I - 2 v vᵀ / vᵀv) to the trailing columns of A
    for (let j = k; j < p; j++) {
      let dot = 0
      for (let i = k; i < n; i++) dot += v[i] * a[i][j]
      const f = (2 * dot) / vnorm
      for (let i = k; i < n; i++) a[i][j] -= f * v[i]
    }
    vs.push(v.map((x) => x / Math.sqrt(vnorm))) // store the unit reflector
  }
  const r: Mat = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => (i <= j ? a[i][j] : 0)))
  const qt = (vec: number[]): number[] => {
    const w = vec.slice()
    for (let k = 0; k < p; k++) {
      const v = vs[k]
      let dot = 0
      for (let i = k; i < n; i++) dot += v[i] * w[i]
      const f = 2 * dot
      for (let i = k; i < n; i++) w[i] -= f * v[i]
    }
    return w
  }
  return { qt, r, rank }
}

/** Back-substitution for an upper-triangular p×p system R x = y. */
function backSub(r: Mat, y: number[]): number[] {
  const p = r.length
  const x = new Array(p).fill(0)
  for (let i = p - 1; i >= 0; i--) {
    if (Math.abs(r[i][i]) < EPS) return x.fill(NaN)
    let sum = y[i]
    for (let j = i + 1; j < p; j++) sum -= r[i][j] * x[j]
    x[i] = sum / r[i][i]
  }
  return x
}

/** Least-squares solution of the (possibly tall) system X β ≈ y via Householder QR. */
export function lstsq(x: Mat, y: number[]): number[] | null {
  if (x.length === 0 || x.length !== y.length) return null
  const p = x[0].length
  if (x.length < p) return null
  const { qt, r, rank } = householderQR(x)
  if (rank < p) return null // rank-deficient design
  const qty = qt(y)
  return backSub(r, qty.slice(0, p))
}

// ---- ordinary least-squares regression (the LINEST core) --------------------
export interface RegressionResult {
  /** β in *natural* order: [coef_x1, coef_x2, …, intercept]. */
  coefficients: number[]
  /** Standard error of each coefficient, same order as `coefficients`. */
  standardErrors: number[]
  rSquared: number
  /** Standard error of the y estimate (the residual standard deviation). */
  standardError: number
  fStatistic: number
  /** Residual degrees of freedom (n − number of parameters). */
  degreesOfFreedom: number
  ssRegression: number
  ssResidual: number
  /** Predicted ŷ for every input row. */
  fitted: number[]
}

/**
 * Ordinary least-squares of `y` (length n) on the design rows `xRows` (n × k, the raw
 * predictor columns, *without* the intercept). When `withIntercept`, a leading 1-column
 * is prepended so β₀ is the intercept. Returns the coefficients in natural order plus the
 * complete LINEST statistics block, or null when the system is rank-deficient.
 */
export function regress(y: number[], xRows: Mat, withIntercept: boolean): RegressionResult | null {
  const n = y.length
  if (n === 0 || xRows.length !== n) return null
  // Build the design matrix (optionally with a leading intercept column).
  const design: Mat = xRows.map((row) => (withIntercept ? [1, ...row] : row.slice()))
  const p = design[0].length // number of parameters
  if (p === 0 || n <= p) return null
  const { qt, r, rank } = householderQR(design)
  if (rank < p) return null
  const qty = qt(y)
  const betaRaw = backSub(r, qty.slice(0, p)) // [intercept?, coef_x1, …]
  if (betaRaw.some((b) => !Number.isFinite(b))) return null

  // Fitted values and residual sum of squares.
  const fitted = design.map((row) => row.reduce((s, v, j) => s + v * betaRaw[j], 0))
  let ssResidual = 0
  for (let i = 0; i < n; i++) ssResidual += (y[i] - fitted[i]) ** 2

  // Total sum of squares: about the mean when there's an intercept, about 0 otherwise.
  const meanY = y.reduce((a, b) => a + b, 0) / n
  let ssTotal = 0
  for (let i = 0; i < n; i++) ssTotal += (y[i] - (withIntercept ? meanY : 0)) ** 2
  const ssRegression = ssTotal - ssResidual

  const dof = n - p
  const sigma2 = dof > 0 ? ssResidual / dof : 0
  const standardError = Math.sqrt(sigma2)

  // Coefficient covariance = σ²·(XᵀX)⁻¹ = σ²·R⁻¹R⁻ᵀ. Invert the (small) p×p R.
  const rInv = inverse(r)
  const cov: Mat = Array.from({ length: p }, () => new Array(p).fill(0))
  if (rInv) {
    for (let i = 0; i < p; i++) {
      for (let j = 0; j < p; j++) {
        let s = 0
        for (let m = 0; m < p; m++) s += rInv[i][m] * rInv[j][m]
        cov[i][j] = sigma2 * s
      }
    }
  }
  const standardErrors = betaRaw.map((_, i) => Math.sqrt(Math.max(cov[i][i], 0)))

  // R² and the F statistic. Regression df = p − 1 with an intercept, else p.
  const rSquared = ssTotal > 0 ? Math.max(0, Math.min(1, ssRegression / ssTotal)) : 0
  const dfReg = withIntercept ? p - 1 : p
  const fStatistic = dfReg > 0 && sigma2 > 0 ? ssRegression / dfReg / sigma2 : Infinity

  // Re-order into natural order: [coef_x1, …, coef_xk, intercept].
  const coefficients = withIntercept ? [...betaRaw.slice(1), betaRaw[0]] : betaRaw.slice()
  const seOrdered = withIntercept ? [...standardErrors.slice(1), standardErrors[0]] : standardErrors.slice()

  return {
    coefficients,
    standardErrors: seOrdered,
    rSquared,
    standardError,
    fStatistic,
    degreesOfFreedom: dof,
    ssRegression,
    ssResidual,
    fitted,
  }
}

/** Simple-regression convenience: slope, intercept and r² of y on a single x vector. */
export function simpleLinear(y: number[], x: number[]): { slope: number; intercept: number; r2: number } | null {
  const n = y.length
  if (n < 2 || x.length !== n) return null
  const res = regress(
    y,
    x.map((v) => [v]),
    true,
  )
  if (!res) return null
  return { slope: res.coefficients[0], intercept: res.coefficients[1], r2: res.rSquared }
}
