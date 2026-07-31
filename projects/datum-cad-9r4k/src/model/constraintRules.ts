import type { Sketch } from './sketch'
import type { Constraint, ConstraintKind, Entity, EntityId } from './types'
import { cubicLength } from '../solver/curve'

export type ValueKind = 'distance' | 'angle' | 'radius' | 'diameter' | 'length' | null

export type ConstraintOption = {
  kind: ConstraintKind
  label: string
  symbol: string
  value: ValueKind
  // Ordered entity ids for the constraint, and a default numeric value.
  entities: EntityId[]
  defaultValue?: number
}

function kinds(
  sketch: Sketch,
  sel: EntityId[],
): { points: EntityId[]; lines: EntityId[]; circular: EntityId[]; splines: EntityId[]; all: Entity[] } {
  const all = sel.map((id) => sketch.get(id)).filter((e): e is Entity => !!e)
  return {
    points: all.filter((e) => e.kind === 'point').map((e) => e.id),
    lines: all.filter((e) => e.kind === 'line').map((e) => e.id),
    // Circles and arcs are interchangeable for every radius/tangent/concentric
    // relation — both carry a (center, radius) pair — so they are pooled here.
    circular: all.filter((e) => e.kind === 'circle' || e.kind === 'arc').map((e) => e.id),
    splines: all.filter((e) => e.kind === 'spline').map((e) => e.id),
    all,
  }
}

// The spline endpoint (p0 or p1) whose position is closest to any of the given
// world points — used to decide which end a tangency acts on when the user selects
// a spline together with a line or circle. Returns a stable point id, stored in the
// constraint so the choice never changes afterwards.
function nearestSplineEnd(sketch: Sketch, splineId: EntityId, targets: [number, number][]): EntityId {
  const s = sketch.spline(splineId)
  let best = s.p0
  let bestD = Infinity
  for (const end of [s.p0, s.p1]) {
    const p = sketch.point(end)
    for (const t of targets) {
      const d = Math.hypot(p.x - t[0], p.y - t[1])
      if (d < bestD) {
        bestD = d
        best = end
      }
    }
  }
  return best
}

// The point id shared as an endpoint of both splines, if any — the join at which a
// G1 (smooth-tangent) continuity constraint is meaningful.
function sharedSplineEndpoint(sketch: Sketch, a: EntityId, b: EntityId): EntityId | null {
  const sa = sketch.spline(a)
  const sb = sketch.spline(b)
  const ends = new Set([sb.p0, sb.p1])
  for (const e of [sa.p0, sa.p1]) if (ends.has(e)) return e
  return null
}

// Every constraint currently applicable to the selection, in menu order.
export function applicableConstraints(sketch: Sketch, sel: EntityId[]): ConstraintOption[] {
  const { points, lines, circular, splines, all } = kinds(sketch, sel)
  const out: ConstraintOption[] = []
  const only = (np: number, nl: number, nc: number, ns = 0) =>
    points.length === np &&
    lines.length === nl &&
    circular.length === nc &&
    splines.length === ns &&
    all.length === np + nl + nc + ns

  if (only(2, 0, 0)) {
    const a = sketch.point(points[0])
    const b = sketch.point(points[1])
    const d = Math.hypot(a.x - b.x, a.y - b.y)
    out.push({ kind: 'coincident', label: 'Coincident', symbol: '•', value: null, entities: [...points] })
    out.push({ kind: 'distance', label: 'Distance', symbol: '↔', value: 'distance', entities: [...points], defaultValue: d })
  }
  if (only(0, 1, 0)) {
    out.push({ kind: 'horizontal', label: 'Horizontal', symbol: 'H', value: null, entities: [...lines] })
    out.push({ kind: 'vertical', label: 'Vertical', symbol: 'V', value: null, entities: [...lines] })
  }
  if (only(0, 2, 0)) {
    const d0 = sketch.lineDir(sketch.line(lines[0]))
    const d1 = sketch.lineDir(sketch.line(lines[1]))
    const ang = (Math.atan2(d0.dx * d1.dy - d0.dy * d1.dx, d0.dx * d1.dx + d0.dy * d1.dy) * 180) / Math.PI
    out.push({ kind: 'parallel', label: 'Parallel', symbol: '∥', value: null, entities: [...lines] })
    out.push({ kind: 'perpendicular', label: 'Perpendicular', symbol: '⟂', value: null, entities: [...lines] })
    out.push({ kind: 'equalLength', label: 'Equal Length', symbol: '=', value: null, entities: [...lines] })
    out.push({ kind: 'colinear', label: 'Colinear', symbol: '≡', value: null, entities: [...lines] })
    out.push({ kind: 'angle', label: 'Angle', symbol: '∠', value: 'angle', entities: [...lines], defaultValue: Math.round(ang) })
  }
  if (only(1, 1, 0)) {
    out.push({ kind: 'pointOnLine', label: 'Point on Line', symbol: '—', value: null, entities: [points[0], lines[0]] })
    out.push({ kind: 'midpoint', label: 'Midpoint', symbol: 'M', value: null, entities: [points[0], lines[0]] })
  }
  if (only(1, 0, 1)) {
    const label = sketch.get(circular[0])?.kind === 'arc' ? 'Point on Arc' : 'Point on Circle'
    out.push({ kind: 'pointOnCircle', label, symbol: '○', value: null, entities: [points[0], circular[0]] })
  }
  // A point + a spline → the point rides the curve at a solved parameter (unless the
  // point is one of the spline's own control points, which would be degenerate).
  if (only(1, 0, 0, 1)) {
    const s = sketch.spline(splines[0])
    const isControl = points[0] === s.p0 || points[0] === s.c0 || points[0] === s.c1 || points[0] === s.p1
    if (!isControl)
      out.push({ kind: 'pointOnSpline', label: 'Point on Spline', symbol: '∿', value: null, entities: [points[0], splines[0]] })
  }
  if (only(2, 1, 0)) {
    out.push({ kind: 'symmetric', label: 'Symmetric', symbol: '⇄', value: null, entities: [points[0], points[1], lines[0]] })
  }
  if (only(0, 1, 1)) {
    out.push({ kind: 'tangentLineCircle', label: 'Tangent', symbol: 'T', value: null, entities: [lines[0], circular[0]] })
  }
  if (only(0, 0, 1)) {
    const r = sketch.radiusOf(circular[0])
    out.push({ kind: 'radius', label: 'Radius', symbol: 'R', value: 'radius', entities: [...circular], defaultValue: r })
    out.push({ kind: 'diameter', label: 'Diameter', symbol: '⌀', value: 'diameter', entities: [...circular], defaultValue: r * 2 })
  }
  if (only(0, 0, 2)) {
    out.push({ kind: 'equalRadius', label: 'Equal Radius', symbol: '=', value: null, entities: [...circular] })
    out.push({ kind: 'tangentCircles', label: 'Tangent', symbol: 'T', value: null, entities: [...circular] })
    out.push({ kind: 'concentric', label: 'Concentric', symbol: '◎', value: null, entities: [...circular] })
  }
  // Spline tangency: the endpoint the constraint acts on is stored first (a point),
  // so the choice is fixed and the on-canvas glyph anchors at the join.
  if (only(0, 1, 0, 1)) {
    const l = sketch.line(lines[0])
    const a = sketch.point(l.p1)
    const b = sketch.point(l.p2)
    const end = nearestSplineEnd(sketch, splines[0], [
      [a.x, a.y],
      [b.x, b.y],
    ])
    out.push({ kind: 'splineTangentLine', label: 'Tangent to Line', symbol: '⌒', value: null, entities: [end, splines[0], lines[0]] })
  }
  if (only(0, 0, 1, 1)) {
    const circ = sketch.circleLike(circular[0])
    const ctr = sketch.point(circ.c)
    const end = nearestSplineEnd(sketch, splines[0], [[ctr.x, ctr.y]])
    out.push({ kind: 'splineTangentArc', label: 'Tangent to Arc', symbol: '⌒', value: null, entities: [end, splines[0], circular[0]] })
  }
  // A single spline → dimension its true arc length.
  if (only(0, 0, 0, 1)) {
    const s = sketch.spline(splines[0])
    const p = (id: EntityId): [number, number] => {
      const q = sketch.point(id)
      return [q.x, q.y]
    }
    const len = cubicLength(p(s.p0), p(s.c0), p(s.c1), p(s.p1))
    out.push({ kind: 'splineLength', label: 'Length', symbol: 'L', value: 'length', entities: [splines[0]], defaultValue: Math.round(len) })
  }
  if (only(0, 0, 0, 2)) {
    const shared = sharedSplineEndpoint(sketch, splines[0], splines[1])
    if (shared !== null)
      out.push({ kind: 'splineTangentSpline', label: 'Smooth Join', symbol: '⌒', value: null, entities: [shared, splines[0], splines[1]] })
  }
  return out
}

// Detect a constraint that already exists on the same entity set (ignoring
// order) so we don't add exact duplicates.
export function findDuplicate(sketch: Sketch, kind: ConstraintKind, entities: EntityId[]): Constraint | undefined {
  const key = [...entities].sort((a, b) => a - b).join(',')
  return sketch.constraints.find((c) => c.kind === kind && [...c.entities].sort((a, b) => a - b).join(',') === key)
}
