import type { Point } from './types'
import { add, cross, dot, scale, sub } from './vector'

// ── Polygon boolean operations (union ∪, intersection ∩, difference −, XOR) ──
//
// General polygons: each operand is a set of rings (a `MultiPolygon`), filled by
// the even-odd rule, so holes are just rings nested inside others — no explicit
// parent pointers needed on input. Everything is from scratch (no clipping
// library).
//
// The method builds the *planar arrangement* of the two boundaries and reads the
// result off it. In three moves:
//
//   1. Overlay every edge of A and B and split each one at every intersection
//      (proper crossings, T-junctions, and the endpoints of collinear overlaps),
//      snapping coincident points to a shared tolerance grid so the arrangement
//      vertices line up exactly. The sub-edges now meet only at endpoints.
//   2. Classify each sub-edge by probing a hair off each side: a sub-edge lies on
//      the result's boundary iff the result-membership (computed from the operand
//      memberships by the operation) *differs* across it. Direct the kept edge so
//      the "in-result" side is on its left.
//   3. Chain the directed boundary edges into oriented rings by the standard
//      face-traversal rule (turn maximally clockwise at each vertex, keeping the
//      region on the left). Outer rings come out CCW, holes CW, so signed areas
//      sum to the true region area and the ring set fills correctly even-odd.
//
// Correctness rests only on segment intersection, even-odd point-in-polygon and a
// small side offset — which is exactly what makes it easy to verify to death with
// Monte-Carlo membership oracles (see selftest.ts).

export type Ring = Point[]
/** A region as a set of rings, filled by the even-odd rule. */
export type MultiPolygon = Ring[]

export type BoolOp = 'union' | 'intersection' | 'difference' | 'xor'

const EPS = 1e-12

/** Even-odd point-in-region test over a set of rings (each implicitly closed). */
export function pointInRings(rings: MultiPolygon, p: Point): boolean {
  let inside = false
  for (const ring of rings) {
    const n = ring.length
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = ring[i]
      const b = ring[j]
      // Standard crossing-number toggle; the `(p.y < a.y) !== (p.y < b.y)`
      // guard counts each edge on exactly one side so vertices don't double-count.
      if ((a.y > p.y) !== (b.y > p.y)) {
        const t = (p.y - a.y) / (b.y - a.y)
        if (p.x < a.x + t * (b.x - a.x)) inside = !inside
      }
    }
  }
  return inside
}

/**
 * Intersection of two closed segments [p1,p2] and [p3,p4]. Returns the crossing
 * point (1 element), the two endpoints of a collinear overlap (2 elements), or
 * an empty array when they miss.
 */
export function segmentIntersection(p1: Point, p2: Point, p3: Point, p4: Point): Point[] {
  const r = sub(p2, p1)
  const s = sub(p4, p3)
  const rxs = cross(r, s)
  const qp = sub(p3, p1)
  const qpxr = cross(qp, r)
  const rr = dot(r, r)
  const ss = dot(s, s)

  if (Math.abs(rxs) <= EPS * Math.sqrt(rr * ss + 1)) {
    // Parallel. Collinear only if q−p is also parallel to r.
    if (Math.abs(qpxr) > EPS * Math.sqrt(rr * dot(qp, qp) + 1)) return []
    if (rr <= EPS) {
      // p1 == p2: treat the first "segment" as a point on the line of the second.
      return []
    }
    // Project both endpoints of [p3,p4] onto the parameter of [p1,p2].
    let t0 = dot(sub(p3, p1), r) / rr
    let t1 = dot(sub(p4, p1), r) / rr
    if (t0 > t1) {
      const tmp = t0
      t0 = t1
      t1 = tmp
    }
    const lo = Math.max(0, t0)
    const hi = Math.min(1, t1)
    if (lo > hi + 1e-9) return []
    const A = add(p1, scale(r, lo))
    const B = add(p1, scale(r, Math.min(1, Math.max(lo, hi))))
    if (dot(sub(A, B), sub(A, B)) <= EPS) return [A]
    return [A, B]
  }

  const t = cross(qp, s) / rxs
  const u = qpxr / rxs
  const tol = 1e-9
  if (t >= -tol && t <= 1 + tol && u >= -tol && u <= 1 + tol) {
    const tc = Math.min(1, Math.max(0, t))
    return [add(p1, scale(r, tc))]
  }
  return []
}

// ── Point snapping ───────────────────────────────────────────────────────────
// Arrangement vertices must match exactly for chaining, but intersection
// coordinates computed from different pairs drift by rounding. Snap every point
// to a tolerance grid keyed off the input scale.

interface Snapper {
  key(p: Point): string
  tol: number
}

function makeSnapper(points: Point[]): Snapper {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  const span = Math.hypot(maxX - minX, maxY - minY) || 1
  const tol = span * 1e-7
  return {
    tol,
    key(p: Point) {
      return `${Math.round(p.x / tol)}:${Math.round(p.y / tol)}`
    },
  }
}

interface SubEdge {
  a: Point
  b: Point
}

/** Split every input edge at all intersections with all others (all-pairs). */
function buildArrangement(edges: SubEdge[], snap: Snapper): SubEdge[] {
  // For each edge, collect the split points lying on it (its own endpoints + any
  // intersection with another edge), then cut it into monotone sub-edges.
  const splits: Point[][] = edges.map((e) => [e.a, e.b])
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const pts = segmentIntersection(edges[i].a, edges[i].b, edges[j].a, edges[j].b)
      for (const p of pts) {
        splits[i].push(p)
        splits[j].push(p)
      }
    }
  }

  const out: SubEdge[] = []
  const seen = new Set<string>()
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]
    const dir = sub(e.b, e.a)
    const len2 = dot(dir, dir)
    if (len2 <= EPS) continue
    // Order the split points along the edge and dedup by the snap grid.
    const uniq = new Map<string, { p: Point; t: number }>()
    for (const p of splits[i]) {
      const t = dot(sub(p, e.a), dir) / len2
      const tc = Math.min(1, Math.max(0, t))
      const k = snap.key(p)
      if (!uniq.has(k)) uniq.set(k, { p, t: tc })
    }
    const ordered = [...uniq.values()].sort((x, y) => x.t - y.t)
    for (let k = 0; k + 1 < ordered.length; k++) {
      const a = ordered[k].p
      const b = ordered[k + 1].p
      const ka = snap.key(a)
      const kb = snap.key(b)
      if (ka === kb) continue
      // Merge coincident sub-edges from A and B into one undirected edge.
      const ekey = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
      if (seen.has(ekey)) continue
      seen.add(ekey)
      out.push({ a, b })
    }
  }
  return out
}

function ringsToEdges(rings: MultiPolygon): SubEdge[] {
  const edges: SubEdge[] = []
  for (const ring of rings) {
    const n = ring.length
    if (n < 3) continue
    for (let i = 0; i < n; i++) {
      edges.push({ a: ring[i], b: ring[(i + 1) % n] })
    }
  }
  return edges
}

function resultMembership(op: BoolOp, inA: boolean, inB: boolean): boolean {
  switch (op) {
    case 'union':
      return inA || inB
    case 'intersection':
      return inA && inB
    case 'difference':
      return inA && !inB
    case 'xor':
      return inA !== inB
  }
}

interface DirectedEdge {
  a: Point
  b: Point
  ka: string
  kb: string
  id: number
}

/** Compute the boolean `op` of two regions, returned as oriented rings. */
export function booleanOp(A: MultiPolygon, B: MultiPolygon, op: BoolOp): MultiPolygon {
  const allPts: Point[] = []
  for (const r of A) for (const p of r) allPts.push(p)
  for (const r of B) for (const p of r) allPts.push(p)
  if (allPts.length === 0) return []
  const snap = makeSnapper(allPts)

  const edges = [...ringsToEdges(A), ...ringsToEdges(B)]
  const sub2 = buildArrangement(edges, snap)

  // The side-probe offset is a *tiny* fixed fraction of the overall scale — small
  // enough to never cross the local clearance to a neighbouring edge (edges only
  // meet at endpoints, and points closer than the snap grid are already merged),
  // yet far above double-precision noise. It is emphatically NOT scaled to the
  // shortest sub-edge: a nearby-but-distinct feature would then be overshot.
  const probe = snap.tol * 50

  const directed: DirectedEdge[] = []
  for (const e of sub2) {
    const d = sub(e.b, e.a)
    const len = Math.hypot(d.x, d.y)
    if (len <= snap.tol) continue
    const mx = (e.a.x + e.b.x) / 2
    const my = (e.a.y + e.b.y) / 2
    // Left normal of a→b.
    const nx = -d.y / len
    const ny = d.x / len
    const off = Math.min(probe, len * 0.4)
    const left: Point = { x: mx + nx * off, y: my + ny * off }
    const right: Point = { x: mx - nx * off, y: my - ny * off }

    const leftIn = resultMembership(op, pointInRings(A, left), pointInRings(B, left))
    const rightIn = resultMembership(op, pointInRings(A, right), pointInRings(B, right))
    if (leftIn === rightIn) continue // not a boundary edge

    // Orient so the in-result side sits on the left of the directed edge.
    const from = leftIn ? e.a : e.b
    const to = leftIn ? e.b : e.a
    directed.push({
      a: from,
      b: to,
      ka: snap.key(from),
      kb: snap.key(to),
      id: directed.length,
    })
  }

  return chainEdges(directed)
}

/**
 * Chain directed boundary edges into oriented rings. The next edge after `e` is
 * the outgoing edge at head(e) that turns most clockwise from the reversed
 * incoming direction — the rotation-system face-traversal rule that keeps the
 * region on the left. Computed as a global permutation of the edges, so its
 * cycles partition every edge into exactly one ring (outer rings CCW, holes CW).
 */
function chainEdges(directed: DirectedEdge[]): MultiPolygon {
  const n = directed.length
  if (n === 0) return []
  const outgoing = new Map<string, DirectedEdge[]>()
  for (const e of directed) {
    const list = outgoing.get(e.ka)
    if (list) list.push(e)
    else outgoing.set(e.ka, [e])
  }
  const angleOf = (e: DirectedEdge) => Math.atan2(e.b.y - e.a.y, e.b.x - e.a.x)

  // next[i] = the edge to follow after edge i (the face-traversal permutation).
  const next = new Int32Array(n).fill(-1)
  for (const e of directed) {
    const candidates = outgoing.get(e.kb)
    if (!candidates) continue
    const incoming = Math.atan2(e.a.y - e.b.y, e.a.x - e.b.x) // reversed direction
    let best: DirectedEdge | null = null
    let bestTurn = Infinity
    for (const c of candidates) {
      let turn = incoming - angleOf(c)
      while (turn <= 1e-12) turn += Math.PI * 2
      while (turn > Math.PI * 2 + 1e-12) turn -= Math.PI * 2
      if (turn < bestTurn) {
        bestTurn = turn
        best = c
      }
    }
    if (best) next[e.id] = best.id
  }

  const rings: MultiPolygon = []
  const visited = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (visited[i]) continue
    const ring: Point[] = []
    let cur = i
    let guard = 0
    while (cur >= 0 && !visited[cur] && guard++ <= n) {
      visited[cur] = 1
      ring.push(directed[cur].a)
      cur = next[directed[cur].id]
    }
    if (ring.length >= 3) rings.push(ring)
  }
  return rings
}

/** Signed area of a ring (CCW positive). */
export function ringSignedArea(ring: Ring): number {
  let s = 0
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % n]
    s += a.x * b.y - b.x * a.y
  }
  return s / 2
}

/** Net area of a region (outer rings CCW positive, holes CW negative). */
export function regionArea(rings: MultiPolygon): number {
  let s = 0
  for (const r of rings) s += ringSignedArea(r)
  return Math.abs(s)
}
