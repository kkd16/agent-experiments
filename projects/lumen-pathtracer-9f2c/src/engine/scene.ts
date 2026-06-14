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
import { add, dot, lerp, madd, normalize, scale, sub, v, clamp } from './vec3'
import type { Hit } from './ray'
import { makeRay } from './ray'
import type { Ray } from './ray'
import type { Material } from './material'
import type { Primitive, Triangle } from './primitive'
import { makeSphere, makeTriangle, sampleTriangle, triangleDirPdf } from './primitive'
import { Bvh } from './bvh'
import type { Rng } from './rng'
import type { SceneDef, EnvDef } from './types'

export interface LightSampleResult {
  wi: Vec3 // unit direction from the shade point toward the light
  dist: number // distance to the sampled light point
  radiance: Vec3 // emitted radiance toward the shade point
  pdf: number // solid-angle pdf (includes the 1/numLights selection prob)
  primId: number
}

export class Scene {
  readonly materials: Material[]
  readonly prims: Primitive[]
  readonly bvh: Bvh
  readonly lights: number[] // indices into prims of emissive triangles
  readonly env: EnvDef
  readonly cameraDef: SceneDef['camera']
  readonly buildMs: number

  constructor(def: SceneDef) {
    const t0 = now()
    this.materials = def.materials
    this.env = def.env
    this.cameraDef = def.camera
    this.prims = def.prims.map((p) =>
      p.kind === 'sphere'
        ? makeSphere(p.center, p.radius, p.material)
        : makeTriangle(p.p0, p.p1, p.p2, p.material),
    )
    this.bvh = new Bvh(this.prims)
    this.lights = []
    for (let i = 0; i < this.prims.length; i++) {
      const prim = this.prims[i]
      if (prim.kind === 'triangle' && this.materials[prim.material].kind === 'emissive') {
        this.lights.push(i)
      }
    }
    this.buildMs = now() - t0
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
    const frontFace = dot(ray.d, hit.ng) < 0
    const n = frontFace ? hit.ng : scale(hit.ng, -1)
    return {
      t: hit.t,
      p,
      n, // oriented to face the incoming ray
      ng: n,
      frontFace,
      material: this.prims[primId].material,
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

  sampleLight(ref: Vec3, rng: Rng): LightSampleResult | null {
    const nL = this.lights.length
    if (nL === 0) return null
    const li = this.lights[rng.int(nL)]
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

  // Solid-angle pdf that sampleLight() would have used to generate direction wi
  // toward emissive triangle `primId` — needed to MIS-weight a BSDF hit on it.
  lightPdf(ref: Vec3, wi: Vec3, primId: number, dist: number): number {
    const nL = this.lights.length
    if (nL === 0) return 0
    const prim = this.prims[primId]
    if (prim.kind !== 'triangle') return 0
    if (this.materials[prim.material].kind !== 'emissive') return 0
    const pdfTri = triangleDirPdf(prim, ref, wi, dist)
    return pdfTri / nL
  }

  // Construct a primary ray helper (used by the self-test harness).
  primaryRay(o: Vec3, d: Vec3): Ray {
    return makeRay(o, normalize(d))
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
