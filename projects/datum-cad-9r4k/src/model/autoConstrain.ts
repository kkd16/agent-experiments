import type { Sketch } from './sketch'
import type { ConstraintKind, EntityId, LineEntity } from './types'
import { findDuplicate } from './constraintRules'
import { analyzeConflicts } from '../solver/conflicts'

export type AutoConstrainResult = {
  added: number
  byKind: Partial<Record<ConstraintKind, number>>
}

export type AutoConstrainOptions = {
  coincidentDist?: number // world-unit radius to fuse two points
  angleTolDeg?: number // how close to 0/90° counts as axis-aligned / parallel / perpendicular
  lengthTolRel?: number // relative length difference that counts as "equal"
}

type Candidate = { kind: ConstraintKind; entities: EntityId[] }

// Infer the constraints a rough sketch is "obviously" trying to express —
// near-coincident points, near-horizontal / vertical lines, near-parallel /
// perpendicular / equal-length line pairs — and add them in one shot.
//
// The trick that makes this trustworthy: every inferred constraint is admitted
// only if it *raises the rank* of the system (i.e. adds no redundant equation),
// checked with the same Jacobian analysis that powers conflict diagnosis. So
// auto-constrain snaps the sketch tighter without ever fighting itself — you get
// a clean, non-redundant constraint set, not a pile of overlapping relations.
export function autoConstrain(sketch: Sketch, opts: AutoConstrainOptions = {}): AutoConstrainResult {
  const coincidentDist = opts.coincidentDist ?? 6
  const angleTol = (opts.angleTolDeg ?? 3) * (Math.PI / 180)
  const lengthTolRel = opts.lengthTolRel ?? 0.02

  const points = sketch.entities.filter((e) => e.kind === 'point')
  const lines = sketch.entities.filter((e): e is LineEntity => e.kind === 'line')

  // Direction angle of a line folded into [0, π): orientation, ignoring sign.
  const orient = (l: LineEntity) => {
    const { dx, dy } = sketch.lineDir(l)
    let a = Math.atan2(dy, dx)
    if (a < 0) a += Math.PI
    if (a >= Math.PI) a -= Math.PI
    return a
  }
  const angleClose = (a: number, target: number) => {
    let d = Math.abs(a - target)
    if (d > Math.PI / 2) d = Math.PI - d
    return d <= angleTol
  }

  // Build candidates in priority order: the strongest, most-obvious intentions
  // first, so that when two candidates are mutually redundant the better one wins.
  const candidates: Candidate[] = []

  // 1. Coincident: distinct points sitting almost on top of each other.
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i]
      const b = points[j]
      if (a.kind !== 'point' || b.kind !== 'point') continue
      if (Math.hypot(a.x - b.x, a.y - b.y) <= coincidentDist) {
        candidates.push({ kind: 'coincident', entities: [a.id, b.id] })
      }
    }
  }

  // 2. Horizontal / vertical: a line lying almost along an axis.
  for (const l of lines) {
    const a = orient(l)
    if (angleClose(a, 0)) candidates.push({ kind: 'horizontal', entities: [l.id] })
    else if (angleClose(a, Math.PI / 2)) candidates.push({ kind: 'vertical', entities: [l.id] })
  }

  // 3. Perpendicular, then parallel, then equal-length line pairs.
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const ai = orient(lines[i])
      const aj = orient(lines[j])
      let diff = Math.abs(ai - aj)
      if (diff > Math.PI / 2) diff = Math.PI - diff
      if (Math.abs(diff - Math.PI / 2) <= angleTol) {
        candidates.push({ kind: 'perpendicular', entities: [lines[i].id, lines[j].id] })
      } else if (diff <= angleTol) {
        candidates.push({ kind: 'parallel', entities: [lines[i].id, lines[j].id] })
      }
    }
  }
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const li = sketch.lineDir(lines[i]).len
      const lj = sketch.lineDir(lines[j]).len
      const denom = Math.max(li, lj) || 1
      if (Math.abs(li - lj) / denom <= lengthTolRel) {
        candidates.push({ kind: 'equalLength', entities: [lines[i].id, lines[j].id] })
      }
    }
  }

  // Admit each candidate only if it adds genuinely new information: no duplicate,
  // and it must not increase the count of redundant (linearly-dependent) equations.
  const byKind: Partial<Record<ConstraintKind, number>> = {}
  let added = 0
  let redundantBefore = analyzeConflicts(sketch).count
  for (const cand of candidates) {
    if (findDuplicate(sketch, cand.kind, cand.entities)) continue
    const c = sketch.addConstraint(cand.kind, cand.entities)
    const redundantAfter = analyzeConflicts(sketch).count
    if (redundantAfter > redundantBefore) {
      sketch.removeConstraint(c.id) // this relation was already implied — drop it
    } else {
      redundantBefore = redundantAfter
      added++
      byKind[cand.kind] = (byKind[cand.kind] ?? 0) + 1
    }
  }
  return { added, byKind }
}
