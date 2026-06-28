import type { Point, Triangle } from './types'
import { orient } from './predicates'
import { dist2 } from './vector'

// Planar point location by the *jump-and-walk* method on the Delaunay mesh: to
// find which triangle contains a query point, start at some triangle and step to
// a neighbour across whichever edge the query lies *outside* of, repeating until
// no edge is crossed — that triangle contains the point. On a Delaunay
// triangulation the oriented walk is guaranteed to terminate, and from a good
// starting guess it touches only ~√T triangles instead of scanning all of them.
//
// This is the dual face of nearest-site search: the triangle a query lands in
// has the three sites of that triangle as its nearest Delaunay neighbours, and
// the nearest of *all* sites is the owner of the Voronoi cell the point sits in.

export interface TriMesh {
  points: Point[]
  tris: Triangle[]
  // neighbour[t] = [across (b,c), across (c,a), across (a,b)], -1 on the hull.
  neighbour: number[][]
}

const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`)

/** Build triangle adjacency from a triangulation (each interior edge links two
 *  triangles; hull edges link to -1). */
export function buildMesh(points: Point[], tris: Triangle[]): TriMesh {
  const neighbour: number[][] = tris.map(() => [-1, -1, -1])
  // For triangle t = (a,b,c): edge 0 = (b,c), edge 1 = (c,a), edge 2 = (a,b).
  const seen = new Map<string, { t: number; e: number }>()
  const link = (t: number, e: number, u: number, v: number) => {
    const k = edgeKey(u, v)
    const other = seen.get(k)
    if (other) {
      neighbour[t][e] = other.t
      neighbour[other.t][other.e] = t
    } else {
      seen.set(k, { t, e })
    }
  }
  tris.forEach((tri, t) => {
    link(t, 0, tri.b, tri.c)
    link(t, 1, tri.c, tri.a)
    link(t, 2, tri.a, tri.b)
  })
  return { points, tris, neighbour }
}

/** Is `q` inside (or on) triangle (a,b,c)? Sign-agnostic, so winding is irrelevant. */
export function pointInTriangle(a: Point, b: Point, c: Point, q: Point): boolean {
  const d1 = orient(a, b, q)
  const d2 = orient(b, c, q)
  const d3 = orient(c, a, q)
  const hasNeg = d1 < -1e-12 || d2 < -1e-12 || d3 < -1e-12
  const hasPos = d1 > 1e-12 || d2 > 1e-12 || d3 > 1e-12
  return !(hasNeg && hasPos)
}

export interface LocateResult {
  triangle: number // containing triangle index, or -1 if the query is outside the hull
  path: number[] // triangles visited, in order — the walk for animation
}

/** Locate the triangle containing `q`, walking from `start`. Pass the previously
 *  located triangle as `start` for spatial coherence (each move is then short). */
export function locate(mesh: TriMesh, q: Point, start = 0): LocateResult {
  const { points, tris, neighbour } = mesh
  if (tris.length === 0) return { triangle: -1, path: [] }
  let t = start >= 0 && start < tris.length ? start : 0
  let prev = -1
  const path = [t]
  const guard = tris.length * 3 + 16
  for (let step = 0; step < guard; step++) {
    const tri = tris[t]
    const A = points[tri.a]
    const B = points[tri.b]
    const C = points[tri.c]
    // Interior of a CCW triangle is to the left of every boundary edge; a
    // negative orientation means the query is across that edge (outside it).
    const oBC = orient(B, C, q) // edge 0
    const oCA = orient(C, A, q) // edge 1
    const oAB = orient(A, B, q) // edge 2
    const candidates: number[] = []
    if (oBC < 0) candidates.push(0)
    if (oCA < 0) candidates.push(1)
    if (oAB < 0) candidates.push(2)
    if (candidates.length === 0) return { triangle: t, path } // contains q

    // Prefer an edge that doesn't bounce us straight back where we came from.
    let cross = -1
    for (const e of candidates) {
      const nb = neighbour[t][e]
      if (nb !== -1 && nb !== prev) {
        cross = e
        break
      }
    }
    if (cross === -1) {
      for (const e of candidates) if (neighbour[t][e] !== -1) cross = e
    }
    if (cross === -1) return { triangle: -1, path } // walked off the convex hull

    prev = t
    t = neighbour[t][cross]
    path.push(t)
  }
  return { triangle: -1, path }
}

/** Brute-force triangle scan — the ground truth the walk is checked against. */
export function locateBruteForce(points: Point[], tris: Triangle[], q: Point): number {
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i]
    if (pointInTriangle(points[t.a], points[t.b], points[t.c], q)) return i
  }
  return -1
}

/** Index of the site nearest `q` — the owner of the Voronoi cell `q` falls in. */
export function nearestSite(points: Point[], q: Point): number {
  let best = -1
  let bestD2 = Infinity
  for (let i = 0; i < points.length; i++) {
    const d2 = dist2(points[i], q)
    if (d2 < bestD2) {
      bestD2 = d2
      best = i
    }
  }
  return best
}
