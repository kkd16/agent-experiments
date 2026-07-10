// Linear algebra for the FEA solver.
//
// Two worlds live here:
//   * tiny dense matrices (number[][]) for element stiffness blocks and the
//     independent LDLᵀ cross-check used by the validation harness;
//   * a sparse compressed-row (CSR) global stiffness matrix solved by a
//     boundary-condition-aware preconditioned conjugate-gradient iteration.
//
// Everything is pure and deterministic — no globals, no time, no randomness —
// so the same model always yields the same numbers, in the browser or in Node.

export type Vec = Float64Array

/** Compressed sparse row matrix (full symmetric storage — both triangles). */
export interface CSR {
  n: number
  rowPtr: Int32Array
  col: Int32Array
  val: Float64Array
  diag: Float64Array
}

/**
 * Triplet accumulator for assembling a global stiffness matrix element by
 * element. Duplicate (i, j) contributions are summed, exactly as the
 * direct-stiffness method requires.
 */
export class Assembler {
  readonly n: number
  private rowMaps: Map<number, number>[]
  constructor(n: number) {
    this.n = n
    this.rowMaps = Array.from({ length: n }, () => new Map<number, number>())
  }

  add(i: number, j: number, v: number): void {
    if (v === 0) return
    const row = this.rowMaps[i]
    row.set(j, (row.get(j) ?? 0) + v)
  }

  /** Scatter a dense element matrix `ke` into global DOFs `dofs`. */
  addBlock(dofs: number[], ke: number[][]): void {
    const m = dofs.length
    for (let a = 0; a < m; a++) {
      const ia = dofs[a]
      const kea = ke[a]
      for (let b = 0; b < m; b++) {
        const v = kea[b]
        if (v !== 0) this.add(ia, dofs[b], v)
      }
    }
  }

  build(): CSR {
    const n = this.n
    const rowPtr = new Int32Array(n + 1)
    for (let i = 0; i < n; i++) rowPtr[i + 1] = rowPtr[i] + this.rowMaps[i].size
    const nnz = rowPtr[n]
    const col = new Int32Array(nnz)
    const val = new Float64Array(nnz)
    const diag = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const entries = [...this.rowMaps[i].entries()].sort((a, b) => a[0] - b[0])
      let p = rowPtr[i]
      for (const [j, v] of entries) {
        col[p] = j
        val[p] = v
        if (j === i) diag[i] = v
        p++
      }
    }
    return { n, rowPtr, col, val, diag }
  }
}

/** y = A·x */
export function matVec(A: CSR, x: Vec, y: Vec): void {
  const { n, rowPtr, col, val } = A
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let p = rowPtr[i], e = rowPtr[i + 1]; p < e; p++) s += val[p] * x[col[p]]
    y[i] = s
  }
}

export function dot(a: Vec, b: Vec): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

export function norm2(a: Vec): number {
  return Math.sqrt(dot(a, a))
}

export interface CGResult {
  x: Vec
  iterations: number
  residual: number
  converged: boolean
}

/**
 * Solve K·u = f for a symmetric-positive-definite K, with homogeneous Dirichlet
 * constraints applied implicitly: DOFs where `free[i] === 0` are clamped to 0.
 *
 * This is a Jacobi (diagonal) preconditioned conjugate gradient. Because the
 * search directions and residual are masked to the free DOFs, the iteration
 * solves exactly the reduced system K_ff·u_f = f_f without ever forming it.
 */
export function solveCG(
  A: CSR,
  f: Vec,
  free: Uint8Array,
  opts: { tol?: number; maxIter?: number } = {},
): CGResult {
  const n = A.n
  const tol = opts.tol ?? 1e-10
  const maxIter = opts.maxIter ?? Math.max(1000, 20 * n)

  const x = new Float64Array(n)
  const r = new Float64Array(n)
  const z = new Float64Array(n)
  const p = new Float64Array(n)
  const Ap = new Float64Array(n)

  // Inverse diagonal preconditioner, zeroed on constrained DOFs.
  const invDiag = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    invDiag[i] = free[i] && A.diag[i] !== 0 ? 1 / A.diag[i] : 0
  }

  // r0 = f - A·x0, with x0 = 0, then masked to free DOFs.
  let bnorm = 0
  for (let i = 0; i < n; i++) {
    r[i] = free[i] ? f[i] : 0
    bnorm += r[i] * r[i]
  }
  bnorm = Math.sqrt(bnorm)
  if (bnorm === 0) return { x, iterations: 0, residual: 0, converged: true }

  for (let i = 0; i < n; i++) {
    z[i] = invDiag[i] * r[i]
    p[i] = z[i]
  }
  let rz = dot(r, z)

  let iter = 0
  let residual = norm2(r) / bnorm
  for (; iter < maxIter; iter++) {
    matVec(A, p, Ap)
    for (let i = 0; i < n; i++) if (!free[i]) Ap[i] = 0 // clamp fixed rows
    const pAp = dot(p, Ap)
    if (pAp <= 0) break // loss of positive-definiteness (singular / mechanism)
    const alpha = rz / pAp
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i]
      r[i] -= alpha * Ap[i]
    }
    residual = norm2(r) / bnorm
    if (residual < tol) {
      iter++
      break
    }
    for (let i = 0; i < n; i++) z[i] = invDiag[i] * r[i]
    const rzNew = dot(r, z)
    const beta = rzNew / rz
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i]
    rz = rzNew
  }

  return { x, iterations: iter, residual, converged: residual < tol }
}

// --- Dense LDLᵀ, used only by the validation harness as an independent check ---

/** Solve A·x = b for a small dense symmetric matrix via LDLᵀ factorisation. */
export function solveDenseLDL(A: number[][], b: number[]): number[] {
  const n = A.length
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  const D = new Array(n).fill(0)
  for (let j = 0; j < n; j++) {
    let dj = A[j][j]
    for (let k = 0; k < j; k++) dj -= L[j][k] * L[j][k] * D[k]
    D[j] = dj
    L[j][j] = 1
    for (let i = j + 1; i < n; i++) {
      let s = A[i][j]
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k] * D[k]
      L[i][j] = dj !== 0 ? s / dj : 0
    }
  }
  // Forward solve L·y = b
  const y = new Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    let s = b[i]
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k]
    y[i] = s
  }
  // Diagonal solve D·z = y
  const z = y.map((yi, i) => (D[i] !== 0 ? yi / D[i] : 0))
  // Back solve Lᵀ·x = z
  const x = new Array(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let s = z[i]
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]
    x[i] = s
  }
  return x
}
