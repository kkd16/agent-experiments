import type { Point } from './types'
import { orient } from './predicates'
import { add, cross, sub } from './vector'
import { signedArea } from './polygon'
import { booleanOp, type MultiPolygon, type Ring } from './boolean'

// ── Minkowski sums A ⊕ B = { a + b : a ∈ A, b ∈ B } ─────────────────────────
//
// The convex case is the classic O(n+m) edge merge: a convex polygon is the
// ordered sequence of its edge vectors sorted by angle, and the sum's edge
// sequence is simply the two sequences merged by angle — so we walk both
// boundaries once, emitting a vertex and advancing whichever edge turns less.
//
// The general (non-convex) case reduces to the convex one: triangulate each
// operand (ear clipping — triangles are trivially convex), sum every pair of
// triangles convexly, and boolean-**union** the whole pile back together.

/** Ensure a simple polygon winds counter-clockwise (positive signed area). */
export function toCCW(poly: Ring): Ring {
  return signedArea(poly) < 0 ? [...poly].reverse() : [...poly]
}

/** Reflect a polygon through the origin: −P (used to form C-space obstacles). */
export function reflect(poly: Ring): Ring {
  return poly.map((p) => ({ x: -p.x, y: -p.y }))
}

function rotateToLowest(poly: Ring): Ring {
  let k = 0
  for (let i = 1; i < poly.length; i++) {
    if (poly[i].y < poly[k].y || (poly[i].y === poly[k].y && poly[i].x < poly[k].x)) k = i
  }
  return [...poly.slice(k), ...poly.slice(0, k)]
}

/**
 * Minkowski sum of two **convex** polygons (given in any winding) by the
 * angle-sorted edge merge. Returns a convex polygon wound CCW.
 */
export function convexMinkowski(P0: Ring, Q0: Ring): Ring {
  const P = rotateToLowest(toCCW(P0))
  const Q = rotateToLowest(toCCW(Q0))
  const n = P.length
  const m = Q.length
  if (n === 0) return [...Q0]
  if (m === 0) return [...P0]
  const result: Ring = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    result.push(add(P[i % n], Q[j % m]))
    const eP = sub(P[(i + 1) % n], P[i % n])
    const eQ = sub(Q[(j + 1) % m], Q[j % m])
    const cr = cross(eP, eQ)
    if (i >= n) j++
    else if (j >= m) i++
    else if (cr > 0) i++
    else if (cr < 0) j++
    else {
      i++
      j++
    }
  }
  return dedupeRing(result)
}

function dedupeRing(ring: Ring): Ring {
  const out: Ring = []
  for (const p of ring) {
    const last = out[out.length - 1]
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-9) out.push(p)
  }
  while (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= 1e-9) {
    out.pop()
  }
  return out
}

function pointInTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const d1 = orient(a, b, p)
  const d2 = orient(b, c, p)
  const d3 = orient(c, a, p)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

/**
 * Ear-clipping triangulation of a simple polygon. Returns a list of CCW
 * triangles covering the interior. Robust enough for the (small) polygons the
 * studio produces; bails gracefully on degenerate input.
 */
export function earClip(poly0: Ring): Ring[] {
  const poly = toCCW(poly0)
  const n = poly.length
  if (n < 3) return []
  const V = [...Array(n).keys()]
  const tris: Ring[] = []
  let guard = 0
  while (V.length > 3 && guard++ < n * n + 10) {
    let clipped = false
    for (let i = 0; i < V.length; i++) {
      const ia = V[(i + V.length - 1) % V.length]
      const ib = V[i]
      const ic = V[(i + 1) % V.length]
      const a = poly[ia]
      const b = poly[ib]
      const c = poly[ic]
      if (orient(a, b, c) <= 0) continue // reflex or collinear — not an ear tip
      let empty = true
      for (const iv of V) {
        if (iv === ia || iv === ib || iv === ic) continue
        if (pointInTriangle(poly[iv], a, b, c)) {
          empty = false
          break
        }
      }
      if (!empty) continue
      tris.push([a, b, c])
      V.splice(i, 1)
      clipped = true
      break
    }
    if (!clipped) break // degenerate: stop rather than loop forever
  }
  if (V.length === 3) tris.push([poly[V[0]], poly[V[1]], poly[V[2]]])
  return tris
}

/**
 * General Minkowski sum of two simple polygons (possibly non-convex): triangulate
 * both, sum every triangle pair convexly, and union the pieces. Returns a region
 * (possibly with holes) as a MultiPolygon.
 */
export function minkowskiSum(A: Ring, B: Ring): MultiPolygon {
  const triA = earClip(A)
  const triB = earClip(B)
  if (triA.length === 0 || triB.length === 0) return []
  let acc: MultiPolygon = []
  for (const ta of triA) {
    for (const tb of triB) {
      const piece = convexMinkowski(ta, tb)
      if (piece.length < 3) continue
      acc = acc.length === 0 ? [piece] : booleanOp(acc, [piece], 'union')
    }
  }
  return acc
}
