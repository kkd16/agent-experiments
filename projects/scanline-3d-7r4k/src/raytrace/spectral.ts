// The spectral path tracer (v10). Architecturally a twin of `tracer.ts`'s `tracePath`,
// but where that integrator carries three fixed RGB channels, this one carries a single
// continuously-sampled wavelength λ along the whole path. That one change is the difference
// between a *fake* and a *real* rainbow: at every glass facet the index of refraction is
// evaluated at λ (a real Sellmeier curve, or the achromatic Cauchy fan), so red and violet
// bend by genuinely different angles and a prism splits white light into a continuous
// spectrum — not the RGB tracer's three-band hero-channel hack.
//
// Each path's scalar radiance L(λ) is turned back into a displayable colour by the CIE
// colour-matching machinery in `spectrum.ts`: a single Monte-Carlo sample contributes
// L(λ)·x̄ȳz̄(λ)/(pdf·∫ȳ) → linear sRGB, white-balanced so a non-dispersive scene reads at the
// SAME exposure as the RGB tracer (only dispersion differs in the side-by-side). The
// wavelength is importance-sampled ∝ ȳ(λ) and stratified across a pixel's samples by the
// caller, so colour converges fast despite carrying one wavelength per ray.
//
// It reuses the RGB tracer's BVH, scene, surface reconstruction and Monte-Carlo kit
// wholesale; only the BSDF, the light/emitter radiance and the dispersive interface are
// re-derived in scalar/spectral form here. Surfaces, lights and emitters keep their RGB
// authoring — their reflectance/illuminant spectra are reconstructed by Smits up-sampling
// (or, for `blackbodyK` emitters, Planck's law), so every existing scene "just works"
// spectrally and the only authored spectral input is a glass's dispersion curve.
import type { Vec3 } from '../math/vec.ts'
import type { RTContext, Surface } from './tracer.ts'
import { surfaceAt } from './tracer.ts'
import type { RTMaterial } from './rtscene.ts'
import type { ClosestHit } from './bvh.ts'
import {
  cosineHemisphere, distributionGGX, orthonormalBasis, powerHeuristic,
  sampleGGX, toWorld, uniformCone, uniformSphere, type Rng,
} from './sampling.ts'
import { fresnelDielectric, reflect, refract, smithG1 } from './dielectric.ts'
import { filmReflectanceAt } from './thinfilm.ts'
import {
  blackbodyRadiance, cauchyIor, getGlass, rgbCoeffAt, rgbToSpectrum,
  sellmeierIor, spectralRadianceToRGB, spectrumAt,
} from './spectrum.ts'

const PI = Math.PI
const EPS = 1e-3
const SMOOTH_DIELECTRIC = 0.04

// ── per-frame spectral caches ─────────────────────────────────────────────────────────
// Light colours and emitter spectra are reused frame to frame; up-sample them once and key
// by value/identity so the inner loop never allocates.
const lightSpecCache = new Map<string, Float64Array>()
function lightSpectrum(color: Vec3): Float64Array {
  const key = `${Math.round(color[0] * 4096)},${Math.round(color[1] * 4096)},${Math.round(color[2] * 4096)}`
  let c = lightSpecCache.get(key)
  if (!c) { c = rgbToSpectrum(color[0], color[1], color[2]); lightSpecCache.set(key, c) }
  return c
}

interface EmitterSpec { coeffs: Float64Array | null; T: number; scale: number }
const emitterSpecCache = new Map<RTMaterial, EmitterSpec>()
function emitterSpec(mat: RTMaterial): EmitterSpec {
  let e = emitterSpecCache.get(mat)
  if (!e) {
    const em = mat.emission
    const scale = Math.max(em[0], em[1], em[2])
    if (mat.blackbodyK > 0) e = { coeffs: null, T: mat.blackbodyK, scale }
    else e = { coeffs: scale > 0 ? rgbToSpectrum(em[0] / scale, em[1] / scale, em[2] / scale) : null, T: 0, scale }
    emitterSpecCache.set(mat, e)
  }
  return e
}
function emitterRadiance(mat: RTMaterial, lambda: number): number {
  const e = emitterSpec(mat)
  if (e.scale <= 0) return 0
  if (e.T > 0) return blackbodyRadiance(lambda, e.T) * e.scale
  return e.coeffs ? spectrumAt(e.coeffs, lambda) * e.scale : 0
}

// Reset the caches when the scene's materials change (the geometry key flips). Keeps a
// stale material's spectrum from leaking into a new scene.
export function resetSpectralCaches(): void {
  lightSpecCache.clear()
  emitterSpecCache.clear()
}

// The albedo's reflectance at λ. Untextured materials use the cached Smits coefficients;
// textured ones up-sample the per-hit modulated colour (rare on spectral scenes).
function reflectanceAt(s: Surface, lambda: number): number {
  if (s.mat.texture) return spectrumAt(rgbToSpectrum(s.br, s.bg, s.bb), lambda)
  return spectrumAt(s.mat.albedoSpectrum, lambda)
}

// The dispersive index of refraction at λ: a named Sellmeier glass if set, else the
// achromatic base IOR fanned by the `dispersion` knob (Cauchy), else the flat IOR.
function iorAt(mat: RTMaterial, lambda: number): number {
  if (mat.glass) { const g = getGlass(mat.glass); if (g) return sellmeierIor(g, lambda) }
  return mat.dispersion > 0 ? cauchyIor(mat.ior, mat.dispersion, lambda) : mat.ior
}

// ── scalar spectral BSDF (mirrors evalBRDF / specProb / bsdfPdf in tracer.ts) ─────────
// The metallic-roughness BRDF value (no cosine) at one wavelength. `refl` is the surface
// reflectance at λ; a thin-film coat replaces the Schlick Fresnel with the exact spectral
// interference reflectance at this very wavelength — true spectral iridescence.
function evalBRDFSpectral(
  s: Surface, lambda: number, refl: number,
  vx: number, vy: number, vz: number, lx: number, ly: number, lz: number,
): number {
  const nx = s.nx, ny = s.ny, nz = s.nz
  const NoL = nx * lx + ny * ly + nz * lz
  const NoV = nx * vx + ny * vy + nz * vz
  if (NoL <= 0 || NoV <= 0) return 0
  const mat = s.mat
  const metallic = mat.metallic
  const a = mat.roughness * mat.roughness
  let hx = vx + lx, hy = vy + ly, hz = vz + lz
  const hl = Math.hypot(hx, hy, hz) || 1
  hx /= hl; hy /= hl; hz /= hl
  const NoH = Math.max(0, nx * hx + ny * hy + nz * hz)
  const VoH = Math.max(0, vx * hx + vy * hy + vz * hz)
  let F: number
  if (mat.filmThicknessNm > 0) {
    F = filmReflectanceAt(VoH, 1.0, mat.filmIor, mat.ior, mat.filmThicknessNm, lambda)
  } else {
    const f0 = 0.04 + (refl - 0.04) * metallic
    const fc = Math.pow(Math.max(0, 1 - VoH), 5)
    F = f0 + (1 - f0) * fc
  }
  const D = distributionGGX(NoH, a)
  const a2 = a * a
  const gv = NoL * Math.sqrt(NoV * NoV * (1 - a2) + a2)
  const gl = NoV * Math.sqrt(NoL * NoL * (1 - a2) + a2)
  const Vis = 0.5 / (gv + gl + 1e-7)
  const kd = (1 - F) * (1 - metallic)
  return kd * refl / PI + D * Vis * F
}

function specProbSpectral(s: Surface, lambda: number, refl: number, vx: number, vy: number, vz: number): number {
  const mat = s.mat
  const diff = refl * (1 - mat.metallic)
  let f0: number
  if (mat.filmThicknessNm > 0) {
    const NoV = s.nx * vx + s.ny * vy + s.nz * vz
    f0 = filmReflectanceAt(NoV, 1.0, mat.filmIor, mat.ior, mat.filmThicknessNm, lambda)
  } else {
    f0 = 0.04 + (refl - 0.04) * mat.metallic
  }
  let pSpec = diff <= 1e-4 ? 1 : f0 / (f0 + diff)
  if (pSpec < 0.15) pSpec = 0.15
  if (pSpec > 0.95) pSpec = 0.95
  return pSpec
}

function bsdfPdfSpectral(
  s: Surface, lambda: number, refl: number,
  vx: number, vy: number, vz: number, wx: number, wy: number, wz: number,
): number {
  const nx = s.nx, ny = s.ny, nz = s.nz
  const NoL = nx * wx + ny * wy + nz * wz
  if (NoL <= 0) return 0
  const a = s.mat.roughness * s.mat.roughness
  const pSpec = specProbSpectral(s, lambda, refl, vx, vy, vz)
  let hx = vx + wx, hy = vy + wy, hz = vz + wz
  const hl = Math.hypot(hx, hy, hz) || 1
  hx /= hl; hy /= hl; hz /= hl
  const NoH = Math.max(0, nx * hx + ny * hy + nz * hz)
  const VoH = Math.max(0, vx * hx + vy * hy + vz * hz)
  const pdfDiff = NoL / PI
  const pdfSpec = VoH > 1e-6 ? (distributionGGX(NoH, a) * NoH) / (4 * VoH) : 0
  return pSpec * pdfSpec + (1 - pSpec) * pdfDiff
}

interface SBSample { wx: number; wy: number; wz: number; weight: number; pdf: number; specular: boolean; transmitted: boolean }
const tmpV = new Float64Array(3)

// Importance-sample a dispersive dielectric (glass) at λ: Fresnel-weighted reflect/refract
// about a (smooth or GGX) microfacet, with the index of refraction taken at this wavelength
// — the line that physically bends a prism's beam into a spectrum.
function sampleDielectricSpectral(s: Surface, lambda: number, vx: number, vy: number, vz: number, rng: Rng, out: SBSample): boolean {
  const mat = s.mat
  const nx = s.nx, ny = s.ny, nz = s.nz
  const rough = mat.roughness
  const a = rough * rough
  const smooth = rough <= SMOOTH_DIELECTRIC
  const ior = iorAt(mat, lambda)
  const etaI = s.frontFace ? 1.0 : ior
  const etaT = s.frontFace ? ior : 1.0

  let mx = nx, my = ny, mz = nz
  if (!smooth) {
    const [t1, t2] = orthonormalBasis([nx, ny, nz])
    const mm = sampleGGX(rng.next(), rng.next(), a)
    const mw = toWorld(mm, t1, t2, [nx, ny, nz])
    mx = mw[0]; my = mw[1]; mz = mw[2]
  }
  let VoH = vx * mx + vy * my + vz * mz
  if (VoH < 0) { mx = -mx; my = -my; mz = -mz; VoH = -VoH }
  if (VoH <= 1e-5) return false

  const F = fresnelDielectric(VoH, etaI, etaT)
  const ix = -vx, iy = -vy, iz = -vz
  let wx: number, wy: number, wz: number
  let transmitted: boolean
  if (rng.next() < F) {
    reflect(ix, iy, iz, mx, my, mz, tmpV)
    wx = tmpV[0]; wy = tmpV[1]; wz = tmpV[2]; transmitted = false
  } else {
    const eta = etaI / etaT
    if (!refract(ix, iy, iz, mx, my, mz, eta, tmpV)) {
      reflect(ix, iy, iz, mx, my, mz, tmpV)
      wx = tmpV[0]; wy = tmpV[1]; wz = tmpV[2]; transmitted = false
    } else {
      wx = tmpV[0]; wy = tmpV[1]; wz = tmpV[2]; transmitted = true
    }
  }
  const w = smooth ? 1 : smithG1(nx * wx + ny * wy + nz * wz, a)
  out.wx = wx; out.wy = wy; out.wz = wz
  out.weight = w
  out.pdf = 0 // Dirac lobe
  out.specular = true
  out.transmitted = transmitted
  return true
}

// Importance-sample the opaque BRDF at λ (cosine diffuse ∪ GGX specular), scalar throughput.
function sampleBSDFSpectral(s: Surface, lambda: number, refl: number, vx: number, vy: number, vz: number, rng: Rng, out: SBSample): boolean {
  if (s.mat.transmission > 0) return sampleDielectricSpectral(s, lambda, vx, vy, vz, rng, out)
  out.transmitted = false
  const mat = s.mat
  const a = mat.roughness * mat.roughness
  const nx = s.nx, ny = s.ny, nz = s.nz
  const pSpec = specProbSpectral(s, lambda, refl, vx, vy, vz)
  const [t1, t2] = orthonormalBasis([nx, ny, nz])
  let wx: number, wy: number, wz: number
  if (rng.next() < pSpec) {
    const m = sampleGGX(rng.next(), rng.next(), a)
    const mw = toWorld(m, t1, t2, [nx, ny, nz])
    const vDotM = vx * mw[0] + vy * mw[1] + vz * mw[2]
    wx = 2 * vDotM * mw[0] - vx; wy = 2 * vDotM * mw[1] - vy; wz = 2 * vDotM * mw[2] - vz
  } else {
    const l = cosineHemisphere(rng.next(), rng.next())
    const lw = toWorld(l, t1, t2, [nx, ny, nz])
    wx = lw[0]; wy = lw[1]; wz = lw[2]
  }
  const NoL = nx * wx + ny * wy + nz * wz
  if (NoL <= 0) return false
  let hx = vx + wx, hy = vy + wy, hz = vz + wz
  const hl = Math.hypot(hx, hy, hz) || 1
  hx /= hl; hy /= hl; hz /= hl
  const NoH = Math.max(0, nx * hx + ny * hy + nz * hz)
  const VoH = Math.max(0, vx * hx + vy * hy + vz * hz)
  const pdf = pSpec * (VoH > 1e-6 ? (distributionGGX(NoH, a) * NoH) / (4 * VoH) : 0) + (1 - pSpec) * (NoL / PI)
  if (pdf <= 1e-8) return false
  const f = evalBRDFSpectral(s, lambda, refl, vx, vy, vz, wx, wy, wz)
  out.wx = wx; out.wy = wy; out.wz = wz
  out.weight = f * NoL / pdf
  out.pdf = pdf
  out.specular = false
  return true
}

// Next-event estimation at λ: scalar direct light from punctual + emissive-area lights, each
// with a shadow ray and MIS against BSDF sampling (mirrors `directLight`).
function directLightSpectral(s: Surface, lambda: number, refl: number, vx: number, vy: number, vz: number, ctx: RTContext, rng: Rng): number {
  const { bvh } = ctx
  let L = 0
  const ogx = s.px + s.gx * EPS, ogy = s.py + s.gy * EPS, ogz = s.pz + s.gz * EPS

  for (let i = 0; i < ctx.lights.length; i++) {
    const light = ctx.lights[i]
    if (light.type === 'dir') {
      let lx = -light.direction[0], ly = -light.direction[1], lz = -light.direction[2]
      const ll = Math.hypot(lx, ly, lz) || 1
      lx /= ll; ly /= ll; lz /= ll
      if (ctx.sunCosHalf < 0.9999) {
        const local = uniformCone(rng.next(), rng.next(), ctx.sunCosHalf)
        const [t1, t2] = orthonormalBasis([lx, ly, lz])
        const w = toWorld(local, t1, t2, [lx, ly, lz])
        lx = w[0]; ly = w[1]; lz = w[2]
      }
      const NoL = s.nx * lx + s.ny * ly + s.nz * lz
      if (NoL <= 0) continue
      if (bvh.occluded(ogx, ogy, ogz, lx, ly, lz, EPS, 1e30)) continue
      const f = evalBRDFSpectral(s, lambda, refl, vx, vy, vz, lx, ly, lz)
      L += f * NoL * spectrumAt(lightSpectrum(light.color), lambda) * light.intensity
    } else {
      let cx = light.position[0], cy = light.position[1], cz = light.position[2]
      if (ctx.lightRadius > 0) {
        const sph = uniformSphere(rng.next(), rng.next())
        cx += sph[0] * ctx.lightRadius; cy += sph[1] * ctx.lightRadius; cz += sph[2] * ctx.lightRadius
      }
      let lx = cx - s.px, ly = cy - s.py, lz = cz - s.pz
      const dist = Math.hypot(lx, ly, lz) || 1
      lx /= dist; ly /= dist; lz /= dist
      const NoL = s.nx * lx + s.ny * ly + s.nz * lz
      if (NoL <= 0) continue
      const fall = 1 - (dist * dist) / (light.range * light.range)
      if (fall <= 0) continue
      const atten = fall * fall
      if (bvh.occluded(ogx, ogy, ogz, lx, ly, lz, EPS, dist - EPS)) continue
      const f = evalBRDFSpectral(s, lambda, refl, vx, vy, vz, lx, ly, lz)
      L += f * NoL * spectrumAt(lightSpectrum(light.color), lambda) * light.intensity * atten
    }
  }

  const scene = ctx.scene
  const nE = scene.emissiveTris.length
  if (nE > 0 && scene.totalEmissiveArea > 1e-9) {
    const target = rng.next() * scene.totalEmissiveArea
    let lo = 0, hi = nE - 1
    while (lo < hi) { const mid = (lo + hi) >> 1; if (scene.emissiveArea[mid] < target) lo = mid + 1; else hi = mid }
    const tri = scene.emissiveTris[lo]
    const o3 = tri * 3
    const e1x = scene.e1[o3], e1y = scene.e1[o3 + 1], e1z = scene.e1[o3 + 2]
    const e2x = scene.e2[o3], e2y = scene.e2[o3 + 1], e2z = scene.e2[o3 + 2]
    const r1 = rng.next(), r2 = rng.next()
    const su = Math.sqrt(r1)
    const bu = su * (1 - r2), bv = su * r2
    const yx = scene.p0[o3] + bu * e1x + bv * e2x
    const yy = scene.p0[o3 + 1] + bu * e1y + bv * e2y
    const yz = scene.p0[o3 + 2] + bu * e1z + bv * e2z
    let lx = yx - s.px, ly = yy - s.py, lz = yz - s.pz
    const dist = Math.hypot(lx, ly, lz) || 1
    lx /= dist; ly /= dist; lz /= dist
    const NoL = s.nx * lx + s.ny * ly + s.nz * lz
    if (NoL > 0) {
      let gx = e1y * e2z - e1z * e2y, gy = e1z * e2x - e1x * e2z, gz = e1x * e2y - e1y * e2x
      const gnl = Math.hypot(gx, gy, gz) || 1
      gx /= gnl; gy /= gnl; gz /= gnl
      const cosLight = Math.abs(gx * lx + gy * ly + gz * lz)
      if (cosLight > 1e-4 && !bvh.occluded(ogx, ogy, ogz, lx, ly, lz, EPS, dist - EPS)) {
        const mat = scene.materials[scene.matIndex[tri]]
        const G = cosLight / (dist * dist)
        const pdfInv = scene.totalEmissiveArea
        const f = evalBRDFSpectral(s, lambda, refl, vx, vy, vz, lx, ly, lz)
        const pdfL = 1 / (G * pdfInv)
        const wMIS = ctx.mis === false ? 1 : powerHeuristic(pdfL, bsdfPdfSpectral(s, lambda, refl, vx, vy, vz, lx, ly, lz))
        L += f * NoL * G * pdfInv * wMIS * emitterRadiance(mat, lambda)
      }
    }
  }
  return L
}

const tmpHit: ClosestHit = { t: 0, tri: -1, u: 0, v: 0 }
const tmpSample: SBSample = { wx: 0, wy: 0, wz: 0, weight: 0, pdf: 0, specular: false, transmitted: false }
const tmpRGB = new Float64Array(3)
const MAX_PATH = 64

// Estimate the radiance along one camera ray at wavelength `lambda`, then convert that
// single spectral sample to its (unbiased) linear-sRGB contribution. `pdf` is the density
// the caller drew `lambda` from. Mirrors `tracePath` but scalar/spectral throughout.
export function traceSpectral(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  ctx: RTContext, rng: Rng, lambda: number, pdf: number,
): Vec3 {
  let L = 0
  let beta = 1
  let misPdfB = -1
  let countEmis = true
  let surfaceBounces = 0
  let abs = 0 // Beer–Lambert absorption coefficient (at λ) of the body we are inside, 0 outside

  for (let iter = 0; iter < MAX_PATH; iter++) {
    const hit = ctx.bvh.closest(ox, oy, oz, dx, dy, dz, 1e-4, 1e30, tmpHit)
    if (hit && abs > 0) beta *= Math.exp(-abs * tmpHit.t)

    if (!hit) {
      const sky = ctx.sky(dx, dy, dz)
      L += beta * spectrumAt(rgbToSpectrum(sky[0], sky[1], sky[2]), lambda)
      break
    }
    const s = surfaceAt(ctx.scene, tmpHit.tri, tmpHit.u, tmpHit.v, dx, dy, dz)
    const vx = -dx, vy = -dy, vz = -dz
    const mat = s.mat
    const em = mat.emission
    if (countEmis && (em[0] + em[1] + em[2]) > 0) {
      let wMIS = 1
      if (misPdfB > 0 && ctx.scene.totalEmissiveArea > 1e-9) {
        const cosLight = Math.abs(s.gx * dx + s.gy * dy + s.gz * dz)
        if (cosLight > 1e-6) {
          const pdfL = (tmpHit.t * tmpHit.t) / (cosLight * ctx.scene.totalEmissiveArea)
          wMIS = powerHeuristic(misPdfB, pdfL)
        }
      }
      L += beta * emitterRadiance(mat, lambda) * wMIS
    }

    const refl = mat.transmission > 0 ? 1 : reflectanceAt(s, lambda)
    if (mat.transmission <= 0) {
      L += beta * directLightSpectral(s, lambda, refl, vx, vy, vz, ctx, rng)
    }

    if (surfaceBounces >= ctx.maxBounces) break
    surfaceBounces++
    if (!sampleBSDFSpectral(s, lambda, refl, vx, vy, vz, rng, tmpSample)) break
    beta *= tmpSample.weight
    if (tmpSample.specular) { countEmis = true; misPdfB = -1 }
    else if (ctx.mis === false) { countEmis = false }
    else { countEmis = true; misPdfB = tmpSample.pdf }

    if (tmpSample.transmitted) {
      if (s.frontFace) abs = rgbCoeffAt(mat.attenuation[0], mat.attenuation[1], mat.attenuation[2], lambda)
      else abs = 0
    }

    if (iter >= 2) {
      let q = beta
      if (q > 0.95) q = 0.95
      if (q < 0.05) q = 0.05
      if (rng.next() >= q) break
      beta /= q
    }

    const wx = tmpSample.wx, wy = tmpSample.wy, wz = tmpSample.wz
    const side = (s.gx * wx + s.gy * wy + s.gz * wz) >= 0 ? 1 : -1
    ox = s.px + s.gx * EPS * side
    oy = s.py + s.gy * EPS * side
    oz = s.pz + s.gz * EPS * side
    dx = wx; dy = wy; dz = wz
  }

  spectralRadianceToRGB(L, lambda, pdf, tmpRGB)
  return [tmpRGB[0], tmpRGB[1], tmpRGB[2]]
}
