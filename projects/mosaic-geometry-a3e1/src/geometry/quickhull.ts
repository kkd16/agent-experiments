import type { Point } from './types'
import { orient } from './predicates'

// Quickhull — a second convex-hull algorithm, divide-and-conquer in spirit
// (quicksort for geometry). Anchor on the two extreme-x points A, B; they are
// certainly on the hull and split the set into the points above the line A→B and
// the points below it. For each side, the point **farthest from the line** is on
// the hull; it splits that side's work into two smaller edges, and we recurse.
// Points inside the triangle (A, apex, B) can never be on the hull and are
// discarded wholesale — that pruning is what makes it fast in practice.
//
// Expected O(n log n); O(n²) on adversarial inputs. We cross-check it against
// Andrew's monotone chain in the self-test: identical hulls on every scene.

const EPS = 1e-9

/** Convex hull as point indices in counter-clockwise order (matching
 *  `convexHull`), collinear vertices dropped. */
export function quickHull(pts: Point[]): number[] {
  const n = pts.length
  if (n < 3) return pts.map((_, i) => i)

  let aI = 0
  let bI = 0
  for (let i = 1; i < n; i++) {
    if (pts[i].x < pts[aI].x || (pts[i].x === pts[aI].x && pts[i].y < pts[aI].y)) aI = i
    if (pts[i].x > pts[bI].x || (pts[i].x === pts[bI].x && pts[i].y > pts[bI].y)) bI = i
  }
  if (aI === bI) return [aI] // all points coincide in x and y → single column handled below

  const above: number[] = []
  const below: number[] = []
  for (let i = 0; i < n; i++) {
    if (i === aI || i === bI) continue
    const o = orient(pts[aI], pts[bI], pts[i])
    if (o > EPS) above.push(i)
    else if (o < -EPS) below.push(i)
  }

  // Walk A → (above chain) → B → (below chain) → A. This particular ordering is
  // clockwise; we normalize to CCW at the end by signed area.
  const hull: number[] = [aI]
  recurse(pts, above, aI, bI, hull)
  hull.push(bI)
  recurse(pts, below, bI, aI, hull)

  return ensureCCW(pts, hull)
}

// Append to `hull` the hull vertices strictly between p and q that lie on the far
// (left) side of the directed edge p→q, in order from p toward q.
function recurse(pts: Point[], idxs: number[], p: number, q: number, hull: number[]): void {
  if (idxs.length === 0) return
  let apex = -1
  let best = EPS
  for (const i of idxs) {
    const d = orient(pts[p], pts[q], pts[i])
    if (d > best) {
      best = d
      apex = i
    }
  }
  if (apex < 0) return // all (near-)collinear with p→q

  const left: number[] = []
  const right: number[] = []
  for (const i of idxs) {
    if (i === apex) continue
    if (orient(pts[p], pts[apex], pts[i]) > EPS) left.push(i)
    else if (orient(pts[apex], pts[q], pts[i]) > EPS) right.push(i)
  }
  recurse(pts, left, p, apex, hull)
  hull.push(apex)
  recurse(pts, right, apex, q, hull)
}

function ensureCCW(pts: Point[], hull: number[]): number[] {
  let a2 = 0
  for (let i = 0, n = hull.length; i < n; i++) {
    const a = pts[hull[i]]
    const b = pts[hull[(i + 1) % n]]
    a2 += a.x * b.y - b.x * a.y
  }
  return a2 < 0 ? hull.slice().reverse() : hull
}

// ── Step-by-step trace, for the algorithm visualizer ────────────────────────

export interface QuickHullStep {
  /** The hull boundary committed so far, in order (a growing convex polyline). */
  boundary: number[]
  /** The directed edge currently being expanded, [p, q] (−1,−1 when done). */
  edge: [number, number]
  /** Candidate points still outside the current edge. */
  outside: number[]
  /** The farthest point just chosen as the new apex (−1 if none / done). */
  apex: number
  note: string
}

/**
 * Produce a full pre-order trace of the Quickhull build. The displayed boundary
 * starts as the diameter segment [A, B] and grows: every time a far edge picks
 * its farthest apex, that apex is spliced into the boundary between its edge's
 * endpoints, so the visualizer always shows a valid (if partial) convex outline.
 */
export function quickHullSteps(pts: Point[]): QuickHullStep[] {
  const steps: QuickHullStep[] = []
  const n = pts.length
  if (n < 3) {
    steps.push({
      boundary: pts.map((_, i) => i),
      edge: [-1, -1],
      outside: [],
      apex: -1,
      note: 'Fewer than 3 points — the hull is just the points themselves.',
    })
    return steps
  }

  let aI = 0
  let bI = 0
  for (let i = 1; i < n; i++) {
    if (pts[i].x < pts[aI].x || (pts[i].x === pts[aI].x && pts[i].y < pts[aI].y)) aI = i
    if (pts[i].x > pts[bI].x || (pts[i].x === pts[bI].x && pts[i].y > pts[bI].y)) bI = i
  }

  const above: number[] = []
  const below: number[] = []
  for (let i = 0; i < n; i++) {
    if (i === aI || i === bI) continue
    const o = orient(pts[aI], pts[bI], pts[i])
    if (o > EPS) above.push(i)
    else if (o < -EPS) below.push(i)
  }

  // boundary is kept cyclic-ish as a flat array A … B … (then back to A).
  const boundary: number[] = [aI, bI]
  const snap = (edge: [number, number], outside: number[], apex: number, note: string) =>
    steps.push({ boundary: [...boundary], edge, outside: [...outside], apex, note })

  snap([aI, bI], [...above, ...below],
    -1,
    'Anchor on the leftmost and rightmost points — both are guaranteed hull vertices. They split the rest into points above and below the line.',
  )

  // Recursive build with snapshots, inserting each apex into `boundary`.
  const build = (idxs: number[], p: number, q: number) => {
    if (idxs.length === 0) return
    let apex = -1
    let bestD = EPS
    for (const i of idxs) {
      const d = orient(pts[p], pts[q], pts[i])
      if (d > bestD) {
        bestD = d
        apex = i
      }
    }
    if (apex < 0) return

    // Splice apex into boundary, right after p.
    const at = boundary.indexOf(p)
    boundary.splice(at + 1, 0, apex)
    snap([p, q], idxs, apex,
      'The point farthest from this edge is a hull vertex — add it and recurse on the two new edges it creates.',
    )

    const left: number[] = []
    const right: number[] = []
    for (const i of idxs) {
      if (i === apex) continue
      if (orient(pts[p], pts[apex], pts[i]) > EPS) left.push(i)
      else if (orient(pts[apex], pts[q], pts[i]) > EPS) right.push(i)
    }
    build(left, p, apex)
    build(right, apex, q)
  }

  build(above, aI, bI)
  build(below, bI, aI)

  snap([-1, -1], [], -1, 'No points remain outside any edge — the convex hull is complete.')
  return steps
}
