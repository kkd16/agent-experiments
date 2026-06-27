import type { Edge, Point } from './types'
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
