// A tiny signed-distance-field (SDF) algebra. A `Field` maps a point in space to
// the signed distance to a surface (negative inside, zero on the surface, positive
// outside). Primitives are exact-ish distance bounds; CSG operators combine fields;
// transforms warp the domain. Everything here is a plain closure over numbers — no
// allocation in the hot path — so marching a field over a grid stays cheap.
//
// The distance metaphor is what makes implicit modelling composable: a complex solid
// is just `min`/`max` of simpler ones, and a *smooth* blend (`smoothUnion`) is a tiny
// algebraic tweak that melts two shapes together the way clay would. None of these are
// perfectly unit-gradient after scaling/blending, but marching cubes only needs the
// sign and the zero-crossing, and we read normals from the field gradient — so an
// approximate distance is plenty.
import type { Vec3 } from '../math/vec.ts'

export type Field = (x: number, y: number, z: number) => number

export interface Sdf {
  name: string
  f: Field
  // The axis-aligned box the surface is meshed inside. Marching cubes only visits
  // this region, so it should enclose the whole solid with a little margin.
  bounds: { min: Vec3; max: Vec3 }
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

// ── primitives (centred at the origin) ──────────────────────────────────────────

export const sphere = (r: number): Field => (x, y, z) => Math.sqrt(x * x + y * y + z * z) - r

// Exact box distance: distance to the box surface in the positive octant of |p|−b,
// plus the (negative) interior term so the field stays signed inside.
export const box = (bx: number, by: number, bz: number): Field => (x, y, z) => {
  const qx = Math.abs(x) - bx
  const qy = Math.abs(y) - by
  const qz = Math.abs(z) - bz
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0)
  const outside = Math.sqrt(ox * ox + oy * oy + oz * oz)
  const inside = Math.min(Math.max(qx, Math.max(qy, qz)), 0)
  return outside + inside
}

export const roundBox = (bx: number, by: number, bz: number, r: number): Field => {
  const b = box(bx - r, by - r, bz - r)
  return (x, y, z) => b(x, y, z) - r
}

// Torus in the XZ plane: major radius R, tube radius r.
export const torus = (R: number, r: number): Field => (x, y, z) => {
  const q = Math.sqrt(x * x + z * z) - R
  return Math.sqrt(q * q + y * y) - r
}

// Capped cylinder along Y: radius r, half-height h.
export const cylinder = (r: number, h: number): Field => (x, y, z) => {
  const dx = Math.sqrt(x * x + z * z) - r
  const dy = Math.abs(y) - h
  const ox = Math.max(dx, 0), oy = Math.max(dy, 0)
  return Math.min(Math.max(dx, dy), 0) + Math.sqrt(ox * ox + oy * oy)
}

// Vertical capsule from (0,-h,0) to (0,h,0) with radius r.
export const capsule = (h: number, r: number): Field => (x, y, z) => {
  const yy = y - clamp(y, -h, h)
  return Math.sqrt(x * x + yy * yy + z * z) - r
}

// Infinite plane through the origin with unit normal n.
export const plane = (nx: number, ny: number, nz: number): Field => (x, y, z) =>
  x * nx + y * ny + z * nz

// Gyroid — a triply-periodic minimal surface. The zero set sin x·cos y + … = 0 is the
// classic gyroid; we take a thick shell of it (|g| − t) so it meshes as a solid. `period`
// sets the cell size, `thickness` the wall. Not a metric distance (the trig warps it),
// but its sign is faithful and gradient-based normals come out clean.
export const gyroid = (period: number, thickness: number): Field => {
  const k = (Math.PI * 2) / period
  return (x, y, z) => {
    const g =
      Math.sin(k * x) * Math.cos(k * y) +
      Math.sin(k * y) * Math.cos(k * z) +
      Math.sin(k * z) * Math.cos(k * x)
    // divide by k to keep the field roughly unit-scaled for the marcher's interpolation
    return (Math.abs(g) - thickness) / k
  }
}

// ── boolean / CSG operators ─────────────────────────────────────────────────────

export const union = (a: Field, b: Field): Field => (x, y, z) => Math.min(a(x, y, z), b(x, y, z))
export const intersect = (a: Field, b: Field): Field => (x, y, z) => Math.max(a(x, y, z), b(x, y, z))
export const subtract = (a: Field, b: Field): Field => (x, y, z) => Math.max(a(x, y, z), -b(x, y, z))

// Polynomial smooth-minimum (Inigo Quilez): blends the two fields over a width `k`,
// rounding the seam instead of creasing it. Reduces to `min` as k→0.
export const smin = (a: number, b: number, k: number): number => {
  if (k <= 1e-6) return Math.min(a, b)
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1)
  return b + (a - b) * h - k * h * (1 - h)
}
const smax = (a: number, b: number, k: number): number => -smin(-a, -b, k)

export const smoothUnion = (a: Field, b: Field, k: number): Field => (x, y, z) =>
  smin(a(x, y, z), b(x, y, z), k)
export const smoothIntersect = (a: Field, b: Field, k: number): Field => (x, y, z) =>
  smax(a(x, y, z), b(x, y, z), k)
export const smoothSubtract = (a: Field, b: Field, k: number): Field => (x, y, z) =>
  smax(a(x, y, z), -b(x, y, z), k)

export const unionAll = (fs: Field[]): Field => (x, y, z) => {
  let m = Infinity
  for (const f of fs) { const d = f(x, y, z); if (d < m) m = d }
  return m
}
export const smoothUnionAll = (fs: Field[], k: number): Field => (x, y, z) => {
  let m = fs[0](x, y, z)
  for (let i = 1; i < fs.length; i++) m = smin(m, fs[i](x, y, z), k)
  return m
}

// ── domain transforms (warp the input point) ────────────────────────────────────

export const translate = (f: Field, tx: number, ty: number, tz: number): Field => (x, y, z) =>
  f(x - tx, y - ty, z - tz)

// Uniform scale: shrink the domain by s and re-expand the distance by s so the field
// stays (approximately) a distance.
export const scaleUniform = (f: Field, s: number): Field => (x, y, z) => f(x / s, y / s, z / s) * s

export const rotateY = (f: Field, a: number): Field => {
  const c = Math.cos(a), si = Math.sin(a)
  return (x, y, z) => f(c * x - si * z, y, si * x + c * z)
}
export const rotateX = (f: Field, a: number): Field => {
  const c = Math.cos(a), si = Math.sin(a)
  return (x, y, z) => f(x, c * y - si * z, si * y + c * z)
}
export const rotateZ = (f: Field, a: number): Field => {
  const c = Math.cos(a), si = Math.sin(a)
  return (x, y, z) => f(c * x - si * y, si * x + c * y, z)
}

// Twist around the Y axis: rotation angle grows with height — turns a bar into a helix.
export const twistY = (f: Field, k: number): Field => (x, y, z) => {
  const a = k * y
  const c = Math.cos(a), si = Math.sin(a)
  return f(c * x - si * z, y, si * x + c * z)
}

// Carve a shell of thickness `t` out of any solid (the |·| trick).
export const onion = (f: Field, t: number): Field => (x, y, z) => Math.abs(f(x, y, z)) - t

// Infinite domain repetition on a lattice of spacing `c` — one primitive tiles space.
export const repeat = (f: Field, cx: number, cy: number, cz: number): Field => (x, y, z) => {
  const rx = cx > 0 ? x - cx * Math.round(x / cx) : x
  const ry = cy > 0 ? y - cy * Math.round(y / cy) : y
  const rz = cz > 0 ? z - cz * Math.round(z / cz) : z
  return f(rx, ry, rz)
}

// Central-difference gradient of a field — the (unnormalised) surface normal points
// along it (toward increasing distance, i.e. outward from the solid).
export const gradient = (f: Field, x: number, y: number, z: number, h = 1e-3): Vec3 => [
  (f(x + h, y, z) - f(x - h, y, z)) / (2 * h),
  (f(x, y + h, z) - f(x, y - h, z)) / (2 * h),
  (f(x, y, z + h) - f(x, y, z - h)) / (2 * h),
]
