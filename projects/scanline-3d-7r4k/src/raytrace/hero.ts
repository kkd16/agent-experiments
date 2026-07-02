// Hero-wavelength spectral path tracing (v11) — Wilkie, Nawaz, Droske, Weidlich & Hanika,
// "Hero Wavelength Spectral Sampling" (EGSR 2014). The v10 `traceSpectral` twin carries ONE
// wavelength per camera ray, so colour — especially luminance — is noisy until many samples
// average the spectrum out. This integrator carries a whole **tuple of C wavelengths** down a
// *single shared path*: a hero λ₀ (importance-sampled ∝ ȳ) plus C−1 stratified companions
// spread evenly across the visible band. For every wavelength-independent interaction (all
// opaque surfaces, dielectric reflection, thin-film iridescence, absorption) the tuple stays
// intact, so one traced path delivers C spectral samples at once and the picture converges
// several times faster — for free.
//
// The one place wavelengths must part ways is a *dispersive refraction*: red and violet leave
// a glass facet in genuinely different directions, so a shared path can only follow one of
// them. There the tuple **terminates its secondaries** — only the hero continues — and the
// reconstruction is rescaled (the hero's effective pdf ÷ C, exactly PBRT-v4's
// `TerminateSecondary`) so glass, prisms and rainbows stay perfectly unbiased and match the
// single-wavelength renderer, just noisier there than on the non-dispersive parts of the scene.
//
// Correctness rests on two ideas:
//   • The direction at every vertex is sampled from the *hero's* pdf, but each companion
//     wavelength weights the shared sample by its own BSDF value ÷ that hero pdf — plain
//     importance sampling with a shared proposal, unbiased per wavelength (a companion whose
//     interface can't produce the hero's direction, i.e. a dispersive refraction, gets f=0 and
//     is what forces the secondary termination above).
//   • Reconstruction accumulates raw tristimulus Xᵢ=Σ x̄(λᵢ)·Lᵢ/(pdfᵢ·C) incrementally, so a
//     wavelength that dies mid-path keeps every photon it banked *before* dying (its pdf is
//     frozen at death, not zeroed) — no energy is lost and C=1 is bit-identical to
//     `traceSpectral`. See `hero_verify.ts` for the numerical proofs.
import type { Vec3 } from '../math/vec.ts'
import type { RTContext, Surface } from './tracer.ts'
import { surfaceAt } from './tracer.ts'
import type { ClosestHit } from './bvh.ts'
import {
  distributionGGX, orthonormalBasis, powerHeuristic, cosineHemisphere,
  sampleGGX, toWorld, uniformCone, uniformSphere, type Rng,
} from './sampling.ts'
import { fresnelDielectric, reflect, refract, smithG1 } from './dielectric.ts'
import {
  cieX, cieY, cieZ, rgbCoeffAt, rgbToSpectrum, sampleWavelength, spectrumAt,
  xyzToBalancedRgb,
} from './spectrum.ts'
import {
  SMOOTH_DIELECTRIC, bsdfPdfSpectral, emitterRadiance, evalBRDFSpectral,
  iorAt, lightSpectrum, reflectanceAt, specProbSpectral,
} from './spectral.ts'

const PI = Math.PI
const EPS = 1e-3

// The number of wavelengths a path carries. Kept small — 4 is the sweet spot (matches the
// four SIMD lanes real spectral renderers use) — but the integrator is size-generic.
export const MAX_HERO = 8
export const DEFAULT_HERO = 4

// ── per-path spectral state (module-level scratch; the tracer is single-threaded) ─────────
const lambdas = new Float64Array(MAX_HERO) // the C wavelengths, [0] = hero
const beta = new Float64Array(MAX_HERO) // per-wavelength path throughput
const invPdf = new Float64Array(MAX_HERO) // reconstruction weight 1/(pdfᵢ·C), frozen on death
const absorb = new Float64Array(MAX_HERO) // Beer–Lambert coefficient at λᵢ of the body we are inside
const reflArr = new Float64Array(MAX_HERO) // surface reflectance at each λᵢ (reused per vertex)
const Ld = new Float64Array(MAX_HERO) // scratch for one direct-lighting evaluation

// ── stratified wavelength tuple ───────────────────────────────────────────────────────────
// The hero is importance-sampled ∝ ȳ(λ) from `u`; the C−1 companions are the same CDF sample
// rotated by k/C so the tuple sweeps the whole band. Each wavelength keeps its OWN importance
// pdf (they are C correlated stratified samples), so reconstruction divides each by its pdf and
// averages by C — unbiased, and reducing to the single-wavelength estimator at C=1.
export function heroWavelengths(u: number, C: number, outLambda: Float64Array, outInvPdf: Float64Array): void {
  for (let k = 0; k < C; k++) {
    let uk = u + k / C
    uk -= Math.floor(uk)
    const ws = sampleWavelength(uk)
    outLambda[k] = ws.lambda
    outInvPdf[k] = ws.pdf > 0 ? 1 / (ws.pdf * C) : 0
  }
}

// Bank one wavelength's contribution (already scaled by its throughput β) into the running
// tristimulus accumulator, weighted by its frozen reconstruction pdf.
let accX = 0, accY = 0, accZ = 0
function bank(i: number, contrib: number): void {
  const w = contrib * invPdf[i]
  const l = lambdas[i]
  accX += cieX(l) * w
  accY += cieY(l) * w
  accZ += cieZ(l) * w
}

// ── hero-aware next-event estimation ──────────────────────────────────────────────────────
// One shadow ray per light / emitter sample (geometry is wavelength-independent); the BSDF,
// the light's spectrum and the emitter radiance are then evaluated at every live wavelength.
// Writes per-wavelength direct radiance (pre-throughput) into `Ld[0..C)`.
function directLightHero(s: Surface, C: number, vx: number, vy: number, vz: number, ctx: RTContext, rng: Rng): void {
  for (let i = 0; i < C; i++) Ld[i] = 0
  const { bvh } = ctx
  const ogx = s.px + s.gx * EPS, ogy = s.py + s.gy * EPS, ogz = s.pz + s.gz * EPS

  for (let li = 0; li < ctx.lights.length; li++) {
    const light = ctx.lights[li]
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
      const spec = lightSpectrum(light.color)
      for (let i = 0; i < C; i++) {
        const l = lambdas[i]
        Ld[i] += evalBRDFSpectral(s, l, reflArr[i], vx, vy, vz, lx, ly, lz) * NoL * spectrumAt(spec, l) * light.intensity
      }
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
      const spec = lightSpectrum(light.color)
      for (let i = 0; i < C; i++) {
        const l = lambdas[i]
        Ld[i] += evalBRDFSpectral(s, l, reflArr[i], vx, vy, vz, lx, ly, lz) * NoL * spectrumAt(spec, l) * light.intensity * atten
      }
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
        const pdfL = 1 / (G * pdfInv)
        for (let i = 0; i < C; i++) {
          const l = lambdas[i]
          // MIS weight uses the hero-consistent BSDF pdf (a valid, shared MIS partition).
          const wMIS = ctx.mis === false ? 1 : powerHeuristic(pdfL, bsdfPdfSpectral(s, l, reflArr[i], vx, vy, vz, lx, ly, lz))
          Ld[i] += evalBRDFSpectral(s, l, reflArr[i], vx, vy, vz, lx, ly, lz) * NoL * G * pdfInv * wMIS * emitterRadiance(mat, l)
        }
      }
    }
  }
}

// ── hero BSDF sampling ────────────────────────────────────────────────────────────────────
// Both samplers draw ONE outgoing direction from the hero wavelength's distribution and update
// every live wavelength's throughput for that shared direction. They return the shared
// direction, the hero pdf (for MIS), and flags. `terminate` fires only on a dispersive
// refraction, where the companions cannot follow the hero's bent ray.
interface HeroSample {
  wx: number; wy: number; wz: number
  pdf: number // the hero pdf of the sampled direction (0 for a Dirac lobe)
  specular: boolean
  transmitted: boolean
  terminate: boolean
  ok: boolean
}
const hs: HeroSample = { wx: 0, wy: 0, wz: 0, pdf: 0, specular: false, transmitted: false, terminate: false, ok: false }
const tmpV = new Float64Array(3)

// Opaque metallic-roughness BSDF: cosine-diffuse ∪ GGX-specular, sampled from the hero's
// mixture, each wavelength weighted by fᵢ·NoL / pdf_hero (shared-proposal importance sampling).
function sampleOpaqueHero(s: Surface, C: number, vx: number, vy: number, vz: number, rng: Rng): void {
  hs.terminate = false; hs.transmitted = false; hs.specular = false
  const mat = s.mat
  const a = mat.roughness * mat.roughness
  const nx = s.nx, ny = s.ny, nz = s.nz
  const pSpec = specProbSpectral(s, lambdas[0], reflArr[0], vx, vy, vz)
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
  if (NoL <= 0) { hs.ok = false; return }
  let hx = vx + wx, hy = vy + wy, hz = vz + wz
  const hl = Math.hypot(hx, hy, hz) || 1
  hx /= hl; hy /= hl; hz /= hl
  const NoH = Math.max(0, nx * hx + ny * hy + nz * hz)
  const VoH = Math.max(0, vx * hx + vy * hy + vz * hz)
  const pdf = pSpec * (VoH > 1e-6 ? (distributionGGX(NoH, a) * NoH) / (4 * VoH) : 0) + (1 - pSpec) * (NoL / PI)
  if (pdf <= 1e-8) { hs.ok = false; return }
  for (let i = 0; i < C; i++) {
    const f = evalBRDFSpectral(s, lambdas[i], reflArr[i], vx, vy, vz, wx, wy, wz)
    beta[i] *= f * NoL / pdf
  }
  hs.wx = wx; hs.wy = wy; hs.wz = wz; hs.pdf = pdf; hs.ok = true
}

// Dispersive dielectric: pick a microfacet (shared), decide reflect/refract by the HERO's
// Fresnel, then reconstruct each wavelength's throughput. Reflection and non-dispersive
// refraction keep the whole tuple (each corrected by its own Fresnel ÷ the hero's branch
// probability); a dispersive refraction bends every wavelength differently, so the tuple
// terminates to the hero alone.
function sampleDielectricHero(s: Surface, C: number, vx: number, vy: number, vz: number, rng: Rng): void {
  hs.specular = true; hs.terminate = false; hs.pdf = 0
  const mat = s.mat
  const nx = s.nx, ny = s.ny, nz = s.nz
  const rough = mat.roughness
  const a = rough * rough
  const smooth = rough <= SMOOTH_DIELECTRIC
  const dispersive = mat.glass !== '' || mat.dispersion > 0

  // shared microfacet
  let mx = nx, my = ny, mz = nz
  if (!smooth) {
    const [t1, t2] = orthonormalBasis([nx, ny, nz])
    const mm = sampleGGX(rng.next(), rng.next(), a)
    const mw = toWorld(mm, t1, t2, [nx, ny, nz])
    mx = mw[0]; my = mw[1]; mz = mw[2]
  }
  let VoH = vx * mx + vy * my + vz * mz
  if (VoH < 0) { mx = -mx; my = -my; mz = -mz; VoH = -VoH }
  if (VoH <= 1e-5) { hs.ok = false; return }

  // hero Fresnel + branch decision
  const ior0 = iorAt(mat, lambdas[0])
  const etaI0 = s.frontFace ? 1.0 : ior0
  const etaT0 = s.frontFace ? ior0 : 1.0
  const F0 = fresnelDielectric(VoH, etaI0, etaT0)
  const ix = -vx, iy = -vy, iz = -vz

  if (rng.next() < F0) {
    // REFLECT — direction is wavelength-independent; keep the whole tuple, each corrected F_i/F0
    reflect(ix, iy, iz, mx, my, mz, tmpV)
    const wx = tmpV[0], wy = tmpV[1], wz = tmpV[2]
    const w = smooth ? 1 : smithG1(nx * wx + ny * wy + nz * wz, a)
    const invF0 = F0 > 1e-6 ? 1 / F0 : 0
    for (let i = 0; i < C; i++) {
      const iori = iorAt(mat, lambdas[i])
      const eI = s.frontFace ? 1.0 : iori, eT = s.frontFace ? iori : 1.0
      const Fi = fresnelDielectric(VoH, eI, eT)
      beta[i] *= Fi * invF0 * w
    }
    hs.wx = wx; hs.wy = wy; hs.wz = wz; hs.transmitted = false; hs.ok = true
    return
  }

  // REFRACT (hero). If total internal reflection, fall back to a shared mirror bounce.
  const eta0 = etaI0 / etaT0
  if (!refract(ix, iy, iz, mx, my, mz, eta0, tmpV)) {
    reflect(ix, iy, iz, mx, my, mz, tmpV)
    const wx = tmpV[0], wy = tmpV[1], wz = tmpV[2]
    const w = smooth ? 1 : smithG1(nx * wx + ny * wy + nz * wz, a)
    for (let i = 0; i < C; i++) beta[i] *= w
    hs.wx = wx; hs.wy = wy; hs.wz = wz; hs.transmitted = false; hs.ok = true
    return
  }
  const wx = tmpV[0], wy = tmpV[1], wz = tmpV[2]
  const w = smooth ? 1 : smithG1(nx * wx + ny * wy + nz * wz, a)
  if (dispersive) {
    // Different λ leave in different directions → only the hero can follow. Terminate the
    // companions: their reconstruction pdf freezes (banked energy kept), the hero's ÷= C.
    beta[0] *= w
    hs.terminate = true
  } else {
    const invT0 = (1 - F0) > 1e-6 ? 1 / (1 - F0) : 0
    for (let i = 0; i < C; i++) {
      const iori = iorAt(mat, lambdas[i])
      const eI = s.frontFace ? 1.0 : iori, eT = s.frontFace ? iori : 1.0
      const Fi = fresnelDielectric(VoH, eI, eT)
      beta[i] *= (1 - Fi) * invT0 * w
    }
  }
  hs.wx = wx; hs.wy = wy; hs.wz = wz; hs.transmitted = true; hs.ok = true
}

const tmpHit: ClosestHit = { t: 0, tri: -1, u: 0, v: 0 }
const outRGB = new Float64Array(3)
const skyCoeff = new Float64Array(10)
const MAX_PATH = 64

// Estimate the pixel colour along one camera ray by carrying `C` hero wavelengths down a
// single shared path. `u` ∈ [0,1) seeds the (stratified) hero wavelength; the caller sweeps it
// across a pixel's samples exactly as the single-wavelength path does. Returns linear sRGB.
export function traceHero(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  ctx: RTContext, rng: Rng, u: number, C: number,
): Vec3 {
  if (C < 1) C = 1; else if (C > MAX_HERO) C = MAX_HERO
  heroWavelengths(u, C, lambdas, invPdf)
  accX = 0; accY = 0; accZ = 0
  let terminated = false
  for (let i = 0; i < C; i++) { beta[i] = 1; absorb[i] = 0 }

  let misPdfB = -1
  let countEmis = true
  let surfaceBounces = 0

  for (let iter = 0; iter < MAX_PATH; iter++) {
    const hit = ctx.bvh.closest(ox, oy, oz, dx, dy, dz, 1e-4, 1e30, tmpHit)
    if (hit) {
      const t = tmpHit.t
      for (let i = 0; i < C; i++) if (absorb[i] > 0) beta[i] *= Math.exp(-absorb[i] * t)
    }

    if (!hit) {
      const sky = ctx.sky(dx, dy, dz)
      // up-sample the (rare, usually near-neutral) sky RGB once, then sample per wavelength
      const c = rgbToSpectrum(sky[0], sky[1], sky[2])
      for (let k = 0; k < 10; k++) skyCoeff[k] = c[k]
      const nLive = terminated ? 1 : C
      for (let i = 0; i < nLive; i++) bank(i, beta[i] * spectrumAt(skyCoeff, lambdas[i]))
      break
    }

    const s = surfaceAt(ctx.scene, tmpHit.tri, tmpHit.u, tmpHit.v, dx, dy, dz)
    const vx = -dx, vy = -dy, vz = -dz
    const mat = s.mat
    const nLive = terminated ? 1 : C

    // emission (MIS-weighted against the area-light NEE at the previous vertex)
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
      for (let i = 0; i < nLive; i++) bank(i, beta[i] * emitterRadiance(mat, lambdas[i]) * wMIS)
    }

    // per-vertex reflectance for the live wavelengths
    const opaque = mat.transmission <= 0
    if (opaque) for (let i = 0; i < nLive; i++) reflArr[i] = reflectanceAt(s, lambdas[i])

    // direct lighting (opaque surfaces only — glass carries light through refraction)
    if (opaque) {
      directLightHero(s, nLive, vx, vy, vz, ctx, rng)
      for (let i = 0; i < nLive; i++) bank(i, beta[i] * Ld[i])
    }

    if (surfaceBounces >= ctx.maxBounces) break
    surfaceBounces++

    if (opaque) sampleOpaqueHero(s, nLive, vx, vy, vz, rng)
    else sampleDielectricHero(s, nLive, vx, vy, vz, rng)
    if (!hs.ok) break

    if (hs.terminate && !terminated) {
      // collapse to the hero: freeze companion pdfs (banked energy kept), rescale the hero's.
      invPdf[0] *= C
      for (let i = 1; i < C; i++) { invPdf[i] = 0; beta[i] = 0 }
      terminated = true
    }

    if (hs.specular) { countEmis = true; misPdfB = -1 } else if (ctx.mis === false) { countEmis = false } else { countEmis = true; misPdfB = hs.pdf }

    if (hs.transmitted) {
      const live = terminated ? 1 : C
      if (s.frontFace) for (let i = 0; i < live; i++) absorb[i] = rgbCoeffAt(mat.attenuation[0], mat.attenuation[1], mat.attenuation[2], lambdas[i])
      else for (let i = 0; i < live; i++) absorb[i] = 0
    }

    // Russian roulette on the surviving throughput (a shared decision → shared survival factor)
    if (iter >= 2) {
      const live = terminated ? 1 : C
      let bmax = 0
      for (let i = 0; i < live; i++) if (beta[i] > bmax) bmax = beta[i]
      let q = bmax
      if (q > 0.95) q = 0.95
      if (q < 0.05) q = 0.05
      if (rng.next() >= q) break
      const inv = 1 / q
      for (let i = 0; i < live; i++) beta[i] *= inv
    }

    const side = (s.gx * hs.wx + s.gy * hs.wy + s.gz * hs.wz) >= 0 ? 1 : -1
    ox = s.px + s.gx * EPS * side
    oy = s.py + s.gy * EPS * side
    oz = s.pz + s.gz * EPS * side
    dx = hs.wx; dy = hs.wy; dz = hs.wz
  }

  xyzToBalancedRgb(accX, accY, accZ, outRGB)
  return [outRGB[0], outRGB[1], outRGB[2]]
}
