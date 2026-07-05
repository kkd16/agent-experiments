// Small 3-D vector helpers — the spine of the Space axis (hull3, lift, delaunay3,
// and the software renderer). Mirrors `vector.ts` in the plane: everything here is
// pure and allocation-light so the incremental-hull and Bowyer–Watson hot loops stay
// cheap. Points are plain {x,y,z} in world coordinates.

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Box3 {
  min: Vec3
  max: Vec3
}

export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z })

export const sub3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
export const add3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
export const scale3 = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s })
export const negate3 = (a: Vec3): Vec3 => ({ x: -a.x, y: -a.y, z: -a.z })

export const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z

export const cross3 = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})

export const len3sq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z
export const len3 = (a: Vec3): number => Math.sqrt(len3sq(a))

export const dist3sq = (a: Vec3, b: Vec3): number => {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz
}
export const dist3 = (a: Vec3, b: Vec3): number => Math.sqrt(dist3sq(a, b))

/** Unit vector, or (0,0,0) for a (near-)zero input so callers never divide by 0. */
export function normalize3(a: Vec3): Vec3 {
  const l = len3(a)
  if (l < 1e-15) return { x: 0, y: 0, z: 0 }
  return { x: a.x / l, y: a.y / l, z: a.z / l }
}

export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
})

/** Tight axis-aligned bounding box of a point set (zero box for no points). */
export function bounds3(points: Vec3[]): Box3 {
  if (points.length === 0) return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const p of points) {
    if (p.x < min.x) min.x = p.x
    if (p.y < min.y) min.y = p.y
    if (p.z < min.z) min.z = p.z
    if (p.x > max.x) max.x = p.x
    if (p.y > max.y) max.y = p.y
    if (p.z > max.z) max.z = p.z
  }
  return { min, max }
}

/** Arithmetic mean of a point set (a strictly-interior point for a convex cloud). */
export function centroid3(points: Vec3[]): Vec3 {
  if (points.length === 0) return { x: 0, y: 0, z: 0 }
  let x = 0
  let y = 0
  let z = 0
  for (const p of points) {
    x += p.x
    y += p.y
    z += p.z
  }
  const n = points.length
  return { x: x / n, y: y / n, z: z / n }
}

/** Centre of a box's diagonal + half its diagonal length (a handy view-fit radius). */
export function boxCenter(b: Box3): Vec3 {
  return { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 }
}
export function boxRadius(b: Box3): number {
  return dist3(b.min, b.max) / 2
}
