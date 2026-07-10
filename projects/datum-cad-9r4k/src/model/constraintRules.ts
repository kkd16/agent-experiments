import type { Sketch } from './sketch'
import type { Constraint, ConstraintKind, Entity, EntityId } from './types'

export type ValueKind = 'distance' | 'angle' | 'radius' | 'diameter' | null

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
): { points: EntityId[]; lines: EntityId[]; circular: EntityId[]; all: Entity[] } {
  const all = sel.map((id) => sketch.get(id)).filter((e): e is Entity => !!e)
  return {
    points: all.filter((e) => e.kind === 'point').map((e) => e.id),
    lines: all.filter((e) => e.kind === 'line').map((e) => e.id),
    // Circles and arcs are interchangeable for every radius/tangent/concentric
    // relation — both carry a (center, radius) pair — so they are pooled here.
    circular: all.filter((e) => e.kind === 'circle' || e.kind === 'arc').map((e) => e.id),
    all,
  }
}

// Every constraint currently applicable to the selection, in menu order.
export function applicableConstraints(sketch: Sketch, sel: EntityId[]): ConstraintOption[] {
  const { points, lines, circular, all } = kinds(sketch, sel)
  const out: ConstraintOption[] = []
  const only = (np: number, nl: number, nc: number) =>
    points.length === np && lines.length === nl && circular.length === nc && all.length === np + nl + nc

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
  return out
}

// Detect a constraint that already exists on the same entity set (ignoring
// order) so we don't add exact duplicates.
export function findDuplicate(sketch: Sketch, kind: ConstraintKind, entities: EntityId[]): Constraint | undefined {
  const key = [...entities].sort((a, b) => a - b).join(',')
  return sketch.constraints.find((c) => c.kind === kind && [...c.entities].sort((a, b) => a - b).join(',') === key)
}
