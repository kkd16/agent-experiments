// Ray–primitive intersection. The Möller–Trumbore test below is the trusted
// reference (used by the self-test and the brute-force baseline); the BVH inlines
// the same arithmetic over flat arrays in its hot loop for speed.
import type { Vec3 } from '../math/vec.ts'

export interface TriHit {
  t: number // ray parameter at the hit
  u: number // barycentric weight of vertex 1
  v: number // barycentric weight of vertex 2 (weight of vertex 0 = 1 − u − v)
}

const EPS = 1e-8

// Möller–Trumbore ray/triangle intersection. Returns the nearest hit in
// (tMin, tMax) or null. `dir` need not be normalized; `t` is in units of `dir`.
export function mollerTrumbore(
  orig: Vec3,
  dir: Vec3,
  p0: Vec3,
  p1: Vec3,
  p2: Vec3,
  tMin: number,
  tMax: number,
): TriHit | null {
  const e1x = p1[0] - p0[0], e1y = p1[1] - p0[1], e1z = p1[2] - p0[2]
  const e2x = p2[0] - p0[0], e2y = p2[1] - p0[1], e2z = p2[2] - p0[2]
  // pvec = dir × e2
  const px = dir[1] * e2z - dir[2] * e2y
  const py = dir[2] * e2x - dir[0] * e2z
  const pz = dir[0] * e2y - dir[1] * e2x
  const det = e1x * px + e1y * py + e1z * pz
  if (det > -EPS && det < EPS) return null // parallel
  const inv = 1 / det
  const tx = orig[0] - p0[0], ty = orig[1] - p0[1], tz = orig[2] - p0[2]
  const u = (tx * px + ty * py + tz * pz) * inv
  if (u < 0 || u > 1) return null
  // qvec = tvec × e1
  const qx = ty * e1z - tz * e1y
  const qy = tz * e1x - tx * e1z
  const qz = tx * e1y - ty * e1x
  const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv
  if (v < 0 || u + v > 1) return null
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv
  if (t < tMin || t > tMax) return null
  return { t, u, v }
}

// Branchless ray/AABB slab test. Returns the entry distance (≤ tMax) or Infinity
// when the ray misses the box within (tMin, tMax). `inv` is 1/dir precomputed.
export function rayAABB(
  ox: number, oy: number, oz: number,
  invx: number, invy: number, invz: number,
  minx: number, miny: number, minz: number,
  maxx: number, maxy: number, maxz: number,
  tMin: number, tMax: number,
): number {
  let t0 = tMin
  let t1 = tMax
  let near = (minx - ox) * invx
  let far = (maxx - ox) * invx
  if (near > far) { const s = near; near = far; far = s }
  if (near > t0) t0 = near
  if (far < t1) t1 = far
  near = (miny - oy) * invy
  far = (maxy - oy) * invy
  if (near > far) { const s = near; near = far; far = s }
  if (near > t0) t0 = near
  if (far < t1) t1 = far
  near = (minz - oz) * invz
  far = (maxz - oz) * invz
  if (near > far) { const s = near; near = far; far = s }
  if (near > t0) t0 = near
  if (far < t1) t1 = far
  return t0 <= t1 ? t0 : Infinity
}
