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
  luminance,
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
import type { Material, Subsurface } from './material'
import { bumpedNormal, evalBSDF, isDelta, isSpectral, pdfBSDF, resolveMaterial, sampleBSDF } from './material'
import { hgPhase, sampleHG } from './phase'
import { LAMBDA_MAX, LAMBDA_MIN, wavelengthWeight } from './spectrum'
import { spectralAt } from './subsurface'
import type { IntegratorSettings } from './types'
import { radianceBDPT } from './bdpt'
import type { Guide } from './guiding'

export interface RayStats {
  rays: number
}

export interface GBuffer {
  albedo: Vec3
  normal: Vec3
}

// Materials a learned guiding distribution applies to: the *non-delta, opaque
// reflectors* (Lambert/Oren–Nayar diffuse without a specular coat, and rough
// metal). These never transmit and never return a delta sub-lobe, so the BSDF
// pdf is well defined everywhere and the mixture density α·p_bsdf+(1−α)·p_guide
// is exact — keeping the guided estimator provably unbiased. Specular and
// transmissive transport (mirrors, glass, coated/thin-film surfaces) keeps to
// plain BSDF sampling, which already handles it well.
function guidable(m: Material): boolean {
  if (m.kind === 'diffuse') return !m.coat
  if (m.kind === 'metal') return m.roughness >= 1e-3
  return false
}

// Dispatch a primary ray to the configured light-transport algorithm. All
// estimators share this signature so the worker and the single-thread fallback
// stay agnostic about which is selected. `guide`, when present (the 'guided'
// integrator), is the SD-tree the path tracer importance-samples from and trains.
export function integrate(
  scene: Scene,
  ray: Ray,
  settings: IntegratorSettings,
  rng: Rng,
  stats: RayStats,
  gbuf?: GBuffer,
  guide?: Guide,
): Vec3 {
  return settings.integrator === 'bdpt'
    ? radianceBDPT(scene, ray, settings, rng, stats, gbuf)
    : radiance(scene, ray, settings, rng, stats, gbuf, guide)
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
      // A translucent (subsurface) dielectric guides the denoiser with its
      // interior albedo — the colour the eye reads — rather than glass white.
      return m.interior ? m.interior.albedo : v(0.9, 0.95, 1)
    case 'thinfilm':
      return m.base ?? v(0.85, 0.85, 0.95)
    case 'emissive':
      return v(1, 1, 1)
  }
}

// A guiding vertex deferred for radiance recording: after the whole path's
// radiance is known, the incident radiance along the direction sampled here is
// (L_final − L_at_this_vertex) / throughput_after_this_vertex — which is exactly
// what we splat into the SD-tree so it learns where the light comes from.
interface GuideRecord {
  p: Vec3
  wi: Vec3
  lumPrefix: number // luminance of L collected up to & including this vertex
  lumBeta: number // luminance of the throughput carried past this vertex
}

export function radiance(
  scene: Scene,
  ray: Ray,
  settings: IntegratorSettings,
  rng: Rng,
  stats: RayStats,
  gbuf?: GBuffer,
  guide?: Guide,
): Vec3 {
  let L = v(0, 0, 0)
  let beta = v(1, 1, 1)
  let r: Ray = ray
  let specularBounce = true
  let prevPdf = 0
  let prevPoint = ray.o
  // (17.0) Surface normal at `prevPoint`, so the emission-MIS lightPdf can recompute
  // the *receiver-aware* light-tree selection probability that NEE used at that
  // vertex. undefined for a volume/subsurface scatter vertex (no surface ⇒ the light
  // tree falls back to its receiver-agnostic importance there, matching the NEE call).
  let prevNormal: Vec3 | undefined = undefined
  let captured = false
  const clampI = settings.clampIndirect
  // (14.0) Route NEE light selection through the light BVH when the render opts in
  // and the scene actually has triangle lights to build a tree over.
  const useTree = settings.manyLights === true && scene.lightTree !== null
  // (20.0) Next-event-estimate emissive *spheres* by the solid angle they subtend
  // when the render opts in and the scene has any. Off ⇒ spheres keep to BSDF
  // sampling and every light pdf/MIS weight is the historical value, bit-for-bit.
  const useSphere = settings.sphereLights === true && scene.sphereLights.length > 0
  const records: GuideRecord[] | null = guide ? [] : null
  // Beer–Lambert state: the absorption coefficient σ_a of the medium the ray is
  // currently travelling through (null = vacuum). And the path's committed "hero"
  // wavelength for spectral dispersion (0 = not yet chosen / achromatic).
  let medium: Vec3 | null = null
  let lambda = 0
  // Subsurface state: the scattering medium filling the translucent dielectric the
  // path is currently *inside* (null = in vacuum / ordinary glass). Set when the
  // path refracts into a dielectric carrying an `interior` medium, cleared when it
  // refracts back out. While non-null the path random-walks (below) instead of
  // flying straight to the next surface — that walk *is* the subsurface scattering.
  let sss: Subsurface | null = null

  for (let depth = 0; depth <= settings.maxDepth; depth++) {
    stats.rays++
    const hit = scene.intersect(r)
    const tHit = hit ? hit.t : Infinity

    // ---- Subsurface scattering: a random walk inside a translucent dielectric. ----
    // Homogeneous free-flight to the next collision: a distance drawn from the
    // interior's transmittance e^(−σ_t·t). A collision before the boundary scatters
    // via the phase function (β ×= the single-scattering albedo — the surviving
    // fraction, so a low-albedo channel darkens with path length, which is what
    // tints marble/jade/skin); no collision means the path reaches the boundary
    // surface with weight 1 (its survival probability e^(−σ_t·tHit) exactly cancels
    // its own pdf), where the dielectric's Fresnel interface refracts it out or
    // total-internally-reflects it back in (handled by the surface BSDF below). We
    // phase-sample only — no interior NEE: the lights live outside a refractive
    // boundary, so the surrounding scene's NEE takes over unbiasedly once the path
    // exits. This is unidirectional volumetric transport bounded by real geometry.
    if (sss) {
      // (15.0) Chromatic mean free path: when the interior is spectral and the
      // path has committed a hero wavelength, draw the free flight against the
      // *wavelength's* extinction σ_t(λ) and apply the *wavelength's* scalar
      // single-scattering albedo ϖ(λ) — so red light travels far inside skin/
      // marble while blue scatters out near the surface. Colour reconstructs
      // through the committed wavelengthWeight (applied once, on entry); the walk
      // itself is monochromatic. Without spectral data, the scalar 12.0 walk runs
      // exactly as before (one mean free path, per-channel RGB albedo).
      const spectral = sss.sigmaTSpectral !== undefined && sss.albedoSpectral !== undefined && lambda > 0
      const sigmaT = spectral ? spectralAt(sss.sigmaTSpectral!, lambda) : sss.sigmaT
      const tColl = sigmaT > 0 ? -Math.log(1 - rng.next()) / sigmaT : Infinity
      if (tColl < tHit) {
        beta = spectral ? scale(beta, spectralAt(sss.albedoSpectral!, lambda)) : mul(beta, sss.albedo)
        if (isBlack(beta)) break
        const x = madd(r.o, r.d, tColl)
        const wo = neg(r.d)
        // Russian roulette: an interior scatter counts as a bounce.
        if (depth >= settings.rrStart) {
          const q = clamp(maxComponent(beta), 0.05, 0.95)
          if (rng.next() >= q) break
          beta = scale(beta, 1 / q)
        }
        const ph = sampleHG(wo, sss.g, rng)
        // No NEE was done here, so whatever light the walk eventually reaches must
        // be counted in full — flag the event so emitter/env MIS uses weight 1.
        specularBounce = true
        prevPdf = ph.pdf
        prevPoint = x
        prevNormal = undefined
        r = makeRay(x, ph.wi)
        continue
      }
      // No collision before the boundary: fall through to shade the surface (the
      // dielectric interface) at `hit`, reached with unit weight.
    }

    // ---- Participating media: a free-flight collision before the next surface
    // makes the path scatter *inside* a volume rather than reach the surface. ----
    if (scene.hasMedia && !sss) {
      // (16.0) Chromatic media: commit a hero wavelength before tracking, so the
      // free-flight is drawn against the medium's σ_t(λ) (blue scattered out sooner
      // than red — a reddening atmosphere). The RGB weight is taken once
      // (E_λ[w]=(1,1,1) ⇒ unbiased); colour reconstructs over many paths' λ.
      if (scene.hasSpectralMedia && lambda === 0) {
        lambda = LAMBDA_MIN + rng.next() * (LAMBDA_MAX - LAMBDA_MIN)
        beta = mul(beta, wavelengthWeight(lambda))
      }
      const ms = scene.sampleMediumScatter(r.o, r.d, tHit, rng, lambda)
      if (ms) {
        const med = ms.medium
        // ---- Volumetric emission (a glowing medium: fire / embers / nebula). ----
        // A real collision occurs at rate σ_t, of which σ_a = (1−albedo)·σ_t is
        // absorption; an emissive medium re-radiates there, so the path collects
        // (σ_a/σ_t)·Lₑ = (1−albedo)·Lₑ of self-emission, weighted by the throughput
        // *before* the scattering albedo is applied. Because real collisions are
        // density-modulated by delta tracking, the glow naturally pools in the
        // dense core of a heterogeneous field.
        if (med.emission) {
          let ce = mul(beta, mul(v(1 - med.albedo.x, 1 - med.albedo.y, 1 - med.albedo.z), med.emission))
          if (depth > 0 && clampI > 0) ce = clampContribution(ce, clampI)
          L = add(L, ce)
        }
        // β *= single-scattering albedo: the homogeneous distance estimator's
        // weight at a collision is σ_s/σ_t, which is exactly the albedo.
        beta = mul(beta, med.albedo)
        if (isBlack(beta)) break
        const x = madd(r.o, r.d, ms.t)
        const wo = neg(r.d)

        // Russian roulette: a volumetric scatter counts as a bounce.
        if (depth >= settings.rrStart) {
          const q = clamp(maxComponent(beta), 0.05, 0.95)
          if (rng.next() >= q) break
          beta = scale(beta, 1 / q)
        }

        // ---- In-scattering NEE through the phase function (phase↔light MIS). ----
        const ls = scene.sampleLight(x, rng, useTree, undefined, useSphere)
        if (ls && ls.pdf > 0 && !isBlack(ls.radiance)) {
          const phase = hgPhase(dot(wo, ls.wi), med.g)
          if (phase > 0) {
            stats.rays++
            const maxT = ls.dist === Infinity ? Infinity : ls.dist - 1e-3
            if (!scene.occluded(x, ls.wi, EPS, maxT)) {
              const tr = scene.mediaTransmittance(x, ls.wi, ls.dist, rng, lambda)
              const w = powerHeuristic(1, ls.pdf, 1, phase)
              let c = scale(mul(beta, ls.radiance), (phase * tr * w) / ls.pdf)
              if (clampI > 0) c = clampContribution(c, clampI)
              L = add(L, c)
            }
          }
        }

        // ---- Phase sampling: a new direction; HG sampling is exact so β *= 1. ----
        const ph = sampleHG(wo, med.g, rng)
        specularBounce = false
        prevPdf = ph.pdf
        prevPoint = x
        prevNormal = undefined
        r = makeRay(x, ph.wi)
        continue
      }
    }

    // ---- Escaped the scene: gather the environment (MIS vs. sun NEE). ----
    if (!hit) {
      const env = scene.envRadiance(r.d)
      // If the environment exposes a sampled sun and this ray came from a
      // non-specular BSDF bounce, weight it against the light sampler that could
      // also have produced this direction (power heuristic). Outside the sun cone
      // the env pdf is 0, so w = 1 and the sky is gathered in full.
      let w = 1
      if (!specularBounce && scene.hasEnvLight) {
        const ep = scene.envSunPdf(r.d, useSphere)
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
    // ---- Spectral rendering: commit to one hero wavelength on the first
    // wavelength-dependent interaction (dispersive glass or a thin film). ----
    if (lambda === 0 && isSpectral(rawMat)) {
      lambda = LAMBDA_MIN + rng.next() * (LAMBDA_MAX - LAMBDA_MIN)
      beta = mul(beta, wavelengthWeight(lambda))
    }
    const mat = resolveMaterial(rawMat, hit.p, lambda)
    // Procedural bump mapping: dent the shading normal by the material's height
    // field before any BSDF/NEE call so the whole interaction sees the bump.
    hit.n = bumpedNormal(rawMat, hit.p, hit.n, hit.ng)
    const wo = neg(r.d)

    if (gbuf && !captured) {
      gbuf.albedo = albedoGuide(mat)
      gbuf.normal = hit.n
      captured = true
    }

    // ---- Emission (with MIS weighting against the NEE that could have hit it). ----
    if (mat.kind === 'emissive') {
      // Area lights are one-sided: they emit only from their winding-front face,
      // exactly as the NEE sampler (scene.sampleLight) treats them. A back-face
      // hit contributes nothing, so the BSDF-hit and NEE estimators stay
      // consistent (and bidirectional path tracing agrees term for term).
      const Le = hit.frontFace ? mat.emission : v(0, 0, 0)
      if (!isBlack(Le)) {
        let w = 1
        if (!specularBounce) {
          const lp = scene.lightPdf(prevPoint, r.d, hit.primId, hit.t, useTree, prevNormal, useSphere)
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
    // When guiding is active at a guidable vertex whose region is *trained*, the
    // continuation sampler the MIS power heuristic competes against is the
    // *mixture* of the BSDF and the guide, so its pdf for the light direction is
    // α·p_bsdf+(1−α)·p_guide. Under-trained regions keep to plain BSDF sampling.
    const guideTrained = guide !== undefined && guidable(mat) && guide.trainedAt(hit.p)
    if (!isDelta(mat)) {
      const ls = scene.sampleLight(hit.p, rng, useTree, hit.n, useSphere)
      if (ls && ls.pdf > 0 && !isBlack(ls.radiance)) {
        const f = evalBSDF(mat, wo, ls.wi, hit.n)
        const cosX = Math.abs(dot(hit.n, ls.wi))
        if (!isBlack(f) && cosX > 0) {
          const shadowO = offsetOrigin(hit.p, hit.ng, ls.wi)
          stats.rays++
          if (!scene.occluded(shadowO, ls.wi, EPS, ls.dist - 1e-3)) {
            let bp = pdfBSDF(mat, wo, ls.wi, hit.n)
            if (guideTrained) {
              bp = guide!.alpha * bp + (1 - guide!.alpha) * guide!.pdf(hit.p, ls.wi)
            }
            const w = powerHeuristic(1, ls.pdf, 1, bp)
            // β · f · Le · cosθ · w / pdf_light
            let c = mul(mul(beta, f), scale(ls.radiance, (cosX * w) / ls.pdf))
            // Attenuate the light by any media the shadow ray passes through.
            if (scene.hasMedia) c = scale(c, scene.mediaTransmittance(shadowO, ls.wi, ls.dist, rng, lambda))
            if (clampI > 0) c = clampContribution(c, clampI)
            L = add(L, c)
          }
        }
      }
    }

    // ---- Guided sampling: a learned SD-tree drives the next direction. ----
    // At a guidable vertex we draw the continuation from the mixture
    // p(ω)=α·p_bsdf+(1−α)·p_guide and weight by f·cosθ/p(ω); the guide trains
    // from each path's eventual radiance (recorded below). Because p(ω) is an
    // exact density this stays unbiased — guiding only reshapes the variance.
    if (guide !== undefined && guidable(mat)) {
      const alpha = guide.alpha
      let bsWi: Vec3
      let recordWi: Vec3 | null = null
      if (guideTrained && rng.next() >= alpha) {
        const gs = guide.sample(hit.p, rng)
        const cosI = Math.abs(dot(hit.n, gs.wi))
        const f = evalBSDF(mat, wo, gs.wi, hit.n)
        if (isBlack(f) || cosI <= 0 || gs.pdf <= 0) break
        const pB = pdfBSDF(mat, wo, gs.wi, hit.n)
        const mix = alpha * pB + (1 - alpha) * gs.pdf
        if (mix <= 0) break
        beta = mul(beta, scale(f, cosI / mix))
        specularBounce = false
        prevPdf = mix
        bsWi = gs.wi
        recordWi = gs.wi
      } else {
        const bs = sampleBSDF(mat, wo, hit.n, hit.frontFace, rng)
        if (!bs || bs.pdf <= 0 || isBlack(bs.weight)) break
        if (bs.specular) {
          // A guidable material shouldn't return a delta lobe; if one slips
          // through, fall back to plain BSDF sampling and don't record it.
          beta = mul(beta, bs.weight)
          specularBounce = true
          prevPdf = bs.pdf
        } else {
          const pG = guideTrained ? guide.pdf(hit.p, bs.wi) : 0
          const mix = guideTrained ? alpha * bs.pdf + (1 - alpha) * pG : bs.pdf
          beta = mul(beta, scale(bs.weight, bs.pdf / mix))
          specularBounce = false
          prevPdf = mix
          recordWi = bs.wi
        }
        bsWi = bs.wi
      }
      if (isBlack(beta)) break
      prevPoint = hit.p
      prevNormal = hit.n
      if (records && recordWi) {
        records.push({ p: hit.p, wi: recordWi, lumPrefix: luminance(L), lumBeta: luminance(beta) })
      }
      r = makeRay(offsetOrigin(hit.p, hit.ng, bsWi), bsWi)
      continue
    }

    // ---- BSDF sampling: choose the next path direction. ----
    const bs = sampleBSDF(mat, wo, hit.n, hit.frontFace, rng)
    if (!bs || bs.pdf <= 0 || isBlack(bs.weight)) break
    beta = mul(beta, bs.weight)
    specularBounce = bs.specular
    prevPdf = bs.pdf
    prevPoint = hit.p
    prevNormal = hit.n
    // ---- Track medium crossings (Beer–Lambert absorption / subsurface walk). ----
    if (bs.transmission && rawMat.kind === 'dielectric') {
      if (hit.frontFace) {
        // Entering: an `interior` scattering medium begins a subsurface random
        // walk (its absorption is carried by the per-collision albedo, so no
        // separate Beer–Lambert is applied); otherwise a plain `absorption`
        // coefficient drives the analytic Beer–Lambert attenuation above.
        sss = rawMat.interior ?? null
        medium = rawMat.interior ? null : rawMat.absorption ?? null
      } else {
        // Exiting through the back face clears both interior states.
        medium = null
        sss = null
      }
    }
    r = makeRay(offsetOrigin(hit.p, hit.ng, bs.wi), bs.wi)
  }

  // Guard against NaN/Inf leaking into the accumulation buffer.
  if (!Number.isFinite(L.x) || !Number.isFinite(L.y) || !Number.isFinite(L.z)) {
    return v(0, 0, 0)
  }

  // ---- Train the guide: splat each vertex's eventual incident radiance. ----
  // The light gathered *downstream* of a vertex (L_final minus what had been
  // collected when we left it), divided by the throughput carried past it, is a
  // Monte-Carlo estimate of the incident radiance along the direction sampled
  // there — exactly the quantity the SD-tree should be proportional to.
  if (guide && records && records.length > 0) {
    const lumL = luminance(L)
    for (let k = 0; k < records.length; k++) {
      const rec = records[k]
      const down = lumL - rec.lumPrefix
      // Every visited vertex is recorded (so the spatial tree subdivides by path
      // density); the splatted radiance is the downstream-incident estimate, or 0
      // when this path found no light along that direction.
      const value = down > 0 && rec.lumBeta > 1e-6 && Number.isFinite(down) ? down / rec.lumBeta : 0
      guide.record(rec.p, rec.wi, value)
    }
  }
  return L
}

// Clamp a radiance contribution's magnitude to tame fireflies (biased but only
// applied to indirect bounces, where the human eye is least sensitive to it).
function clampContribution(c: Vec3, maxVal: number): Vec3 {
  const m = maxComponent(c)
  return m > maxVal ? scale(c, maxVal / m) : c
}
