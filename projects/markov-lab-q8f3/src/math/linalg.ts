// Tiny linear-algebra helpers used by the samplers and diagnostics.
// Everything is plain number[] / number[][] — no external deps.

export type Vec = number[]
export type Mat = number[][]

export const add = (a: Vec, b: Vec): Vec => a.map((v, i) => v + b[i])
export const sub = (a: Vec, b: Vec): Vec => a.map((v, i) => v - b[i])
export const scale = (a: Vec, s: number): Vec => a.map((v) => v * s)
export const dot = (a: Vec, b: Vec): number => a.reduce((acc, v, i) => acc + v * b[i], 0)
export const norm2 = (a: Vec): number => Math.sqrt(dot(a, a))
export const clone = (a: Vec): Vec => a.slice()

/** y = M·x for a dense matrix. */
export function matVec(M: Mat, x: Vec): Vec {
  const out = new Array<number>(M.length).fill(0)
  for (let i = 0; i < M.length; i++) {
    let s = 0
    const row = M[i]
    for (let j = 0; j < row.length; j++) s += row[j] * x[j]
    out[i] = s
  }
  return out
}

/** Lower-triangular Cholesky factor L such that L·Lᵀ = A (A symmetric PD). */
export function cholesky(A: Mat): Mat {
  const n = A.length
  const L: Mat = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = 0
      for (let k = 0; k < j; k++) s += L[i][k] * L[j][k]
      if (i === j) {
        const d = A[i][i] - s
        L[i][j] = Math.sqrt(Math.max(d, 1e-12))
      } else {
        L[i][j] = (A[i][j] - s) / L[j][j]
      }
    }
  }
  return L
}

/** Invert a 2×2 matrix (used all over for bivariate Gaussians). */
export function inv2(m: Mat): Mat {
  const [[a, b], [c, d]] = m
  const det = a * d - b * c
  const inv = 1 / det
  return [
    [d * inv, -b * inv],
    [-c * inv, a * inv],
  ]
}

export const det2 = (m: Mat): number => m[0][0] * m[1][1] - m[0][1] * m[1][0]

/** Solve L·y = b for lower-triangular L (forward substitution). */
export function forwardSolve(L: Mat, b: Vec): Vec {
  const n = L.length
  const y = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    let s = b[i]
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k]
    y[i] = s / L[i][i]
  }
  return y
}
