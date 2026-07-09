import type {
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
export type ParamRef = { owner: PointEntity | CircleEntity; key: 'x' | 'y' | 'r' }

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

  addConstraint(kind: ConstraintKind, entities: EntityId[], value?: number, driver = false): Constraint {
    const c: Constraint = { kind, id: this.fresh(), entities, value, driver }
    this.constraints.push(c)
    return c
  }

  removeConstraint(id: EntityId) {
    this.constraints = this.constraints.filter((c) => c.id !== id)
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
      } else if (e.kind === 'circle') {
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
      }
    }
    if (!isFinite(minX)) return { minX: -100, minY: -100, maxX: 100, maxY: 100 }
    return { minX, minY, maxX, maxY }
  }
}
