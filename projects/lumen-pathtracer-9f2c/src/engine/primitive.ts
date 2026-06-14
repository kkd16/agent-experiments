// primitive.ts — geometric primitives: analytic spheres and triangles.
//
// Triangles cache their edges, geometric normal, and area at construction so
// the hot intersection and light-sampling paths touch only precomputed data.

import type { Vec3 } from './vec3'
import { cross, dot, len, madd, normalize, scale, sub, v } from './vec3'
import type { Aabb } from './ray'
import { aabbUnionPoint, aabbEmpty } from './ray'
import type { Rng } from './rng'
import { triangleBary } from './rng'

export interface Sphere {
  kind: 'sphere'
  center: Vec3
  radius: number
  material: number
}

export interface Triangle {
  kind: 'triangle'
  p0: Vec3
  e1: Vec3 // p1 - p0
  e2: Vec3 // p2 - p0
  ng: Vec3 // unit geometric normal
  area: number
  material: number
  // Optional per-vertex shading normals for smooth shading (barycentric blend).
  n0?: Vec3
  n1?: Vec3
  n2?: Vec3
  smooth: boolean
}

export type Primitive = Sphere | Triangle

export function makeSphere(center: Vec3, radius: number, material: number): Sphere {
  return { kind: 'sphere', center, radius, material }
}

export function makeTriangle(
  p0: Vec3,
  p1: Vec3,
  p2: Vec3,
  material: number,
  n0?: Vec3,
  n1?: Vec3,
  n2?: Vec3,
): Triangle {
  const e1 = sub(p1, p0)
  const e2 = sub(p2, p0)
  const nc = cross(e1, e2)
  const area = 0.5 * len(nc)
  const smooth = !!(n0 && n1 && n2)
  return { kind: 'triangle', p0, e1, e2, ng: normalize(nc), area, material, n0, n1, n2, smooth }
}

// A local hit result before the scene fills in shading info. For triangles `u`,`v`
// are the Möller–Trumbore barycentrics (weights of p1, p2; p0 gets 1−u−v); the
// scene uses them to interpolate smooth vertex normals.
export interface PrimHit {
  t: number
  ng: Vec3 // geometric normal (outward / winding-defined; not yet ray-oriented)
  u: number
  v: number
}

const EPS = 1e-6

export function intersectPrim(p: Primitive, o: Vec3, d: Vec3, tMin: number, tMax: number): PrimHit | null {
  return p.kind === 'sphere' ? intersectSphere(p, o, d, tMin, tMax) : intersectTriangle(p, o, d, tMin, tMax)
}

function intersectSphere(s: Sphere, o: Vec3, d: Vec3, tMin: number, tMax: number): PrimHit | null {
  // |o + t d - c|^2 = r^2, solved as a quadratic in t.
  const ocx = o.x - s.center.x
  const ocy = o.y - s.center.y
  const ocz = o.z - s.center.z
  const a = d.x * d.x + d.y * d.y + d.z * d.z
  const halfB = ocx * d.x + ocy * d.y + ocz * d.z
  const c = ocx * ocx + ocy * ocy + ocz * ocz - s.radius * s.radius
  const disc = halfB * halfB - a * c
  if (disc < 0) return null
  const sq = Math.sqrt(disc)
  let t = (-halfB - sq) / a
  if (t < tMin || t > tMax) {
    t = (-halfB + sq) / a
    if (t < tMin || t > tMax) return null
  }
  const px = o.x + d.x * t
  const py = o.y + d.y * t
  const pz = o.z + d.z * t
  const inv = 1 / s.radius
  const ng = v((px - s.center.x) * inv, (py - s.center.y) * inv, (pz - s.center.z) * inv)
  return { t, ng, u: 0, v: 0 }
}

function intersectTriangle(tri: Triangle, o: Vec3, d: Vec3, tMin: number, tMax: number): PrimHit | null {
  // Möller–Trumbore.
  const pvecx = d.y * tri.e2.z - d.z * tri.e2.y
  const pvecy = d.z * tri.e2.x - d.x * tri.e2.z
  const pvecz = d.x * tri.e2.y - d.y * tri.e2.x
  const det = tri.e1.x * pvecx + tri.e1.y * pvecy + tri.e1.z * pvecz
  if (det > -EPS && det < EPS) return null // ray parallel to triangle
  const invDet = 1 / det
  const tvx = o.x - tri.p0.x
  const tvy = o.y - tri.p0.y
  const tvz = o.z - tri.p0.z
  const u = (tvx * pvecx + tvy * pvecy + tvz * pvecz) * invDet
  if (u < 0 || u > 1) return null
  const qvx = tvy * tri.e1.z - tvz * tri.e1.y
  const qvy = tvz * tri.e1.x - tvx * tri.e1.z
  const qvz = tvx * tri.e1.y - tvy * tri.e1.x
  const vv = (d.x * qvx + d.y * qvy + d.z * qvz) * invDet
  if (vv < 0 || u + vv > 1) return null
  const t = (tri.e2.x * qvx + tri.e2.y * qvy + tri.e2.z * qvz) * invDet
  if (t < tMin || t > tMax) return null
  return { t, ng: tri.ng, u, v: vv }
}

export function primBounds(p: Primitive): Aabb {
  if (p.kind === 'sphere') {
    const r = Math.abs(p.radius)
    return {
      min: v(p.center.x - r, p.center.y - r, p.center.z - r),
      max: v(p.center.x + r, p.center.y + r, p.center.z + r),
    }
  }
  const p1 = madd(p.p0, p.e1, 1)
  const p2 = madd(p.p0, p.e2, 1)
  let box = aabbUnionPoint(aabbEmpty(), p.p0)
  box = aabbUnionPoint(box, p1)
  box = aabbUnionPoint(box, p2)
  // Pad any axis the triangle is perfectly flat on. An axis-aligned planar face
  // (a floor quad, a wall, a coplanar mesh facet) otherwise has a zero-thickness
  // slab on that axis, and the ray/AABB tangent test rejects it (tMax == tMin) —
  // so the face would only ever be found when its BVH leaf happened to also hold
  // a non-coplanar primitive. A tiny pad keeps the broad phase robust.
  return padThin(box)
}

// Ensure every axis of a box has a minimum thickness so the slab test never sees
// a degenerate (zero-width) interval. The pad scales with the box so it stays
// negligible relative to the geometry at any scene size.
function padThin(box: Aabb): Aabb {
  const ext = v(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z)
  const maxExt = Math.max(ext.x, ext.y, ext.z)
  const eps = Math.max(1e-5, maxExt * 1e-5)
  const padAxis = (lo: number, hi: number): [number, number] =>
    hi - lo < eps ? [(lo + hi) * 0.5 - eps * 0.5, (lo + hi) * 0.5 + eps * 0.5] : [lo, hi]
  const [minx, maxx] = padAxis(box.min.x, box.max.x)
  const [miny, maxy] = padAxis(box.min.y, box.max.y)
  const [minz, maxz] = padAxis(box.min.z, box.max.z)
  return { min: v(minx, miny, minz), max: v(maxx, maxy, maxz) }
}

// ---------------------------------------------------------------------------
// Area-light sampling (triangles only — see scene.ts for why)
// ---------------------------------------------------------------------------

export interface LightSample {
  p: Vec3 // sampled point on the emitter
  n: Vec3 // emitter surface normal there
  pdfArea: number // pdf w.r.t. surface area
}

export function sampleTriangle(tri: Triangle, rng: Rng): LightSample {
  const { u, v: bv } = triangleBary(rng)
  const p = madd(madd(tri.p0, tri.e1, u), tri.e2, bv)
  return { p, n: tri.ng, pdfArea: 1 / tri.area }
}

// Solid-angle pdf of sampling direction `wi` from `ref` toward this triangle,
// used by MIS when a BSDF-sampled ray happens to land on the light.
export function triangleDirPdf(tri: Triangle, ref: Vec3, wi: Vec3, dist: number): number {
  const cos = Math.abs(dot(tri.ng, wi))
  if (cos < 1e-7) return 0
  // dω = dA · cosθ / d²  ⇒  pdf_ω = d² / (cosθ · A)
  void ref
  return (dist * dist) / (cos * tri.area)
}

export function triangleArea(tri: Triangle): number {
  return tri.area
}

// Convenience for building a quad as two triangles (CCW from p0).
export function quadTriangles(
  p0: Vec3,
  p1: Vec3,
  p2: Vec3,
  p3: Vec3,
  material: number,
): [Triangle, Triangle] {
  return [makeTriangle(p0, p1, p2, material), makeTriangle(p0, p2, p3, material)]
}

export const scaleVec = scale // re-export for scene builders
