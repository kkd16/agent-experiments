import type { Edge, Point, Triangle } from './types'
import { circumcircle } from './predicates'

// Alpha shapes — a one-parameter family of "concave hulls" carved from the
// Delaunay mesh. Intuition: imagine an eraser disk of radius α rolling over the
// point set; it can reach into any concavity wider than 2α. Formally we keep the
// Delaunay triangles whose circumradius ≤ α (a disk of radius α covers them while
// still passing through their three vertices), and the boundary of that retained
// region is the alpha shape.
//
//   • α → ∞   keeps every triangle; the boundary is the convex hull.
//   • α small drops the fat triangles that bridge concavities and holes, so the
//     outline hugs the points and interior voids open up.
//
// This is exact and dependency-free: circumradius is the radius of the circle
// through a triangle's three vertices, which is precisely the smallest α for
// which that triangle is "covered".

export interface AlphaShape {
  /** Boundary edges of the retained region (each borders exactly one kept triangle). */
  boundary: Edge[]
  /** Triangles retained at this α (circumradius ≤ α) — used for the translucent fill. */
  triangles: Triangle[]
  /** Circumradius threshold actually used. */
  alpha: number
}

/** Circumradius of every triangle (∞ for a degenerate, near-collinear triangle). */
export function circumRadii(pts: Point[], tris: Triangle[]): number[] {
  const radii: number[] = []
  for (const t of tris) {
    const c = circumcircle(pts[t.a], pts[t.b], pts[t.c])
    radii.push(c ? c.r : Infinity)
  }
  return radii
}

const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`)

/**
 * Alpha shape for a given α (a circumradius threshold). Retains triangles with
 * circumradius ≤ α and returns the boundary of their union plus the kept set.
 */
export function alphaShape(pts: Point[], tris: Triangle[], alpha: number): AlphaShape {
  const radii = circumRadii(pts, tris)
  const kept: Triangle[] = []
  // Count how many *kept* triangles each edge borders; boundary edges have count 1.
  const counts = new Map<string, { a: number; b: number; n: number }>()
  const bump = (a: number, b: number) => {
    const key = edgeKey(a, b)
    const e = counts.get(key)
    if (e) e.n++
    else counts.set(key, { a, b, n: 1 })
  }
  for (let i = 0; i < tris.length; i++) {
    if (radii[i] > alpha) continue
    const t = tris[i]
    kept.push(t)
    bump(t.a, t.b)
    bump(t.b, t.c)
    bump(t.c, t.a)
  }
  const boundary: Edge[] = []
  for (const e of counts.values()) {
    if (e.n === 1) boundary.push({ a: Math.min(e.a, e.b), b: Math.max(e.a, e.b) })
  }
  return { boundary, triangles: kept, alpha }
}

/**
 * Maps a normalized slider position t ∈ [0,1] to an α value spanning the useful
 * range of circumradii. t = 1 lands above the largest radius (full convex-hull
 * triangulation); t = 0 sits just above the median so the shape stays connected
 * rather than dissolving into specks.
 */
export function alphaForSlider(radii: number[], t: number): number {
  const finite = radii.filter((r) => Number.isFinite(r)).sort((a, b) => a - b)
  if (finite.length === 0) return Infinity
  const max = finite[finite.length - 1]
  const lo = finite[Math.floor(finite.length * 0.35)] // a sensible "hugging" floor
  const clamped = Math.min(1, Math.max(0, t))
  return lo + (max * 1.001 - lo) * clamped
}
