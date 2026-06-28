import type { Edge, Point } from './types'
import { circumcenter, orient } from './predicates'
import { dist } from './vector'

// Fortune's sweep-line algorithm — the elegant alternative to incremental
// Bowyer-Watson. A horizontal line sweeps top-to-bottom; behind it the "beach
// line" is the lower envelope of the parabolas equidistant from each processed
// site and the line. Two kinds of events drive it:
//
//   • a SITE event (the line reaches a new site) splits the arc above it in two,
//     starting a fresh pair of Voronoi half-edges;
//   • a CIRCLE event (three consecutive arcs pinch a middle arc to nothing)
//     removes that arc and emits a Voronoi vertex — the circumcenter of the
//     three sites' triangle, i.e. a Delaunay triangle is finalized.
//
// Events live in a binary heap (O(log n) each); the beach line is a flat list of
// arcs, so locating the arc above a new site is linear in its length. The dual of
// every Voronoi edge is a Delaunay edge, so the same run yields the Delaunay
// triangulation — we verify it matches Bowyer-Watson edge-for-edge.

interface Arc {
  site: number
  event: CircleEvent | null // the circle event currently scheduled to kill this arc
}

interface SiteEvent {
  kind: 'site'
  y: number
  site: number
}

interface CircleEvent {
  kind: 'circle'
  y: number // sweep position at which the event fires (bottom of the circle)
  center: Point // the Voronoi vertex (circumcenter of the three foci)
  arc: Arc // the middle arc that vanishes
  valid: boolean
}

type Event = SiteEvent | CircleEvent

// ── A small binary max-heap keyed on event.y (process highest y first) ───────
class EventHeap {
  private items: Event[] = []
  get size(): number {
    return this.items.length
  }
  push(e: Event): void {
    const a = this.items
    a.push(e)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p].y >= a[i].y) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
  }
  pop(): Event | undefined {
    const a = this.items
    if (a.length === 0) return undefined
    const top = a[0]
    const last = a.pop() as Event
    if (a.length > 0) {
      a[0] = last
      let i = 0
      const n = a.length
      for (;;) {
        const l = 2 * i + 1
        const r = 2 * i + 2
        let m = i
        if (l < n && a[l].y > a[m].y) m = l
        if (r < n && a[r].y > a[m].y) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]
        i = m
      }
    }
    return top
  }
}

/**
 * x-coordinate of the breakpoint between the arc with focus `left` and the arc
 * with focus `right`, when the sweep line is at `ly`. The two parabolas meet at
 * two points; we return the one that has `left` as the lower arc immediately to
 * its left (the actual beach-line breakpoint for that ordering).
 */
export function breakpointX(left: Point, right: Point, ly: number): number {
  const dl = left.y - ly
  const dr = right.y - ly
  // A site exactly on the sweep line is a degenerate vertical arc.
  if (Math.abs(dl) < 1e-12) return left.x
  if (Math.abs(dr) < 1e-12) return right.x
  // Quadratic a·x² + b·x + c = 0 whose sign matches y_left(x) − y_right(x).
  const a = dr - dl
  const b = 2 * (right.x * dl - left.x * dr)
  const c = dr * left.x * left.x - dl * right.x * right.x + (left.y - right.y) * dl * dr
  if (Math.abs(a) < 1e-12) return -c / b // parabolas of equal height — linear
  const disc = Math.max(0, b * b - 4 * a * c)
  const sq = Math.sqrt(disc)
  const x1 = (-b - sq) / (2 * a)
  const x2 = (-b + sq) / (2 * a)
  const lo = Math.min(x1, x2)
  const hi = Math.max(x1, x2)
  // a>0 ⇒ y_left − y_right opens upward ⇒ left is the lower arc to the right of
  // the larger root; a<0 ⇒ left is lower to the right of the smaller root.
  return a > 0 ? hi : lo
}

/** Evaluate the parabola of focus `f` with directrix y=ly at x. */
export function parabolaY(f: Point, ly: number, x: number): number {
  const d = f.y - ly
  if (Math.abs(d) < 1e-12) return f.y
  return ((x - f.x) * (x - f.x)) / (2 * d) + (f.y + ly) / 2
}

/**
 * The x-intervals each beach-line arc spans, for a given sweep position. Used by
 * the visualizer to draw each parabolic arc only over the stretch where it is the
 * lowest. Intervals are clamped to [x0, x1].
 */
export function beachIntervals(
  sites: Point[],
  arcSites: number[],
  ly: number,
  x0: number,
  x1: number,
): { site: number; lo: number; hi: number }[] {
  const out: { site: number; lo: number; hi: number }[] = []
  for (let i = 0; i < arcSites.length; i++) {
    const lo = i === 0 ? x0 : clamp(breakpointX(sites[arcSites[i - 1]], sites[arcSites[i]], ly), x0, x1)
    const hi =
      i === arcSites.length - 1
        ? x1
        : clamp(breakpointX(sites[arcSites[i]], sites[arcSites[i + 1]], ly), x0, x1)
    out.push({ site: arcSites[i], lo, hi })
  }
  return out
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export interface FortuneSnapshot {
  sweepY: number
  arcSites: number[] // foci of the beach-line arcs, left to right
  vertices: Point[] // Voronoi vertices discovered so far
  circles: { x: number; y: number; r: number }[] // pending circle events (their circumcircles)
  kind: 'site' | 'circle' | 'start' | 'end'
  active: number // site involved in this event (-1 when none)
  note: string
}

export interface FortuneResult {
  vertices: Point[]
  delaunayEdges: Edge[]
  steps: FortuneSnapshot[]
}

const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`)

/**
 * Run Fortune's algorithm. Returns the Voronoi vertices, the dual Delaunay edge
 * set, and (when `trace`) a per-event snapshot list for the animation. The
 * geometry core (vertices, edges) is exact; the trace is purely for display.
 */
export function fortune(input: Point[], trace = false): FortuneResult {
  const n = input.length
  const vertices: Point[] = []
  const delaunay = new Set<string>()
  const steps: FortuneSnapshot[] = []
  if (n < 2) return { vertices, delaunayEdges: [], steps }

  const sites = input
  const arcs: Arc[] = []
  const heap = new EventHeap()
  for (let i = 0; i < n; i++) heap.push({ kind: 'site', y: sites[i].y, site: i })

  const arcSites = () => arcs.map((a) => a.site)
  const pendingCircles = (): { x: number; y: number; r: number }[] => {
    const seen = new Set<CircleEvent>()
    const out: { x: number; y: number; r: number }[] = []
    for (const a of arcs) {
      if (a.event && a.event.valid && !seen.has(a.event)) {
        seen.add(a.event)
        out.push({ x: a.event.center.x, y: a.event.center.y, r: a.event.center.y - a.event.y })
      }
    }
    return out
  }
  const snap = (sweepY: number, kind: FortuneSnapshot['kind'], active: number, note: string) => {
    if (!trace) return
    steps.push({
      sweepY,
      arcSites: arcSites(),
      vertices: vertices.map((v) => ({ ...v })),
      circles: pendingCircles(),
      kind,
      active,
      note,
    })
  }

  // Schedule the circle event for the arc at index i (if its neighbours pinch it).
  const checkCircle = (i: number, sweepY: number) => {
    if (i <= 0 || i >= arcs.length - 1) return
    const a = sites[arcs[i - 1].site]
    const b = sites[arcs[i].site]
    const c = sites[arcs[i + 1].site]
    if (arcs[i - 1].site === arcs[i + 1].site) return
    // Breakpoints converge only when the triple turns clockwise (y-up frame).
    if (orient(a, b, c) >= 0) return
    const center = circumcenter(a, b, c)
    if (!center) return
    const r = dist(center, b)
    const ey = center.y - r // bottom of the circumcircle
    if (ey > sweepY + 1e-9) return // event would be in the past
    const ev: CircleEvent = { kind: 'circle', y: ey, center, arc: arcs[i], valid: true }
    arcs[i].event = ev
    heap.push(ev)
  }

  const invalidate = (arc: Arc | undefined) => {
    if (arc && arc.event) {
      arc.event.valid = false
      arc.event = null
    }
  }

  snap(sites[heap.size ? 0 : 0]?.y ?? 0, 'start', -1, 'Sweep starts above the topmost site; the beach line is empty.')

  while (heap.size > 0) {
    const e = heap.pop() as Event
    if (e.kind === 'site') {
      handleSite(e.site, e.y)
    } else if (e.valid) {
      handleCircle(e)
    }
  }

  // Final cleanup snapshot.
  snap(-Infinity, 'end', -1, 'Sweep complete: every circle event has emitted its Voronoi vertex.')

  return { vertices, delaunayEdges: [...delaunay].map(keyToEdge), steps }

  function handleSite(s: number, y: number): void {
    if (arcs.length === 0) {
      arcs.push({ site: s, event: null })
      snap(y, 'site', s, `Site ${s}: the first arc — a single parabola spans the whole line.`)
      return
    }
    // Find the arc directly above the new site's x at sweep height y.
    const px = sites[s].x
    let i = 0
    for (; i < arcs.length; i++) {
      const lo = i === 0 ? -Infinity : breakpointX(sites[arcs[i - 1].site], sites[arcs[i].site], y)
      const hi =
        i === arcs.length - 1 ? Infinity : breakpointX(sites[arcs[i].site], sites[arcs[i + 1].site], y)
      if (px >= lo - 1e-9 && px <= hi + 1e-9) break
    }
    if (i >= arcs.length) i = arcs.length - 1
    const a = arcs[i].site
    invalidate(arcs[i])
    // Split arc `a` into [a, s, a]; the new site spawns a Voronoi edge with a.
    arcs.splice(i, 1, { site: a, event: null }, { site: s, event: null }, { site: a, event: null })
    delaunay.add(edgeKey(a, s))
    checkCircle(i, y) // left copy of a
    checkCircle(i + 2, y) // right copy of a
    snap(y, 'site', s, `Site ${s} arrives: split the arc of site ${a} and open a new Voronoi edge.`)
  }

  function handleCircle(e: CircleEvent): void {
    const j = arcs.indexOf(e.arc)
    if (j < 0) return
    const left = arcs[j - 1]
    const right = arcs[j + 1]
    vertices.push({ ...e.center })
    if (left && right) delaunay.add(edgeKey(left.site, right.site))
    invalidate(left)
    invalidate(right)
    arcs.splice(j, 1)
    // The merged breakpoint can now spawn new circle events on either side.
    checkCircle(j - 1, e.y)
    checkCircle(j, e.y)
    snap(e.y, 'circle', left ? left.site : -1, `Circle event: an arc vanishes, fixing a Voronoi vertex (a Delaunay triangle closes).`)
  }
}

function keyToEdge(k: string): Edge {
  const [a, b] = k.split('_').map(Number)
  return { a, b }
}
