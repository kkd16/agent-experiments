import type { Circle, Point } from './types'

// Geometric predicates — the numerical heart of every algorithm here. We use the
// standard determinant forms. These are not adaptive-precision (à la Shewchuk),
// but they are evaluated in a frame translated to the query point, which keeps
// the magnitudes small and the float error well within tolerance for an
// interactive studio operating on screen-scale coordinates.

/**
 * Orientation of the triple (a, b, c).
 *   > 0  → counter-clockwise (c is left of the directed line a→b)
 *   < 0  → clockwise (c is right)
 *   = 0  → collinear
 * Equal to twice the signed area of triangle abc.
 */
export function orient(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

const EPS = 1e-9

export function ccw(a: Point, b: Point, c: Point): boolean {
  return orient(a, b, c) > EPS
}

export function collinear(a: Point, b: Point, c: Point): boolean {
  return Math.abs(orient(a, b, c)) <= EPS
}

/**
 * In-circle test. Assuming (a, b, c) is given counter-clockwise, returns
 *   > 0  → d lies strictly inside the circumcircle of a, b, c
 *   < 0  → d lies strictly outside
 *   = 0  → d is on the circle (cocircular)
 * Computed as the 3×3 determinant in coordinates relative to d.
 */
export function inCircle(a: Point, b: Point, c: Point, d: Point): number {
  const ax = a.x - d.x
  const ay = a.y - d.y
  const bx = b.x - d.x
  const by = b.y - d.y
  const cx = c.x - d.x
  const cy = c.y - d.y

  const a2 = ax * ax + ay * ay
  const b2 = bx * bx + by * by
  const c2 = cx * cx + cy * cy

  return (
    a2 * (bx * cy - cx * by) -
    b2 * (ax * cy - cx * ay) +
    c2 * (ax * by - bx * ay)
  )
}

/** Circumcenter of a triangle, or null if the points are (nearly) collinear. */
export function circumcenter(a: Point, b: Point, c: Point): Point | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  if (Math.abs(d) < EPS) return null
  const a2 = a.x * a.x + a.y * a.y
  const b2 = b.x * b.x + b.y * b.y
  const c2 = c.x * c.x + c.y * c.y
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d
  return { x: ux, y: uy }
}

export function circumcircle(a: Point, b: Point, c: Point): Circle | null {
  const center = circumcenter(a, b, c)
  if (!center) return null
  const dx = center.x - a.x
  const dy = center.y - a.y
  return { x: center.x, y: center.y, r: Math.sqrt(dx * dx + dy * dy) }
}
