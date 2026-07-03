// A from-scratch **two-phase primal simplex** for the linear program
//
//     minimize   c · x      subject to   A x ≥ b   (b ≥ 0),   x ≥ 0.
//
// It is deliberately general (any A, b, c) — the WCOJ pillar needs it to solve
// the *fractional edge cover* LP that yields the AGM bound, but nothing here
// knows about joins. Anti-cycling is guaranteed by **Bland's rule** (always
// pick the lowest-index eligible entering/leaving variable), so the method
// terminates on degenerate covers (grids, cliques) without looping.

export type LpStatus = 'optimal' | 'infeasible' | 'unbounded'

export interface LpResult {
  status: LpStatus
  /** The optimal `x` (length = c.length) when `status === 'optimal'`. */
  x: number[]
  /** The optimal objective `c · x`. */
  obj: number
}

const EPS = 1e-9

/**
 * Solve `min c·x s.t. A x ≥ b, x ≥ 0` with `b ≥ 0`. Rows of `A` and entries of
 * `b` must line up; `c` has one entry per structural variable.
 */
export function solveGE(A: number[][], b: number[], c: number[]): LpResult {
  const m = A.length
  const n = c.length
  if (m === 0) return { status: 'optimal', x: new Array(n).fill(0), obj: 0 }
  if (b.some((v) => v < -EPS)) throw new Error('solveGE requires b ≥ 0')

  // Standard form columns:  x (n)  |  surplus s (m, coeff −1)  |  artificial a (m).
  const N = n + 2 * m
  const T: number[][] = []
  for (let i = 0; i < m; i++) {
    const row = new Array(N + 1).fill(0)
    for (let j = 0; j < n; j++) row[j] = A[i][j]
    row[n + i] = -1
    row[n + m + i] = 1
    row[N] = b[i]
    T.push(row)
  }
  const basis: number[] = []
  for (let i = 0; i < m; i++) basis.push(n + m + i) // artificials start basic

  // Run simplex against a given cost row (length N+1; the last cell tracks −obj),
  // restricted to the columns flagged `allowed`. Returns false iff unbounded.
  const run = (cost: number[], allowed: boolean[]): boolean => {
    for (;;) {
      let enter = -1
      for (let j = 0; j < N; j++) {
        if (allowed[j] && cost[j] < -EPS) {
          enter = j
          break // Bland: lowest index
        }
      }
      if (enter === -1) return true // optimal
      let leave = -1
      let best = Infinity
      for (let i = 0; i < m; i++) {
        const a = T[i][enter]
        if (a > EPS) {
          const ratio = T[i][N] / a
          if (
            ratio < best - EPS ||
            (Math.abs(ratio - best) <= EPS && (leave === -1 || basis[i] < basis[leave]))
          ) {
            best = ratio
            leave = i
          }
        }
      }
      if (leave === -1) return false // unbounded
      const pv = T[leave][enter]
      const prow = T[leave]
      for (let j = 0; j <= N; j++) prow[j] /= pv
      for (let i = 0; i < m; i++) {
        if (i === leave) continue
        const f = T[i][enter]
        if (Math.abs(f) < EPS) continue
        const ri = T[i]
        for (let j = 0; j <= N; j++) ri[j] -= f * prow[j]
      }
      const f2 = cost[enter]
      if (Math.abs(f2) > EPS) for (let j = 0; j <= N; j++) cost[j] -= f2 * prow[j]
      basis[leave] = enter
    }
  }

  // ---- Phase 1: minimise the sum of artificials -----------------------------
  const allow1 = new Array(N).fill(true)
  const cost1 = new Array(N + 1).fill(0)
  for (let j = n + m; j < N; j++) cost1[j] = 1
  // Price out the basic artificials so the cost row is in reduced form.
  for (let i = 0; i < m; i++) for (let j = 0; j <= N; j++) cost1[j] -= T[i][j]
  run(cost1, allow1)
  let artSum = 0
  for (let i = 0; i < m; i++) if (basis[i] >= n + m) artSum += T[i][N]
  if (artSum > 1e-6) return { status: 'infeasible', x: [], obj: NaN }

  // ---- Phase 2: minimise c·x, artificials forbidden -------------------------
  const allow2 = new Array(N).fill(true)
  for (let j = n + m; j < N; j++) allow2[j] = false
  const cost2 = new Array(N + 1).fill(0)
  for (let j = 0; j < n; j++) cost2[j] = c[j]
  for (let i = 0; i < m; i++) {
    const bi = basis[i]
    if (bi < n && Math.abs(cost2[bi]) > 1e-12) {
      const f = cost2[bi]
      for (let j = 0; j <= N; j++) cost2[j] -= f * T[i][j]
    }
  }
  if (!run(cost2, allow2)) return { status: 'unbounded', x: [], obj: NaN }

  const x = new Array(n).fill(0)
  for (let i = 0; i < m; i++) if (basis[i] < n) x[basis[i]] = T[i][N]
  let obj = 0
  for (let j = 0; j < n; j++) obj += c[j] * x[j]
  return { status: 'optimal', x, obj }
}
