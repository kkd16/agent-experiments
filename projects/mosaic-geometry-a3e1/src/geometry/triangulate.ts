import type { Point, Triangle } from './types'
import { orient } from './predicates'
import { signedArea } from './polygon'

// ── Simple-polygon triangulation in O(n log n) ──────────────────────────────
//
// The textbook two-phase algorithm (de Berg, Cheong, van Kreveld & Overmars,
// *Computational Geometry*, ch. 3), from scratch:
//
//   1. **Make monotone** — one plane sweep top-to-bottom classifies every vertex
//      as start / end / split / merge / regular, maintaining the set of edges
//      immediately left of the sweep in an x-ordered status structure with a
//      "helper" per edge. Split and merge vertices — the ones that create local
//      non-monotonicity — are resolved by adding a diagonal to the right helper,
//      cutting the polygon into y-monotone pieces.
//   2. **Triangulate each monotone piece** in linear time with the classic stack
//      walk: merge the two chains by descending y, and greedily cut off every ear
//      that turns the right way for the chain the reflex vertices sit on.
//
// The whole thing runs in O(n log n): the sweep sorts the vertices and does a
// logarithmic status query per event; the monotone phase is linear overall.
// Ear-clipping (used elsewhere in the studio for Minkowski sums) is the O(n²)
// rival — this is the asymptotically optimal method, and the first thing the
// Visibility axis stands on (guards, funnels and shortest paths all consume the
// triangulation).

export type VertexKind = 'start' | 'end' | 'split' | 'merge' | 'regular'

export interface TriangulationTrace {
  /** One entry per sweep event, in processing order. */
  events: { vertex: number; kind: VertexKind; diagonals: [number, number][] }[]
}

export interface Triangulation {
  /** The polygon vertices, normalised to counter-clockwise order. */
  vertices: Point[]
  /** Triangles as indices into `vertices` (each counter-clockwise). */
  triangles: Triangle[]
  /** Diagonals added by the monotone-partition phase (index pairs). */
  monotoneDiagonals: [number, number][]
  /** The y-monotone pieces, each a ring of vertex indices (CCW). */
  monotonePieces: number[][]
  /** Per-vertex classification from the sweep. */
  kinds: VertexKind[]
  trace: TriangulationTrace
}

// A vertex `u` is swept before `v` when it is higher; ties break to the left.
// (Screen space has y growing downward, but the algorithm is orientation-pure —
// "higher" just means "swept earlier"; callers pass whatever frame they draw in
// and the result is consistent with it.)
function above(a: Point, b: Point): boolean {
  return a.y > b.y || (a.y === b.y && a.x < b.x)
}

/** x-coordinate where the directed edge (p→q) crosses the horizontal line y. */
function edgeXAtY(p: Point, q: Point, y: number): number {
  const dy = q.y - p.y
  if (Math.abs(dy) < 1e-12) return (p.x + q.x) / 2
  return p.x + ((q.x - p.x) * (y - p.y)) / dy
}

/**
 * Triangulate a simple polygon (no holes, no self-intersections). Returns the
 * triangles plus the intermediate monotone decomposition and vertex types so the
 * whole pipeline can be visualised.
 */
export function triangulatePolygon(poly: Point[]): Triangulation {
  const empty: Triangulation = {
    vertices: poly.slice(),
    triangles: [],
    monotoneDiagonals: [],
    monotonePieces: [],
    kinds: [],
    trace: { events: [] },
  }
  if (poly.length < 3) return empty

  // Normalise to CCW so vertex classification and chain orientation are fixed.
  const vertices = signedArea(poly) < 0 ? poly.slice().reverse() : poly.slice()
  const n = vertices.length
  const prev = (i: number) => (i + n - 1) % n
  const next = (i: number) => (i + 1) % n

  // ── Phase 1: vertex classification ────────────────────────────────────────
  const kinds: VertexKind[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const p = vertices[prev(i)]
    const v = vertices[i]
    const nx = vertices[next(i)]
    const bothBelow = above(v, p) && above(v, nx)
    const bothAbove = above(p, v) && above(nx, v)
    // Interior angle < π  ⟺  convex corner  ⟺  left turn on a CCW polygon.
    const convex = orient(p, v, nx) > 0
    if (bothBelow) kinds[i] = convex ? 'start' : 'split'
    else if (bothAbove) kinds[i] = convex ? 'end' : 'merge'
    else kinds[i] = 'regular'
  }

  // ── Phase 2: the sweep — add diagonals to kill split/merge vertices ───────
  const diagonals: [number, number][] = []
  const trace: TriangulationTrace = { events: [] }

  // Status structure: edge indices (edge i spans vertices[i]→vertices[next i]),
  // kept sorted left→right by their x at the current sweep line. Simple polygons
  // have non-crossing edges, so the order is stable while an edge is active and
  // a binary search resolves every "edge directly left of v" query in O(log n).
  const status: number[] = []
  const helper = new Map<number, number>()
  let sweepY = 0

  const insertEdge = (e: number) => {
    const x = edgeXAtY(vertices[e], vertices[next(e)], sweepY)
    let lo = 0
    let hi = status.length
    while (lo < hi) {
      const m = (lo + hi) >> 1
      const ex = edgeXAtY(vertices[status[m]], vertices[next(status[m])], sweepY)
      if (ex < x) lo = m + 1
      else hi = m
    }
    status.splice(lo, 0, e)
  }
  const removeEdge = (e: number) => {
    const idx = status.indexOf(e)
    if (idx >= 0) status.splice(idx, 1)
  }
  // The edge immediately to the left of vertex v (largest active edge with x<v.x).
  const edgeLeftOf = (vi: number): number => {
    const vx = vertices[vi].x
    let lo = 0
    let hi = status.length
    let ans = -1
    while (lo < hi) {
      const m = (lo + hi) >> 1
      const ex = edgeXAtY(vertices[status[m]], vertices[next(status[m])], sweepY)
      if (ex < vx) {
        ans = m
        lo = m + 1
      } else hi = m
    }
    return ans >= 0 ? status[ans] : -1
  }

  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) =>
    above(vertices[a], vertices[b]) ? -1 : 1,
  )

  const addDiag = (a: number, b: number, bucket: [number, number][]) => {
    diagonals.push([a, b])
    bucket.push([a, b])
  }

  for (const vi of order) {
    sweepY = vertices[vi].y
    const evDiag: [number, number][] = []
    const ei = vi // edge starting at vi (vi → next)
    const ep = prev(vi) // edge ending at vi (prev → vi)

    switch (kinds[vi]) {
      case 'start': {
        insertEdge(ei)
        helper.set(ei, vi)
        break
      }
      case 'end': {
        if (kinds[helper.get(ep)!] === 'merge') addDiag(vi, helper.get(ep)!, evDiag)
        removeEdge(ep)
        break
      }
      case 'split': {
        const ej = edgeLeftOf(vi)
        if (ej >= 0) {
          addDiag(vi, helper.get(ej)!, evDiag)
          helper.set(ej, vi)
        }
        insertEdge(ei)
        helper.set(ei, vi)
        break
      }
      case 'merge': {
        if (kinds[helper.get(ep)!] === 'merge') addDiag(vi, helper.get(ep)!, evDiag)
        removeEdge(ep)
        const ej = edgeLeftOf(vi)
        if (ej >= 0) {
          if (kinds[helper.get(ej)!] === 'merge') addDiag(vi, helper.get(ej)!, evDiag)
          helper.set(ej, vi)
        }
        break
      }
      case 'regular': {
        // Interior to the right ⟺ the boundary descends past v (prev above, next
        // below on a CCW polygon). Then v bounds a left edge (ep) we replace.
        const interiorRight = above(vertices[prev(vi)], vertices[vi])
        if (interiorRight) {
          if (kinds[helper.get(ep)!] === 'merge') addDiag(vi, helper.get(ep)!, evDiag)
          removeEdge(ep)
          insertEdge(ei)
          helper.set(ei, vi)
        } else {
          const ej = edgeLeftOf(vi)
          if (ej >= 0) {
            if (kinds[helper.get(ej)!] === 'merge') addDiag(vi, helper.get(ej)!, evDiag)
            helper.set(ej, vi)
          }
        }
        break
      }
    }
    trace.events.push({ vertex: vi, kind: kinds[vi], diagonals: evDiag })
  }

  // ── Extract the monotone faces from (polygon edges ∪ diagonals) ───────────
  const pieces = extractFaces(vertices, diagonals)

  // ── Phase 3: triangulate every monotone piece ─────────────────────────────
  const triangles: Triangle[] = []
  for (const piece of pieces) triangulateMonotone(vertices, piece, triangles)

  return {
    vertices,
    triangles,
    monotoneDiagonals: diagonals,
    monotonePieces: pieces,
    kinds,
    trace,
  }
}

// Rotation-system face traversal (the same idea boolean.ts uses): every diagonal
// becomes two opposite half-edges, every polygon edge one directed half-edge in
// CCW order. Following, at each vertex, the *next* half-edge clockwise around the
// arrival direction carves out the interior faces one at a time.
function extractFaces(vertices: Point[], diagonals: [number, number][]): number[][] {
  const n = vertices.length
  // Adjacency: outgoing directed half-edges from each vertex.
  const outgoing: number[][] = Array.from({ length: n }, () => [])
  const addHalf = (a: number, b: number) => outgoing[a].push(b)
  for (let i = 0; i < n; i++) addHalf(i, (i + 1) % n) // CCW boundary
  for (const [a, b] of diagonals) {
    addHalf(a, b)
    addHalf(b, a)
  }
  // Sort each vertex's outgoing neighbours by angle so we can pick the next edge.
  for (let v = 0; v < n; v++) {
    outgoing[v].sort(
      (p, q) =>
        Math.atan2(vertices[p].y - vertices[v].y, vertices[p].x - vertices[v].x) -
        Math.atan2(vertices[q].y - vertices[v].y, vertices[q].x - vertices[v].x),
    )
  }
  const angleOf = (from: number, to: number) =>
    Math.atan2(vertices[to].y - vertices[from].y, vertices[to].x - vertices[from].x)

  // Given we just arrived at `to` from `from`, the next half-edge around the face
  // (interior on the left) turns most clockwise from the reversed incoming
  // direction — the same rotation-system rule chainEdges() uses in boolean.ts.
  const nextHalf = (from: number, to: number): number => {
    const list = outgoing[to]
    const incoming = angleOf(to, from) // reversed direction (head → tail)
    let best = -1
    let bestTurn = Infinity
    for (const w of list) {
      let turn = incoming - angleOf(to, w)
      while (turn <= 1e-12) turn += Math.PI * 2
      while (turn > Math.PI * 2 + 1e-12) turn -= Math.PI * 2
      if (turn < bestTurn) {
        bestTurn = turn
        best = w
      }
    }
    return best
  }

  const visited = new Set<string>()
  const faces: number[][] = []
  const key = (a: number, b: number) => `${a}->${b}`
  for (let a = 0; a < n; a++) {
    for (const b of outgoing[a]) {
      if (visited.has(key(a, b))) continue
      const face: number[] = []
      let u = a
      let v = b
      let guard = 0
      while (!visited.has(key(u, v)) && guard++ < 4 * (n + diagonals.length) + 8) {
        visited.add(key(u, v))
        face.push(u)
        const w = nextHalf(u, v)
        u = v
        v = w
        if (v < 0) break
      }
      // Keep only interior faces (CCW, positive area). The outer face is CW.
      if (face.length >= 3) {
        const ring = face.map((i) => vertices[i])
        if (signedArea(ring) > 1e-12) faces.push(face)
      }
    }
  }
  return faces
}

// Linear-time triangulation of a single y-monotone polygon (indices into
// `vertices`, given CCW). Emits CCW triangles into `out`.
function triangulateMonotone(vertices: Point[], ring: number[], out: Triangle[]): void {
  const m = ring.length
  if (m < 3) return
  if (m === 3) {
    out.push(orderCCW(vertices, ring[0], ring[1], ring[2]))
    return
  }
  // Split the ring into its two chains at the top and bottom vertices, then merge
  // by descending y. `side[i]` is false on the chain reached by walking CCW
  // (next) from the top — the left chain on a CCW polygon — and true on the other.
  let topPos = 0
  let botPos = 0
  for (let i = 1; i < m; i++) {
    if (above(vertices[ring[i]], vertices[ring[topPos]])) topPos = i
    if (above(vertices[ring[botPos]], vertices[ring[i]])) botPos = i
  }
  const side = new Array<boolean>(m)
  side[topPos] = false
  side[botPos] = true
  for (let i = (topPos + 1) % m; i !== botPos; i = (i + 1) % m) side[i] = false // left chain
  for (let i = (botPos + 1) % m; i !== topPos; i = (i + 1) % m) side[i] = true // right chain

  const idx = Array.from({ length: m }, (_, i) => i).sort((a, b) =>
    above(vertices[ring[a]], vertices[ring[b]]) ? -1 : 1,
  )

  const stack: number[] = [idx[0], idx[1]]
  for (let j = 2; j < m - 1; j++) {
    const cur = idx[j]
    const top = stack[stack.length - 1]
    if (side[cur] !== side[top]) {
      // Opposite chains: connect cur to every stack vertex, popping all but keep
      // the last one and cur as the new stack.
      while (stack.length > 1) {
        const a = stack.pop()!
        const b = stack[stack.length - 1]
        emit(vertices, ring, cur, a, b, out)
      }
      stack.pop()
      stack.push(top, cur)
    } else {
      // Same chain: pop while the ear (cur, top-1, top) turns the right way.
      let last = stack.pop()!
      while (stack.length > 0) {
        const t = stack[stack.length - 1]
        const o = orient(vertices[ring[cur]], vertices[ring[last]], vertices[ring[t]])
        // Left chain (side=false) needs a right turn (CW, o<0); right chain a left turn.
        const convex = side[cur] ? o > 0 : o < 0
        if (!convex) break
        emit(vertices, ring, cur, last, t, out)
        last = stack.pop()!
      }
      stack.push(last, cur)
    }
  }
  // The bottom vertex closes triangles against every remaining stack edge.
  const cur = idx[m - 1]
  for (let s = 0; s < stack.length - 1; s++) {
    emit(vertices, ring, cur, stack[s], stack[s + 1], out)
  }
}

function emit(
  vertices: Point[],
  ring: number[],
  a: number,
  b: number,
  c: number,
  out: Triangle[],
): void {
  out.push(orderCCW(vertices, ring[a], ring[b], ring[c]))
}

function orderCCW(vertices: Point[], a: number, b: number, c: number): Triangle {
  return orient(vertices[a], vertices[b], vertices[c]) >= 0
    ? { a, b, c }
    : { a, b: c, c: b }
}
