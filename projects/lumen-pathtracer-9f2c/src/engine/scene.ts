// scene.ts — assembles a renderable Scene from a serialisable SceneDef: builds
// the primitive list and BVH, indexes the emitters for next-event estimation,
// and exposes intersection / environment / light-sampling queries.
//
// Why triangles-only lights: next-event estimation needs an exact solid-angle
// pdf for any sampled emitter direction, and for a flat triangle that pdf has a
// closed form (d²/(cosθ·A)). Restricting explicit lights to triangles keeps the
// MIS weights provably consistent. Emissive *spheres* are still allowed — they
// simply contribute through BSDF sampling only (their NEE pdf is treated as 0).

import type { Vec3 } from './vec3'
import { add, dot, lerp, madd, neg, normalize, onb, scale, sub, toWorld, v, clamp } from './vec3'
import type { Hit } from './ray'
import { makeRay } from './ray'
import type { Ray } from './ray'
import type { Material } from './material'
import type { Primitive, Triangle } from './primitive'
import { makeSphere, makeTriangle, sampleTriangle, triangleDirPdf } from './primitive'
import { Bvh } from './bvh'
import type { Rng } from './rng'
import type { SceneDef, EnvDef, MediumDef } from './types'
import { makeSky, skyRadiance } from './sky'
import type { SkyState } from './sky'

// A directional "sun" the environment exposes as a sampled light: a cone of
// half-angle `size` around `dir` (the direction toward the sun).
interface EnvSun {
  dir: Vec3
  cosSize: number
  solidAngle: number // 2π(1−cos size)
}

const ENV_PRIM_ID = -1 // sentinel primId for an environment light sample

export interface LightSampleResult {
  wi: Vec3 // unit direction from the shade point toward the light
  dist: number // distance to the sampled light point
  radiance: Vec3 // emitted radiance toward the shade point
  pdf: number // solid-angle pdf (includes the 1/numLights selection prob)
  primId: number
}

// A volumetric scattering event the integrator should service: a free-flight
// collision at distance `t` along the current ray, inside medium `medium`.
export interface MediumScatter {
  t: number
  medium: MediumDef
}

// Ray ∩ sphere, returning the (possibly negative) near/far parameters, or null
// when the ray misses. Used to clip a medium's homogeneous region onto a ray.
function sphereInterval(
  o: Vec3,
  d: Vec3,
  center: Vec3,
  radius: number,
): { t0: number; t1: number } | null {
  const ox = o.x - center.x
  const oy = o.y - center.y
  const oz = o.z - center.z
  const b = ox * d.x + oy * d.y + oz * d.z
  const c = ox * ox + oy * oy + oz * oz - radius * radius
  const disc = b * b - c // d is unit, so a = 1
  if (disc < 0) return null
  const s = Math.sqrt(disc)
  return { t0: -b - s, t1: -b + s }
}

export class Scene {
  readonly materials: Material[]
  readonly prims: Primitive[]
  readonly bvh: Bvh
  readonly lights: number[] // indices into prims of emissive triangles
  readonly env: EnvDef
  readonly cameraDef: SceneDef['camera']
  readonly buildMs: number
  readonly sky: SkyState | null
  readonly envSun: EnvSun | null
  readonly hasEnvLight: boolean
  readonly media: MediumDef[]
  readonly hasMedia: boolean

  constructor(def: SceneDef) {
    const t0 = now()
    this.materials = def.materials
    this.env = def.env
    this.cameraDef = def.camera
    this.prims = def.prims.map((p) =>
      p.kind === 'sphere'
        ? makeSphere(p.center, p.radius, p.material)
        : makeTriangle(p.p0, p.p1, p.p2, p.material, p.n0, p.n1, p.n2),
    )
    this.bvh = new Bvh(this.prims)
    this.lights = []
    for (let i = 0; i < this.prims.length; i++) {
      const prim = this.prims[i]
      if (prim.kind === 'triangle' && this.materials[prim.material].kind === 'emissive') {
        this.lights.push(i)
      }
    }
    this.sky = def.env.kind === 'sky' ? makeSky(def.env) : null
    this.envSun = deriveEnvSun(def.env)
    this.hasEnvLight = this.envSun !== null
    this.media = (def.media ?? []).filter((m) => m.sigmaT > 0 && m.radius > 0)
    this.hasMedia = this.media.length > 0
    this.buildMs = now() - t0
  }

  // Number of explicitly sampled lights = emissive triangles + the sun, if any.
  get numLights(): number {
    return this.lights.length + (this.envSun ? 1 : 0)
  }

  get triangleCount(): number {
    return this.prims.length
  }

  // Closest-hit query, returning a fully shaded interaction or null.
  intersect(ray: Ray): Hit | null {
    const res = this.bvh.intersect(ray.o, ray.d, 1e-4, ray.tMax)
    if (!res) return null
    const { hit, primId } = res
    const p = madd(ray.o, ray.d, hit.t)
    // Front-face and ray offsets are decided by the *geometric* normal so smooth
    // shading can never push the origin to the wrong side of a face.
    const frontFace = dot(ray.d, hit.ng) < 0
    const ng = frontFace ? hit.ng : neg(hit.ng)
    // Shading normal: for a smooth triangle, the barycentric blend of its vertex
    // normals; otherwise the geometric normal. Oriented into the geometric
    // hemisphere so the BSDF frame and the offsets agree.
    let n = ng
    const prim = this.prims[primId]
    if (prim.kind === 'triangle' && prim.smooth) {
      const w0 = 1 - hit.u - hit.v
      const ns = normalize(
        v(
          prim.n0!.x * w0 + prim.n1!.x * hit.u + prim.n2!.x * hit.v,
          prim.n0!.y * w0 + prim.n1!.y * hit.u + prim.n2!.y * hit.v,
          prim.n0!.z * w0 + prim.n1!.z * hit.u + prim.n2!.z * hit.v,
        ),
      )
      n = dot(ns, ng) < 0 ? neg(ns) : ns
    }
    return {
      t: hit.t,
      p,
      n, // shading normal, oriented to face the incoming ray
      ng, // geometric normal, oriented to face the incoming ray
      frontFace,
      material: prim.material,
      primId,
    }
  }

  occluded(o: Vec3, d: Vec3, tMin: number, tMax: number): boolean {
    return this.bvh.occluded(o, d, tMin, tMax)
  }

  // Radiance from the environment for a ray that escapes the scene.
  envRadiance(dir: Vec3): Vec3 {
    const e = this.env
    if (e.kind === 'solid') return e.color
    if (e.kind === 'sky') return skyRadiance(this.sky!, dir, true)
    const tt = 0.5 * (dir.y + 1)
    let col = lerp(e.bottom, e.top, clamp(tt, 0, 1))
    if (e.sunDir && e.sunColor) {
      const sd = normalize(e.sunDir)
      const c = dot(dir, sd)
      const size = e.sunSize ?? 0.02
      const cosSun = Math.cos(size)
      if (c > cosSun) {
        // Soft-edged disc so the sun does not produce a hard alias.
        const k = clamp((c - cosSun) / (1 - cosSun), 0, 1)
        col = add(col, scale(e.sunColor, k))
      }
    }
    return col
  }

  // ---- Next-event estimation -------------------------------------------------

  // Pick one of the scene's lights uniformly and sample a direction toward it.
  // The pool spans the emissive triangles plus, if present, the environment sun;
  // every returned pdf already folds in the 1/numLights selection probability.
  sampleLight(ref: Vec3, rng: Rng): LightSampleResult | null {
    const nTri = this.lights.length
    const nL = nTri + (this.envSun ? 1 : 0)
    if (nL === 0) return null
    const k = rng.int(nL)
    if (k >= nTri) return this.sampleEnvLight(rng, nL)
    const li = this.lights[k]
    const tri = this.prims[li] as Triangle
    const s = sampleTriangle(tri, rng)
    const toLight = sub(s.p, ref)
    const dist2 = dot(toLight, toLight)
    const dist = Math.sqrt(dist2)
    if (dist < 1e-5) return null
    const wi = scale(toLight, 1 / dist)
    // The emitter must face the shade point to contribute.
    const cosLight = dot(s.n, scale(wi, -1))
    if (cosLight <= 1e-6) return null
    const pdfArea = s.pdfArea / nL
    const pdf = (pdfArea * dist2) / cosLight // area → solid-angle conversion
    const mat = this.materials[tri.material]
    const radiance = mat.kind === 'emissive' ? mat.emission : v(0, 0, 0)
    return { wi, dist, radiance, pdf, primId: li }
  }

  // Sample a direction within the sun's cone (uniform in solid angle) and read
  // the environment radiance there. The light is at infinity, so dist = ∞.
  private sampleEnvLight(rng: Rng, nL: number): LightSampleResult | null {
    const sun = this.envSun!
    const u1 = rng.next()
    const u2 = rng.next()
    const cosT = 1 - u1 * (1 - sun.cosSize)
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT))
    const phi = 2 * Math.PI * u2
    const { t, b } = onb(sun.dir)
    const wi = normalize(
      toWorld(v(Math.cos(phi) * sinT, Math.sin(phi) * sinT, cosT), t, b, sun.dir),
    )
    const pdf = 1 / sun.solidAngle / nL
    return { wi, dist: Infinity, radiance: this.envRadiance(wi), pdf, primId: ENV_PRIM_ID }
  }

  // Solid-angle pdf that sampleLight() would have used to generate direction wi
  // toward emissive triangle `primId` — needed to MIS-weight a BSDF hit on it.
  lightPdf(ref: Vec3, wi: Vec3, primId: number, dist: number): number {
    const nL = this.numLights
    if (nL === 0) return 0
    const prim = this.prims[primId]
    if (prim.kind !== 'triangle') return 0
    if (this.materials[prim.material].kind !== 'emissive') return 0
    const pdfTri = triangleDirPdf(prim, ref, wi, dist)
    return pdfTri / nL
  }

  // Solid-angle pdf that the env-light sampler assigns to direction wi: uniform
  // inside the sun cone, zero outside. Used to MIS-weight an escaped BSDF ray.
  envSunPdf(wi: Vec3): number {
    const sun = this.envSun
    if (!sun) return 0
    if (dot(wi, sun.dir) < sun.cosSize) return 0
    return 1 / sun.solidAngle / this.numLights
  }

  // ---- Participating media -------------------------------------------------

  // Sample the nearest free-flight collision along ray (o,d) within [0, tMax].
  // For each bounded medium we clip its sphere onto the ray, then draw a distance
  // from that segment's transmittance e^(−σ_t·s); a draw landing past the segment
  // means "no collision in this medium" (the analytic exit weight is 1). The
  // smallest collision across all (disjoint) media is the event; null ⇒ the ray
  // travels unobstructed to the surface/environment at tMax.
  sampleMediumScatter(o: Vec3, d: Vec3, tMax: number, rng: Rng): MediumScatter | null {
    let best: MediumScatter | null = null
    let bestT = tMax
    for (const m of this.media) {
      const iv = sphereInterval(o, d, m.center, m.radius)
      if (!iv) continue
      const t0 = Math.max(iv.t0, 1e-4)
      const t1 = Math.min(iv.t1, bestT)
      if (t1 <= t0) continue
      const t = t0 - Math.log(1 - rng.next()) / m.sigmaT
      if (t < t1) {
        best = { t, medium: m }
        bestT = t
      }
    }
    return best
  }

  // Scalar transmittance e^(−Σ σ_t·overlap) of a shadow segment of length `dist`
  // through the media — what attenuates a next-event light through fog/smoke.
  mediaTransmittance(o: Vec3, d: Vec3, dist: number): number {
    if (!this.hasMedia) return 1
    let tau = 0
    for (const m of this.media) {
      const iv = sphereInterval(o, d, m.center, m.radius)
      if (!iv) continue
      const t0 = Math.max(iv.t0, 0)
      const t1 = Math.min(iv.t1, dist)
      if (t1 > t0) tau += m.sigmaT * (t1 - t0)
    }
    return tau > 0 ? Math.exp(-tau) : 1
  }

  // Construct a primary ray helper (used by the self-test harness).
  primaryRay(o: Vec3, d: Vec3): Ray {
    return makeRay(o, normalize(d))
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

// Build the sampled sun cone for an environment, if it has one. A daylight
// gradient with a `sunDir`, or any `sky`, contributes a sun the integrator can
// next-event-estimate; a `solid` colour or a sun-less gradient contributes none.
function deriveEnvSun(env: EnvDef): EnvSun | null {
  if (env.kind === 'sky') {
    const dir = normalize(env.sunDir)
    const size = env.sunSize ?? 0.035
    const cosSize = Math.cos(size)
    return { dir, cosSize, solidAngle: 2 * Math.PI * (1 - cosSize) }
  }
  if (env.kind === 'gradient' && env.sunDir) {
    const dir = normalize(env.sunDir)
    const size = env.sunSize ?? 0.04
    const cosSize = Math.cos(size)
    return { dir, cosSize, solidAngle: 2 * Math.PI * (1 - cosSize) }
  }
  return null
}
