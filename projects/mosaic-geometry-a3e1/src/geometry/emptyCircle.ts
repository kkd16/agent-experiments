import type { Circle, Point, Triangle } from './types'
import { circumcircle, orient } from './predicates'

// Largest empty circle (centre constrained to the convex hull): the biggest disk
// you can place over the point set that touches no site, with its centre inside
// the hull. The key fact is that such a circle's centre sits at a Voronoi vertex
// — and every (interior) Voronoi vertex is the circumcentre of a Delaunay
// triangle, the circle being that triangle's circumcircle. So we just scan the
// Delaunay triangles, keep the ones whose circumcentre lies inside the hull, and
// take the largest circumcircle. By the Delaunay empty-circle property that disk
// is automatically site-free.

/** Inside-or-on test for a CCW convex polygon (the hull). */
function insideHull(hull: Point[], p: Point): boolean {
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]
    const b = hull[(i + 1) % hull.length]
    if (orient(a, b, p) < -1e-9) return false
  }
  return true
}

export interface EmptyCircle {
  circle: Circle
  /** The three sites whose Delaunay triangle defines the circle. */
  sites: [Point, Point, Point]
}

/**
 * Largest empty circle whose centre lies inside the convex hull.
 * `hullPts` is the CCW list of hull vertices.
 */
export function largestEmptyCircle(
  pts: Point[],
  tris: Triangle[],
  hullPts: Point[],
): EmptyCircle | null {
  if (hullPts.length < 3) return null
  let best: EmptyCircle | null = null
  for (const t of tris) {
    const c = circumcircle(pts[t.a], pts[t.b], pts[t.c])
    if (!c) continue
    if (!insideHull(hullPts, c)) continue
    if (!best || c.r > best.circle.r) {
      best = { circle: c, sites: [pts[t.a], pts[t.b], pts[t.c]] }
    }
  }
  return best
}
