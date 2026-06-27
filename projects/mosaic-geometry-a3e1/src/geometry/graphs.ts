import type { Edge, Point, Triangle } from './types'
import { dist, dist2, mid } from './vector'

// Proximity graphs derived from the Delaunay triangulation. Two classics here:
//   • Euclidean Minimum Spanning Tree (EMST) — a subgraph of the Delaunay edges,
//     so we can run Kruskal over just those edges instead of all O(n²) pairs.
//   • Gabriel graph — edge (a,b) is kept iff the disk with diameter ab contains
//     no other site. Also a Delaunay subgraph (EMST ⊆ Gabriel ⊆ Delaunay).

class DisjointSet {
  private parent: number[]
  private rank: number[]
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
    this.rank = new Array(n).fill(0)
  }
  find(x: number): number {
    let r = x
    while (this.parent[r] !== r) r = this.parent[r]
    while (this.parent[x] !== r) {
      const next = this.parent[x]
      this.parent[x] = r
      x = next
    }
    return r
  }
  union(a: number, b: number): boolean {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return false
    if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra
    else {
      this.parent[rb] = ra
      this.rank[ra]++
    }
    return true
  }
}

/** Euclidean MST over the given candidate edges (Kruskal). */
export function euclideanMST(pts: Point[], candidateEdges: Edge[]): Edge[] {
  const sorted = [...candidateEdges].sort(
    (e, f) => dist2(pts[e.a], pts[e.b]) - dist2(pts[f.a], pts[f.b]),
  )
  const dsu = new DisjointSet(pts.length)
  const tree: Edge[] = []
  for (const e of sorted) {
    if (dsu.union(e.a, e.b)) {
      tree.push(e)
      if (tree.length === pts.length - 1) break
    }
  }
  return tree
}

/** Gabriel graph filter over candidate (Delaunay) edges. */
export function gabrielGraph(pts: Point[], candidateEdges: Edge[]): Edge[] {
  const out: Edge[] = []
  for (const e of candidateEdges) {
    const a = pts[e.a]
    const b = pts[e.b]
    const m = mid(a, b)
    const r2 = dist2(a, b) / 4
    let ok = true
    for (let k = 0; k < pts.length; k++) {
      if (k === e.a || k === e.b) continue
      if (dist2(pts[k], m) < r2 - 1e-9) {
        ok = false
        break
      }
    }
    if (ok) out.push(e)
  }
  return out
}

/** Total length of an edge set — handy for stats. */
export function totalLength(pts: Point[], edges: Edge[]): number {
  let s = 0
  for (const e of edges) s += dist(pts[e.a], pts[e.b])
  return s
}

// The proximity-graph hierarchy is a tidy nesting:
//   NNG ⊆ EMST ⊆ RNG ⊆ Urquhart ⊆ Gabriel ⊆ Delaunay
// Every member is a subgraph of the Delaunay triangulation, so each can be
// extracted by filtering the Delaunay edges (or, for the Urquhart graph, the
// triangles) instead of touching all O(n²) pairs.

/**
 * Relative Neighborhood Graph. Edge (a,b) survives iff no third site r is
 * simultaneously closer to a *and* closer to b than they are to each other — i.e.
 * the lune (intersection of the two disks of radius |ab| centered at a and b) is
 * empty. A clean middle ground between the (sparse) EMST and the (denser) Gabriel
 * graph. O(E·n) over the Delaunay candidate edges.
 */
export function relativeNeighborhoodGraph(pts: Point[], candidateEdges: Edge[]): Edge[] {
  const out: Edge[] = []
  for (const e of candidateEdges) {
    const a = pts[e.a]
    const b = pts[e.b]
    const d2 = dist2(a, b)
    let ok = true
    for (let k = 0; k < pts.length; k++) {
      if (k === e.a || k === e.b) continue
      // r lies in the lune when it is strictly inside both disks of radius |ab|.
      if (dist2(pts[k], a) < d2 - 1e-9 && dist2(pts[k], b) < d2 - 1e-9) {
        ok = false
        break
      }
    }
    if (ok) out.push(e)
  }
  return out
}

/**
 * Nearest-Neighbor Graph: connect every site to its single closest neighbor. The
 * nearest neighbor is always a Delaunay edge, so we only scan each vertex's
 * Delaunay neighbours. Returned as a deduplicated undirected edge set (a mutual
 * nearest pair yields one edge, not two).
 */
export function nearestNeighborGraph(pts: Point[], candidateEdges: Edge[]): Edge[] {
  const n = pts.length
  const adj: number[][] = Array.from({ length: n }, () => [])
  for (const e of candidateEdges) {
    adj[e.a].push(e.b)
    adj[e.b].push(e.a)
  }
  const seen = new Set<string>()
  const out: Edge[] = []
  for (let i = 0; i < n; i++) {
    let best = -1
    let bestD = Infinity
    for (const j of adj[i]) {
      const d = dist2(pts[i], pts[j])
      if (d < bestD) {
        bestD = d
        best = j
      }
    }
    if (best < 0) continue
    const lo = Math.min(i, best)
    const hi = Math.max(i, best)
    const key = `${lo}_${hi}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push({ a: lo, b: hi })
    }
  }
  return out
}

/**
 * Urquhart graph: drop the longest edge of every Delaunay triangle. A famously
 * cheap, high-quality approximation of the relative neighborhood graph — it needs
 * only the triangles, no per-edge proximity search. An edge is removed if it is
 * the longest in *any* incident triangle.
 */
export function urquhartGraph(pts: Point[], tris: Triangle[]): Edge[] {
  const removed = new Set<string>()
  const present = new Set<string>()
  const key = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`)
  for (const t of tris) {
    const e = [
      { a: t.a, b: t.b, d: dist2(pts[t.a], pts[t.b]) },
      { a: t.b, b: t.c, d: dist2(pts[t.b], pts[t.c]) },
      { a: t.c, b: t.a, d: dist2(pts[t.c], pts[t.a]) },
    ]
    for (const ed of e) present.add(key(ed.a, ed.b))
    let longest = e[0]
    for (const ed of e) if (ed.d > longest.d) longest = ed
    removed.add(key(longest.a, longest.b))
  }
  const out: Edge[] = []
  for (const k of present) {
    if (removed.has(k)) continue
    const [a, b] = k.split('_').map(Number)
    out.push({ a, b })
  }
  return out
}

/** Closest pair of sites, and the distance between them. */
export interface ClosestPair {
  a: number
  b: number
  dist: number
}

/**
 * Closest pair of points. The closest pair is always a Delaunay edge, so the
 * shortest candidate edge is the answer — O(E). Falls back to a brute-force scan
 * for degenerate inputs (fewer than three points, or all-collinear sites that
 * produce no triangles).
 */
export function closestPair(pts: Point[], candidateEdges: Edge[]): ClosestPair | null {
  if (pts.length < 2) return null
  let best: ClosestPair | null = null
  if (candidateEdges.length > 0) {
    let bestD2 = Infinity
    for (const e of candidateEdges) {
      const d2 = dist2(pts[e.a], pts[e.b])
      if (d2 < bestD2) {
        bestD2 = d2
        best = { a: e.a, b: e.b, dist: Math.sqrt(d2) }
      }
    }
    if (best) return best
  }
  // Degenerate fallback (no triangulation edges available).
  let bestD2 = Infinity
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d2 = dist2(pts[i], pts[j])
      if (d2 < bestD2) {
        bestD2 = d2
        best = { a: i, b: j, dist: Math.sqrt(d2) }
      }
    }
  }
  return best
}
