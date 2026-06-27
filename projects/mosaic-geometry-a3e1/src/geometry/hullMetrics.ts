import type { Point } from './types'
import { convexHull } from './convexHull'
import { dist, dist2 } from './vector'

// Metrics that live on the convex hull. The headline pair — the polygon's
// *diameter* (farthest two points) and its *minimum width* — both fall out of
// the rotating-calipers idea: sweep a pair of parallel support lines around the
// hull, and the antipodal vertex they pin out at each step is the only candidate
// you ever need to test. That turns an O(n²) pair search into an O(h) walk over
// the h hull vertices. (Andrew's monotone chain leaves no three hull vertices
// collinear, which keeps the antipodal step unambiguous.)

/** Twice the signed area of triangle abc — the cross product (b-a)×(c-a). */
function cross2(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

export interface FarthestPair {
  p: Point
  q: Point
  dist: number
}

/**
 * Diameter of a point set: its two farthest-apart points, found by rotating
 * calipers over the convex hull. `hull` is the CCW list of hull vertices.
 */
export function diameter(hull: Point[]): FarthestPair | null {
  const n = hull.length
  if (n < 2) return null
  if (n === 2) return { p: hull[0], q: hull[1], dist: dist(hull[0], hull[1]) }

  let best = 0
  let bp = hull[0]
  let bq = hull[1]
  let j = 1
  for (let i = 0; i < n; i++) {
    const ni = (i + 1) % n
    // Advance the antipodal vertex j while it keeps moving away from edge i→ni.
    while (
      Math.abs(cross2(hull[i], hull[ni], hull[(j + 1) % n])) >
      Math.abs(cross2(hull[i], hull[ni], hull[j]))
    ) {
      j = (j + 1) % n
    }
    // The farthest pair touches one of the two antipodal candidates this step.
    for (const u of [i, ni]) {
      const d = dist2(hull[u], hull[j])
      if (d > best) {
        best = d
        bp = hull[u]
        bq = hull[j]
      }
    }
  }
  return { p: bp, q: bq, dist: Math.sqrt(best) }
}

export interface MinWidth {
  width: number
  /** The hull edge that supports the slab (one of the two parallel lines). */
  edge: [Point, Point]
  /** The antipodal vertex the opposite line passes through. */
  support: Point
}

/**
 * Minimum width of a convex polygon: the smallest distance between a pair of
 * parallel supporting lines. The minimum is always achieved with one line flush
 * against a hull edge, so we test each edge against its farthest (antipodal)
 * vertex. `hull` is the CCW list of hull vertices.
 */
export function minWidth(hull: Point[]): MinWidth | null {
  const n = hull.length
  if (n < 3) return null
  let best = Infinity
  let result: MinWidth | null = null
  let j = 1
  for (let i = 0; i < n; i++) {
    const ni = (i + 1) % n
    const base = dist(hull[i], hull[ni]) || 1
    while (
      Math.abs(cross2(hull[i], hull[ni], hull[(j + 1) % n])) >
      Math.abs(cross2(hull[i], hull[ni], hull[j]))
    ) {
      j = (j + 1) % n
    }
    const w = Math.abs(cross2(hull[i], hull[ni], hull[j])) / base
    if (w < best) {
      best = w
      result = { width: w, edge: [hull[i], hull[ni]], support: hull[j] }
    }
  }
  return result
}

/** Perimeter of the (closed) hull polygon. */
export function perimeter(hull: Point[]): number {
  if (hull.length < 2) return 0
  let s = 0
  for (let i = 0; i < hull.length; i++) s += dist(hull[i], hull[(i + 1) % hull.length])
  return s
}

/** Absolute area enclosed by the hull polygon (shoelace). */
export function hullArea(hull: Point[]): number {
  let s = 0
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]
    const b = hull[(i + 1) % hull.length]
    s += a.x * b.y - b.x * a.y
  }
  return Math.abs(s) / 2
}

/**
 * Convex layers ("onion peeling"): repeatedly strip the convex hull and recurse
 * on the interior. The result is a set of nested rings — a structure used in
 * robust statistics (convex-hull peeling depth) and in some k-nearest queries.
 * Each layer is returned as a list of indices into the original point array.
 */
export function convexLayers(pts: Point[]): number[][] {
  const layers: number[][] = []
  let remaining = pts.map((_, i) => i)
  while (remaining.length > 0) {
    const sub = remaining.map((i) => pts[i])
    const hullLocal = convexHull(sub) // indices into `sub`
    const layer = hullLocal.map((li) => remaining[li])
    layers.push(layer)
    const onHull = new Set(layer)
    const next = remaining.filter((i) => !onHull.has(i))
    if (next.length === remaining.length) break // safety: nothing peeled
    remaining = next
  }
  return layers
}
