import type { Point, Rect } from './types'
import { clipHalfPlane, signedArea } from './polygon'

// ─────────────────────────────────────────────────────────────────────────────
// Arrangements of lines, point–line duality, k-levels, the ham-sandwich cut, and
// 2-D linear programming — the "dual world" of computational geometry, all from
// scratch. Where the rest of the studio works with points and the structures
// they induce (hulls, Delaunay, Voronoi), this module works with *lines*: how n
// lines carve the plane into a arrangement of vertices/edges/faces, how points
// and lines trade places under duality, and the two classic payoffs of that
// duality — a line that simultaneously bisects two point sets (ham sandwich) and
// the optimum of a linear program by Seidel's randomized incremental method.
// ─────────────────────────────────────────────────────────────────────────────

const EPS = 1e-9

/** A line in normalized implicit form: {(x,y) : nx·x + ny·y = c}, |‍(nx,ny)|=1. */
export interface Line {
  nx: number
  ny: number
  c: number
}

/** A non-vertical line as y = m·x + b — the natural form for levels & duality. */
export interface SILine {
  m: number
  b: number
}

/** The oriented line through p→q (its positive side is the left of p→q). */
export function lineThroughPoints(p: Point, q: Point): Line {
  const dx = q.x - p.x
  const dy = q.y - p.y
  const len = Math.hypot(dx, dy) || 1
  // Normal is the left perpendicular of the direction, unit length.
  const nx = -dy / len
  const ny = dx / len
  return { nx, ny, c: nx * p.x + ny * p.y }
}

/** Normalized implicit line for y = m·x + b. */
export function lineFromSI(l: SILine): Line {
  // m·x − y + b = 0  →  normal (m, −1), constant −b, then normalized.
  const len = Math.hypot(l.m, 1)
  return { nx: l.m / len, ny: -1 / len, c: -l.b / len }
}

export const isVertical = (l: Line): boolean => Math.abs(l.ny) < 1e-7

/** y-coordinate of a non-vertical line at abscissa x. */
export function yAt(l: Line, x: number): number {
  return (l.c - l.nx * x) / l.ny
}

/** Slope-intercept form of a non-vertical line. */
export function toSI(l: Line): SILine {
  return { m: -l.nx / l.ny, b: l.c / l.ny }
}

/** Signed distance of a point from a normalized line (positive on its normal side). */
export const signedDist = (l: Line, p: Point): number => l.nx * p.x + l.ny * p.y - l.c

/** Intersection of two lines, or null when (near-)parallel. */
export function intersectLines(a: Line, b: Line): Point | null {
  const det = a.nx * b.ny - b.nx * a.ny
  if (Math.abs(det) < 1e-12) return null
  return {
    x: (a.c * b.ny - b.c * a.ny) / det,
    y: (a.nx * b.c - b.nx * a.c) / det,
  }
}

const inRect = (p: Point, r: Rect): boolean =>
  p.x >= r.minX - EPS && p.x <= r.maxX + EPS && p.y >= r.minY - EPS && p.y <= r.maxY + EPS

export const rectPolygon = (r: Rect): Point[] => [
  { x: r.minX, y: r.minY },
  { x: r.maxX, y: r.minY },
  { x: r.maxX, y: r.maxY },
  { x: r.minX, y: r.maxY },
]

/**
 * Clip the infinite line `l` to the rectangle, returning its chord [A,B] (the
 * two boundary crossings) or null if the line misses the rectangle. Liang–Barsky
 * on the parametric ray p0 + t·dir.
 */
export function clipLineToRect(l: Line, r: Rect): [Point, Point] | null {
  const p0 = { x: l.c * l.nx, y: l.c * l.ny } // foot of perpendicular from origin
  const dir = { x: -l.ny, y: l.nx } // unit direction along the line
  let t0 = -Infinity
  let t1 = Infinity
  const clip = (num: number, den: number): boolean => {
    // Constraint  num + t·den ≤ 0  (point stays on the inside of one rect edge).
    if (Math.abs(den) < 1e-12) return num <= EPS // parallel: feasible iff inside
    const t = -num / den
    if (den > 0) {
      if (t < t1) t1 = t
    } else if (t > t0) t0 = t
    return true
  }
  // x ≥ minX, x ≤ maxX, y ≥ minY, y ≤ maxY expressed as num + t·den ≤ 0.
  if (!clip(r.minX - p0.x, -dir.x)) return null
  if (!clip(p0.x - r.maxX, dir.x)) return null
  if (!clip(r.minY - p0.y, -dir.y)) return null
  if (!clip(p0.y - r.maxY, dir.y)) return null
  if (t0 > t1) return null
  return [
    { x: p0.x + dir.x * t0, y: p0.y + dir.y * t0 },
    { x: p0.x + dir.x * t1, y: p0.y + dir.y * t1 },
  ]
}

// ── Faces of the arrangement (as convex cells clipped to a frame) ─────────────

export interface Face {
  polygon: Point[]
  /** Number of lines strictly below this face's centroid (its "level"). */
  level: number
}

const centroidOf = (poly: Point[]): Point => {
  let sx = 0
  let sy = 0
  for (const p of poly) {
    sx += p.x
    sy += p.y
  }
  const n = poly.length || 1
  return { x: sx / n, y: sy / n }
}

/**
 * Build the faces of the arrangement of `lines` clipped to `frame`, by
 * incrementally splitting convex cells: every face a new line crosses is cut
 * into its above- and below-halves. Each resulting cell is convex and carries
 * its level (how many lines pass below it) for depth-colouring.
 */
export function arrangementFaces(lines: Line[], frame: Rect): Face[] {
  let cells: Point[][] = [rectPolygon(frame)]
  for (const l of lines) {
    const next: Point[][] = []
    for (const cell of cells) {
      const below = clipHalfPlane(cell, l.nx, l.ny, l.c) // nx·x+ny·y ≤ c
      const above = clipHalfPlane(cell, -l.nx, -l.ny, -l.c) // ≥ c
      if (Math.abs(signedArea(below)) > 1e-12) next.push(below)
      if (Math.abs(signedArea(above)) > 1e-12) next.push(above)
    }
    cells = next
  }
  return cells.map((polygon) => ({ polygon, level: levelOfPoint(lines, centroidOf(polygon)) }))
}

/** Whether p lies inside the convex, CCW-wound polygon (edges included). */
export function pointInConvex(poly: Point[], p: Point): boolean {
  if (poly.length < 3) return false
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % n]
    if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) < -1e-9) return false
  }
  return true
}

/**
 * Locate the arrangement face containing p by a direct scan of the convex cells
 * — the O(F) point-location baseline for an arrangement. Returns the face index
 * or −1 (outside the frame). Its level always equals `levelOfPoint`.
 */
export function locateFace(faces: Face[], p: Point): number {
  for (let i = 0; i < faces.length; i++) if (pointInConvex(faces[i].polygon, p)) return i
  return -1
}

/** How many (non-vertical) lines pass strictly below the point. */
export function levelOfPoint(lines: Line[], p: Point): number {
  let below = 0
  for (const l of lines) {
    if (isVertical(l)) continue
    if (yAt(l, p.x) < p.y - EPS) below++
  }
  return below
}

// ── Combinatorial structure: vertices, edges, faces & Euler's formula ─────────

export interface ArrangementStats {
  vertices: Point[]
  edges: [Point, Point][]
  V: number
  E: number
  F: number // includes the unbounded (outer) face
  euler: number // V − E + F, must equal 2 for a connected planar subdivision
  eulerOK: boolean
}

const keyOf = (p: Point): string => `${Math.round(p.x / 1e-7)},${Math.round(p.y / 1e-7)}`

/**
 * Proper single-point intersection of segments [a,b] and [c,d], including
 * T-junctions where an endpoint of one lies on the interior of the other.
 * Returns null for disjoint, parallel or collinear-overlapping pairs.
 */
function segIntersect(a: Point, b: Point, c: Point, d: Point): Point | null {
  const r = { x: b.x - a.x, y: b.y - a.y }
  const s = { x: d.x - c.x, y: d.y - c.y }
  const denom = r.x * s.y - r.y * s.x
  if (Math.abs(denom) < 1e-12) return null // parallel or collinear
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / denom
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / denom
  const pad = 1e-9
  if (t < -pad || t > 1 + pad || u < -pad || u > 1 + pad) return null
  return { x: a.x + r.x * t, y: a.y + r.y * t }
}

/**
 * The exact planar subdivision the lines induce inside `frame`: every line is
 * clipped to its chord, the four frame sides are added, all pairwise
 * intersections split those segments into edges, and shared points are merged.
 * The resulting (V, E, F) satisfy Euler's V − E + F = 2 — the invariant the
 * self-test checks on random arrangements.
 */
export function arrangementStats(lines: Line[], frame: Rect): ArrangementStats {
  const corners = rectPolygon(frame)
  // Every segment of the subdivision: the 4 frame sides + one chord per line.
  const segs: [Point, Point][] = []
  for (let i = 0; i < 4; i++) segs.push([corners[i], corners[(i + 1) % 4]])
  for (const l of lines) {
    const chord = clipLineToRect(l, frame)
    if (chord) segs.push(chord)
  }
  // Points lying on each segment (endpoints + all crossings), deduped by key.
  const onSeg: Point[][] = segs.map(([a, b]) => [a, b])
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const x = segIntersect(segs[i][0], segs[i][1], segs[j][0], segs[j][1])
      if (x && inRect(x, frame)) {
        onSeg[i].push(x)
        onSeg[j].push(x)
      }
    }
  }
  const vertexKeys = new Map<string, Point>()
  let E = 0
  for (let i = 0; i < segs.length; i++) {
    const [a, b] = segs[i]
    const dir = { x: b.x - a.x, y: b.y - a.y }
    // Order points along the segment and drop duplicates.
    const uniq = new Map<string, { p: Point; t: number }>()
    for (const p of onSeg[i]) {
      const k = keyOf(p)
      vertexKeys.set(k, p)
      if (!uniq.has(k)) uniq.set(k, { p, t: (p.x - a.x) * dir.x + (p.y - a.y) * dir.y })
    }
    const ordered = [...uniq.values()].sort((u, v) => u.t - v.t)
    E += Math.max(0, ordered.length - 1)
  }
  const V = vertexKeys.size
  const F = arrangementFaces(lines, frame).length + 1 // + the outer face
  const euler = V - E + F
  return {
    vertices: [...vertexKeys.values()],
    edges: segs.map(([a, b]) => [a, b] as [Point, Point]),
    V,
    E,
    F,
    euler,
    eulerOK: euler === 2,
  }
}

/**
 * The zone of a query line: the faces of the arrangement it crosses, and the
 * total edge count of those faces. The zone theorem bounds this by O(n); the
 * self-test confirms the linear growth.
 */
export function zoneComplexity(lines: Line[], query: Line, frame: Rect): { faces: Face[]; edges: number } {
  const faces = arrangementFaces(lines, frame)
  const crossed: Face[] = []
  let edges = 0
  for (const f of faces) {
    let hasPos = false
    let hasNeg = false
    for (const p of f.polygon) {
      const d = signedDist(query, p)
      if (d > EPS) hasPos = true
      else if (d < -EPS) hasNeg = true
    }
    if (hasPos && hasNeg) {
      crossed.push(f)
      edges += f.polygon.length
    }
  }
  return { faces: crossed, edges }
}

// ── Point–line duality ────────────────────────────────────────────────────────
// The standard order-preserving dual:  point (a,b) ↔ line y = a·x − b, and
// line y = m·x + c ↔ point (m, −c). It is an involution, maps incidence to
// incidence, and preserves the above/below relation — the engine behind both
// the ham-sandwich cut and the level machinery below.

export const dualLineOfPoint = (p: Point): SILine => ({ m: p.x, b: -p.y })
export const dualPointOfLine = (l: SILine): Point => ({ x: l.m, y: -l.b })

// ── k-levels and envelopes of a set of non-vertical lines ─────────────────────

/** Value of the k-th lowest line at abscissa x (0-indexed from the bottom). */
export function kthValueAt(lines: SILine[], k: number, x: number): number {
  const vals = lines.map((l) => l.m * x + l.b).sort((a, b) => a - b)
  return vals[Math.max(0, Math.min(vals.length - 1, k))]
}

/** All abscissae where two of the lines cross, within (x0, x1), sorted. */
function crossingXs(lines: SILine[], x0: number, x1: number): number[] {
  const xs: number[] = []
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const dm = lines[i].m - lines[j].m
      if (Math.abs(dm) < 1e-12) continue
      const x = (lines[j].b - lines[i].b) / dm
      if (x > x0 + EPS && x < x1 - EPS) xs.push(x)
    }
  }
  xs.sort((a, b) => a - b)
  return xs
}

/**
 * The k-level of the lines as an x-monotone polyline across [x0, x1]: the locus
 * of points with exactly k lines strictly below. Between consecutive crossings
 * the k-th lowest line is fixed, so the level follows one segment at a time.
 */
export function kLevelPath(lines: SILine[], k: number, x0: number, x1: number): Point[] {
  if (lines.length === 0 || k < 0 || k >= lines.length) return []
  const events = crossingXs(lines, x0, x1)
  const bounds = [x0, ...events, x1]
  const path: Point[] = []
  for (let i = 0; i + 1 < bounds.length; i++) {
    const xa = bounds[i]
    const xb = bounds[i + 1]
    if (xb - xa < EPS) continue
    const xm = (xa + xb) / 2
    // Identify the k-th lowest line on this interval, then follow it edge-to-edge.
    const ranked = lines
      .map((l, li) => ({ v: l.m * xm + l.b, li }))
      .sort((p, q) => p.v - q.v)
    const l = lines[ranked[k].li]
    const A = { x: xa, y: l.m * xa + l.b }
    const B = { x: xb, y: l.m * xb + l.b }
    if (path.length === 0) path.push(A)
    path.push(B)
  }
  return path
}

export const lowerEnvelope = (lines: SILine[], x0: number, x1: number): Point[] =>
  kLevelPath(lines, 0, x0, x1)
export const upperEnvelope = (lines: SILine[], x0: number, x1: number): Point[] =>
  kLevelPath(lines, lines.length - 1, x0, x1)

// ── The ham-sandwich cut ──────────────────────────────────────────────────────

export interface HamSandwich {
  /** The cut, as a general (possibly vertical) normalized line. */
  line: Line
  /** The dual point (m, −b) when the cut was found directly; null if via rotation. */
  dual: Point | null
  /** True if the cut was recovered through the near-vertical rotation fallback. */
  rotated: boolean
  redAbove: number
  redBelow: number
  redOn: number
  blueAbove: number
  blueBelow: number
  blueOn: number
  balanced: boolean
}

const classifyLine = (line: Line, pts: Point[]): { above: number; below: number; on: number } => {
  let above = 0
  let below = 0
  let on = 0
  for (const p of pts) {
    const d = signedDist(line, p)
    if (d > 1e-7) above++
    else if (d < -1e-7) below++
    else on++
  }
  return { above, below, on }
}

const rotatePts = (pts: Point[], t: number): Point[] => {
  const c = Math.cos(t)
  const s = Math.sin(t)
  return pts.map((p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c }))
}

/** Rotate a line's normal back by −θ (its constant is rotation-invariant). */
const unrotateLine = (l: Line, t: number): Line => {
  const c = Math.cos(t)
  const s = Math.sin(t)
  return { nx: l.nx * c + l.ny * s, ny: -l.nx * s + l.ny * c, c: l.c }
}

/**
 * Find the dual point where the two median levels cross, or null when the
 * bisector is (near-)vertical — the one case duality pushes to infinity, since a
 * vertical primal line has no finite dual point.
 */
function medianLevelCrossing(red: Point[], blue: Point[]): SILine | null {
  const rLines = red.map(dualLineOfPoint)
  const bLines = blue.map(dualLineOfPoint)
  const kR = Math.floor(red.length / 2)
  const kB = Math.floor(blue.length / 2)
  const f = (x: number): number => kthValueAt(rLines, kR, x) - kthValueAt(bLines, kB, x)
  const span = 1e4
  const breaks = [
    -span,
    ...crossingXs(rLines, -span, span),
    ...crossingXs(bLines, -span, span),
    span,
  ].sort((a, b) => a - b)
  for (let i = 0; i + 1 < breaks.length; i++) {
    const xa = breaks[i]
    const xb = breaks[i + 1]
    if (xb - xa < 1e-9) continue
    const fa = f(xa + 1e-6)
    const fb = f(xb - 1e-6)
    if (fa === 0 || (fa < 0) !== (fb < 0)) {
      const denom = fb - fa
      const t = Math.abs(denom) < 1e-15 ? 0.5 : -fa / denom
      const xStar = xa + 1e-6 + (xb - xa - 2e-6) * Math.max(0, Math.min(1, t))
      const yStar = kthValueAt(rLines, kR, xStar)
      // Dual point (xStar, yStar) ↦ primal line y = xStar·x − yStar.
      return { m: xStar, b: -yStar }
    }
  }
  return null
}

/**
 * A line simultaneously bisecting two planar point sets (the ham-sandwich
 * theorem in 2-D). Dualize each set to a fan of lines; a point on a set's
 * ⌊n/2⌋-median level is a primal line halving that set, so the cut is where the
 * two median levels meet. That crossing is found by walking the piecewise-linear
 * difference of the two median heights until it changes sign. When the bisector
 * is near-vertical the crossing escapes to infinity in the dual, so we retry in a
 * generically-rotated frame and rotate the resulting line back — always landing
 * a finite, balanced cut.
 */
export function hamSandwich(red: Point[], blue: Point[]): HamSandwich | null {
  if (red.length === 0 || blue.length === 0) return null
  const direct = medianLevelCrossing(red, blue)
  let line: Line
  let dual: Point | null = null
  let rotated = false
  if (direct) {
    line = lineFromSI(direct)
    dual = { x: direct.m, y: -direct.b }
  } else {
    // Near-vertical cut: solve in a rotated frame, then map the line back.
    const angles = [0.6, 1.05, -0.35, 0.9, -0.8, 1.4]
    let found: Line | null = null
    for (const t of angles) {
      const cross = medianLevelCrossing(rotatePts(red, t), rotatePts(blue, t))
      if (cross) {
        found = unrotateLine(lineFromSI(cross), t)
        break
      }
    }
    if (!found) return null
    line = found
    rotated = true
  }
  const rc = classifyLine(line, red)
  const bc = classifyLine(line, blue)
  const balanced =
    Math.max(rc.above, rc.below) <= Math.ceil(red.length / 2) &&
    Math.max(bc.above, bc.below) <= Math.ceil(blue.length / 2)
  return {
    line,
    dual,
    rotated,
    redAbove: rc.above,
    redBelow: rc.below,
    redOn: rc.on,
    blueAbove: bc.above,
    blueBelow: bc.below,
    blueOn: bc.on,
    balanced,
  }
}

// ── Half-plane intersection & 2-D linear programming (Seidel) ─────────────────

/** A half-plane constraint {(x,y) : nx·x + ny·y ≤ c}. */
export type HalfPlane = Line

/** The (convex) feasible region: the frame clipped by every half-plane. */
export function halfPlaneRegion(constraints: HalfPlane[], frame: Rect): Point[] {
  let poly = rectPolygon(frame)
  for (const h of constraints) {
    poly = clipHalfPlane(poly, h.nx, h.ny, h.c)
    if (poly.length === 0) break
  }
  return poly
}

export interface LPResult {
  point: Point | null
  value: number
  feasible: boolean
}

/**
 * Maximize obj·(x,y) over the half-planes, bounded by `frame`. Seidel's
 * randomized incremental LP: keep the running optimum; when a new constraint is
 * violated the optimum must slide onto that constraint's line, re-solved as a
 * 1-D LP against all earlier constraints. Expected O(n). Seeded for determinism.
 */
export function seidelLP(
  constraints: HalfPlane[],
  obj: Point,
  frame: Rect,
  seed = 1,
): LPResult {
  // The frame becomes four hard constraints so the program is always bounded.
  const box: HalfPlane[] = [
    { nx: 1, ny: 0, c: frame.maxX },
    { nx: -1, ny: 0, c: -frame.minX },
    { nx: 0, ny: 1, c: frame.maxY },
    { nx: 0, ny: -1, c: -frame.minY },
  ]
  // Start at the frame corner that maximizes the objective.
  let best = rectPolygon(frame)[0]
  let bestVal = -Infinity
  for (const corner of rectPolygon(frame)) {
    const v = obj.x * corner.x + obj.y * corner.y
    if (v > bestVal) {
      bestVal = v
      best = corner
    }
  }
  const active: HalfPlane[] = [...box]
  // Fisher–Yates shuffle of the user constraints with a seeded RNG.
  const order = constraints.map((_, i) => i)
  let s = seed >>> 0
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }

  for (const oi of order) {
    const h = constraints[oi]
    if (h.nx * best.x + h.ny * best.y <= h.c + 1e-9) {
      active.push(h)
      continue
    }
    // Optimum slides onto the line h: nx·x+ny·y = c. Parametrize q(t)=q0+t·dir.
    const q0 = { x: h.c * h.nx, y: h.c * h.ny }
    const dir = { x: -h.ny, y: h.nx }
    let tlo = -Infinity
    let thi = Infinity
    let feasible = true
    for (const g of active) {
      // g: gx·q + gy·q ≤ gc  →  (g·q0 − gc) + t·(g·dir) ≤ 0.
      const num = g.nx * q0.x + g.ny * q0.y - g.c
      const den = g.nx * dir.x + g.ny * dir.y
      if (Math.abs(den) < 1e-12) {
        if (num > 1e-9) {
          feasible = false
          break
        }
      } else {
        const t = -num / den
        if (den > 0) thi = Math.min(thi, t)
        else tlo = Math.max(tlo, t)
      }
    }
    if (!feasible || tlo > thi + 1e-9) return { point: null, value: -Infinity, feasible: false }
    const along = obj.x * dir.x + obj.y * dir.y
    const t = along > 0 ? thi : along < 0 ? tlo : (tlo + thi) / 2
    const tc = Math.max(tlo, Math.min(thi, t))
    best = { x: q0.x + dir.x * tc, y: q0.y + dir.y * tc }
    active.push(h)
  }
  return { point: best, value: obj.x * best.x + obj.y * best.y, feasible: true }
}

/** Brute-force LP optimum: the best vertex of the feasible polygon (the oracle). */
export function lpBruteForce(constraints: HalfPlane[], obj: Point, frame: Rect): LPResult {
  const region = halfPlaneRegion(constraints, frame)
  if (region.length === 0) return { point: null, value: -Infinity, feasible: false }
  let best = region[0]
  let bestVal = -Infinity
  for (const p of region) {
    const v = obj.x * p.x + obj.y * p.y
    if (v > bestVal) {
      bestVal = v
      best = p
    }
  }
  return { point: best, value: bestVal, feasible: true }
}
