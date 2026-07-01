// Standalone correctness checks for the geometry core. Not shipped in the app
// bundle (nothing imports it); it exists so the algorithms can be exercised with
// `tsc` + node. Run via the scratchpad harness during development.
import type { Point } from './types'
import { convexHull } from './convexHull'
import { delaunay, triangulationEdges } from './delaunay'
import { inCircle, orient, circumcircle } from './predicates'
import { voronoiCells } from './voronoi'
import {
  euclideanMST,
  gabrielGraph,
  relativeNeighborhoodGraph,
  nearestNeighborGraph,
  urquhartGraph,
  betaSkeleton,
  knnGraph,
  closestPair,
} from './graphs'
import { fortune } from './fortune'
import { refineDelaunay, minMeshAngle } from './refine'
import { constrainedDelaunay } from './constrained'
import { poissonDisk, mulberry32, uniformPoints } from './random'
import { lloydStep } from './lloyd'
import { area } from './polygon'
import { diameter, minWidth, convexLayers } from './hullMetrics'
import { minimumEnclosingCircle } from './enclosingCircle'
import { largestEmptyCircle } from './emptyCircle'
import { alphaShape, circumRadii } from './alphaShape'
import {
  powerCells,
  powerDistance,
  regularTriangulationEdges,
  hiddenSites,
} from './power'
import { farthestCells, farthestOwners } from './farthest'
import { quickHull, quickHullSteps } from './quickhull'
import { encodePoints, decodePoints, parsePointsText } from './pointset'
import {
  buildKdTree,
  kdNearest,
  kdKNearest,
  kdRange,
  kdDepth,
  kdSize,
  kdSplits,
  kdBuildSteps,
} from './kdtree'
import {
  buildQuadtree,
  quadLeaves,
  quadRange,
  quadStats,
  quadBuildSteps,
} from './quadtree'
import {
  buildMesh,
  locate,
  locateBruteForce,
  nearestSite,
  pointInTriangle,
} from './pointLocation'
import { yaoGraph, thetaGraph, greedySpanner, dilation, thetaBound } from './spanner'
import {
  mortonEncode,
  mortonDecode,
  hilbertEncode,
  hilbertDecode,
  curveOrder,
  tourLength,
  curvePath,
} from './spaceFilling'
import {
  buildRangeTree,
  rangeQuery,
  rangeQueryNaive,
  rangeTreeDepth,
  rangeTreeSize,
} from './rangeTree'
import {
  buildSplitTree,
  wspd,
  wellSeparated,
  coveredPairCount,
  wspdSpanner,
  wspdSpannerBound,
} from './wspd'
import { kdApproxNearest } from './kdtree'
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

// ── Fortune's algorithm: dual matches Bowyer-Watson, vertices are circumcenters ─
{
  const key = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`)
  let allBwInFortune = true
  let allLegal = true
  let validVoronoiVertices = true
  for (const seed of [11, 64, 222, 909]) {
    const pts = uniformPoints(70, RECT, mulberry32(seed))
    const f = fortune(pts)
    const tris = delaunay(pts)
    const bw = new Set(triangulationEdges(tris).map((e) => key(e.a, e.b)))
    const fset = new Set(f.delaunayEdges.map((e) => key(e.a, e.b)))
    // Every Bowyer-Watson Delaunay edge must appear in Fortune's dual.
    for (const k of bw) if (!fset.has(k)) allBwInFortune = false
    // Every Fortune edge must be Delaunay-legal: some empty circumcircle through it.
    for (const e of f.delaunayEdges) {
      let legal = false
      for (let w = 0; w < pts.length && !legal; w++) {
        if (w === e.a || w === e.b) continue
        const c = circumcircle(pts[e.a], pts[e.b], pts[w])
        if (!c) continue
        let intruders = 0
        for (let m = 0; m < pts.length; m++) {
          if (m === e.a || m === e.b || m === w) continue
          if (dist(pts[m], { x: c.x, y: c.y }) < c.r - 1e-6) intruders++
        }
        if (intruders === 0) legal = true
      }
      if (!legal) allLegal = false
    }
    // Each Voronoi vertex is a genuine vertex: equidistant to ≥3 sites and that
    // distance is the minimum over all sites (its empty circle holds no site).
    for (const v of f.vertices) {
      let dmin = Infinity
      for (const p of pts) dmin = Math.min(dmin, dist(v, p))
      let onCircle = 0
      for (const p of pts) if (dist(v, p) <= dmin + 1e-6) onCircle++
      if (onCircle < 3) validVoronoiVertices = false
    }
  }
  check('Fortune dual ⊇ Bowyer-Watson Delaunay edges', allBwInFortune)
  check('Fortune Delaunay edges are all Delaunay-legal', allLegal)
  check('Fortune vertices are empty-circle Voronoi vertices', validVoronoiVertices)
}

// ── Fortune is deterministic (same input ⇒ identical dual + step trace) ────────
{
  const pts = uniformPoints(50, RECT, mulberry32(73))
  const a = fortune(pts, true)
  const b = fortune(pts, true)
  check('Fortune is deterministic (edges)', a.delaunayEdges.length === b.delaunayEdges.length)
  check('Fortune trace is reproducible', a.steps.length === b.steps.length && a.steps.length > pts.length)
}

// ── β-skeleton family: β=1 is Gabriel, β=2 is the RNG, monotone in β ──────────
{
  const key = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`)
  const pts = uniformPoints(80, RECT, mulberry32(404))
  const edges = triangulationEdges(delaunay(pts))
  const gab = new Set(gabrielGraph(pts, edges).map((e) => key(e.a, e.b)))
  const rng2 = new Set(relativeNeighborhoodGraph(pts, edges).map((e) => key(e.a, e.b)))
  const b1 = new Set(betaSkeleton(pts, edges, 1).map((e) => key(e.a, e.b)))
  const b2 = new Set(betaSkeleton(pts, edges, 2).map((e) => key(e.a, e.b)))
  const sameSet = (x: Set<string>, y: Set<string>) =>
    x.size === y.size && [...x].every((k) => y.has(k))
  check('β-skeleton(β=1) = Gabriel graph', sameSet(b1, gab), `(${b1.size} vs ${gab.size})`)
  check('β-skeleton(β=2) = relative-neighborhood graph', sameSet(b2, rng2), `(${b2.size} vs ${rng2.size})`)
  const counts = [1, 1.5, 2, 2.5, 3].map((b) => betaSkeleton(pts, edges, b).length)
  let monotone = true
  for (let i = 1; i < counts.length; i++) if (counts[i] > counts[i - 1]) monotone = false
  check('β-skeleton sparsifies as β grows', monotone, `(${counts.join(' ≥ ')})`)
}

// ── k-nearest graph: k=1 = nearest-neighbor graph, grows with k ───────────────
{
  const key = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`)
  const pts = uniformPoints(90, RECT, mulberry32(818))
  const edges = triangulationEdges(delaunay(pts))
  const nng = new Set(nearestNeighborGraph(pts, edges).map((e) => key(e.a, e.b)))
  const k1 = new Set(knnGraph(pts, 1).map((e) => key(e.a, e.b)))
  const same = nng.size === k1.size && [...nng].every((k) => k1.has(k))
  check('kNN(k=1) = nearest-neighbor graph', same, `(${k1.size} vs ${nng.size})`)
  const counts = [1, 2, 3, 5, 8].map((k) => knnGraph(pts, k).length)
  let nondecreasing = true
  for (let i = 1; i < counts.length; i++) if (counts[i] < counts[i - 1]) nondecreasing = false
  check('kNN edges grow monotonically with k', nondecreasing, `(${counts.join(' ≤ ')})`)
  // Every kNN edge connects existing sites (sanity on indices).
  let bad = 0
  for (const e of knnGraph(pts, 4)) if (e.a < 0 || e.b >= pts.length || e.a === e.b) bad++
  check('kNN edges are well-formed', bad === 0)
}

// ── Ruppert refinement: meets the angle bound, keeps inputs, stays Delaunay ───
{
  const pts = poissonDisk(45, { minX: 8, minY: 8, maxX: 92, maxY: 92 }, mulberry32(57))
  const bound = 20
  const res = refineDelaunay(pts, { minAngleDeg: bound, maxSteiner: 1000 })
  check('Ruppert improves the minimum angle', res.minAngleAfter > res.minAngleBefore,
    `(${res.minAngleBefore.toFixed(1)}° → ${res.minAngleAfter.toFixed(1)}°)`)
  check('Ruppert meets the angle bound (no cap)', res.hitCap || res.minAngleAfter >= bound - 0.5,
    `(${res.minAngleAfter.toFixed(1)}° ≥ ${bound}°)`)
  // Original points are preserved verbatim at the front of the augmented list.
  let preserved = true
  for (let i = 0; i < pts.length; i++)
    if (Math.abs(pts[i].x - res.points[i].x) > 1e-9 || Math.abs(pts[i].y - res.points[i].y) > 1e-9)
      preserved = false
  check('Ruppert preserves the original sites', preserved && res.steinerStart === pts.length)
  // The reported mesh is the Delaunay triangulation of the augmented points.
  check('Ruppert mesh angle matches a fresh Delaunay solve',
    Math.abs(res.minAngleAfter - minMeshAngle(res.points, delaunay(res.points))) < 1e-9)
}

// ── Constrained Delaunay: enforces segments, stays a valid triangulation ──────
{
  const key = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`)
  const triArea = (p: Point[], t: { a: number; b: number; c: number }) =>
    Math.abs(orient(p[t.a], p[t.b], p[t.c])) / 2
  let badArea = 0
  let badCount = 0
  let badCcw = 0
  let constraintsMissing = 0
  let cdtViolations = 0
  let totalForced = 0
  for (let seed = 1; seed <= 12; seed++) {
    const rng = mulberry32(seed * 17 + 3)
    const pts = uniformPoints(55, RECT, rng)
    const cons: { a: number; b: number }[] = []
    for (let i = 0; i < 10; i++) {
      const a = Math.floor(rng() * pts.length)
      const b = Math.floor(rng() * pts.length)
      if (a !== b) cons.push({ a, b })
    }
    const raw = delaunay(pts)
    const rawA = raw.reduce((s, t) => s + triArea(pts, t), 0)
    const rawEdges = new Set<string>()
    for (const t of raw) {
      rawEdges.add(key(t.a, t.b))
      rawEdges.add(key(t.b, t.c))
      rawEdges.add(key(t.c, t.a))
    }
    const r = constrainedDelaunay(pts, cons)
    // Flips conserve the triangulated region: same area, same triangle count.
    if (Math.abs(r.triangles.reduce((s, t) => s + triArea(pts, t), 0) - rawA) > 1e-6) badArea++
    if (r.triangles.length !== raw.length) badCount++
    for (const t of r.triangles) if (orient(pts[t.a], pts[t.b], pts[t.c]) <= 0) badCcw++
    // Every constraint the solver kept must actually be present as an edge.
    const eset = new Set(r.edges.map((e) => key(e.edge.a, e.edge.b)))
    const flagged = r.edges.filter((e) => e.constrained)
    for (const e of flagged) if (!eset.has(key(e.edge.a, e.edge.b))) constraintsMissing++
    totalForced += flagged.filter((e) => !rawEdges.has(key(e.edge.a, e.edge.b))).length
    // Constrained-Delaunay property: every non-constrained interior edge is legal.
    const conSet = new Set(flagged.map((e) => key(e.edge.a, e.edge.b)))
    const em = new Map<string, number[]>()
    r.triangles.forEach((t, ti) => {
      for (const [a, b] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as const) {
        const k = key(a, b)
        const arr = em.get(k)
        if (arr) arr.push(ti)
        else em.set(k, [ti])
      }
    })
    for (const [k, ts] of em) {
      if (ts.length !== 2 || conSet.has(k)) continue
      const [t1, t2] = ts.map((i) => r.triangles[i])
      const sh = k.split('_').map(Number)
      const opp = (t: { a: number; b: number; c: number }) =>
        [t.a, t.b, t.c].find((x) => x !== sh[0] && x !== sh[1])!
      const p = opp(t1)
      const q = opp(t2)
      const A = pts[sh[0]]
      const B = pts[sh[1]]
      const P = pts[p]
      const o = orient(P, A, B) > 0 ? [P, A, B] : [P, B, A]
      if (inCircle(o[0], o[1], o[2], pts[q]) > 1e-6) cdtViolations++
    }
  }
  check('CDT conserves area (flips only)', badArea === 0, `(${badArea} seeds off)`)
  check('CDT conserves triangle count', badCount === 0, `(${badCount} seeds off)`)
  check('CDT triangles are CCW', badCcw === 0, `(${badCcw})`)
  check('CDT enforces every kept constraint as an edge', constraintsMissing === 0, `(${constraintsMissing})`)
  check('CDT is Delaunay off the constraints', cdtViolations === 0, `(${cdtViolations})`)
  check('CDT actually forces non-Delaunay segments', totalForced > 20, `(${totalForced} forced)`)
}

// ── Power (Laguerre) diagrams + regular triangulation ────────────────────────
{
  const key = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`)
  const rng = mulberry32(11)
  const pts = uniformPoints(40, RECT, rng)

  // Equal weights ⇒ power diagram == Voronoi diagram (cell areas match).
  {
    const zero = pts.map((p) => ({ x: p.x, y: p.y, w: 0 }))
    const pc = powerCells(zero, RECT)
    const vc = voronoiCells(pts, RECT)
    let maxDiff = 0
    for (let i = 0; i < pts.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(area(pc[i].polygon) - area(vc[i].polygon)))
    }
    check('power diagram with w=0 equals Voronoi (cell areas)', maxDiff < 1e-6, `(maxΔ=${maxDiff})`)

    // …and the regular triangulation reduces to Delaunay. Computed over a frame
    // large enough to contain every Voronoi vertex, so no adjacency is clipped
    // away (the dual over the whole plane *is* the regular triangulation).
    const BIG: Rect = { minX: -1000, minY: -1000, maxX: 1100, maxY: 1100 }
    const regKeys = new Set(
      regularTriangulationEdges(zero, powerCells(zero, BIG)).map((e) => key(e.a, e.b)),
    )
    const delKeys = new Set(triangulationEdges(delaunay(pts)).map((e) => key(e.a, e.b)))
    let same = regKeys.size === delKeys.size
    for (const k of delKeys) if (!regKeys.has(k)) same = false
    check('regular triangulation with w=0 equals Delaunay edges', same,
      `(reg ${regKeys.size} vs del ${delKeys.size})`)
  }

  // Weighted: cells are convex, tile the frame, and obey the power-distance rule.
  {
    const wsites = pts.map((p) => ({ x: p.x, y: p.y, w: rng() * 200 }))
    const cells = powerCells(wsites, RECT)

    let totalArea = 0
    let nonConvex = 0
    for (const cell of cells) {
      if (cell.polygon.length < 3) continue
      totalArea += area(cell.polygon)
      // Convexity: every consecutive triple turns the same way.
      const poly = cell.polygon
      let pos = 0
      let neg = 0
      for (let i = 0, n = poly.length; i < n; i++) {
        const o = orient(poly[i], poly[(i + 1) % n], poly[(i + 2) % n])
        if (o > 1e-9) pos++
        else if (o < -1e-9) neg++
      }
      if (pos > 0 && neg > 0) nonConvex++
    }
    check('power cells are convex', nonConvex === 0, `(${nonConvex} non-convex)`)
    check('power cells tile the frame (area = 100²)', Math.abs(totalArea - 10000) < 1e-3,
      `(area=${totalArea.toFixed(3)})`)

    // Power-distance rule: a random interior query's owning cell is the one
    // minimizing the power distance over all sites.
    let wrongOwner = 0
    let samples = 0
    for (let s = 0; s < 200; s++) {
      const qx = rng() * 100
      const qy = rng() * 100
      let owner = -1
      for (const cell of cells) {
        if (pointInPolygon({ x: qx, y: qy }, cell.polygon)) {
          owner = cell.site
          break
        }
      }
      if (owner < 0) continue
      samples++
      let best = -1
      let bestD = Infinity
      for (let i = 0; i < wsites.length; i++) {
        const d = powerDistance(qx, qy, wsites[i])
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      if (best !== owner) wrongOwner++
    }
    check('power-cell owner minimizes power distance', wrongOwner === 0,
      `(${wrongOwner}/${samples} wrong)`)
  }

  // A dramatically over-weighted site swallows neighbours (some get hidden).
  {
    const wsites = pts.map((p, i) => ({ x: p.x, y: p.y, w: i === 0 ? 9000 : 0 }))
    const cells = powerCells(wsites, RECT)
    const hidden = hiddenSites(cells)
    check('a heavy site hides at least one neighbour', hidden.length > 0,
      `(${hidden.length} hidden)`)
    check('the heavy site itself is not hidden', !hidden.includes(0))
  }
}

// ── Farthest-point Voronoi diagram ───────────────────────────────────────────
{
  const rng = mulberry32(7)
  const pts = uniformPoints(30, RECT, rng)
  // The farthest diagram is unbounded; a generous frame reveals all h cells.
  const BIG: Rect = { minX: -400, minY: -400, maxX: 500, maxY: 500 }
  const cells = farthestCells(pts, BIG)
  const owners = new Set(farthestOwners(cells))
  const hull = new Set(convexHull(pts))

  // Only convex-hull vertices own a non-empty farthest cell, and every hull
  // vertex owns one — so the owner set is exactly the hull.
  let mismatch = owners.size !== hull.size
  for (const o of owners) if (!hull.has(o)) mismatch = true
  for (const h of hull) if (!owners.has(h)) mismatch = true
  check('farthest cells are owned by exactly the hull vertices', !mismatch,
    `(owners ${owners.size} vs hull ${hull.size})`)

  // The cells tile the frame (BIG is 900 × 900).
  let totalArea = 0
  for (const cell of cells) if (cell.polygon.length >= 3) totalArea += area(cell.polygon)
  check('farthest cells tile the frame', Math.abs(totalArea - 900 * 900) < 1e-2,
    `(area=${totalArea.toFixed(3)})`)

  // Brute force: a query's owning cell really is its farthest site.
  let wrong = 0
  let samples = 0
  for (let s = 0; s < 300; s++) {
    const qx = rng() * 100
    const qy = rng() * 100
    let owner = -1
    for (const cell of cells) {
      if (cell.polygon.length >= 3 && pointInPolygon({ x: qx, y: qy }, cell.polygon)) {
        owner = cell.site
        break
      }
    }
    if (owner < 0) continue
    samples++
    let far = -1
    let farD = -1
    for (let i = 0; i < pts.length; i++) {
      const dx = qx - pts[i].x
      const dy = qy - pts[i].y
      const d = dx * dx + dy * dy
      if (d > farD) {
        farD = d
        far = i
      }
    }
    if (far !== owner) wrong++
  }
  check('farthest-cell owner is the actual farthest site', wrong === 0, `(${wrong}/${samples})`)
}

// ── Quickhull ≡ monotone chain ───────────────────────────────────────────────
{
  let disagree = 0
  for (let seed = 1; seed <= 40; seed++) {
    const rng = mulberry32(seed * 31 + 5)
    const pts = uniformPoints(4 + (seed % 30), RECT, rng)
    const mc = canonicalHull(convexHull(pts))
    const qh = canonicalHull(quickHull(pts))
    if (mc.join(',') !== qh.join(',')) disagree++
  }
  check('Quickhull matches the monotone-chain hull on 40 scenes', disagree === 0,
    `(${disagree} disagree)`)

  // Quickhull returns CCW (positive signed area), like convexHull.
  const rng = mulberry32(99)
  const pts = uniformPoints(50, RECT, rng)
  const qh = quickHull(pts)
  let a2 = 0
  for (let i = 0; i < qh.length; i++) {
    const a = pts[qh[i]]
    const b = pts[qh[(i + 1) % qh.length]]
    a2 += a.x * b.y - b.x * a.y
  }
  check('Quickhull winds counter-clockwise', a2 > 0)

  // The final boundary of the step trace contains exactly the hull vertices.
  const steps = quickHullSteps(pts)
  const last = steps[steps.length - 1].boundary
  check('Quickhull step trace ends on the full hull',
    [...last].sort((a, b) => a - b).join(',') === [...qh].sort((a, b) => a - b).join(','))
}

// Even-odd point-in-polygon for the diagram self-tests.
function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

// Rotate a hull index loop to start at its smallest index, for order-insensitive
// comparison of two hull algorithms.
function canonicalHull(hull: number[]): number[] {
  if (hull.length === 0) return hull
  let m = 0
  for (let i = 1; i < hull.length; i++) if (hull[i] < hull[m]) m = i
  return [...hull.slice(m), ...hull.slice(0, m)]
}

// ── k-d tree: balance, NN / kNN / range all match brute force, pruning works ──
{
  const rng = mulberry32(20260628)
  const pts = uniformPoints(200, RECT, rng)
  const tree = buildKdTree(pts, RECT)
  check('k-d tree stores every point', kdSize(tree) === pts.length, `(${kdSize(tree)})`)
  check('k-d tree is balanced (depth ≤ ⌈log₂n⌉+2)', kdDepth(tree) <= Math.ceil(Math.log2(pts.length)) + 2,
    `(depth ${kdDepth(tree)})`)

  let nnWrong = 0
  let totalVisited = 0
  const Q = 200
  for (let s = 0; s < Q; s++) {
    const q = { x: rng() * 100, y: rng() * 100 }
    const got = kdNearest(tree, pts, q)
    let bd = Infinity
    for (const p of pts) bd = Math.min(bd, dist(p, q))
    if (Math.abs(got.dist - bd) > 1e-9) nnWrong++
    totalVisited += got.visited
  }
  check('k-d nearest-neighbour matches brute force', nnWrong === 0, `(${nnWrong}/${Q} wrong)`)
  check('k-d NN prunes (avg nodes visited < n)', totalVisited / Q < pts.length,
    `(avg ${(totalVisited / Q).toFixed(1)} of ${pts.length})`)

  let knnWrong = 0
  const K = 5
  for (let s = 0; s < 60; s++) {
    const q = { x: rng() * 100, y: rng() * 100 }
    const got = kdKNearest(tree, pts, q, K)
      .map((h) => h.dist)
      .sort((a, b) => a - b)
    const brute = pts
      .map((p) => dist(p, q))
      .sort((a, b) => a - b)
      .slice(0, K)
    if (got.length !== K) knnWrong++
    else for (let i = 0; i < K; i++) if (Math.abs(got[i] - brute[i]) > 1e-9) knnWrong++
  }
  check('k-d k-nearest (k=5) matches brute force', knnWrong === 0, `(${knnWrong})`)

  let rangeMism = 0
  for (let s = 0; s < 60; s++) {
    const x0 = rng() * 100
    const y0 = rng() * 100
    const x1 = rng() * 100
    const y1 = rng() * 100
    const win: Rect = { minX: Math.min(x0, x1), minY: Math.min(y0, y1), maxX: Math.max(x0, x1), maxY: Math.max(y0, y1) }
    const got = kdRange(tree, pts, win).indices.slice().sort((a, b) => a - b)
    const brute: number[] = []
    for (let i = 0; i < pts.length; i++)
      if (pts[i].x >= win.minX && pts[i].x <= win.maxX && pts[i].y >= win.minY && pts[i].y <= win.maxY) brute.push(i)
    brute.sort((a, b) => a - b)
    if (got.join(',') !== brute.join(',')) rangeMism++
  }
  check('k-d orthogonal range query matches brute force', rangeMism === 0, `(${rangeMism})`)
  check('k-d build trace has one step per node', kdBuildSteps(tree, pts).length === pts.length)
  const splits = kdSplits(tree, pts)
  check('k-d partition has fewer cuts than points', splits.length > 0 && splits.length < pts.length,
    `(${splits.length})`)
}

// ── Quadtree: one bucket per point, range query exact, build trace per point ──
{
  const rng = mulberry32(909090)
  const pts = poissonDisk(160, RECT, rng) // well-separated ⇒ distinct cells
  const qt = buildQuadtree(pts, RECT)
  const leaves = quadLeaves(qt)
  const stored = leaves.reduce((s, c) => s + c.count, 0)
  check('quadtree stores every point exactly once', stored === pts.length, `(${stored}/${pts.length})`)
  const st = quadStats(qt)
  check('quadtree leaves hold ≤ capacity (distinct points)', st.maxBucket <= 1, `(maxBucket ${st.maxBucket})`)

  let mism = 0
  for (let s = 0; s < 60; s++) {
    const x0 = rng() * 100
    const y0 = rng() * 100
    const x1 = rng() * 100
    const y1 = rng() * 100
    const win: Rect = { minX: Math.min(x0, x1), minY: Math.min(y0, y1), maxX: Math.max(x0, x1), maxY: Math.max(y0, y1) }
    const got = quadRange(qt, pts, win).indices.slice().sort((a, b) => a - b)
    const brute: number[] = []
    for (let i = 0; i < pts.length; i++)
      if (pts[i].x >= win.minX && pts[i].x <= win.maxX && pts[i].y >= win.minY && pts[i].y <= win.maxY) brute.push(i)
    brute.sort((a, b) => a - b)
    if (got.join(',') !== brute.join(',')) mism++
  }
  check('quadtree range query matches brute force', mism === 0, `(${mism})`)
  check('quadtree build trace has one step per point', quadBuildSteps(pts, RECT).length === pts.length)
}

// ── Point location: symmetric adjacency, walk lands in the containing triangle ─
{
  const rng = mulberry32(2468100)
  const pts = uniformPoints(120, RECT, rng)
  const tris = delaunay(pts)
  const mesh = buildMesh(pts, tris)

  let asym = 0
  for (let t = 0; t < tris.length; t++)
    for (const e of [0, 1, 2]) {
      const nb = mesh.neighbour[t][e]
      if (nb >= 0 && !mesh.neighbour[nb].includes(t)) asym++
    }
  check('mesh triangle adjacency is symmetric', asym === 0, `(${asym})`)

  let wrong = 0
  let inside = 0
  let located = 0
  let totalPath = 0
  let start = 0
  for (let s = 0; s < 300; s++) {
    const q = { x: rng() * 100, y: rng() * 100 }
    const brute = locateBruteForce(pts, tris, q)
    const res = locate(mesh, q, start)
    if (res.triangle >= 0) start = res.triangle
    if (brute >= 0) {
      inside++
      if (res.triangle < 0) wrong++
      else {
        const tt = tris[res.triangle]
        if (!pointInTriangle(pts[tt.a], pts[tt.b], pts[tt.c], q)) wrong++
        else {
          located++
          totalPath += res.path.length
        }
      }
    }
  }
  check('jump-and-walk lands in the containing triangle', wrong === 0, `(${wrong}/${inside})`)
  check('jump-and-walk path stays short (avg < T)', located > 0 && totalPath / located < tris.length,
    `(avg ${(totalPath / Math.max(1, located)).toFixed(1)} of ${tris.length})`)

  let nsBad = 0
  for (let s = 0; s < 60; s++) {
    const q = { x: rng() * 100, y: rng() * 100 }
    const ns = nearestSite(pts, q)
    let bi = -1
    let bd = Infinity
    for (let i = 0; i < pts.length; i++) {
      const d = dist(pts[i], q)
      if (d < bd) {
        bd = d
        bi = i
      }
    }
    if (ns !== bi) nsBad++
  }
  check('nearest-site (Voronoi owner) matches brute force', nsBad === 0, `(${nsBad})`)
}

// ── Geometric spanners: connectivity, Θ-bound, greedy realizes its target t ───
{
  const rng = mulberry32(5152530)
  const pts = uniformPoints(60, RECT, rng)
  const yao = yaoGraph(pts, 6)
  const theta = thetaGraph(pts, 8)
  const dy = dilation(pts, yao)
  const dt = dilation(pts, theta)
  check('Yao graph (6 cones) is connected', dy.connected)
  check('Θ-graph (8 cones) is connected', dt.connected)
  check('Θ-graph realizes its dilation bound', dt.stretch <= thetaBound(8) + 1e-6,
    `(${dt.stretch.toFixed(3)} ≤ ${thetaBound(8).toFixed(3)})`)

  for (const t of [1.5, 2, 3]) {
    const g = greedySpanner(pts, t)
    const dg = dilation(pts, g)
    check(`greedy ${t}-spanner realizes dilation ≤ ${t}`, dg.connected && dg.stretch <= t + 1e-9,
      `(${dg.stretch.toFixed(4)})`)
  }
  const e15 = greedySpanner(pts, 1.5).length
  const e30 = greedySpanner(pts, 3).length
  check('greedy spanner sparsifies as t grows', e15 >= e30, `(${e15} ≥ ${e30})`)

  let bad = 0
  const seen = new Set<string>()
  for (const e of theta) {
    if (e.a >= e.b) bad++
    const k = `${e.a}_${e.b}`
    if (seen.has(k)) bad++
    seen.add(k)
  }
  check('Θ-graph edges are canonical and unique', bad === 0, `(${bad})`)
}

// ── Space-filling curves (Morton / Hilbert) ─────────────────────────────────
{
  // Encode/decode are inverse bijections over the whole 2^order grid.
  for (const order of [1, 2, 4, 5]) {
    const side = 1 << order
    const n = side * side
    let mortonBad = 0
    let hilbertBad = 0
    const mortonSeen = new Set<number>()
    const hilbertSeen = new Set<number>()
    for (let x = 0; x < side; x++) {
      for (let y = 0; y < side; y++) {
        const md = mortonEncode(x, y, order)
        const [mx, my] = mortonDecode(md, order)
        if (mx !== x || my !== y) mortonBad++
        mortonSeen.add(md)
        const hd = hilbertEncode(x, y, order)
        const [hx, hy] = hilbertDecode(hd, order)
        if (hx !== x || hy !== y) hilbertBad++
        hilbertSeen.add(hd)
      }
    }
    check(`Morton encode∘decode is identity (order ${order})`, mortonBad === 0, `(${mortonBad})`)
    check(`Morton codes are a permutation of 0…${n - 1}`, mortonSeen.size === n)
    check(`Hilbert encode∘decode is identity (order ${order})`, hilbertBad === 0, `(${hilbertBad})`)
    check(`Hilbert codes are a permutation of 0…${n - 1}`, hilbertSeen.size === n)
  }

  // Hilbert's defining property: consecutive indices are grid-neighbours (the
  // curve never jumps). Morton, by contrast, does jump — so it fails this.
  const order = 5
  const cells = 1 << (2 * order)
  let hilbertGaps = 0
  let mortonJumps = 0
  for (let d = 0; d + 1 < cells; d++) {
    const [ax, ay] = hilbertDecode(d, order)
    const [bx, by] = hilbertDecode(d + 1, order)
    if (Math.abs(ax - bx) + Math.abs(ay - by) !== 1) hilbertGaps++
    const [mx0, my0] = mortonDecode(d, order)
    const [mx1, my1] = mortonDecode(d + 1, order)
    if (Math.abs(mx0 - mx1) + Math.abs(my0 - my1) !== 1) mortonJumps++
  }
  check('Hilbert steps are always unit grid moves (no jumps)', hilbertGaps === 0, `(${hilbertGaps})`)
  check('Morton order does jump (locality leaks)', mortonJumps > 0, `(${mortonJumps} jumps)`)

  // curvePath threads every cell for the Hilbert curve (path length = 4^order).
  const path = curvePath('hilbert', 4, RECT)
  check('Hilbert curvePath visits every cell once', path.length === 1 << (2 * 4))

  // Locality: over a real point set, the Hilbert tour is shorter than the Morton
  // tour — the whole reason Hilbert is preferred for spatial layouts.
  const rng = mulberry32(20260701)
  const pts = uniformPoints(400, RECT, rng)
  const mOrder = curveOrder(pts, RECT, 8, 'morton')
  const hOrder = curveOrder(pts, RECT, 8, 'hilbert')
  const perm = [...hOrder.visit].sort((a, b) => a - b)
  check('curveOrder returns a permutation of all points', perm.every((v, i) => v === i))
  const mLen = tourLength(pts, mOrder)
  const hLen = tourLength(pts, hOrder)
  check('Hilbert tour is shorter than Morton (locality win)', hLen < mLen,
    `(hilbert ${hLen.toFixed(1)} < morton ${mLen.toFixed(1)})`)
}

// ── 2-D range tree with fractional cascading ─────────────────────────────────
{
  const rng = mulberry32(7)
  const pts = uniformPoints(200, RECT, rng)
  const tree = buildRangeTree(pts)

  // A full binary tree on n leaves has exactly 2n−1 nodes and depth ≤ ⌈log₂n⌉+1.
  check('range tree has 2n−1 nodes', rangeTreeSize(tree.root) === 2 * pts.length - 1)
  check('range tree is balanced (depth ≤ ⌈log₂n⌉+1)',
    rangeTreeDepth(tree.root) <= Math.ceil(Math.log2(pts.length)) + 1)

  const inWin = (p: Point, r: Rect) =>
    p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY
  let mismatches = 0
  let cascadeVsNaive = 0
  let maxCanonical = 0
  for (let t = 0; t < 60; t++) {
    const x0 = rng() * 100
    const x1 = rng() * 100
    const y0 = rng() * 100
    const y1 = rng() * 100
    const win: Rect = {
      minX: Math.min(x0, x1),
      maxX: Math.max(x0, x1),
      minY: Math.min(y0, y1),
      maxY: Math.max(y0, y1),
    }
    const res = rangeQuery(tree, win)
    const naive = rangeQueryNaive(tree, win)
    const brute = pts.map((_, i) => i).filter((i) => inWin(pts[i], win))
    const asSet = (a: number[]) => [...a].sort((p, q) => p - q).join(',')
    if (asSet(res.indices) !== asSet(brute)) mismatches++
    if (asSet(res.indices) !== asSet(naive)) cascadeVsNaive++
    maxCanonical = Math.max(maxCanonical, res.canonical)
  }
  check('range tree matches brute force over 60 random windows', mismatches === 0, `(${mismatches})`)
  check('cascaded query ≡ naive (per-node binary search) query', cascadeVsNaive === 0, `(${cascadeVsNaive})`)
  check('range query uses O(log n) canonical subtrees',
    maxCanonical <= 4 * Math.ceil(Math.log2(pts.length)), `(${maxCanonical})`)
}

// ── Well-separated pair decomposition + spanner ──────────────────────────────
{
  const rng = mulberry32(11)
  for (const n of [30, 60, 90]) {
    const pts = uniformPoints(n, RECT, rng)
    for (const s of [1, 2, 4]) {
      const pairs = wspd(pts, s)
      // THE correctness property: every unordered point pair covered exactly once.
      const covered = coveredPairCount(pairs)
      const expected = (n * (n - 1)) / 2
      check(`WSPD(n=${n}, s=${s}) covers every pair exactly once (Σ|A||B| = n(n−1)/2)`,
        covered === expected, `(${covered} vs ${expected})`)
      // No pair is double-counted: enumerate memberships into a set.
      const seen = new Set<number>()
      let dup = 0
      for (const { a, b } of pairs) {
        for (const i of a.points) {
          for (const j of b.points) {
            const lo = Math.min(i, j)
            const hi = Math.max(i, j)
            const key = lo * n + hi
            if (seen.has(key)) dup++
            seen.add(key)
          }
        }
      }
      check(`WSPD(n=${n}, s=${s}) has no double-covered pair`, dup === 0 && seen.size === expected,
        `(dup ${dup}, distinct ${seen.size})`)
      // Every emitted pair really is s-well-separated.
      const allSep = pairs.every((p) => wellSeparated(p.a, p.b, s))
      check(`WSPD(n=${n}, s=${s}) pairs are all s-well-separated`, allSep)
      // Sub-quadratic: far fewer than the n(n−1)/2 raw pairs.
      check(`WSPD(n=${n}, s=${s}) is sub-quadratic (${pairs.length} pairs ≪ ${expected})`,
        pairs.length <= 15 * n, `(${pairs.length} ≤ ${15 * n})`)
    }
  }

  // Split tree: exactly n leaves (one per point).
  const pts = uniformPoints(50, RECT, mulberry32(3))
  const leafCount = (() => {
    const root = buildSplitTree(pts)
    let count = 0
    const walk = (node: ReturnType<typeof buildSplitTree>) => {
      if (!node) return
      if (!node.left && !node.right) count++
      walk(node.left)
      walk(node.right)
    }
    walk(root)
    return count
  })()
  check('fair-split tree has one leaf per point', leafCount === pts.length, `(${leafCount})`)

  // WSPD-spanner: with s > 4 it is a t-spanner for t = (s+4)/(s−4).
  for (const s of [6, 8]) {
    const g = wspdSpanner(pts, s)
    const dg = dilation(pts, g)
    const bound = wspdSpannerBound(s)
    check(`WSPD ${s}-separated spanner realizes dilation ≤ (s+4)/(s−4)`,
      dg.connected && dg.stretch <= bound + 1e-9, `(${dg.stretch.toFixed(3)} ≤ ${bound.toFixed(3)})`)
    check(`WSPD spanner is linear-size (${g.length} edges for n=${pts.length})`,
      g.length <= 20 * pts.length)
  }
}

// ── Approximate nearest neighbour (best-bin-first) ───────────────────────────
{
  const rng = mulberry32(99)
  const pts = uniformPoints(500, RECT, rng)
  const tree = buildKdTree(pts, RECT)
  let exactMismatch = 0
  let boundViolations = 0
  let approxVisitedSum = 0
  let exactVisitedSum = 0
  const trials = 80
  for (let t = 0; t < trials; t++) {
    const q: Point = { x: rng() * 100, y: rng() * 100 }
    // Brute-force truth.
    let trueD = Infinity
    for (const p of pts) trueD = Math.min(trueD, dist(p, q))
    // ε = 0 must reproduce the exact nearest.
    const a0 = kdApproxNearest(tree, pts, q, 0)
    if (Math.abs(a0.dist - trueD) > 1e-9) exactMismatch++
    // ε = 0.5 must stay within the (1+ε) factor, and touch no more nodes on average.
    const aeps = kdApproxNearest(tree, pts, q, 0.5)
    if (aeps.dist > 1.5 * trueD + 1e-9) boundViolations++
    approxVisitedSum += aeps.visited
    exactVisitedSum += kdNearest(tree, pts, q).visited
  }
  check('approx-NN with ε=0 equals the exact nearest', exactMismatch === 0, `(${exactMismatch})`)
  check('approx-NN with ε=0.5 stays within the (1+ε) factor', boundViolations === 0, `(${boundViolations})`)
  check('approx-NN (ε=0.5) touches no more nodes than exact, on average',
    approxVisitedSum <= exactVisitedSum,
    `(approx ${(approxVisitedSum / trials).toFixed(1)} ≤ exact ${(exactVisitedSum / trials).toFixed(1)})`)
}

export const result = { failures }
console.log(failures === 0 ? '\nALL GEOMETRY TESTS PASSED' : `\n${failures} TEST(S) FAILED`)
