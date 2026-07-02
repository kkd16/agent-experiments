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

// =============================================================================
// v8 — the spectral layer: symmetric eigendecomposition (Jacobi), the SVD
// (one-sided Jacobi), general eigenvalues (Faddeev–LeVerrier → Durand–Kerner),
// and everything they unlock (rank, the 2-norm and its condition number, the
// Moore–Penrose pseudo-inverse). Still hand-derived, still dependency-free.
// =============================================================================

/** True when `a` is square and symmetric to a relative tolerance. */
export function isSymmetric(a: Mat, tol = 1e-9): boolean {
  const n = a.length
  if (n === 0 || a.some((r) => r.length !== n)) return false
  let scale = 0
  for (const row of a) for (const v of row) scale = Math.max(scale, Math.abs(v))
  const eps = tol * (scale || 1)
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (Math.abs(a[i][j] - a[j][i]) > eps) return false
  return true
}

export interface SymEigen {
  /** Eigenvalues, sorted descending. */
  values: number[]
  /** Eigenvectors as columns, aligned with `values`; orthonormal (Q with A = QΛQᵀ). */
  vectors: Mat
}

/**
 * Symmetric eigendecomposition by the cyclic **Jacobi** method: repeatedly apply
 * plane rotations that annihilate the largest off-diagonal pair until the matrix is
 * diagonal. Unconditionally convergent for a symmetric matrix and delivers a fully
 * orthonormal eigenvector basis — the accurate path behind `EIGVALS`/`EIGVECS`.
 */
export function jacobiEigen(aIn: Mat, sweeps = 100): SymEigen | null {
  const n = aIn.length
  if (n === 0 || aIn.some((r) => r.length !== n)) return null
  const a = aIn.map((r) => r.slice())
  const v = identity(n)
  const offNorm = (): number => {
    let s = 0
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) s += a[p][q] * a[p][q]
    return Math.sqrt(2 * s)
  }
  let diagScale = 0
  for (let i = 0; i < n; i++) diagScale = Math.max(diagScale, Math.abs(a[i][i]))
  const tol = 1e-15 * (diagScale || 1)
  for (let sweep = 0; sweep < sweeps; sweep++) {
    if (offNorm() <= tol) break
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p][q]
        if (Math.abs(apq) < 1e-300) continue
        // Rotation angle that zeroes a[p][q].
        const theta = (a[q][q] - a[p][p]) / (2 * apq)
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        // Rotate rows/cols p and q of A.
        for (let k = 0; k < n; k++) {
          const akp = a[k][p]
          const akq = a[k][q]
          a[k][p] = c * akp - s * akq
          a[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k]
          const aqk = a[q][k]
          a[p][k] = c * apk - s * aqk
          a[q][k] = s * apk + c * aqk
        }
        a[p][q] = a[q][p] = 0
        // Accumulate the rotation into the eigenvector matrix.
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p]
          const vkq = v[k][q]
          v[k][p] = c * vkp - s * vkq
          v[k][q] = s * vkp + c * vkq
        }
      }
    }
  }
  const values = a.map((_, i) => a[i][i])
  // Sort eigenvalues (and their eigenvectors) descending.
  const order = values.map((_, i) => i).sort((i, j) => values[j] - values[i])
  const sortedVals = order.map((i) => values[i])
  const sortedVecs: Mat = Array.from({ length: n }, (_, r) => order.map((i) => v[r][i]))
  // Canonicalize sign so the largest-magnitude entry of each eigenvector is positive.
  for (let col = 0; col < n; col++) {
    let best = 0
    for (let r = 0; r < n; r++) if (Math.abs(sortedVecs[r][col]) > Math.abs(sortedVecs[best][col])) best = r
    if (sortedVecs[best][col] < 0) for (let r = 0; r < n; r++) sortedVecs[r][col] = -sortedVecs[r][col]
  }
  return { values: sortedVals, vectors: sortedVecs }
}

export interface SVD {
  /** m×k left singular vectors (columns), k = min(m,n). */
  u: Mat
  /** Singular values, descending, length k. */
  s: number[]
  /** n×k right singular vectors (columns). */
  v: Mat
}

/**
 * Singular Value Decomposition by **one-sided Jacobi**: orthogonalize the columns of
 * A with plane rotations (each rotation zeroes one column-pair inner product) while
 * accumulating the right vectors in V; the column norms at convergence are the
 * singular values and the normalized columns are the left vectors. Works for any
 * shape — a wide matrix is handled by transposing and swapping U↔V.
 */
export function svd(aIn: Mat): SVD | null {
  const m0 = aIn.length
  if (m0 === 0) return null
  const n0 = aIn[0].length
  if (aIn.some((r) => r.length !== n0)) return null
  const wide = n0 > m0
  // Work on a tall (or square) matrix; transpose a wide one and swap U/V at the end.
  const A: Mat = wide ? transpose(aIn) : aIn.map((r) => r.slice())
  const m = A.length
  const n = A[0].length
  const V = identity(n)
  const EPS_SVD = 1e-14
  let converged = false
  for (let sweep = 0; sweep < 100 && !converged; sweep++) {
    converged = true
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        let alpha = 0
        let beta = 0
        let gamma = 0
        for (let k = 0; k < m; k++) {
          alpha += A[k][i] * A[k][i]
          beta += A[k][j] * A[k][j]
          gamma += A[k][i] * A[k][j]
        }
        if (Math.abs(gamma) <= EPS_SVD * Math.sqrt(alpha * beta) || gamma === 0) continue
        converged = false
        const zeta = (beta - alpha) / (2 * gamma)
        const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta))
        const c = 1 / Math.sqrt(1 + t * t)
        const s = c * t
        for (let k = 0; k < m; k++) {
          const aki = A[k][i]
          const akj = A[k][j]
          A[k][i] = c * aki - s * akj
          A[k][j] = s * aki + c * akj
        }
        for (let k = 0; k < n; k++) {
          const vki = V[k][i]
          const vkj = V[k][j]
          V[k][i] = c * vki - s * vkj
          V[k][j] = s * vki + c * vkj
        }
      }
    }
  }
  // Singular values = column norms; left vectors = normalized columns.
  const cols = Array.from({ length: n }, (_, j) => {
    let nrm = 0
    for (let k = 0; k < m; k++) nrm += A[k][j] * A[k][j]
    return Math.sqrt(nrm)
  })
  const order = cols.map((_, j) => j).sort((a, b) => cols[b] - cols[a])
  const k = Math.min(m, n)
  const s: number[] = []
  const u: Mat = Array.from({ length: m }, () => new Array(k).fill(0))
  const v: Mat = Array.from({ length: n }, () => new Array(k).fill(0))
  for (let idx = 0; idx < k; idx++) {
    const j = order[idx]
    const sigma = cols[j]
    s.push(sigma)
    for (let r = 0; r < n; r++) v[r][idx] = V[r][j]
    if (sigma > 1e-300) for (let r = 0; r < m; r++) u[r][idx] = A[r][j] / sigma
  }
  return wide ? { u: v, s, v: u } : { u, s, v }
}

/** Numerical rank from the SVD: singular values above a relative tolerance. */
export function matrixRank(a: Mat, tol?: number): number {
  const d = svd(a)
  if (!d) return 0
  const smax = d.s[0] ?? 0
  const t = tol ?? Math.max(a.length, a[0]?.length ?? 0) * smax * 2.220446049250313e-16
  return d.s.filter((x) => x > t).length
}

/** The 2-norm (largest singular value). */
export function norm2(a: Mat): number {
  const d = svd(a)
  return d ? d.s[0] ?? 0 : 0
}

/** The 2-norm condition number σ_max / σ_min (∞ when rank-deficient). */
export function cond2(a: Mat): number {
  const d = svd(a)
  if (!d || d.s.length === 0) return Infinity
  const smin = d.s[d.s.length - 1]
  return smin > 0 ? d.s[0] / smin : Infinity
}

/** Frobenius / 1 / ∞ matrix norms. */
export function normFro(a: Mat): number {
  let s = 0
  for (const row of a) for (const v of row) s += v * v
  return Math.sqrt(s)
}
export function norm1(a: Mat): number {
  const n = a[0]?.length ?? 0
  let best = 0
  for (let j = 0; j < n; j++) {
    let s = 0
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i][j])
    best = Math.max(best, s)
  }
  return best
}
export function normInf(a: Mat): number {
  let best = 0
  for (const row of a) best = Math.max(best, row.reduce((s, v) => s + Math.abs(v), 0))
  return best
}

/** Moore–Penrose pseudo-inverse A⁺ = V Σ⁺ Uᵀ (the exact least-squares solver, any shape/rank). */
export function pseudoInverse(a: Mat, tol?: number): Mat | null {
  const d = svd(a)
  if (!d) return null
  const m = a.length
  const n = a[0].length
  const k = d.s.length
  const smax = d.s[0] ?? 0
  const t = tol ?? Math.max(m, n) * smax * 2.220446049250313e-16
  // A⁺[j][i] = Σ_r V[j][r] (1/σ_r) U[i][r]
  const out: Mat = Array.from({ length: n }, () => new Array(m).fill(0))
  for (let r = 0; r < k; r++) {
    const sigma = d.s[r]
    if (sigma <= t) continue
    const inv = 1 / sigma
    for (let j = 0; j < n; j++) {
      const vjr = d.v[j][r] * inv
      if (vjr === 0) continue
      for (let i = 0; i < m; i++) out[j][i] += vjr * d.u[i][r]
    }
  }
  return out
}

// ---- general (non-symmetric) eigenvalues -----------------------------------
export interface Complex {
  re: number
  im: number
}

/**
 * The characteristic polynomial of a square matrix via the **Faddeev–LeVerrier**
 * recurrence. Returns the monic coefficients [1, c_{n-1}, …, c_0] (highest degree
 * first), each an exact rational combination of traces of powers of A. Accurate for
 * the small matrices a spreadsheet meets.
 */
export function charPoly(a: Mat): number[] | null {
  const n = a.length
  if (n === 0 || a.some((r) => r.length !== n)) return null
  // M_0 = I; a_k = tr(A M_{k-1})/k; M_k = A M_{k-1} − a_k I. p(λ)=λⁿ − Σ a_k λ^{n−k}.
  let M = identity(n)
  const coeffs = [1] // leading coefficient of the monic polynomial
  for (let k = 1; k <= n; k++) {
    const AM = matMul(a, M)
    if (!AM) return null
    let tr = 0
    for (let i = 0; i < n; i++) tr += AM[i][i]
    const ak = tr / k
    coeffs.push(-ak)
    // M_k = A M_{k-1} − a_k I
    M = AM.map((row, i) => row.map((val, j) => val - (i === j ? ak : 0)))
  }
  return coeffs
}

/** Evaluate a real-coefficient polynomial (highest degree first) at a complex point. */
function polyEvalComplex(coeffs: number[], z: Complex): Complex {
  let re = 0
  let im = 0
  for (const c of coeffs) {
    // (re + i·im)·z + c
    const nr = re * z.re - im * z.im + c
    const ni = re * z.im + im * z.re
    re = nr
    im = ni
  }
  return { re, im }
}

/**
 * All (complex) roots of a monic real polynomial by the **Durand–Kerner** (Weierstrass)
 * simultaneous iteration — robust for the modest degrees a spreadsheet eigenproblem
 * produces. Complex-conjugate roots are recovered as pairs.
 */
export function polyRoots(coeffs: number[], iters = 500): Complex[] {
  const deg = coeffs.length - 1
  if (deg <= 0) return []
  // Deflate any exact zero leading terms already handled (monic assumed).
  const roots: Complex[] = []
  // Spread initial guesses off the real axis to separate conjugate pairs.
  const seed: Complex = { re: 0.4, im: 0.9 }
  let p: Complex = { re: 1, im: 0 }
  for (let i = 0; i < deg; i++) {
    roots.push({ re: p.re, im: p.im })
    p = { re: p.re * seed.re - p.im * seed.im, im: p.re * seed.im + p.im * seed.re }
  }
  const cdiv = (a: Complex, b: Complex): Complex => {
    const d = b.re * b.re + b.im * b.im
    return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d }
  }
  for (let it = 0; it < iters; it++) {
    let maxDelta = 0
    for (let i = 0; i < deg; i++) {
      const num = polyEvalComplex(coeffs, roots[i])
      let den: Complex = { re: 1, im: 0 }
      for (let j = 0; j < deg; j++) {
        if (j === i) continue
        const diff = { re: roots[i].re - roots[j].re, im: roots[i].im - roots[j].im }
        den = { re: den.re * diff.re - den.im * diff.im, im: den.re * diff.im + den.im * diff.re }
      }
      const step = cdiv(num, den)
      roots[i] = { re: roots[i].re - step.re, im: roots[i].im - step.im }
      maxDelta = Math.max(maxDelta, Math.hypot(step.re, step.im))
    }
    if (maxDelta < 1e-14) break
  }
  // Snap negligible imaginary parts to zero (real roots), relative to magnitude.
  return roots.map((r) => ({ re: r.re, im: Math.abs(r.im) < 1e-9 * (1 + Math.hypot(r.re, r.im)) ? 0 : r.im }))
}

/** General eigenvalues (possibly complex): char poly (Faddeev–LeVerrier) → roots (Durand–Kerner). */
export function eigenvaluesGeneral(a: Mat): Complex[] | null {
  const poly = charPoly(a)
  if (!poly) return null
  const roots = polyRoots(poly)
  // Sort by descending real part, then descending imaginary part — a stable display order.
  roots.sort((x, y) => y.re - x.re || y.im - x.im)
  return roots
}
