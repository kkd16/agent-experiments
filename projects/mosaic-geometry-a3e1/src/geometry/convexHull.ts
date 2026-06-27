import type { Point } from './types'
import { orient } from './predicates'

// Convex hull via Andrew's monotone chain — O(n log n): sort by (x, y), then
// build the lower and upper hulls with a left-turn stack. Returns indices into
// the original point array, in counter-clockwise order.

function sortedIndices(pts: Point[]): number[] {
  return pts
    .map((_, i) => i)
    .sort((i, j) => pts[i].x - pts[j].x || pts[i].y - pts[j].y)
}

export function convexHull(pts: Point[]): number[] {
  const n = pts.length
  if (n < 3) return pts.map((_, i) => i)
  const order = sortedIndices(pts)
  const hull: number[] = []

  // Lower hull.
  for (const i of order) {
    while (
      hull.length >= 2 &&
      orient(pts[hull[hull.length - 2]], pts[hull[hull.length - 1]], pts[i]) <= 0
    ) {
      hull.pop()
    }
    hull.push(i)
  }

  // Upper hull (skip the last point, already added; stop above the lower size).
  const lowerFloor = hull.length + 1
  for (let k = order.length - 2; k >= 0; k--) {
    const i = order[k]
    while (
      hull.length >= lowerFloor &&
      orient(pts[hull[hull.length - 2]], pts[hull[hull.length - 1]], pts[i]) <= 0
    ) {
      hull.pop()
    }
    hull.push(i)
  }

  hull.pop() // last point equals the first
  return hull
}

// ── Step-by-step trace, for the algorithm visualizer ────────────────────────

export interface HullStep {
  order: number[] // points in scan order (sorted by x then y)
  hull: number[] // current stack contents
  considering: number // index of the point currently being added (-1 when done)
  popped: number // index just discarded by a right-turn test (-1 otherwise)
  phase: 'lower' | 'upper' | 'done'
  note: string
}

/** Produce a full trace of the monotone-chain build for narration/animation. */
export function convexHullSteps(pts: Point[]): HullStep[] {
  const steps: HullStep[] = []
  const n = pts.length
  if (n < 3) {
    steps.push({
      order: pts.map((_, i) => i),
      hull: pts.map((_, i) => i),
      considering: -1,
      popped: -1,
      phase: 'done',
      note: 'Fewer than 3 points — the hull is just the points themselves.',
    })
    return steps
  }

  const order = sortedIndices(pts)
  const hull: number[] = []
  const snap = (phase: HullStep['phase'], considering: number, popped: number, note: string) =>
    steps.push({ order, hull: [...hull], considering, popped, phase, note })

  snap('lower', -1, -1, 'Sort points left-to-right, then sweep to build the lower hull.')

  for (const i of order) {
    while (
      hull.length >= 2 &&
      orient(pts[hull[hull.length - 2]], pts[hull[hull.length - 1]], pts[i]) <= 0
    ) {
      const popped = hull.pop() as number
      snap('lower', i, popped, 'Right turn (or collinear) detected — pop the middle point.')
    }
    hull.push(i)
    snap('lower', i, -1, 'Left turn keeps the chain convex — push this point.')
  }

  const lowerFloor = hull.length + 1
  snap('upper', -1, -1, 'Lower hull complete. Sweep back right-to-left for the upper hull.')

  for (let k = order.length - 2; k >= 0; k--) {
    const i = order[k]
    while (
      hull.length >= lowerFloor &&
      orient(pts[hull[hull.length - 2]], pts[hull[hull.length - 1]], pts[i]) <= 0
    ) {
      const popped = hull.pop() as number
      snap('upper', i, popped, 'Right turn on the upper chain — pop the middle point.')
    }
    hull.push(i)
    snap('upper', i, -1, 'Push this point onto the upper hull.')
  }

  hull.pop()
  snap('done', -1, -1, 'Drop the duplicate endpoint — the convex hull is closed.')
  return steps
}
