// Deterministic-chaos analysis through the variational (tangent) equations.
//
// A gravitational N-body system is a Hamiltonian flow. Two questions decide its
// long-term fate: is a given configuration *regular* (quasi-periodic, predictable
// forever) or *chaotic* (exponentially sensitive to its initial conditions)? This
// module answers both, from first principles, by evolving an infinitesimal
// deviation vector δ alongside the real trajectory and measuring how it grows.
//
//   • Maximal Lyapunov exponent λ — Benettin's algorithm. We integrate δ under the
//     *linearised* flow, renormalise it to unit length every step, and accumulate
//     the logarithm of each step's stretch. λ = ⟨ln‖δ‖⟩ / t. λ ≈ 0 ⇒ regular;
//     λ > 0 ⇒ chaos, with e-folding ("Lyapunov") time 1/λ.
//
//   • MEGNO (Mean Exponential Growth of Nearby Orbits; Cincotta & Simó 2000) — a
//     far faster-converging indicator. From the logarithmic derivative
//     a(t) = (δ̇·δ)/(δ·δ) it forms  Y(t) = (2/t)∫₀ᵗ a(s)·s ds  and its running
//     mean ⟨Y⟩(t) = (1/t)∫₀ᵗ Y(s) ds. The theorem: for a quasi-periodic orbit
//     ⟨Y⟩ → 2 exactly; for a chaotic one ⟨Y⟩ grows linearly as (λ/2)·t. So ⟨Y⟩
//     converges to 2 in a handful of periods where Lyapunov needs hundreds —
//     and the slope of the linear growth *is* the Lyapunov exponent.
//
// The linearised dynamics need the gradient of the force — the tidal tensor. For
// the softened pair potential the acceleration of body i is
//   aᵢ = G Σⱼ mⱼ dᵢⱼ / s³ ,  dᵢⱼ = rⱼ − rᵢ ,  s = √(|dᵢⱼ|² + ε²),
// whose exact derivative gives the variational acceleration
//   δaᵢ = G Σⱼ mⱼ [ δdᵢⱼ/s³ − 3 (dᵢⱼ·δdᵢⱼ) dᵢⱼ / s⁵ ] ,  δdᵢⱼ = δrⱼ − δrᵢ.
// Both are computed in one symmetric O(n²) pass (exact — no Barnes–Hut
// approximation pollutes the chaos measurement), and the real state and the
// tangent state are advanced together by the same symplectic velocity-Verlet map.

export type ChaosClass = 'regular' | 'weakly-chaotic' | 'chaotic'

export interface ChaosSample {
  /** Simulated time at this sample. */
  t: number
  /** Running MEGNO mean ⟨Y⟩(t). */
  megno: number
  /** Running maximal-Lyapunov estimate λ(t). */
  lyapunov: number
}

export interface ChaosResult {
  n: number
  steps: number
  dt: number
  time: number
  /** Final time-averaged MEGNO ⟨Y⟩ — the headline number (→2 for regular orbits). */
  megno: number
  /** Final instantaneous MEGNO Y(t). */
  megnoInstant: number
  /** Maximal Lyapunov exponent estimate (per unit simulated time). */
  lyapunov: number
  /** e-folding (Lyapunov) time 1/λ; Infinity when λ is indistinguishable from 0. */
  lyapunovTime: number
  /** Dimensionless λ·T over the whole window — how many e-foldings were observed. */
  efoldings: number
  classification: ChaosClass
  /** Down-sampled ⟨Y⟩ / λ history for plotting. */
  samples: ChaosSample[]
}

export interface ChaosOptions {
  g: number
  softening: number
  dt: number
  steps: number
  /** Number of history samples to keep for the plot (default 120). */
  sampleCount?: number
  /** Seed for the deterministic initial deviation vector (default 0x9e3779b9). */
  seed?: number
}

/** The largest system the O(n²)-per-step variational solver will analyse. */
export const CHAOS_BODY_LIMIT = 400
/** Total work budget (n² · steps); the step count is trimmed to stay under it. */
const CHAOS_WORK_BUDGET = 60_000_000

/**
 * Accelerations and their variational (tangent) counterpart in one O(n²) pass.
 * `A*` receives the real acceleration at (X,Y); `DA*` the linearised acceleration
 * of the deviation whose position part is (DX,DY). Velocities never enter the
 * force, so the tangent acceleration depends only on the position deviation.
 */
export function accelAndVariational(
  n: number,
  X: Float64Array, Y: Float64Array, M: Float64Array,
  DX: Float64Array, DY: Float64Array,
  AX: Float64Array, AY: Float64Array, DAX: Float64Array, DAY: Float64Array,
  g: number, eps2: number,
): void {
  for (let i = 0; i < n; i++) {
    AX[i] = 0; AY[i] = 0; DAX[i] = 0; DAY[i] = 0
  }
  for (let i = 0; i < n; i++) {
    const xi = X[i], yi = Y[i], dxi = DX[i], dyi = DY[i], mi = M[i]
    for (let j = i + 1; j < n; j++) {
      const dx = X[j] - xi
      const dy = Y[j] - yi
      const r2 = dx * dx + dy * dy + eps2
      const inv = 1 / Math.sqrt(r2)
      const inv3 = inv * inv * inv
      const inv5 = inv3 * inv * inv
      const mj = M[j]

      // Real acceleration (Newton's third law keeps it symmetric).
      const fx = g * dx * inv3
      const fy = g * dy * inv3
      AX[i] += mj * fx; AY[i] += mj * fy
      AX[j] -= mi * fx; AY[j] -= mi * fy

      // Variational acceleration: δaᵢ from δdᵢⱼ = δrⱼ − δrᵢ.
      const ddx = DX[j] - dxi
      const ddy = DY[j] - dyi
      const dot = dx * ddx + dy * ddy
      const tx = g * (ddx * inv3 - 3 * dot * dx * inv5)
      const ty = g * (ddy * inv3 - 3 * dot * dy * inv5)
      DAX[i] += mj * tx; DAY[i] += mj * ty
      DAX[j] -= mi * tx; DAY[j] -= mi * ty
    }
  }
}

/**
 * Run a full chaos analysis on a snapshot of the system. The input arrays are
 * copied, so the caller's live state is never touched. Returns MEGNO, the maximal
 * Lyapunov exponent, and a sampled history of both.
 */
export function analyzeChaos(
  n: number,
  posX: Float64Array, posY: Float64Array,
  velX: Float64Array, velY: Float64Array,
  mass: Float64Array,
  opts: ChaosOptions,
): ChaosResult {
  const dt = opts.dt
  const eps2 = opts.softening * opts.softening
  const g = opts.g
  // Trim the step count so a large system never blows the work budget.
  const maxSteps = Math.max(1, Math.floor(CHAOS_WORK_BUDGET / Math.max(1, n * n)))
  const steps = Math.max(1, Math.min(opts.steps, maxSteps))
  const sampleCount = Math.max(2, opts.sampleCount ?? 120)

  // Working copies of the real state.
  const X = new Float64Array(n), Y = new Float64Array(n)
  const VX = new Float64Array(n), VY = new Float64Array(n)
  const M = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    X[i] = posX[i]; Y[i] = posY[i]
    VX[i] = velX[i]; VY[i] = velY[i]
    M[i] = mass[i]
  }

  // The deviation vector δ = (δx, δy, δvx, δvy), seeded pseudo-randomly so the
  // run is fully reproducible, then normalised to unit phase-space length.
  const DX = new Float64Array(n), DY = new Float64Array(n)
  const DVX = new Float64Array(n), DVY = new Float64Array(n)
  let s = (opts.seed ?? 0x9e3779b9) >>> 0
  const rnd = () => {
    // mulberry32
    s |= 0; s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  let norm0 = 0
  for (let i = 0; i < n; i++) {
    DX[i] = rnd() - 0.5; DY[i] = rnd() - 0.5
    DVX[i] = rnd() - 0.5; DVY[i] = rnd() - 0.5
    norm0 += DX[i] * DX[i] + DY[i] * DY[i] + DVX[i] * DVX[i] + DVY[i] * DVY[i]
  }
  {
    const inv = 1 / Math.sqrt(norm0)
    for (let i = 0; i < n; i++) {
      DX[i] *= inv; DY[i] *= inv; DVX[i] *= inv; DVY[i] *= inv
    }
  }

  const AX = new Float64Array(n), AY = new Float64Array(n)
  const DAX = new Float64Array(n), DAY = new Float64Array(n)

  const half = dt * 0.5
  let t = 0
  let y1 = 0 // ∫ a(s)·s ds
  let y2 = 0 // ∫ Y(s) ds
  let sumLogStretch = 0
  let megnoMean = 0
  let megnoInst = 0
  let lyap = 0

  // Seed the force/variational buffers for the first half-kick.
  accelAndVariational(n, X, Y, M, DX, DY, AX, AY, DAX, DAY, g, eps2)

  const samples: ChaosSample[] = []
  const sampleEvery = Math.max(1, Math.floor(steps / sampleCount))

  for (let step = 0; step < steps; step++) {
    // Velocity-Verlet (KDK) on the real and tangent states together.
    for (let i = 0; i < n; i++) {
      VX[i] += AX[i] * half; VY[i] += AY[i] * half
      DVX[i] += DAX[i] * half; DVY[i] += DAY[i] * half
    }
    for (let i = 0; i < n; i++) {
      X[i] += VX[i] * dt; Y[i] += VY[i] * dt
      DX[i] += DVX[i] * dt; DY[i] += DVY[i] * dt
    }
    accelAndVariational(n, X, Y, M, DX, DY, AX, AY, DAX, DAY, g, eps2)
    for (let i = 0; i < n; i++) {
      VX[i] += AX[i] * half; VY[i] += AY[i] * half
      DVX[i] += DAX[i] * half; DVY[i] += DAY[i] * half
    }
    t += dt

    // Logarithmic derivative a(t) = (δ̇·δ)/(δ·δ). The phase-space velocity of the
    // deviation is δ̇ = (δv, δa); δa = DA was just evaluated at the new position.
    let num = 0
    let den = 0
    for (let i = 0; i < n; i++) {
      num += DX[i] * DVX[i] + DY[i] * DVY[i] + DVX[i] * DAX[i] + DVY[i] * DAY[i]
      den += DX[i] * DX[i] + DY[i] * DY[i] + DVX[i] * DVX[i] + DVY[i] * DVY[i]
    }
    const aLog = den > 0 ? num / den : 0

    // MEGNO integrals (rectangle rule). Both Y and ⟨Y⟩ are scale-free.
    y1 += aLog * t * dt
    megnoInst = (2 * y1) / t
    y2 += megnoInst * dt
    megnoMean = y2 / t

    // Lyapunov: the deviation had unit norm at the start of the step (it is
    // renormalised below), so √den is exactly this step's stretch factor.
    const stretch = Math.sqrt(den)
    sumLogStretch += Math.log(stretch)
    lyap = sumLogStretch / t

    // Renormalise the deviation back to unit length to avoid overflow; direction
    // (the only thing the indicators depend on) is preserved.
    const inv = stretch > 0 ? 1 / stretch : 1
    for (let i = 0; i < n; i++) {
      DX[i] *= inv; DY[i] *= inv; DVX[i] *= inv; DVY[i] *= inv
    }

    if (step % sampleEvery === 0 || step === steps - 1) {
      samples.push({ t, megno: megnoMean, lyapunov: lyap })
    }
  }

  const efoldings = lyap * t
  const lyapunovTime = lyap > 1e-9 ? 1 / lyap : Infinity
  // Classify from BOTH indicators. The subtlety: a *regular* orbit's deviation
  // still grows — but only polynomially (linearly, from the slightly different
  // periods of neighbouring orbits), so ‖δ‖ ~ t and the naive λ ≈ ln(t)/t decays
  // toward 0 while the apparent "e-folding count" λ·t creeps up like ln(t). True
  // chaos grows *exponentially*: ‖δ‖ ~ e^{λt}, so λ·t ≫ ln(t). We therefore
  // normalise the e-folding count by ln(t): the ratio is ≈1 for regular motion
  // and ≫1 for chaos. MEGNO ⟨Y⟩ → 2 confirms regularity independently.
  const megnoExcess = Math.abs(megnoMean - 2)
  const growthRatio = efoldings / Math.max(1, Math.log(t))
  let classification: ChaosClass
  if (megnoExcess < 0.7 && growthRatio < 1.6) {
    classification = 'regular'
  } else if (megnoExcess > 1.5 || growthRatio > 2.2) {
    classification = 'chaotic'
  } else {
    classification = 'weakly-chaotic'
  }

  return {
    n,
    steps,
    dt,
    time: t,
    megno: megnoMean,
    megnoInstant: megnoInst,
    lyapunov: lyap,
    lyapunovTime,
    efoldings,
    classification,
    samples,
  }
}
