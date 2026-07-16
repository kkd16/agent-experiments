// Exact linear algebra over the rationals. Unbounded reachability probabilities in a DTMC are the
// unique solution of a linear system (I − P)x = b restricted to the "maybe" states; solved here by
// Gauss–Jordan elimination in exact BigInt fractions, the probabilities come out as exact rationals.
// Small dense systems only (one variable per uncertain state), so a plain O(n³) elimination is ample.

import type { Frac } from './frac.ts'
import { F0, F1, fadd, fdiv, fisZero, fmul, fneg, fsub } from './frac.ts'

/**
 * Solve A·x = b exactly. `A` is n×n (row-major), `b` length n. Returns the solution vector, or `null`
 * if the matrix is singular (no unique solution). Uses full elimination with the first non-zero pivot
 * in each column — exact arithmetic needs no numerical pivoting for stability, only a non-zero pivot.
 */
export function solve(A: Frac[][], b: Frac[]): Frac[] | null {
  const n = b.length
  // Work on augmented copies so the caller's matrices are untouched.
  const M = A.map((row) => row.slice())
  const y = b.slice()

  for (let col = 0; col < n; col++) {
    // Find a pivot row at or below `col` with a non-zero entry in this column.
    let pivot = -1
    for (let r = col; r < n; r++) {
      if (!fisZero(M[r][col])) {
        pivot = r
        break
      }
    }
    if (pivot === -1) return null // singular
    if (pivot !== col) {
      ;[M[pivot], M[col]] = [M[col], M[pivot]]
      ;[y[pivot], y[col]] = [y[col], y[pivot]]
    }
    // Normalise the pivot row so M[col][col] = 1.
    const inv = fdiv(F1, M[col][col])
    for (let c = col; c < n; c++) M[col][c] = fmul(M[col][c], inv)
    y[col] = fmul(y[col], inv)
    // Eliminate this column from every other row.
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const factor = M[r][col]
      if (fisZero(factor)) continue
      for (let c = col; c < n; c++) M[r][c] = fsub(M[r][c], fmul(factor, M[col][c]))
      y[r] = fsub(y[r], fmul(factor, y[col]))
    }
  }
  return y
}

/** The residual A·x − b, exact; every entry is 0 iff x truly solves the system (used by the self-test). */
export function residual(A: Frac[][], x: Frac[], b: Frac[]): Frac[] {
  const n = b.length
  const out: Frac[] = []
  for (let r = 0; r < n; r++) {
    let acc = F0
    for (let c = 0; c < n; c++) acc = fadd(acc, fmul(A[r][c], x[c]))
    out.push(fsub(acc, b[r]))
  }
  return out
}

/** Identity minus the given sub-matrix, `I − P`. Convenience for the reachability system. */
export function iMinus(P: Frac[][]): Frac[][] {
  return P.map((row, r) => row.map((v, c) => (r === c ? fsub(F1, v) : fneg(v))))
}
