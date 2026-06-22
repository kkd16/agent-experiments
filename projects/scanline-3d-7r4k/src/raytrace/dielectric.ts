// The optics of a smooth/rough dielectric interface — the missing half of surface
// light transport (every other pass here treats surfaces as opaque, reflecting only).
// Pure, allocation-free number math so the path tracer's inner loop can call it, and
// exported standalone so `dielectric_verify.ts` can re-derive every claim against a
// reference: the unpolarised Fresnel equations (not Schlick), Snell refraction with
// total internal reflection, Cauchy wavelength-dependent IOR for dispersion, the
// Smith G1 masking term for the rough lobe, and Beer–Lambert volumetric absorption.
import type { Vec3 } from '../math/vec.ts'

// The full unpolarised Fresnel reflectance at a dielectric interface, averaging the
// s- and p-polarised terms (Fresnel 1823) — exact, not the Schlick approximation the
// metallic BRDF uses. `cosThetaI` is the cosine of the incidence angle (≥ 0) measured
// against the interface normal; `etaI`/`etaT` are the IORs of the incident and
// transmitted media. Returns 1 under total internal reflection (no real transmitted
// ray exists past the critical angle sinθc = etaT/etaI).
export function fresnelDielectric(cosThetaI: number, etaI: number, etaT: number): number {
  const ci = cosThetaI < 0 ? 0 : cosThetaI > 1 ? 1 : cosThetaI
  // Snell: sinθt = (etaI/etaT)·sinθi
  const sinI = Math.sqrt(Math.max(0, 1 - ci * ci))
  const sinT = (etaI / etaT) * sinI
  if (sinT >= 1) return 1 // total internal reflection
  const cosT = Math.sqrt(Math.max(0, 1 - sinT * sinT))
  const rParl = (etaT * ci - etaI * cosT) / (etaT * ci + etaI * cosT)
  const rPerp = (etaI * ci - etaT * cosT) / (etaI * ci + etaT * cosT)
  return (rParl * rParl + rPerp * rPerp) * 0.5
}

// Snell refraction. `I` is the unit incident *propagation* direction (pointing into
// the surface); `N` is the unit interface normal on the incident side (so I·N < 0);
// `eta` = etaI/etaT (incident over transmitted). Writes the transmitted direction
// into `out` and returns true, or returns false on total internal reflection.
export function refract(
  ix: number, iy: number, iz: number,
  nx: number, ny: number, nz: number,
  eta: number, out: Float64Array,
): boolean {
  const cosI = -(ix * nx + iy * ny + iz * nz) // > 0 when N faces the incident side
  const k = 1 - eta * eta * (1 - cosI * cosI)
  if (k < 0) return false // TIR — no transmitted ray
  const c = eta * cosI - Math.sqrt(k)
  const tx = eta * ix + c * nx
  const ty = eta * iy + c * ny
  const tz = eta * iz + c * nz
  const l = Math.hypot(tx, ty, tz) || 1
  out[0] = tx / l; out[1] = ty / l; out[2] = tz / l
  return true
}

// Mirror reflection of the incident propagation direction `I` about normal `N`.
export function reflect(
  ix: number, iy: number, iz: number,
  nx: number, ny: number, nz: number,
  out: Float64Array,
): void {
  const d = 2 * (ix * nx + iy * ny + iz * nz)
  out[0] = ix - d * nx; out[1] = iy - d * ny; out[2] = iz - d * nz
}

// Wavelength-dependent IOR via a normalised Cauchy spread, so a single `ior` (taken
// at the green hero wavelength) fans into three channel IORs when `dispersion` > 0.
// Shorter wavelengths bend more (n_blue > n_green > n_red), exactly what splits a
// prism's beam into a spectrum. `channel`: 0 = R, 1 = G, 2 = B. `dispersion` is a
// dimensionless 0..1 strength (≈ inverse Abbe number, scaled for visible effect).
const CAUCHY_INV_LAMBDA2: [number, number, number] = [
  // 1/λ² at ~650/550/450 nm, recentred on green so green is unshifted
  1 / (0.65 * 0.65) - 1 / (0.55 * 0.55),
  0,
  1 / (0.45 * 0.45) - 1 / (0.55 * 0.55),
]
export function cauchyIor(ior: number, dispersion: number, channel: number): number {
  if (dispersion <= 0) return ior
  return ior + dispersion * 0.04 * CAUCHY_INV_LAMBDA2[channel]
}

// The Smith GGX single-direction masking term G1(cosθ) for roughness² = a. Bounded in
// [0,1]; used to shadow the rough-dielectric lobe so frosted glass loses energy at
// grazing rather than gaining it (no fireflies).
export function smithG1(cosTheta: number, a: number): number {
  const c = Math.abs(cosTheta)
  if (c <= 0) return 0
  return (2 * c) / (c + Math.sqrt(a * a + (1 - a * a) * c * c))
}

// Beer–Lambert transmittance through `distance` of an absorbing body whose per-channel
// absorption coefficient (1/world-unit) is `absorption`. This is what tints a thick
// coloured-glass body by the *path length* light travels inside it, not its surface.
export function beerLambert(absorption: Vec3, distance: number): Vec3 {
  return [
    Math.exp(-absorption[0] * distance),
    Math.exp(-absorption[1] * distance),
    Math.exp(-absorption[2] * distance),
  ]
}
