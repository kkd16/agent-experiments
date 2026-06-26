// spherelight.ts — next-event estimation for *emissive spheres* by sampling the
// solid angle they subtend (the classic uniform-cone sampler, PBRT §12.x).
//
// Until now Lumen's NEE sampled only triangle emitters: a flat triangle has a
// closed-form solid-angle pdf (d²/(cosθ·A)), so its MIS weights are exact, but a
// *sphere* has no such triangle pdf and was therefore left to BSDF sampling only
// (a scattered ray that happens to strike it) — which finds a small bright orb
// only a fraction of a percent of the time, so a sphere-lit room is a storm of
// fireflies (the whole point of the Glowing Orb scene). This module closes that
// gap with the textbook estimator.
//
// The set of directions from a shade point `ref` that hit a sphere of radius R a
// distance d away is exactly a CONE of half-angle θ_max with
//
//     sin θ_max = R / d        ⇒        cos θ_max = √(1 − R²/d²).
//
// Sampling a direction *uniformly inside that cone* gives a constant solid-angle
// density
//
//     p(ω) = 1 / Ω,      Ω = 2π (1 − cos θ_max)
//
// over the cone and 0 outside it — which importance-samples the 1/d² geometry of
// the emitter perfectly (every sample lands on the sphere, none is wasted on the
// surrounding dark). The same Ω drives the MIS weight when a BSDF-sampled ray
// instead lands on the sphere (see `sphereDirPdf`), so the two estimators stay
// consistent and the result is provably unbiased — only the variance drops.
//
// A reference point *inside* (or on) the sphere has no subtending cone (the
// emitter wraps the whole sky), so the sampler declines there and the surrounding
// transport falls back to BSDF sampling — a safe, unbiased no-op.

import type { Vec3 } from './vec3'
import { madd, normalize, onb, scale, toWorld, v } from './vec3'
import type { Rng } from './rng'

const TWO_PI = 2 * Math.PI

// A direction toward a sphere emitter, with the hit point's distance + normal and
// the solid-angle density it was drawn from. `pdf` is the *directional* density
// 1/Ω (it does NOT include the 1/numLights selection probability — the caller
// folds that in, exactly as it does for triangle and environment lights).
export interface SphereLightSample {
  wi: Vec3 // unit direction from `ref` toward the sampled point on the sphere
  dist: number // distance to that point (the near intersection)
  n: Vec3 // outward surface normal there (faces `ref` for the near cap)
  pdf: number // solid-angle pdf 1/Ω of having drawn `wi`
}

// cos θ_max of the cone a sphere of radius² `r2` subtends from distance² `d2`, or
// null when the reference point is inside/on the sphere (no subtending cone).
export function sphereConeCosMax(d2: number, r2: number): number | null {
  if (d2 <= r2) return null
  return Math.sqrt(Math.max(0, 1 - r2 / d2))
}

// Solid angle Ω = 2π(1 − cos θ_max) of a cone with the given cos θ_max.
export function sphereSolidAngle(cosMax: number): number {
  return TWO_PI * (1 - cosMax)
}

// The solid-angle pdf the cone sampler assigns to *any* direction that strikes
// this sphere (uniform within the subtended cone), used to MIS-weight a
// BSDF-sampled ray that lands on the emitter. Zero when `ref` is inside/on the
// sphere (the sampler declines there) — which correctly gives such a BSDF hit
// full MIS weight, since no NEE sample could have produced it.
export function sphereDirPdf(ref: Vec3, center: Vec3, radius: number): number {
  const dx = center.x - ref.x
  const dy = center.y - ref.y
  const dz = center.z - ref.z
  const d2 = dx * dx + dy * dy + dz * dz
  const r2 = radius * radius
  const cosMax = sphereConeCosMax(d2, r2)
  if (cosMax === null) return 0
  const omega = sphereSolidAngle(cosMax)
  return omega > 0 ? 1 / omega : 0
}

// Sample a direction toward the sphere uniformly within the subtended cone.
// Returns null when `ref` is inside/on the sphere. The hit distance is computed
// in closed form from the sampled cone angle (robust at the cone boundary, where
// re-intersecting the sampled ray would hit a grazing-tangent numerical edge):
// for a ray at angle θ to the centre direction, the near intersection is
//
//     dist = d·cosθ − √(R² − d²·sin²θ),
//
// the √ argument staying ≥ 0 for every θ ≤ θ_max by construction.
export function sampleSphereLight(
  ref: Vec3,
  center: Vec3,
  radius: number,
  rng: Rng,
): SphereLightSample | null {
  const dx = center.x - ref.x
  const dy = center.y - ref.y
  const dz = center.z - ref.z
  const d2 = dx * dx + dy * dy + dz * dz
  const r2 = radius * radius
  // A tiny margin keeps a shade point sitting *on* the emitter (d≈R) out of the
  // sampler, where cos θ_max → 0 and the cone degenerates.
  if (d2 <= r2 * (1 + 1e-6)) return null
  const d = Math.sqrt(d2)
  const cosMax = Math.sqrt(Math.max(0, 1 - r2 / d2))

  // Uniform-cone direction: cosθ ∈ [cosθ_max, 1], azimuth uniform.
  const u1 = rng.next()
  const u2 = rng.next()
  const cosT = 1 - u1 * (1 - cosMax)
  const sin2T = Math.max(0, 1 - cosT * cosT)
  const sinT = Math.sqrt(sin2T)
  const phi = TWO_PI * u2

  // Build the direction in the orthonormal frame whose +z axis points at the
  // sphere centre, then rotate to world.
  const w = v(dx / d, dy / d, dz / d)
  const { t, b } = onb(w)
  const wi = normalize(toWorld(v(Math.cos(phi) * sinT, Math.sin(phi) * sinT, cosT), t, b, w))

  // Closed-form near-intersection distance at cone angle θ (see header).
  const under = Math.max(0, r2 - d2 * sin2T)
  const dist = d * cosT - Math.sqrt(under)
  const point = madd(ref, wi, dist)
  const n = scale(v(point.x - center.x, point.y - center.y, point.z - center.z), 1 / radius)

  const omega = sphereSolidAngle(cosMax)
  return { wi, dist, n, pdf: omega > 0 ? 1 / omega : 0 }
}

// Analytic irradiance at a surface point from a *uniform* spherical luminaire of
// radiance L, fully above the surface's horizon: E = π·L·sin²θ_max·cosθ_c, where
// θ_c is the angle between the surface normal and the direction to the sphere
// centre. This is the exact form factor of a sphere — the ground truth the
// verify suite checks the cone-sampled NEE estimator against. Returns 0 when the
// sphere centre is below the horizon (a conservative stand-in; partial visibility
// is not modelled here because the proof places the sphere fully above it).
export function sphereIrradianceFull(
  ref: Vec3,
  normal: Vec3,
  center: Vec3,
  radius: number,
  radiance: number,
): number {
  const dx = center.x - ref.x
  const dy = center.y - ref.y
  const dz = center.z - ref.z
  const d2 = dx * dx + dy * dy + dz * dz
  const r2 = radius * radius
  if (d2 <= r2) return 0
  const d = Math.sqrt(d2)
  const cosC = (normal.x * dx + normal.y * dy + normal.z * dz) / d
  if (cosC <= 0) return 0
  const sin2Max = r2 / d2
  return Math.PI * radiance * sin2Max * cosC
}
