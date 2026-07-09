// Adaptive filters & the Kalman filter — the filters that *learn*.
//
// Every other filter in this lab is *fixed*: you state a spec (Design) or pick
// coefficients (Filter) and the response never changes. An **adaptive** filter
// instead starts blind and tunes its own taps from the data, chasing a moving
// target it is only ever shown indirectly — through a "desired" reference d(n).
// At each step the transversal filter forms
//
//     y(n) = wᵀ(n)·x(n),        e(n) = d(n) − y(n),
//
// where x(n) = [u(n), u(n−1), …, u(n−L+1)] is the tapped delay line of the input
// u, and then nudges w to shrink e. The genius is that this *one* mechanism, with
// four different update rules, solves a whole zoo of problems just by *wiring what
// plays the role of u and d*:
//
//   • System identification — u = probe, d = unknown plant's output → w → plant.
//   • Noise cancellation     — u = noise reference, d = signal+noise → e = signal.
//   • Channel equalization   — u = received symbols, d = a delayed clean symbol.
//   • Linear prediction      — u = past samples, d = the present sample.
//
// The four update rules trade compute for convergence speed:
//
//   LMS   (Widrow–Hoff): w ← w + μ·e·x                       — O(L), stochastic gradient.
//   NLMS  (normalised):  w ← w + μ/(ε+‖x‖²)·e·x              — O(L), step-size-robust.
//   APA   (affine proj): reuses the last K regressors        — O(LK+K³), decorrelates input.
//   RLS   (recursive LS): exact least-squares via P = R⁻¹     — O(L²), converges in ~2L steps.
//
// RLS is, exactly, the **Kalman filter** for a random-walk weight vector — so this
// file closes with a genuine 2-state constant-velocity Kalman tracker, the same
// predict/update recursion applied to a physical state instead of filter taps.
//
// Everything is real-valued, allocation-light, and library-free; the matrices
// (RLS's P, Kalman's 2×2 covariance) are carried as flat arrays and updated by the
// textbook recursions.

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

// ---------------------------------------------------------------------------
// Small dense-linear-algebra helpers (kept minimal; used by APA + tests).
// ---------------------------------------------------------------------------

/** Solve the K×K system A·z = b in place by Gaussian elimination with partial
 *  pivoting. A is row-major length K*K; returns the solution z (length K). K is
 *  tiny (the affine-projection order), so O(K³) is free. */
export function solveSmall(A: Float64Array, b: Float64Array, K: number): Float64Array {
  const M = A.slice()
  const x = b.slice()
  for (let col = 0; col < K; col++) {
    // Partial pivot: swap in the row with the largest |pivot|.
    let piv = col
    let best = Math.abs(M[col * K + col])
    for (let r = col + 1; r < K; r++) {
      const v = Math.abs(M[r * K + col])
      if (v > best) {
        best = v
        piv = r
      }
    }
    if (piv !== col) {
      for (let c = 0; c < K; c++) {
        const t = M[col * K + c]
        M[col * K + c] = M[piv * K + c]
        M[piv * K + c] = t
      }
      const t = x[col]
      x[col] = x[piv]
      x[piv] = t
    }
    const d = M[col * K + col] || 1e-12
    for (let r = col + 1; r < K; r++) {
      const f = M[r * K + col] / d
      if (f === 0) continue
      for (let c = col; c < K; c++) M[r * K + c] -= f * M[col * K + c]
      x[r] -= f * x[col]
    }
  }
  // Back-substitution.
  for (let r = K - 1; r >= 0; r--) {
    let s = x[r]
    for (let c = r + 1; c < K; c++) s -= M[r * K + c] * x[c]
    x[r] = s / (M[r * K + r] || 1e-12)
  }
  return x
}

/** Linear convolution y = h * u (full length n_u + n_h − 1). */
export function convolve(u: ArrayLike<number>, h: ArrayLike<number>): Float64Array {
  const nu = u.length
  const nh = h.length
  const y = new Float64Array(nu + nh - 1)
  for (let i = 0; i < nu; i++) {
    const ui = u[i]
    if (ui === 0) continue
    for (let j = 0; j < nh; j++) y[i + j] += ui * h[j]
  }
  return y
}

// ---------------------------------------------------------------------------
// The adaptive transversal filter — one runner, four update rules.
// ---------------------------------------------------------------------------

export type AlgoKind = 'lms' | 'nlms' | 'apa' | 'rls'

export interface AlgoConfig {
  algo: AlgoKind
  L: number // filter length (taps)
  mu: number // step size (LMS/NLMS/APA)
  lambda: number // RLS forgetting factor (0.9…1)
  delta: number // RLS init: P(0) = δ⁻¹·I
  apaOrder: number // APA projection order K (2…8)
  eps: number // NLMS/APA regulariser
}

export interface AdaptiveRun {
  y: Float64Array // filter output y(n)
  e: Float64Array // error e(n) = d(n) − y(n)
  w: Float64Array // final tap weights
  wNormHist: Float64Array // ‖w‖ over time (weight-track energy)
}

/** Run the adaptive filter over paired streams (u, d) of equal length N.
 *  x(n) is the length-L regressor ending at u(n); samples before 0 are zero. */
export function runAdaptive(u: Float64Array, d: Float64Array, cfg: AlgoConfig): AdaptiveRun {
  const N = u.length
  const L = cfg.L
  const w = new Float64Array(L)
  const y = new Float64Array(N)
  const e = new Float64Array(N)
  const wNormHist = new Float64Array(N)
  const x = new Float64Array(L) // current regressor (x[0] = u(n), x[k] = u(n−k))

  // RLS state: inverse correlation matrix P (L×L), only allocated when needed.
  let P: Float64Array | null = null
  if (cfg.algo === 'rls') {
    P = new Float64Array(L * L)
    const p0 = 1 / cfg.delta
    for (let i = 0; i < L; i++) P[i * L + i] = p0
  }

  // APA ring buffer of the last K regressors and desired values.
  const K = Math.max(1, cfg.apaOrder)
  const Xbuf = cfg.algo === 'apa' ? new Float64Array(K * L) : null // row k = regressor age k
  const Dbuf = cfg.algo === 'apa' ? new Float64Array(K) : null

  const Px = new Float64Array(L) // scratch for RLS P·x
  const kGain = new Float64Array(L)

  for (let n = 0; n < N; n++) {
    // Shift the regressor: x[k] = u(n−k).
    for (let k = L - 1; k > 0; k--) x[k] = x[k - 1]
    x[0] = u[n]

    // Filter output and a-priori error.
    let yn = 0
    for (let i = 0; i < L; i++) yn += w[i] * x[i]
    const en = d[n] - yn
    y[n] = yn
    e[n] = en

    switch (cfg.algo) {
      case 'lms': {
        const g = cfg.mu * en
        for (let i = 0; i < L; i++) w[i] += g * x[i]
        break
      }
      case 'nlms': {
        let norm = cfg.eps
        for (let i = 0; i < L; i++) norm += x[i] * x[i]
        const g = (cfg.mu * en) / norm
        for (let i = 0; i < L; i++) w[i] += g * x[i]
        break
      }
      case 'apa': {
        // Push the current regressor + desired into the ring (age 0 = newest).
        for (let k = K - 1; k > 0; k--) {
          Dbuf![k] = Dbuf![k - 1]
          for (let i = 0; i < L; i++) Xbuf![k * L + i] = Xbuf![(k - 1) * L + i]
        }
        Dbuf![0] = d[n]
        for (let i = 0; i < L; i++) Xbuf![i] = x[i]
        // Error vector e_k = d_k − w·x_k for all K stored regressors (a-priori).
        const ev = new Float64Array(K)
        for (let k = 0; k < K; k++) {
          let dot = 0
          for (let i = 0; i < L; i++) dot += w[i] * Xbuf![k * L + i]
          ev[k] = Dbuf![k] - dot
        }
        // Gram matrix G = XᵀX + εI  (K×K, X columns are the regressors).
        const G = new Float64Array(K * K)
        for (let a = 0; a < K; a++) {
          for (let b = a; b < K; b++) {
            let s = 0
            for (let i = 0; i < L; i++) s += Xbuf![a * L + i] * Xbuf![b * L + i]
            if (a === b) s += cfg.eps
            G[a * K + b] = s
            G[b * K + a] = s
          }
        }
        const z = solveSmall(G, ev, K) // z = (XᵀX+εI)⁻¹ e
        // w ← w + μ·X·z
        for (let i = 0; i < L; i++) {
          let s = 0
          for (let k = 0; k < K; k++) s += Xbuf![k * L + i] * z[k]
          w[i] += cfg.mu * s
        }
        break
      }
      case 'rls': {
        const p = P!
        const lam = cfg.lambda
        // Px = P·x
        for (let i = 0; i < L; i++) {
          let s = 0
          for (let j = 0; j < L; j++) s += p[i * L + j] * x[j]
          Px[i] = s
        }
        let denom = lam
        for (let i = 0; i < L; i++) denom += x[i] * Px[i]
        const inv = 1 / denom
        for (let i = 0; i < L; i++) kGain[i] = Px[i] * inv // gain k = Px/(λ+xᵀPx)
        // w ← w + k·e  (a-priori error already computed)
        for (let i = 0; i < L; i++) w[i] += kGain[i] * en
        // P ← (P − k·(Px)ᵀ)/λ
        const invLam = 1 / lam
        for (let i = 0; i < L; i++) {
          const ki = kGain[i]
          for (let j = 0; j < L; j++) {
            p[i * L + j] = (p[i * L + j] - ki * Px[j]) * invLam
          }
        }
        break
      }
    }

    let wn = 0
    for (let i = 0; i < L; i++) wn += w[i] * w[i]
    wNormHist[n] = Math.sqrt(wn)
  }

  return { y, e, w, wNormHist }
}

// ---------------------------------------------------------------------------
// Scenarios — the wiring that turns one runner into four classic applications.
// ---------------------------------------------------------------------------

export type ScenarioKind = 'sysid' | 'anc' | 'equalize' | 'predict'

export interface ScenarioConfig {
  scenario: ScenarioKind
  N: number // number of samples / iterations
  plantLen: number // unknown-plant length (sysid) / echo path (anc)
  color: number // input colouring pole ρ ∈ [0,0.95) — eigenvalue spread for LMS
  snrDb: number // measurement / observation SNR
  freq: number // clean-tone frequency (anc) in cycles/sample
  channel: number // equalizer channel select (0..2)
  arA1: number // predictor AR(2) coefficient a1
  arA2: number // predictor AR(2) coefficient a2
  delay: number // equalizer training delay Δ
}

export interface Scenario {
  u: Float64Array // filter input stream
  d: Float64Array // desired reference
  clean?: Float64Array // ground-truth clean signal (anc / predict display)
  truth?: Float64Array // ground-truth taps to compare w against (sysid / equalize)
  symbols?: Float64Array // transmitted symbols (equalize)
  channelTaps?: Float64Array // channel impulse response (equalize)
  label: string
}

/** An AR(1) colouring filter: e(n) = ρ·e(n−1) + white. ρ→1 makes the input
 *  correlated, widening the eigenvalue spread of R that cripples plain LMS. */
function coloured(N: number, rho: number, rng: () => number): Float64Array {
  const out = new Float64Array(N)
  let prev = 0
  const g = Math.sqrt(1 - rho * rho) // unit-variance normalisation
  for (let n = 0; n < N; n++) {
    prev = rho * prev + g * gaussian(rng)
    out[n] = prev
  }
  return out
}

/** The catalogue of equalizer channels (Proakis-style ISI channels). */
export const EQ_CHANNELS: Float64Array[] = [
  new Float64Array([0.407, 0.815, 0.407]), // Proakis B — mild ISI, spectral null
  new Float64Array([0.227, 0.46, 0.688, 0.46, 0.227]), // Proakis C — deep null, hard
  new Float64Array([1, 0, 0, 0.55]), // sparse multipath echo
]

/** Build a scenario's (u, d) pair and its ground truth. */
export function makeScenario(cfg: ScenarioConfig, seed: number): Scenario {
  const rng = mulberry32(seed >>> 0)
  const N = cfg.N
  const noiseStd = Math.pow(10, -cfg.snrDb / 20)

  switch (cfg.scenario) {
    case 'sysid': {
      // Unknown plant: an exponentially decaying random impulse response.
      const Lp = cfg.plantLen
      const h = new Float64Array(Lp)
      let e2 = 0
      for (let i = 0; i < Lp; i++) {
        h[i] = gaussian(rng) * Math.exp(-i / (Lp * 0.5))
        e2 += h[i] * h[i]
      }
      const nrm = 1 / Math.sqrt(e2)
      for (let i = 0; i < Lp; i++) h[i] *= nrm
      const u = coloured(N, cfg.color, rng)
      const d = new Float64Array(N)
      for (let n = 0; n < N; n++) {
        let s = 0
        for (let i = 0; i < Lp; i++) if (n - i >= 0) s += h[i] * u[n - i]
        d[n] = s + noiseStd * gaussian(rng)
      }
      return { u, d, truth: h, label: 'system identification' }
    }

    case 'anc': {
      // A clean tone corrupted by noise that reaches the primary mic through an
      // unknown acoustic path g; a second mic hears the raw noise (reference).
      const s = new Float64Array(N)
      const w0 = 2 * Math.PI * cfg.freq
      for (let n = 0; n < N; n++) s[n] = Math.sin(w0 * n) + 0.5 * Math.sin(2 * w0 * n)
      const v = new Float64Array(N)
      for (let n = 0; n < N; n++) v[n] = gaussian(rng)
      const g = new Float64Array([0.8, -0.5, 0.3, -0.15]) // room path
      const noiseAtPrimary = convolve(v, g)
      const d = new Float64Array(N) // primary = signal + filtered noise
      const clean = new Float64Array(N)
      for (let n = 0; n < N; n++) {
        clean[n] = s[n]
        d[n] = s[n] + noiseAtPrimary[n] + noiseStd * gaussian(rng)
      }
      // Reference input = the raw noise the second mic hears.
      return { u: v, d, clean, truth: g, label: 'adaptive noise cancellation' }
    }

    case 'equalize': {
      // Random ±1 BPSK symbols through an ISI channel; equalizer inverts it with
      // a training delay Δ so d(n) = a(n−Δ).
      const a = new Float64Array(N)
      for (let n = 0; n < N; n++) a[n] = rng() < 0.5 ? -1 : 1
      const h = EQ_CHANNELS[Math.max(0, Math.min(EQ_CHANNELS.length - 1, cfg.channel))]
      const rx = convolve(a, h) // length N + Lh − 1
      const u = new Float64Array(N)
      for (let n = 0; n < N; n++) u[n] = rx[n] + noiseStd * gaussian(rng)
      const delta = cfg.delay
      const d = new Float64Array(N)
      for (let n = 0; n < N; n++) d[n] = n - delta >= 0 ? a[n - delta] : 0
      return { u, d, symbols: a, channelTaps: h, truth: undefined, label: 'channel equalization' }
    }

    case 'predict': {
      // A narrowband AR(2) process; a one-step forward predictor learns to whiten
      // it. u drives a length-L predictor of the *next* sample.
      const proc = new Float64Array(N)
      let x1 = 0
      let x2 = 0
      const a1 = cfg.arA1
      const a2 = cfg.arA2
      for (let n = 0; n < N; n++) {
        const w = gaussian(rng)
        const val = a1 * x1 + a2 * x2 + w
        proc[n] = val
        x2 = x1
        x1 = val
      }
      // Predict proc(n) from proc(n−1…n−L): feed a one-sample-delayed stream in,
      // desired = the present sample.
      const u = new Float64Array(N)
      for (let n = 0; n < N; n++) u[n] = n >= 1 ? proc[n - 1] : 0
      const truth = new Float64Array([a1, a2]) // ideal predictor taps
      return { u, d: proc, clean: proc, truth, label: 'linear prediction' }
    }
  }
}

// ---------------------------------------------------------------------------
// Metrics.
// ---------------------------------------------------------------------------

/** Power (mean square) of a slice [a, b). */
export function power(x: Float64Array, a = 0, b = x.length): number {
  let s = 0
  for (let i = a; i < b; i++) s += x[i] * x[i]
  return s / Math.max(1, b - a)
}

/** SNR (dB) of `clean` vs the residual `est − clean` over the tail. */
export function snrDbTail(clean: Float64Array, est: Float64Array, frac = 0.5): number {
  const a = Math.floor(clean.length * (1 - frac))
  let sig = 0
  let err = 0
  for (let i = a; i < clean.length; i++) {
    sig += clean[i] * clean[i]
    const dlt = est[i] - clean[i]
    err += dlt * dlt
  }
  return 10 * Math.log10(sig / Math.max(err, 1e-30))
}

/** Normalised misalignment (dB): ‖ŵ − w*‖² / ‖w*‖². */
export function misalignmentDb(wHat: Float64Array, wStar: Float64Array): number {
  let num = 0
  let den = 0
  const L = Math.max(wHat.length, wStar.length)
  for (let i = 0; i < L; i++) {
    const a = i < wHat.length ? wHat[i] : 0
    const b = i < wStar.length ? wStar[i] : 0
    num += (a - b) * (a - b)
    den += b * b
  }
  return 10 * Math.log10(num / Math.max(den, 1e-30))
}

// ---------------------------------------------------------------------------
// Ensemble learning curve — average e²(n) over many independent realisations to
// reveal the mean-square-error convergence (the textbook "learning curve").
// ---------------------------------------------------------------------------

/** Run `algos` on `realisations` independent draws of the scenario and return,
 *  for each algorithm, the ensemble-averaged MSE per iteration in dB. */
export function learningCurves(
  scfg: ScenarioConfig,
  algos: AlgoConfig[],
  realisations: number,
  baseSeed: number,
): { curvesDb: Float64Array[]; iters: number } {
  const N = scfg.N
  const acc = algos.map(() => new Float64Array(N))
  for (let r = 0; r < realisations; r++) {
    const sc = makeScenario(scfg, baseSeed + r * 7919)
    for (let ai = 0; ai < algos.length; ai++) {
      const run = runAdaptive(sc.u, sc.d, algos[ai])
      const a = acc[ai]
      for (let n = 0; n < N; n++) a[n] += run.e[n] * run.e[n]
    }
  }
  const curvesDb = acc.map((a) => {
    const out = new Float64Array(N)
    for (let n = 0; n < N; n++) out[n] = 10 * Math.log10(a[n] / realisations + 1e-30)
    return out
  })
  return { curvesDb, iters: N }
}

// ---------------------------------------------------------------------------
// The Kalman filter — a 2-state constant-velocity tracker.
//
// State  s = [position, velocity]ᵀ.  Model:
//     s(n) = F·s(n−1) + process noise,     F = [[1, dt],[0, 1]]
//     z(n) = H·s(n)   + measurement noise, H = [1, 0]
// Process noise from a random acceleration σa: Q = σa²·[[dt⁴/4, dt³/2],[dt³/2, dt²]].
// The recursion is the same predict/update as RLS, on a 2-D state instead of taps.
// ---------------------------------------------------------------------------

export interface KalmanConfig {
  N: number
  dt: number
  sigmaA: number // process (acceleration) noise std the filter assumes
  sigmaMeas: number // measurement noise std
  trueSigmaA: number // acceleration std actually driving the target
  motion: 'sine' | 'randomwalk'
}

export interface KalmanRun {
  truePos: Float64Array
  trueVel: Float64Array
  meas: Float64Array
  estPos: Float64Array
  estVel: Float64Array
  posStd: Float64Array // √P₀₀ — the 1-σ position uncertainty band
  velStd: Float64Array
  innov: Float64Array // measurement residual z − H·ŝ⁻
  rmseMeas: number
  rmseKalman: number
}

export function runKalman(cfg: KalmanConfig, seed: number): KalmanRun {
  const rng = mulberry32(seed >>> 0)
  const { N, dt } = cfg
  const truePos = new Float64Array(N)
  const trueVel = new Float64Array(N)
  const meas = new Float64Array(N)

  // Simulate the true trajectory.
  let pos = 0
  let vel = 1
  for (let n = 0; n < N; n++) {
    if (cfg.motion === 'sine') {
      // A smooth sinusoidal position; the CV model is a deliberate approximation.
      const t = n * dt
      pos = 6 * Math.sin(0.6 * t)
      vel = 6 * 0.6 * Math.cos(0.6 * t)
    } else {
      const acc = cfg.trueSigmaA * gaussian(rng)
      pos += vel * dt + 0.5 * acc * dt * dt
      vel += acc * dt
    }
    truePos[n] = pos
    trueVel[n] = vel
    meas[n] = pos + cfg.sigmaMeas * gaussian(rng)
  }

  // Kalman recursion — carry the 2×2 covariance P as [p00,p01,p10,p11].
  const estPos = new Float64Array(N)
  const estVel = new Float64Array(N)
  const posStd = new Float64Array(N)
  const velStd = new Float64Array(N)
  const innov = new Float64Array(N)

  let sp = meas[0] // state estimate [pos, vel]
  let sv = 0
  let p00 = 100
  let p01 = 0
  let p10 = 0
  let p11 = 100

  const sa2 = cfg.sigmaA * cfg.sigmaA
  const q00 = (sa2 * dt * dt * dt * dt) / 4
  const q01 = (sa2 * dt * dt * dt) / 2
  const q11 = sa2 * dt * dt
  const R = cfg.sigmaMeas * cfg.sigmaMeas

  for (let n = 0; n < N; n++) {
    // Predict: s⁻ = F·s, P⁻ = F·P·Fᵀ + Q.
    const pp = sp + dt * sv
    const pv = sv
    // F P Fᵀ with F = [[1,dt],[0,1]]
    const a00 = p00 + dt * p10 + dt * (p01 + dt * p11)
    const a01 = p01 + dt * p11
    const a10 = p10 + dt * p11
    const a11 = p11
    const pp00 = a00 + q00
    const pp01 = a01 + q01
    const pp10 = a10 + q01
    const pp11 = a11 + q11

    // Update with measurement z = pos. H = [1, 0].
    const yInnov = meas[n] - pp // innovation
    const S = pp00 + R
    const k0 = pp00 / S
    const k1 = pp10 / S
    sp = pp + k0 * yInnov
    sv = pv + k1 * yInnov
    // P = (I − K H) P⁻
    const np00 = (1 - k0) * pp00
    const np01 = (1 - k0) * pp01
    const np10 = pp10 - k1 * pp00
    const np11 = pp11 - k1 * pp01
    p00 = np00
    p01 = np01
    p10 = np10
    p11 = np11

    estPos[n] = sp
    estVel[n] = sv
    posStd[n] = Math.sqrt(Math.max(p00, 0))
    velStd[n] = Math.sqrt(Math.max(p11, 0))
    innov[n] = yInnov
  }

  // RMSE over the tail (after convergence).
  const a = Math.floor(N * 0.3)
  let em = 0
  let ek = 0
  for (let n = a; n < N; n++) {
    em += (meas[n] - truePos[n]) * (meas[n] - truePos[n])
    ek += (estPos[n] - truePos[n]) * (estPos[n] - truePos[n])
  }
  const cnt = Math.max(1, N - a)
  return {
    truePos,
    trueVel,
    meas,
    estPos,
    estVel,
    posStd,
    velStd,
    innov,
    rmseMeas: Math.sqrt(em / cnt),
    rmseKalman: Math.sqrt(ek / cnt),
  }
}

// ---------------------------------------------------------------------------
// The Wiener solution — the least-squares optimum the adaptive filters chase.
// Solves the normal equations R·w = p from the input/desired data directly, so
// tests can confirm the adaptive filters converge to the *right* answer.
// ---------------------------------------------------------------------------

export function wienerSolution(u: Float64Array, d: Float64Array, L: number): Float64Array {
  const N = u.length
  const R = new Float64Array(L * L)
  const p = new Float64Array(L)
  const x = new Float64Array(L)
  for (let n = 0; n < N; n++) {
    for (let k = L - 1; k > 0; k--) x[k] = x[k - 1]
    x[0] = u[n]
    for (let i = 0; i < L; i++) {
      p[i] += x[i] * d[n]
      for (let j = i; j < L; j++) {
        const v = x[i] * x[j]
        R[i * L + j] += v
        if (i !== j) R[j * L + i] += v
      }
    }
  }
  // Tiny Tikhonov ridge for numerical safety on rank-deficient inputs.
  for (let i = 0; i < L; i++) R[i * L + i] += 1e-6
  return solveSmall(R, p, L)
}

// ---------------------------------------------------------------------------
// Metadata for the UI selectors.
// ---------------------------------------------------------------------------

export const SCENARIOS: { id: ScenarioKind | 'kalman'; label: string }[] = [
  { id: 'sysid', label: 'System ID' },
  { id: 'anc', label: 'Noise cancel' },
  { id: 'equalize', label: 'Equalizer' },
  { id: 'predict', label: 'Prediction' },
  { id: 'kalman', label: 'Kalman' },
]

export const ALGOS: { id: AlgoKind; label: string }[] = [
  { id: 'lms', label: 'LMS' },
  { id: 'nlms', label: 'NLMS' },
  { id: 'apa', label: 'APA' },
  { id: 'rls', label: 'RLS' },
]
