import type { Circle, Point } from './types'
import { circumcircle } from './predicates'
import { dist, mid } from './vector'
import { mulberry32 } from './random'

// Smallest enclosing circle via Welzl's algorithm — the smallest disk that
// contains every site. Written in its incremental form: shuffle the points, then
// grow the disk so each newly seen point that falls outside is pushed onto the
// boundary, recursively fixing the at-most-two points already pinned there. The
// random shuffle makes a rebuild rare, giving O(n) expected time. The optimal
// circle is always pinned by 2 or 3 of the input points.

const EPS = 1e-9

function circleFrom2(a: Point, b: Point): Circle {
  const c = mid(a, b)
  return { x: c.x, y: c.y, r: dist(a, b) / 2 }
}

function circleFrom3(a: Point, b: Point, c: Point): Circle {
  const cc = circumcircle(a, b, c)
  if (cc) return cc
  // Collinear: the enclosing circle is the diameter of the farthest two.
  const pairs: [Point, Point][] = [
    [a, b],
    [b, c],
    [a, c],
  ]
  let best = circleFrom2(pairs[0][0], pairs[0][1])
  for (const [p, q] of pairs) {
    const cand = circleFrom2(p, q)
    if (cand.r > best.r) best = cand
  }
  return best
}

function inside(c: Circle, p: Point): boolean {
  const dx = p.x - c.x
  const dy = p.y - c.y
  return dx * dx + dy * dy <= c.r * c.r + EPS
}

/** Deterministic shuffle (seeded) so results are reproducible across runs. */
function shuffled(pts: Point[], seed: number): Point[] {
  const a = pts.slice()
  const rng = mulberry32(seed)
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Smallest enclosing circle of a point set (null if empty). */
export function minimumEnclosingCircle(input: Point[], seed = 1): Circle | null {
  if (input.length === 0) return null
  if (input.length === 1) return { x: input[0].x, y: input[0].y, r: 0 }
  const p = shuffled(input, seed)
  let c = circleFrom2(p[0], p[1])
  for (let i = 2; i < p.length; i++) {
    if (inside(c, p[i])) continue
    c = withPointOnBoundary(p, i, p[i])
  }
  return c
}

// One boundary point fixed (p[i]); solve over p[0..i].
function withPointOnBoundary(p: Point[], i: number, q0: Point): Circle {
  let c = circleFrom2(p[0], q0)
  for (let j = 1; j < i; j++) {
    if (inside(c, p[j])) continue
    c = withTwoOnBoundary(p, j, q0, p[j])
  }
  return c
}

// Two boundary points fixed (q0, q1); solve over p[0..j].
function withTwoOnBoundary(p: Point[], j: number, q0: Point, q1: Point): Circle {
  let c = circleFrom2(q0, q1)
  for (let k = 0; k < j; k++) {
    if (inside(c, p[k])) continue
    c = circleFrom3(q0, q1, p[k])
  }
  return c
}

// ── Step-by-step trace for the visualizer ────────────────────────────────────

export interface MecSnapshot {
  circle: Circle
  processed: number // points considered so far (indices into the shuffled order)
  order: Point[] // the shuffled points, so the visualizer paints them in scan order
  current: number // index just tested (-1 at start/end)
  rebuilt: boolean // did the current point fall outside and force a rebuild?
  support: Point[] // the 2–3 points currently on the boundary
  note: string
}

/**
 * Trace of the incremental Welzl pass, snapshotting each time a point is tested.
 * Narrates the two states that matter: the point was already inside, or it broke
 * out and the circle had to be rebuilt with it on the boundary.
 */
export function mecSteps(input: Point[], seed = 1): MecSnapshot[] {
  const steps: MecSnapshot[] = []
  if (input.length < 2) {
    const circle = input.length === 1 ? { x: input[0].x, y: input[0].y, r: 0 } : { x: 0.5, y: 0.5, r: 0 }
    steps.push({
      circle,
      processed: input.length,
      order: input.slice(),
      current: -1,
      rebuilt: false,
      support: input.slice(),
      note: 'Need at least two points for an enclosing circle.',
    })
    return steps
  }
  const p = shuffled(input, seed)
  let c = circleFrom2(p[0], p[1])
  let support: Point[] = [p[0], p[1]]
  steps.push({
    circle: c,
    processed: 2,
    order: p,
    current: 1,
    rebuilt: true,
    support,
    note: 'Shuffle the points, then seed the circle on the first two.',
  })
  for (let i = 2; i < p.length; i++) {
    if (inside(c, p[i])) {
      steps.push({
        circle: c,
        processed: i + 1,
        order: p,
        current: i,
        rebuilt: false,
        support,
        note: `Point ${i} is already inside — the circle is unchanged.`,
      })
      continue
    }
    // Rebuild with p[i] pinned to the boundary, tracking the support set.
    const rebuilt = rebuildWithSupport(p, i)
    c = rebuilt.circle
    support = rebuilt.support
    steps.push({
      circle: c,
      processed: i + 1,
      order: p,
      current: i,
      rebuilt: true,
      support,
      note: `Point ${i} fell outside — rebuild with it on the boundary (${support.length} support points).`,
    })
  }
  steps.push({
    circle: c,
    processed: p.length,
    order: p,
    current: -1,
    rebuilt: false,
    support,
    note: `Done. The smallest enclosing circle is pinned by ${support.length} points.`,
  })
  return steps
}

function rebuildWithSupport(p: Point[], i: number): { circle: Circle; support: Point[] } {
  const q0 = p[i]
  let c = circleFrom2(p[0], q0)
  let support: Point[] = [p[0], q0]
  for (let j = 1; j < i; j++) {
    if (inside(c, p[j])) continue
    const q1 = p[j]
    c = circleFrom2(q0, q1)
    support = [q0, q1]
    for (let k = 0; k < j; k++) {
      if (inside(c, p[k])) continue
      c = circleFrom3(q0, q1, p[k])
      support = [q0, q1, p[k]]
    }
  }
  return { circle: c, support }
}
