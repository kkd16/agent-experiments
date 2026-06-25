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
import { add, dot, onb, scale, toWorld, v } from './vec3'
import { Rng } from './rng'
import type { Texture } from './texture'
import { evalTexture } from './texture'
import { cauchyIor } from './spectrum'
import { thinFilmReflectance } from './thinfilm'
import type { ConductorName } from './conductor'
import { conductorAverageFresnel, conductorEta, conductorK, fresnelConductor } from './conductor'

// A clear dielectric coat layered over a diffuse base (lacquer / car paint /
// glazed ceramic). `roughness` frosts the coat's GGX highlight (0 = a sharp
// gloss); `ior` is the coat's index of refraction (≈1.5 for varnish); `tint`,
// when present, colours the light that passes *through* the coat to the base
// (a coloured glaze). The coat reflects a Fresnel fraction as a specular lobe
// and transmits the rest to the base, attenuating it by (1−F) on the way in and
// out so the layered stack still conserves energy.
export interface Coat {
  roughness: number
  ior: number
  tint?: Vec3
}

// A homogeneous scattering medium filling a dielectric's *interior*, turning the
// glass into a translucent solid — marble, wax, jade, milk, skin. Light refracts
// in through the dielectric's Fresnel boundary, then random-walks among
// microscopic scatterers before refracting back out: the hallmark "subsurface"
// glow that a surface BRDF can never produce. `sigmaT` is the scalar extinction
// (collisions per world unit, so 1/σ_t is the mean free path); `albedo` is the
// single-scattering albedo σ_s/σ_t — *per channel*, since its hue is exactly what
// tints the translucency (1−albedo is the fraction absorbed at each collision, so
// a low-albedo channel darkens with depth); `g` is the Henyey–Greenstein
// anisotropy of the interior phase function (forward, g>0, for most organic
// media). The boundary is the dielectric's own interface, so the surface still
// reflects a Fresnel sheen and total-internal-reflection traps light inside — all
// reusing the existing smooth/rough dielectric BSDF, with the random walk run by
// the integrator (see `radiance`). Present ⇒ the dielectric is translucent;
// absent ⇒ it is ordinary glass (clear, or Beer–Lambert `absorption`-tinted).
export interface Subsurface {
  sigmaT: number
  albedo: Vec3
  g: number
  // (15.0) Optional **chromatic mean free path**: per-channel extinction and
  // single-scattering albedo, read as 3-point spectra at the R/G/B representative
  // wavelengths (see subsurface.ts). When present the dielectric becomes
  // `isSpectral`, so the path commits a hero wavelength λ at the boundary and the
  // interior walk runs *monochromatically* with σ_t(λ)/ϖ(λ) — red light reaching
  // far while blue scatters out near the surface (real skin/marble/milk). Absent ⇒
  // the scalar 12.0 walk (one mean free path for every colour), bit-for-bit.
  sigmaTSpectral?: Vec3
  albedoSpectral?: Vec3
}

export type Material =
  // `tex`, when present, overrides `albedo` with a procedural pattern evaluated
  // at the hit point (resolved away before any BSDF call — see resolveMaterial).
  // `sigma` (radians) turns Lambert into a rough-diffuse Oren–Nayar surface
  // (chalk / clay / unfinished plaster); `coat` layers a clear dielectric gloss
  // over the base (ceramic / lacquer / car paint).
  | { kind: 'diffuse'; albedo: Vec3; tex?: Texture; sigma?: number; coat?: Coat }
  // `multiscatter` adds Kulla–Conty energy compensation so rough metals stop
  // darkening (they recover the energy single-scatter GGX drops between
  // microfacets); `aniso` ∈ [0,1) stretches the GGX lobe into an anisotropic
  // (brushed-metal) streak, oriented by `anisoAngle` (radians in the tangent
  // plane). `aniso` and `multiscatter` are independent upgrades to the lobe.
  // `spectrum` names a real metal (gold/copper/silver/…): the Schlick-from-RGB
  // Fresnel is then replaced by the exact complex-IOR conductor Fresnel evaluated
  // at the path's committed hero wavelength (so the metal is `isSpectral` and its
  // hue emerges spectrally, like dispersion through glass). `albedo` is still used
  // as the denoiser/BDPT colour guide (set it to conductorF0RGB(name)). `cond` is
  // baked by resolveMaterial — the scalar (η,k) and hemispherical average at the
  // hero wavelength — and is never set by scenes.
  | {
      kind: 'metal'
      albedo: Vec3
      roughness: number
      tex?: Texture
      multiscatter?: boolean
      aniso?: number
      anisoAngle?: number
      spectrum?: ConductorName
      cond?: { eta: number; k: number; favg: number }
    }
  // Dielectric (glass/water). `tint` colours transmitted radiance; `roughness`
  // (0 = smooth) frosts it via a microfacet interface; `absorption` is the
  // Beer–Lambert coefficient σ_a (per world unit) applied to interior path
  // segments by the integrator; `cauchyB` (µm²) turns on wavelength dispersion;
  // `interior`, when present, fills the solid with a scattering medium so it
  // renders as a **translucent / subsurface** material (the integrator random-
  // walks inside it) instead of clear glass (see `Subsurface`).
  | {
      kind: 'dielectric'
      ior: number
      tint: Vec3
      roughness?: number
      absorption?: Vec3
      cauchyB?: number
      interior?: Subsurface
    }
  // A thin-film-coated specular reflector (iridescent). `thickness` (nm) and
  // `filmIor` set the interference; `baseIor` is the substrate the film coats;
  // `base`, when present, tints the reflection (e.g. a coloured metal under the
  // film). Reflectance is spectral, so the integrator commits a hero wavelength
  // (see isSpectral) and `lambda` is baked in by resolveMaterial before shading.
  | { kind: 'thinfilm'; thickness: number; filmIor: number; baseIor: number; base?: Vec3; lambda?: number }
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
      return m.tex ? { ...m, albedo: evalTexture(m.tex, p), tex: undefined } : m
    case 'metal': {
      let r = m
      if (r.tex) r = { ...r, albedo: evalTexture(r.tex, p), tex: undefined }
      // Bake the measured complex index at the hero wavelength into a scalar
      // (η,k) + hemispherical average. At λ=0 (the achromatic BDPT path) we leave
      // `cond` unset, so the lobe falls back to Schlick(albedo) — albedo already
      // carries the metal's band-integrated RGB, giving a sensible colour there.
      if (r.spectrum && lambdaNm > 0) {
        const eta = conductorEta(r.spectrum, lambdaNm)
        const k = conductorK(r.spectrum, lambdaNm)
        r = { ...r, cond: { eta, k, favg: conductorAverageFresnel(eta, k) } }
      }
      return r
    }
    case 'dielectric':
      return m.cauchyB && lambdaNm > 0 ? { ...m, ior: cauchyIor(m.ior, m.cauchyB, lambdaNm) } : m
    case 'thinfilm':
      return lambdaNm > 0 ? { ...m, lambda: lambdaNm } : m
    default:
      return m
  }
}

const ROUGHNESS_DELTA = 1e-3 // below this a metal is treated as a perfect mirror

export const isDelta = (m: Material): boolean =>
  m.kind === 'dielectric' ||
  m.kind === 'thinfilm' ||
  (m.kind === 'metal' && m.roughness < ROUGHNESS_DELTA)

// True for materials whose response varies with wavelength, so the integrator
// must commit a hero wavelength before shading them (dispersive glass; a film).
export const isSpectral = (m: Material): boolean =>
  m.kind === 'thinfilm' ||
  (m.kind === 'dielectric' && m.cauchyB !== undefined && m.cauchyB > 0) ||
  // (15.0) A translucent dielectric whose interior carries a chromatic mean free
  // path: the path must commit a hero wavelength at the boundary so the interior
  // random walk can use the per-wavelength extinction/albedo.
  (m.kind === 'dielectric' && m.interior?.sigmaTSpectral !== undefined) ||
  (m.kind === 'metal' && m.spectrum !== undefined)

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

// A conductor's reflectance is described either by an RGB Schlick F0 (the legacy
// metal: `albedo` is F0) or by a measured complex index η−ik baked at the hero
// wavelength (`spectrum` metals). Both feed every microfacet lobe through the two
// helpers below, so a metal can be spectral, anisotropic and multiscatter-
// compensated at once without any lobe ever branching on which Fresnel it has.
type FresnelSpec = { f0: Vec3 } | { eta: number; k: number; favg: number }

// Fresnel reflectance at micro-angle `cos`, as an RGB triple. The complex-IOR
// branch is a scalar (a metal reflects one fraction per wavelength); colour comes
// from the path's committed hero wavelength, so we broadcast it to grey here.
function fresnelSpec(cos: number, fr: FresnelSpec): Vec3 {
  if ('eta' in fr) {
    const r = fresnelConductor(cos, fr.eta, fr.k)
    return { x: r, y: r, z: r }
  }
  return fresnelSchlick(cos, fr.f0)
}

// The cosine-weighted hemispherical-average Fresnel a lobe needs for Kulla–Conty
// multiscatter compensation: the analytic Schlick average for an RGB F0, or the
// measured conductor average baked into `cond`.
function fresnelAvgSpec(fr: FresnelSpec): Vec3 {
  if ('eta' in fr) return { x: fr.favg, y: fr.favg, z: fr.favg }
  return fresnelAvg(fr.f0)
}

// The Fresnel description of a (resolved) metal: complex-IOR if a spectrum was
// baked, otherwise Schlick with albedo as F0.
function metalFresnel(m: Extract<Material, { kind: 'metal' }>): FresnelSpec {
  return m.cond ? { eta: m.cond.eta, k: m.cond.k, favg: m.cond.favg } : { f0: m.albedo }
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

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const INV_PI = 1 / Math.PI

// ---------------------------------------------------------------------------
// Shared local-frame microfacet helpers (z = shading normal). These centralise
// the GGX reflection BRDF value and its VNDF solid-angle pdf so that sampling,
// evaluation, and pdf queries can never drift out of sync — which is what keeps
// next-event-estimation and BDPT's MIS weights correct.
// ---------------------------------------------------------------------------

// GGX reflection BRDF f = F·D·G2 / (4 cosθo cosθi), local frame, wo.z,wi.z > 0.
function ggxReflectFLocal(wo: Vec3, wi: Vec3, alpha: number, fr: FresnelSpec): Vec3 {
  if (wo.z <= 0 || wi.z <= 0) return v(0, 0, 0)
  const h = norm(v(wo.x + wi.x, wo.y + wi.y, wo.z + wi.z))
  const D = ggxD(h.z, alpha)
  const G = g2(wo.z, wi.z, alpha)
  // For a reflection half-vector dot(wo,h) === dot(wi,h), so F is reciprocal.
  const F = fresnelSpec(Math.max(0, dot(wo, h)), fr)
  return scale(F, (D * G) / (4 * wo.z * wi.z))
}

// Solid-angle pdf of the GGX VNDF reflection sampler, local frame.
function ggxReflectPdfLocal(wo: Vec3, wi: Vec3, alpha: number): number {
  if (wo.z <= 0 || wi.z <= 0) return 0
  const h = norm(v(wo.x + wi.x, wo.y + wi.y, wo.z + wi.z))
  const D = ggxD(h.z, alpha)
  const gv = g1(wo.z, alpha)
  return (gv * D) / (4 * wo.z)
}

// Cosine-weighted hemisphere sample (local frame).
function cosineSample(u1: number, u2: number): Vec3 {
  const r = Math.sqrt(u1)
  const phi = 2 * Math.PI * u2
  return v(r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(Math.max(0, 1 - u1)))
}

// ---------------------------------------------------------------------------
// Anisotropic GGX (Heitz 2014). The isotropic case (αx = αy) reduces to the
// formulae above exactly, so brushed metals reuse the same VNDF machinery with
// two roughness axes in the (rotated) tangent frame.
// ---------------------------------------------------------------------------

function ggxDAniso(h: Vec3, ax: number, ay: number): number {
  if (h.z <= 0) return 0
  const t = (h.x * h.x) / (ax * ax) + (h.y * h.y) / (ay * ay) + h.z * h.z
  return 1 / (Math.PI * ax * ay * t * t)
}

function smithLambdaAniso(w: Vec3, ax: number, ay: number): number {
  const c = Math.abs(w.z)
  if (c < 1e-6) return 0
  const t2 = (ax * ax * w.x * w.x + ay * ay * w.y * w.y) / (c * c)
  return 0.5 * (-1 + Math.sqrt(1 + t2))
}
const g1A = (w: Vec3, ax: number, ay: number): number => 1 / (1 + smithLambdaAniso(w, ax, ay))
const g2A = (wo: Vec3, wi: Vec3, ax: number, ay: number): number =>
  1 / (1 + smithLambdaAniso(wo, ax, ay) + smithLambdaAniso(wi, ax, ay))

function sampleGGXVNDFAniso(ve: Vec3, ax: number, ay: number, u1: number, u2: number): Vec3 {
  const vh = norm(v(ax * ve.x, ay * ve.y, ve.z))
  const lensq = vh.x * vh.x + vh.y * vh.y
  const t1 = lensq > 1e-12 ? scale(v(-vh.y, vh.x, 0), 1 / Math.sqrt(lensq)) : v(1, 0, 0)
  const t2 = { x: vh.y * t1.z - vh.z * t1.y, y: vh.z * t1.x - vh.x * t1.z, z: vh.x * t1.y - vh.y * t1.x }
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
  return norm(v(ax * nh.x, ay * nh.y, Math.max(1e-6, nh.z)))
}

// Map a (roughness, anisotropy) pair to the two GGX axis roughnesses. aspect
// follows Disney: aspect = √(1 − 0.9·aniso), so aniso → 1 elongates the lobe.
function anisoAlphas(roughness: number, aniso: number): { ax: number; ay: number } {
  const a = roughness * roughness
  const aspect = Math.sqrt(Math.max(1e-3, 1 - 0.9 * clamp01(aniso)))
  return { ax: Math.max(1e-3, a / aspect), ay: Math.max(1e-3, a * aspect) }
}

// ---------------------------------------------------------------------------
// Kulla–Conty multiple-scattering energy compensation (Kulla & Conty 2017).
//
// A single-scatter microfacet lobe drops the energy that would have bounced
// multiple times between microfacets, so rough conductors darken unphysically.
// We restore it with an added compensation lobe whose strength is set by the
// *directional albedo* E(μ,α) — the fraction of energy the single-scatter GGX
// lobe (white, F=1) actually reflects — precomputed once into a small table.
// The compensation BRDF
//   f_ms(wo,wi) = Fms · (1−E(μo))(1−E(μi)) / (π (1−Eavg))
// integrates to exactly (1−E(μo)) for white, so single + multi reflect ≈ 1.
// ---------------------------------------------------------------------------

const E_MU = 32 // directional-cosine resolution
const E_AL = 32 // roughness (alpha) resolution
const ggxE = new Float64Array(E_MU * E_AL) // E(μ,α): single-scatter directional albedo
const ggxEavg = new Float64Array(E_AL) // Eavg(α): cosine-weighted hemisphere average

function buildGgxAlbedoTable(): void {
  const rng = new Rng(0x5eed1e, 11)
  const SAMPLES = 2048
  for (let ai = 0; ai < E_AL; ai++) {
    const alpha = Math.max(1e-3, (ai + 0.5) / E_AL) // α ∈ (0,1]
    let avg = 0
    for (let mi = 0; mi < E_MU; mi++) {
      const mu = Math.max(1e-3, (mi + 0.5) / E_MU) // μ = cosθo ∈ (0,1]
      const wo = v(Math.sqrt(Math.max(0, 1 - mu * mu)), 0, mu)
      let sum = 0
      for (let s = 0; s < SAMPLES; s++) {
        const h = sampleGGXVNDF(wo, alpha, rng.next(), rng.next())
        const woDotH = dot(wo, h)
        if (woDotH <= 0) continue
        const wi = v(2 * woDotH * h.x - wo.x, 2 * woDotH * h.y - wo.y, 2 * woDotH * h.z - wo.z)
        if (wi.z <= 0) continue
        // VNDF throughput for white F=1 collapses to G2/G1 — exactly the
        // per-sample estimator of the single-scatter directional albedo.
        sum += g2(wo.z, wi.z, alpha) / g1(wo.z, alpha)
      }
      const e = sum / SAMPLES
      ggxE[ai * E_MU + mi] = e
      avg += 2 * e * mu * (1 / E_MU) // Eavg = 2∫₀¹ E(μ)μ dμ
    }
    ggxEavg[ai] = avg
  }
}
buildGgxAlbedoTable()

// Bilinearly sample the single-scatter directional albedo E(μ,α).
export function ggxDirectionalAlbedo(mu: number, alpha: number): number {
  const x = clamp01(mu) * E_MU - 0.5
  const y = clamp01(alpha) * E_AL - 0.5
  const x0 = Math.max(0, Math.min(E_MU - 1, Math.floor(x)))
  const y0 = Math.max(0, Math.min(E_AL - 1, Math.floor(y)))
  const x1 = Math.min(E_MU - 1, x0 + 1)
  const y1 = Math.min(E_AL - 1, y0 + 1)
  const tx = clamp01(x - x0)
  const ty = clamp01(y - y0)
  const e0 = lerp(ggxE[y0 * E_MU + x0], ggxE[y0 * E_MU + x1], tx)
  const e1 = lerp(ggxE[y1 * E_MU + x0], ggxE[y1 * E_MU + x1], tx)
  return lerp(e0, e1, ty)
}

// Linearly sample the hemisphere-averaged single-scatter albedo Eavg(α).
export function ggxAverageAlbedo(alpha: number): number {
  const y = clamp01(alpha) * E_AL - 0.5
  const y0 = Math.max(0, Math.min(E_AL - 1, Math.floor(y)))
  const y1 = Math.min(E_AL - 1, y0 + 1)
  return lerp(ggxEavg[y0], ggxEavg[y1], clamp01(y - y0))
}

// Average Fresnel of a Schlick conductor over the cosine-weighted hemisphere:
// Favg = F0 + (1−F0)/21 (the analytic integral of Schlick).
function fresnelAvg(f0: Vec3): Vec3 {
  return { x: f0.x + (1 - f0.x) / 21, y: f0.y + (1 - f0.y) / 21, z: f0.z + (1 - f0.z) / 21 }
}

// Coloured multiscatter Fresnel factor Fms = Favg²·Eavg / (1 − Favg(1−Eavg)).
function multiscatterFresnel(favg: Vec3, eavg: number): Vec3 {
  const f = (a: number): number => (a * a * eavg) / Math.max(1e-4, 1 - a * (1 - eavg))
  return { x: f(favg.x), y: f(favg.y), z: f(favg.z) }
}

// Total energy-compensated conductor BRDF: single-scatter GGX + Kulla–Conty
// multiscatter lobe (local frame). `fr` carries either the Schlick RGB F0 or the
// measured complex-IOR Fresnel; the multiscatter Fresnel uses the matching
// hemispherical average, so spectral metals are energy-compensated correctly too.
function metalMsFLocal(wo: Vec3, wi: Vec3, alpha: number, fr: FresnelSpec, eo: number): Vec3 {
  const fs = ggxReflectFLocal(wo, wi, alpha, fr)
  const ei = ggxDirectionalAlbedo(wi.z, alpha)
  const eavg = ggxAverageAlbedo(alpha)
  const fms = multiscatterFresnel(fresnelAvgSpec(fr), eavg)
  const k = ((1 - eo) * (1 - ei)) / (Math.PI * Math.max(1e-4, 1 - eavg))
  return add(fs, scale(fms, k))
}

// ---------------------------------------------------------------------------
// Oren–Nayar rough-diffuse reflectance (qualitative model, 1994). Reciprocal in
// (wo,wi) and energy-bounded; reduces to Lambert at σ = 0. Local frame.
// ---------------------------------------------------------------------------

function orenNayarFLocal(albedo: Vec3, sigma: number, wo: Vec3, wi: Vec3): Vec3 {
  if (wo.z <= 0 || wi.z <= 0) return v(0, 0, 0)
  const s2 = sigma * sigma
  const A = 1 - 0.5 * (s2 / (s2 + 0.33))
  const B = 0.45 * (s2 / (s2 + 0.09))
  const sinO = Math.sqrt(Math.max(0, 1 - wo.z * wo.z))
  const sinI = Math.sqrt(Math.max(0, 1 - wi.z * wi.z))
  let maxCos = 0
  if (sinO > 1e-4 && sinI > 1e-4) {
    const cosDPhi = (wo.x * wi.x + wo.y * wi.y) / (sinO * sinI)
    maxCos = Math.max(0, cosDPhi)
  }
  const minZ = Math.min(wo.z, wi.z)
  const maxZ = Math.max(wo.z, wi.z)
  const sinAlpha = Math.sqrt(Math.max(0, 1 - minZ * minZ)) // sin of the larger angle
  const tanBeta = Math.sqrt(Math.max(0, 1 - maxZ * maxZ)) / Math.max(1e-4, maxZ)
  const f = (A + B * maxCos * sinAlpha * tanBeta) * INV_PI
  return scale(albedo, f)
}

// ---------------------------------------------------------------------------
// Clear-coat helpers. The coat is a grey Schlick dielectric (F0 from its IOR).
// ---------------------------------------------------------------------------

function coatF0(ior: number): number {
  const r = (ior - 1) / (ior + 1)
  return r * r
}
const schlickScalar = (cos: number, f0: number): number => {
  const m = Math.max(0, 1 - cos)
  return f0 + (1 - f0) * m * m * m * m * m
}

// ---------------------------------------------------------------------------
// Local-frame helpers
// ---------------------------------------------------------------------------

function worldToLocal(w: Vec3, t: Vec3, b: Vec3, n: Vec3): Vec3 {
  return { x: dot(w, t), y: dot(w, b), z: dot(w, n) }
}

// A tangent frame rotated by `angle` about the normal — used to orient the
// anisotropic GGX streak (brushed metal) in the shading plane.
function rotatedFrame(n: Vec3, angle: number): { t: Vec3; b: Vec3 } {
  const { t, b } = onb(n)
  if (!angle) return { t, b }
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return {
    t: { x: c * t.x + s * b.x, y: c * t.y + s * b.y, z: c * t.z + s * b.z },
    b: { x: -s * t.x + c * b.x, y: -s * t.y + c * b.y, z: -s * t.z + c * b.z },
  }
}

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
    case 'thinfilm': {
      // A delta-specular mirror whose reflectance is the wavelength-dependent
      // Airy reflectance of the film. The path has already committed a hero
      // wavelength (β scaled by its RGB weight), so a scalar reflectance here
      // reconstructs the iridescent colour over many samples.
      const { t, b } = onb(n)
      const wo = worldToLocal(woW, t, b, n)
      if (wo.z <= 0) return null
      const lam = m.lambda && m.lambda > 0 ? m.lambda : 550
      const R = thinFilmReflectance(wo.z, lam, m.thickness, m.filmIor, m.baseIor)
      const wi = v(-wo.x, -wo.y, wo.z)
      const tint = m.base ?? v(1, 1, 1)
      return { wi: toWorld(wi, t, b, n), weight: scale(tint, R), pdf: 1, specular: true }
    }
    case 'diffuse': {
      if (m.sigma || m.coat) return sampleDiffuseLayered(m, woW, n, rng)
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
      const { t, b } = m.aniso ? rotatedFrame(n, m.anisoAngle ?? 0) : onb(n)
      const wo = worldToLocal(woW, t, b, n)
      if (wo.z <= 0) return null
      const fr = metalFresnel(m)
      if (m.roughness < ROUGHNESS_DELTA) {
        // Perfect mirror: a delta lobe handled analytically.
        const wi = v(-wo.x, -wo.y, wo.z)
        const F = fresnelSpec(wo.z, fr)
        return { wi: toWorld(wi, t, b, n), weight: F, pdf: 1, specular: true }
      }
      if (m.aniso) return sampleMetalAniso(m, wo, t, b, n, rng)
      if (m.multiscatter) return sampleMetalMs(m, wo, t, b, n, rng)
      const alpha = m.roughness * m.roughness
      const h = sampleGGXVNDF(wo, alpha, rng.next(), rng.next())
      const woDotH = dot(wo, h)
      if (woDotH <= 0) return null
      // Reflect wo about the sampled microfacet normal h.
      const wi = v(2 * woDotH * h.x - wo.x, 2 * woDotH * h.y - wo.y, 2 * woDotH * h.z - wo.z)
      if (wi.z <= 0) return null
      const F = fresnelSpec(woDotH, fr)
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

// ---------------------------------------------------------------------------
// Energy-compensated and anisotropic conductors + layered diffuse. Each material
// keeps sampleX / evalXLocal / pdfXLocal in lockstep so MIS stays consistent.
// ---------------------------------------------------------------------------

type MetalMat = Extract<Material, { kind: 'metal' }>
type DiffuseMat = Extract<Material, { kind: 'diffuse' }>

// Anisotropic GGX reflection BRDF (local, rotated tangent frame).
function ggxReflectFLocalAniso(wo: Vec3, wi: Vec3, ax: number, ay: number, fr: FresnelSpec): Vec3 {
  if (wo.z <= 0 || wi.z <= 0) return v(0, 0, 0)
  const h = norm(v(wo.x + wi.x, wo.y + wi.y, wo.z + wi.z))
  const D = ggxDAniso(h, ax, ay)
  const G = g2A(wo, wi, ax, ay)
  const F = fresnelSpec(Math.max(0, dot(wo, h)), fr)
  return scale(F, (D * G) / (4 * wo.z * wi.z))
}
function ggxReflectPdfLocalAniso(wo: Vec3, wi: Vec3, ax: number, ay: number): number {
  if (wo.z <= 0 || wi.z <= 0) return 0
  const h = norm(v(wo.x + wi.x, wo.y + wi.y, wo.z + wi.z))
  return (g1A(wo, ax, ay) * ggxDAniso(h, ax, ay)) / (4 * wo.z)
}

// --- Anisotropic (brushed) metal: VNDF throughput collapses to F·G2/G1. ---
function sampleMetalAniso(m: MetalMat, wo: Vec3, t: Vec3, b: Vec3, n: Vec3, rng: Rng): BsdfSample | null {
  const { ax, ay } = anisoAlphas(m.roughness, m.aniso ?? 0)
  const h = sampleGGXVNDFAniso(wo, ax, ay, rng.next(), rng.next())
  const woDotH = dot(wo, h)
  if (woDotH <= 0) return null
  const wi = v(2 * woDotH * h.x - wo.x, 2 * woDotH * h.y - wo.y, 2 * woDotH * h.z - wo.z)
  if (wi.z <= 0) return null
  const F = fresnelSpec(woDotH, metalFresnel(m))
  const weight = scale(F, g2A(wo, wi, ax, ay) / g1A(wo, ax, ay))
  const pdf = (g1A(wo, ax, ay) * ggxDAniso(h, ax, ay)) / (4 * wo.z)
  return { wi: toWorld(wi, t, b, n), weight, pdf, specular: false }
}

// --- Multiscatter (Kulla–Conty) metal: GGX single lobe mixed with a cosine
// compensation lobe, weighted by the single-scatter directional albedo. ---
function metalMsLobeProb(eo: number): number {
  return Math.min(0.95, Math.max(0.05, eo))
}
function sampleMetalMs(m: MetalMat, wo: Vec3, t: Vec3, b: Vec3, n: Vec3, rng: Rng): BsdfSample | null {
  const alpha = m.roughness * m.roughness
  const eo = ggxDirectionalAlbedo(wo.z, alpha)
  const ps = metalMsLobeProb(eo)
  let wi: Vec3
  if (rng.next() < ps) {
    const h = sampleGGXVNDF(wo, alpha, rng.next(), rng.next())
    const woDotH = dot(wo, h)
    if (woDotH <= 0) return null
    wi = v(2 * woDotH * h.x - wo.x, 2 * woDotH * h.y - wo.y, 2 * woDotH * h.z - wo.z)
    if (wi.z <= 0) return null
  } else {
    wi = cosineSample(rng.next(), rng.next())
  }
  const f = metalMsFLocal(wo, wi, alpha, metalFresnel(m), eo)
  const pdf = ps * ggxReflectPdfLocal(wo, wi, alpha) + (1 - ps) * wi.z * INV_PI
  if (pdf <= 0) return null
  return { wi: toWorld(wi, t, b, n), weight: scale(f, wi.z / pdf), pdf, specular: false }
}

// --- Layered diffuse (Oren–Nayar base ± clear dielectric coat). ---
function diffuseBaseFLocal(m: DiffuseMat, wo: Vec3, wi: Vec3): Vec3 {
  let base = m.sigma ? orenNayarFLocal(m.albedo, m.sigma, wo, wi) : scale(m.albedo, INV_PI)
  if (m.coat) {
    const f0 = coatF0(m.coat.ior)
    const kt = (1 - schlickScalar(wo.z, f0)) * (1 - schlickScalar(wi.z, f0))
    base = scale(base, kt)
    if (m.coat.tint) base = mul3(base, m.coat.tint)
  }
  return base
}
function diffuseLayeredFLocal(m: DiffuseMat, wo: Vec3, wi: Vec3): Vec3 {
  if (wo.z <= 0 || wi.z <= 0) return v(0, 0, 0)
  let f = diffuseBaseFLocal(m, wo, wi)
  if (m.coat) {
    const ca = Math.max(1e-3, m.coat.roughness * m.coat.roughness)
    const f0 = coatF0(m.coat.ior)
    f = add(f, ggxReflectFLocal(wo, wi, ca, { f0: v(f0, f0, f0) }))
  }
  return f
}
function diffuseCoatProb(m: DiffuseMat, woz: number): number {
  if (!m.coat) return 0
  return Math.min(0.9, Math.max(0.1, schlickScalar(woz, coatF0(m.coat.ior)) + 0.1))
}
function diffuseLayeredPdfLocal(m: DiffuseMat, wo: Vec3, wi: Vec3): number {
  if (wo.z <= 0 || wi.z <= 0) return 0
  const cos = wi.z * INV_PI
  if (!m.coat) return cos
  const ca = Math.max(1e-3, m.coat.roughness * m.coat.roughness)
  const pc = diffuseCoatProb(m, wo.z)
  return pc * ggxReflectPdfLocal(wo, wi, ca) + (1 - pc) * cos
}
function sampleDiffuseLayered(m: DiffuseMat, woW: Vec3, n: Vec3, rng: Rng): BsdfSample | null {
  const { t, b } = onb(n)
  const wo = worldToLocal(woW, t, b, n)
  if (wo.z <= 0) return null
  let wi: Vec3
  if (m.coat && rng.next() < diffuseCoatProb(m, wo.z)) {
    const ca = Math.max(1e-3, m.coat.roughness * m.coat.roughness)
    const h = sampleGGXVNDF(wo, ca, rng.next(), rng.next())
    const woDotH = dot(wo, h)
    if (woDotH <= 0) return null
    wi = v(2 * woDotH * h.x - wo.x, 2 * woDotH * h.y - wo.y, 2 * woDotH * h.z - wo.z)
    if (wi.z <= 0) return null
  } else {
    wi = cosineSample(rng.next(), rng.next())
  }
  const pdf = diffuseLayeredPdfLocal(m, wo, wi)
  if (pdf <= 0) return null
  const f = diffuseLayeredFLocal(m, wo, wi)
  return { wi: toWorld(wi, t, b, n), weight: scale(f, wi.z / pdf), pdf, specular: false }
}

const mul3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x * b.x, y: a.y * b.y, z: a.z * b.z })

export function evalBSDF(m: Material, woW: Vec3, wiW: Vec3, n: Vec3): Vec3 {
  switch (m.kind) {
    case 'diffuse': {
      if (m.sigma || m.coat) {
        const { t, b } = onb(n)
        return diffuseLayeredFLocal(m, worldToLocal(woW, t, b, n), worldToLocal(wiW, t, b, n))
      }
      if (dot(wiW, n) <= 0 || dot(woW, n) <= 0) return v(0, 0, 0)
      return scale(m.albedo, INV_PI)
    }
    case 'metal': {
      if (m.roughness < ROUGHNESS_DELTA) return v(0, 0, 0)
      const { t, b } = m.aniso ? rotatedFrame(n, m.anisoAngle ?? 0) : onb(n)
      const wo = worldToLocal(woW, t, b, n)
      const wi = worldToLocal(wiW, t, b, n)
      if (wo.z <= 0 || wi.z <= 0) return v(0, 0, 0)
      const alpha = m.roughness * m.roughness
      const fr = metalFresnel(m)
      if (m.aniso) {
        const { ax, ay } = anisoAlphas(m.roughness, m.aniso)
        return ggxReflectFLocalAniso(wo, wi, ax, ay, fr)
      }
      if (m.multiscatter) return metalMsFLocal(wo, wi, alpha, fr, ggxDirectionalAlbedo(wo.z, alpha))
      const h = norm(v(wo.x + wi.x, wo.y + wi.y, wo.z + wi.z))
      const D = ggxD(h.z, alpha)
      const G = g2(wo.z, wi.z, alpha)
      const F = fresnelSpec(Math.max(0, dot(wo, h)), fr)
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
      if (m.sigma || m.coat) {
        const { t, b } = onb(n)
        return diffuseLayeredPdfLocal(m, worldToLocal(woW, t, b, n), worldToLocal(wiW, t, b, n))
      }
      const c = dot(wiW, n)
      return c > 0 ? c * INV_PI : 0
    }
    case 'metal': {
      if (m.roughness < ROUGHNESS_DELTA) return 0
      const { t, b } = m.aniso ? rotatedFrame(n, m.anisoAngle ?? 0) : onb(n)
      const wo = worldToLocal(woW, t, b, n)
      const wi = worldToLocal(wiW, t, b, n)
      if (wo.z <= 0 || wi.z <= 0) return 0
      const alpha = m.roughness * m.roughness
      if (m.aniso) {
        const { ax, ay } = anisoAlphas(m.roughness, m.aniso)
        return ggxReflectPdfLocalAniso(wo, wi, ax, ay)
      }
      if (m.multiscatter) {
        const ps = metalMsLobeProb(ggxDirectionalAlbedo(wo.z, alpha))
        return ps * ggxReflectPdfLocal(wo, wi, alpha) + (1 - ps) * wi.z * INV_PI
      }
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
