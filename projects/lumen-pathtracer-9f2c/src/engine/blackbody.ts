// blackbody.ts — physically based light colour from temperature (Lumen 18.0).
//
// Until now every emitter in Lumen was given a raw RGB radiance. But real light
// sources don't have an RGB colour — they have a *temperature*. A tungsten filament
// glows at ~2700 K and is warm amber; an overcast sky is ~6500 K and neutral; a
// clear north sky is ~10000 K and distinctly blue. That progression — the warm→cool
// sweep every photographer knows as "colour temperature" — is the **Planckian
// locus**, the path a perfect blackbody traces through colour space as it heats up,
// and it is fixed by physics, not taste.
//
// This module computes it from scratch. `planck(λ,T)` is Planck's law (the spectral
// radiance of a blackbody); we integrate it against the **CIE 1931 colour-matching
// functions** (the analytic multi-Gaussian fit of Wyman, Sloan & Shirley 2013) to
// get the tristimulus XYZ the eye would see, then convert XYZ→linear sRGB with the
// standard matrix. The result is a unit-brightness *hue* a scene multiplies by its
// own intensity — so a light is specified the way a real one is: `blackbody(3200)`.
//
// It needs no new material or integrator code: a scene just calls `blackbody(K)`
// where it used to write an RGB triple. But it composes with the rest of the
// renderer's physical-optics machinery (the same visible band, the same linear-RGB
// pipeline), and the verify suite pins it to the textbook laws — Wien's displacement,
// Stefan–Boltzmann, and the locus's warm→neutral→cool progression.

import type { Vec3 } from './vec3'
import { v } from './vec3'

// The second radiation constant c₂ = hc/k_B, in nanometre·kelvin, so Planck's law
// can be evaluated with λ in nm directly: 1.438777e-2 m·K = 1.438777e7 nm·K.
const C2_NM_K = 1.438777e7

// Planck's law for spectral radiance, up to a temperature-independent constant (the
// leading 2hc² cancels under the normalisation below). Strictly positive for all
// λ>0, T>0. Shape only: ∝ λ⁻⁵ / (exp(c₂/(λT)) − 1).
export function planck(lambdaNm: number, tempK: number): number {
  const l = lambdaNm
  const x = C2_NM_K / (l * tempK)
  // expm1 keeps precision for the small-x (long-λ / hot) tail where exp(x)→1.
  return 1 / (l * l * l * l * l * Math.expm1(x))
}

// A single Gaussian lobe with separate left/right widths, the building block of the
// Wyman–Sloan–Shirley (2013) analytic fit to the CIE 1931 colour-matching functions.
function gaussian(lambda: number, mu: number, sigma1: number, sigma2: number): number {
  const t = (lambda - mu) / (lambda < mu ? sigma1 : sigma2)
  return Math.exp(-0.5 * t * t)
}

// The CIE 1931 2° colour-matching functions x̄(λ), ȳ(λ), z̄(λ), as the multi-lobe
// Gaussian approximation of Wyman, Sloan & Shirley, "Simple Analytic Approximations
// to the CIE XYZ Color Matching Functions" (JCGT 2013) — accurate to a few percent
// across the visible band, with no 1 nm table to ship.
export function cieXYZBar(lambda: number): Vec3 {
  const x =
    1.056 * gaussian(lambda, 599.8, 37.9, 31.0) +
    0.362 * gaussian(lambda, 442.0, 16.0, 26.7) -
    0.065 * gaussian(lambda, 501.1, 20.4, 26.2)
  const y = 0.821 * gaussian(lambda, 568.8, 46.9, 40.5) + 0.286 * gaussian(lambda, 530.9, 16.3, 31.1)
  const z = 1.217 * gaussian(lambda, 437.0, 11.8, 36.0) + 0.681 * gaussian(lambda, 459.0, 26.0, 13.8)
  return v(x, y, z)
}

// Integrate a blackbody at temperature `tempK` against the CIE CMFs to get its
// (unnormalised) XYZ tristimulus. A 5 nm Riemann sum over 360–830 nm — fine enough
// that the locus is smooth and Wien's peak is captured.
function blackbodyXYZ(tempK: number): Vec3 {
  let X = 0
  let Y = 0
  let Z = 0
  for (let lambda = 360; lambda <= 830; lambda += 5) {
    const p = planck(lambda, tempK)
    const bar = cieXYZBar(lambda)
    X += p * bar.x
    Y += p * bar.y
    Z += p * bar.z
  }
  return v(X, Y, Z)
}

// Linear sRGB (D65) from CIE XYZ — the standard matrix.
function xyzToLinearRGB(xyz: Vec3): Vec3 {
  return v(
    3.2406 * xyz.x - 1.5372 * xyz.y - 0.4986 * xyz.z,
    -0.9689 * xyz.x + 1.8758 * xyz.y + 0.0415 * xyz.z,
    0.0557 * xyz.x - 0.204 * xyz.y + 1.057 * xyz.z,
  )
}

// The linear-RGB **hue** of a blackbody at `tempK`, normalised so its brightest
// channel is 1 (a unit-brightness colour the scene scales by its own intensity).
// Warm (R-dominant) below ~5000 K, near-neutral around 6500 K, cool (B-dominant)
// above ~8000 K — the Planckian locus, computed not tabulated. Out-of-gamut
// negatives (deep in the locus) are clamped to 0, as a display must.
export function blackbody(tempK: number): Vec3 {
  const rgb = xyzToLinearRGB(blackbodyXYZ(tempK))
  const r = Math.max(0, rgb.x)
  const g = Math.max(0, rgb.y)
  const b = Math.max(0, rgb.z)
  const m = Math.max(r, g, b)
  return m > 0 ? v(r / m, g / m, b / m) : v(0, 0, 0)
}

// Convenience: a blackbody hue scaled to a given peak radiance, ready to drop into
// an emissive material's `emission`.
export function blackbodyEmission(tempK: number, intensity: number): Vec3 {
  const c = blackbody(tempK)
  return v(c.x * intensity, c.y * intensity, c.z * intensity)
}
