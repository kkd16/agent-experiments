// Seismic time-history analysis — the earthquake chapter of structural dynamics.
//
// Modal analysis found the natural frequencies; the transient solver rang the
// structure down from a static kick; the harmonic solver traced the resonance
// curve of a *steady* sinusoidal drive. The question this file answers is the one
// earthquake engineering is built on: **what does an arbitrary ground motion do
// to the structure as it happens?** There is no single frequency and no steady
// state — the support accelerates along a recorded/synthetic accelerogram a_g(t)
// and we must integrate the equation of motion forward in time,
//
//     M·ü + C·u̇ + K·u = −M·ι·a_g(t),
//
// where u is the displacement *relative to the moving ground*, ι the influence
// vector (unit rigid ground translation), and C = a₀M + a₁K is **Rayleigh
// (proportional) damping** tuned to a target modal damping ratio ζ. The solver
// is the unconditionally-stable **Newmark-β average-acceleration** method
// (γ = ½, β = ¼): factor the effective stiffness once (Cholesky) and march.
//
// Alongside the time history it computes the **response spectrum** — the single
// most-used object in earthquake engineering. For a bank of single-DOF
// oscillators spanning a range of periods T, each is integrated under the *same*
// ground motion and its peak response recorded; plotting peak pseudo-acceleration
// against period gives the spectrum, from which a designer reads the force a
// building of a given period will attract. The whole thing is validated live
// against closed-form results (Newmark's exact natural period, the step-load
// dynamic-amplification factor of 2, the damped log-decrement, the SDOF
// harmonic steady-state amplitude, and the T→0 spectral limit Sa → PGA).
//
// Everything is pure `number` / `Float64Array` arithmetic — deterministic (the
// synthetic accelerogram is seeded, never Math.random), no time, no globals — so
// the same model + record always yields the same response, and validate.ts can
// cross-check it against theory exactly like every other chapter.

import { type FrameModel, type NodeDisp } from './frame'
import { solveModal, assemble, expand, toNodeDisp } from './dynamics'
import { choleskyLower, forwardSolve, backSolveT, matVecDense, type Mat } from './eigen'

// ------------------------------------------------------------- ground motions

/** Which excitation record drives the support. */
export type GroundRecord = 'synthetic' | 'pulse' | 'harmonic'

export interface GroundMotion {
  record: GroundRecord
  name: string
  dt: number
  /** Ground acceleration a_g(t), m/s². */
  ag: Float64Array
  /** Ground velocity (baseline-corrected), m/s. */
  vg: Float64Array
  /** Ground displacement (baseline-corrected), m. */
  ug: Float64Array
  duration: number
  pga: number // peak ground acceleration, m/s²
  pgv: number // peak ground velocity, m/s
  pgd: number // peak ground displacement, m
}

const G = 9.80665 // m/s²

/** A tiny deterministic PRNG (mulberry32) — seeded, so records never jitter. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Jennings strong-motion envelope: quadratic rise, plateau, exponential decay. */
function jennings(t: number, t1: number, t2: number, decay: number): number {
  if (t < t1) return (t / t1) * (t / t1)
  if (t <= t2) return 1
  return Math.exp(-decay * (t - t2))
}

/**
 * Baseline-correct a raw accelerogram and integrate to velocity/displacement.
 * Removes the mean acceleration, integrates (trapezoid) to velocity, removes a
 * linear velocity trend (so the ground ends at rest), integrates to displacement
 * and removes its linear trend — the standard processing that keeps `ug` from
 * drifting off screen while leaving the accelerogram essentially unchanged.
 */
function integrateGround(ag: Float64Array, dt: number): { vg: Float64Array; ug: Float64Array } {
  const n = ag.length
  // Remove mean acceleration.
  let meanA = 0
  for (let i = 0; i < n; i++) meanA += ag[i]
  meanA /= n
  const a = new Float64Array(n)
  for (let i = 0; i < n; i++) a[i] = ag[i] - meanA

  const vg = new Float64Array(n)
  for (let i = 1; i < n; i++) vg[i] = vg[i - 1] + 0.5 * (a[i] + a[i - 1]) * dt
  // Remove a linear velocity trend v ≈ slope·t so the record ends at rest.
  const slope = vg[n - 1] / ((n - 1) * dt)
  for (let i = 0; i < n; i++) vg[i] -= slope * i * dt

  const ug = new Float64Array(n)
  for (let i = 1; i < n; i++) ug[i] = ug[i - 1] + 0.5 * (vg[i] + vg[i - 1]) * dt
  const dslope = ug[n - 1] / ((n - 1) * dt)
  for (let i = 0; i < n; i++) ug[i] -= dslope * i * dt
  return { vg, ug }
}

function finish(record: GroundRecord, name: string, agRaw: Float64Array, dt: number, targetPga: number): GroundMotion {
  const n = agRaw.length
  // Scale to the requested PGA.
  let mx = 0
  for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(agRaw[i]))
  const s = mx > 1e-30 ? targetPga / mx : 0
  const ag = new Float64Array(n)
  for (let i = 0; i < n; i++) ag[i] = agRaw[i] * s
  const { vg, ug } = integrateGround(ag, dt)
  let pga = 0
  let pgv = 0
  let pgd = 0
  for (let i = 0; i < n; i++) {
    pga = Math.max(pga, Math.abs(ag[i]))
    pgv = Math.max(pgv, Math.abs(vg[i]))
    pgd = Math.max(pgd, Math.abs(ug[i]))
  }
  return { record, name, dt, ag, vg, ug, duration: (n - 1) * dt, pga, pgv, pgd }
}

/**
 * A broadband **synthetic accelerogram**: a sum of harmonics whose amplitudes
 * follow a Kanai–Tajimi ground-filter spectrum (a soil resonance around ~2.5 Hz)
 * with a high-pass roll-off, random phases from a fixed seed, all shaped by a
 * Jennings envelope. It looks and behaves like a real earthquake record —
 * non-stationary, broadband — while being perfectly reproducible.
 */
export function syntheticQuake(pgaG = 0.4, duration = 24, dt = 0.01, seed = 1337): GroundMotion {
  const n = Math.round(duration / dt) + 1
  const rnd = mulberry32(seed)
  const nComp = 48
  const fMin = 0.25
  const fMax = 9
  const fg = 2.5 // soil predominant frequency, Hz
  const zg = 0.6 // soil damping
  const f0 = 0.35 // high-pass corner, Hz
  const comps: { w: number; A: number; ph: number }[] = []
  for (let j = 0; j < nComp; j++) {
    const f = fMin + ((fMax - fMin) * (j + 0.5)) / nComp
    const r = f / fg
    const kt = (1 + (2 * zg * r) ** 2) / ((1 - r * r) ** 2 + (2 * zg * r) ** 2)
    const hp = (f * f) / (f * f + f0 * f0) // high-pass to suppress long periods
    const A = Math.sqrt(kt) * hp
    comps.push({ w: 2 * Math.PI * f, A, ph: rnd() * 2 * Math.PI })
  }
  const ag = new Float64Array(n)
  const t1 = Math.min(2.5, 0.15 * duration)
  const t2 = Math.min(0.6 * duration, duration - 4)
  for (let i = 0; i < n; i++) {
    const t = i * dt
    let s = 0
    for (const c of comps) s += c.A * Math.sin(c.w * t + c.ph)
    ag[i] = s * jennings(t, t1, t2, 0.25)
  }
  return finish('synthetic', 'Synthetic broadband', ag, dt, pgaG * G)
}

/**
 * A **near-fault velocity pulse** — the destructive signature of a rupture
 * directivity effect. Modelled as a Ricker wavelet (the second derivative of a
 * Gaussian) in acceleration, giving one dominant swing that hammers long-period
 * structures far harder than a broadband record of the same PGA.
 */
export function pulseGround(pgaG = 0.5, duration = 16, dt = 0.01, fp = 0.7): GroundMotion {
  const n = Math.round(duration / dt) + 1
  const ag = new Float64Array(n)
  const t0 = 4.5
  for (let i = 0; i < n; i++) {
    const t = i * dt
    const a = (Math.PI * fp * (t - t0)) ** 2
    ag[i] = (1 - 2 * a) * Math.exp(-a)
  }
  return finish('pulse', 'Near-fault pulse', ag, dt, pgaG * G)
}

/**
 * A **harmonic shaker** record: a pure sinusoid with a short raised-cosine ramp
 * so it starts smoothly. Its response spectrum is a single sharp spike at the
 * drive period — the cleanest way to see a structure caught in resonance.
 */
export function harmonicGround(pgaG = 0.3, duration = 24, dt = 0.01, f0 = 1.0): GroundMotion {
  const n = Math.round(duration / dt) + 1
  const ag = new Float64Array(n)
  const ramp = 2.5
  for (let i = 0; i < n; i++) {
    const t = i * dt
    const env = t < ramp ? 0.5 * (1 - Math.cos((Math.PI * t) / ramp)) : 1
    ag[i] = env * Math.sin(2 * Math.PI * f0 * t)
  }
  return finish('harmonic', `Harmonic ${f0.toFixed(1)} Hz`, ag, dt, pgaG * G)
}

export function makeGround(record: GroundRecord, pgaG: number): GroundMotion {
  if (record === 'pulse') return pulseGround(pgaG)
  if (record === 'harmonic') return harmonicGround(pgaG)
  return syntheticQuake(pgaG)
}

// ----------------------------------------------------------- Newmark integrator

/** Newmark-β constants for the average-acceleration (γ=½, β=¼) scheme. */
function newmarkConstants(dt: number, gamma = 0.5, beta = 0.25) {
  return {
    gamma,
    beta,
    a0: 1 / (beta * dt * dt),
    a1: gamma / (beta * dt),
    a2: 1 / (beta * dt),
    a3: 1 / (2 * beta) - 1,
    a4: gamma / beta - 1,
    a5: dt * (gamma / (2 * beta) - 1),
    a6: dt * (1 - gamma),
    a7: dt * gamma,
  }
}

/** Dense SPD linear-system solver from a cached Cholesky factor. */
function makeSolver(A: Mat): ((b: number[]) => number[]) | null {
  const L = choleskyLower(A)
  if (!L) return null
  return (b: number[]) => backSolveT(L, forwardSolve(L, b))
}

/**
 * Rayleigh damping coefficients (a₀, a₁) such that C = a₀M + a₁K gives the
 * damping ratio ζ at both circular frequencies ω₁ and ω₂:
 *     ζ = ½(a₀/ω + a₁ω)  ⇒  a₀ = ζ·2ω₁ω₂/(ω₁+ω₂),  a₁ = ζ·2/(ω₁+ω₂).
 */
export function rayleighCoeffs(zeta: number, w1: number, w2: number): { a0: number; a1: number } {
  if (w1 <= 0 || w2 <= 0 || Math.abs(w2 - w1) < 1e-9) {
    const w = Math.max(w1, w2, 1e-6)
    return { a0: zeta * w, a1: zeta / w }
  }
  return {
    a0: (zeta * 2 * w1 * w2) / (w1 + w2),
    a1: (zeta * 2) / (w1 + w2),
  }
}

// ---------------------------------------------------------- scalar SDOF Newmark

/**
 * Integrate a single-DOF oscillator m·ü + c·u̇ + k·u = p(t) by Newmark-β and
 * return the full displacement history. Used both for the response spectrum
 * (many oscillators, one per period) and for the closed-form validation cases.
 */
export function newmarkSDOF(
  m: number,
  c: number,
  k: number,
  dt: number,
  p: Float64Array,
  u0 = 0,
  v0 = 0,
): Float64Array {
  const n = p.length
  const u = new Float64Array(n)
  const C = newmarkConstants(dt)
  const keff = k + C.a0 * m + C.a1 * c
  let ui = u0
  let vi = v0
  let ai = (p[0] - c * v0 - k * u0) / m
  u[0] = ui
  for (let i = 1; i < n; i++) {
    const peff = p[i] + m * (C.a0 * ui + C.a2 * vi + C.a3 * ai) + c * (C.a1 * ui + C.a4 * vi + C.a5 * ai)
    const un = peff / keff
    const an = C.a0 * (un - ui) - C.a2 * vi - C.a3 * ai
    const vn = vi + C.a6 * ai + C.a7 * an
    u[i] = un
    ui = un
    vi = vn
    ai = an
  }
  return u
}

/** Peak absolute value of a series (a spectral ordinate). */
function peakAbs(x: Float64Array, from = 0): number {
  let p = 0
  for (let i = from; i < x.length; i++) p = Math.max(p, Math.abs(x[i]))
  return p
}

// ------------------------------------------------------------- response spectrum

export interface SpectrumPoint {
  T: number // period, s
  omega: number // circular frequency, rad/s
  Sd: number // spectral (peak relative) displacement, m
  Sv: number // pseudo-velocity, m/s
  Sa: number // pseudo-acceleration, m/s²
  SaG: number // pseudo-acceleration in g
}

/**
 * The **elastic response spectrum** of a ground motion at damping ζ. For each
 * period T a mass-normalised SDOF (m = 1, k = ω², c = 2ζω) is driven by the
 * ground acceleration and its peak relative displacement Sd recorded; the
 * pseudo-spectral quantities are Sv = ω·Sd and Sa = ω²·Sd. As T → 0 the
 * oscillator is rigid and Sa → PGA; as T → ∞ it stays still and Sd → PGD.
 */
export function responseSpectrum(ground: GroundMotion, zeta: number, nT = 64, Tmin = 0.05, Tmax = 4): SpectrumPoint[] {
  const dt = ground.dt
  const out: SpectrumPoint[] = []
  const logMin = Math.log(Tmin)
  const logMax = Math.log(Tmax)
  // p(t) = −m·ι·a_g = −a_g for the unit oscillator (relative-displacement form).
  const p = new Float64Array(ground.ag.length)
  for (let i = 0; i < p.length; i++) p[i] = -ground.ag[i]
  for (let j = 0; j < nT; j++) {
    const T = Math.exp(logMin + ((logMax - logMin) * j) / (nT - 1))
    const omega = (2 * Math.PI) / T
    const k = omega * omega
    const c = 2 * zeta * omega
    const u = newmarkSDOF(1, c, k, dt, p)
    const Sd = peakAbs(u)
    const Sa = omega * omega * Sd
    out.push({ T, omega, Sd, Sv: omega * Sd, Sa, SaG: Sa / G })
  }
  return out
}

/** Interpolate a spectral ordinate (Sa, m/s²) at an arbitrary period. */
export function spectrumAt(spec: SpectrumPoint[], T: number): number {
  if (spec.length === 0) return 0
  if (T <= spec[0].T) return spec[0].Sa
  if (T >= spec[spec.length - 1].T) return spec[spec.length - 1].Sa
  for (let i = 1; i < spec.length; i++) {
    if (T <= spec[i].T) {
      const a = spec[i - 1]
      const b = spec[i]
      const f = (Math.log(T) - Math.log(a.T)) / (Math.log(b.T) - Math.log(a.T))
      return a.Sa + f * (b.Sa - a.Sa)
    }
  }
  return spec[spec.length - 1].Sa
}

// ------------------------------------------------------------ MDOF time history

/** Cap on reduced size — dense per-step solves are O(n²). */
const MAX_FREE_DOF = 300
/** Cap on stored steps (memory + per-frame animation cost). */
const MAX_STEPS = 4000

export interface SeismicResult {
  kind: 'seismic'
  ok: boolean
  note?: string
  dofPerNode: number
  nNodes: number
  ground: GroundMotion
  zeta: number
  spectrum: SpectrumPoint[]
  /** Natural periods (s) of the first few modes, for spectrum markers. */
  periods: number[]
  T1: number
  SaT1: number // pseudo-acceleration at the fundamental period, m/s²
  // Time-history results (present when ok):
  free: number[]
  nDof: number
  nSteps: number
  dt: number
  /** Reduced (free-DOF) relative-displacement history, one Float64Array per step. */
  U: Float64Array[]
  outNode: number
  outDir: 'x' | 'y' | 'θ'
  outReduced: number // index into the reduced vector
  /** Output-DOF (roof) relative-displacement history, m. */
  roof: Float64Array
  /** Elastic base-shear history ιᵀK u, N. */
  baseShear: Float64Array
  peakRoof: number
  peakDrift: number // peak inter-level horizontal drift (max − min nodal ux), m
  peakBaseShear: number
  /** Ground displacement normalised to unit peak, for the sway animation. */
  ugNorm: Float64Array
  /** Peak nodal translation across the record (normalises the drawn shape). */
  shapePeak: number
}

/** Build the reduced influence vector ι (unit horizontal ground translation). */
function influence(free: number[], dpn: number): number[] {
  return free.map((g) => (g % dpn === 0 ? 1 : 0))
}

/**
 * Full seismic analysis of a frame model under a ground motion: assemble K and
 * the consistent mass M, build Rayleigh damping from the first two modal
 * frequencies, integrate the relative-displacement response by Newmark-β, and
 * compute the response spectrum + spectral demand at the structure's periods.
 */
export function solveSeismic(model: FrameModel, ground: GroundMotion, zeta = 0.05): SeismicResult {
  const dpn = model.type === 'truss' ? 2 : 3
  const spectrum = responseSpectrum(ground, zeta)
  const base: SeismicResult = {
    kind: 'seismic',
    ok: false,
    dofPerNode: dpn,
    nNodes: model.nodes.length,
    ground,
    zeta,
    spectrum,
    periods: [],
    T1: 0,
    SaT1: 0,
    free: [],
    nDof: 0,
    nSteps: 0,
    dt: ground.dt,
    U: [],
    outNode: 0,
    outDir: 'x',
    outReduced: 0,
    roof: new Float64Array(0),
    baseShear: new Float64Array(0),
    peakRoof: 0,
    peakDrift: 0,
    peakBaseShear: 0,
    ugNorm: new Float64Array(0),
    shapePeak: 0,
  }
  if (model.members.length === 0) return { ...base, note: 'Add members to shake the structure.' }

  const asm = assemble(model, { withMass: true })
  const n = asm.free.length
  if (n === 0) return { ...base, note: 'No free DOFs — fully constrained.' }
  if (n > MAX_FREE_DOF) return { ...base, note: `Model too large for time-history (${n} DOF). Spectrum still shown.`, spectrum }

  // Natural frequencies (for Rayleigh damping targets + spectrum markers).
  const modal = solveModal(model, 6)
  const omegas = modal.modes.map((m) => m.omega).filter((w) => w > 1e-6)
  if (omegas.length === 0) return { ...base, note: 'No elastic modes found.' }
  const periods = omegas.map((w) => (2 * Math.PI) / w)
  const T1 = periods[0]
  const SaT1 = spectrumAt(spectrum, T1)

  // Rayleigh damping anchored at the 1st and a higher mode (spans the response).
  const w1 = omegas[0]
  const w2 = omegas[Math.min(omegas.length - 1, 2)] || w1 * 3
  const { a0, a1 } = rayleighCoeffs(zeta, w1, w2)
  const K = asm.Kr
  const M = asm.Mr
  const C: Mat = M.map((row, i) => row.map((mv, j) => a0 * mv + a1 * K[i][j]))

  // Newmark effective stiffness, factored once.
  const dt = ground.dt
  const NC = newmarkConstants(dt)
  const Keff: Mat = K.map((row, i) => row.map((kv, j) => kv + NC.a0 * M[i][j] + NC.a1 * C[i][j]))
  const solveKeff = makeSolver(Keff)
  if (!solveKeff) return { ...base, note: 'Effective stiffness not positive-definite.', spectrum }

  const iota = influence(asm.free, dpn)
  const Miota = matVecDense(M, iota) // the seismic load direction: p = −Miota·a_g

  const rawSteps = ground.ag.length
  const stride = Math.max(1, Math.ceil(rawSteps / MAX_STEPS))
  const U: Float64Array[] = []
  const kept: number[] = [] // raw indices we stored

  // State vectors.
  let u = new Float64Array(n)
  let v = new Float64Array(n)
  // Initial acceleration a = M⁻¹(p₀ − C v − K u); from rest, a = −ι·a_g(0).
  let acc = new Float64Array(n)
  for (let i = 0; i < n; i++) acc[i] = -iota[i] * ground.ag[0]

  const baseShearStored: number[] = []
  let peakBaseShear = 0

  // Output (roof) DOF: the free translational DOF that moves most over the whole
  // record — found on the fly from the largest running peak displacement.
  const runPeak = new Float64Array(n)

  const rhsWork = new Array(n)
  for (let step = 0; step < rawSteps; step++) {
    if (step > 0) {
      const ag = ground.ag[step]
      // p = −Miota·ag  (relative-displacement seismic forcing).
      for (let i = 0; i < n; i++) {
        const pi = -Miota[i] * ag
        rhsWork[i] =
          pi +
          // M·(a0 u + a2 v + a3 acc) + C·(a1 u + a4 v + a5 acc)
          mvRow(M, i, u, v, acc, NC.a0, NC.a2, NC.a3) +
          mvRow(C, i, u, v, acc, NC.a1, NC.a4, NC.a5)
      }
      const un = solveKeff(rhsWork)
      const uArr = new Float64Array(n)
      const vArr = new Float64Array(n)
      const aArr = new Float64Array(n)
      for (let i = 0; i < n; i++) {
        const an = NC.a0 * (un[i] - u[i]) - NC.a2 * v[i] - NC.a3 * acc[i]
        aArr[i] = an
        vArr[i] = v[i] + NC.a6 * acc[i] + NC.a7 * an
        uArr[i] = un[i]
      }
      u = uArr
      v = vArr
      acc = aArr
    }
    // Base shear = ιᵀK u (elastic story-shear resultant).
    const Ku = matVecDense(K, Array.from(u))
    let shear = 0
    for (let i = 0; i < n; i++) {
      shear += iota[i] * Ku[i]
      runPeak[i] = Math.max(runPeak[i], Math.abs(u[i]))
    }
    peakBaseShear = Math.max(peakBaseShear, Math.abs(shear))
    if (step % stride === 0) {
      U.push(u.slice())
      kept.push(step)
      baseShearStored.push(shear)
    }
  }

  // Output DOF = translational free DOF with the largest peak displacement.
  let outReduced = 0
  let bestPeak = -1
  for (let i = 0; i < n; i++) {
    if (asm.free[i] % dpn === 2) continue // skip rotations
    if (runPeak[i] > bestPeak) {
      bestPeak = runPeak[i]
      outReduced = i
    }
  }
  const outGlobal = asm.free[outReduced]
  const outNode = Math.floor(outGlobal / dpn)
  const outLocal = outGlobal % dpn

  // Roof (output-DOF) displacement history at the stored resolution.
  const roof = new Float64Array(U.length)
  for (let s = 0; s < U.length; s++) roof[s] = U[s][outReduced]

  // Peak drift: over stored frames, the spread of horizontal nodal displacement.
  let peakDrift = 0
  for (const uf of U) {
    let mn = Infinity
    let mx = -Infinity
    for (let i = 0; i < n; i++) {
      if (asm.free[i] % dpn === 0) {
        mn = Math.min(mn, uf[i])
        mx = Math.max(mx, uf[i])
      }
    }
    if (mx > mn) peakDrift = Math.max(peakDrift, mx - mn)
  }

  // Shape normalisation: peak nodal translation across stored frames.
  let shapePeak = 0
  for (const uf of U) {
    const full = expand(asm.free, asm.nDof, Array.from(uf))
    for (let i = 0; i < model.nodes.length; i++)
      shapePeak = Math.max(shapePeak, Math.hypot(full[i * dpn], full[i * dpn + 1]))
  }

  // Ground displacement at stored steps, normalised to unit peak for the sway.
  const ugNorm = new Float64Array(U.length)
  let ugMax = 1e-30
  for (const k of kept) ugMax = Math.max(ugMax, Math.abs(ground.ug[k]))
  kept.forEach((k, s) => (ugNorm[s] = ground.ug[k] / ugMax))

  const peakRoof = peakAbs(roof)
  const baseShear = Float64Array.from(baseShearStored)

  return {
    kind: 'seismic',
    ok: true,
    dofPerNode: dpn,
    nNodes: model.nodes.length,
    ground,
    zeta,
    spectrum,
    periods,
    T1,
    SaT1,
    free: asm.free,
    nDof: asm.nDof,
    nSteps: U.length,
    dt: dt * stride,
    U,
    outNode,
    outDir: outLocal === 0 ? 'x' : outLocal === 1 ? 'y' : 'θ',
    outReduced,
    roof,
    baseShear,
    peakRoof,
    peakDrift,
    peakBaseShear,
    ugNorm,
    shapePeak: shapePeak || 1,
  }
}

/** Row i of  A·(c1 u + c2 v + c3 a)  — avoids allocating the combined vector. */
function mvRow(A: Mat, i: number, u: Float64Array, v: Float64Array, a: Float64Array, c1: number, c2: number, c3: number): number {
  const row = A[i]
  let s = 0
  for (let j = 0; j < row.length; j++) s += row[j] * (c1 * u[j] + c2 * v[j] + c3 * a[j])
  return s
}

/**
 * The drawn shape at stored step `s`: the relative structural deformation
 * (normalised to unit peak, so the shared mode-shape scale renders it) plus a
 * rigid ground sway so the whole frame — supports and all — visibly rides the
 * earthquake, drifting relative to the fixed undeformed ghost.
 */
export function seismicShape(res: SeismicResult, s: number): NodeDisp[] {
  const dpn = res.dofPerNode
  const idx = Math.max(0, Math.min(res.U.length - 1, Math.round(s)))
  const uf = res.U[idx] ?? new Float64Array(res.free.length)
  const full = expand(res.free, res.nDof, Array.from(uf))
  const nd = toNodeDisp(full, dpn, res.nNodes)
  const sway = 0.55 * (res.ugNorm[idx] ?? 0) // sway amplitude as a fraction of the deflection scale
  const inv = 1 / res.shapePeak
  return nd.map((d) => ({ ux: d.ux * inv + sway, uy: d.uy * inv, rot: d.rot * inv }))
}
