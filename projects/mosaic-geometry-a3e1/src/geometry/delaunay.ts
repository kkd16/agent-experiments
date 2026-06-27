import type { Edge, Point, Triangle } from './types'
import { bounds } from './vector'
import { inCircle, orient } from './predicates'

// Delaunay triangulation via the incremental Bowyer-Watson algorithm.
//
// We embed the input in a large "super-triangle" that contains every point, then
// insert points one at a time: find all triangles whose circumcircle contains the
// new point (the "cavity"), delete them, and re-triangulate the star-shaped hole
// by connecting the new point to each boundary edge. Triangles touching a
// super-vertex are stripped at the end.

const SUPER = 3 // number of synthetic super-triangle vertices appended to the point list

interface WorkTri {
  a: number
  b: number
  c: number
}

/** Build the super-triangle vertices for a point set, generously oversized. */
function superVertices(pts: Point[]): [Point, Point, Point] {
  const b = bounds(pts)
  const dx = b.maxX - b.minX || 1
  const dy = b.maxY - b.minY || 1
  const d = Math.max(dx, dy)
  const cx = (b.minX + b.maxX) / 2
  const cy = (b.minY + b.maxY) / 2
  const m = 20 * d // margin large enough that the triangle encloses everything
  return [
    { x: cx - m, y: cy - m },
    { x: cx + m, y: cy - m },
    { x: cx, y: cy + m },
  ]
}

/** Ensure (a, b, c) is counter-clockwise so the in-circle predicate is valid. */
function orientedTri(pts: Point[], a: number, b: number, c: number): WorkTri {
  return orient(pts[a], pts[b], pts[c]) < 0 ? { a, b: c, c: b } : { a, b, c }
}

interface BWState {
  pts: Point[] // original points followed by the 3 super vertices
  tris: WorkTri[]
  nReal: number
}

function initBowyerWatson(input: Point[]): BWState {
  const [s0, s1, s2] = superVertices(input)
  const pts = [...input, s0, s1, s2]
  const n = input.length
  const tris: WorkTri[] = [orientedTri(pts, n, n + 1, n + 2)]
  return { pts, tris, nReal: n }
}

function insertPoint(state: BWState, i: number): void {
  const { pts, tris } = state
  const p = pts[i]

  // Triangles whose circumcircle contains p form the cavity to be removed.
  const bad: WorkTri[] = []
  for (const t of tris) {
    if (inCircle(pts[t.a], pts[t.b], pts[t.c], p) > 0) bad.push(t)
  }

  // Collect the cavity boundary: edges that belong to exactly one bad triangle.
  const counts = new Map<string, { a: number; b: number; n: number }>()
  const addEdge = (a: number, b: number) => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`
    const e = counts.get(key)
    if (e) e.n++
    else counts.set(key, { a, b, n: 1 })
  }
  for (const t of bad) {
    addEdge(t.a, t.b)
    addEdge(t.b, t.c)
    addEdge(t.c, t.a)
  }

  const badSet = new Set(bad)
  state.tris = tris.filter((t) => !badSet.has(t))

  // Re-triangulate the polygonal hole by fanning the new point to each boundary edge.
  for (const e of counts.values()) {
    if (e.n === 1) state.tris.push(orientedTri(pts, e.a, e.b, i))
  }
}

function strip(state: BWState): Triangle[] {
  const n = state.nReal
  const out: Triangle[] = []
  for (const t of state.tris) {
    if (t.a < n && t.b < n && t.c < n) out.push({ a: t.a, b: t.b, c: t.c })
  }
  return out
}

/** Full Delaunay triangulation. Returns triangles as index triples (CCW). */
export function delaunay(input: Point[]): Triangle[] {
  if (input.length < 3) return []
  const state = initBowyerWatson(input)
  for (let i = 0; i < state.nReal; i++) insertPoint(state, i)
  return strip(state)
}

/** Unique undirected edges of a triangulation (each edge once, a < b). */
export function triangulationEdges(tris: Triangle[]): Edge[] {
  const seen = new Set<string>()
  const edges: Edge[] = []
  const push = (a: number, b: number) => {
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    const key = `${lo}_${hi}`
    if (!seen.has(key)) {
      seen.add(key)
      edges.push({ a: lo, b: hi })
    }
  }
  for (const t of tris) {
    push(t.a, t.b)
    push(t.b, t.c)
    push(t.c, t.a)
  }
  return edges
}

// ── Step-by-step trace for the visualizer ───────────────────────────────────

export interface DelaunaySnapshot {
  pts: Point[] // augmented points (originals + super vertices) for rendering
  nReal: number
  tris: Triangle[] // current triangulation as index triples
  inserted: number // index of the point just inserted (-1 before/after)
  cavity: Triangle[] // bad triangles removed at this step
  note: string
}

export function delaunaySteps(input: Point[]): DelaunaySnapshot[] {
  const steps: DelaunaySnapshot[] = []
  if (input.length < 3) {
    steps.push({
      pts: input,
      nReal: input.length,
      tris: [],
      inserted: -1,
      cavity: [],
      note: 'Need at least 3 points to form a triangle.',
    })
    return steps
  }

  const state = initBowyerWatson(input)
  const asTris = (ts: WorkTri[]): Triangle[] => ts.map((t) => ({ a: t.a, b: t.b, c: t.c }))

  steps.push({
    pts: state.pts,
    nReal: state.nReal,
    tris: asTris(state.tris),
    inserted: -1,
    cavity: [],
    note: 'Start with one huge super-triangle that contains every point.',
  })

  for (let i = 0; i < state.nReal; i++) {
    const p = state.pts[i]
    const cavity = state.tris.filter((t) => inCircle(state.pts[t.a], state.pts[t.b], state.pts[t.c], p) > 0)
    steps.push({
      pts: state.pts,
      nReal: state.nReal,
      tris: asTris(state.tris),
      inserted: i,
      cavity: asTris(cavity),
      note: `Insert point ${i}: its circumcircle violation marks ${cavity.length} triangle(s) as the cavity.`,
    })
    insertPoint(state, i)
    steps.push({
      pts: state.pts,
      nReal: state.nReal,
      tris: asTris(state.tris),
      inserted: i,
      cavity: [],
      note: 'Delete the cavity and reconnect the new point to its boundary — still Delaunay.',
    })
  }

  steps.push({
    pts: state.pts,
    nReal: state.nReal,
    tris: strip(state),
    inserted: -1,
    cavity: [],
    note: 'Discard every triangle touching a super-vertex. The Delaunay mesh remains.',
  })
  return steps
}

export { SUPER }
