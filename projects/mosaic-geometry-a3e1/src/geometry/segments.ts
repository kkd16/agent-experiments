import type { Point } from './types'

// ── Bentley–Ottmann sweep-line segment intersection ─────────────────────────
//
// Reports every intersection among n line segments in O((n + k) log n) for k
// crossings — the optimal output-sensitive bound, versus the O(n²) brute-force
// all-pairs test. A vertical sweep line moves left to right through three kinds
// of event: a segment's left endpoint (insert it into the sweep-line *status*,
// the segments ordered by height where they cross the line), its right endpoint
// (remove it), and a crossing (swap the two segments' order). Only *adjacent*
// segments in the status can cross next, so each event only re-tests a constant
// number of neighbour pairs — that's where the speed-up comes from.
//
// A full step trace (the sweep-line position, the status order, and each
// crossing as it pops) is recorded for the Algorithms visualizer.

export interface Segment {
  a: Point
  b: Point
}

export interface Intersection {
  point: Point
  i: number // index of one segment
  j: number // index of the other
}

type EventKind = 'left' | 'right' | 'cross'

interface Event {
  x: number
  y: number
  kind: EventKind
  seg: number // for left/right
  segB: number // for cross (the other segment)
  point?: Point
}

export interface SweepStep {
  x: number
  status: number[] // segment indices, bottom → top, at this sweep position
  kind: EventKind
  found: Point | null
}

// ── A binary min-heap of events, ordered by x then y then kind ──────────────
const kindRank: Record<EventKind, number> = { left: 0, cross: 1, right: 2 }

function eventLess(a: Event, b: Event): boolean {
  if (a.x !== b.x) return a.x < b.x
  if (a.y !== b.y) return a.y < b.y
  return kindRank[a.kind] < kindRank[b.kind]
}

class EventHeap {
  private h: Event[] = []
  get size() {
    return this.h.length
  }
  push(e: Event) {
    const h = this.h
    h.push(e)
    let i = h.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (eventLess(h[i], h[p])) {
        ;[h[i], h[p]] = [h[p], h[i]]
        i = p
      } else break
    }
  }
  pop(): Event | undefined {
    const h = this.h
    if (h.length === 0) return undefined
    const top = h[0]
    const last = h.pop() as Event
    if (h.length > 0) {
      h[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = 2 * i + 2
        let s = i
        if (l < h.length && eventLess(h[l], h[s])) s = l
        if (r < h.length && eventLess(h[r], h[s])) s = r
        if (s === i) break
        ;[h[i], h[s]] = [h[s], h[i]]
        i = s
      }
    }
    return top
  }
}

const EPS = 1e-9

/** y-coordinate where segment s crosses the vertical line x = X (clamped). */
function yAt(seg: Segment, X: number): number {
  const dx = seg.b.x - seg.a.x
  if (Math.abs(dx) < EPS) return seg.a.y // vertical: use lower endpoint
  const t = (X - seg.a.x) / dx
  return seg.a.y + t * (seg.b.y - seg.a.y)
}

/** Proper/improper crossing of two closed segments; null if they don't meet. */
function intersect(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
  const r = { x: p2.x - p1.x, y: p2.y - p1.y }
  const s = { x: p4.x - p3.x, y: p4.y - p3.y }
  const rxs = r.x * s.y - r.y * s.x
  if (Math.abs(rxs) < 1e-14) return null // parallel (overlaps ignored here)
  const qp = { x: p3.x - p1.x, y: p3.y - p1.y }
  const t = (qp.x * s.y - qp.y * s.x) / rxs
  const u = (qp.x * r.y - qp.y * r.x) / rxs
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null
  return { x: p1.x + t * r.x, y: p1.y + t * r.y }
}

interface Prepared {
  a: Point
  b: Point
  orig: number
}

/**
 * Report all pairwise intersections among `segments` via Bentley–Ottmann.
 * Returns the crossings and (optionally) the sweep step trace.
 */
export function bentleyOttmann(
  segments: Segment[],
  trace = false,
): { intersections: Intersection[]; steps: SweepStep[] } {
  // Normalise: left endpoint first (smaller x, ties smaller y).
  const segs: Prepared[] = segments.map((s, i) => {
    const left = s.a.x < s.b.x || (s.a.x === s.b.x && s.a.y <= s.b.y)
    return { a: left ? s.a : s.b, b: left ? s.b : s.a, orig: i }
  })

  const queue = new EventHeap()
  for (let i = 0; i < segs.length; i++) {
    queue.push({ x: segs[i].a.x, y: segs[i].a.y, kind: 'left', seg: i, segB: -1 })
    queue.push({ x: segs[i].b.x, y: segs[i].b.y, kind: 'right', seg: i, segB: -1 })
  }

  // Status: segment indices ordered by y at the sweep line, bottom → top.
  const status: number[] = []
  const found: Intersection[] = []
  const reportedPairs = new Set<number>()
  const scheduled = new Set<number>()
  const steps: SweepStep[] = []
  const n = segs.length
  const SORT_EPS = 1e-7

  // Slope of a segment (verticals get +∞ so they sort to one side consistently).
  const slope = (i: number) => {
    const d = segs[i].b.x - segs[i].a.x
    return Math.abs(d) < EPS ? Infinity : (segs[i].b.y - segs[i].a.y) / d
  }

  // Schedule the crossing of segments i and j (if any) that lies at/right of X.
  // A per-pair `scheduled` guard keeps the event queue from blowing up.
  const tryCross = (i: number, j: number, X: number) => {
    if (i < 0 || j < 0) return
    const pairId = i < j ? i * n + j : j * n + i
    if (scheduled.has(pairId)) return
    const p = intersect(segs[i].a, segs[i].b, segs[j].a, segs[j].b)
    if (!p || p.x < X - EPS) return
    scheduled.add(pairId)
    queue.push({ x: p.x, y: p.y, kind: 'cross', seg: i, segB: j, point: p })
  }

  const snapshot = (X: number, kind: EventKind, pt: Point | null) => {
    if (trace) steps.push({ x: X, status: status.slice(), kind, found: pt })
  }

  let guard = 0
  const guardMax = (n * n + n) * 8 + 2000
  while (queue.size > 0 && guard++ < guardMax) {
    const ev = queue.pop() as Event
    const X = ev.x

    let reported: Point | null = null
    if (ev.kind === 'left') {
      status.push(ev.seg)
    } else if (ev.kind === 'right') {
      const pos = status.indexOf(ev.seg)
      if (pos >= 0) status.splice(pos, 1)
    } else {
      // A crossing: report it once (dedup on the unordered segment pair).
      const pairId = ev.seg < ev.segB ? ev.seg * n + ev.segB : ev.segB * n + ev.seg
      if (!reportedPairs.has(pairId)) {
        reportedPairs.add(pairId)
        found.push({ point: ev.point as Point, i: segs[ev.seg].orig, j: segs[ev.segB].orig })
        reported = ev.point as Point
      }
    }

    // Re-sort the status exactly, evaluated a hair right of the event so the
    // post-event vertical order holds even where segments cross at X. Then every
    // freshly-adjacent pair is (re)tested — this corrects any numerical drift and
    // guarantees each true crossing is scheduled when its pair becomes adjacent.
    const xs = X + SORT_EPS
    status.sort((i, j) => {
      const dy = yAt(segs[i], xs) - yAt(segs[j], xs)
      if (Math.abs(dy) > 1e-12) return dy
      return slope(i) - slope(j)
    })
    for (let k = 0; k + 1 < status.length; k++) tryCross(status[k], status[k + 1], X)
    snapshot(X, ev.kind, reported)
  }

  return { intersections: found, steps }
}

/**
 * Robust intersection reporting for *arbitrary* input (verticals, axis-aligned
 * grids, shared x-coordinates and all). A rigid rotation commutes exactly with
 * line intersection, so we rotate the whole scene into general position, run the
 * sweep, and rotate the crossing points back — sidestepping the vertical-segment
 * and coincident-abscissa special cases without changing a single true crossing.
 */
export function reportIntersections(segments: Segment[]): Intersection[] {
  const c = Math.cos(0.3)
  const s = Math.sin(0.3)
  const rot = (p: Point): Point => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c })
  const inv = (p: Point): Point => ({ x: p.x * c + p.y * s, y: -p.x * s + p.y * c })
  const rotated = segments.map((seg) => ({ a: rot(seg.a), b: rot(seg.b) }))
  const { intersections } = bentleyOttmann(rotated)
  return intersections.map((it) => ({ point: inv(it.point), i: it.i, j: it.j }))
}

/** O(n²) reference: all pairwise proper/improper crossings. */
export function bruteForceIntersections(segments: Segment[]): Intersection[] {
  const out: Intersection[] = []
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const p = intersect(segments[i].a, segments[i].b, segments[j].a, segments[j].b)
      if (p) out.push({ point: p, i, j })
    }
  }
  return out
}
