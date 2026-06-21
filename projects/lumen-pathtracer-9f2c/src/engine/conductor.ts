// conductor.ts — real metals from measured complex refractive indices.
//
// Until 11.0 every "metal" in Lumen was tinted by an RGB `albedo` fed into the
// Schlick Fresnel approximation as F0. That is convenient but unphysical: a real
// conductor's reflectance is a *spectral* function R(λ) set by its complex index
// of refraction n̄(λ) = η(λ) − i·k(λ), and that spectral shape is exactly what
// gives gold its warm rim, copper its red, silver its near-neutral brilliance and
// aluminium its faint blue. Schlick-from-RGB can fake the colour at normal
// incidence but gets the *angular* desaturation wrong and can never reproduce the
// way a metal's hue shifts toward the horizon.
//
// This module carries small measured η/k tables (Johnson & Christy 1972 for the
// noble metals; Rakić 1998 for aluminium; standard handbook data for iron and
// chromium), an exact unpolarised **conductor Fresnel** evaluated from (η,k), and
// the two derived quantities the BSDF needs: the cosine-weighted hemispherical
// average reflectance (for Kulla–Conty multiscatter) and a band-integrated RGB F0
// (for the denoiser albedo guide and the achromatic BDPT fallback). The path
// tracer reuses the existing hero-wavelength machinery — a path that strikes a
// spectral metal commits one wavelength and shades with that wavelength's scalar
// conductor reflectance, so the metal's colour emerges over many samples exactly
// as dispersion does through glass.

import type { Vec3 } from './vec3'
import { v } from './vec3'
import { LAMBDA_MAX, LAMBDA_MIN, wavelengthWeight } from './spectrum'

// The named metals exposed to scenes. Each maps to a measured (η,k) table below.
export type ConductorName = 'gold' | 'silver' | 'copper' | 'aluminium' | 'iron' | 'chromium'

// A measured spectrum: parallel wavelength (nm), η and k arrays (ascending λ).
interface MetalSpectrum {
  lambda: number[]
  eta: number[]
  k: number[]
}

// Measured complex refractive index n̄ = η − ik, sampled across the visible band.
// Values are interpolated linearly between samples; outside the band the nearest
// endpoint is held. Reflectance at normal incidence R₀ = ((η−1)²+k²)/((η+1)²+k²)
// reproduces the textbook metal colours (gold/copper warm, silver/aluminium near
// neutral and bright, iron/chromium a flat mid grey).
const SPECTRA: Record<ConductorName, MetalSpectrum> = {
  // Au — Johnson & Christy 1972. R₀ ramps ≈0.39 (blue) → 0.97 (red): warm.
  gold: {
    lambda: [400, 450, 500, 550, 600, 650, 700],
    eta: [1.658, 1.35, 0.84, 0.331, 0.222, 0.167, 0.131],
    k: [1.956, 1.883, 1.834, 2.324, 2.948, 3.15, 3.842],
  },
  // Ag — Johnson & Christy 1972. Near-flat ≈0.87 → 0.97: bright, faintly warm.
  silver: {
    lambda: [400, 450, 500, 550, 600, 650, 700],
    eta: [0.173, 0.13, 0.13, 0.129, 0.124, 0.14, 0.149],
    k: [1.95, 2.39, 2.92, 3.33, 3.73, 4.15, 4.52],
  },
  // Cu — Johnson & Christy 1972. ≈0.49 (blue) → 0.94 (red): coppery red-orange.
  copper: {
    lambda: [400, 450, 500, 550, 600, 650, 700],
    eta: [1.175, 1.155, 1.135, 0.83, 0.31, 0.213, 0.214],
    k: [2.13, 2.4, 2.6, 2.6, 3.24, 3.67, 4.05],
  },
  // Al — Rakić 1998. ≈0.92 and faintly higher in blue: bright, slightly cool.
  aluminium: {
    lambda: [400, 450, 500, 550, 600, 650, 700],
    eta: [0.49, 0.598, 0.77, 0.958, 1.2, 1.47, 1.83],
    k: [4.86, 5.39, 6.08, 6.69, 7.26, 7.79, 8.31],
  },
  // Fe — handbook data. ≈0.54 and nearly flat: a dark neutral grey.
  iron: {
    lambda: [400, 450, 500, 550, 600, 650, 700],
    eta: [2.0, 2.27, 2.5, 2.75, 2.95, 3.05, 3.1],
    k: [2.9, 2.95, 3.05, 3.2, 3.4, 3.6, 3.8],
  },
  // Cr — handbook data. ≈0.55 mid grey with a slight blue lean.
  chromium: {
    lambda: [400, 450, 500, 550, 600, 650, 700],
    eta: [2.2, 2.75, 3.18, 3.18, 3.22, 3.3, 3.5],
    k: [2.85, 3.1, 3.3, 3.33, 3.39, 3.36, 3.4],
  },
}

// Linear interpolation into a measured table, holding the endpoints outside range.
function sampleTable(xs: number[], ys: number[], x: number): number {
  if (x <= xs[0]) return ys[0]
  const n = xs.length
  if (x >= xs[n - 1]) return ys[n - 1]
  let i = 1
  while (i < n && xs[i] < x) i++
  const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1])
  return ys[i - 1] + (ys[i] - ys[i - 1]) * t
}

// The complex index components η(λ), k(λ) for a named metal at wavelength λ (nm).
export function conductorEta(name: ConductorName, lambdaNm: number): number {
  const s = SPECTRA[name]
  return sampleTable(s.lambda, s.eta, lambdaNm)
}
export function conductorK(name: ConductorName, lambdaNm: number): number {
  const s = SPECTRA[name]
  return sampleTable(s.lambda, s.k, lambdaNm)
}

// Exact unpolarised Fresnel reflectance of a conductor (incident medium = vacuum)
// from its complex index η − ik, at incidence cosine `cosI` ∈ (0,1]. This is the
// full Airy/Fresnel result averaged over the two polarisations — the physically
// correct replacement for Schlick. (PBRT's `FrComplex`, real-valued form.)
export function fresnelConductor(cosI: number, eta: number, k: number): number {
  const cos = Math.min(1, Math.max(0, cosI))
  const cos2 = cos * cos
  const sin2 = 1 - cos2
  const eta2 = eta * eta
  const etak2 = k * k

  const t0 = eta2 - etak2 - sin2
  const a2plusb2 = Math.sqrt(Math.max(0, t0 * t0 + 4 * eta2 * etak2))
  const t1 = a2plusb2 + cos2
  const a = Math.sqrt(Math.max(0, 0.5 * (a2plusb2 + t0)))
  const t2 = 2 * a * cos
  const Rs = (t1 - t2) / (t1 + t2)

  const t3 = cos2 * a2plusb2 + sin2 * sin2
  const t4 = t2 * sin2
  const Rp = Rs * (t3 - t4) / (t3 + t4)

  return 0.5 * (Rp + Rs)
}

// Cosine-weighted hemispherical average of the conductor reflectance,
//   F̄ = 2∫₀¹ R(μ,η,k) μ dμ,
// the quantity the Kulla–Conty multiscatter compensation lobe needs (the analytic
// Schlick average has no closed form for a complex index, so we integrate it).
export function conductorAverageFresnel(eta: number, k: number): number {
  const N = 64
  let sum = 0
  for (let i = 0; i < N; i++) {
    const mu = (i + 0.5) / N
    sum += fresnelConductor(mu, eta, k) * mu
  }
  return Math.min(1, (2 * sum) / N)
}

// Band-integrated RGB reflectance at normal incidence, used for the denoiser
// albedo guide and the achromatic (BDPT) fallback. Integrating R(λ,μ=1) against
// the per-wavelength RGB weight (whose band mean is 1) yields exactly the RGB a
// spectral path converges to for a head-on view — gold comes out gold, etc.
export function conductorF0RGB(name: ConductorName): Vec3 {
  const N = 96
  let x = 0
  let y = 0
  let z = 0
  for (let i = 0; i < N; i++) {
    const lam = LAMBDA_MIN + ((i + 0.5) / N) * (LAMBDA_MAX - LAMBDA_MIN)
    const r = fresnelConductor(1, conductorEta(name, lam), conductorK(name, lam))
    const w = wavelengthWeight(lam)
    x += w.x * r
    y += w.y * r
    z += w.z * r
  }
  return v(x / N, y / N, z / N)
}
