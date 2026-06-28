import type { Edge, Point } from './types'
import { dist } from './vector'

// Geometric spanners: sparse graphs that nonetheless approximate every Euclidean
// distance. A graph is a *t-spanner* if, for every pair of sites, the shortest
// path through the graph is at most t times their straight-line distance. The
// smallest such t is the graph's *dilation* (spanning ratio). Three constructions
// live here, each from scratch:
//
//   • Yao graph    — split the directions around each point into k cones; in each
//                    cone, keep the edge to the nearest point.
//   • Θ (theta)    — same cones, but keep the point with the smallest projection
//                    onto the cone's axis (cheaper to reason about; t ≈ 1/(1−2 sin(π/k))).
//   • Greedy       — consider all pairs shortest-first and add an edge only when
//                    the current graph can't already get within t of it. Sparsest
//                    of the three for a given t, but O(n² log n)-ish to build.
//
// `dilation` then measures the *actual* spanning ratio by all-pairs shortest path,
// so the theoretical guarantee can be checked against the realized stretch.

const TAU = Math.PI * 2

/** Canonicalize a directed edge set into deduped undirected edges (a < b). */
function dedupe(pairs: [number, number][]): Edge[] {
  const seen = new Set<string>()
  const out: Edge[] = []
  for (const [u, v] of pairs) {
    if (u === v) continue
    const a = Math.min(u, v)
    const b = Math.max(u, v)
    const k = `${a}_${b}`
    if (!seen.has(k)) {
      seen.add(k)
      out.push({ a, b })
    }
  }
  return out
}

/** Yao graph with `cones` sectors: nearest neighbour per cone. */
export function yaoGraph(points: Point[], cones: number, rotate = 0): Edge[] {
  const k = Math.max(2, Math.floor(cones))
  const wedge = TAU / k
  const pairs: [number, number][] = []
  for (let i = 0; i < points.length; i++) {
    const bestIdx = new Array<number>(k).fill(-1)
    const bestVal = new Array<number>(k).fill(Infinity)
    for (let j = 0; j < points.length; j++) {
      if (j === i) continue
      const dx = points[j].x - points[i].x
      const dy = points[j].y - points[i].y
      const ang = (Math.atan2(dy, dx) - rotate + TAU * 2) % TAU
      const s = Math.min(k - 1, Math.floor(ang / wedge))
      const d = dx * dx + dy * dy
      if (d < bestVal[s]) {
        bestVal[s] = d
        bestIdx[s] = j
      }
    }
    for (const j of bestIdx) if (j >= 0) pairs.push([i, j])
  }
  return dedupe(pairs)
}

/** Θ-graph with `cones` sectors: per cone, the point with the least projection
 *  onto the cone bisector (its axis). */
export function thetaGraph(points: Point[], cones: number, rotate = 0): Edge[] {
  const k = Math.max(2, Math.floor(cones))
  const wedge = TAU / k
  const pairs: [number, number][] = []
  for (let i = 0; i < points.length; i++) {
    const bestIdx = new Array<number>(k).fill(-1)
    const bestProj = new Array<number>(k).fill(Infinity)
    for (let j = 0; j < points.length; j++) {
      if (j === i) continue
      const dx = points[j].x - points[i].x
      const dy = points[j].y - points[i].y
      const ang = (Math.atan2(dy, dx) - rotate + TAU * 2) % TAU
      const s = Math.min(k - 1, Math.floor(ang / wedge))
      const axis = rotate + (s + 0.5) * wedge
      const proj = dx * Math.cos(axis) + dy * Math.sin(axis)
      if (proj < bestProj[s]) {
        bestProj[s] = proj
        bestIdx[s] = j
      }
    }
    for (const j of bestIdx) if (j >= 0) pairs.push([i, j])
  }
  return dedupe(pairs)
}

/** Build a weighted adjacency list (Euclidean lengths) from an edge set. */
function adjacency(points: Point[], edges: Edge[]): { to: number; w: number }[][] {
  const adj: { to: number; w: number }[][] = points.map(() => [])
  for (const e of edges) {
    const w = dist(points[e.a], points[e.b])
    adj[e.a].push({ to: e.b, w })
    adj[e.b].push({ to: e.a, w })
  }
  return adj
}

/** Single-source shortest paths (Dijkstra, dense O(V²) — V is small here). */
function dijkstra(adj: { to: number; w: number }[][], src: number): number[] {
  const n = adj.length
  const dist0 = new Array<number>(n).fill(Infinity)
  const done = new Array<boolean>(n).fill(false)
  dist0[src] = 0
  for (let it = 0; it < n; it++) {
    let u = -1
    let best = Infinity
    for (let v = 0; v < n; v++) {
      if (!done[v] && dist0[v] < best) {
        best = dist0[v]
        u = v
      }
    }
    if (u === -1) break
    done[u] = true
    for (const { to, w } of adj[u]) {
      if (dist0[u] + w < dist0[to]) dist0[to] = dist0[u] + w
    }
  }
  return dist0
}

/** Greedy t-spanner: add edges shortest-first only where the graph can't yet get
 *  within `t` of the pair. The classic sparsest construction for a target t. */
export function greedySpanner(points: Point[], t: number): Edge[] {
  const n = points.length
  const pairs: { a: number; b: number; d: number }[] = []
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) pairs.push({ a: i, b: j, d: dist(points[i], points[j]) })
  pairs.sort((p, q) => p.d - q.d)
  const edges: Edge[] = []
  const adj: { to: number; w: number }[][] = points.map(() => [])
  for (const { a, b, d } of pairs) {
    // Cheap lower bound first: re-running Dijkstra for every pair is the cost.
    const sp = dijkstra(adj, a)[b]
    if (sp > t * d + 1e-12) {
      edges.push({ a, b })
      adj[a].push({ to: b, w: d })
      adj[b].push({ to: a, w: d })
    }
  }
  return edges
}

export interface Dilation {
  stretch: number // realized spanning ratio (max over all pairs)
  a: number // the witness pair achieving it
  b: number
  connected: boolean // false ⇒ some pair is unreachable (stretch = ∞)
}

/** The graph's actual dilation: max over pairs of graph-distance / Euclidean. */
export function dilation(points: Point[], edges: Edge[]): Dilation {
  const n = points.length
  const adj = adjacency(points, edges)
  let stretch = 1
  let wa = 0
  let wb = 0
  let connected = n <= 1
  if (n > 1) connected = true
  for (let s = 0; s < n; s++) {
    const d = dijkstra(adj, s)
    for (let t = s + 1; t < n; t++) {
      const euclid = dist(points[s], points[t])
      if (euclid < 1e-15) continue
      if (!Number.isFinite(d[t])) {
        connected = false
        continue
      }
      const ratio = d[t] / euclid
      if (ratio > stretch) {
        stretch = ratio
        wa = s
        wb = t
      }
    }
  }
  return { stretch: connected ? stretch : Infinity, a: wa, b: wb, connected }
}

/** Theoretical dilation bound for the Θ-graph with k cones (k > 4 ⇒ finite). */
export function thetaBound(cones: number): number {
  const s = Math.sin(Math.PI / cones)
  const denom = 1 - 2 * s
  return denom > 0 ? 1 / denom : Infinity
}
