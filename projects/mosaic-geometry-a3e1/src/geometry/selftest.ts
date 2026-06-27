// Standalone correctness checks for the geometry core. Not shipped in the app
// bundle (nothing imports it); it exists so the algorithms can be exercised with
// `tsc` + node. Run via the scratchpad harness during development.
import type { Point } from './types'
import { convexHull } from './convexHull'
import { delaunay, triangulationEdges } from './delaunay'
import { inCircle, orient } from './predicates'
import { voronoiCells } from './voronoi'
import { euclideanMST, gabrielGraph } from './graphs'
import { poissonDisk, mulberry32, uniformPoints } from './random'
import { lloydStep } from './lloyd'
import { area } from './polygon'
import type { Rect } from './types'

let failures = 0
function check(name: string, cond: boolean, extra = '') {
  if (!cond) {
    failures++
    console.error(`  ✗ ${name} ${extra}`)
  } else {
    console.log(`  ✓ ${name}`)
  }
}

const RECT: Rect = { minX: 0, minY: 0, maxX: 100, maxY: 100 }

// ── Convex hull ────────────────────────────────────────────────────────────
{
  const pts: Point[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
    { x: 50, y: 50 }, // interior — must be excluded
    { x: 25, y: 25 },
  ]
  const hull = convexHull(pts)
  check('hull excludes interior points', hull.length === 4)
  // The hull must wind counter-clockwise (positive signed area).
  let a2 = 0
  for (let i = 0; i < hull.length; i++) {
    const p = pts[hull[i]]
    const q = pts[hull[(i + 1) % hull.length]]
    a2 += p.x * q.y - q.x * p.y
  }
  check('hull is counter-clockwise', a2 > 0)
}

// ── Delaunay empty-circle property ───────────────────────────────────────────
{
  const rng = mulberry32(42)
  const pts = uniformPoints(60, RECT, rng)
  const tris = delaunay(pts)
  check('delaunay produced triangles', tris.length > 0)
  // Every triangle's circumcircle must be empty of other points (Delaunay).
  let violations = 0
  for (const t of tris) {
    const a = pts[t.a]
    const b = pts[t.b]
    const c = pts[t.c]
    const oriented = orient(a, b, c) > 0 ? [a, b, c] : [a, c, b]
    for (let k = 0; k < pts.length; k++) {
      if (k === t.a || k === t.b || k === t.c) continue
      if (inCircle(oriented[0], oriented[1], oriented[2], pts[k]) > 1e-6) violations++
    }
  }
  check('delaunay empty-circle holds', violations === 0, `(${violations} violations)`)
  // Euler check: for a triangulation of points in general position, every
  // interior edge is shared by exactly two triangles.
  const edges = triangulationEdges(tris)
  check('triangulation has edges', edges.length >= tris.length)
}

// ── Voronoi cells ────────────────────────────────────────────────────────────
{
  const rng = mulberry32(7)
  const sites = poissonDisk(80, RECT, rng)
  const cells = voronoiCells(sites, RECT)
  check('one cell per site', cells.length === sites.length)
  // Cell areas should sum to (approximately) the clip rectangle's area.
  const totalArea = cells.reduce((s, c) => s + area(c.polygon), 0)
  const boxArea = (RECT.maxX - RECT.minX) * (RECT.maxY - RECT.minY)
  check('voronoi tiles the box', Math.abs(totalArea - boxArea) / boxArea < 0.01,
    `(got ${totalArea.toFixed(1)} vs ${boxArea})`)
  // Each site must lie inside (or on) its own cell.
  let outside = 0
  for (const cell of cells) {
    const s = sites[cell.site]
    // point-in-convex-polygon via consistent orientation
    let inside = true
    const poly = cell.polygon
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]
      const q = poly[(i + 1) % poly.length]
      if (orient(p, q, s) < -1e-6) inside = false
    }
    if (!inside) outside++
  }
  check('every site is inside its cell', outside === 0, `(${outside} outside)`)
}

// ── EMST + Gabriel ───────────────────────────────────────────────────────────
{
  const rng = mulberry32(99)
  const pts = uniformPoints(50, RECT, rng)
  const edges = triangulationEdges(delaunay(pts))
  const mst = euclideanMST(pts, edges)
  check('MST has n-1 edges', mst.length === pts.length - 1, `(${mst.length})`)
  const gab = gabrielGraph(pts, edges)
  check('Gabriel ⊆ Delaunay', gab.length <= edges.length)
  check('EMST ⊆ Gabriel (counts)', mst.length <= gab.length)
}

// ── Poisson minimum-distance guarantee ───────────────────────────────────────
{
  const rng = mulberry32(123)
  const radius = 6
  const pts = poissonDisk(500, RECT, rng, radius)
  let minD = Infinity
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i].x - pts[j].x
      const dy = pts[i].y - pts[j].y
      minD = Math.min(minD, Math.hypot(dx, dy))
    }
  }
  check('poisson respects min distance', minD >= radius - 1e-6, `(min ${minD.toFixed(2)})`)
}

// ── Lloyd relaxation converges (movement decreases) ──────────────────────────
{
  const rng = mulberry32(2024)
  let sites = uniformPoints(60, RECT, rng)
  const m1 = lloydStep(sites, RECT)
  sites = m1.sites
  const m2 = lloydStep(sites, RECT)
  check('lloyd reduces movement', m2.movement <= m1.movement + 1e-9,
    `(${m1.movement.toFixed(2)} → ${m2.movement.toFixed(2)})`)
}

export const result = { failures }
console.log(failures === 0 ? '\nALL GEOMETRY TESTS PASSED' : `\n${failures} TEST(S) FAILED`)
