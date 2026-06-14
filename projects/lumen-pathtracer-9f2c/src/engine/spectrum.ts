// spectrum.ts — the bits of physical optics Lumen needs to render *dispersion*:
// the splitting of white light into a spectrum as it refracts through glass.
//
// A normal RGB path tracer treats glass as having one index of refraction, so a
// prism just bends light without colouring it. Real glass refracts blue light
// more strongly than red (its IOR rises toward shorter wavelengths), which is
// what fans sunlight into a rainbow. We model that with two ingredients:
//
//   • `cauchyIor` — Cauchy's empirical dispersion law n(λ) = n_D + B/λ², so a
//     material is given its reference index n_D (at the sodium D line, 589 nm)
//     plus a dispersion strength B (µm²); larger B ⇒ a wider rainbow.
//   • `wavelengthToRGB` — a perceptual map from a single wavelength to a linear
//     RGB colour, normalised so that an *equal-energy* (flat) spectrum integrates
//     back to neutral white. That normalisation is what keeps a dispersive glass
//     object colour-neutral overall while still tinting each refracted ray.
//
// The integrator uses these for "hero wavelength" spectral sampling: a path that
// enters a dispersive medium commits to one random wavelength, picks up the
// matching RGB weight once, and from then on refracts with that wavelength's IOR.

import type { Vec3 } from './vec3'
import { v } from './vec3'

// Visible-band limits used for hero-wavelength sampling.
export const LAMBDA_MIN = 380 // nm
export const LAMBDA_MAX = 720 // nm

// Cauchy's two-term dispersion relation, anchored so n(589 nm) === base.
//   n(λ) = base + B · (1/λ² − 1/λ_D²),  λ in micrometres, λ_D = 0.589 µm.
// B is the dispersion coefficient in µm²; B = 0 reproduces a non-dispersive glass.
export function cauchyIor(base: number, b: number, lambdaNm: number): number {
  const um = lambdaNm / 1000
  const refUm = 0.589
  return base + b * (1 / (um * um) - 1 / (refUm * refUm))
}

// Approximate a single wavelength as a linear-RGB colour. This is Dan Bruton's
// well-known piecewise fit (380–720 nm) with the near-UV/IR intensity roll-off,
// returned in *linear* RGB (no gamma) so it composes with the renderer's HDR
// pipeline. Values are un-normalised here; `wavelengthWeight` divides out the
// band's mean so a flat spectrum stays neutral.
export function wavelengthToRGB(lambda: number): Vec3 {
  let r = 0
  let g = 0
  let b = 0
  if (lambda >= 380 && lambda < 440) {
    r = -(lambda - 440) / (440 - 380)
    b = 1
  } else if (lambda < 490) {
    g = (lambda - 440) / (490 - 440)
    b = 1
  } else if (lambda < 510) {
    g = 1
    b = -(lambda - 510) / (510 - 490)
  } else if (lambda < 580) {
    r = (lambda - 510) / (580 - 510)
    g = 1
  } else if (lambda < 645) {
    r = 1
    g = -(lambda - 645) / (645 - 580)
  } else if (lambda <= 720) {
    r = 1
  }
  // Intensity falls off toward the edges of human vision.
  let f = 1
  if (lambda < 420) f = 0.3 + (0.7 * (lambda - 380)) / (420 - 380)
  else if (lambda > 700) f = 0.3 + (0.7 * (720 - lambda)) / (720 - 700)
  // sRGB-ish gamma 0.8 in the original fit; we keep it linear-friendly via **2.
  return v(r * f, g * f, b * f)
}

// The mean RGB of the band — precomputed once so the per-wavelength weight can be
// normalised to it. Without this an equal-energy spectrum would tint green
// (the eye's response peaks there), breaking the white point of dispersive glass.
const BAND_MEAN: Vec3 = (() => {
  const N = 512
  let x = 0
  let y = 0
  let z = 0
  for (let i = 0; i < N; i++) {
    const lambda = LAMBDA_MIN + ((i + 0.5) / N) * (LAMBDA_MAX - LAMBDA_MIN)
    const c = wavelengthToRGB(lambda)
    x += c.x
    y += c.y
    z += c.z
  }
  return v(x / N, y / N, z / N)
})()

// The RGB weight a path picks up when it commits to wavelength λ. Normalised per
// channel by the band mean so E_λ[weight] = (1,1,1): an undispersed white beam
// passing this estimator reconstructs to white, only its *spread* across λ tints
// the individual refracted rays.
export function wavelengthWeight(lambda: number): Vec3 {
  const c = wavelengthToRGB(lambda)
  return v(c.x / BAND_MEAN.x, c.y / BAND_MEAN.y, c.z / BAND_MEAN.z)
}
