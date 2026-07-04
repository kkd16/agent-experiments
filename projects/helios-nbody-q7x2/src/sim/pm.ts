// The Particle-Mesh (PM) gravity solver — Helios's first *grid* force solver, and
// the engine of the Cosmic Web Lab.
//
// Where Barnes–Hut and the FMM walk a tree of bodies, PM never looks at a pair of
// bodies at all. It (1) paints the particle masses onto a square mesh with a
// Cloud-In-Cell (CIC) kernel, (2) solves Poisson's equation on that mesh in one shot
// with an FFT — φ̂_k = −Ŝ_k/k² — takes the force spectrally as F̂_k = −i k φ̂_k, and
// (3) reads the force back onto each particle with the *same* CIC kernel. Using one
// kernel for scatter and gather is what makes the scheme momentum-conserving and
// self-force-free.
//
// The physics is cosmological: positions are **comoving**, the force is the peculiar
// force −∇φ with ∇²φ = 2·δ (the normalised 2-D comoving Poisson equation, see
// `cosmology.ts`), and the leapfrog carries the expanding background through the
// canonical momentum p = a²ẋ.

import { fft2, ifft2, wavenumber } from './fft2'
import {
  SOURCE_COEFF,
  hubble,
  makeInitialField,
  zeldovichDisplacement,
  samplePeriodic,
  growingMode,
  growingModeRate,
} from './cosmology'
import type { InitialField } from './cosmology'

/** Wrap a coordinate into [0, box). */
function wrap(v: number, box: number): number {
  const r = v - Math.floor(v / box) * box
  return r === box ? 0 : r
}

/**
 * Cloud-In-Cell mass deposit. Each particle smears its mass onto the four nearest
 * grid nodes by bilinear weights, periodically. Grid node i sits at comoving
 * position i·(box/m); the weights match `samplePeriodic` exactly so scatter and
 * gather are the same kernel.
 */
export function cicDeposit(
  n: number,
  px: Float64Array,
  py: Float64Array,
  mass: Float64Array,
  m: number,
  box: number,
): Float64Array {
  const grid = new Float64Array(m * m)
  const cell = box / m
  for (let p = 0; p < n; p++) {
    const gx = wrap(px[p], box) / cell
    const gy = wrap(py[p], box) / cell
    const i0 = Math.floor(gx) % m
    const j0 = Math.floor(gy) % m
    const i1 = (i0 + 1) % m
    const j1 = (j0 + 1) % m
    const fx = gx - Math.floor(gx)
    const fy = gy - Math.floor(gy)
    const mp = mass[p]
    grid[i0 * m + j0] += mp * (1 - fx) * (1 - fy)
    grid[i1 * m + j0] += mp * fx * (1 - fy)
    grid[i0 * m + j1] += mp * (1 - fx) * fy
    grid[i1 * m + j1] += mp * fx * fy
  }
  return grid
}

/** Deposit mass, then convert to the density contrast δ = ρ/ρ̄ − 1 (zero mean). */
export function depositContrast(
  n: number,
  px: Float64Array,
  py: Float64Array,
  mass: Float64Array,
  m: number,
  box: number,
): Float64Array {
  const grid = cicDeposit(n, px, py, mass, m, box)
  let sum = 0
  for (let i = 0; i < grid.length; i++) sum += grid[i]
  const mean = sum / grid.length
  const delta = new Float64Array(grid.length)
  if (mean > 0) for (let i = 0; i < grid.length; i++) delta[i] = grid[i] / mean - 1
  return delta
}

export interface MeshForce {
  fx: Float64Array
  fy: Float64Array
}

/**
 * Solve the mesh peculiar force from a density-contrast field. In Fourier space,
 * with source S = SOURCE_COEFF·δ:  φ̂_k = −Ŝ_k/k²,  F̂_k = −i k φ̂_k = i k Ŝ_k/k².
 * The k=0 (mean) mode is dropped, so the net mesh force is exactly zero.
 */
export function solveForce(delta: Float64Array, m: number, box: number): MeshForce {
  const kUnit = (2 * Math.PI) / box
  // FFT the source S = SOURCE_COEFF·δ (real input).
  const sr = new Float64Array(m * m)
  const si = new Float64Array(m * m)
  for (let i = 0; i < m * m; i++) sr[i] = SOURCE_COEFF * delta[i]
  fft2(sr, si, m)

  const fxr = new Float64Array(m * m)
  const fxi = new Float64Array(m * m)
  const fyr = new Float64Array(m * m)
  const fyi = new Float64Array(m * m)
  for (let iu = 0; iu < m; iu++) {
    const kx = kUnit * wavenumber(iu, m)
    for (let iv = 0; iv < m; iv++) {
      const ky = kUnit * wavenumber(iv, m)
      const idx = iu * m + iv
      const k2 = kx * kx + ky * ky
      if (k2 === 0) continue
      // Zero the self-conjugate Nyquist row/column: a first-derivative (odd) operator
      // ∝ i·k turns a real Nyquist coefficient imaginary, which a real field can't
      // represent. Dropping it keeps the force real and momentum-conserving (the
      // standard Hockney–Eastwood choice).
      if (iu * 2 === m || iv * 2 === m) continue
      const Sr = sr[idx]
      const Si = si[idx]
      // F̂_j = i·k_j·Ŝ/k². i·(Sr + i·Si) = (−Si + i·Sr); scale by k_j/k².
      const gx = kx / k2
      const gy = ky / k2
      fxr[idx] = -Si * gx
      fxi[idx] = Sr * gx
      fyr[idx] = -Si * gy
      fyi[idx] = Sr * gy
    }
  }
  ifft2(fxr, fxi, m)
  ifft2(fyr, fyi, m)
  return { fx: fxr, fy: fyr }
}

/** The analytic peculiar force of a single-cosine density δ = A·cos(k₀·x): Fₓ = −(2A/k₀)·sin(k₀·x). */
export function analyticSingleModeForceX(amp: number, modeIndex: number, box: number, x: number): number {
  const k0 = (2 * Math.PI * modeIndex) / box
  return -(SOURCE_COEFF * amp / k0) * Math.sin(k0 * x)
}

export interface PowerSpectrum {
  k: number[] // integer wavenumber magnitude at each bin centre
  power: number[] // azimuthally-averaged |δ̂(k)|² in that bin
}

/**
 * The matter power spectrum P(k) — the canonical observable of large-scale
 * structure. FFT the density contrast, average |δ̂|² over each |k| annulus. The
 * amplitude normalisation is arbitrary (only the *shape* matters here), so this is
 * returned in mesh units; a power-law input field P(k) ∝ kⁿ comes back with slope n.
 */
export function measurePowerSpectrum(delta: Float64Array, m: number): PowerSpectrum {
  const re = delta.slice()
  const im = new Float64Array(m * m)
  fft2(re, im, m)
  const kMax = Math.floor(m / 2)
  const sum = new Float64Array(kMax + 1)
  const count = new Float64Array(kMax + 1)
  for (let iu = 0; iu < m; iu++) {
    const ku = wavenumber(iu, m)
    for (let iv = 0; iv < m; iv++) {
      const kv = wavenumber(iv, m)
      const kMag = Math.round(Math.sqrt(ku * ku + kv * kv))
      if (kMag < 1 || kMag > kMax) continue
      const idx = iu * m + iv
      sum[kMag] += re[idx] * re[idx] + im[idx] * im[idx]
      count[kMag] += 1
    }
  }
  const k: number[] = []
  const power: number[] = []
  for (let b = 1; b <= kMax; b++) {
    if (count[b] > 0) {
      k.push(b)
      power.push(sum[b] / count[b])
    }
  }
  return { k, power }
}

/**
 * Least-squares slope of log(P) against log(k) over a band [kLo, kHi] — the measured
 * spectral index n of a power-law power spectrum P(k) ∝ kⁿ.
 */
export function powerLawSlope(ps: PowerSpectrum, kLo: number, kHi: number): number {
  let n = 0
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < ps.k.length; i++) {
    const kk = ps.k[i]
    if (kk < kLo || kk > kHi || ps.power[i] <= 0) continue
    const x = Math.log(kk)
    const y = Math.log(ps.power[i])
    n++
    sx += x
    sy += y
    sxx += x * x
    sxy += x * y
  }
  if (n < 2) return NaN
  return (n * sxy - sx * sy) / (n * sxx - sx * sx)
}

export interface CosmicPMOptions {
  m: number // mesh side (power of two)
  box: number // comoving box side
  particlesPerSide: number // P × P particles on the initial lattice
  spectralIndex: number // P(k) ∝ kⁿ
  sigma1: number // linear σ at a = 1 (perturbation amplitude)
  seed: number
  aInit: number // initial scale factor (start deep in the linear regime)
}

/**
 * A cosmological Particle-Mesh simulation: Zel'dovich initial conditions on a
 * lattice, evolved by a comoving kick–drift–kick leapfrog on the mesh force.
 */
export class CosmicPM {
  readonly m: number
  readonly box: number
  readonly n: number
  readonly opts: CosmicPMOptions
  readonly initialField: InitialField

  px: Float64Array
  py: Float64Array
  px0: Float64Array // initial (unperturbed) lattice sites, for the displacement probe
  py0: Float64Array
  momX: Float64Array // canonical momentum p = a²ẋ
  momY: Float64Array
  mass: Float64Array

  a: number
  t: number

  private forceX: Float64Array | null = null
  private forceY: Float64Array | null = null

  constructor(opts: CosmicPMOptions) {
    this.opts = opts
    this.m = opts.m
    this.box = opts.box
    const P = opts.particlesPerSide
    this.n = P * P
    this.a = opts.aInit
    this.t = opts.aInit // a = t

    // Zel'dovich ICs: displace a P×P lattice by D(a)·Ψ, give it the linear-growth velocity.
    this.initialField = makeInitialField(opts.m, opts.spectralIndex, opts.sigma1, opts.seed)
    const disp = zeldovichDisplacement(this.initialField, opts.box)

    this.px = new Float64Array(this.n)
    this.py = new Float64Array(this.n)
    this.px0 = new Float64Array(this.n)
    this.py0 = new Float64Array(this.n)
    this.momX = new Float64Array(this.n)
    this.momY = new Float64Array(this.n)
    this.mass = new Float64Array(this.n)

    const D = growingMode(opts.aInit)
    const Ddot = growingModeRate() // dD/dt
    const a2 = opts.aInit * opts.aInit
    const step = opts.box / P
    let idx = 0
    for (let i = 0; i < P; i++) {
      for (let j = 0; j < P; j++) {
        const qx = i * step
        const qy = j * step
        this.px0[idx] = qx
        this.py0[idx] = qy
        const sx = samplePeriodic(disp.psiX, opts.m, opts.box, qx, qy)
        const sy = samplePeriodic(disp.psiY, opts.m, opts.box, qx, qy)
        this.px[idx] = wrap(qx + D * sx, opts.box)
        this.py[idx] = wrap(qy + D * sy, opts.box)
        // ẋ = Ḋ·Ψ  ⇒  p = a²ẋ = a²·Ḋ·Ψ.
        this.momX[idx] = a2 * Ddot * sx
        this.momY[idx] = a2 * Ddot * sy
        this.mass[idx] = 1
        idx++
      }
    }
  }

  /** Peculiar force −∇φ at every particle (deposit → solve → CIC gather). */
  computeForces(): { fx: Float64Array; fy: Float64Array } {
    const delta = depositContrast(this.n, this.px, this.py, this.mass, this.m, this.box)
    const mesh = solveForce(delta, this.m, this.box)
    const fx = new Float64Array(this.n)
    const fy = new Float64Array(this.n)
    for (let p = 0; p < this.n; p++) {
      fx[p] = samplePeriodic(mesh.fx, this.m, this.box, this.px[p], this.py[p])
      fy[p] = samplePeriodic(mesh.fy, this.m, this.box, this.px[p], this.py[p])
    }
    return { fx, fy }
  }

  /** One comoving kick–drift–kick leapfrog step of size Δt in cosmic time. */
  step(dt: number): void {
    if (!this.forceX || !this.forceY) {
      const f = this.computeForces()
      this.forceX = f.fx
      this.forceY = f.fy
    }
    // Kick (half): p += F·Δt/2.
    for (let p = 0; p < this.n; p++) {
      this.momX[p] += this.forceX[p] * 0.5 * dt
      this.momY[p] += this.forceY[p] * 0.5 * dt
    }
    // Drift: x += (p/a_mid²)·Δt, with a evaluated at the half-step.
    const aMid = this.t + 0.5 * dt // a = t
    const invA2 = 1 / (aMid * aMid)
    for (let p = 0; p < this.n; p++) {
      this.px[p] = wrap(this.px[p] + this.momX[p] * invA2 * dt, this.box)
      this.py[p] = wrap(this.py[p] + this.momY[p] * invA2 * dt, this.box)
    }
    this.t += dt
    this.a = this.t
    // Recompute force, then Kick (half).
    const f = this.computeForces()
    this.forceX = f.fx
    this.forceY = f.fy
    for (let p = 0; p < this.n; p++) {
      this.momX[p] += this.forceX[p] * 0.5 * dt
      this.momY[p] += this.forceY[p] * 0.5 * dt
    }
  }

  /** RMS density contrast σ measured from the current particle distribution. */
  sigma(): number {
    const delta = depositContrast(this.n, this.px, this.py, this.mass, this.m, this.box)
    let sumSq = 0
    for (let i = 0; i < delta.length; i++) sumSq += delta[i] * delta[i]
    return Math.sqrt(sumSq / delta.length)
  }

  /**
   * RMS comoving displacement of the particles from their initial lattice sites,
   * with periodic minimum-image wrapping. In the linear (Zel'dovich) regime the
   * displacement is D(a)·Ψ, so this grows exactly ∝ a until shell-crossing — a
   * clean, low-noise probe of the linear growth rate.
   */
  rmsDisplacement(): number {
    let sumSq = 0
    for (let p = 0; p < this.n; p++) {
      let dx = this.px[p] - this.px0[p]
      let dy = this.py[p] - this.py0[p]
      dx -= Math.round(dx / this.box) * this.box
      dy -= Math.round(dy / this.box) * this.box
      sumSq += dx * dx + dy * dy
    }
    return Math.sqrt(sumSq / this.n)
  }

  /** Total comoving momentum Σp — a conserved quantity of the leapfrog (ΣF ≈ 0). */
  totalMomentum(): { x: number; y: number } {
    let x = 0
    let y = 0
    for (let p = 0; p < this.n; p++) {
      x += this.momX[p]
      y += this.momY[p]
    }
    return { x, y }
  }

  /** The current density contrast field, for the heatmap. */
  densityField(): Float64Array {
    return depositContrast(this.n, this.px, this.py, this.mass, this.m, this.box)
  }

  /** Local density contrast interpolated at each particle (for colouring). */
  localDensity(): Float64Array {
    const delta = depositContrast(this.n, this.px, this.py, this.mass, this.m, this.box)
    const out = new Float64Array(this.n)
    for (let p = 0; p < this.n; p++) {
      out[p] = samplePeriodic(delta, this.m, this.box, this.px[p], this.py[p])
    }
    return out
  }

  redshift(): number {
    return 1 / this.a - 1
  }

  hubbleRate(): number {
    return hubble(this.a)
  }
}
