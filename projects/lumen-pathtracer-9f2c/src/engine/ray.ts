// ray.ts — rays, axis-aligned bounding boxes, and the surface hit record.

import type { Vec3 } from './vec3'
import { madd, minV, maxV, v } from './vec3'

export interface Ray {
  o: Vec3 // origin
  d: Vec3 // direction (kept unit-length)
  tMax: number
}

export const makeRay = (o: Vec3, d: Vec3, tMax = Infinity): Ray => ({ o, d, tMax })
export const rayAt = (r: Ray, t: number): Vec3 => madd(r.o, r.d, t)

// A surface interaction: everything shading needs at the hit point.
export interface Hit {
  t: number
  p: Vec3 // world position
  n: Vec3 // shading normal, oriented against the incoming ray
  ng: Vec3 // geometric (face) normal, oriented against the incoming ray
  frontFace: boolean // did the ray hit the outward-facing side?
  material: number // index into the scene material table
  primId: number // index into the primitive table (for light pdf lookups)
}

// Axis-aligned bounding box. `empty` is an inverted box that grows on union.
export interface Aabb {
  min: Vec3
  max: Vec3
}

export const aabbEmpty = (): Aabb => ({
  min: v(Infinity, Infinity, Infinity),
  max: v(-Infinity, -Infinity, -Infinity),
})

export const aabbUnion = (a: Aabb, b: Aabb): Aabb => ({
  min: minV(a.min, b.min),
  max: maxV(a.max, b.max),
})

export const aabbUnionPoint = (a: Aabb, p: Vec3): Aabb => ({
  min: minV(a.min, p),
  max: maxV(a.max, p),
})

export const aabbCenter = (a: Aabb): Vec3 => ({
  x: (a.min.x + a.max.x) * 0.5,
  y: (a.min.y + a.max.y) * 0.5,
  z: (a.min.z + a.max.z) * 0.5,
})

export const aabbSurfaceArea = (a: Aabb): number => {
  const dx = a.max.x - a.min.x
  const dy = a.max.y - a.min.y
  const dz = a.max.z - a.min.z
  if (dx < 0 || dy < 0 || dz < 0) return 0
  return 2 * (dx * dy + dy * dz + dz * dx)
}

// Slab test. `invD` and `sign` are precomputed per ray for speed. Returns true
// if the box is hit within (tMin, tMax).
export const aabbHit = (
  box: Aabb,
  o: Vec3,
  invD: Vec3,
  tMin: number,
  tMax: number,
): boolean => {
  let t0 = (box.min.x - o.x) * invD.x
  let t1 = (box.max.x - o.x) * invD.x
  if (invD.x < 0) {
    const tmp = t0
    t0 = t1
    t1 = tmp
  }
  if (t0 > tMin) tMin = t0
  if (t1 < tMax) tMax = t1
  if (tMax <= tMin) return false

  t0 = (box.min.y - o.y) * invD.y
  t1 = (box.max.y - o.y) * invD.y
  if (invD.y < 0) {
    const tmp = t0
    t0 = t1
    t1 = tmp
  }
  if (t0 > tMin) tMin = t0
  if (t1 < tMax) tMax = t1
  if (tMax <= tMin) return false

  t0 = (box.min.z - o.z) * invD.z
  t1 = (box.max.z - o.z) * invD.z
  if (invD.z < 0) {
    const tmp = t0
    t0 = t1
    t1 = tmp
  }
  if (t0 > tMin) tMin = t0
  if (t1 < tMax) tMax = t1
  return tMax > tMin
}
