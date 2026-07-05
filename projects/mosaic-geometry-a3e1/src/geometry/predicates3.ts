import type { Vec3 } from './vector3'
import { sub3, cross3, dot3, dist3sq, len3sq } from './vector3'

// 3-D geometric predicates — the numerical heart of the Space axis, the exact
// analogues of the plane's `orient` / `inCircle`. As in `predicates.ts` these are
// plain determinant forms (not adaptive à la Shewchuk), evaluated in a frame
// translated to one of the query points to keep magnitudes small; well within
// tolerance for the screen-scale, general-position clouds the studio works with.

/**
 * Orientation / signed volume of the tetrahedron (a, b, c, d).
 *   = det[ b−a ; c−a ; d−a ]  =  6 · signed volume.
 *   > 0  → (a,b,c,d) is a positively-oriented (right-handed) tetrahedron, i.e. d
 *          lies on the side of plane(a,b,c) the normal (b−a)×(c−a) points toward.
 *   < 0  → d lies on the far side.
 *   = 0  → the four points are coplanar.
 */
export function orient3d(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number {
  return dot3(sub3(b, a), cross3(sub3(c, a), sub3(d, a)))
}

/** Six times the signed volume; volume of the tetra is |orient3d| / 6. */
export function signedVolume6(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number {
  return orient3d(a, b, c, d)
}

export interface Sphere {
  center: Vec3
  r2: number // radius squared
}

/**
 * Solve the 3×3 system M·x = r by Cramer's rule. Returns null when the matrix is
 * (near-)singular — the caller reads that as a degenerate (coplanar) configuration.
 * Rows are the three Vec3s; the right-hand side is (r0, r1, r2).
 */
function solve3(m0: Vec3, m1: Vec3, m2: Vec3, r0: number, r1: number, r2: number): Vec3 | null {
  const det =
    m0.x * (m1.y * m2.z - m1.z * m2.y) -
    m0.y * (m1.x * m2.z - m1.z * m2.x) +
    m0.z * (m1.x * m2.y - m1.y * m2.x)
  if (Math.abs(det) < 1e-18) return null
  const inv = 1 / det
  // Cramer: replace column k with the rhs vector.
  const dx =
    r0 * (m1.y * m2.z - m1.z * m2.y) -
    m0.y * (r1 * m2.z - m1.z * r2) +
    m0.z * (r1 * m2.y - m1.y * r2)
  const dy =
    m0.x * (r1 * m2.z - m1.z * r2) -
    r0 * (m1.x * m2.z - m1.z * m2.x) +
    m0.z * (m1.x * r2 - r1 * m2.x)
  const dz =
    m0.x * (m1.y * r2 - r1 * m2.y) -
    m0.y * (m1.x * r2 - r1 * m2.x) +
    r0 * (m1.x * m2.y - m1.y * m2.x)
  return { x: dx * inv, y: dy * inv, z: dz * inv }
}

/**
 * Circumsphere of a tetrahedron: the unique sphere through a, b, c, d, or null if
 * the points are (nearly) coplanar. Found by solving, in the frame centred at a,
 * the three linear equations (p−a)·O' = |p−a|²/2 for p ∈ {b,c,d}, where O' = O − a.
 */
export function circumsphere(a: Vec3, b: Vec3, c: Vec3, d: Vec3): Sphere | null {
  const ba = sub3(b, a)
  const ca = sub3(c, a)
  const da = sub3(d, a)
  const op = solve3(ba, ca, da, len3sq(ba) / 2, len3sq(ca) / 2, len3sq(da) / 2)
  if (!op) return null
  const center = { x: a.x + op.x, y: a.y + op.y, z: a.z + op.z }
  return { center, r2: len3sq(op) }
}

/**
 * Insphere test. Returns
 *   > 0  → e lies strictly inside the circumsphere of tetra (a, b, c, d),
 *   < 0  → strictly outside,
 *   = 0  → on the sphere (or the tetra is degenerate).
 * Built directly on the circumsphere so the sign is unambiguous (no reliance on
 * the orientation of a,b,c,d, unlike the raw 5×5 determinant form).
 */
export function inSphere(a: Vec3, b: Vec3, c: Vec3, d: Vec3, e: Vec3): number {
  const s = circumsphere(a, b, c, d)
  if (!s) return 0
  return s.r2 - dist3sq(e, s.center)
}

/** Plane through three points as an outward normal + offset: n·x = d. */
export interface Plane {
  n: Vec3
  d: number
}

export function planeThrough(a: Vec3, b: Vec3, c: Vec3): Plane {
  const n = cross3(sub3(b, a), sub3(c, a))
  return { n, d: dot3(n, a) }
}

/** Signed distance-proportional value n·p − d (same units as the un-normalised normal). */
export function planeEval(plane: Plane, p: Vec3): number {
  return dot3(plane.n, p) - plane.d
}
