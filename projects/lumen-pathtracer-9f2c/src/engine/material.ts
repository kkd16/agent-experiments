// material.ts — physically based BSDFs.
//
// Every material exposes the same four-call contract so the integrator can stay
// agnostic about what it is shading:
//
//   sampleBSDF(mat, wo, n) → { wi, weight, pdf, specular } | null
//       Importance-sample an outgoing direction. `weight` is the *complete*
//       throughput multiplier (f·|cosθ|/pdf), so the integrator just does
//       β *= weight — no cosine bookkeeping leaks out of this module.
//   evalBSDF(mat, wo, wi, n) → f       (BSDF value, 0 for delta lobes)
//   pdfBSDF(mat, wo, wi, n)  → pdf     (solid-angle pdf, 0 for delta lobes)
//   isDelta(mat) → boolean             (true ⇒ skip next-event estimation)
//
// Directions are world-space and point *away* from the surface. We rotate into
// a local frame (z = shading normal) for the microfacet math, which is where
// GGX and the Smith shadowing terms are cleanest.

import type { Vec3 } from './vec3'
import { dot, onb, scale, toWorld, v } from './vec3'
import type { Rng } from './rng'
import type { Texture } from './texture'
import { evalTexture } from './texture'
import { cauchyIor } from './spectrum'

export type Material =
  // `tex`, when present, overrides `albedo` with a procedural pattern evaluated
  // at the hit point (resolved away before any BSDF call — see resolveMaterial).
  | { kind: 'diffuse'; albedo: Vec3; tex?: Texture }
  | { kind: 'metal'; albedo: Vec3; roughness: number; tex?: Texture }
  // Dielectric (glass/water). `tint` colours transmitted radiance; `roughness`
  // (0 = smooth) frosts it via a microfacet interface; `absorption` is the
  // Beer–Lambert coefficient σ_a (per world unit) applied to interior path
  // segments by the integrator; `cauchyB` (µm²) turns on wavelength dispersion.
  | { kind: 'dielectric'; ior: number; tint: Vec3; roughness?: number; absorption?: Vec3; cauchyB?: number }
  | { kind: 'emissive'; emission: Vec3 }

export interface BsdfSample {
  wi: Vec3
  weight: Vec3 // f * |cosθ_i| / pdf  (already divided through)
  pdf: number
  specular: boolean
  transmission?: boolean // true if the ray crossed the interface (refraction)
}

// Resolve any view-dependent material parameters into a plain, BSDF-ready
// material at a specific surface point and (for dispersion) hero wavelength:
//   • a procedural texture becomes a concrete albedo, and
//   • a dispersive dielectric's IOR is shifted to the path's wavelength.
// The hot BSDF code then never has to branch on textures or spectra.
export function resolveMaterial(m: Material, p: Vec3, lambdaNm: number): Material {
  switch (m.kind) {
    case 'diffuse':
      return m.tex ? { kind: 'diffuse', albedo: evalTexture(m.tex, p) } : m
    case 'metal':
      return m.tex ? { kind: 'metal', albedo: evalTexture(m.tex, p), roughness: m.roughness } : m
    case 'dielectric':
      return m.cauchyB && lambdaNm > 0 ? { ...m, ior: cauchyIor(m.ior, m.cauchyB, lambdaNm) } : m
    default:
      return m
  }
}

const ROUGHNESS_DELTA = 1e-3 // below this a metal is treated as a perfect mirror

export const isDelta = (m: Material): boolean =>
  m.kind === 'dielectric' || (m.kind === 'metal' && m.roughness < ROUGHNESS_DELTA)

// ---------------------------------------------------------------------------
// Fresnel
// ---------------------------------------------------------------------------

// Schlick approximation, evaluated per RGB channel (metals tint their F0).
function fresnelSchlick(cosTheta: number, f0: Vec3): Vec3 {
  const m = Math.max(0, 1 - cosTheta)
  const m2 = m * m
  const p = m2 * m2 * m // (1-cos)^5
  return {
    x: f0.x + (1 - f0.x) * p,
    y: f0.y + (1 - f0.y) * p,
    z: f0.z + (1 - f0.z) * p,
  }
}

// Exact unpolarised dielectric Fresnel reflectance. cosI is the cosine of the
// incident angle (positive); eta = etaI / etaT.
function fresnelDielectric(cosI: number, eta: number): number {
  const sin2T = eta * eta * Math.max(0, 1 - cosI * cosI)
  if (sin2T >= 1) return 1 // total internal reflection
  const cosT = Math.sqrt(1 - sin2T)
  const rParl = (eta * cosI - cosT) / (eta * cosI + cosT)
  const rPerp = (cosI - eta * cosT) / (cosI + eta * cosT)
  return 0.5 * (rParl * rParl + rPerp * rPerp)
}

// ---------------------------------------------------------------------------
// GGX / Trowbridge–Reitz microfacet model with Smith shadowing
// ---------------------------------------------------------------------------

function ggxD(nh: number, alpha: number): number {
  if (nh <= 0) return 0
  const a2 = alpha * alpha
  const d = nh * nh * (a2 - 1) + 1
  return a2 / (Math.PI * d * d)
}

// Smith Λ for the GGX distribution (used by the masking term G1).
function smithLambda(cosTheta: number, alpha: number): number {
  const c = Math.min(0.99999, Math.abs(cosTheta))
  const tan2 = (1 - c * c) / (c * c)
  return 0.5 * (-1 + Math.sqrt(1 + alpha * alpha * tan2))
}

const g1 = (cosTheta: number, alpha: number): number => 1 / (1 + smithLambda(cosTheta, alpha))
// Height-correlated Smith masking-shadowing.
const g2 = (cosO: number, cosI: number, alpha: number): number =>
  1 / (1 + smithLambda(cosO, alpha) + smithLambda(cosI, alpha))

// Sample the distribution of *visible* normals (Heitz 2018). Returns a local
// half-vector given a local outgoing direction `ve` (z = normal, ve.z > 0).
function sampleGGXVNDF(ve: Vec3, alpha: number, u1: number, u2: number): Vec3 {
  // Stretch the view direction to the hemisphere configuration.
  const vh = norm(v(alpha * ve.x, alpha * ve.y, ve.z))
  const lensq = vh.x * vh.x + vh.y * vh.y
  const t1 =
    lensq > 1e-12
      ? scale(v(-vh.y, vh.x, 0), 1 / Math.sqrt(lensq))
      : v(1, 0, 0)
  const t2 = { x: vh.y * t1.z - vh.z * t1.y, y: vh.z * t1.x - vh.x * t1.z, z: vh.x * t1.y - vh.y * t1.x }
  // Sample a point on the projected disk, then tilt it onto the hemisphere.
  const r = Math.sqrt(u1)
  const phi = 2 * Math.PI * u2
  const p1 = r * Math.cos(phi)
  let p2 = r * Math.sin(phi)
  const s = 0.5 * (1 + vh.z)
  p2 = (1 - s) * Math.sqrt(Math.max(0, 1 - p1 * p1)) + s * p2
  const pz = Math.sqrt(Math.max(0, 1 - p1 * p1 - p2 * p2))
  const nh = {
    x: p1 * t1.x + p2 * t2.x + pz * vh.x,
    y: p1 * t1.y + p2 * t2.y + pz * vh.y,
    z: p1 * t1.z + p2 * t2.z + pz * vh.z,
  }
  // Unstretch back to the ellipsoid configuration.
  return norm(v(alpha * nh.x, alpha * nh.y, Math.max(1e-6, nh.z)))
}

const norm = (a: Vec3): Vec3 => {
  const l = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
  return l > 0 ? { x: a.x / l, y: a.y / l, z: a.z / l } : v(0, 0, 1)
}

// ---------------------------------------------------------------------------
// Local-frame helpers
// ---------------------------------------------------------------------------

function worldToLocal(w: Vec3, t: Vec3, b: Vec3, n: Vec3): Vec3 {
  return { x: dot(w, t), y: dot(w, b), z: dot(w, n) }
}

const INV_PI = 1 / Math.PI

// ---------------------------------------------------------------------------
// Public BSDF interface
// ---------------------------------------------------------------------------

// `n` is the shading normal already oriented to face `woW` (the view direction).
// `frontFace` says whether the ray struck the geometry's outward side — only the
// dielectric needs it, to pick the index-of-refraction ratio.
export function sampleBSDF(
  m: Material,
  woW: Vec3,
  n: Vec3,
  frontFace: boolean,
  rng: Rng,
): BsdfSample | null {
  switch (m.kind) {
    case 'emissive':
      return null
    case 'diffuse': {
      const { t, b } = onb(n)
      // Cosine-weighted hemisphere: pdf = cosθ/π, so weight = albedo (f·cos/pdf).
      const r = Math.sqrt(rng.next())
      const phi = 2 * Math.PI * rng.next()
      const lx = r * Math.cos(phi)
      const ly = r * Math.sin(phi)
      const lz = Math.sqrt(Math.max(0, 1 - lx * lx - ly * ly))
      const wi = toWorld(v(lx, ly, lz), t, b, n)
      return { wi, weight: m.albedo, pdf: lz * INV_PI, specular: false }
    }
    case 'metal': {
      const { t, b } = onb(n)
      const wo = worldToLocal(woW, t, b, n)
      if (wo.z <= 0) return null
      if (m.roughness < ROUGHNESS_DELTA) {
        // Perfect mirror: a delta lobe handled analytically.
        const wi = v(-wo.x, -wo.y, wo.z)
        const F = fresnelSchlick(wo.z, m.albedo)
        return { wi: toWorld(wi, t, b, n), weight: F, pdf: 1, specular: true }
      }
      const alpha = m.roughness * m.roughness
      const h = sampleGGXVNDF(wo, alpha, rng.next(), rng.next())
      const woDotH = dot(wo, h)
      if (woDotH <= 0) return null
      // Reflect wo about the sampled microfacet normal h.
      const wi = v(2 * woDotH * h.x - wo.x, 2 * woDotH * h.y - wo.y, 2 * woDotH * h.z - wo.z)
      if (wi.z <= 0) return null
      const F = fresnelSchlick(woDotH, m.albedo)
      // With VNDF sampling the throughput f·cosθ_i/pdf collapses analytically to
      // F·G2(wo,wi)/G1(wo) — the cosine and the distribution term cancel.
      const gv = g1(wo.z, alpha)
      const G2 = g2(wo.z, wi.z, alpha)
      const weight = scale(F, G2 / gv)
      // Report the analytic pdf for MIS consistency with pdfBSDF.
      const D = ggxD(h.z, alpha)
      const pdf = (gv * D) / (4 * wo.z)
      return { wi: toWorld(wi, t, b, n), weight, pdf, specular: false }
    }
    case 'dielectric': {
      // `n` already faces the viewer, so it is the outward normal when the ray
      // hit the front and the inward normal when it hit the back.
      const etaI = frontFace ? 1 : m.ior
      const etaT = frontFace ? m.ior : 1
      const eta = etaI / etaT
      const rough = m.roughness ?? 0
      if (rough >= ROUGHNESS_DELTA) return sampleRoughDielectric(m, woW, n, eta, rough, rng)
      // Smooth dielectric: choose reflection or refraction stochastically by the
      // Fresnel reflectance, giving an unbiased single sample per bounce.
      const nl = n
      const cosI = Math.abs(dot(woW, nl))
      const F = fresnelDielectric(cosI, eta)
      if (rng.next() < F) {
        const wi = reflectAbout(scale(woW, -1), nl)
        return { wi, weight: v(1, 1, 1), pdf: F, specular: true }
      }
      // Refraction. wo points away from surface; the incident ray is -wo.
      const wi = refractDir(scale(woW, -1), nl, eta)
      if (!wi) {
        // Total internal reflection fallback (numerical safety).
        const r = reflectAbout(scale(woW, -1), nl)
        return { wi: r, weight: v(1, 1, 1), pdf: 1 - F, specular: true }
      }
      // Radiance transport across an interface scales by (etaT/etaI)^2... using
      // eta = etaI/etaT here means multiply by 1/eta^2.
      const radianceScale = 1 / (eta * eta)
      return {
        wi,
        weight: scale(m.tint, radianceScale),
        pdf: 1 - F,
        specular: true,
        transmission: true,
      }
    }
  }
}

// Rough (microfacet) dielectric — Walter et al. 2007 with Heitz VNDF sampling.
// We sample a microfacet half-vector h from the distribution of visible normals,
// evaluate Fresnel at the micro-angle, then stochastically reflect or refract the
// view ray about h. As in the metal case the VNDF throughput collapses to the
// Smith ratio G2(wo,wi)/G1(wo); choosing the lobe by Fresnel probability removes
// the F factor from the weight. The result is a glossy/frosted glass. We flag it
// `specular` so the integrator skips NEE (its transmission pdf is not derived for
// MIS) — correct, just noisier for sharp caustics than the smooth case.
function sampleRoughDielectric(
  m: { tint: Vec3 },
  woW: Vec3,
  n: Vec3,
  eta: number,
  roughness: number,
  rng: Rng,
): BsdfSample | null {
  const { t, b } = onb(n)
  const wo = worldToLocal(woW, t, b, n)
  if (wo.z <= 0) return null
  const alpha = roughness * roughness
  const h = sampleGGXVNDF(wo, alpha, rng.next(), rng.next()) // local, h.z > 0
  const woDotH = dot(wo, h)
  if (woDotH <= 0) return null
  const F = fresnelDielectric(woDotH, eta)
  const gv = g1(wo.z, alpha)
  if (rng.next() < F) {
    // Reflect wo about the microfacet normal h (stays in the upper hemisphere).
    const wi = v(2 * woDotH * h.x - wo.x, 2 * woDotH * h.y - wo.y, 2 * woDotH * h.z - wo.z)
    if (wi.z <= 0) return null
    const weight = scale(v(1, 1, 1), g2(wo.z, wi.z, alpha) / gv)
    return { wi: toWorld(wi, t, b, n), weight, pdf: 1, specular: true }
  }
  // Refract the incident ray (−wo) across the microfacet normal h.
  const wi = refractDir(v(-wo.x, -wo.y, -wo.z), h, eta)
  if (!wi || wi.z >= 0) {
    // TIR through this microfacet → reflect instead.
    const r = v(2 * woDotH * h.x - wo.x, 2 * woDotH * h.y - wo.y, 2 * woDotH * h.z - wo.z)
    if (r.z <= 0) return null
    const weight = scale(v(1, 1, 1), g2(wo.z, r.z, alpha) / gv)
    return { wi: toWorld(r, t, b, n), weight, pdf: 1, specular: true }
  }
  const radianceScale = 1 / (eta * eta)
  const weight = scale(m.tint, (g2(wo.z, Math.abs(wi.z), alpha) / gv) * radianceScale)
  return { wi: toWorld(wi, t, b, n), weight, pdf: 1, specular: true, transmission: true }
}

export function evalBSDF(m: Material, woW: Vec3, wiW: Vec3, n: Vec3): Vec3 {
  switch (m.kind) {
    case 'diffuse': {
      if (dot(wiW, n) <= 0 || dot(woW, n) <= 0) return v(0, 0, 0)
      return scale(m.albedo, INV_PI)
    }
    case 'metal': {
      if (m.roughness < ROUGHNESS_DELTA) return v(0, 0, 0)
      const { t, b } = onb(n)
      const wo = worldToLocal(woW, t, b, n)
      const wi = worldToLocal(wiW, t, b, n)
      if (wo.z <= 0 || wi.z <= 0) return v(0, 0, 0)
      const alpha = m.roughness * m.roughness
      const h = norm(v(wo.x + wi.x, wo.y + wi.y, wo.z + wi.z))
      const D = ggxD(h.z, alpha)
      const G = g2(wo.z, wi.z, alpha)
      const F = fresnelSchlick(Math.max(0, dot(wo, h)), m.albedo)
      const denom = 4 * wo.z * wi.z
      return scale(F, (D * G) / denom)
    }
    default:
      return v(0, 0, 0)
  }
}

export function pdfBSDF(m: Material, woW: Vec3, wiW: Vec3, n: Vec3): number {
  switch (m.kind) {
    case 'diffuse': {
      const c = dot(wiW, n)
      return c > 0 ? c * INV_PI : 0
    }
    case 'metal': {
      if (m.roughness < ROUGHNESS_DELTA) return 0
      const { t, b } = onb(n)
      const wo = worldToLocal(woW, t, b, n)
      const wi = worldToLocal(wiW, t, b, n)
      if (wo.z <= 0 || wi.z <= 0) return 0
      const alpha = m.roughness * m.roughness
      const h = norm(v(wo.x + wi.x, wo.y + wi.y, wo.z + wi.z))
      const D = ggxD(h.z, alpha)
      const gv = g1(wo.z, alpha)
      return (gv * D) / (4 * wo.z)
    }
    default:
      return 0
  }
}

// Reflect incident direction d (pointing toward surface) about unit normal n.
function reflectAbout(d: Vec3, n: Vec3): Vec3 {
  const c = dot(d, n)
  return { x: d.x - 2 * c * n.x, y: d.y - 2 * c * n.y, z: d.z - 2 * c * n.z }
}

// Refract incident direction d (toward surface, unit) across n with eta=etaI/etaT.
function refractDir(d: Vec3, n: Vec3, eta: number): Vec3 | null {
  const cosI = -dot(d, n)
  const sin2T = eta * eta * (1 - cosI * cosI)
  if (sin2T > 1) return null
  const cosT = Math.sqrt(1 - sin2T)
  return {
    x: eta * d.x + (eta * cosI - cosT) * n.x,
    y: eta * d.y + (eta * cosI - cosT) * n.y,
    z: eta * d.z + (eta * cosI - cosT) * n.z,
  }
}

export function emittedRadiance(m: Material): Vec3 {
  return m.kind === 'emissive' ? m.emission : v(0, 0, 0)
}
