import type { Point } from './types'
import { orient } from './predicates'
import { triangleAdjacency } from './artgallery'
import { triangulatePolygon } from './triangulate'

// ── Geodesic shortest path inside a simple polygon (Lee–Preparata funnel) ────
//
// The Euclidean-shortest path between two points inside a simple polygon is the
// "taut string" you'd get by pulling a thread between them — it bends only at
// reflex vertices. The classic O(n) method (once the polygon is triangulated):
//
//   1. Triangulate, then locate the triangles containing s and t.
//   2. The triangulation dual is a tree; the unique tree path between those two
//      triangles crosses a sequence of interior diagonals — the **portals**.
//   3. Walk the portals with the **funnel** algorithm: keep an apex plus a left
//      and right chain; each new portal edge tightens one side, and whenever a
//      side would cross the other the apex advances to a reflex vertex, emitting
//      a corner of the path. This is the "string-pulling" of Hershberger–Snoeyink.
//
// The result is the exact shortest geodesic; on a convex polygon it collapses to
// the straight segment, and every bend sits on a genuine reflex vertex.

export interface Geodesic {
  path: Point[]
  length: number
  /** The triangle-dual path (triangle indices) the funnel walked. */
  triPath: number[]
  /** Portal diagonals crossed, as [left, right] point pairs. */
  portals: [Point, Point][]
  ok: boolean
}

const area2 = (a: Point, b: Point, c: Point) => orient(a, b, c)

function pointInTri(p: Point, a: Point, b: Point, c: Point): boolean {
  const d1 = area2(p, a, b)
  const d2 = area2(p, b, c)
  const d3 = area2(p, c, a)
  const neg = d1 < 0 || d2 < 0 || d3 < 0
  const pos = d1 > 0 || d2 > 0 || d3 > 0
  return !(neg && pos) // all same sign (or on an edge) ⇒ inside
}

function pathLength(pts: Point[]): number {
  let s = 0
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return s
}

/**
 * Shortest geodesic from `s` to `t` inside the simple polygon `poly` (CCW or CW —
 * normalised internally). Returns the taut path and its length.
 */
export function geodesicPath(s: Point, t: Point, poly: Point[]): Geodesic {
  const fail: Geodesic = { path: [s, t], length: Math.hypot(t.x - s.x, t.y - s.y), triPath: [], portals: [], ok: false }
  const tri = triangulatePolygon(poly)
  const V = tri.vertices
  const T = tri.triangles
  if (T.length === 0) return fail

  const locate = (p: Point): number => {
    for (let i = 0; i < T.length; i++) {
      if (pointInTri(p, V[T[i].a], V[T[i].b], V[T[i].c])) return i
    }
    return -1
  }
  const sTri = locate(s)
  const tTri = locate(t)
  if (sTri < 0 || tTri < 0) return fail

  // BFS the triangle dual tree for the path of triangles from sTri to tTri.
  const adj = triangleAdjacency(T)
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`)
  const neighbours = (i: number): { tri: number; edge: [number, number] }[] => {
    const tt = T[i]
    const res: { tri: number; edge: [number, number] }[] = []
    for (const [a, b] of [
      [tt.a, tt.b],
      [tt.b, tt.c],
      [tt.c, tt.a],
    ] as const) {
      for (const j of adj.get(key(a, b)) ?? []) if (j !== i) res.push({ tri: j, edge: [a, b] })
    }
    return res
  }

  const prev = new Map<number, { from: number; edge: [number, number] }>()
  const queue = [sTri]
  const seen = new Set([sTri])
  while (queue.length) {
    const cur = queue.shift()!
    if (cur === tTri) break
    for (const { tri: nb, edge } of neighbours(cur)) {
      if (seen.has(nb)) continue
      seen.add(nb)
      prev.set(nb, { from: cur, edge })
      queue.push(nb)
    }
  }
  if (!prev.has(tTri) && sTri !== tTri) return fail

  // Reconstruct the triangle path and the ordered portal diagonals.
  const triPath: number[] = []
  const portalEdges: [number, number][] = []
  let cur = tTri
  while (cur !== sTri) {
    triPath.push(cur)
    const p = prev.get(cur)!
    portalEdges.push(p.edge)
    cur = p.from
  }
  triPath.push(sTri)
  triPath.reverse()
  portalEdges.reverse()

  // Orient each portal so `left` is on the left of the walking direction. In a
  // CCW triangle, the interior sits left of every directed edge, so the edge we
  // exit through is directed with the *next* triangle on its right — its tail is
  // the left portal vertex, its head the right one.
  const portals: [Point, Point][] = []
  for (let i = 0; i < portalEdges.length; i++) {
    const from = triPath[i]
    const [a, b] = portalEdges[i]
    const tt = T[from]
    const cyc = [tt.a, tt.b, tt.c]
    // Find a,b consecutive in CCW order of the exiting triangle.
    let leftV = a
    let rightV = b
    for (let k = 0; k < 3; k++) {
      if (cyc[k] === a && cyc[(k + 1) % 3] === b) {
        leftV = a
        rightV = b
        break
      }
      if (cyc[k] === b && cyc[(k + 1) % 3] === a) {
        leftV = b
        rightV = a
        break
      }
    }
    portals.push([V[leftV], V[rightV]])
  }

  const path = funnel(s, t, portals)
  return { path, length: pathLength(path), triPath, portals, ok: true }
}

/**
 * The funnel / string-pulling core. `portals[i] = [left, right]` are the portal
 * edge endpoints in walk order; returns the shortest polyline from s to t.
 * (Mononen's formulation of the Hershberger–Snoeyink funnel.)
 */
export function funnel(s: Point, t: Point, portals: [Point, Point][]): Point[] {
  const left: Point[] = [s, ...portals.map((p) => p[0]), t]
  const right: Point[] = [s, ...portals.map((p) => p[1]), t]
  const n = left.length

  const out: Point[] = [s]
  let apex = s
  let portalL = s
  let portalR = s
  let leftIdx = 0
  let rightIdx = 0

  for (let i = 1; i < n; i++) {
    const L = left[i]
    const R = right[i]

    // Tighten the right side.
    if (area2(apex, portalR, R) <= 0) {
      if (same(apex, portalR) || area2(apex, portalL, R) > 0) {
        portalR = R
        rightIdx = i
      } else {
        // Right over left ⇒ the left vertex becomes a new apex/corner.
        pushPoint(out, portalL)
        apex = portalL
        const na = leftIdx
        portalL = apex
        portalR = apex
        leftIdx = na
        rightIdx = na
        i = na
        continue
      }
    }
    // Tighten the left side.
    if (area2(apex, portalL, L) >= 0) {
      if (same(apex, portalL) || area2(apex, portalR, L) < 0) {
        portalL = L
        leftIdx = i
      } else {
        pushPoint(out, portalR)
        apex = portalR
        const na = rightIdx
        portalL = apex
        portalR = apex
        leftIdx = na
        rightIdx = na
        i = na
        continue
      }
    }
  }
  pushPoint(out, t)
  return out
}

function same(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y
}
function pushPoint(out: Point[], p: Point): void {
  const last = out[out.length - 1]
  if (!last || !same(last, p)) out.push(p)
}
