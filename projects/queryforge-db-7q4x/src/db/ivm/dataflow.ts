// The incremental dataflow — Select / Project / Join / Aggregate over Z-sets.
//
// A `MaterializedView` compiles a maintainable SELECT (vetted by analyze.ts)
// into a small operator graph and keeps its result in lock-step with the base
// tables. The headline property: when a base table changes by a delta ΔT, the
// change to the view is computed *from ΔT alone*, never by re-scanning the whole
// query. Concretely:
//
//   • σ (WHERE / JOIN-ON predicates) and π (projection) are *linear* — a delta
//     pushes straight through them.
//   • ⋈ (join) is *bilinear*; but because we forbid a table appearing twice, a
//     single base table's delta is linear in that table, so the view delta is
//     just `ΔT ⋈ (other tables at their current contents)`. We read the other
//     relations live from the catalog, so no per-view mirror of base data exists.
//   • aggregation keeps O(groups) running state (counts, integer sums, min/max
//     value-multisets) and emits a retract+insert only for the groups a delta
//     actually touches.
//
// Processing single-row deltas against the *current* state of the other
// relations is exactly correct even when one statement changes several tables
// (e.g. an ON DELETE CASCADE): the deltas are applied in the order they happen,
// and the join's bilinearity makes the sequence telescope to the right answer.

import { compileExpr, truthy, type Evaluator, type CompileCtx } from '../eval'
import { resolveColumn, type Binding, type Schema } from '../schema'
import { hashKey, orderValues, SqlError, type ColumnType, type SqlValue } from '../types'
import type { Database, Row, Table } from '../catalog'
import type { Expr, SelectItem, SelectStmt } from '../ast'
import { analyzeView, collectColumns, type GroupedOutput, type IvmAggregate, type IvmAnalysis } from './analyze'
import { ZSet, type ZSetEntry } from './zset'

// ---------------------------------------------------------------------------
// Small expression helpers
// ---------------------------------------------------------------------------

/** Split a predicate on its top-level ANDs into a conjunct list. */
function conjuncts(e: Expr | undefined): Expr[] {
  if (!e) return []
  if (e.kind === 'binary' && e.op === 'AND') return [...conjuncts(e.left), ...conjuncts(e.right)]
  return [e]
}

/** Best-effort static type of an output expression (the planner re-derives the
 *  real type from the data when it scans a materialized view, so this is only a
 *  label / fallback). */
function staticType(e: Expr, schema: Schema): ColumnType {
  switch (e.kind) {
    case 'column':
      try {
        return schema[resolveColumn(schema, e.table, e.name)].type
      } catch {
        return 'TEXT'
      }
    case 'cast':
      return e.type
    case 'literal':
      if (typeof e.value === 'number') return Number.isInteger(e.value) ? 'INTEGER' : 'REAL'
      if (typeof e.value === 'boolean') return 'BOOLEAN'
      return 'TEXT'
    default:
      return 'TEXT'
  }
}

function labelOf(it: SelectItem, i: number): string {
  if (it.alias) return it.alias
  if (it.expr.kind === 'column') return it.expr.name
  if (it.expr.kind === 'func') return it.expr.name.toLowerCase()
  return `col${i + 1}`
}

// ---------------------------------------------------------------------------
// Sinks — each maintains the integrated result and turns an input delta (of
// composite, post-join rows) into an output delta of materialized rows.
// ---------------------------------------------------------------------------

interface Sink {
  readonly outputColumns: string[]
  readonly outputSchema: Schema
  reset(): void
  /** Apply a delta of composite rows; return the resulting delta of output rows. */
  apply(delta: ZSet): ZSet
  rows(): Row[]
}

/** A non-DISTINCT projection — a pure bag. result += π(Δ). */
class BagSink implements Sink {
  private result = new ZSet()
  private readonly proj: Projection
  readonly outputColumns: string[]
  readonly outputSchema: Schema
  constructor(proj: Projection) {
    this.proj = proj
    this.outputColumns = proj.labels
    this.outputSchema = proj.schema
  }
  reset(): void {
    this.result = new ZSet()
  }
  apply(delta: ZSet): ZSet {
    const out = new ZSet()
    for (const e of delta.entries()) {
      const row = this.proj.project(e.row)
      this.result.add(row, e.weight)
      out.add(row, e.weight)
    }
    return out
  }
  rows(): Row[] {
    return this.result.toRows()
  }
}

/** A DISTINCT projection. Keeps the pre-distinct bag's multiplicity per row and
 *  flips a row in/out of the visible result as its count crosses zero. */
class DistinctSink implements Sink {
  private pre = new ZSet()
  private readonly proj: Projection
  readonly outputColumns: string[]
  readonly outputSchema: Schema
  constructor(proj: Projection) {
    this.proj = proj
    this.outputColumns = proj.labels
    this.outputSchema = proj.schema
  }
  reset(): void {
    this.pre = new ZSet()
  }
  apply(delta: ZSet): ZSet {
    const out = new ZSet()
    for (const e of delta.entries()) {
      const row = this.proj.project(e.row)
      const before = this.pre.weightOf(row) > 0
      this.pre.add(row, e.weight)
      const after = this.pre.weightOf(row) > 0
      if (!before && after) out.add(row, 1)
      else if (before && !after) out.add(row, -1)
    }
    return out
  }
  rows(): Row[] {
    const out: Row[] = []
    for (const e of this.pre.entries()) if (e.weight > 0) out.push(e.row)
    return out
  }
}

// --- grouped aggregation ----------------------------------------------------

type SlotState =
  | { kind: 'count_star' }
  | { kind: 'count'; n: number }
  | { kind: 'sum'; sum: number; n: number }
  | { kind: 'avg'; sum: number; n: number }
  | { kind: 'minmax'; isMax: boolean; values: Map<string, { v: SqlValue; n: number }> }

interface GroupState {
  key: SqlValue[]
  countStar: number
  slots: SlotState[]
}

interface AggSlot {
  agg: IvmAggregate
  arg?: Evaluator
}

/** An output column resolved to where its value comes from: a grouping-key
 *  position, or an aggregate-slot index. */
type CompiledOutput = { kind: 'key'; keyIndex: number } | { kind: 'agg'; slotIndex: number }

class GroupedSink implements Sink {
  private groups = new Map<string, GroupState>()
  private readonly groupKeys: Evaluator[]
  private readonly slots: AggSlot[]
  private readonly outputs: CompiledOutput[]
  readonly outputColumns: string[]
  readonly outputSchema: Schema
  constructor(groupKeys: Evaluator[], slots: AggSlot[], outputs: CompiledOutput[], outputColumns: string[], outputSchema: Schema) {
    this.groupKeys = groupKeys
    this.slots = slots
    this.outputs = outputs
    this.outputColumns = outputColumns
    this.outputSchema = outputSchema
  }

  reset(): void {
    this.groups = new Map()
    // An un-grouped aggregate (no GROUP BY) always yields exactly one row, even
    // over an empty table — seed the single empty-key group up front.
    if (this.groupKeys.length === 0) {
      this.groups.set('', { key: [], countStar: 0, slots: this.slots.map(initSlot) })
    }
  }

  private exists(g: GroupState): boolean {
    return this.groupKeys.length === 0 || g.countStar > 0
  }

  apply(delta: ZSet): ZSet {
    // Snapshot each touched group's old output before mutating, so we emit a
    // single net retract+insert per group regardless of how many input rows hit it.
    const oldOut = new Map<string, Row | null>()
    for (const e of delta.entries()) {
      const key = this.groupKeys.map((ev) => ev(e.row))
      const kh = hashKey(key)
      if (!oldOut.has(kh)) {
        const existing = this.groups.get(kh)
        oldOut.set(kh, existing && this.exists(existing) ? this.emit(existing) : null)
      }
      let g = this.groups.get(kh)
      if (!g) {
        g = { key, countStar: 0, slots: this.slots.map(initSlot) }
        this.groups.set(kh, g)
      }
      this.updateGroup(g, e.row, e.weight)
    }
    const out = new ZSet()
    for (const [kh, before] of oldOut) {
      const g = this.groups.get(kh)!
      const present = this.exists(g)
      const after = present ? this.emit(g) : null
      if (!present && this.groupKeys.length > 0) this.groups.delete(kh)
      if (before && after && rowsEqual(before, after)) continue
      if (before) out.add(before, -1)
      if (after) out.add(after, 1)
    }
    return out
  }

  private updateGroup(g: GroupState, row: Row, w: number): void {
    g.countStar += w
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]
      const st = g.slots[i]
      if (st.kind === 'count_star') continue
      const v = slot.arg ? slot.arg(row) : null
      if (v === null) continue
      switch (st.kind) {
        case 'count':
          st.n += w
          break
        case 'sum':
        case 'avg': {
          const num = typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : Number(v)
          st.sum += w * num
          st.n += w
          break
        }
        case 'minmax': {
          const vk = hashKey([v])
          const cur = st.values.get(vk)
          if (cur) {
            cur.n += w
            if (cur.n <= 0) st.values.delete(vk)
          } else if (w > 0) {
            st.values.set(vk, { v, n: w })
          }
          break
        }
      }
    }
  }

  private emit(g: GroupState): Row {
    return this.outputs.map((o) => (o.kind === 'key' ? g.key[o.keyIndex] : finalizeSlot(g, o.slotIndex)))
  }

  rows(): Row[] {
    const out: Row[] = []
    for (const g of this.groups.values()) if (this.exists(g)) out.push(this.emit(g))
    return out
  }
}

function initSlot(s: AggSlot): SlotState {
  switch (s.agg.func) {
    case 'COUNT_STAR':
      return { kind: 'count_star' }
    case 'COUNT':
      return { kind: 'count', n: 0 }
    case 'SUM':
      return { kind: 'sum', sum: 0, n: 0 }
    case 'AVG':
      return { kind: 'avg', sum: 0, n: 0 }
    case 'MIN':
      return { kind: 'minmax', isMax: false, values: new Map() }
    case 'MAX':
      return { kind: 'minmax', isMax: true, values: new Map() }
  }
}

function finalizeSlot(g: GroupState, slotIndex: number): SqlValue {
  const st = g.slots[slotIndex]
  switch (st.kind) {
    case 'count_star':
      return g.countStar
    case 'count':
      return st.n
    case 'sum':
      return st.n > 0 ? st.sum : null
    case 'avg':
      return st.n > 0 ? st.sum / st.n : null
    case 'minmax': {
      let best: SqlValue = null
      let have = false
      for (const { v } of st.values.values()) {
        if (!have) {
          best = v
          have = true
        } else if (st.isMax ? orderValues(v, best) > 0 : orderValues(v, best) < 0) {
          best = v
        }
      }
      return have ? best : null
    }
  }
}

function rowsEqual(a: Row, b: Row): boolean {
  if (a.length !== b.length) return false
  return hashKey(a) === hashKey(b)
}

// ---------------------------------------------------------------------------
// Projection (shared by bag / distinct sinks)
// ---------------------------------------------------------------------------

interface Projection {
  project(row: Row): Row
  labels: string[]
  schema: Schema
}

function buildProjection(columns: SelectItem[], schema: Schema, ctx: CompileCtx): Projection {
  const evals: Evaluator[] = []
  const labels: string[] = []
  const out: Binding[] = []
  columns.forEach((it, i) => {
    if (it.expr.kind === 'star') {
      const tbl = it.expr.table?.toLowerCase()
      schema.forEach((b, idx) => {
        if (tbl && b.table.toLowerCase() !== tbl) return
        evals.push((r) => r[idx])
        labels.push(b.name)
        out.push({ table: '', name: b.name, type: b.type })
      })
      return
    }
    evals.push(compileExpr(it.expr, ctx))
    const label = labelOf(it, i)
    labels.push(label)
    out.push({ table: '', name: label, type: staticType(it.expr, schema) })
  })
  return {
    project: (row) => evals.map((ev) => ev(row)),
    labels,
    schema: out,
  }
}

// ---------------------------------------------------------------------------
// MaterializedView — the compiled, incrementally-maintained view
// ---------------------------------------------------------------------------

export interface MaintenanceStats {
  /** How many maintenance steps (base deltas) have been applied. */
  steps: number
  /** Output rows added / removed by the most recent maintenance step. */
  lastInserted: number
  lastDeleted: number
}

export class MaterializedView {
  readonly name: string
  readonly select: SelectStmt
  readonly analysis: IvmAnalysis
  /** Lower-cased catalog names of the base tables this view reads. */
  readonly baseTables: string[]
  /** SQL describing the maintainable shape, for the UI ("incremental: SPJ" …). */
  readonly shapeLabel: string

  private readonly relations: { table: string; alias: string }[]
  private readonly offsets: number[]
  private readonly width: number
  /** Conjuncts grouped by the join depth at which they become evaluable. */
  private readonly predsAt: Evaluator[][]
  private readonly slotByTable: Map<string, number>
  private readonly sink: Sink
  readonly stats: MaintenanceStats = { steps: 0, lastInserted: 0, lastDeleted: 0 }

  private constructor(args: {
    name: string
    select: SelectStmt
    analysis: IvmAnalysis
    relations: { table: string; alias: string }[]
    offsets: number[]
    width: number
    predsAt: Evaluator[][]
    slotByTable: Map<string, number>
    sink: Sink
    baseTables: string[]
    shapeLabel: string
  }) {
    this.name = args.name
    this.select = args.select
    this.analysis = args.analysis
    this.relations = args.relations
    this.offsets = args.offsets
    this.width = args.width
    this.predsAt = args.predsAt
    this.slotByTable = args.slotByTable
    this.sink = args.sink
    this.baseTables = args.baseTables
    this.shapeLabel = args.shapeLabel
  }

  /** Compile a maintainable SELECT into a view (throws `SqlError` if ineligible). */
  static build(db: Database, name: string, select: SelectStmt): MaterializedView {
    const analysis = analyzeView(select)

    // Resolve relations, build the composite (concatenated) schema + offsets.
    const relations = analysis.relations.map((r) => ({ table: r.table, alias: r.alias }))
    const compositeSchema: Schema = []
    const offsets: number[] = []
    const slotByTable = new Map<string, number>()
    relations.forEach((rel, slot) => {
      offsets.push(compositeSchema.length)
      const t = db.getTable(rel.table)
      for (const c of t.columns) compositeSchema.push({ table: rel.alias, name: c.name, type: c.type })
      slotByTable.set(rel.table.toLowerCase(), slot)
    })
    const width = compositeSchema.length

    const ctx: CompileCtx = { resolve: (table, n) => resolveColumn(compositeSchema, table, n) }

    // Which slot does a binding index belong to?
    const slotOfIndex = (idx: number): number => {
      let s = 0
      while (s + 1 < offsets.length && idx >= offsets[s + 1]) s++
      return s
    }

    // Gather conjuncts from every JOIN-ON and the WHERE, and bucket each by the
    // depth (slot) at which all its referenced columns are bound — classic
    // predicate push-down, so a selective join condition prunes early.
    const predsAt: Evaluator[][] = relations.map(() => [])
    const placePred = (e: Expr): void => {
      const cols: { table?: string; name: string }[] = []
      collectColumns(e, cols)
      let depth = 0
      for (const c of cols) {
        const idx = resolveColumn(compositeSchema, c.table, c.name)
        depth = Math.max(depth, slotOfIndex(idx))
      }
      predsAt[depth].push(compileExpr(e, ctx))
    }
    select.joins.forEach((j) => {
      for (const c of conjuncts(j.on)) placePred(c)
    })
    for (const c of conjuncts(select.where)) placePred(c)

    // Build the sink for this view's shape.
    let sink: Sink
    let shapeLabel: string
    if (analysis.shape.mode === 'bag') {
      const proj = buildProjection(select.columns, compositeSchema, ctx)
      sink = analysis.shape.distinct ? new DistinctSink(proj) : new BagSink(proj)
      shapeLabel = analysis.shape.distinct ? 'select–project–join, DISTINCT' : 'select–project–join'
    } else {
      const groupKeys = analysis.shape.groupBy.map((g) => compileExpr(g, ctx))
      // Agg slots, in the order aggregates appear in the output.
      const aggOutputs = analysis.shape.outputs.filter((o) => o.kind === 'agg') as Extract<GroupedOutput, { kind: 'agg' }>[]
      const slots: AggSlot[] = aggOutputs.map((o) => {
        const agg = o.agg
        if (agg.func === 'SUM' || agg.func === 'AVG') {
          // Guarantee byte-exact incremental arithmetic: integer addition is
          // exact and order-independent (under 2^53). Restrict SUM/AVG to an
          // INTEGER column so the running total can never drift from a recompute.
          if (!agg.arg || agg.arg.kind !== 'column') {
            throw new SqlError(`incremental ${agg.func} requires a plain INTEGER column argument`, 'plan')
          }
          const b = compositeSchema[resolveColumn(compositeSchema, agg.arg.table, agg.arg.name)]
          if (b.type !== 'INTEGER') {
            throw new SqlError(
              `incremental ${agg.func} is only supported over an INTEGER column (got ${b.type} "${agg.arg.name}")`,
              'plan',
            )
          }
        }
        return { agg, arg: agg.arg ? compileExpr(agg.arg, ctx) : undefined }
      })
      // Map every output column to a key index or an agg-slot index.
      const groupByExprs = analysis.shape.groupBy
      let ai = 0
      const outputs: CompiledOutput[] = analysis.shape.outputs.map((o) =>
        o.kind === 'key' ? { kind: 'key', keyIndex: o.keyIndex } : { kind: 'agg', slotIndex: ai++ },
      )
      const labels = analysis.shape.outputs.map((o) => o.label)
      const outSchema: Schema = analysis.shape.outputs.map((o) => {
        if (o.kind === 'key') {
          return { table: '', name: o.label, type: staticType(groupByExprs[o.keyIndex], compositeSchema) }
        }
        const t: ColumnType =
          o.agg.func === 'AVG'
            ? 'REAL'
            : o.agg.func === 'MIN' || o.agg.func === 'MAX'
              ? o.agg.arg
                ? staticType(o.agg.arg, compositeSchema)
                : 'INTEGER'
              : 'INTEGER'
        return { table: '', name: o.label, type: t }
      })
      sink = new GroupedSink(groupKeys, slots, outputs, labels, outSchema)
      shapeLabel = `group-by aggregate (${aggOutputs.map((o) => o.agg.func.toLowerCase()).join(', ') || 'count'})`
    }

    const baseTables = [...new Set(relations.map((r) => r.table.toLowerCase()))]
    return new MaterializedView({
      name,
      select,
      analysis,
      relations,
      offsets,
      width,
      predsAt,
      slotByTable,
      sink,
      baseTables,
      shapeLabel,
    })
  }

  /** The composite-row delta produced by a delta on a single relation slot,
   *  joined against the other relations' current contents and filtered. */
  private spjDelta(db: Database, changedSlot: number, deltaRows: ZSetEntry[]): ZSet {
    const out = new ZSet()
    const composite: Row = new Array(this.width).fill(null)
    const N = this.relations.length
    const liveTables: (Table | null)[] = this.relations.map((r, s) => (s === changedSlot ? null : db.getTable(r.table)))

    const recur = (slot: number, weight: number): void => {
      if (slot === N) {
        out.add(composite.slice(), weight)
        return
      }
      const off = this.offsets[slot]
      const colCount = (slot + 1 < N ? this.offsets[slot + 1] : this.width) - off
      const preds = this.predsAt[slot]
      const tryRow = (r: Row, rw: number): void => {
        for (let i = 0; i < colCount; i++) composite[off + i] = r[i]
        for (const p of preds) if (!truthy(p(composite))) return
        recur(slot + 1, weight * rw)
      }
      if (slot === changedSlot) {
        for (const e of deltaRows) tryRow(e.row, e.weight)
      } else {
        for (const r of liveTables[slot]!.heap.values()) tryRow(r, 1)
      }
    }
    recur(0, 1)
    return out
  }

  /** Populate the view from the current base tables (a full re-evaluation). */
  initialize(db: Database): void {
    this.sink.reset()
    if (this.relations.length === 0) return
    const first = db.getTable(this.relations[0].table)
    const delta: ZSetEntry[] = []
    for (const r of first.heap.values()) delta.push({ row: r, weight: 1 })
    const composite = this.spjDelta(db, 0, delta)
    this.sink.apply(composite)
    this.stats.steps = 0
    this.stats.lastInserted = 0
    this.stats.lastDeleted = 0
  }

  /** Does a change to `tableLower` affect this view? */
  dependsOn(tableLower: string): boolean {
    return this.slotByTable.has(tableLower)
  }

  /** Apply a base-table delta (the rows that changed, with ±1 weights) and
   *  maintain the materialized result. Returns the output delta it produced. */
  applyChange(db: Database, tableLower: string, deltaRows: ZSetEntry[]): { inserted: number; deleted: number; outDelta: ZSet } {
    const slot = this.slotByTable.get(tableLower)
    if (slot === undefined) return { inserted: 0, deleted: 0, outDelta: new ZSet() }
    const composite = this.spjDelta(db, slot, deltaRows)
    const outDelta = this.sink.apply(composite)
    let inserted = 0
    let deleted = 0
    for (const e of outDelta.entries()) {
      if (e.weight > 0) inserted += e.weight
      else deleted += -e.weight
    }
    this.stats.steps++
    this.stats.lastInserted = inserted
    this.stats.lastDeleted = deleted
    return { inserted, deleted, outDelta }
  }

  materializedRows(): Row[] {
    return this.sink.rows()
  }

  rowCount(): number {
    return this.sink.rows().length
  }

  get outputColumns(): string[] {
    return this.sink.outputColumns
  }

  get outputSchema(): Schema {
    return this.sink.outputSchema
  }
}
