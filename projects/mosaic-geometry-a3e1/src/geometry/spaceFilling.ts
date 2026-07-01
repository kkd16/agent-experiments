import type { Point, Rect } from './types'
import { dist } from './vector'

// Space-filling curves: a continuous path that visits every cell of a 2^order ×
// 2^order grid exactly once, giving a *linear order* on the plane. Two classics
// live here, both from scratch:
//
//   • Morton (Z-order) — interleave the bits of (x, y). Trivial to compute and the
//     backbone of quadtrees/geohashes, but its "Z" jumps make it leak locality: two
//     cells adjacent on the curve can be far apart in the plane (and vice-versa).
//   • Hilbert — a recursively rotated "U" that never jumps: consecutive indices are
//     always grid-neighbours, so nearby indices stay nearby in space. The gold
//     standard when locality matters (spatial databases, cache-oblivious layouts).
//
// The curve turns 2-D proximity into 1-D proximity: sort points by their curve
// index and you get a cache-friendly traversal whose consecutive hops are short.
// The `tourLength` metric makes the Hilbert-beats-Morton locality gap measurable.
//
// All arithmetic is integer bit-twiddling on a grid of side 2^order; `order` is
// capped at 15 so a Morton code (2·order bits) stays inside a 32-bit word.

export type CurveKind = 'morton' | 'hilbert'

export const MAX_ORDER = 15

// ── Morton (Z-order): bit interleave / de-interleave ─────────────────────────

/** Interleave the low `order` bits of x and y (x → even bits, y → odd bits). */
export function mortonEncode(x: number, y: number, order: number): number {
  let d = 0
  for (let i = 0; i < order; i++) {
    d |= ((x >> i) & 1) << (2 * i)
    d |= ((y >> i) & 1) << (2 * i + 1)
  }
  return d >>> 0
}

/** Inverse of {@link mortonEncode}: split an interleaved code back into (x, y). */
export function mortonDecode(d: number, order: number): [number, number] {
  let x = 0
  let y = 0
  for (let i = 0; i < order; i++) {
    x |= ((d >> (2 * i)) & 1) << i
    y |= ((d >> (2 * i + 1)) & 1) << i
  }
  return [x, y]
}

// ── Hilbert curve: the rotation trick (Wikipedia's xy2d / d2xy) ──────────────

/** Rotate/flip a quadrant so the four sub-curves stitch into one continuous path. */
function hilbertRot(n: number, x: number, y: number, rx: number, ry: number): [number, number] {
  if (ry === 0) {
    if (rx === 1) {
      x = n - 1 - x
      y = n - 1 - y
    }
    return [y, x] // transpose
  }
  return [x, y]
}

/** Map grid cell (x, y) to its Hilbert distance along the order-`order` curve. */
export function hilbertEncode(x: number, y: number, order: number): number {
  const n = 1 << order
  let rx: number
  let ry: number
  let d = 0
  for (let s = n >> 1; s > 0; s >>= 1) {
    rx = (x & s) > 0 ? 1 : 0
    ry = (y & s) > 0 ? 1 : 0
    d += s * s * ((3 * rx) ^ ry)
    ;[x, y] = hilbertRot(n, x, y, rx, ry)
  }
  return d
}

/** Inverse of {@link hilbertEncode}: the cell at Hilbert distance `d`. */
export function hilbertDecode(d: number, order: number): [number, number] {
  const n = 1 << order
  let rx: number
  let ry: number
  let t = d
  let x = 0
  let y = 0
  for (let s = 1; s < n; s <<= 1) {
    rx = 1 & (t >> 1)
    ry = 1 & (t ^ rx)
    ;[x, y] = hilbertRot(s, x, y, rx, ry)
    x += s * rx
    y += s * ry
    t >>= 2
  }
  return [x, y]
}

/** The curve index of a grid cell for either family. */
export function curveIndex(kind: CurveKind, x: number, y: number, order: number): number {
  return kind === 'hilbert' ? hilbertEncode(x, y, order) : mortonEncode(x, y, order)
}

// ── Mapping continuous points onto the grid ──────────────────────────────────

/** Quantize a world point into a grid cell of the 2^order lattice over `frame`. */
export function gridCoords(p: Point, frame: Rect, order: number): [number, number] {
  const side = 1 << order
  const w = frame.maxX - frame.minX || 1
  const h = frame.maxY - frame.minY || 1
  const gx = Math.min(side - 1, Math.max(0, Math.floor(((p.x - frame.minX) / w) * side)))
  const gy = Math.min(side - 1, Math.max(0, Math.floor(((p.y - frame.minY) / h) * side)))
  return [gx, gy]
}

/** Center of grid cell (gx, gy) back in world coordinates. */
export function cellCenter(gx: number, gy: number, frame: Rect, order: number): Point {
  const side = 1 << order
  const w = frame.maxX - frame.minX || 1
  const h = frame.maxY - frame.minY || 1
  return {
    x: frame.minX + ((gx + 0.5) / side) * w,
    y: frame.minY + ((gy + 0.5) / side) * h,
  }
}

export interface CurveOrdering {
  kind: CurveKind
  order: number // grid resolution exponent used
  visit: number[] // point indices in curve-visiting order
  code: number[] // curve index per point (parallel to the input points)
}

/** Sort points along the chosen curve. Ties (two points in one cell) keep their
 *  original relative order — a stable sort — so the ordering is deterministic. */
export function curveOrder(
  points: Point[],
  frame: Rect,
  order: number,
  kind: CurveKind,
): CurveOrdering {
  const o = Math.max(1, Math.min(MAX_ORDER, Math.floor(order)))
  const code = points.map((p) => {
    const [gx, gy] = gridCoords(p, frame, o)
    return curveIndex(kind, gx, gy, o)
  })
  const visit = points.map((_, i) => i)
  visit.sort((a, b) => code[a] - code[b] || a - b)
  return { kind, order: o, visit, code }
}

/** The tour: the input points reordered along the curve (a polyline to draw). */
export function tourPolyline(points: Point[], ordering: CurveOrdering): Point[] {
  return ordering.visit.map((i) => points[i])
}

/** Total Euclidean length of the tour — the locality metric. Shorter ⇒ the curve
 *  kept spatially-near points near in the ordering; Hilbert reliably beats Morton. */
export function tourLength(points: Point[], ordering: CurveOrdering): number {
  let total = 0
  for (let i = 1; i < ordering.visit.length; i++) {
    total += dist(points[ordering.visit[i - 1]], points[ordering.visit[i]])
  }
  return total
}

/** The full space-filling curve as a polyline through every cell center. Capped
 *  at `maxCells` cells so a high order can't blow up rendering. */
export function curvePath(kind: CurveKind, order: number, frame: Rect, maxCells = 1 << 14): Point[] {
  const o = Math.max(1, Math.min(MAX_ORDER, Math.floor(order)))
  const cells = 1 << (2 * o)
  if (cells > maxCells) return []
  const out: Point[] = new Array(cells)
  for (let d = 0; d < cells; d++) {
    const [gx, gy] = kind === 'hilbert' ? hilbertDecode(d, o) : mortonDecode(d, o)
    out[d] = cellCenter(gx, gy, frame, o)
  }
  return out
}

export interface CurveFrameStep {
  kind: CurveKind
  order: number
  path: Point[]
  note: string
}

/** Refinement frames (order 1, 2, …, maxOrder) for the Algorithms visualizer:
 *  the curve growing more detailed as the grid subdivides. */
export function curveFrames(kind: CurveKind, maxOrder: number, frame: Rect): CurveFrameStep[] {
  const top = Math.max(1, Math.min(7, Math.floor(maxOrder)))
  const steps: CurveFrameStep[] = []
  for (let o = 1; o <= top; o++) {
    const side = 1 << o
    steps.push({
      kind,
      order: o,
      path: curvePath(kind, o, frame),
      note: `Order ${o}: the ${kind === 'hilbert' ? 'Hilbert' : 'Z-order'} curve threads all ${side}×${side} = ${side * side} cells in a single ${
        kind === 'hilbert' ? 'jump-free pass' : 'Z pattern'
      }.`,
    })
  }
  return steps
}
