// Compressed sensing — recovering a sparse signal from far below the Nyquist rate.
//
// The rest of the lab preaches Nyquist: to pin down a signal you need two samples
// per period. Compressed sensing (Candès–Romberg–Tao, Donoho, 2006) is the
// beautiful heresy that overturns it. If a length-N signal x is *sparse* — only
// k ≪ N of its coefficients in some basis Ψ are non-zero — then a mere
// m = O(k·log(N/k)) linear measurements y = A·x are enough to recover x *exactly*,
// provided you reconstruct with an ℓ₁ program instead of the naive ℓ₂ one:
//
//     minimise ½‖A·Ψ·s − y‖²₂ + λ‖s‖₁,    then   x̂ = Ψ·s.
//
// The ℓ₁ penalty is the convex surrogate for "count the non-zeros" (ℓ₀); its
// corners sit on the axes, so the minimiser is *sparse*, and — miraculously —
// equal to the true signal well below Nyquist. The min-ℓ₂ ("least energy")
// solution, by contrast, spreads the answer over every coordinate and never
// recovers a spike train.
//
// Everything here is real-valued and matrix-based for legibility: the sparsifying
// bases and the sensing operator are explicit matrices, so the composite operator
// B = A·Ψ is one matrix and every solver reads exactly like its textbook form.
// N and m stay small (≤ 256), so the O(m·N) products are cheap.

// ---------------------------------------------------------------------------
// Seeded randomness — deterministic so a scene reproduces from its controls.
// ---------------------------------------------------------------------------

/** mulberry32: a tiny, fast, well-distributed 32-bit PRNG. */
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

/** A standard normal draw from a uniform generator (Box–Muller). */
export function gaussian(rng: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** A random size-`count` subset of {0…n−1} (sorted), drawn without replacement. */
export function randomSubset(n: number, count: number, rng: () => number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i)
  const c = Math.max(0, Math.min(n, count))
  for (let i = 0; i < c; i++) {
    const j = i + Math.floor(rng() * (n - i))
    const t = idx[i]
    idx[i] = idx[j]
    idx[j] = t
  }
  return idx.slice(0, c).sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// Dense matrices, row-major in a flat Float64Array. Small linear algebra.
// ---------------------------------------------------------------------------

/** y = A·x, where A is `rows`×`cols` row-major. */
export function matVec(A: Float64Array, x: Float64Array, rows: number, cols: number): Float64Array {
  const y = new Float64Array(rows)
  for (let i = 0; i < rows; i++) {
    let s = 0
    const base = i * cols
    for (let j = 0; j < cols; j++) s += A[base + j] * x[j]
    y[i] = s
  }
  return y
}

/** z = Aᵀ·y, where A is `rows`×`cols` row-major (result length `cols`). */
export function matTVec(A: Float64Array, y: Float64Array, rows: number, cols: number): Float64Array {
  const z = new Float64Array(cols)
  for (let i = 0; i < rows; i++) {
    const yi = y[i]
    if (yi === 0) continue
    const base = i * cols
    for (let j = 0; j < cols; j++) z[j] += A[base + j] * yi
  }
  return z
}

/** C = A·Bᵀ, with A `rows`×`N` and B `k`×`N` (both row-major); C is `rows`×`k`. */
export function matMulByT(A: Float64Array, B: Float64Array, rows: number, k: number, N: number): Float64Array {
  const C = new Float64Array(rows * k)
  for (let i = 0; i < rows; i++) {
    const ai = i * N
    for (let j = 0; j < k; j++) {
      const bj = j * N
      let s = 0
      for (let l = 0; l < N; l++) s += A[ai + l] * B[bj + l]
      C[i * k + j] = s
    }
  }
  return C
}

// ---------------------------------------------------------------------------
// Orthonormal sparsifying bases Ψ, as explicit N×N matrices whose rows are the
// forward-transform basis functions (s = M·x). Because M is orthonormal the
// inverse is simply the transpose: x = Mᵀ·s.
// ---------------------------------------------------------------------------

export type BasisKind = 'spike' | 'dct' | 'fourier'

export const BASES: { id: BasisKind; label: string }[] = [
  { id: 'spike', label: 'Spikes (identity)' },
  { id: 'dct', label: 'Cosine (DCT)' },
  { id: 'fourier', label: 'Fourier (sines)' },
]

/** Orthonormal DCT-II matrix, row k(n) = c(k)·√(2/N)·cos(π(2n+1)k / 2N). */
function dctMatrix(N: number): Float64Array {
  const M = new Float64Array(N * N)
  const s0 = Math.sqrt(1 / N)
  const s = Math.sqrt(2 / N)
  for (let k = 0; k < N; k++) {
    const scale = k === 0 ? s0 : s
    for (let n = 0; n < N; n++) M[k * N + n] = scale * Math.cos((Math.PI * (2 * n + 1) * k) / (2 * N))
  }
  return M
}

/**
 * A real orthonormal Fourier basis of size N: a DC row, then cos/sin pairs at each
 * frequency (and a lone cos row at Nyquist when N is even). Orthonormal, so its
 * transpose inverts it exactly — the real cousin of the DFT.
 */
function realFourierMatrix(N: number): Float64Array {
  const rows: Float64Array[] = []
  const push = (fn: (n: number) => number, norm: number) => {
    const r = new Float64Array(N)
    for (let n = 0; n < N; n++) r[n] = norm * fn(n)
    rows.push(r)
  }
  push(() => 1, Math.sqrt(1 / N)) // DC
  const half = Math.floor(N / 2)
  for (let f = 1; f < half; f++) {
    const w = (2 * Math.PI * f) / N
    push((n) => Math.cos(w * n), Math.sqrt(2 / N))
    push((n) => Math.sin(w * n), Math.sqrt(2 / N))
  }
  if (N % 2 === 0) {
    push((n) => Math.cos(Math.PI * n), Math.sqrt(1 / N)) // Nyquist
  } else {
    // odd N: one extra cos/sin pair fills the count to N.
    const f = half
    const w = (2 * Math.PI * f) / N
    push((n) => Math.cos(w * n), Math.sqrt(2 / N))
    push((n) => Math.sin(w * n), Math.sqrt(2 / N))
  }
  const M = new Float64Array(N * N)
  for (let k = 0; k < N; k++) M.set(rows[k], k * N)
  return M
}

/** Build the forward-transform matrix M for a basis (identity for spikes). */
export function basisMatrix(kind: BasisKind, N: number): Float64Array {
  if (kind === 'dct') return dctMatrix(N)
  if (kind === 'fourier') return realFourierMatrix(N)
  const I = new Float64Array(N * N)
  for (let i = 0; i < N; i++) I[i * N + i] = 1
  return I
}

/** Synthesise the signal x = Mᵀ·s from its sparse coefficient vector s. */
export function synthesize(M: Float64Array, s: Float64Array, N: number): Float64Array {
  return matTVec(M, s, N, N)
}

// ---------------------------------------------------------------------------
// Sensing operators A (m×N). Two canonical choices from the CS literature.
// ---------------------------------------------------------------------------

export type OperatorKind = 'gaussian' | 'fourier' | 'dct'

export const OPERATORS: { id: OperatorKind; label: string }[] = [
  { id: 'gaussian', label: 'Gaussian random' },
  { id: 'fourier', label: 'Random Fourier rows' },
  { id: 'dct', label: 'Random cosine rows' },
]

export interface SensingSetup {
  A: Float64Array // m×N measurement matrix
  m: number
  N: number
  rows?: number[] // selected transform rows (partial-orthobasis operators)
}

/** Build the m×N sensing matrix A for a given operator kind. */
export function buildOperator(kind: OperatorKind, m: number, N: number, rng: () => number): SensingSetup {
  if (kind === 'gaussian') {
    const A = new Float64Array(m * N)
    const scale = 1 / Math.sqrt(m) // entries ~ N(0, 1/m): columns are ~unit norm
    for (let i = 0; i < m * N; i++) A[i] = gaussian(rng) * scale
    return { A, m, N }
  }
  // Partial orthobasis: pick m random rows of an orthonormal transform Φ and scale
  // by √(N/m) so the operator is energy-preserving in expectation, like Gaussian.
  const Phi = kind === 'fourier' ? realFourierMatrix(N) : dctMatrix(N)
  const rows = randomSubset(N, m, rng)
  const A = new Float64Array(m * N)
  const scale = Math.sqrt(N / m)
  for (let i = 0; i < m; i++) {
    const src = rows[i] * N
    const dst = i * N
    for (let j = 0; j < N; j++) A[dst + j] = Phi[src + j] * scale
  }
  return { A, m, N, rows }
}

// ---------------------------------------------------------------------------
// A random k-sparse test signal, given a sparsity basis.
// ---------------------------------------------------------------------------

export interface SparseSignal {
  x: Float64Array // the signal (length N)
  s: Float64Array // its sparse coefficients in the basis (length N)
  support: number[] // indices of the non-zeros
}

/** Draw a k-sparse coefficient vector (amplitudes in ±[0.5,1.5]) and synthesise x. */
export function sparseSignal(M: Float64Array, N: number, k: number, rng: () => number): SparseSignal {
  const support = randomSubset(N, Math.max(0, Math.min(N, k)), rng)
  const s = new Float64Array(N)
  for (const i of support) {
    const sign = rng() < 0.5 ? -1 : 1
    s[i] = sign * (0.5 + rng())
  }
  const x = matTVec(M, s, N, N)
  return { x, s, support }
}

// ---------------------------------------------------------------------------
// Solvers. All operate on the composite operator B = A·Ψ = A·Mᵀ (m×N), recovering
// the coefficient vector s; the signal is then x̂ = Mᵀ·ŝ.
// ---------------------------------------------------------------------------

/** Largest eigenvalue of BᵀB (= ‖B‖²₂) by the power method — the Lipschitz const. */
export function powerMethod(B: Float64Array, m: number, N: number, iters = 40, seed = 1): number {
  const rng = mulberry32(seed)
  let v: Float64Array = new Float64Array(N)
  for (let i = 0; i < N; i++) v[i] = gaussian(rng)
  let lambda = 0
  for (let it = 0; it < iters; it++) {
    const Bv = matVec(B, v, m, N)
    const w = matTVec(B, Bv, m, N) // BᵀB v
    let norm = 0
    for (let i = 0; i < N; i++) norm += w[i] * w[i]
    norm = Math.sqrt(norm)
    if (norm < 1e-30) break
    for (let i = 0; i < N; i++) w[i] /= norm
    lambda = norm
    v = w
  }
  return lambda
}

/** Elementwise soft-threshold (the proximal operator of λ‖·‖₁): shrink toward 0. */
export function softThreshold(x: Float64Array, t: number): Float64Array {
  const out = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) {
    const v = x[i]
    if (v > t) out[i] = v - t
    else if (v < -t) out[i] = v + t
    else out[i] = 0
  }
  return out
}

function residualNorm(B: Float64Array, x: Float64Array, y: Float64Array, m: number, N: number): number {
  const Bx = matVec(B, x, m, N)
  let s = 0
  for (let i = 0; i < m; i++) {
    const d = Bx[i] - y[i]
    s += d * d
  }
  return s
}

function l1(x: Float64Array): number {
  let s = 0
  for (let i = 0; i < x.length; i++) s += Math.abs(x[i])
  return s
}

/** Objective of the LASSO / basis-pursuit-denoising program. */
export function lassoObjective(B: Float64Array, x: Float64Array, y: Float64Array, lambda: number, m: number, N: number): number {
  return 0.5 * residualNorm(B, x, y, m, N) + lambda * l1(x)
}

export interface SolveResult {
  x: Float64Array // recovered coefficients
  history: number[] // objective (or residual, for OMP/CGLS) per iteration
  iterations: number
}

/** ISTA — iterative soft-thresholding: a gradient step then a shrink, repeated. */
export function ista(B: Float64Array, y: Float64Array, lambda: number, iters: number, m: number, N: number, step?: number): SolveResult {
  const L = step ?? 1 / Math.max(powerMethod(B, m, N), 1e-12)
  let x: Float64Array = new Float64Array(N)
  const history: number[] = []
  for (let it = 0; it < iters; it++) {
    const Bx = matVec(B, x, m, N)
    for (let i = 0; i < m; i++) Bx[i] -= y[i]
    const grad = matTVec(B, Bx, m, N)
    const z = new Float64Array(N)
    for (let i = 0; i < N; i++) z[i] = x[i] - L * grad[i]
    x = softThreshold(z, L * lambda)
    history.push(lassoObjective(B, x, y, lambda, m, N))
  }
  return { x, history, iterations: iters }
}

/** FISTA — ISTA with Nesterov momentum: the same cost per step, O(1/k²) decay. */
export function fista(B: Float64Array, y: Float64Array, lambda: number, iters: number, m: number, N: number, step?: number): SolveResult {
  const L = step ?? 1 / Math.max(powerMethod(B, m, N), 1e-12)
  let x: Float64Array = new Float64Array(N)
  let z: Float64Array = new Float64Array(N)
  let t = 1
  const history: number[] = []
  for (let it = 0; it < iters; it++) {
    const Bz = matVec(B, z, m, N)
    for (let i = 0; i < m; i++) Bz[i] -= y[i]
    const grad = matTVec(B, Bz, m, N)
    const g = new Float64Array(N)
    for (let i = 0; i < N; i++) g[i] = z[i] - L * grad[i]
    const xNext = softThreshold(g, L * lambda)
    const tNext = (1 + Math.sqrt(1 + 4 * t * t)) / 2
    const zNext = new Float64Array(N)
    const mom = (t - 1) / tNext
    for (let i = 0; i < N; i++) zNext[i] = xNext[i] + mom * (xNext[i] - x[i])
    x = xNext
    z = zNext
    t = tNext
    history.push(lassoObjective(B, x, y, lambda, m, N))
  }
  return { x, history, iterations: iters }
}

/**
 * Solve the small symmetric-positive-definite system G·c = b by Gaussian
 * elimination with partial pivoting (G is `k`×`k`, row-major). Used by OMP.
 */
function solveDense(G: Float64Array, b: Float64Array, k: number): Float64Array {
  const A = Float64Array.from(G)
  const x = Float64Array.from(b)
  for (let col = 0; col < k; col++) {
    let piv = col
    let best = Math.abs(A[col * k + col])
    for (let r = col + 1; r < k; r++) {
      const v = Math.abs(A[r * k + col])
      if (v > best) {
        best = v
        piv = r
      }
    }
    if (best < 1e-12) continue
    if (piv !== col) {
      for (let j = 0; j < k; j++) {
        const t = A[col * k + j]
        A[col * k + j] = A[piv * k + j]
        A[piv * k + j] = t
      }
      const tb = x[col]
      x[col] = x[piv]
      x[piv] = tb
    }
    const diag = A[col * k + col]
    for (let r = 0; r < k; r++) {
      if (r === col) continue
      const f = A[r * k + col] / diag
      if (f === 0) continue
      for (let j = col; j < k; j++) A[r * k + j] -= f * A[col * k + j]
      x[r] -= f * x[col]
    }
  }
  for (let i = 0; i < k; i++) {
    const d = A[i * k + i]
    x[i] = Math.abs(d) < 1e-12 ? 0 : x[i] / d
  }
  return x
}

/**
 * Least squares on a fixed support: solve min‖B_S·c − y‖₂ via the normal
 * equations and scatter the coefficients back into a length-N vector. Shared by
 * OMP (its per-step refit) and the ℓ₁ debiasing pass.
 */
export function leastSquaresOnSupport(B: Float64Array, y: Float64Array, support: number[], m: number, N: number): Float64Array {
  const ks = support.length
  const x = new Float64Array(N)
  if (ks === 0) return x
  const G = new Float64Array(ks * ks)
  const b = new Float64Array(ks)
  for (let a = 0; a < ks; a++) {
    const ca = support[a]
    let by = 0
    for (let i = 0; i < m; i++) by += B[i * N + ca] * y[i]
    b[a] = by
    for (let c = 0; c < ks; c++) {
      const cc = support[c]
      let g = 0
      for (let i = 0; i < m; i++) g += B[i * N + ca] * B[i * N + cc]
      G[a * ks + c] = g
    }
  }
  const coef = solveDense(G, b, ks)
  for (let a = 0; a < ks; a++) x[support[a]] = coef[a]
  return x
}

/**
 * Debias an ℓ₁ estimate: the LASSO penalty shrinks every recovered amplitude, so
 * even a perfectly-identified support reads slightly low. Detect the support the
 * ℓ₁ solver found (relative to its own largest coefficient) and re-fit those
 * amplitudes by plain least squares — the textbook "debiasing" step.
 */
export function debias(B: Float64Array, y: Float64Array, s: Float64Array, m: number, N: number): Float64Array {
  let peak = 0
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(s[i]))
  if (peak === 0) return s
  const thresh = peak * 1e-3
  const support: number[] = []
  for (let i = 0; i < N; i++) if (Math.abs(s[i]) > thresh) support.push(i)
  if (support.length === 0 || support.length >= m) return s
  return leastSquaresOnSupport(B, y, support, m, N)
}

/**
 * OMP — orthogonal matching pursuit: greedily add the column most correlated with
 * the residual, then re-fit *all* chosen columns by least squares. Exact for
 * genuinely sparse signals under enough measurements.
 */
export function omp(B: Float64Array, y: Float64Array, k: number, m: number, N: number, tol = 1e-9): SolveResult {
  const support: number[] = []
  const inSupport = new Uint8Array(N)
  let residual: Float64Array = Float64Array.from(y)
  const history: number[] = []
  const maxAtoms = Math.min(k, m, N)
  const x = new Float64Array(N)
  for (let step = 0; step < maxAtoms; step++) {
    const corr = matTVec(B, residual, m, N)
    let best = -1
    let bestVal = tol
    for (let j = 0; j < N; j++) {
      if (inSupport[j]) continue
      const a = Math.abs(corr[j])
      if (a > bestVal) {
        bestVal = a
        best = j
      }
    }
    if (best < 0) break
    support.push(best)
    inSupport[best] = 1
    // Re-fit *all* chosen columns by least squares (the "orthogonal" in OMP).
    const fit = leastSquaresOnSupport(B, y, support, m, N)
    x.set(fit)
    residual = matVec(B, x, m, N)
    for (let i = 0; i < m; i++) residual[i] = y[i] - residual[i]
    let rn = 0
    for (let i = 0; i < m; i++) rn += residual[i] * residual[i]
    history.push(Math.sqrt(rn))
    if (rn < tol) break
  }
  return { x, history, iterations: history.length }
}

/**
 * CGLS — conjugate gradients on the normal equations, started at 0, converges to
 * the **minimum-ℓ₂-norm** least-squares solution. This is the honest ℓ₂ baseline:
 * it spreads energy across every coordinate and never recovers a spike train.
 */
export function cgls(B: Float64Array, y: Float64Array, iters: number, m: number, N: number): SolveResult {
  const x = new Float64Array(N)
  const r = Float64Array.from(y) // r = y − Bx, x=0
  const p = matTVec(B, r, m, N) // p = Bᵀr
  let gamma = 0
  for (let i = 0; i < N; i++) gamma += p[i] * p[i]
  const history: number[] = []
  for (let it = 0; it < iters; it++) {
    if (gamma < 1e-24) break
    const q = matVec(B, p, m, N)
    let qq = 0
    for (let i = 0; i < m; i++) qq += q[i] * q[i]
    if (qq < 1e-30) break
    const alpha = gamma / qq
    for (let i = 0; i < N; i++) x[i] += alpha * p[i]
    for (let i = 0; i < m; i++) r[i] -= alpha * q[i]
    const sNext = matTVec(B, r, m, N)
    let gNext = 0
    for (let i = 0; i < N; i++) gNext += sNext[i] * sNext[i]
    const beta = gNext / gamma
    for (let i = 0; i < N; i++) p[i] = sNext[i] + beta * p[i]
    gamma = gNext
    let rn = 0
    for (let i = 0; i < m; i++) rn += r[i] * r[i]
    history.push(Math.sqrt(rn))
  }
  return { x, history, iterations: history.length }
}

// ---------------------------------------------------------------------------
// High-level recovery: build everything, sense, solve, and report.
// ---------------------------------------------------------------------------

export type SolverKind = 'fista' | 'ista' | 'omp' | 'l2'

export const SOLVERS: { id: SolverKind; label: string }[] = [
  { id: 'fista', label: 'FISTA (ℓ₁, fast)' },
  { id: 'ista', label: 'ISTA (ℓ₁)' },
  { id: 'omp', label: 'OMP (greedy)' },
  { id: 'l2', label: 'Min-ℓ₂ (baseline)' },
]

export interface RecoverConfig {
  N: number
  k: number
  m: number
  basis: BasisKind
  operator: OperatorKind
  solver: SolverKind
  lambda: number
  iterations: number
  noise: number
  seed: number
}

export interface RecoverResult {
  x: Float64Array // true signal
  xHat: Float64Array // recovered signal
  sTrue: Float64Array // true coefficients
  sHat: Float64Array // recovered coefficients
  y: Float64Array // the m measurements
  support: number[] // true support
  history: number[] // solver convergence trace
  relError: number // ‖x̂−x‖ / ‖x‖
  exact: boolean // recovered to within tolerance
  measRatio: number // m / N
  supportRecall: number // fraction of true atoms recovered
  supportPrecision: number
  operatorRows?: number[]
}

const EXACT_TOL = 1e-2

function relL2(a: Float64Array, b: Float64Array): number {
  let num = 0
  let den = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    num += d * d
    den += b[i] * b[i]
  }
  return Math.sqrt(num / Math.max(den, 1e-30))
}

export interface CSProblem {
  M: Float64Array // sparsifying basis (forward transform, N×N)
  B: Float64Array // composite operator A·Mᵀ (m×N), acting on coefficients
  y: Float64Array // measurements (length m)
  x: Float64Array // true signal (length N)
  sTrue: Float64Array // true coefficients (length N)
  support: number[]
  operatorRows?: number[]
}

/** Build a deterministic CS problem (signal, operator, measurements) from a config. */
export function buildProblem(cfg: RecoverConfig): CSProblem {
  const { N, k, m, basis, operator, noise, seed } = cfg
  const rng = mulberry32(seed)
  const M = basisMatrix(basis, N)
  const sig = sparseSignal(M, N, k, rng)
  const setup = buildOperator(operator, m, N, rng)
  // y = A·x  (+ noise). B = A·Mᵀ operates on coefficients: B·s = A·(Mᵀs) = A·x.
  const y = matVec(setup.A, sig.x, m, N)
  if (noise > 0) {
    let energy = 0
    for (let i = 0; i < m; i++) energy += y[i] * y[i]
    const rms = Math.sqrt(energy / Math.max(m, 1))
    for (let i = 0; i < m; i++) y[i] += gaussian(rng) * noise * rms
  }
  const B = matMulByT(setup.A, M, m, N, N) // A · Mᵀ
  return { M, B, y, x: sig.x, sTrue: sig.s, support: sig.support, operatorRows: setup.rows }
}

/** Run the whole compressed-sensing pipeline for a configuration. */
export function recover(cfg: RecoverConfig): RecoverResult {
  const { N, k, m, solver, lambda, iterations, noise } = cfg
  const prob = buildProblem(cfg)
  const { M, B, y } = prob

  let res: SolveResult
  let sHat: Float64Array
  if (solver === 'omp') {
    res = omp(B, y, Math.max(k, 1), m, N)
    sHat = res.x
  } else if (solver === 'l2') {
    res = cgls(B, y, iterations, m, N)
    sHat = res.x
  } else {
    res = solver === 'ista' ? ista(B, y, lambda, iterations, m, N) : fista(B, y, lambda, iterations, m, N)
    // Debias the ℓ₁ estimate so a correctly-identified support reads exactly.
    sHat = noise > 0 ? res.x : debias(B, y, res.x, m, N)
  }

  const xHat = matTVec(M, sHat, N, N)
  const relError = relL2(xHat, prob.x)

  // Support recovery: compare the true support against the k largest |ŝ|.
  const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => Math.abs(sHat[b]) - Math.abs(sHat[a]))
  const estSupport = new Set(order.slice(0, prob.support.length).filter((i) => Math.abs(sHat[i]) > 1e-6))
  let hits = 0
  for (const i of prob.support) if (estSupport.has(i)) hits++
  const supportRecall = prob.support.length ? hits / prob.support.length : 1
  const supportPrecision = estSupport.size ? hits / estSupport.size : 1

  return {
    x: prob.x,
    xHat,
    sTrue: prob.sTrue,
    sHat,
    y,
    support: prob.support,
    history: res.history,
    relError,
    exact: relError < EXACT_TOL,
    measRatio: m / N,
    supportRecall,
    supportPrecision,
    operatorRows: prob.operatorRows,
  }
}

// ---------------------------------------------------------------------------
// The Donoho–Tanner phase transition: for a grid of (sparsity k, measurements m),
// the fraction of random instances recovered exactly by ℓ₁. A sharp diagonal
// ridge separates "always recovers" from "never" — the signature result of CS.
// ---------------------------------------------------------------------------

export interface PhaseConfig {
  N: number
  basis: BasisKind
  operator: OperatorKind
  solver: SolverKind
  mSteps: number
  kSteps: number
  trials: number
  iterations: number
  lambda: number
  seed: number
}

export interface PhaseResult {
  field: Float64Array // kSteps (rows) × mSteps (cols), success fraction in [0,1]
  mVals: number[] // measurement counts along the columns
  kVals: number[] // sparsity counts along the rows
  N: number
}

/** Sweep (k, m) and record the empirical exact-recovery fraction of ℓ₁ recovery. */
export function phaseTransition(cfg: PhaseConfig): PhaseResult {
  const { N, basis, operator, solver, mSteps, kSteps, trials, iterations, lambda } = cfg
  const mVals: number[] = []
  const kVals: number[] = []
  for (let c = 0; c < mSteps; c++) mVals.push(Math.max(1, Math.round(((c + 1) / mSteps) * N)))
  for (let r = 0; r < kSteps; r++) kVals.push(Math.max(1, Math.round(((r + 1) / kSteps) * (N * 0.5))))
  const field = new Float64Array(kSteps * mSteps)
  let seedCtr = cfg.seed >>> 0
  for (let c = 0; c < mSteps; c++) {
    const m = mVals[c]
    for (let r = 0; r < kSteps; r++) {
      const k = Math.min(kVals[r], m) // k > m is hopeless; clamp for a clean plot
      let success = 0
      for (let t = 0; t < trials; t++) {
        seedCtr = (seedCtr + 0x9e3779b9) >>> 0
        const rng = mulberry32(seedCtr)
        const Mb = basisMatrix(basis, N)
        const sig = sparseSignal(Mb, N, k, rng)
        const setup = buildOperator(operator, m, N, rng)
        const y = matVec(setup.A, sig.x, m, N)
        const B = matMulByT(setup.A, Mb, m, N, N)
        let sHat: Float64Array
        if (solver === 'omp') sHat = omp(B, y, Math.max(k, 1), m, N).x
        else sHat = debias(B, y, fista(B, y, lambda, iterations, m, N).x, m, N)
        const xHat = matTVec(Mb, sHat, N, N)
        if (relL2(xHat, sig.x) < EXACT_TOL) success++
      }
      field[r * mSteps + c] = success / trials
    }
  }
  return { field, mVals, kVals, N }
}
