import type { Edge, Point, Rect, VoronoiCell } from './types'
import { rectCorners } from './vector'
import { clipHalfPlane } from './polygon'

// Power diagrams (a.k.a. Laguerre / radical Voronoi) — the weighted
// generalization of the Voronoi diagram. Each site s carries a weight w (think
// of it as a *squared radius*); distances are measured by the **power distance**
//
//     pow(x, s) = |x − s|² − w
//
// and the cell of a site is the region where its power distance is smallest. The
// bisector between two weighted sites is their **radical axis** — still a straight
// line perpendicular to the segment joining them, but shifted toward the lighter
// site. So the *exact same* robust half-plane-intersection machinery the Voronoi
// builder uses (`voronoi.ts`) works here verbatim, with one substitution: the
// constant in each half-plane carries the weights.
//
// Derivation of the half-plane that keeps x nearer (in power) to site i than j:
//   |x−sᵢ|² − wᵢ ≤ |x−sⱼ|² − wⱼ
//   ⟺ 2(sⱼ − sᵢ)·x ≤ (|sⱼ|² − wⱼ) − (|sᵢ|² − wᵢ)
// With all weights equal this collapses to the perpendicular bisector and the
// power diagram becomes the ordinary Voronoi diagram — a fact the self-test pins.
//
// Two things make power diagrams genuinely different from Voronoi:
//   • a site can lie *outside* its own cell, and
//   • a heavily out-weighted site can vanish entirely (an empty cell). Such a
//     site is **hidden** / redundant and contributes no face to the diagram.

export interface WeightedSite {
  x: number
  y: number
  w: number
}

/** Power distance from the point (px,py) to a weighted site: |x−s|² − w. */
export function powerDistance(px: number, py: number, s: WeightedSite): number {
  const dx = px - s.x
  const dy = py - s.y
  return dx * dx + dy * dy - s.w
}

/**
 * Power (Laguerre) cells, one per site, clipped to `clip`. A site whose cell is
 * empty (degenerate polygon, < 3 vertices) is *hidden* — outweighed by its
 * neighbours. O(n²), robust, and produces clean convex polygons just like the
 * Voronoi builder, so power-Lloyd relaxation has well-defined centroids.
 */
export function powerCells(sites: WeightedSite[], clip: Rect): VoronoiCell[] {
  const cells: VoronoiCell[] = []
  const rect = rectCorners(clip)
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i]
    let poly = rect
    const ci = s.x * s.x + s.y * s.y - s.w
    for (let j = 0; j < sites.length && poly.length > 0; j++) {
      if (j === i) continue
      const t = sites[j]
      const nx = 2 * (t.x - s.x)
      const ny = 2 * (t.y - s.y)
      const c = t.x * t.x + t.y * t.y - t.w - ci
      poly = clipHalfPlane(poly, nx, ny, c)
    }
    cells.push({ site: i, polygon: poly })
  }
  return cells
}

/** Indices of hidden (redundant) sites — those with an empty power cell. */
export function hiddenSites(cells: VoronoiCell[]): number[] {
  const hidden: number[] = []
  for (const cell of cells) if (cell.polygon.length < 3) hidden.push(cell.site)
  return hidden
}

/**
 * Edges of the **regular (weighted Delaunay) triangulation** — the straight-line
 * dual of the power diagram. Two sites are dual-adjacent exactly when their power
 * cells share a boundary segment of positive length. We read that off the cells
 * directly: every interior boundary edge of cell i has a midpoint m where, by
 * construction, pow(m, i) ties the minimum with exactly the neighbouring site
 * across that edge. So for each cell edge we find the site j ≠ i minimizing the
 * power distance at the midpoint; if that minimum *ties* pow(m, i) the edge is
 * shared (dual edge i–j), otherwise the edge lies on the clip frame.
 *
 * With equal weights this returns precisely the Delaunay edge set.
 */
export function regularTriangulationEdges(sites: WeightedSite[], cells: VoronoiCell[]): Edge[] {
  const edges: Edge[] = []
  const seen = new Set<number>()
  for (let i = 0; i < cells.length; i++) {
    const poly = cells[i].polygon
    if (poly.length < 3) continue
    for (let k = 0, n = poly.length; k < n; k++) {
      const p = poly[k]
      const q = poly[(k + 1) % n]
      const mx = (p.x + q.x) / 2
      const my = (p.y + q.y) / 2
      const pi = powerDistance(mx, my, sites[i])
      let bj = -1
      let bd = Infinity
      for (let j = 0; j < sites.length; j++) {
        if (j === i) continue
        const d = powerDistance(mx, my, sites[j])
        if (d < bd) {
          bd = d
          bj = j
        }
      }
      if (bj < 0) continue
      // Interior shared edge ⟺ the nearest other site ties pow(m, i). The frame
      // edges fail this by a wide margin. Tolerance scales with the magnitudes.
      const tol = 1e-7 * (1 + Math.abs(pi) + Math.abs(bd))
      if (Math.abs(bd - pi) <= tol) {
        const a = Math.min(i, bj)
        const b = Math.max(i, bj)
        const code = a * 1_000_003 + b
        if (!seen.has(code)) {
          seen.add(code)
          edges.push({ a, b })
        }
      }
    }
  }
  return edges
}

/**
 * The **radical circle** of a weighted site: centre s, radius √w (only for
 * positive weights). Two such circles' radical axis is exactly the power bisector,
 * which is what makes the picture click — where the circles cross, the cell wall
 * passes. Returns null for non-positive weights (no real circle).
 */
export function radicalCircle(s: WeightedSite): { x: number; y: number; r: number } | null {
  if (s.w <= 0) return null
  return { x: s.x, y: s.y, r: Math.sqrt(s.w) }
}

/**
 * One step of **weighted (power) Lloyd relaxation**: move every site to the
 * centroid of its power cell, keeping its weight. Hidden sites (empty cells) stay
 * put. Returns the new sites and the mean displacement, mirroring `lloydStep`.
 */
export function powerLloydStep(
  sites: WeightedSite[],
  clip: Rect,
): { sites: WeightedSite[]; movement: number } {
  const cells = powerCells(sites, clip)
  const next = sites.slice()
  let moved = 0
  let count = 0
  for (const cell of cells) {
    const poly = cell.polygon
    if (poly.length < 3) continue
    const c = polygonCentroid(poly)
    const s = sites[cell.site]
    const dx = c.x - s.x
    const dy = c.y - s.y
    moved += Math.hypot(dx, dy)
    count++
    next[cell.site] = { x: c.x, y: c.y, w: s.w }
  }
  return { sites: next, movement: count ? moved / count : 0 }
}

// ── Step-by-step trace: building one power cell ──────────────────────────────

export interface PowerCellStep {
  /** The cell polygon after the clips applied so far. */
  poly: Point[]
  /** Index of the site whose radical axis was just applied (−1 at the start). */
  against: number
  /** That radical axis as a long segment spanning the frame (null at the start). */
  line: [Point, Point] | null
  note: string
}

/**
 * Trace the half-plane construction of a *single* power cell (site `target`):
 * start from the clip rectangle and clip against each other site's radical axis
 * in turn, nearest sites first so the cell tightens quickly. Mirrors how the
 * Voronoi/power builders work, made legible step by step.
 */
export function powerCellSteps(sites: WeightedSite[], clip: Rect, target: number): PowerCellStep[] {
  const steps: PowerCellStep[] = []
  if (target < 0 || target >= sites.length) return steps
  const s = sites[target]
  const ci = s.x * s.x + s.y * s.y - s.w
  let poly = rectCorners(clip)
  steps.push({ poly: [...poly], against: -1, line: null, note: 'Start from the whole frame — the cell before any walls are added.' })

  // Order the other sites by distance to the target so the cell shrinks fast.
  const order = sites
    .map((_, j) => j)
    .filter((j) => j !== target)
    .sort((a, b) => {
      const da = (sites[a].x - s.x) ** 2 + (sites[a].y - s.y) ** 2
      const db = (sites[b].x - s.x) ** 2 + (sites[b].y - s.y) ** 2
      return da - db
    })

  for (const j of order) {
    const t = sites[j]
    const nx = 2 * (t.x - s.x)
    const ny = 2 * (t.y - s.y)
    const c = t.x * t.x + t.y * t.y - t.w - ci
    const before = poly.length
    poly = clipHalfPlane(poly, nx, ny, c)
    // The radical axis nx·x + ny·y = c, as a long segment for drawing.
    const norm2 = nx * nx + ny * ny || 1
    const foot = { x: (c * nx) / norm2, y: (c * ny) / norm2 }
    const dir = { x: -ny, y: nx }
    const dl = Math.hypot(dir.x, dir.y) || 1
    const L = 4 * Math.max(clip.maxX - clip.minX, clip.maxY - clip.minY)
    const line: [Point, Point] = [
      { x: foot.x - (dir.x / dl) * L, y: foot.y - (dir.y / dl) * L },
      { x: foot.x + (dir.x / dl) * L, y: foot.y + (dir.y / dl) * L },
    ]
    const trimmed = poly.length !== before || poly.length === 0
    steps.push({
      poly: [...poly],
      against: j,
      line,
      note: trimmed
        ? 'Clip against this neighbour’s radical axis — the cell keeps only the side with smaller power distance.'
        : 'This neighbour is too far to matter — its radical axis misses the cell.',
    })
    if (poly.length === 0) break
  }
  steps.push({ poly: [...poly], against: -1, line: null, note: poly.length >= 3 ? 'Every wall applied — this is the finished power cell.' : 'All space clipped away — this site is hidden (outweighed by its neighbours).' })
  return steps
}

// Local area-weighted centroid (kept here to avoid importing the Point-typed
// helper and re-wrapping; identical formula).
function polygonCentroid(poly: Point[]): Point {
  let a2 = 0
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % n]
    a2 += p.x * q.y - q.x * p.y
  }
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
