import type {
  ArcEntity,
  CircularEntity,
  Constraint,
  ConstraintKind,
  CircleEntity,
  Entity,
  EntityId,
  LineEntity,
  PointEntity,
  SketchData,
  SplineEntity,
} from './types'
import { nearestParam, splitCubic } from '../solver/curve'

// A single solvable scalar parameter the solver may move. It is one of two kinds:
//   • a *coordinate* — a point's x/y or a circle/arc radius, living on an entity, or
//   • an *auxiliary* parameter — a curve parameter (or the like) owned by a constraint
//     and stored in its `aux[]` array at `index` (Session 7's first non-coordinate DOF).
// The solver assembles a flat vector of these; `paramKey` maps each to the stable
// column key the AD backends address it by.
export type ParamRef =
  | { kind: 'coord'; owner: PointEntity | CircleEntity | ArcEntity; key: 'x' | 'y' | 'r' }
  | { kind: 'aux'; owner: Constraint; index: number }

// The stable string key identifying a parameter's Jacobian column. Coordinates key on
// "<id>:x|y|r" (unchanged, so every existing lookup keeps working); auxiliaries key on
// "<constraintId>:aux<index>". Owner ids are globally unique (entities and constraints
// draw from one id counter), so the two namespaces never collide.
export function paramKey(ref: ParamRef): string {
  return ref.kind === 'aux' ? `${ref.owner.id}:aux${ref.index}` : `${ref.owner.id}:${ref.key}`
}

// The Sketch is the mutable model: a bag of entities and constraints plus the
// bookkeeping to turn them into (and back from) a flat parameter vector.
export class Sketch {
  entities: Entity[] = []
  constraints: Constraint[] = []
  private nextId = 1

  private byId = new Map<EntityId, Entity>()
  private constraintById = new Map<EntityId, Constraint>()

  constructor(data?: SketchData) {
    if (data) this.load(data)
  }

  load(data: SketchData) {
    this.entities = data.entities.map((e) => ({ ...e }))
    // Deep-copy `entities` and any `aux[]` so a loaded sketch never aliases the source
    // arrays (a stale reference would let an undo snapshot mutate the live model).
    this.constraints = data.constraints.map((c) => ({
      ...c,
      entities: [...c.entities],
      ...(c.aux ? { aux: [...c.aux] } : {}),
    }))
    this.nextId = data.nextId
    this.reindex()
  }

  toData(): SketchData {
    return {
      entities: this.entities.map((e) => ({ ...e })),
      constraints: this.constraints.map((c) => ({
        ...c,
        entities: [...c.entities],
        ...(c.aux ? { aux: [...c.aux] } : {}),
      })),
      nextId: this.nextId,
    }
  }

  clone(): Sketch {
    return new Sketch(this.toData())
  }

  private reindex() {
    this.byId.clear()
    for (const e of this.entities) this.byId.set(e.id, e)
    this.constraintById.clear()
    for (const c of this.constraints) this.constraintById.set(c.id, c)
  }

  // The current value of a constraint's auxiliary parameter (0 if unset) — the value
  // the plain backend reads and the AD backends seed for the "<id>:aux<index>" column.
  auxValue(constraintId: EntityId, index: number): number {
    return this.constraintById.get(constraintId)?.aux?.[index] ?? 0
  }

  private fresh(): EntityId {
    return this.nextId++
  }

  get(id: EntityId): Entity | undefined {
    return this.byId.get(id)
  }

  point(id: EntityId): PointEntity {
    const e = this.byId.get(id)
    if (!e || e.kind !== 'point') throw new Error(`entity ${id} is not a point`)
    return e
  }

  line(id: EntityId): LineEntity {
    const e = this.byId.get(id)
    if (!e || e.kind !== 'line') throw new Error(`entity ${id} is not a line`)
    return e
  }

  circle(id: EntityId): CircleEntity {
    const e = this.byId.get(id)
    if (!e || e.kind !== 'circle') throw new Error(`entity ${id} is not a circle`)
    return e
  }

  arc(id: EntityId): ArcEntity {
    const e = this.byId.get(id)
    if (!e || e.kind !== 'arc') throw new Error(`entity ${id} is not an arc`)
    return e
  }

  spline(id: EntityId): SplineEntity {
    const e = this.byId.get(id)
    if (!e || e.kind !== 'spline') throw new Error(`entity ${id} is not a spline`)
    return e
  }

  // The tangent handle at one of a spline's endpoints, as an ordered pair of point
  // ids [from, to] whose vector (to − from) is the curve's tangent direction there:
  // at the start B′(0) ∝ (c0 − p0); at the end B′(1) ∝ (c1 − p1) (defined pointing
  // from the endpoint toward its control, so a shared-endpoint G1 join is "both
  // handles collinear"). The choice is purely structural (id equality), so it never
  // flips mid-solve — which is what keeps the tangency residuals cleanly
  // differentiable. `pointId` must be the spline's p0 or p1; p1 is the default.
  splineHandleAt(id: EntityId, pointId: EntityId): { from: EntityId; to: EntityId } {
    const s = this.spline(id)
    return pointId === s.p0 ? { from: s.p0, to: s.c0 } : { from: s.p1, to: s.c1 }
  }

  // A circle *or* an arc, viewed through their common (center, radius) interface.
  // This is what lets a single body of "circular" residual code and UI cover both.
  circleLike(id: EntityId): CircularEntity {
    const e = this.byId.get(id)
    if (!e || (e.kind !== 'circle' && e.kind !== 'arc')) throw new Error(`entity ${id} is not a circle or arc`)
    return e
  }

  // The current radius scalar of any circle or arc — the value the solver reads and
  // writes for the `r` parameter, and the accessor the residual `cr(id)` resolves to.
  radiusOf(id: EntityId): number {
    return this.circleLike(id).r
  }

  // --- construction -------------------------------------------------------

  addPoint(x: number, y: number, opts: Partial<PointEntity> = {}): PointEntity {
    const p: PointEntity = { kind: 'point', id: this.fresh(), x, y, fixed: false, ...opts }
    this.entities.push(p)
    this.byId.set(p.id, p)
    return p
  }

  addLine(p1: EntityId, p2: EntityId, construction = false): LineEntity {
    const l: LineEntity = { kind: 'line', id: this.fresh(), p1, p2, construction }
    this.entities.push(l)
    this.byId.set(l.id, l)
    return l
  }

  addCircle(c: EntityId, r: number, construction = false): CircleEntity {
    const circ: CircleEntity = { kind: 'circle', id: this.fresh(), c, r, construction }
    this.entities.push(circ)
    this.byId.set(circ.id, circ)
    return circ
  }

  addArc(c: EntityId, p1: EntityId, p2: EntityId, r: number, construction = false): ArcEntity {
    const arc: ArcEntity = { kind: 'arc', id: this.fresh(), c, p1, p2, r, construction }
    this.entities.push(arc)
    this.byId.set(arc.id, arc)
    return arc
  }

  addSpline(p0: EntityId, c0: EntityId, c1: EntityId, p1: EntityId, construction = false): SplineEntity {
    const sp: SplineEntity = { kind: 'spline', id: this.fresh(), p0, c0, c1, p1, construction }
    this.entities.push(sp)
    this.byId.set(sp.id, sp)
    return sp
  }

  addConstraint(kind: ConstraintKind, entities: EntityId[], value?: number, driver = false): Constraint {
    const c: Constraint = { kind, id: this.fresh(), entities, value, driver }
    // Constraints that carry auxiliary solver parameters seed them now, from the
    // sketch's current geometry, so the solve starts near the right place.
    if (kind === 'pointOnSpline') c.aux = [this.initSplineParam(entities[0], entities[1])]
    this.constraints.push(c)
    this.constraintById.set(c.id, c)
    return c
  }

  // The curve parameter t at which a point most nearly rides a spline — the initial
  // value for a fresh point-on-spline's auxiliary parameter. Lazy import avoids a
  // module cycle (curve.ts pulls in nothing from the model).
  private initSplineParam(pointId: EntityId, splineId: EntityId): number {
    const p = this.point(pointId)
    const s = this.spline(splineId)
    const P = (id: EntityId): [number, number] => {
      const q = this.point(id)
      return [q.x, q.y]
    }
    return nearestParam(P(s.p0), P(s.c0), P(s.c1), P(s.p1), [p.x, p.y])
  }

  removeConstraint(id: EntityId) {
    this.constraints = this.constraints.filter((c) => c.id !== id)
    this.constraintById.delete(id)
  }

  // Split a cubic Bézier spline at parameter `t` (0<t<1) via de Casteljau, replacing
  // it with two cubics that together reproduce the original curve exactly and meet with
  // matching tangent (C1) at the split point. The two new splines share that split
  // point, so dragging it moves both halves together. If `atPoint` is given — a point
  // already riding the curve at `t` (a point-on-spline bead) — it becomes the shared
  // join; otherwise a fresh point is created there. The original spline, its two
  // interior handles, and any constraint that referenced them are removed (that
  // geometry no longer exists); the two endpoints are reused so chained neighbours stay
  // attached.
  splitSpline(id: EntityId, t: number, atPoint?: EntityId): { left: SplineEntity; right: SplineEntity } {
    const s = this.spline(id)
    const P = (pid: EntityId): [number, number] => {
      const p = this.point(pid)
      return [p.x, p.y]
    }
    const { left, right } = splitCubic(P(s.p0), P(s.c0), P(s.c1), P(s.p1), t)
    const p0end = s.p0
    const p1end = s.p1
    const construction = s.construction ?? false

    // The new interior handles.
    const L1 = this.addPoint(left[1][0], left[1][1])
    const L2 = this.addPoint(left[2][0], left[2][1])
    const R1 = this.addPoint(right[1][0], right[1][1])
    const R2 = this.addPoint(right[2][0], right[2][1])
    // The shared split point: reuse the bead if given (moving it exactly onto the
    // curve point), else create a fresh point.
    let S: PointEntity
    if (atPoint !== undefined) {
      S = this.point(atPoint)
      S.x = left[3][0]
      S.y = left[3][1]
    } else {
      S = this.addPoint(left[3][0], left[3][1])
    }

    // Remove the original spline and its now-orphaned interior handles, plus every
    // constraint that referenced any of them (including the bead's point-on-spline).
    const toRemove = new Set<EntityId>([id, s.c0, s.c1])
    this.entities = this.entities.filter((e) => !toRemove.has(e.id))
    this.constraints = this.constraints.filter((c) => !c.entities.some((r) => toRemove.has(r)))

    const newLeft = this.addSpline(p0end, L1.id, L2.id, S.id, construction)
    const newRight = this.addSpline(S.id, R1.id, R2.id, p1end, construction)
    this.reindex()
    return { left: newLeft, right: newRight }
  }

  // Swap an arc's start and end points, flipping which side of the circle the arc
  // sweeps — the standard major-arc / minor-arc toggle. Purely a display choice:
  // the geometry (center, radius, endpoints) and every residual are unchanged.
  reverseArc(id: EntityId) {
    const a = this.arc(id)
    const t = a.p1
    a.p1 = a.p2
    a.p2 = t
  }

  // Delete an entity and everything that depends on it (lines/circles that
  // reference it, and constraints that touch any removed entity).
  removeEntity(id: EntityId) {
    const removed = new Set<EntityId>([id])
    // Cascade to lines/circles built on a removed point.
    let changed = true
    while (changed) {
      changed = false
      for (const e of this.entities) {
        if (removed.has(e.id)) continue
        if (e.kind === 'line' && (removed.has(e.p1) || removed.has(e.p2))) {
          removed.add(e.id)
          changed = true
        } else if (e.kind === 'circle' && removed.has(e.c)) {
          removed.add(e.id)
          changed = true
        } else if (e.kind === 'arc' && (removed.has(e.c) || removed.has(e.p1) || removed.has(e.p2))) {
          removed.add(e.id)
          changed = true
        } else if (
          e.kind === 'spline' &&
          (removed.has(e.p0) || removed.has(e.c0) || removed.has(e.c1) || removed.has(e.p1))
        ) {
          removed.add(e.id)
          changed = true
        }
      }
    }
    this.entities = this.entities.filter((e) => !removed.has(e.id))
    this.constraints = this.constraints.filter((c) => !c.entities.some((ref) => removed.has(ref)))
    this.reindex()
  }

  // --- parameter vector ---------------------------------------------------

  // Every free scalar the solver may move: point coordinates and circle/arc radii
  // first (fixed points contribute nothing), then every constraint's auxiliary
  // parameters. The order is stable, so the AD backends and DOF/kinematics all derive
  // the same column layout from this one list.
  freeParams(extraFixed?: Set<EntityId>): ParamRef[] {
    const params: ParamRef[] = []
    for (const e of this.entities) {
      if (e.kind === 'point') {
        if (e.fixed || extraFixed?.has(e.id)) continue
        params.push({ kind: 'coord', owner: e, key: 'x' })
        params.push({ kind: 'coord', owner: e, key: 'y' })
      } else if (e.kind === 'circle' || e.kind === 'arc') {
        params.push({ kind: 'coord', owner: e, key: 'r' })
      }
    }
    for (const c of this.constraints) {
      if (c.aux) for (let i = 0; i < c.aux.length; i++) params.push({ kind: 'aux', owner: c, index: i })
    }
    return params
  }

  readParams(refs: ParamRef[]): Float64Array {
    const v = new Float64Array(refs.length)
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]
      v[i] = ref.kind === 'aux' ? ref.owner.aux?.[ref.index] ?? 0 : (ref.owner as unknown as Record<string, number>)[ref.key]
    }
    return v
  }

  writeParams(refs: ParamRef[], v: Float64Array) {
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]
      if (ref.kind === 'aux') {
        if (!ref.owner.aux) ref.owner.aux = []
        ref.owner.aux[ref.index] = v[i]
      } else {
        ;(ref.owner as unknown as Record<string, number>)[ref.key] = v[i]
      }
    }
  }

  // --- geometry helpers ---------------------------------------------------

  lineDir(l: LineEntity): { dx: number; dy: number; len: number } {
    const a = this.point(l.p1)
    const b = this.point(l.p2)
    const dx = b.x - a.x
    const dy = b.y - a.y
    return { dx, dy, len: Math.hypot(dx, dy) }
  }

  // World-space description of an arc for rendering / hit-testing: its center, the
  // stored radius, and the counter-clockwise sweep from the start endpoint (a0) to
  // the end endpoint (a1). `sweep` is the CCW angular span in (0, 2π]; the endpoints'
  // angles are taken from their *actual* positions (which the solver keeps on the
  // circle) so the drawn arc always passes through the two endpoint handles.
  arcGeom(a: ArcEntity): { cx: number; cy: number; r: number; a0: number; a1: number; sweep: number } {
    const c = this.point(a.c)
    const p1 = this.point(a.p1)
    const p2 = this.point(a.p2)
    const a0 = Math.atan2(p1.y - c.y, p1.x - c.x)
    const a1 = Math.atan2(p2.y - c.y, p2.x - c.x)
    let sweep = a1 - a0
    while (sweep <= 0) sweep += Math.PI * 2
    while (sweep > Math.PI * 2) sweep -= Math.PI * 2
    return { cx: c.x, cy: c.y, r: a.r, a0, a1, sweep }
  }

  boundingBox(): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const grow = (x: number, y: number) => {
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
    for (const e of this.entities) {
      if (e.kind === 'point') grow(e.x, e.y)
      else if (e.kind === 'circle') {
        const c = this.point(e.c)
        grow(c.x - e.r, c.y - e.r)
        grow(c.x + e.r, c.y + e.r)
      } else if (e.kind === 'arc') {
        // The true swept box: the two endpoints, plus any of the four axis extreme
        // points (angles 0, π/2, π, 3π/2) that fall within the CCW sweep — those are
        // where the arc bulges furthest out.
        const g = this.arcGeom(e)
        grow(this.point(e.p1).x, this.point(e.p1).y)
        grow(this.point(e.p2).x, this.point(e.p2).y)
        for (let k = 0; k < 4; k++) {
          const ang = (k * Math.PI) / 2
          let delta = ang - g.a0
          while (delta < 0) delta += Math.PI * 2
          while (delta > Math.PI * 2) delta -= Math.PI * 2
          if (delta <= g.sweep) grow(g.cx + Math.cos(ang) * g.r, g.cy + Math.sin(ang) * g.r)
        }
      } else if (e.kind === 'spline') {
        // A cubic Bézier lies within the convex hull of its four control points, so
        // growing by all four is a valid (slightly loose) bound that never clips it.
        for (const pid of [e.p0, e.c0, e.c1, e.p1]) {
          const p = this.point(pid)
          grow(p.x, p.y)
        }
      }
    }
    if (!isFinite(minX)) return { minX: -100, minY: -100, maxX: 100, maxY: 100 }
    return { minX, minY, maxX, maxY }
  }
}
