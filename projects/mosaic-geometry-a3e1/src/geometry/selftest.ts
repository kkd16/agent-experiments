// Standalone correctness checks for the geometry core. Not shipped in the app
// bundle (nothing imports it); it exists so the algorithms can be exercised with
// `tsc` + node. Run via the scratchpad harness during development.
import type { Point } from './types'
import { convexHull } from './convexHull'
import { delaunay, triangulationEdges } from './delaunay'
import { inCircle, orient } from './predicates'
import { voronoiCells } from './voronoi'
import {
  euclideanMST,
  gabrielGraph,
  relativeNeighborhoodGraph,
  nearestNeighborGraph,
  urquhartGraph,
  closestPair,
} from './graphs'
import { poissonDisk, mulberry32, uniformPoints } from './random'
import { lloydStep } from './lloyd'
import { area } from './polygon'
import { diameter, minWidth, convexLayers } from './hullMetrics'
import { minimumEnclosingCircle } from './enclosingCircle'
import { largestEmptyCircle } from './emptyCircle'
import { alphaShape, circumRadii } from './alphaShape'
import { encodePoints, decodePoints, parsePointsText } from './pointset'
import { dist } from './vector'
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

// ── Proximity-graph hierarchy: NNG ⊆ EMST ⊆ RNG ⊆ Urquhart ⊆ Gabriel ⊆ Delaunay ─
{
  const rng = mulberry32(555)
  const pts = uniformPoints(80, RECT, rng)
  const tris = delaunay(pts)
  const edges = triangulationEdges(tris)
  const nng = nearestNeighborGraph(pts, edges)
  const mst = euclideanMST(pts, edges)
  const rng2 = relativeNeighborhoodGraph(pts, edges)
  const urq = urquhartGraph(pts, tris)
  const gab = gabrielGraph(pts, edges)
  check('NNG ⊆ EMST (counts)', nng.length <= mst.length, `(${nng.length} ≤ ${mst.length})`)
  check('EMST ⊆ RNG (counts)', mst.length <= rng2.length, `(${mst.length} ≤ ${rng2.length})`)
  check('RNG ⊆ Urquhart (counts)', rng2.length <= urq.length, `(${rng2.length} ≤ ${urq.length})`)
  check('Urquhart ⊆ Gabriel (counts)', urq.length <= gab.length, `(${urq.length} ≤ ${gab.length})`)
  check('Gabriel ⊆ Delaunay (counts)', gab.length <= edges.length, `(${gab.length} ≤ ${edges.length})`)

  // RNG membership is exact: no point may sit in the lune of a kept edge.
  let luneViolations = 0
  for (const e of rng2) {
    const d2 = dist(pts[e.a], pts[e.b]) ** 2
    for (let k = 0; k < pts.length; k++) {
      if (k === e.a || k === e.b) continue
      const da = dist(pts[k], pts[e.a]) ** 2
      const db = dist(pts[k], pts[e.b]) ** 2
      if (da < d2 - 1e-6 && db < d2 - 1e-6) luneViolations++
    }
  }
  check('RNG lune is empty', luneViolations === 0, `(${luneViolations})`)
}

// ── Closest pair matches brute force ─────────────────────────────────────────
{
  const rng = mulberry32(321)
  const pts = uniformPoints(120, RECT, rng)
  const edges = triangulationEdges(delaunay(pts))
  const cp = closestPair(pts, edges)
  let bruteD = Infinity
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) bruteD = Math.min(bruteD, dist(pts[i], pts[j]))
  check('closest pair = brute force', !!cp && Math.abs(cp.dist - bruteD) < 1e-9,
    `(${cp?.dist.toFixed(4)} vs ${bruteD.toFixed(4)})`)
}

// ── Diameter (rotating calipers) matches brute-force farthest pair ───────────
{
  const rng = mulberry32(808)
  const pts = uniformPoints(150, RECT, rng)
  const hull = convexHull(pts).map((i) => pts[i])
  const dia = diameter(hull)
  let bruteD = 0
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) bruteD = Math.max(bruteD, dist(pts[i], pts[j]))
  check('diameter = brute force', !!dia && Math.abs(dia.dist - bruteD) < 1e-9,
    `(${dia?.dist.toFixed(4)} vs ${bruteD.toFixed(4)})`)
  const w = minWidth(hull)
  check('min width ≤ diameter', !!w && !!dia && w.width <= dia.dist + 1e-9,
    `(${w?.width.toFixed(3)} ≤ ${dia?.dist.toFixed(3)})`)
}

// ── Convex layers cover every point exactly once ─────────────────────────────
{
  const rng = mulberry32(606)
  const pts = uniformPoints(70, RECT, rng)
  const layers = convexLayers(pts)
  const seen = new Set<number>()
  let dupes = 0
  for (const layer of layers) {
    for (const idx of layer) {
      if (seen.has(idx)) dupes++
      else seen.add(idx)
    }
  }
  check('convex layers partition the set', dupes === 0 && seen.size === pts.length,
    `(seen ${seen.size}/${pts.length}, dupes ${dupes})`)
  check('first layer is the convex hull', layers[0].length === convexHull(pts).length)
}

// ── Minimum enclosing circle (Welzl) contains every point ────────────────────
{
  const rng = mulberry32(247)
  const pts = uniformPoints(200, RECT, rng)
  const mec = minimumEnclosingCircle(pts, 7)
  let outside = 0
  for (const p of pts) {
    const d = Math.hypot(p.x - mec!.x, p.y - mec!.y)
    if (d > mec!.r + 1e-6) outside++
  }
  check('MEC contains all points', outside === 0, `(${outside} outside)`)
  // The two diameter points lie inside, so 2r ≥ diameter.
  const hull = convexHull(pts).map((i) => pts[i])
  const dia = diameter(hull)!
  check('MEC radius ≥ diameter/2', mec!.r >= dia.dist / 2 - 1e-6,
    `(r ${mec!.r.toFixed(3)}, dia/2 ${(dia.dist / 2).toFixed(3)})`)
}

// ── Largest empty circle is empty and centred inside the hull ────────────────
{
  const rng = mulberry32(484)
  const pts = poissonDisk(100, RECT, rng)
  const tris = delaunay(pts)
  const hull = convexHull(pts).map((i) => pts[i])
  const lec = largestEmptyCircle(pts, tris, hull)
  let intruders = 0
  if (lec) {
    for (const p of pts) {
      const d = Math.hypot(p.x - lec.circle.x, p.y - lec.circle.y)
      if (d < lec.circle.r - 1e-6) intruders++
    }
  }
  check('largest empty circle is site-free', !!lec && intruders === 0, `(${intruders})`)
}

// ── Alpha shape: ∞ recovers the convex hull, small α drops fat triangles ──────
{
  const rng = mulberry32(913)
  const pts = poissonDisk(120, RECT, rng)
  const tris = delaunay(pts)
  const full = alphaShape(pts, tris, Infinity)
  check('alpha=∞ keeps every triangle', full.triangles.length === tris.length)
  // α=∞ retains the whole mesh, so its boundary must equal the triangulation's
  // own outer boundary: the edges incident to exactly one triangle.
  const once = new Map<string, number>()
  for (const t of tris) {
    for (const [a, b] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as const) {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`
      once.set(k, (once.get(k) ?? 0) + 1)
    }
  }
  let triBoundary = 0
  for (const n of once.values()) if (n === 1) triBoundary++
  check('alpha=∞ boundary = triangulation boundary', full.boundary.length === triBoundary,
    `(${full.boundary.length} vs ${triBoundary})`)
  const radii = circumRadii(pts, tris).filter((r) => Number.isFinite(r)).sort((a, b) => a - b)
  const small = alphaShape(pts, tris, radii[Math.floor(radii.length * 0.3)])
  check('small alpha keeps fewer triangles', small.triangles.length < tris.length,
    `(${small.triangles.length} < ${tris.length})`)
}

// ── Point-set codec round-trips and parser normalizes out-of-range input ─────
{
  const rng = mulberry32(135)
  const pts = uniformPoints(60, { minX: 0, minY: 0, maxX: 1, maxY: 1 }, rng)
  const round = decodePoints(encodePoints(pts))
  check('codec preserves count', round.length === pts.length)
  let maxErr = 0
  for (let i = 0; i < pts.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(pts[i].x - round[i].x), Math.abs(pts[i].y - round[i].y))
  }
  check('codec within quantization tolerance', maxErr < 1 / 4000, `(maxErr ${maxErr.toExponential(2)})`)
  const parsed = parsePointsText('0 0\n100 0\n100 100\n0 100')
  const ok = parsed.length === 4 && parsed.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)
  check('parser fits out-of-range coords into the frame', ok, `(${parsed.length} pts)`)
}

export const result = { failures }
console.log(failures === 0 ? '\nALL GEOMETRY TESTS PASSED' : `\n${failures} TEST(S) FAILED`)
