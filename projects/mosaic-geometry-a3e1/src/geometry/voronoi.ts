import type { Point, Rect, VoronoiCell } from './types'
import { rectCorners } from './vector'
import { clipHalfPlane } from './polygon'

// Voronoi diagram by half-plane intersection. For each site we start from the
// clipping rectangle and intersect it with the half-plane closer to that site
// than to every other site (the perpendicular bisector). The result is the exact
// bounded Voronoi cell. This is O(n²) but robust, and gives clean convex polygons
// — exactly what Lloyd relaxation needs (each cell's centroid is well defined).
//
// The bisector between sites s and t keeps the half-plane nearer s:
//   |x - s|² <= |x - t|²  ⟺  2(t - s)·x <= |t|² - |s|²
// so nx = 2(tx - sx), ny = 2(ty - sy), c = |t|² - |s|².

export function voronoiCells(sites: Point[], clip: Rect): VoronoiCell[] {
  const cells: VoronoiCell[] = []
  const rect = rectCorners(clip)
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i]
    let poly = rect
    const s2 = s.x * s.x + s.y * s.y
    for (let j = 0; j < sites.length && poly.length > 0; j++) {
      if (j === i) continue
      const t = sites[j]
      const nx = 2 * (t.x - s.x)
      const ny = 2 * (t.y - s.y)
      const c = t.x * t.x + t.y * t.y - s2
      poly = clipHalfPlane(poly, nx, ny, c)
    }
    cells.push({ site: i, polygon: poly })
  }
  return cells
}

/** Deduplicated Voronoi edges as point pairs, for drawing the diagram skeleton. */
export function voronoiEdges(cells: VoronoiCell[]): [Point, Point][] {
  const seen = new Set<string>()
  const edges: [Point, Point][] = []
  const key = (p: Point, q: Point) => {
    const r = (v: number) => Math.round(v * 100) / 100
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
