import type { Point } from './types'
import { dist } from './vector'
import { orient } from './predicates'
import { pointInRings, type MultiPolygon, type Ring } from './boolean'
import { convexMinkowski, minkowskiSum, reflect, toCCW } from './minkowski'

// ── Translational motion planning for a convex robot ────────────────────────
//
// A point robot's shortest collision-free path among polygonal obstacles is a
// straight-line-segment path through the *visibility graph* of the obstacle
// vertices (Dijkstra over it gives the Euclidean-shortest route). A robot with
// area is handled by growing every obstacle by the robot's reflection — the
// **configuration-space obstacle** O ⊕ (−R) — after which the robot collapses to
// its reference point and the point-robot machinery applies unchanged.

export interface CObstacle {
  rings: MultiPolygon // the grown obstacle region (outer ring; holes possible)
}

/** Grow one obstacle into its C-space obstacle for the given (convex) robot. */
export function cSpaceObstacle(obstacle: Ring, robot: Ring): MultiPolygon {
  const negR = reflect(toCCW(robot))
  // Convex robot & convex obstacle → a single convex sum; else the general sum.
  const oCCW = toCCW(obstacle)
  if (isConvex(oCCW) && isConvex(negR)) return [convexMinkowski(oCCW, negR)]
  return minkowskiSum(oCCW, negR)
}

export function isConvex(poly: Ring): boolean {
  const n = poly.length
  if (n < 3) return false
  let sign = 0
  for (let i = 0; i < n; i++) {
    const o = orient(poly[i], poly[(i + 1) % n], poly[(i + 2) % n])
    if (Math.abs(o) < 1e-12) continue
    const s = o > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

interface Seg {
  a: Point
  b: Point
}

function obstacleEdges(obstacles: MultiPolygon[]): Seg[] {
  const segs: Seg[] = []
  for (const region of obstacles) {
    for (const ring of region) {
      const n = ring.length
      for (let i = 0; i < n; i++) segs.push({ a: ring[i], b: ring[(i + 1) % n] })
    }
  }
  return segs
}

// Proper segment-segment crossing (open segments): true only if they cross in
// their interiors — shared endpoints and collinear touching don't count, so
// graph edges are allowed to run *along* obstacle boundaries between vertices.
function properIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d1 = orient(p3, p4, p1)
  const d2 = orient(p3, p4, p2)
  const d3 = orient(p1, p2, p3)
  const d4 = orient(p1, p2, p4)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

/**
 * Is the open segment a→b free of obstacle interiors? It must cross no obstacle
 * edge properly and its midpoint must not lie inside any obstacle (which rules
 * out a chord tunnelling through a region between two of its own vertices).
 */
export function segmentIsFree(a: Point, b: Point, obstacles: MultiPolygon[], edges: Seg[]): boolean {
  for (const s of edges) {
    if (properIntersect(a, b, s.a, s.b)) return false
  }
  const mid: Point = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  for (const region of obstacles) {
    if (pointInRings(region, mid)) return false
  }
  // Sample a few interior points too, to catch a chord that grazes a concavity.
  for (let t = 0.25; t < 0.9; t += 0.25) {
    const q: Point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    for (const region of obstacles) if (pointInRings(region, q)) return false
  }
  return true
}

export interface VisibilityGraph {
  nodes: Point[] // [start, goal, ...obstacle vertices]
  edges: { u: number; v: number; w: number }[]
  startIndex: number
  goalIndex: number
}

/** Build the visibility graph over the C-space obstacle vertices + start/goal. */
export function visibilityGraph(
  start: Point,
  goal: Point,
  obstacles: MultiPolygon[],
): VisibilityGraph {
  const nodes: Point[] = [start, goal]
  for (const region of obstacles) for (const ring of region) for (const p of ring) nodes.push(p)
  const edges: { u: number; v: number; w: number }[] = []
  const segs = obstacleEdges(obstacles)
  for (let i = 0; i < nodes.length; i++) {
    // Endpoints that sit strictly inside another obstacle can't be used.
    if (i > 1 && insideAny(nodes[i], obstacles, 1e-7)) continue
    for (let j = i + 1; j < nodes.length; j++) {
      if (j > 1 && insideAny(nodes[j], obstacles, 1e-7)) continue
      if (segmentIsFree(nodes[i], nodes[j], obstacles, segs)) {
        edges.push({ u: i, v: j, w: dist(nodes[i], nodes[j]) })
      }
    }
  }
  return { nodes, edges, startIndex: 0, goalIndex: 1 }
}

function insideAny(p: Point, obstacles: MultiPolygon[], eps: number): boolean {
  // Nudge the point inward a hair before testing so its own boundary vertices
  // aren't reported as "inside".
  void eps
  for (const region of obstacles) if (strictlyInside(region, p)) return true
  return false
}

// Strictly-inside test: inside by even-odd AND not lying on any edge.
function strictlyInside(region: MultiPolygon, p: Point): boolean {
  if (!pointInRings(region, p)) return false
  for (const ring of region) {
    const n = ring.length
    for (let i = 0; i < n; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % n]
      // distance point→segment
      const vx = b.x - a.x
      const vy = b.y - a.y
      const wx = p.x - a.x
      const wy = p.y - a.y
      const len2 = vx * vx + vy * vy || 1
      const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2))
      const dx = p.x - (a.x + t * vx)
      const dy = p.y - (a.y + t * vy)
      if (dx * dx + dy * dy < 1e-14) return false // on boundary
    }
  }
  return true
}

export interface PlanResult {
  path: Point[] // empty if unreachable
  length: number
  graph: VisibilityGraph
  reachable: boolean
}

/** Dijkstra shortest path from start to goal over the visibility graph. */
export function shortestPath(graph: VisibilityGraph): PlanResult {
  const { nodes, edges, startIndex, goalIndex } = graph
  const n = nodes.length
  const adj: { to: number; w: number }[][] = Array.from({ length: n }, () => [])
  for (const e of edges) {
    adj[e.u].push({ to: e.v, w: e.w })
    adj[e.v].push({ to: e.u, w: e.w })
  }
  const distTo = new Array(n).fill(Infinity)
  const prev = new Array(n).fill(-1)
  const done = new Array(n).fill(false)
  distTo[startIndex] = 0
  // Simple O(n²) selection (n is small — obstacle vertices).
  for (let iter = 0; iter < n; iter++) {
    let u = -1
    let best = Infinity
    for (let i = 0; i < n; i++) {
      if (!done[i] && distTo[i] < best) {
        best = distTo[i]
        u = i
      }
    }
    if (u < 0) break
    done[u] = true
    if (u === goalIndex) break
    for (const { to, w } of adj[u]) {
      if (distTo[u] + w < distTo[to]) {
        distTo[to] = distTo[u] + w
        prev[to] = u
      }
    }
  }
  if (distTo[goalIndex] === Infinity) {
    return { path: [], length: Infinity, graph, reachable: false }
  }
  const path: Point[] = []
  for (let at = goalIndex; at !== -1; at = prev[at]) path.push(nodes[at])
  path.reverse()
  return { path, length: distTo[goalIndex], graph, reachable: true }
}

/** End-to-end plan: grow obstacles, build the visibility graph, Dijkstra it. */
export function planPath(
  start: Point,
  goal: Point,
  obstacles: Ring[],
  robot: Ring,
): { result: PlanResult; cObstacles: MultiPolygon[] } {
  const cObstacles = obstacles.map((o) => cSpaceObstacle(o, robot))
  const graph = visibilityGraph(start, goal, cObstacles)
  const result = shortestPath(graph)
  return { result, cObstacles }
}
