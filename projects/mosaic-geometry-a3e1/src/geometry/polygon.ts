import type { Point } from './types'

// Convex-polygon utilities used by the Voronoi builder and Lloyd relaxation.

/** Signed area (positive when the vertices wind counter-clockwise). */
export function signedArea(poly: Point[]): number {
  let s = 0
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % n]
    s += a.x * b.y - b.x * a.y
  }
  return s / 2
}

export const area = (poly: Point[]): number => Math.abs(signedArea(poly))

/** Area-weighted centroid of a simple polygon. Falls back to the vertex mean
 *  for degenerate (zero-area) polygons so relaxation never divides by zero. */
export function centroid(poly: Point[]): Point {
  const a2 = signedArea(poly) * 2
  if (Math.abs(a2) < 1e-12) {
    let sx = 0
    let sy = 0
    for (const p of poly) {
      sx += p.x
      sy += p.y
    }
    const n = poly.length || 1
    return { x: sx / n, y: sy / n }
  }
  let cx = 0
  let cy = 0
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % n]
    const f = p.x * q.y - q.x * p.y
    cx += (p.x + q.x) * f
    cy += (p.y + q.y) * f
  }
  return { x: cx / (3 * a2), y: cy / (3 * a2) }
}

/**
 * Clip a convex polygon to the half-plane { (x,y) : nx·x + ny·y <= c }.
 * Sutherland-Hodgman against a single line; returns the inside portion. An empty
 * result means the polygon lies entirely outside the half-plane.
 */
export function clipHalfPlane(poly: Point[], nx: number, ny: number, c: number): Point[] {
  if (poly.length === 0) return poly
  const out: Point[] = []
  const inside = (p: Point) => nx * p.x + ny * p.y <= c
  for (let i = 0, n = poly.length; i < n; i++) {
    const cur = poly[i]
    const prev = poly[(i + n - 1) % n]
    const curIn = inside(cur)
    const prevIn = inside(prev)
    if (curIn) {
      if (!prevIn) out.push(intersect(prev, cur, nx, ny, c))
      out.push(cur)
    } else if (prevIn) {
      out.push(intersect(prev, cur, nx, ny, c))
    }
  }
  return out
}

function intersect(p: Point, q: Point, nx: number, ny: number, c: number): Point {
  const dp = nx * p.x + ny * p.y - c
  const dq = nx * q.x + ny * q.y - c
  const t = dp / (dp - dq)
  return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }
}
