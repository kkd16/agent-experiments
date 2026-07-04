// The cosmology behind Helios's Particle-Mesh solver: an expanding background, the
// linear growth of density perturbations, and Gaussian-random-field / Zel'dovich
// initial conditions.
//
// ── The model (2-D, self-contained, and made exactly testable) ────────────────
//
// Split the physical position r = a(t)·x into an expanding background (the scale
// factor a) and a comoving peculiar coordinate x. Carrying the split through
// Newtonian gravity (see the JOURNAL derivation) gives the peculiar equation of
// motion and the comoving Poisson equation:
//
//     ẍ + 2H ẋ = −(1/a²) ∇_x φ ,     ∇²_x φ = 2πG ρ̄_com δ ,   δ = ρ/ρ̄ − 1 ,
//
// where H = ȧ/a. In **two dimensions** the a-powers in the Poisson source cancel,
// so ∇²φ = 2πGρ̄_com δ is a-independent. Adopting a coasting background **a(t) = t**
// (H = 1/a) and normalising 2πGρ̄_com = 2, the linearised growth equation is
//
//     δ̈ + 2H δ̇ − (2/a²) δ = 0 ,
//
// with the two closed-form modes D₊ ∝ a (growing) and D₋ ∝ a⁻² (decaying). That
// clean result is what the self-test checks the live PM integrator against.

import { fft2, ifft2, wavenumber } from './fft2'
import { Rng } from './rng'

/** The Poisson source coefficient: ∇²φ = SOURCE_COEFF · δ (with 2πGρ̄_com ≡ 2). */
export const SOURCE_COEFF = 2

/** Background scale factor as a function of cosmic time — the coasting a(t) = t. */
export function scaleFactor(t: number): number {
  return t
}

/** Hubble rate H = ȧ/a for the coasting background (ȧ = 1, so H = 1/a). */
export function hubble(a: number): number {
  return 1 / a
}

/** The growing linear mode D₊(a) ∝ a, normalised to D₊(1) = 1. */
export function growingMode(a: number): number {
  return a
}

/** The decaying linear mode D₋(a) ∝ a⁻², normalised to D₋(1) = 1. */
export function decayingMode(a: number): number {
  return 1 / (a * a)
}

/** dD₊/dt for the growing mode (a = t ⇒ Ḋ₊ = 1). */
export function growingModeRate(): number {
  return 1
}

export interface GrowthSample {
  a: number
  delta: number
  deltaDot: number
}

/**
 * Integrate the linear growth ODE δ̈ + 2H δ̇ − (2/a²)δ = 0 in cosmic time (t = a),
 * by RK4, from `a0` to `a1`. Used both to seed a controlled perturbation and, in the
 * self-test, as the independent oracle the nonlinear PM integrator must track.
 */
export function integrateLinearGrowth(
  a0: number,
  a1: number,
  delta0: number,
  deltaDot0: number,
  steps: number,
): GrowthSample[] {
  // State y = [δ, δ̇]; t ≡ a. δ̈ = −2H δ̇ + (2/a²)δ, H = 1/a.
  const accel = (t: number, d: number, dDot: number) => -2 * (1 / t) * dDot + (2 / (t * t)) * d
  const dt = (a1 - a0) / steps
  let d = delta0
  let dDot = deltaDot0
  let t = a0
  const out: GrowthSample[] = [{ a: t, delta: d, deltaDot: dDot }]
  for (let s = 0; s < steps; s++) {
    const k1d = dDot
    const k1v = accel(t, d, dDot)
    const k2d = dDot + 0.5 * dt * k1v
    const k2v = accel(t + 0.5 * dt, d + 0.5 * dt * k1d, dDot + 0.5 * dt * k1v)
    const k3d = dDot + 0.5 * dt * k2v
    const k3v = accel(t + 0.5 * dt, d + 0.5 * dt * k2d, dDot + 0.5 * dt * k2v)
    const k4d = dDot + dt * k3v
    const k4v = accel(t + dt, d + dt * k3d, dDot + dt * k3v)
    d += (dt / 6) * (k1d + 2 * k2d + 2 * k3d + k4d)
    dDot += (dt / 6) * (k1v + 2 * k2v + 2 * k3v + k4v)
    t += dt
    out.push({ a: t, delta: d, deltaDot: dDot })
  }
  return out
}

export interface InitialField {
  /** The linear density contrast δ₁(x) at a = 1, on the M×M mesh (row-major). */
  delta: Float64Array
  /** Its Fourier transform (real / imag), reused by the Zel'dovich builder. */
  modesRe: Float64Array
  modesIm: Float64Array
  m: number
  /** RMS of `delta` — the linear σ at a = 1. */
  rms: number
}

/**
 * Build a Gaussian random field with a power-law power spectrum P(k) ∝ kⁿ on an
 * M×M mesh, normalised so its real-space RMS equals `targetRms` (the linear σ at
 * a = 1). Returns both the real field and its Fourier modes (the Zel'dovich builder
 * needs the modes; the density test needs the field).
 *
 * Method: white Gaussian noise → FFT → multiply each mode by √P(k) (a real, |k|-even
 * factor, so Hermitian symmetry is preserved and the inverse is real) → drop the DC
 * mode (zero mean) → inverse FFT.
 */
export function makeInitialField(
  m: number,
  spectralIndex: number,
  targetRms: number,
  seed: number,
): InitialField {
  const rng = new Rng(seed)
  const re = new Float64Array(m * m)
  const im = new Float64Array(m * m)
  for (let i = 0; i < m * m; i++) re[i] = rng.gaussian()

  fft2(re, im, m)

  for (let iu = 0; iu < m; iu++) {
    const ku = wavenumber(iu, m)
    for (let iv = 0; iv < m; iv++) {
      const kv = wavenumber(iv, m)
      const idx = iu * m + iv
      if (ku === 0 && kv === 0) {
        re[idx] = 0
        im[idx] = 0
        continue
      }
      const kMag = Math.sqrt(ku * ku + kv * kv)
      const amp = Math.pow(kMag, spectralIndex / 2) // √P(k), P ∝ kⁿ
      re[idx] *= amp
      im[idx] *= amp
    }
  }

  // Keep a copy of the (unnormalised) modes; the real field is their inverse.
  const modesRe = re.slice()
  const modesIm = im.slice()
  const fieldRe = re.slice()
  const fieldIm = im.slice()
  ifft2(fieldRe, fieldIm, m)

  // Measure RMS of the real part and rescale both field and modes to targetRms.
  let sumSq = 0
  for (let i = 0; i < m * m; i++) sumSq += fieldRe[i] * fieldRe[i]
  const rawRms = Math.sqrt(sumSq / (m * m))
  const scale = rawRms > 0 ? targetRms / rawRms : 0

  const delta = new Float64Array(m * m)
  for (let i = 0; i < m * m; i++) delta[i] = fieldRe[i] * scale
  for (let i = 0; i < m * m; i++) {
    modesRe[i] *= scale
    modesIm[i] *= scale
  }

  return { delta, modesRe, modesIm, m, rms: targetRms }
}

export interface DisplacementField {
  psiX: Float64Array
  psiY: Float64Array
  m: number
}

/**
 * The Zel'dovich displacement field Ψ from a linear-density field's Fourier modes:
 * Ψ̂ = i·k·δ̂₁/k² (so ∇·Ψ = −δ₁). `box` is the comoving side length, which sets the
 * physical wavevector k = (2π/L)·(integer wavenumber).
 */
export function zeldovichDisplacement(field: InitialField, box: number): DisplacementField {
  const m = field.m
  const kUnit = (2 * Math.PI) / box
  const xr = new Float64Array(m * m)
  const xi = new Float64Array(m * m)
  const yr = new Float64Array(m * m)
  const yi = new Float64Array(m * m)

  for (let iu = 0; iu < m; iu++) {
    const kx = kUnit * wavenumber(iu, m)
    for (let iv = 0; iv < m; iv++) {
      const ky = kUnit * wavenumber(iv, m)
      const idx = iu * m + iv
      const k2 = kx * kx + ky * ky
      if (k2 === 0) continue
      // Drop the self-conjugate Nyquist row/column so the i·k derivative keeps Ψ real
      // (see the matching note in `pm.ts` solveForce).
      if (iu * 2 === m || iv * 2 === m) continue
      const dr = field.modesRe[idx]
      const di = field.modesIm[idx]
      // Ψ̂_j = i·k_j·δ̂/k². Multiply δ̂ = (dr + i·di) by i·k_j/k²:
      //   i·(dr + i·di) = (−di + i·dr) → scale by k_j/k².
      const sx = kx / k2
      const sy = ky / k2
      xr[idx] = -di * sx
      xi[idx] = dr * sx
      yr[idx] = -di * sy
      yi[idx] = dr * sy
    }
  }

  ifft2(xr, xi, m)
  ifft2(yr, yi, m)
  return { psiX: xr, psiY: yr, m }
}

/** Bilinear sample of a periodic M×M grid at comoving position (x, y) in a box of side `box`. */
export function samplePeriodic(grid: Float64Array, m: number, box: number, x: number, y: number): number {
  const cell = box / m
  let gx = x / cell
  let gy = y / cell
  gx -= Math.floor(gx / m) * m
  gy -= Math.floor(gy / m) * m
  const i0 = Math.floor(gx) % m
  const j0 = Math.floor(gy) % m
  const i1 = (i0 + 1) % m
  const j1 = (j0 + 1) % m
  const fx = gx - Math.floor(gx)
  const fy = gy - Math.floor(gy)
  const v00 = grid[i0 * m + j0]
  const v10 = grid[i1 * m + j0]
  const v01 = grid[i0 * m + j1]
  const v11 = grid[i1 * m + j1]
  return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy
}
