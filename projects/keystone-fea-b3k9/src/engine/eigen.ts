// Dense symmetric eigen-analysis — the numerical heart of modal and buckling
// analysis. Where the static solver answers "how far does it move under this
// load?", these routines answer the two *eigenvalue* questions of structural
// mechanics: "how does it vibrate?" (K φ = ω² M φ) and "when does it buckle?"
// ((K + λ K_g) φ = 0). Both reduce to a generalized symmetric eigenproblem
//     A x = λ B x,   A symmetric,  B symmetric positive-definite.
//
// The method is textbook and fully self-contained:
//   1. factor B = L Lᵀ (Cholesky),
//   2. form the symmetric standard problem C = L⁻¹ A L⁻ᵀ,
//   3. diagonalise C with a cyclic Jacobi sweep (all eigenpairs, high accuracy),
//   4. map eigenvectors back: x = L⁻ᵀ z.
//
// Everything is pure `number[][]` / `number[]` — deterministic, no globals, no
// time, no randomness — so the same matrices always yield the same spectrum,
// and validate.ts can cross-check the results against closed-form solutions.

export type Mat = number[][]

/** Deep-copy a dense matrix. */
export function cloneMat(A: Mat): Mat {
  return A.map((row) => row.slice())
}

/** Allocate an n×n zero matrix. */
export function zeros(n: number, m = n): Mat {
  return Array.from({ length: n }, () => new Array(m).fill(0))
}

/** Identity matrix of size n. */
export function eye(n: number): Mat {
  const I = zeros(n)
  for (let i = 0; i < n; i++) I[i][i] = 1
  return I
}

/**
 * Cholesky factorisation of a symmetric positive-definite matrix: B = L·Lᵀ,
 * with L lower-triangular. Returns null if B is not positive-definite (a
 * non-positive pivot appears) — the caller treats that as a singular /
 * mechanism system rather than crashing.
 */
export function choleskyLower(B: Mat): Mat | null {
  const n = B.length
  const L = zeros(n)
  for (let j = 0; j < n; j++) {
    let d = B[j][j]
    for (let k = 0; k < j; k++) d -= L[j][k] * L[j][k]
    if (d <= 0 || !Number.isFinite(d)) return null
    const ljj = Math.sqrt(d)
    L[j][j] = ljj
    for (let i = j + 1; i < n; i++) {
      let s = B[i][j]
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k]
      L[i][j] = s / ljj
    }
  }
  return L
}

/** Solve L·y = b for lower-triangular L (forward substitution). */
export function forwardSolve(L: Mat, b: number[]): number[] {
  const n = L.length
  const y = new Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    let s = b[i]
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k]
    y[i] = s / L[i][i]
  }
  return y
}

/** Solve Lᵀ·x = b for lower-triangular L (back substitution). */
export function backSolveT(L: Mat, b: number[]): number[] {
  const n = L.length
  const x = new Array(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i]
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]
    x[i] = s / L[i][i]
  }
  return x
}

export interface EigenResult {
  /** Eigenvalues, ascending. */
  values: number[]
  /** Eigenvectors as columns: vectors[i][k] is component i of eigenvector k. */
  vectors: Mat
}

/**
 * All eigenpairs of a real symmetric matrix by the cyclic Jacobi method.
 *
 * Jacobi repeatedly applies Givens rotations that zero the largest off-diagonal
 * entries; it converges quadratically and delivers a full orthonormal
 * eigenbasis with excellent accuracy for the small dense matrices that arise
 * from reduced structural systems. Returns eigenpairs sorted by ascending
 * eigenvalue.
 */
export function jacobiEig(Ain: Mat, maxSweeps = 100, tol = 1e-14): EigenResult {
  const n = Ain.length
  if (n === 0) return { values: [], vectors: [] }
  if (n === 1) return { values: [Ain[0][0]], vectors: [[1]] }
  const A = cloneMat(Ain)
  const V = eye(n)

  const offNorm = (): number => {
    let s = 0
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) s += A[p][q] * A[p][q]
    return Math.sqrt(2 * s)
  }

  let scale = 0
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) scale = Math.max(scale, Math.abs(A[i][j]))
  const thresh = tol * Math.max(scale, 1)

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    if (offNorm() <= thresh) break
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = A[p][q]
        if (Math.abs(apq) <= 1e-300) continue
        const app = A[p][p]
        const aqq = A[q][q]
        // Rotation angle that zeroes A[p][q].
        const phi = (aqq - app) / (2 * apq)
        const t =
          Math.sign(phi || 1) / (Math.abs(phi) + Math.sqrt(phi * phi + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        // Apply the rotation to rows/cols p, q of A.
        for (let i = 0; i < n; i++) {
          const aip = A[i][p]
          const aiq = A[i][q]
          A[i][p] = c * aip - s * aiq
          A[i][q] = s * aip + c * aiq
        }
        for (let i = 0; i < n; i++) {
          const api = A[p][i]
          const aqi = A[q][i]
          A[p][i] = c * api - s * aqi
          A[q][i] = s * api + c * aqi
        }
        // Accumulate the eigenvectors.
        for (let i = 0; i < n; i++) {
          const vip = V[i][p]
          const viq = V[i][q]
          V[i][p] = c * vip - s * viq
          V[i][q] = s * vip + c * viq
        }
      }
    }
  }

  const values = new Array(n)
  for (let i = 0; i < n; i++) values[i] = A[i][i]

  // Sort ascending, permuting eigenvectors with their eigenvalues.
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b])
  const sortedVals = order.map((i) => values[i])
  const sortedVecs = zeros(n)
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) sortedVecs[i][k] = V[i][order[k]]
  return { values: sortedVals, vectors: sortedVecs }
}

/**
 * Generalized symmetric eigenproblem A·x = λ·B·x with B symmetric
 * positive-definite. Reduces to a standard symmetric problem via Cholesky of B
 * and returns eigenpairs sorted by ascending λ. Eigenvectors are B-orthonormal
 * (xᵢᵀ·B·xⱼ = δᵢⱼ). Returns null when B is not positive-definite.
 */
export function generalizedSymEig(A: Mat, B: Mat): EigenResult | null {
  const n = A.length
  if (n === 0) return { values: [], vectors: [] }
  const L = choleskyLower(B)
  if (!L) return null

  // G = L⁻¹ · A  (forward-solve each column of A).
  const G = zeros(n)
  for (let j = 0; j < n; j++) {
    const col = new Array(n)
    for (let i = 0; i < n; i++) col[i] = A[i][j]
    const g = forwardSolve(L, col)
    for (let i = 0; i < n; i++) G[i][j] = g[i]
  }
  // C = L⁻¹ · Aᵀ · L⁻ᵀ = L⁻¹ · Gᵀ  (A symmetric ⇒ A·L⁻ᵀ = Gᵀ).
  // Column j of C is L⁻¹ applied to row j of G.
  const C = zeros(n)
  for (let j = 0; j < n; j++) {
    const rowj = G[j].slice()
    const c = forwardSolve(L, rowj)
    for (let i = 0; i < n; i++) C[i][j] = c[i]
  }
  // Symmetrise to kill rounding asymmetry before Jacobi.
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const m = 0.5 * (C[i][j] + C[j][i])
      C[i][j] = m
      C[j][i] = m
    }

  const { values, vectors } = jacobiEig(C)
  // Map eigenvectors back: x = L⁻ᵀ · z.
  const outVecs = zeros(n)
  for (let k = 0; k < n; k++) {
    const z = new Array(n)
    for (let i = 0; i < n; i++) z[i] = vectors[i][k]
    const x = backSolveT(L, z)
    for (let i = 0; i < n; i++) outVecs[i][k] = x[i]
  }
  return { values, vectors: outVecs }
}

/** y = A·x for a dense matrix. */
export function matVecDense(A: Mat, x: number[]): number[] {
  return A.map((row) => {
    let s = 0
    for (let j = 0; j < row.length; j++) s += row[j] * x[j]
    return s
  })
}

/** xᵀ·A·x — the quadratic form (used to normalise / measure modal quantities). */
export function quadForm(A: Mat, x: number[]): number {
  const y = matVecDense(A, x)
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i] * y[i]
  return s
}
