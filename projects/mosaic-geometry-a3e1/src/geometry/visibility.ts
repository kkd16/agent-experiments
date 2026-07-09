import type { Point } from './types'
import { orient } from './predicates'

// ── Visibility polygon from a point ─────────────────────────────────────────
//
// Given a viewpoint `q` inside a polygon-with-holes, the *visibility polygon* is
// the star-shaped region of every point the viewpoint can see along an
// unobstructed straight segment. We compute it by an **angular sweep**: the only
// angles at which the visible boundary can switch from one edge to another are
// the directions to the polygon's vertices, so we shoot a ray toward each vertex
// (plus a hair to either side, to slip *past* a vertex and land on the wall
// behind it), keep the nearest edge hit along each ray, and read the hits off in
// angular order. The ε-straddling is the textbook trick that makes the sweep
// robust without an explicit ordered-edge status structure — O(n²) for n edges,
// which is instant at the interactive sizes the studio works with, and every
// output vertex is an exact ray/edge intersection.

export interface Segment {
  a: Point
  b: Point
}

/** Flatten a set of rings (outer + holes) into boundary segments. */
export function ringsToSegments(rings: Point[][]): Segment[] {
  const segs: Segment[] = []
  for (const ring of rings) {
    const n = ring.length
    for (let i = 0; i < n; i++) segs.push({ a: ring[i], b: ring[(i + 1) % n] })
  }
  return segs
}

// Nearest hit of the ray q + t·d (t ≥ 0) against a segment, as a t value, or ∞.
function rayHit(q: Point, dx: number, dy: number, s: Segment): number {
  const ex = s.b.x - s.a.x
  const ey = s.b.y - s.a.y
  const denom = dx * ey - dy * ex
  if (Math.abs(denom) < 1e-15) return Infinity // parallel
  const qx = s.a.x - q.x
  const qy = s.a.y - q.y
  // Solve q + t·d = a + u·e.
  const t = (qx * ey - qy * ex) / denom
  const u = (qx * dy - qy * dx) / denom
  if (t >= 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) return t
  return Infinity
}

/**
 * The visibility polygon of `q` inside the region bounded by `rings` (rings[0]
 * the outer boundary, the rest holes). Returns the visible region as a ring of
 * points in counter-clockwise angular order around `q`.
 */
export function visibilityPolygon(q: Point, rings: Point[][]): Point[] {
  const segs = ringsToSegments(rings)
  if (segs.length === 0) return []

  // Candidate ray directions: toward every vertex, nudged ±ε in angle so a ray
  // aimed at a corner also probes the walls just behind it on either side.
  const EPS = 1e-6
  const dirs: number[] = []
  for (const ring of rings) {
    for (const v of ring) {
      const base = Math.atan2(v.y - q.y, v.x - q.x)
      dirs.push(base - EPS, base, base + EPS)
    }
  }

  const hits: { angle: number; p: Point }[] = []
  for (const ang of dirs) {
    const dx = Math.cos(ang)
    const dy = Math.sin(ang)
    let best = Infinity
    for (const s of segs) {
      const t = rayHit(q, dx, dy, s)
      if (t < best) best = t
    }
    if (best < Infinity) {
      hits.push({ angle: ang, p: { x: q.x + dx * best, y: q.y + dy * best } })
    }
  }

  hits.sort((a, b) => a.angle - b.angle)

  // Drop points that are (nearly) collinear with their neighbours through q — the
  // ε-triples leave three almost-identical points along each clean edge run.
  const out: Point[] = []
  for (const h of hits) {
    const n = out.length
    if (n >= 1) {
      const prev = out[n - 1]
      if (Math.hypot(prev.x - h.p.x, prev.y - h.p.y) < 1e-7) continue
    }
    out.push(h.p)
  }
  // Collinear-through-q simplification.
  const simplified: Point[] = []
  for (let i = 0; i < out.length; i++) {
    const a = simplified[simplified.length - 1]
    const b = out[i]
    const c = out[(i + 1) % out.length]
    if (a && Math.abs(orient(q, a, b)) < 1e-12 && Math.abs(orient(q, b, c)) < 1e-12) continue
    simplified.push(b)
  }
  return simplified.length >= 3 ? simplified : out
}

/**
 * Direct point-to-point visibility inside `rings`: true when the open segment
 * a→b crosses no boundary edge and stays inside the region (its midpoint is in).
 */
export function segmentVisible(a: Point, b: Point, rings: Point[][]): boolean {
  const segs = ringsToSegments(rings)
  for (const s of segs) {
    if (properCross(a, b, s.a, s.b)) return false
  }
  // Sample interior points to reject a chord tunnelling through a hole or notch.
  for (let t = 0.5 / SAMPLES; t < 1; t += 1 / SAMPLES) {
    const m = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    if (!pointInRegion(m, rings)) return false
  }
  return true
}

const SAMPLES = 12

function properCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d1 = orient(p3, p4, p1)
  const d2 = orient(p3, p4, p2)
  const d3 = orient(p1, p2, p3)
  const d4 = orient(p1, p2, p4)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

/** Even-odd membership in a region of rings (outer minus holes handled by parity). */
export function pointInRegion(p: Point, rings: Point[][]): boolean {
  let inside = false
  for (const ring of rings) {
    const n = ring.length
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = ring[i]
      const b = ring[j]
      if ((a.y > p.y) !== (b.y > p.y)) {
        const t = (p.y - a.y) / (b.y - a.y)
        if (p.x < a.x + t * (b.x - a.x)) inside = !inside
      }
    }
  }
  return inside
}
