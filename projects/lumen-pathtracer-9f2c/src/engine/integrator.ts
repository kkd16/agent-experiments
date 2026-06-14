// integrator.ts — a unidirectional path tracer with multiple importance
// sampling. This is the estimator that actually solves the rendering equation
//
//   L_o(x,ω_o) = L_e + ∫_Ω f(x,ω_i,ω_o) · L_i(x,ω_i) · |cosθ_i| dω_i
//
// by following light paths from the camera and, at every non-specular vertex,
// combining two competing estimators with the power heuristic:
//
//   • next-event estimation (NEE) — sample a point on a light directly, which
//     excels for small/bright lights and smooth surfaces; and
//   • BSDF sampling — follow the material's own scattering lobe, which excels
//     for large/dim lights and glossy/specular surfaces.
//
// MIS keeps the variance of whichever estimator is locally worse from polluting
// the result, so the same code renders a tiny bright bulb and a broad sky dome
// without tuning. Russian roulette unbiasedly terminates dim paths.

import type { Vec3 } from './vec3'
import {
  add,
  clamp,
  dot,
  isBlack,
  madd,
  maxComponent,
  mul,
  neg,
  scale,
  v,
} from './vec3'
import { makeRay } from './ray'
import type { Ray } from './ray'
import type { Scene } from './scene'
import type { Rng } from './rng'
import { powerHeuristic } from './rng'
import type { Material } from './material'
import { evalBSDF, isDelta, pdfBSDF, resolveMaterial, sampleBSDF } from './material'
import { LAMBDA_MAX, LAMBDA_MIN, wavelengthWeight } from './spectrum'
import type { IntegratorSettings } from './types'

export interface RayStats {
  rays: number
}

export interface GBuffer {
  albedo: Vec3
  normal: Vec3
}

const EPS = 1e-4

// Small ray-origin offset along the geometric normal to defeat self-shadowing.
function offsetOrigin(p: Vec3, ng: Vec3, dir: Vec3): Vec3 {
  return madd(p, ng, dot(ng, dir) > 0 ? EPS : -EPS)
}

// A perceptual stand-in for a surface's base colour, used only as a denoiser
// guide (never in the light transport itself).
function albedoGuide(m: Material): Vec3 {
  switch (m.kind) {
    case 'diffuse':
      return m.albedo
    case 'metal':
      return m.albedo
    case 'dielectric':
      return v(0.9, 0.95, 1)
    case 'emissive':
      return v(1, 1, 1)
  }
}

export function radiance(
  scene: Scene,
  ray: Ray,
  settings: IntegratorSettings,
  rng: Rng,
  stats: RayStats,
  gbuf?: GBuffer,
): Vec3 {
  let L = v(0, 0, 0)
  let beta = v(1, 1, 1)
  let r: Ray = ray
  let specularBounce = true
  let prevPdf = 0
  let prevPoint = ray.o
  let captured = false
  const clampI = settings.clampIndirect
  // Beer–Lambert state: the absorption coefficient σ_a of the medium the ray is
  // currently travelling through (null = vacuum). And the path's committed "hero"
  // wavelength for spectral dispersion (0 = not yet chosen / achromatic).
  let medium: Vec3 | null = null
  let lambda = 0

  for (let depth = 0; depth <= settings.maxDepth; depth++) {
    stats.rays++
    const hit = scene.intersect(r)

    // ---- Escaped the scene: gather the environment (MIS vs. sun NEE). ----
    if (!hit) {
      const env = scene.envRadiance(r.d)
      // If the environment exposes a sampled sun and this ray came from a
      // non-specular BSDF bounce, weight it against the light sampler that could
      // also have produced this direction (power heuristic). Outside the sun cone
      // the env pdf is 0, so w = 1 and the sky is gathered in full.
      let w = 1
      if (!specularBounce && scene.hasEnvLight) {
        const ep = scene.envSunPdf(r.d)
        if (ep > 0) w = powerHeuristic(1, prevPdf, 1, ep)
      }
      let c = scale(mul(beta, env), w)
      if (depth > 0 && clampI > 0) c = clampContribution(c, clampI)
      L = add(L, c)
      if (gbuf && !captured) {
        gbuf.albedo = env
        gbuf.normal = neg(r.d)
      }
      break
    }

    // ---- Beer–Lambert: attenuate over the segment just travelled in a medium. ----
    if (medium) {
      beta = mul(beta, v(Math.exp(-medium.x * hit.t), Math.exp(-medium.y * hit.t), Math.exp(-medium.z * hit.t)))
    }

    const rawMat = scene.materials[hit.material]
    // ---- Spectral dispersion: commit to one wavelength on first dispersive hit. ----
    if (rawMat.kind === 'dielectric' && rawMat.cauchyB && lambda === 0) {
      lambda = LAMBDA_MIN + rng.next() * (LAMBDA_MAX - LAMBDA_MIN)
      beta = mul(beta, wavelengthWeight(lambda))
    }
    const mat = resolveMaterial(rawMat, hit.p, lambda)
    const wo = neg(r.d)

    if (gbuf && !captured) {
      gbuf.albedo = albedoGuide(mat)
      gbuf.normal = hit.n
      captured = true
    }

    // ---- Emission (with MIS weighting against the NEE that could have hit it). ----
    if (mat.kind === 'emissive') {
      const Le = mat.emission
      if (!isBlack(Le)) {
        let w = 1
        if (!specularBounce) {
          const lp = scene.lightPdf(prevPoint, r.d, hit.primId, hit.t)
          w = powerHeuristic(1, prevPdf, 1, lp)
        }
        let c = scale(mul(beta, Le), w)
        if (depth > 0 && clampI > 0) c = clampContribution(c, clampI)
        L = add(L, c)
      }
      break // emitters are pure lights; they do not scatter further
    }

    // ---- Russian roulette: probabilistically terminate dim paths. ----
    if (depth >= settings.rrStart) {
      const q = clamp(maxComponent(beta), 0.05, 0.95)
      if (rng.next() >= q) break
      beta = scale(beta, 1 / q)
    }

    // ---- Next-event estimation (skip for delta/specular lobes). ----
    if (!isDelta(mat)) {
      const ls = scene.sampleLight(hit.p, rng)
      if (ls && ls.pdf > 0 && !isBlack(ls.radiance)) {
        const f = evalBSDF(mat, wo, ls.wi, hit.n)
        const cosX = Math.abs(dot(hit.n, ls.wi))
        if (!isBlack(f) && cosX > 0) {
          const shadowO = offsetOrigin(hit.p, hit.ng, ls.wi)
          stats.rays++
          if (!scene.occluded(shadowO, ls.wi, EPS, ls.dist - 1e-3)) {
            const bp = pdfBSDF(mat, wo, ls.wi, hit.n)
            const w = powerHeuristic(1, ls.pdf, 1, bp)
            // β · f · Le · cosθ · w / pdf_light
            let c = mul(mul(beta, f), scale(ls.radiance, (cosX * w) / ls.pdf))
            if (clampI > 0) c = clampContribution(c, clampI)
            L = add(L, c)
          }
        }
      }
    }

    // ---- BSDF sampling: choose the next path direction. ----
    const bs = sampleBSDF(mat, wo, hit.n, hit.frontFace, rng)
    if (!bs || bs.pdf <= 0 || isBlack(bs.weight)) break
    beta = mul(beta, bs.weight)
    specularBounce = bs.specular
    prevPdf = bs.pdf
    prevPoint = hit.p
    // ---- Track medium crossings for Beer–Lambert absorption. ----
    if (bs.transmission && rawMat.kind === 'dielectric') {
      // Entering through the front face starts the medium; exiting clears it.
      medium = hit.frontFace ? rawMat.absorption ?? null : null
    }
    r = makeRay(offsetOrigin(hit.p, hit.ng, bs.wi), bs.wi)
  }

  // Guard against NaN/Inf leaking into the accumulation buffer.
  if (!Number.isFinite(L.x) || !Number.isFinite(L.y) || !Number.isFinite(L.z)) {
    return v(0, 0, 0)
  }
  return L
}

// Clamp a radiance contribution's magnitude to tame fireflies (biased but only
// applied to indirect bounces, where the human eye is least sensitive to it).
function clampContribution(c: Vec3, maxVal: number): Vec3 {
  const m = maxComponent(c)
  return m > maxVal ? scale(c, maxVal / m) : c
}
