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
} from './types'

// A single solvable scalar parameter, addressed by the entity it lives on and
// the field name to read/write. The solver assembles a flat vector of these.
export type ParamRef = { owner: PointEntity | CircleEntity | ArcEntity; key: 'x' | 'y' | 'r' }

// The Sketch is the mutable model: a bag of entities and constraints plus the
// bookkeeping to turn them into (and back from) a flat parameter vector.
export class Sketch {
  entities: Entity[] = []
  constraints: Constraint[] = []
  private nextId = 1

  private byId = new Map<EntityId, Entity>()

  constructor(data?: SketchData) {
    if (data) this.load(data)
  }

  load(data: SketchData) {
    this.entities = data.entities.map((e) => ({ ...e }))
    this.constraints = data.constraints.map((c) => ({ ...c, entities: [...c.entities] }))
    this.nextId = data.nextId
    this.reindex()
  }

  toData(): SketchData {
    return {
      entities: this.entities.map((e) => ({ ...e })),
      constraints: this.constraints.map((c) => ({ ...c, entities: [...c.entities] })),
      nextId: this.nextId,
    }
  }

  clone(): Sketch {
    return new Sketch(this.toData())
  }

  private reindex() {
    this.byId.clear()
    for (const e of this.entities) this.byId.set(e.id, e)
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

  addConstraint(kind: ConstraintKind, entities: EntityId[], value?: number, driver = false): Constraint {
    const c: Constraint = { kind, id: this.fresh(), entities, value, driver }
    this.constraints.push(c)
    return c
  }

  removeConstraint(id: EntityId) {
    this.constraints = this.constraints.filter((c) => c.id !== id)
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
        }
      }
    }
    this.entities = this.entities.filter((e) => !removed.has(e.id))
    this.constraints = this.constraints.filter((c) => !c.entities.some((ref) => removed.has(ref)))
    this.reindex()
  }

  // --- parameter vector ---------------------------------------------------

  // Every free scalar the solver may move. Fixed points contribute nothing.
  freeParams(extraFixed?: Set<EntityId>): ParamRef[] {
    const params: ParamRef[] = []
    for (const e of this.entities) {
      if (e.kind === 'point') {
        if (e.fixed || extraFixed?.has(e.id)) continue
        params.push({ owner: e, key: 'x' })
        params.push({ owner: e, key: 'y' })
      } else if (e.kind === 'circle' || e.kind === 'arc') {
        params.push({ owner: e, key: 'r' })
      }
    }
    return params
  }

  readParams(refs: ParamRef[]): Float64Array {
    const v = new Float64Array(refs.length)
    for (let i = 0; i < refs.length; i++) v[i] = (refs[i].owner as unknown as Record<string, number>)[refs[i].key]
    return v
  }

  writeParams(refs: ParamRef[], v: Float64Array) {
    for (let i = 0; i < refs.length; i++) (refs[i].owner as unknown as Record<string, number>)[refs[i].key] = v[i]
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
      }
    }
    if (!isFinite(minX)) return { minX: -100, minY: -100, maxX: 100, maxY: 100 }
    return { minX, minY, maxX, maxY }
  }
}
