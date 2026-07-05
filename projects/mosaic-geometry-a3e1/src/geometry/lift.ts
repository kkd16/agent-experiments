import type { Point, Triangle } from './types'
import type { Vec3 } from './vector3'
import type { Face3 } from './hull3'
import { convexHull3, faceNormal } from './hull3'

// The lifting map — the deepest single idea in the whole studio, and the reason
// the Space axis exists. Lift each flat point (x, y) onto the paraboloid
//   z = x² + y²,
// take the 3-D convex hull of the lifted points, and look at its **underside**: the
// faces whose outward normal points *down*. Drop those back to the plane and you get
// **exactly the Delaunay triangulation** — because "d is inside the circumcircle of
// (a,b,c)" in the plane is *identical* to "the lifted d is below the plane through the
// lifted (a,b,c)" in space (an orient3d test). The 2-D in-circle predicate is a 3-D
// orientation predicate in disguise. The hull's **upper** faces, symmetrically, drop
// to the farthest-point Delaunay triangulation.
//
// A positive vertical scale of the bowl leaves the lower/upper hull combinatorics
// unchanged (it is a monotone vertical stretch), so the Space page can *animate* the
// points rising onto the paraboloid and the Delaunay mesh is correct at every height.

export interface LiftResult {
  /** The lifted points; index i corresponds to input point i. `zScale` stretches z for display. */
  lifted: Vec3[]
  /** Downward-facing hull faces → the Delaunay triangulation (index triples into the input). */
  lowerFaces: Face3[]
  /** Upward-facing hull faces → the farthest-point Delaunay triangulation. */
  upperFaces: Face3[]
}

/** Lift the plane onto the paraboloid z = zScale·(x² + y²). */
export function liftParaboloid(pts: Point[], zScale = 1): Vec3[] {
  return pts.map((p) => ({ x: p.x, y: p.y, z: zScale * (p.x * p.x + p.y * p.y) }))
}

/**
 * Lift, hull, and split the faces into the down-facing (Delaunay) and up-facing
 * (farthest-point Delaunay) sets. `zScale` only affects the returned `lifted`
 * coordinates for rendering — the face combinatorics are scale-independent.
 */
export function liftMap(pts: Point[], zScale = 1): LiftResult {
  const lifted = liftParaboloid(pts, zScale)
  // Build the hull from the geometric lift (unit scale); combinatorics are identical.
  const geom = zScale === 1 ? lifted : liftParaboloid(pts, 1)
  const hull = convexHull3(geom)
  const lowerFaces: Face3[] = []
  const upperFaces: Face3[] = []
  for (const f of hull.faces) {
    const nz = faceNormal(geom, f).z
    if (nz < -1e-9) lowerFaces.push(f)
    else if (nz > 1e-9) upperFaces.push(f)
  }
  return { lifted, lowerFaces, upperFaces }
}

const asTri = (f: Face3): Triangle => ({ a: f.a, b: f.b, c: f.c })

/** The Delaunay triangulation via the lifting map — the lower-hull faces dropped to the plane. */
export function liftedDelaunay(pts: Point[]): Triangle[] {
  return liftMap(pts).lowerFaces.map(asTri)
}

/** The farthest-point Delaunay triangulation via the lifting map — the upper-hull faces. */
export function liftedFarthestDelaunay(pts: Point[]): Triangle[] {
  return liftMap(pts).upperFaces.map(asTri)
}

/** A canonical unordered key for a triangle (sorted index triple) — for set comparison. */
export function triKey(t: Triangle): string {
  const s = [t.a, t.b, t.c].sort((x, y) => x - y)
  return `${s[0]},${s[1]},${s[2]}`
}

/** Do two triangulations describe the same set of triangles (ignoring order/winding)? */
export function sameTriangleSet(x: Triangle[], y: Triangle[]): boolean {
  if (x.length !== y.length) return false
  const sx = new Set(x.map(triKey))
  for (const t of y) if (!sx.has(triKey(t))) return false
  return true
}
