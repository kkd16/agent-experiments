import type { Point, Rect, VoronoiCell } from './types'
import { rectCorners } from './vector'
import { clipHalfPlane } from './polygon'

// The **farthest-point Voronoi diagram** — the inside-out twin of the ordinary
// (nearest-point) Voronoi diagram. Cell(s) is the region of the plane whose
// *farthest* input site is s:
//
//     FCell(sᵢ) = { x : |x − sᵢ| ≥ |x − sⱼ|  for all j }
//
// Two structural facts make it worth its own layer:
//   • Only the **convex-hull vertices** own a non-empty cell. An interior point
//     is never the farthest site of anywhere, so its cell is empty.
//   • The diagram has **no bounded cells** — it is an unbounded tree. Clipped to
//     the frame it tiles it with h convex regions (h = hull size).
//
// It is built by the same half-plane intersection as the nearest diagram, but
// keeping the *opposite* half-plane of every bisector — the side on which sᵢ is
// the farther of the pair:
//   |x−sᵢ|² ≥ |x−sⱼ|²  ⟺  2(sᵢ − sⱼ)·x ≤ |sᵢ|² − |sⱼ|²
//
// A lovely consequence: the centre of the smallest enclosing circle is a vertex
// of (or lies on an edge of) this diagram — the studio highlights that link.

export function farthestCells(sites: Point[], clip: Rect): VoronoiCell[] {
  const cells: VoronoiCell[] = []
  const rect = rectCorners(clip)
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i]
    let poly = rect
    const si = s.x * s.x + s.y * s.y
    for (let j = 0; j < sites.length && poly.length > 0; j++) {
      if (j === i) continue
      const t = sites[j]
      const nx = 2 * (s.x - t.x)
      const ny = 2 * (s.y - t.y)
      const c = si - (t.x * t.x + t.y * t.y)
      poly = clipHalfPlane(poly, nx, ny, c)
    }
    cells.push({ site: i, polygon: poly })
  }
  return cells
}

/** Deduplicated farthest-diagram edges (its tree skeleton), for drawing. */
export function farthestEdges(cells: VoronoiCell[]): [Point, Point][] {
  const seen = new Set<string>()
  const edges: [Point, Point][] = []
  const key = (p: Point, q: Point) => {
    const r = (v: number) => Math.round(v * 10000) / 10000
    const a = `${r(p.x)},${r(p.y)}`
    const b = `${r(q.x)},${r(q.y)}`
    return a < b ? `${a}|${b}` : `${b}|${a}`
  }
  for (const cell of cells) {
    const poly = cell.polygon
    for (let i = 0, n = poly.length; i < n; i++) {
      const p = poly[i]
      const q = poly[(i + 1) % n]
      const k = key(p, q)
      if (!seen.has(k)) {
        seen.add(k)
        edges.push([p, q])
      }
    }
  }
  return edges
}

/** Indices of sites that actually own a (non-empty) farthest cell — exactly the
 *  convex-hull vertices, recovered straight from the diagram. */
export function farthestOwners(cells: VoronoiCell[]): number[] {
  const owners: number[] = []
  for (const cell of cells) if (cell.polygon.length >= 3) owners.push(cell.site)
  return owners
}
