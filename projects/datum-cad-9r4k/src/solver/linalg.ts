// Minimal dense linear algebra for the solver. The systems here are small
// (a sketch rarely has more than a few hundred parameters), so straightforward
// O(n³) Gaussian elimination with partial pivoting is more than fast enough and
// far easier to trust than anything clever.

// Solve A x = b in place. A is n×n stored row-major; b is length n. Returns the
// solution, or null if the matrix is singular to the given tolerance.
export function solveLinear(A: Float64Array, b: Float64Array, n: number, tol = 1e-12): Float64Array | null {
  // Work on copies so the caller's matrices survive.
  const M = Float64Array.from(A)
  const x = Float64Array.from(b)

  for (let col = 0; col < n; col++) {
    // Partial pivot: find the largest-magnitude entry in this column.
    let pivot = col
    let best = Math.abs(M[col * n + col])
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r * n + col])
      if (v > best) {
        best = v
        pivot = r
      }
    }
    if (best < tol) return null

    if (pivot !== col) {
      for (let k = 0; k < n; k++) {
        const tmp = M[col * n + k]
        M[col * n + k] = M[pivot * n + k]
        M[pivot * n + k] = tmp
      }
      const tb = x[col]
      x[col] = x[pivot]
      x[pivot] = tb
    }

    const diag = M[col * n + col]
    for (let r = col + 1; r < n; r++) {
      const f = M[r * n + col] / diag
      if (f === 0) continue
      for (let k = col; k < n; k++) M[r * n + k] -= f * M[col * n + k]
      x[r] -= f * x[col]
    }
  }

  // Back-substitution.
  for (let row = n - 1; row >= 0; row--) {
    let s = x[row]
    for (let k = row + 1; k < n; k++) s -= M[row * n + k] * x[k]
    x[row] = s / M[row * n + row]
  }
  return x
}

// Numerical rank of an m×n matrix (row-major) via Gauss–Jordan elimination with
// partial pivoting. Used for degree-of-freedom analysis: the rank of the
// constraint Jacobian is the number of independent scalar constraints.
export function matrixRank(J: number[], m: number, n: number, tol = 1e-7): number {
  // Copy into a mutable dense buffer.
  const A: number[] = J.slice()
  let rank = 0
  const rows = m
  const cols = n
  const pivotCols: boolean[] = new Array(cols).fill(false)

  for (let col = 0; col < cols && rank < rows; col++) {
    // Find a pivot in this column at or below `rank`.
    let pivot = -1
    let best = tol
    for (let r = rank; r < rows; r++) {
      const v = Math.abs(A[r * cols + col])
      if (v > best) {
        best = v
        pivot = r
      }
    }
    if (pivot === -1) continue

    // Swap into place.
    if (pivot !== rank) {
      for (let k = 0; k < cols; k++) {
        const tmp = A[rank * cols + k]
        A[rank * cols + k] = A[pivot * cols + k]
        A[pivot * cols + k] = tmp
      }
    }

    const diag = A[rank * cols + col]
    for (let r = 0; r < rows; r++) {
      if (r === rank) continue
      const f = A[r * cols + col] / diag
      if (f === 0) continue
      for (let k = col; k < cols; k++) A[r * cols + k] -= f * A[rank * cols + k]
    }
    pivotCols[col] = true
    rank++
  }
  return rank
}
