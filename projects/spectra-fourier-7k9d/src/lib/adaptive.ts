// Adaptive filtering — from scratch, no libraries.
//
// An adaptive FIR filter learns its own M taps from data by driving a running
// error e[n] = d[n] − wᵀu[n] toward zero, where u[n] = [x[n], x[n−1], …, x[n−M+1]]
// is the tap-delay-line regressor. Three learning rules are implemented and pitted
// against the one they all chase — the Wiener / least-squares optimum wₒ that solves
// the normal equations R·wₒ = p (R = Σ u uᵀ, p = Σ u d). The whole point of the
// mode is that LMS, NLMS and RLS are just different *paths* to that same fixed point:
// they converge to it at different speeds, and the speed depends — for the gradient
// rules — on the eigenvalue spread of R.
//
// Everything here is real-valued and array-based so each line reads like its
// textbook form (Haykin, *Adaptive Filter Theory*; Widrow & Stearns).

// ---------------------------------------------------------------------------
// Deterministic randomness (so every trial and self-test is reproducible).
// ---------------------------------------------------------------------------

/** A tiny, fast, seedable PRNG. Same seed ⇒ same stream, in every browser. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Box–Muller standard normal from a uniform generator. */
export function gaussian(rng: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// ---------------------------------------------------------------------------
// Small dense linear algebra for the M×M normal equations (M is modest, ≲ 64).
// ---------------------------------------------------------------------------

/** dot product of two equal-length vectors. */
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/**
 * Solve a symmetric positive-(semi)definite system A·x = b by Cholesky
 * factorisation A = L·Lᵀ, with a tiny adaptive ridge if A is only semidefinite
 * (rank-deficient regressors). Returns x. A is not modified.
 */
export function choleskySolve(A: number[][], b: number[]): number[] {
  const n = b.length
  // Trace-scaled jitter keeps a singular Gram matrix invertible without perturbing
  // a well-conditioned one meaningfully.
  let trace = 0
  for (let i = 0; i < n; i++) trace += A[i][i]
  const ridge = (trace / Math.max(1, n)) * 1e-12 + 1e-30
  for (let attempt = 0; attempt < 6; attempt++) {
    const jitter = ridge * Math.pow(10, attempt) * (attempt === 0 ? 0 : 1)
    const L = choleskyFactor(A, jitter)
    if (L) return choleskyBackSolve(L, b)
  }
  // Last resort: heavier ridge so we always return *something* finite.
  const L = choleskyFactor(A, ridge * 1e6)
  return L ? choleskyBackSolve(L, b) : b.slice()
}

function choleskyFactor(A: number[][], jitter: number): number[][] | null {
  const n = A.length
  const L: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j]
      if (i === j) sum += jitter
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k]
      if (i === j) {
        if (sum <= 0) return null
        L[i][j] = Math.sqrt(sum)
      } else {
        L[i][j] = sum / L[j][j]
      }
    }
  }
  return L
}

function choleskyBackSolve(L: number[][], b: number[]): number[] {
  const n = b.length
  const y = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    let s = b[i]
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k]
    y[i] = s / L[i][i]
  }
  const x = new Array<number>(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]
    x[i] = s / L[i][i]
  }
  return x
}

// ---------------------------------------------------------------------------
// The Wiener / least-squares optimum — the target every adaptive rule chases.
// ---------------------------------------------------------------------------

export interface WienerSolution {
  /** Optimal taps wₒ solving R·wₒ = p. */
  w: Float64Array
  /** Sample autocorrelation matrix R = Σ u uᵀ / N (the M×M Gram matrix). */
  R: number[][]
  /** Cross-correlation p = Σ u·d / N. */
  p: number[]
  /** Minimum mean-square error Jmin = σ_d² − pᵀwₒ. */
  jmin: number
  /** Eigenvalues of R (ascending), for the eigenvalue-spread story. */
  eigs: number[]
  /** Condition number λmax / λmin of R — LMS convergence time scales with it. */
  spread: number
}

/**
 * Assemble and solve the finite-data normal equations for an M-tap filter mapping
 * x → d. This is the exact least-squares (equivalently, sample-Wiener) solution:
 * the best any FIR filter of this length can do on this data, and the fixed point
 * of every adaptive rule below.
 */
export function wienerSolution(
  x: ArrayLike<number>,
  d: ArrayLike<number>,
  M: number,
): WienerSolution {
  const N = x.length
  const R: number[][] = Array.from({ length: M }, () => new Array<number>(M).fill(0))
  const p = new Array<number>(M).fill(0)
  let dEnergy = 0
  let count = 0
  const u = new Float64Array(M)
  for (let n = 0; n < N; n++) {
    for (let j = 0; j < M; j++) u[j] = n - j >= 0 ? x[n - j] : 0
    for (let i = 0; i < M; i++) {
      for (let j = i; j < M; j++) R[i][j] += u[i] * u[j]
      p[i] += u[i] * d[n]
    }
    dEnergy += d[n] * d[n]
    count++
  }
  const inv = 1 / Math.max(1, count)
  for (let i = 0; i < M; i++) {
    for (let j = i; j < M; j++) {
      R[i][j] *= inv
      R[j][i] = R[i][j]
    }
    p[i] *= inv
  }
  const w = Float64Array.from(choleskySolve(R, p))
  const sigmaD = dEnergy * inv
  const jmin = Math.max(0, sigmaD - dot(p, w))
  const eigs = symmetricEigenvalues(R)
  const lo = eigs[0]
  const hi = eigs[eigs.length - 1]
  const spread = lo > 1e-14 ? hi / lo : Infinity
  return { w, R, p, jmin, eigs, spread }
}

/**
 * All eigenvalues of a small symmetric matrix by the cyclic Jacobi rotation
 * method — robust and dependency-free. Returned ascending.
 */
export function symmetricEigenvalues(Ain: number[][]): number[] {
  const n = Ain.length
  const A = Ain.map((row) => row.slice())
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q]
    if (off < 1e-24) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-300) continue
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q])
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < n; k++) {
          const akp = A[k][p]
          const akq = A[k][q]
          A[k][p] = c * akp - s * akq
          A[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k]
          const aqk = A[q][k]
          A[p][k] = c * apk - s * aqk
          A[q][k] = s * apk + c * aqk
        }
      }
    }
  }
  const eigs = new Array<number>(n)
  for (let i = 0; i < n; i++) eigs[i] = A[i][i]
  eigs.sort((a, b) => a - b)
  return eigs
}

// ---------------------------------------------------------------------------
// The adaptive rules.
// ---------------------------------------------------------------------------

export type Algorithm = 'lms' | 'nlms' | 'rls'

export const ALGORITHMS: { id: Algorithm; label: string }[] = [
  { id: 'lms', label: 'LMS' },
  { id: 'nlms', label: 'NLMS' },
  { id: 'rls', label: 'RLS' },
]

export interface AdaptParams {
  M: number
  /** LMS step size μ (ignored by RLS). */
  mu: number
  /** RLS forgetting factor λ ∈ (0,1] (ignored by LMS/NLMS). */
  lambda: number
  /** RLS regularisation δ for P(0) = δ⁻¹·I. */
  delta: number
  /** NLMS numerical floor ε. */
  eps: number
  /** Optional leakage γ (leaky-LMS): w ← (1−μγ)w + μ e u. 0 = off. */
  leak?: number
}

export interface AdaptRun {
  /** Final taps. */
  w: Float64Array
  /** A-priori error signal e[n] = d[n] − wᵀu[n]. */
  e: Float64Array
  /** Filter output y[n] = wᵀu[n]. */
  y: Float64Array
  /** Instantaneous squared error e[n]². */
  se: Float64Array
  /** Optional tap snapshots over time (for trajectory plots). */
  wHist?: Float64Array[]
}

/**
 * Run one adaptive filter over a stream. A single, shared driver keeps the three
 * rules honest — they differ only in how the tap update is formed.
 */
export function adaptRun(
  x: ArrayLike<number>,
  d: ArrayLike<number>,
  algo: Algorithm,
  params: AdaptParams,
  snapshots = 0,
): AdaptRun {
  const N = x.length
  const M = params.M
  const w = new Float64Array(M)
  const e = new Float64Array(N)
  const y = new Float64Array(N)
  const se = new Float64Array(N)
  const u = new Float64Array(M)
  const leak = params.leak ?? 0

  // RLS state: inverse correlation matrix P and a scratch vector.
  let P: number[][] | null = null
  if (algo === 'rls') {
    P = Array.from({ length: M }, (_, i) =>
      Array.from({ length: M }, (_, j) => (i === j ? 1 / params.delta : 0)),
    )
  }
  const Pu = new Float64Array(M)
  const k = new Float64Array(M)

  const snapEvery = snapshots > 0 ? Math.max(1, Math.floor(N / snapshots)) : 0
  const wHist: Float64Array[] | undefined = snapshots > 0 ? [] : undefined

  for (let n = 0; n < N; n++) {
    for (let j = 0; j < M; j++) u[j] = n - j >= 0 ? x[n - j] : 0
    // Output and a-priori error (uses taps *before* this step's update).
    let yn = 0
    for (let j = 0; j < M; j++) yn += w[j] * u[j]
    const en = d[n] - yn
    y[n] = yn
    e[n] = en
    se[n] = en * en

    if (algo === 'lms') {
      const g = params.mu * en
      const decay = 1 - params.mu * leak
      for (let j = 0; j < M; j++) w[j] = decay * w[j] + g * u[j]
    } else if (algo === 'nlms') {
      let nrm = params.eps
      for (let j = 0; j < M; j++) nrm += u[j] * u[j]
      const g = (params.mu * en) / nrm
      const decay = 1 - params.mu * leak
      for (let j = 0; j < M; j++) w[j] = decay * w[j] + g * u[j]
    } else {
      // RLS. Pu = P·u ; k = Pu / (λ + uᵀPu) ; w += k·e ; P = (P − k·uᵀP)/λ.
      const p = P!
      for (let i = 0; i < M; i++) {
        let s = 0
        for (let j = 0; j < M; j++) s += p[i][j] * u[j]
        Pu[i] = s
      }
      let denom = params.lambda
      for (let j = 0; j < M; j++) denom += u[j] * Pu[j]
      for (let i = 0; i < M; i++) k[i] = Pu[i] / denom
      for (let i = 0; i < M; i++) w[i] += k[i] * en
      const invL = 1 / params.lambda
      for (let i = 0; i < M; i++) {
        for (let j = 0; j < M; j++) {
          p[i][j] = invL * (p[i][j] - k[i] * Pu[j])
        }
      }
    }

    if (snapEvery && n % snapEvery === 0) wHist!.push(Float64Array.from(w))
  }
  if (wHist) wHist.push(Float64Array.from(w))
  return { w, e, y, se, wHist }
}

/**
 * Ensemble-averaged learning curve J[n] = E[e[n]²], estimated by averaging the
 * squared error over `trials` independent realisations of the problem (fresh noise
 * each time). This is the smooth curve textbooks plot; a single run is far too
 * noisy to read the convergence rate off.
 */
export function learningCurve(
  makeProblem: (seed: number) => { x: Float64Array; d: Float64Array },
  algo: Algorithm,
  params: AdaptParams,
  trials: number,
  baseSeed: number,
): Float64Array {
  let J: Float64Array | null = null
  for (let t = 0; t < trials; t++) {
    const { x, d } = makeProblem(baseSeed + t * 9973)
    const run = adaptRun(x, d, algo, params)
    if (!J) J = new Float64Array(run.se.length)
    for (let n = 0; n < J.length; n++) J[n] += run.se[n]
  }
  if (!J) return new Float64Array(0)
  for (let n = 0; n < J.length; n++) J[n] /= trials
  return J
}

// ---------------------------------------------------------------------------
// Applications — each is a problem generator plus enough metadata to score it.
// ---------------------------------------------------------------------------

export type Application = 'sysid' | 'anc' | 'ale' | 'equalizer'

export const APPLICATIONS: { id: Application; label: string }[] = [
  { id: 'sysid', label: 'System ID' },
  { id: 'anc', label: 'Noise cancel' },
  { id: 'ale', label: 'Line enhancer' },
  { id: 'equalizer', label: 'Equalizer' },
]

/** Filter a signal through an FIR kernel h (full-length causal convolution, trimmed). */
export function firFilter(x: ArrayLike<number>, h: ArrayLike<number>): Float64Array {
  const N = x.length
  const L = h.length
  const y = new Float64Array(N)
  for (let n = 0; n < N; n++) {
    let s = 0
    for (let l = 0; l < L; l++) if (n - l >= 0) s += h[l] * x[n - l]
    y[n] = s
  }
  return y
}

/** A colored-noise generator: AR(1) x[n] = ρ·x[n−1] + √(1−ρ²)·white, unit variance. */
export function coloredNoise(N: number, rho: number, rng: () => number): Float64Array {
  const x = new Float64Array(N)
  const g = Math.sqrt(1 - rho * rho)
  let prev = 0
  for (let n = 0; n < N; n++) {
    const w = gaussian(rng)
    prev = rho * prev + g * w
    x[n] = prev
  }
  return x
}

export interface ProblemConfig {
  app: Application
  N: number
  M: number
  /** Input coloring ρ for system ID (0 = white, → 1 = highly correlated). */
  rho: number
  /** Measurement / channel SNR in dB. */
  snrDb: number
  /** Decorrelation delay Δ for the line enhancer / equalizer. */
  delay: number
  seed: number
}

/** The unknown plant used by System ID — a fixed, seed-independent echo path. */
export function plantResponse(M: number): Float64Array {
  // A short, decaying multipath echo with a sign flip — a recognisable target.
  const base = [0.9, 0.0, -0.5, 0.35, 0.0, 0.28, -0.18, 0.12, 0.0, -0.06]
  const h = new Float64Array(M)
  for (let i = 0; i < M; i++) h[i] = i < base.length ? base[i] : 0
  return h
}

/** The dispersive channel used by the equalizer (Proakis' textbook channel B). */
export const PROAKIS_CHANNEL = [0.304, 0.903, 0.304] as const

export interface Problem {
  x: Float64Array
  d: Float64Array
  /** True target taps, when the application has one (System ID). */
  hTrue?: Float64Array
  /** Clean reference signal to recover (Noise cancel / Line enhancer). */
  clean?: Float64Array
  /** The dispersive channel (Equalizer). */
  channel?: Float64Array
  /** Transmitted symbols (Equalizer), for post-training decision scoring. */
  symbols?: Float64Array
  /** Noise variance that sets the MMSE floor, when known. */
  noiseVar?: number
}

/** Build a fresh realisation of the chosen application for a given seed. */
export function makeProblem(cfg: ProblemConfig, seed: number): Problem {
  const rng = mulberry32(seed >>> 0)
  const { N, M, rho, snrDb, delay } = cfg
  const noiseStd = Math.pow(10, -snrDb / 20)

  if (cfg.app === 'sysid') {
    const hTrue = plantResponse(M)
    const x = coloredNoise(N, rho, rng)
    const clean = firFilter(x, hTrue)
    // Match signal power so the SNR label means what it says.
    let sp = 0
    for (let n = 0; n < N; n++) sp += clean[n] * clean[n]
    sp = Math.sqrt(sp / N) || 1
    const d = new Float64Array(N)
    const nStd = noiseStd * sp
    for (let n = 0; n < N; n++) d[n] = clean[n] + nStd * gaussian(rng)
    return { x, d, hTrue, noiseVar: nStd * nStd }
  }

  if (cfg.app === 'anc') {
    // Clean signal to keep: a two-tone we can hear/see.
    const clean = new Float64Array(N)
    for (let n = 0; n < N; n++) {
      clean[n] = Math.sin(2 * Math.PI * 0.02 * n) + 0.6 * Math.sin(2 * Math.PI * 0.055 * n + 0.7)
    }
    // Reference noise source (white); the primary sensor hears it through an unknown path.
    const ref = new Float64Array(N)
    for (let n = 0; n < N; n++) ref[n] = gaussian(rng)
    const path = [0.8, -0.45, 0.3, 0.0, -0.15, 0.08]
    const leaked = firFilter(ref, path)
    // Scale the leaked noise to a chosen noise-to-signal ratio (snrDb is signal-vs-noise).
    let sp = 0
    let np = 0
    for (let n = 0; n < N; n++) {
      sp += clean[n] * clean[n]
      np += leaked[n] * leaked[n]
    }
    const scale = (Math.sqrt(sp / N) / (Math.sqrt(np / N) || 1)) * Math.pow(10, -snrDb / 20)
    const d = new Float64Array(N)
    for (let n = 0; n < N; n++) d[n] = clean[n] + scale * leaked[n]
    // Reference input is the noise source (plus a whisper of independent sensor noise).
    const x = new Float64Array(N)
    for (let n = 0; n < N; n++) x[n] = ref[n] + 0.01 * gaussian(rng)
    return { x, d, clean }
  }

  if (cfg.app === 'ale') {
    // Narrowband lines buried in broadband noise. x is the delayed copy; d is the
    // signal itself, so the filter can only predict the *correlated* (line) part.
    const sig = new Float64Array(N)
    for (let n = 0; n < N; n++) {
      sig[n] = Math.sin(2 * Math.PI * 0.11 * n) + 0.9 * Math.sin(2 * Math.PI * 0.23 * n + 1.1)
    }
    let sp = 0
    for (let n = 0; n < N; n++) sp += sig[n] * sig[n]
    sp = Math.sqrt(sp / N) || 1
    const nStd = noiseStd * sp
    const u = new Float64Array(N)
    for (let n = 0; n < N; n++) u[n] = sig[n] + nStd * gaussian(rng)
    const d = u
    const x = new Float64Array(N)
    for (let n = 0; n < N; n++) x[n] = n - delay >= 0 ? u[n - delay] : 0
    return { x, d, clean: sig }
  }

  // equalizer
  {
    const channel = Float64Array.from(PROAKIS_CHANNEL)
    const symbols = new Float64Array(N)
    for (let n = 0; n < N; n++) symbols[n] = rng() < 0.5 ? -1 : 1
    const rx = firFilter(symbols, channel)
    let rp = 0
    for (let n = 0; n < N; n++) rp += rx[n] * rx[n]
    const nStd = Math.sqrt(rp / N) * noiseStd
    const x = new Float64Array(N)
    for (let n = 0; n < N; n++) x[n] = rx[n] + nStd * gaussian(rng)
    // Training desired: the transmitted symbol, delayed to align with the peak of
    // the combined channel⊛equalizer response.
    const d = new Float64Array(N)
    for (let n = 0; n < N; n++) d[n] = n - delay >= 0 ? symbols[n - delay] : 0
    return { x, d, channel, symbols, noiseVar: nStd * nStd }
  }
}

// ---------------------------------------------------------------------------
// Scoring helpers used by the UI.
// ---------------------------------------------------------------------------

/** Relative tap misalignment ‖w − h‖² / ‖h‖² in dB (System ID quality). */
export function misalignmentDb(w: ArrayLike<number>, h: ArrayLike<number>): number {
  let num = 0
  let den = 0
  const L = Math.max(w.length, h.length)
  for (let i = 0; i < L; i++) {
    const wi = i < w.length ? w[i] : 0
    const hi = i < h.length ? h[i] : 0
    num += (wi - hi) * (wi - hi)
    den += hi * hi
  }
  return 10 * Math.log10((num + 1e-30) / (den + 1e-30))
}

/** Combined impulse response of channel followed by equalizer, c⊛w. */
export function combinedResponse(channel: ArrayLike<number>, w: ArrayLike<number>): Float64Array {
  const L = channel.length + w.length - 1
  const c = new Float64Array(L)
  for (let i = 0; i < channel.length; i++) {
    for (let j = 0; j < w.length; j++) c[i + j] += channel[i] * w[j]
  }
  return c
}

/** Intersymbol-interference metric: peak-normalised energy in the off-peak taps. */
export function isiDb(combined: ArrayLike<number>): number {
  let peak = 0
  let peakIdx = 0
  for (let i = 0; i < combined.length; i++) {
    if (Math.abs(combined[i]) > peak) {
      peak = Math.abs(combined[i])
      peakIdx = i
    }
  }
  if (peak < 1e-30) return 0
  let off = 0
  for (let i = 0; i < combined.length; i++) if (i !== peakIdx) off += combined[i] * combined[i]
  return 10 * Math.log10((off + 1e-30) / (peak * peak))
}

/** SNR in dB of an estimate ŝ against a clean reference s (signal / error power). */
export function snrDb(est: ArrayLike<number>, clean: ArrayLike<number>, start = 0): number {
  let sp = 0
  let ep = 0
  for (let n = start; n < clean.length; n++) {
    sp += clean[n] * clean[n]
    const err = est[n] - clean[n]
    ep += err * err
  }
  return 10 * Math.log10((sp + 1e-30) / (ep + 1e-30))
}

/** Fraction of post-training symbol decisions that are wrong (Equalizer). */
export function symbolErrorRate(
  y: ArrayLike<number>,
  symbols: ArrayLike<number>,
  delay: number,
  start: number,
): number {
  let errs = 0
  let total = 0
  for (let n = start; n < y.length; n++) {
    const ref = n - delay >= 0 ? symbols[n - delay] : 0
    const dec = y[n] >= 0 ? 1 : -1
    if (dec !== (ref >= 0 ? 1 : -1)) errs++
    total++
  }
  return total > 0 ? errs / total : 0
}

/** LMS stability ceiling μ < 2/λmax (mean-square, tight form uses tr R). */
export function lmsStabilityBound(eigs: number[]): number {
  const hi = eigs[eigs.length - 1]
  return hi > 1e-14 ? 2 / hi : Infinity
}

/**
 * LMS steady-state misadjustment M = J_excess / Jmin. The independence-theory
 * result is M = μ·tr(R) / (2 − μ·tr(R)); it reduces to the familiar μ·tr(R)/2 for
 * a small step, and blows up as μ·tr(R) → 2 (the mean-square stability edge).
 */
export function misadjustment(mu: number, trR: number): number {
  const x = mu * trR
  if (x >= 2) return Infinity
  return x / (2 - x)
}

/** Predicted LMS steady-state MSE, J(∞) = Jmin·(1 + misadjustment). */
export function lmsSteadyStateMse(jmin: number, mu: number, trR: number): number {
  return jmin * (1 + misadjustment(mu, trR))
}
