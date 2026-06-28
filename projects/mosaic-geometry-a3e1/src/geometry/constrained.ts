import type { Edge, Point, Triangle } from './types'
import { delaunay } from './delaunay'
import { inCircle, orient } from './predicates'

// Constrained Delaunay triangulation (CDT). Start from the ordinary Delaunay
// triangulation, then *force* a set of segments to appear as edges by Lawson's
// edge-insertion: list the edges a segment crosses and flip them one at a time
// (whenever the surrounding quadrilateral is convex) until the segment itself is
// an edge. Finally restore the Delaunay property everywhere *except* across the
// constrained edges, which stay pinned. The result is the unique triangulation
// that contains every constraint and is "as Delaunay as possible" otherwise.
//
// The mesh carries explicit triangle adjacency (each triangle knows the neighbour
// opposite each of its three vertices), which is what makes local flips O(1).

interface MeshTri {
  v: [number, number, number] // vertex indices, CCW
  n: [number, number, number] // n[k] = triangle opposite v[k] (across the other two), or -1
  dead: boolean
}

class Mesh {
  pts: Point[]
  tris: MeshTri[] = []
  constrained = new Set<string>() // pinned edges, "lo_hi"
  constructor(pts: Point[], tris: Triangle[]) {
    this.pts = pts
    this.build(tris)
  }

  static key(a: number, b: number): string {
    return a < b ? `${a}_${b}` : `${b}_${a}`
  }

  private build(tris: Triangle[]): void {
    // Ensure CCW winding so orientation tests are consistent.
    this.tris = tris.map((t) => {
      const ccw = orient(this.pts[t.a], this.pts[t.b], this.pts[t.c]) > 0
      const v: [number, number, number] = ccw ? [t.a, t.b, t.c] : [t.a, t.c, t.b]
      return { v, n: [-1, -1, -1], dead: false }
    })
    // Link neighbours: each undirected edge belongs to at most two triangles.
    const edgeMap = new Map<string, { t: number; slot: number }[]>()
    for (let ti = 0; ti < this.tris.length; ti++) {
      const v = this.tris[ti].v
      for (let s = 0; s < 3; s++) {
        // Edge opposite v[s] joins v[(s+1)%3] and v[(s+2)%3].
        const k = Mesh.key(v[(s + 1) % 3], v[(s + 2) % 3])
        const list = edgeMap.get(k)
        if (list) list.push({ t: ti, slot: s })
        else edgeMap.set(k, [{ t: ti, slot: s }])
      }
    }
    for (const list of edgeMap.values()) {
      if (list.length === 2) {
        this.tris[list[0].t].n[list[0].slot] = list[1].t
        this.tris[list[1].t].n[list[1].slot] = list[0].t
      }
    }
  }

  /** Local index (0..2) of vertex `vi` within triangle `ti`, or -1. */
  private slotOfVertex(ti: number, vi: number): number {
    const v = this.tris[ti].v
    return v[0] === vi ? 0 : v[1] === vi ? 1 : v[2] === vi ? 2 : -1
  }

  /** Slot whose neighbour pointer references triangle `from`, or -1. */
  private slotOfNeighbour(ti: number, from: number): number {
    const n = this.tris[ti].n
    return n[0] === from ? 0 : n[1] === from ? 1 : n[2] === from ? 2 : -1
  }

  /** Is there already an edge between u and v? */
  edgeExists(u: number, v: number): boolean {
    for (let ti = 0; ti < this.tris.length; ti++) {
      if (this.tris[ti].dead) continue
      const su = this.slotOfVertex(ti, u)
      const sv = this.slotOfVertex(ti, v)
      if (su >= 0 && sv >= 0) return true
    }
    return false
  }

  /**
   * Flip the edge opposite v[i] in triangle ti (shared with its neighbour).
   * Returns the two apex vertices (p, q) now joined by the new diagonal, or null
   * if the edge is on the hull (no neighbour) or the quad is not convex.
   */
  private flip(ti: number, i: number): [number, number] | null {
    const T = this.tris[ti]
    const ni = T.n[i]
    if (ni < 0) return null
    const N = this.tris[ni]
    const p = T.v[i]
    const a = T.v[(i + 1) % 3]
    const b = T.v[(i + 2) % 3]
    const f = this.slotOfNeighbour(ni, ti)
    if (f < 0) return null
    const q = N.v[f]
    // Convex quad ⇔ the new diagonal p-q properly crosses the shared edge a-b.
    if (!properCross(this.pts[p], this.pts[q], this.pts[a], this.pts[b])) return null

    // External neighbours around the quad p–a–q–b.
    const nA = T.n[(i + 2) % 3] // across edge p-a
    const nB = T.n[(i + 1) % 3] // across edge b-p
    // N is (q, b, a) CCW: v[f]=q, v[(f+1)%3]=b, v[(f+2)%3]=a.
    const nC = N.n[(f + 1) % 3] // opp b ⇒ across edge a-q
    const nD = N.n[(f + 2) % 3] // opp a ⇒ across edge q-b

    // Rebuild T as (p, a, q) and N as (p, q, b).
    T.v = [p, a, q]
    T.n = [nC, ni, nA] // opp p: a-q→nC ; opp a: q-p→N ; opp q: p-a→nA
    N.v = [p, q, b]
    N.n = [nD, nB, ti] // opp p: q-b→nD ; opp q: b-p→nB ; opp b: p-q→T

    // Back-pointers that moved triangles: a-q (nC) now in T; b-p (nB) now in N.
    if (nC >= 0) {
      const s = this.slotOfNeighbour(nC, ni)
      if (s >= 0) this.tris[nC].n[s] = ti
    }
    if (nB >= 0) {
      const s = this.slotOfNeighbour(nB, ti)
      if (s >= 0) this.tris[nB].n[s] = ni
    }
    return [p, q]
  }

  /**
   * Find one currently-flippable edge crossing segment u→v: it must cross the
   * segment, not be a constraint, and bound a convex quad. Also reports whether
   * *any* crossing edge exists at all, so the caller can tell "done" from "stuck".
   * Re-scanning each step keeps every (triangle, slot) reference fresh — flips
   * mutate triangles in place, so cached slots would otherwise go stale.
   */
  private findFlippableCrossing(u: number, v: number): { t: number; slot: number; anyCrossing: boolean } {
    const pu = this.pts[u]
    const pv = this.pts[v]
    let anyCrossing = false
    let result: { t: number; slot: number } | null = null
    for (let ti = 0; ti < this.tris.length; ti++) {
      const T = this.tris[ti]
      if (T.dead) continue
      for (let s = 0; s < 3; s++) {
        const ni = T.n[s]
        if (ni < 0 || ni < ti) continue // each interior edge once, hull edges never cross-flip
        const a = T.v[(s + 1) % 3]
        const b = T.v[(s + 2) % 3]
        if (a === u || a === v || b === u || b === v) continue // touches an endpoint
        if (!properCross(pu, pv, this.pts[a], this.pts[b])) continue
        anyCrossing = true
        if (this.constrained.has(Mesh.key(a, b))) continue
        const p = T.v[s]
        const f = this.slotOfNeighbour(ni, ti)
        if (f < 0) continue
        const q = this.tris[ni].v[f]
        if (properCross(this.pts[p], this.pts[q], this.pts[a], this.pts[b])) {
          if (!result) result = { t: ti, slot: s }
        }
      }
    }
    return result ? { ...result, anyCrossing } : { t: -1, slot: -1, anyCrossing }
  }

  /** Force segment (u,v) to be an edge via Lawson flips. Returns success. */
  insertSegment(u: number, v: number): boolean {
    if (u === v) return false
    if (this.edgeExists(u, v)) {
      this.constrained.add(Mesh.key(u, v))
      return true
    }
    let guard = 0
    const limit = this.tris.length * this.tris.length + 100
    for (;;) {
      if (guard++ > limit) return false
      const c = this.findFlippableCrossing(u, v)
      if (c.t < 0) {
        if (c.anyCrossing) return false // crossing edges remain but none flippable — give up
        break // no edge crosses the segment any more ⇒ it is an edge
      }
      if (!this.flip(c.t, c.slot)) return false
    }
    if (!this.edgeExists(u, v)) return false
    this.constrained.add(Mesh.key(u, v))
    return true
  }

  /**
   * Restore the Delaunay property by flipping every illegal, non-constrained edge
   * (Lawson). Constrained edges are never flipped.
   */
  restoreDelaunay(): void {
    // Seed the stack with all interior edges.
    const stack: { t: number; slot: number }[] = []
    for (let ti = 0; ti < this.tris.length; ti++) {
      if (this.tris[ti].dead) continue
      for (let s = 0; s < 3; s++) if (this.tris[ti].n[s] > ti) stack.push({ t: ti, slot: s })
    }
    let guard = 0
    const limit = this.tris.length * this.tris.length * 4 + 1000
    while (stack.length > 0) {
      if (guard++ > limit) break
      const { t: ti, slot } = stack.pop() as { t: number; slot: number }
      const T = this.tris[ti]
      if (T.dead) continue
      const ni = T.n[slot]
      if (ni < 0) continue
      const a = T.v[(slot + 1) % 3]
      const b = T.v[(slot + 2) % 3]
      if (this.constrained.has(Mesh.key(a, b))) continue
      const p = T.v[slot]
      const f = this.slotOfNeighbour(ni, ti)
      if (f < 0) continue
      const q = this.tris[ni].v[f]
      // Illegal if q lies inside the circumcircle of (p, a, b).
      const pa = this.pts[a]
      const pb = this.pts[b]
      const pp = this.pts[p]
      const ccw = orient(pp, pa, pb) > 0 ? [pp, pa, pb] : [pp, pb, pa]
      if (inCircle(ccw[0], ccw[1], ccw[2], this.pts[q]) > 1e-9) {
        if (this.flip(ti, slot)) {
          // Push the four outer edges of the new quad for re-checking.
          stack.push({ t: ti, slot: 0 }, { t: ti, slot: 2 }, { t: ni, slot: 0 }, { t: ni, slot: 1 })
        }
      }
    }
  }

  toTriangles(): Triangle[] {
    const out: Triangle[] = []
    for (const t of this.tris) if (!t.dead) out.push({ a: t.v[0], b: t.v[1], c: t.v[2] })
    return out
  }

  /** Unique undirected edges, each flagged whether it is a pinned constraint. */
  toEdges(): { edge: Edge; constrained: boolean }[] {
    const seen = new Set<string>()
    const out: { edge: Edge; constrained: boolean }[] = []
    for (const t of this.tris) {
      if (t.dead) continue
      for (let s = 0; s < 3; s++) {
        const a = t.v[(s + 1) % 3]
        const b = t.v[(s + 2) % 3]
        const k = Mesh.key(a, b)
        if (seen.has(k)) continue
        seen.add(k)
        out.push({ edge: { a: Math.min(a, b), b: Math.max(a, b) }, constrained: this.constrained.has(k) })
      }
    }
    return out
  }
}

/** Do segments (a,b) and (c,d) cross at an interior point of both? */
function properCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orient(a, b, c)
  const o2 = orient(a, b, d)
  const o3 = orient(c, d, a)
  const o4 = orient(c, d, b)
  return ((o1 > 0) !== (o2 > 0)) && ((o3 > 0) !== (o4 > 0)) &&
    Math.abs(o1) > 1e-12 && Math.abs(o2) > 1e-12 && Math.abs(o3) > 1e-12 && Math.abs(o4) > 1e-12
}

export interface CDTResult {
  triangles: Triangle[]
  edges: { edge: Edge; constrained: boolean }[]
  inserted: number // constraints successfully enforced
  requested: number
}

/**
 * Constrained Delaunay triangulation of `pts` that contains every segment in
 * `constraints` (index pairs). Constraints that cross an existing input vertex or
 * each other may be skipped; `inserted` reports how many were enforced.
 */
export function constrainedDelaunay(pts: Point[], constraints: Edge[]): CDTResult {
  if (pts.length < 3) {
    return { triangles: [], edges: [], inserted: 0, requested: constraints.length }
  }
  const mesh = new Mesh(pts, delaunay(pts))
  let inserted = 0
  for (const c of constraints) {
    if (c.a === c.b) continue
    if (mesh.insertSegment(c.a, c.b)) inserted++
  }
  mesh.restoreDelaunay()
  return {
    triangles: mesh.toTriangles(),
    edges: mesh.toEdges(),
    inserted,
    requested: constraints.length,
  }
}
