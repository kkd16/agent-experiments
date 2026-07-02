import type { Point, Triangle } from './types'
import { orient } from './predicates'
import { delaunay } from './delaunay'
import { convexHull } from './convexHull'
import { signedArea, clipHalfPlane, area, centroid } from './polygon'
import { pointInTriangle } from './pointLocation'
import { bounds } from './vector'

// ─────────────────────────────────────────────────────────────────────────────
// Kirkpatrick's point-location hierarchy — the *other* classic O(log n) locator,
// and a completely independent cross-check on the trapezoidal map. Where Seidel
// randomizes a segment arrangement, Kirkpatrick (1983) is deterministic and
// beautifully structural: triangulate the region inside one big enclosing
// triangle, then repeatedly delete an **independent set of low-degree interior
// vertices** and re-triangulate the small holes they leave. Each deletion makes
// the triangulation coarser by a constant fraction, so after O(log n) rounds only
// the enclosing triangle remains. A vertex removal is *local*: the new triangles
// filling a hole overlap only the constant-many old triangles that surrounded the
// removed vertex, and those overlaps are the edges of a DAG.
//
// To locate q, start at the top (the lone enclosing triangle) and walk *down*:
// at each level the current coarse triangle points to the constant-many finer
// triangles it overlaps; test those, step into the one containing q, repeat. The
// descent is O(log n) because there are O(log n) levels and O(1) work per level.
//
// We enclose the sites in a far outer triangle and Delaunay-triangulate the
// augmented set. Every triangle whose three corners are all original sites is —
// since adding far points can only shrink empty circumcircles — a genuine
// Delaunay triangle of the sites, so a located interior triangle maps straight
// back to the site triangulation; a triangle touching an outer corner means the
// query is outside the sites' convex hull.

interface Level {
  tris: Triangle[]
}

export interface KirkpatrickMap {
  /** Locate the site-triangle index containing `q` (or -1 outside the hull),
   *  plus the number of triangle tests spent descending the hierarchy. */
  locateTriangle(q: Point): { triangle: number; comparisons: number; levelsDescended: number }
  /** Number of levels (1 = only the enclosing triangle). */
  levelCount: number
  /** Triangles per level, coarsest-last — for the "how it collapses" readout. */
  levelSizes: number[]
  /** Total triangles across every level (the DAG's node count). */
  totalNodes: number
}

const EPS = 1e-12

// Overlap test: do triangles `outer` and `inner` share area? Used only to build
// child links, where **over-inclusion is harmless** (it only lengthens a child
// list) but a miss breaks the descent — so the test is deliberately generous:
// clip inner against outer (both winding orders) and also accept if a vertex or
// centroid of one lies in the other, catching thin slivers near-degenerate
// clipping would round away.
function trianglesOverlap(P: Point[], outer: Triangle, inner: Triangle): boolean {
  const oPts = [P[outer.a], P[outer.b], P[outer.c]]
  const iPts = [P[inner.a], P[inner.b], P[inner.c]]
  // Clip inner against outer's edges regardless of outer's winding.
  const ccw = orient(oPts[0], oPts[1], oPts[2]) >= 0
  const verts = ccw ? oPts : [oPts[0], oPts[2], oPts[1]]
  let poly: Point[] = iPts
  let clippedOut = false
  for (let e = 0; e < 3; e++) {
    const A = verts[e]
    const B = verts[(e + 1) % 3]
    const nx = B.y - A.y
    const ny = -(B.x - A.x)
    const c = nx * A.x + ny * A.y
    poly = clipHalfPlane(poly, nx, ny, c)
    if (poly.length === 0) {
      clippedOut = true
      break
    }
  }
  if (!clippedOut && area(poly) > 1e-15) return true
  // Sliver / containment fallbacks.
  if (pointInTriangle(oPts[0], oPts[1], oPts[2], centroid(iPts))) return true
  if (pointInTriangle(iPts[0], iPts[1], iPts[2], centroid(oPts))) return true
  for (const v of iPts) if (pointInTriangle(oPts[0], oPts[1], oPts[2], v)) return true
  for (const v of oPts) if (pointInTriangle(iPts[0], iPts[1], iPts[2], v)) return true
  return false
}

// The link of an interior vertex v: the polygon of its neighbours, in order,
// built by chaining each incident triangle's edge opposite v.
function linkPolygon(v: number, star: number[], tris: Triangle[]): number[] {
  const next = new Map<number, number>()
  for (const ti of star) {
    const t = tris[ti]
    let e: [number, number]
    if (t.a === v) e = [t.b, t.c]
    else if (t.b === v) e = [t.c, t.a]
    else e = [t.a, t.b]
    next.set(e[0], e[1])
  }
  // Walk the cycle from any edge tail.
  const first = next.keys().next().value as number
  const poly: number[] = [first]
  let cur = next.get(first)!
  let guard = 0
  while (cur !== first && guard++ < next.size + 2) {
    poly.push(cur)
    const nx = next.get(cur)
    if (nx === undefined) break
    cur = nx
  }
  return poly
}

// Is p strictly inside triangle (a,b,c)? (Boundary/vertices excluded, so a
// vertex lying on an ear's edge does not block that ear — the grid degeneracy.)
function strictlyInside(a: Point, b: Point, c: Point, p: Point): boolean {
  const d1 = orient(a, b, p)
  const d2 = orient(b, c, p)
  const d3 = orient(c, a, p)
  const hasNeg = d1 < -EPS || d2 < -EPS || d3 < -EPS
  const hasPos = d1 > EPS || d2 > EPS || d3 > EPS
  return !(hasNeg && hasPos) && Math.abs(d1) > EPS && Math.abs(d2) > EPS && Math.abs(d3) > EPS
}

// Ear-clip a simple polygon (given as point indices), returning CCW triangles.
// Robust to collinear vertices (a straight-line vertex is clipped without
// emitting a zero-area triangle) so a nearly-collinear link never stalls.
function earClip(polyIdx: number[], P: Point[]): Triangle[] {
  const idx = polyIdx.slice()
  if (signedArea(idx.map((i) => P[i])) < 0) idx.reverse() // normalize to CCW
  const out: Triangle[] = []
  const V = idx.slice()
  let guard = 0
  const limit = polyIdx.length * polyIdx.length + 16
  while (V.length > 3 && guard++ < limit) {
    let clipped = false
    for (let i = 0; i < V.length; i++) {
      const a = V[(i + V.length - 1) % V.length]
      const b = V[i]
      const c = V[(i + 1) % V.length]
      const o = orient(P[a], P[b], P[c])
      if (o <= EPS) {
        // Collinear vertex: safe to drop (no area lost).
        if (Math.abs(o) <= EPS) {
          V.splice(i, 1)
          clipped = true
          break
        }
        continue // reflex — not an ear
      }
      let ear = true
      for (const p of V) {
        if (p === a || p === b || p === c) continue
        if (strictlyInside(P[a], P[b], P[c], P[p])) {
          ear = false
          break
        }
      }
      if (!ear) continue
      out.push({ a, b, c })
      V.splice(i, 1)
      clipped = true
      break
    }
    if (!clipped) break // fully degenerate; bail with what we have
  }
  if (V.length === 3 && Math.abs(orient(P[V[0]], P[V[1]], P[V[2]])) > EPS) {
    out.push({ a: V[0], b: V[1], c: V[2] })
  }
  return out
}

/**
 * Build Kirkpatrick's hierarchy for locating points in the site triangulation
 * `tris` (the Delaunay triangulation of `points`). Queries return an index back
 * into `tris`, so the answer is directly comparable to the other locators.
 */
export function buildKirkpatrick(points: Point[], tris: Triangle[], degreeCap = 12): KirkpatrickMap {
  const nOrig = points.length
  // Enclosing triangle far outside the sites.
  const b = nOrig ? bounds(points) : { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  const cx = (b.minX + b.maxX) / 2
  const cy = (b.minY + b.maxY) / 2
  const R = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1e-6) * 12 + 1
  const P: Point[] = [
    ...points,
    { x: cx, y: cy - R * 2 },
    { x: cx + R * 2, y: cy + R * 1.6 },
    { x: cx - R * 2, y: cy + R * 1.6 },
  ]
  // Level 0 = Delaunay of the augmented set (covers the enclosing triangle).
  const levels: Level[] = [{ tris: delaunay(P) }]
  // childrenOf[k][j] = finer-level (k-1) triangle indices that levels[k].tris[j] overlaps.
  const childrenOf: number[][][] = [[]]

  let k = 0
  let guard = 0
  while (levels[k].tris.length > 1 && guard++ < nOrig + 8) {
    const L = levels[k].tris
    // Vertex → incident triangles, and adjacency, for interior vertices.
    const incid = new Map<number, number[]>()
    const adj = new Map<number, Set<number>>()
    const touch = (v: number, ti: number, others: number[]) => {
      if (v >= nOrig) return
      if (!incid.has(v)) {
        incid.set(v, [])
        adj.set(v, new Set())
      }
      incid.get(v)!.push(ti)
      for (const o of others) adj.get(v)!.add(o)
    }
    L.forEach((t, ti) => {
      touch(t.a, ti, [t.b, t.c])
      touch(t.b, ti, [t.a, t.c])
      touch(t.c, ti, [t.a, t.b])
    })

    // Greedy independent set of low-degree interior vertices.
    const picked: number[] = []
    const blocked = new Set<number>()
    const cand = [...incid.keys()].sort((u, v) => incid.get(u)!.length - incid.get(v)!.length)
    for (const v of cand) {
      if (blocked.has(v)) continue
      if (incid.get(v)!.length > degreeCap) continue
      picked.push(v)
      blocked.add(v)
      for (const nb of adj.get(v)!) blocked.add(nb)
    }
    // Guarantee progress: if nothing qualified, take the lowest-degree vertex.
    if (picked.length === 0 && cand.length) picked.push(cand[0])
    if (picked.length === 0) break

    const removed = new Set(picked)
    const removedTris = new Set<number>()
    for (const v of picked) for (const ti of incid.get(v)!) removedTris.add(ti)

    const newTris: Triangle[] = []
    const links: number[][] = []
    // Surviving triangles carry an identity link down.
    L.forEach((t, ti) => {
      if (!removedTris.has(ti)) {
        newTris.push(t)
        links.push([ti])
      }
    })
    // Retriangulate each removed vertex's hole.
    for (const v of picked) {
      const star = incid.get(v)!
      const poly = linkPolygon(v, star, L)
      const fill = earClip(poly, P)
      for (const et of fill) {
        const kids = star.filter((ti) => trianglesOverlap(P, et, L[ti]))
        newTris.push(et)
        links.push(kids)
      }
    }
    void removed
    levels.push({ tris: newTris })
    childrenOf.push(links)
    k++
  }

  // Map a located triangle's vertex triple → its index in the caller's `tris`.
  const tripleKey = (a: number, b: number, c: number) => {
    const s = [a, b, c].sort((x, y) => x - y)
    return `${s[0]}_${s[1]}_${s[2]}`
  }
  const siteIndex = new Map<string, number>()
  tris.forEach((t, i) => siteIndex.set(tripleKey(t.a, t.b, t.c), i))

  // The sites' convex hull (CCW) — the boundary between the real triangulation
  // and the annulus filler. Used to tell "genuinely outside" from the thin
  // near-boundary region where the augmented Delaunay disagrees with `tris`.
  const hull = nOrig >= 3 ? convexHull(points) : []
  const insideHull = (q: Point): boolean => {
    if (hull.length < 3) return false
    for (let i = 0; i < hull.length; i++) {
      const a = points[hull[i]]
      const b = points[hull[(i + 1) % hull.length]]
      if (orient(a, b, q) < -1e-9) return false
    }
    return true
  }
  const scanTris = (q: Point): number => {
    for (let i = 0; i < tris.length; i++) {
      const tt = tris[i]
      if (pointInTriangle(points[tt.a], points[tt.b], points[tt.c], q)) return i
    }
    return -1
  }

  const top = levels.length - 1
  const inTri = (t: Triangle, q: Point) => pointInTriangle(P[t.a], P[t.b], P[t.c], q)
  // Signed containment margin: ≥ 0 iff q is inside (or on) the CCW/CW triangle.
  // Used to disambiguate the boundary case where a query just inside the hull
  // also tolerantly touches the annulus triangle across a hull edge — the truly
  // containing triangle has a non-negative margin, its edge-neighbour a negative
  // one, so picking the largest margin always follows q into the right cell.
  const margin = (t: Triangle, q: Point): number => {
    const A = P[t.a]
    const B = P[t.b]
    const C = P[t.c]
    let d1 = orient(A, B, q)
    let d2 = orient(B, C, q)
    let d3 = orient(C, A, q)
    if (orient(A, B, C) < 0) {
      d1 = -d1
      d2 = -d2
      d3 = -d3
    }
    return Math.min(d1, d2, d3)
  }

  return {
    levelCount: levels.length,
    levelSizes: levels.map((l) => l.tris.length),
    totalNodes: levels.reduce((s, l) => s + l.tris.length, 0),
    locateTriangle(q: Point) {
      let comparisons = 0
      if (levels[top].tris.length === 0) return { triangle: -1, comparisons, levelsDescended: 0 }
      // The top level is a single triangle (the enclosing triangle).
      comparisons++
      if (!inTri(levels[top].tris[0], q)) return { triangle: -1, comparisons, levelsDescended: 0 }
      let cur = 0
      let descended = 0
      for (let lvl = top; lvl >= 1; lvl--) {
        const kids = childrenOf[lvl][cur]
        let found = -1
        let best = -Infinity
        for (const ci of kids) {
          comparisons++
          const m = margin(levels[lvl - 1].tris[ci], q)
          if (m > best) {
            best = m
            found = ci
          }
        }
        if (found < 0 || best < -1e-7) return { triangle: -1, comparisons, levelsDescended: descended }
        cur = found
        descended++
      }
      const t = levels[0].tris[cur]
      const allOriginal = t.a < nOrig && t.b < nOrig && t.c < nOrig
      if (allOriginal) {
        const idx = siteIndex.get(tripleKey(t.a, t.b, t.c))
        if (idx !== undefined) return { triangle: idx, comparisons, levelsDescended: descended }
      }
      // The descent landed on an annulus triangle, or on an interior triangle the
      // augmented Delaunay triangulated differently from `tris` (a near-boundary /
      // near-cocircular disagreement between two equally valid triangulations).
      // Only when q genuinely lies inside the sites' hull do we reconcile with a
      // linear scan; the common "outside the hull" answer stays O(log n).
      if (insideHull(q)) return { triangle: scanTris(q), comparisons, levelsDescended: descended }
      return { triangle: -1, comparisons, levelsDescended: descended }
    },
  }
}
