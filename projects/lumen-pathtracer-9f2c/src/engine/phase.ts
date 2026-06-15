// phase.ts — the Henyey–Greenstein phase function, the volumetric analogue of a
// surface BSDF. Where a BSDF describes how a surface redistributes incident
// radiance over the hemisphere, a phase function describes how a *scattering
// event inside a medium* redistributes it over the whole sphere.
//
// HG is a one-parameter family controlled by the anisotropy g ∈ (−1, 1):
//   g = 0  → isotropic (uniform sphere): thick paint, dense smoke.
//   g > 0  → forward scattering: water droplets, haze lit from behind (god rays).
//   g < 0  → back scattering.
//
// We follow PBRT's convention: `wo` points *away* from the scattering point
// (back toward where the ray came from), exactly like a surface BSDF's `wo`, and
// the phase value is parameterised by cosθ = dot(wo, wi). The phase function is
// its own pdf (it integrates to 1 over the sphere and we sample it exactly), so
// `sampleHG` returns the analytic pdf for the very direction it generated — the
// same contract GGX VNDF sampling offers, which is what lets the integrator MIS
// a phase-sampled bounce against a next-event light sample.

import type { Vec3 } from './vec3'
import { onb } from './vec3'
import type { Rng } from './rng'

const INV_4PI = 1 / (4 * Math.PI)
const TWO_PI = 2 * Math.PI

// HG phase value p(cosθ), normalised so ∫_{S²} p dω = 1. cosθ = dot(wo, wi).
export function hgPhase(cosTheta: number, g: number): number {
  const g2 = g * g
  // (1 + g² + 2g·cosθ): the "+2g" pairs with the wo-convention (wo points back),
  // so forward scattering (g>0) peaks where wi ≈ −wo, i.e. cosθ ≈ −1.
  const denom = 1 + g2 + 2 * g * cosTheta
  return (INV_4PI * (1 - g2)) / (denom * Math.sqrt(Math.max(1e-9, denom)))
}

export interface PhaseSample {
  wi: Vec3
  pdf: number // == hgPhase(dot(wo, wi), g) — exact importance sampling
}

// Importance-sample a scattered direction about `wo` (unit). The inversion of
// the HG cdf gives cosθ in closed form; φ is uniform.
export function sampleHG(wo: Vec3, g: number, rng: Rng): PhaseSample {
  const u0 = rng.next()
  const u1 = rng.next()
  let cosTheta: number
  if (Math.abs(g) < 1e-3) {
    cosTheta = 1 - 2 * u0 // isotropic
  } else {
    const s = (1 - g * g) / (1 + g - 2 * g * u0)
    cosTheta = -(1 + g * g - s * s) / (2 * g)
  }
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta))
  const phi = TWO_PI * u1
  const { t, b } = onb(wo)
  const cp = Math.cos(phi)
  const sp = Math.sin(phi)
  const wi: Vec3 = {
    x: sinTheta * cp * t.x + sinTheta * sp * b.x + cosTheta * wo.x,
    y: sinTheta * cp * t.y + sinTheta * sp * b.y + cosTheta * wo.y,
    z: sinTheta * cp * t.z + sinTheta * sp * b.z + cosTheta * wo.z,
  }
  return { wi, pdf: hgPhase(cosTheta, g) }
}
