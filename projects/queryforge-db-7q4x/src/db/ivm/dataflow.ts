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

import { compileExpr, exprKey, truthy, type Evaluator, type CompileCtx } from '../eval'
import { resolveColumn, type Binding, type Schema } from '../schema'
import { hashKey, orderValues, SqlError, type ColumnType, type SqlValue } from '../types'
import {
  addDecimal,
  divDecimal,
  rescale,
  fromInt as decFromInt,
  isDecimal,
  DECIMAL_ZERO,
  DIV_DEFAULT_SCALE,
  type DecimalValue,
} from '../decimal'
import type { Database, Row, Table } from '../catalog'
import type { Expr, SelectItem, SelectStmt } from '../ast'
import { analyzeView, collectColumns, type IvmAggregate, type IvmAnalysis } from './analyze'
import { ZSet, type ZSetEntry } from './zset'

// ---------------------------------------------------------------------------
// Small expression helpers
// ---------------------------------------------------------------------------

/** A render-ready node of a view's incremental dataflow (for `EXPLAIN`-style
 *  introspection). The tree reads top-down output → producers, like a plan tree:
 *  the sink at the top, the join/scans where each base delta enters at the
 *  bottom. Decoupled from the cost-model `PlanNode` — there are no row estimates,
 *  only the structure and where deltas flow. */
export interface IvmPlanNode {
  op: string
  detail: string
  extra: string[]
  children: IvmPlanNode[]
}

/** A compact SQL-ish rendering of an expression, for EXPLAIN labels only. */
function exprText(e: Expr): string {
  switch (e.kind) {
    case 'column':
      return e.table ? `${e.table}.${e.name}` : e.name
    case 'literal':
      return e.value === null ? 'NULL' : typeof e.value === 'string' ? `'${e.value}'` : String(e.value)
    case 'star':
      return e.table ? `${e.table}.*` : '*'
    case 'unary':
      return `${e.op}${/[a-z]/i.test(e.op) ? ' ' : ''}${exprText(e.expr)}`
    case 'binary':
      return `${exprText(e.left)} ${e.op} ${exprText(e.right)}`
    case 'between':
      return `${exprText(e.expr)} ${e.negated ? 'NOT ' : ''}BETWEEN ${exprText(e.lo)} AND ${exprText(e.hi)}`
    case 'in':
      return `${exprText(e.expr)} ${e.negated ? 'NOT ' : ''}IN (${e.list.map(exprText).join(', ')})`
    case 'like':
      return `${exprText(e.expr)} ${e.negated ? 'NOT ' : ''}LIKE ${exprText(e.pattern)}`
    case 'isnull':
      return `${exprText(e.expr)} IS ${e.negated ? 'NOT ' : ''}NULL`
    case 'cast':
      return `CAST(${exprText(e.expr)} AS ${e.type})`
    case 'case':
      return 'CASE … END'
    case 'func': {
      if (e.star) return `${e.name}(*)${e.filter ? ` FILTER (WHERE ${exprText(e.filter)})` : ''}`
      const inner = `${e.distinct ? 'DISTINCT ' : ''}${e.args.map(exprText).join(', ')}`
      return `${e.name}(${inner})${e.filter ? ` FILTER (WHERE ${exprText(e.filter)})` : ''}`
    }
    default:
      return 'expr'
  }
}

/** A SQL-ish rendering of one normalized aggregate slot. */
function aggText(a: IvmAggregate): string {
  if (a.func === 'COUNT_STAR') return `COUNT(*)${a.filter ? ` FILTER (WHERE ${exprText(a.filter)})` : ''}`
  const inner = `${a.distinct ? 'DISTINCT ' : ''}${a.arg ? exprText(a.arg) : ''}`
  return `${a.func}(${inner})${a.filter ? ` FILTER (WHERE ${exprText(a.filter)})` : ''}`
}

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

/** Best-effort static type of an aggregate's result column (a label/fallback;
 *  the planner re-derives the real type from the materialized data on scan). */
function aggResultType(agg: IvmAggregate, schema: Schema): ColumnType {
  switch (agg.func) {
    case 'COUNT_STAR':
    case 'COUNT':
      return 'INTEGER'
    case 'SUM':
      return agg.arg ? staticType(agg.arg, schema) : 'INTEGER'
    case 'AVG': {
      const t = agg.arg ? staticType(agg.arg, schema) : 'REAL'
      return t === 'DECIMAL' ? 'DECIMAL' : 'REAL'
    }
    case 'MIN':
    case 'MAX':
      return agg.arg ? staticType(agg.arg, schema) : 'INTEGER'
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
//
// Each group keeps O(1) running state per aggregate slot, so a delta updates
// only the groups it touches and emits a single net retract+insert per group.
// Every slot kind is *invertible* under retraction: counts and sums add the
// signed weight; a DECIMAL sum keeps an exact BigInt-backed running total plus a
// live-scale multiset (so the rendered scale matches a recompute even after a
// wider-scale value is inserted and later deleted); COUNT(DISTINCT) keeps a
// value→multiplicity map (a value leaves only when its last copy does); MIN/MAX
// keep a value-multiset so a deleted extreme recovers the next one.

type SlotState =
  | { kind: 'count'; n: number }
  | { kind: 'count_distinct'; counts: Map<string, number> }
  | { kind: 'sum_int'; sum: number; n: number }
  | { kind: 'avg_int'; sum: number; n: number }
  | { kind: 'sum_dec'; sum: DecimalValue; n: number; scales: Map<number, number> }
  | { kind: 'avg_dec'; sum: DecimalValue; n: number; scales: Map<number, number> }
  | { kind: 'minmax'; isMax: boolean; values: Map<string, { v: SqlValue; n: number }> }

interface GroupState {
  key: SqlValue[]
  /** Unfiltered row count — drives group *existence* regardless of any FILTERs. */
  countStar: number
  slots: SlotState[]
}

interface AggSlot {
  agg: IvmAggregate
  /** Whether SUM/AVG run the exact-decimal path (a DECIMAL column) or the
   *  float path (an INTEGER column). Irrelevant for the other kinds. */
  decimal: boolean
  arg?: Evaluator
  /** Optional `FILTER (WHERE …)` predicate over the composite row. */
  filter?: Evaluator
}

class GroupedSink implements Sink {
  private groups = new Map<string, GroupState>()
  private readonly groupKeys: Evaluator[]
  private readonly slots: AggSlot[]
  /** Output projection over the intermediate row [key…, aggResult…]. */
  private readonly outputEvals: Evaluator[]
  /** Optional HAVING predicate over the same intermediate row. */
  private readonly having?: Evaluator
  readonly outputColumns: string[]
  readonly outputSchema: Schema
  constructor(
    groupKeys: Evaluator[],
    slots: AggSlot[],
    outputEvals: Evaluator[],
    having: Evaluator | undefined,
    outputColumns: string[],
    outputSchema: Schema,
  ) {
    this.groupKeys = groupKeys
    this.slots = slots
    this.outputEvals = outputEvals
    this.having = having
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

  /** The intermediate row a group resolves to: the grouping key followed by
   *  every aggregate's finalized value. Outputs and HAVING read from it. */
  private intermediate(g: GroupState): Row {
    const row: Row = g.key.slice()
    for (let i = 0; i < this.slots.length; i++) row.push(finalizeSlot(g, i))
    return row
  }

  /** Is this group materialized? It must hold ≥1 row (or be the single empty-key
   *  group of an un-grouped aggregate), and pass HAVING if one is present. */
  private exists(g: GroupState): boolean {
    const base = this.groupKeys.length === 0 || g.countStar > 0
    if (!base) return false
    if (!this.having) return true
    return truthy(this.having(this.intermediate(g)))
  }

  /** The materialized output row of a (presumed-present) group. */
  private emit(g: GroupState): Row {
    const inter = this.intermediate(g)
    return this.outputEvals.map((ev) => ev(inter))
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
      // Reclaim a fully-drained group (un-grouped aggregate keeps its lone group).
      if (g.countStar <= 0 && this.groupKeys.length > 0) this.groups.delete(kh)
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
      // A FILTER (WHERE …) gates whether this row contributes to *this* slot.
      if (slot.filter && !truthy(slot.filter(row))) continue
      // COUNT(*) (no argument) counts every (filtered) row, NULLs included.
      const countsEveryRow = st.kind === 'count' && !slot.arg
      const v = slot.arg ? slot.arg(row) : null
      if (!countsEveryRow && v === null) continue
      switch (st.kind) {
        case 'count':
          st.n += w
          break
        case 'count_distinct': {
          const vk = hashKey([v])
          const c = (st.counts.get(vk) ?? 0) + w
          if (c === 0) st.counts.delete(vk)
          else st.counts.set(vk, c)
          break
        }
        case 'sum_int':
        case 'avg_int': {
          const num = typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : Number(v)
          st.sum += w * num
          st.n += w
          break
        }
        case 'sum_dec':
        case 'avg_dec': {
          if (!isDecimal(v)) break
          // Exact, order-independent: add the value's unscaled BigInt × weight.
          st.sum = addDecimal(st.sum, { t: 'decimal', d: (BigInt(v.d) * BigInt(w)).toString(), s: v.s })
          st.n += w
          const sc = (st.scales.get(v.s) ?? 0) + w
          if (sc === 0) st.scales.delete(v.s)
          else st.scales.set(v.s, sc)
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

  rows(): Row[] {
    const out: Row[] = []
    for (const g of this.groups.values()) if (this.exists(g)) out.push(this.emit(g))
    return out
  }
}

function initSlot(s: AggSlot): SlotState {
  switch (s.agg.func) {
    case 'COUNT_STAR':
      return { kind: 'count', n: 0 }
    case 'COUNT':
      return s.agg.distinct ? { kind: 'count_distinct', counts: new Map() } : { kind: 'count', n: 0 }
    case 'SUM':
      return s.decimal ? { kind: 'sum_dec', sum: DECIMAL_ZERO, n: 0, scales: new Map() } : { kind: 'sum_int', sum: 0, n: 0 }
    case 'AVG':
      return s.decimal ? { kind: 'avg_dec', sum: DECIMAL_ZERO, n: 0, scales: new Map() } : { kind: 'avg_int', sum: 0, n: 0 }
    case 'MIN':
      return { kind: 'minmax', isMax: false, values: new Map() }
    case 'MAX':
      return { kind: 'minmax', isMax: true, values: new Map() }
  }
}

/** The largest scale among the currently-live decimal values, mirroring the
 *  scale an `addDecimal` fold of the live set would settle on. */
function liveScale(scales: Map<number, number>): number {
  let max = 0
  for (const s of scales.keys()) if (s > max) max = s
  return max
}

function finalizeSlot(g: GroupState, slotIndex: number): SqlValue {
  const st = g.slots[slotIndex]
  switch (st.kind) {
    case 'count':
      return st.n
    case 'count_distinct':
      return st.counts.size
    case 'sum_int':
      return st.n > 0 ? st.sum : null
    case 'avg_int':
      return st.n > 0 ? st.sum / st.n : null
    case 'sum_dec': {
      if (st.n <= 0) return null
      // Render at the live max-scale — the exact total fits there (the higher
      // scale the running sum may carry is only trailing zeros from a value that
      // has since been retracted), so this matches a recompute exactly.
      return rescale(st.sum, liveScale(st.scales))
    }
    case 'avg_dec': {
      if (st.n <= 0) return null
      const ls = liveScale(st.scales)
      const num = rescale(st.sum, ls)
      // The engine finalizes AVG(decimal) as divDecimal(sum, count, max(sum.s, 6)).
      return divDecimal(num, decFromInt(st.n), Math.max(ls, DIV_DEFAULT_SCALE)) ?? null
    }
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

// ---------------------------------------------------------------------------
// Outer-join runtime — a single two-table LEFT/RIGHT/FULL join.
//
// An outer join's output is the inner join ⊕ the NULL-extended *anti-join* of
// each preserved side (its rows with no match on the other). The inner part is
// linear in a single base delta, exactly like the bilinear inner join. The
// anti-join is the subtle part: a preserved row flips between its real matched
// rows and its single NULL-extended row as its match count crosses zero — and
// that count is changed by the *other* side's deltas. So we keep, per preserved
// side, a value→{multiplicity, live-match-weight} map; a row is NULL-extended
// iff its match weight is 0. The map is rebuilt from scratch on initialize /
// refresh / restore, so there is never stale state to reconcile across a
// rollback. State is keyed by row *value* (so duplicate rows in a bag share an
// entry, with `mult` their count) — exactly the multiplicity the output needs.
// ---------------------------------------------------------------------------

interface OuterState {
  row: Row
  /** How many copies of this row value the preserved side currently holds. */
  mult: number
  /** Total weight of other-side rows that currently match this value. */
  matchW: number
}

interface OuterJoinRuntime {
  type: 'LEFT' | 'RIGHT' | 'FULL'
  preserveA: boolean
  preserveB: boolean
  /** ON-predicate conjuncts (decide a *match*), over the composite row. */
  onPreds: Evaluator[]
  /** WHERE conjuncts (filter the *output*, matched and NULL-extended alike). */
  wherePreds: Evaluator[]
  aState: Map<string, OuterState>
  bState: Map<string, OuterState>
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
  /** Present iff this view is built on a single LEFT/RIGHT/FULL outer join. */
  private readonly outer?: OuterJoinRuntime
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
    outer?: OuterJoinRuntime
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
    this.outer = args.outer
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
      const shape = analysis.shape
      const groupBy = shape.groupBy
      const groupKeys = groupBy.map((g) => compileExpr(g, ctx))

      // One running slot per distinct aggregate (from the SELECT + HAVING). For
      // SUM/AVG decide the exact path by the argument column's type: INTEGER →
      // float total (exact and order-independent under 2^53); DECIMAL → an exact
      // BigInt-backed running total. Anything else can't be maintained exactly.
      const slots: AggSlot[] = shape.aggs.map((agg) => {
        let decimal = false
        if (agg.func === 'SUM' || agg.func === 'AVG') {
          if (!agg.arg || agg.arg.kind !== 'column') {
            throw new SqlError(`incremental ${agg.func} requires a plain INTEGER or DECIMAL column argument`, 'plan')
          }
          const b = compositeSchema[resolveColumn(compositeSchema, agg.arg.table, agg.arg.name)]
          if (b.type === 'DECIMAL') decimal = true
          else if (b.type !== 'INTEGER') {
            throw new SqlError(
              `incremental ${agg.func} is only supported over an INTEGER or DECIMAL column (got ${b.type} "${agg.arg.name}")`,
              'plan',
            )
          }
        }
        return {
          agg,
          decimal,
          arg: agg.arg ? compileExpr(agg.arg, ctx) : undefined,
          filter: agg.filter ? compileExpr(agg.filter, ctx) : undefined,
        }
      })

      // The intermediate row a group resolves to is [grouping keys…, aggregate
      // results…]; compile the output projection and HAVING against it via a
      // `lookup` that maps a grouping-key or aggregate expression to its slot —
      // exactly how the planner lowers a grouped SELECT, so the values match.
      const groupKeyMap = new Map<string, number>()
      groupBy.forEach((g, i) => groupKeyMap.set(exprKey(g), i))
      const aggSlotMap = new Map<string, number>()
      shape.aggs.forEach((a, i) => aggSlotMap.set(a.key, groupBy.length + i))

      const interSchema: Schema = [
        ...groupBy.map((g, i) => ({
          table: g.kind === 'column' ? (g.table ?? '') : '',
          name: g.kind === 'column' ? g.name : `group${i}`,
          type: staticType(g, compositeSchema),
        })),
        ...shape.aggs.map((a) => ({ table: '', name: a.label, type: aggResultType(a, compositeSchema) })),
      ]
      const outCtx: CompileCtx = {
        resolve: (t, n) => {
          const k = exprKey({ kind: 'column', table: t, name: n })
          const slot = groupKeyMap.get(k)
          if (slot !== undefined) return slot
          return resolveColumn(interSchema, t, n)
        },
        lookup: (e) => groupKeyMap.get(exprKey(e)) ?? aggSlotMap.get(exprKey(e)),
      }
      const outputEvals = shape.outputs.map((o) => compileExpr(o.expr, outCtx))
      const having = shape.having ? compileExpr(shape.having, outCtx) : undefined
      const labels = shape.outputs.map((o) => o.label)
      const outSchema: Schema = shape.outputs.map((o) => {
        const slot = aggSlotMap.get(exprKey(o.expr))
        const type =
          slot !== undefined ? aggResultType(shape.aggs[slot - groupBy.length], compositeSchema) : staticType(o.expr, compositeSchema)
        return { table: '', name: o.label, type }
      })
      sink = new GroupedSink(groupKeys, slots, outputEvals, having, labels, outSchema)
      const aggNames = shape.aggs.map((a) => a.func.toLowerCase().replace('_star', '(*)'))
      shapeLabel =
        `group-by aggregate (${aggNames.join(', ') || 'none'})` +
        (shape.having ? ' + HAVING' : '')
    }

    // Outer-join runtime: ON decides matches, WHERE filters output; they must
    // stay separate (unlike the inner path, which pushes both down together).
    let outer: OuterJoinRuntime | undefined
    if (analysis.outer) {
      const type = analysis.outer.type
      outer = {
        type,
        preserveA: type === 'LEFT' || type === 'FULL',
        preserveB: type === 'RIGHT' || type === 'FULL',
        onPreds: conjuncts(select.joins[0].on).map((c) => compileExpr(c, ctx)),
        wherePreds: conjuncts(select.where).map((c) => compileExpr(c, ctx)),
        aState: new Map(),
        bState: new Map(),
      }
      shapeLabel = `${type.toLowerCase()} outer join → ${shapeLabel}`
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
      outer,
    })
  }

  // --- outer-join maintenance ------------------------------------------------

  /** Fill slot `slot`'s columns of `composite` from `r` (NULLs when `r` is null). */
  private fillSlot(composite: Row, slot: number, r: Row | null): void {
    const off = this.offsets[slot]
    const end = slot + 1 < this.relations.length ? this.offsets[slot + 1] : this.width
    for (let i = off; i < end; i++) composite[i] = r ? r[i - off] : null
  }

  /** A fresh composite row with A in slot 0 and B in slot 1 (either may be NULL). */
  private compose(aRow: Row | null, bRow: Row | null): Row {
    const c: Row = new Array(this.width).fill(null)
    this.fillSlot(c, 0, aRow)
    this.fillSlot(c, 1, bRow)
    return c
  }

  private onMatch(aRow: Row, bRow: Row): boolean {
    const c = this.compose(aRow, bRow)
    for (const p of this.outer!.onPreds) if (!truthy(p(c))) return false
    return true
  }

  private wherePass(c: Row): boolean {
    for (const q of this.outer!.wherePreds) if (!truthy(q(c))) return false
    return true
  }

  /** Full (re)evaluation of an outer join: build both side-states and the
   *  initial output composite, then load the sink. */
  private outerInitialize(db: Database): void {
    const o = this.outer!
    o.aState.clear()
    o.bState.clear()
    const aRows = [...db.getTable(this.relations[0].table).heap.values()]
    const bRows = [...db.getTable(this.relations[1].table).heap.values()]
    const out = new ZSet()
    // Matched rows + A-side state/anti (scan B for each A row).
    for (const a of aRows) {
      let mw = 0
      for (const b of bRows) {
        if (this.onMatch(a, b)) {
          mw++
          const c = this.compose(a, b)
          if (this.wherePass(c)) out.add(c, 1)
        }
      }
      if (o.preserveA) {
        const ah = hashKey(a)
        const e = o.aState.get(ah)
        if (e) e.mult++
        else o.aState.set(ah, { row: a, mult: 1, matchW: mw })
        if (mw === 0) {
          const c = this.compose(a, null)
          if (this.wherePass(c)) out.add(c, 1)
        }
      }
    }
    // B-side state/anti (matched rows already emitted above).
    if (o.preserveB) {
      for (const b of bRows) {
        let mw = 0
        for (const a of aRows) if (this.onMatch(a, b)) mw++
        const bh = hashKey(b)
        const e = o.bState.get(bh)
        if (e) e.mult++
        else o.bState.set(bh, { row: b, mult: 1, matchW: mw })
        if (mw === 0) {
          const c = this.compose(null, b)
          if (this.wherePass(c)) out.add(c, 1)
        }
      }
    }
    this.sink.apply(out)
  }

  /** The output composite delta from a base delta on one side of the outer join.
   *  Emits matched rows linearly, flips the changed side's own NULL-extended rows
   *  by its match count, and flips the *other* side's NULL-extended rows wherever
   *  this delta moves their match count across zero. All rows pass WHERE first. */
  private outerDelta(db: Database, changedSlot: number, deltaRows: ZSetEntry[]): ZSet {
    const o = this.outer!
    const out = new ZSet()
    const yslot = 1 - changedSlot
    const yRows = [...db.getTable(this.relations[yslot].table).heap.values()]
    const preserveX = changedSlot === 0 ? o.preserveA : o.preserveB
    const preserveY = changedSlot === 0 ? o.preserveB : o.preserveA
    const xState = changedSlot === 0 ? o.aState : o.bState
    const yState = changedSlot === 0 ? o.bState : o.aState

    // Compose with the changed row in its slot and the other row in the other.
    const comp = (xr: Row | null, yr: Row | null): Row =>
      changedSlot === 0 ? this.compose(xr, yr) : this.compose(yr, xr)
    const matches = (xr: Row, yr: Row): boolean =>
      changedSlot === 0 ? this.onMatch(xr, yr) : this.onMatch(yr, xr)

    // Net change to each distinct other-side value's match weight, for Y-anti.
    const deltaMatchY = new Map<string, number>()

    for (const { row: x, weight: wx } of deltaRows) {
      const xh = hashKey(x)
      let mwx = 0 // total Y weight (heap entries) matching x — for X-anti
      const seen = new Set<string>() // distinct Y values matched by this x
      for (const y of yRows) {
        if (!matches(x, y)) continue
        mwx++
        const c = comp(x, y)
        if (this.wherePass(c)) out.add(c, wx)
        const yh = hashKey(y)
        if (!seen.has(yh)) {
          seen.add(yh)
          deltaMatchY.set(yh, (deltaMatchY.get(yh) ?? 0) + wx)
        }
      }
      if (preserveX) {
        // X is unmatched (gets a NULL-extended row) iff its match weight is 0.
        // The other side is unchanged by an X-delta, so the stored matchW (or the
        // count we just took for a brand-new value) is current.
        const e = xState.get(xh)
        const mw = e ? e.matchW : mwx
        if (mw === 0) {
          const c = comp(x, null)
          if (this.wherePass(c)) out.add(c, wx)
        }
        if (e) {
          e.mult += wx
          if (e.mult <= 0) xState.delete(xh)
        } else if (wx > 0) {
          xState.set(xh, { row: x, mult: wx, matchW: mwx })
        }
      }
    }

    if (preserveY) {
      for (const [yh, dm] of deltaMatchY) {
        if (dm === 0) continue
        const e = yState.get(yh)
        if (!e) continue
        const before = e.matchW
        const after = before + dm
        e.matchW = after
        // A Y value flips out of / into the anti-join as its match count crosses 0.
        if (before === 0 && after > 0) {
          const c = comp(null, e.row)
          if (this.wherePass(c)) out.add(c, -e.mult)
        } else if (before > 0 && after === 0) {
          const c = comp(null, e.row)
          if (this.wherePass(c)) out.add(c, e.mult)
        }
      }
    }
    return out
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
    if (this.outer) {
      this.outerInitialize(db)
    } else {
      const first = db.getTable(this.relations[0].table)
      const delta: ZSetEntry[] = []
      for (const r of first.heap.values()) delta.push({ row: r, weight: 1 })
      this.sink.apply(this.spjDelta(db, 0, delta))
    }
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
    const composite = this.outer ? this.outerDelta(db, slot, deltaRows) : this.spjDelta(db, slot, deltaRows)
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

  /** The compiled incremental dataflow as a render-ready tree: the sink at the
   *  top, the join/scan structure (where each base delta enters) at the bottom.
   *  The incremental dual of `EXPLAIN` — it describes how a Δ to a base table is
   *  turned into a Δ to the view, not how the query would be re-run. */
  explain(): IvmPlanNode {
    const scan = (slot: number): IvmPlanNode => {
      const rel = this.relations[slot]
      const named = rel.alias !== rel.table ? `${rel.table} ${rel.alias}` : rel.table
      return { op: 'DeltaScan', detail: named, extra: ['a Δ on this table drives maintenance'], children: [] }
    }

    // The join / scan producer subtree.
    let producer: IvmPlanNode
    if (this.outer) {
      const o = this.outer
      const onText = conjuncts(this.select.joins[0].on).map(exprText).join(' AND ') || 'true'
      const whereText = conjuncts(this.select.where).map(exprText).join(' AND ')
      const preserved = [o.preserveA ? this.relations[0].alias : null, o.preserveB ? this.relations[1].alias : null].filter(
        Boolean,
      )
      const extra = [
        `preserves ${preserved.join(' + ')} (NULL-extends unmatched rows)`,
        `tracks each preserved row's live match count; flips its NULL-extended image as the count crosses 0`,
      ]
      if (whereText) extra.push(`WHERE ${whereText} (applied to matched & NULL-extended rows)`)
      producer = {
        op: `${o.type} OUTER JOIN`,
        detail: `ON ${onText}`,
        extra,
        children: [scan(0), scan(1)],
      }
    } else {
      producer = scan(0)
      for (let i = 1; i < this.relations.length; i++) {
        const j = this.select.joins[i - 1]
        const onText = conjuncts(j.on).map(exprText).join(' AND ')
        producer = {
          op: `${j.type} JOIN`,
          detail: onText ? `ON ${onText}` : '(cross product)',
          extra:
            i === 1
              ? ['bilinear: a single table’s Δ is linear; the other side is read live from the catalog']
              : [],
          children: [producer, scan(i)],
        }
      }
      const whereText = conjuncts(this.select.where).map(exprText).join(' AND ')
      if (whereText) {
        producer = {
          op: 'Filter (σ)',
          detail: whereText,
          extra: ['pushed down to the earliest join depth where each conjunct is bound'],
          children: [producer],
        }
      }
    }

    // The sink on top.
    const shape = this.analysis.shape
    let sinkNode: IvmPlanNode
    if (shape.mode === 'grouped') {
      const keys = shape.groupBy.map(exprText)
      const extra: string[] = []
      extra.push(`aggregates: ${shape.aggs.map(aggText).join(', ') || '(none)'}`)
      extra.push(`output: ${shape.outputs.map((x) => `${exprText(x.expr)} AS ${x.label}`).join(', ')}`)
      if (shape.having) extra.push(`HAVING ${exprText(shape.having)} (decides group presence)`)
      extra.push('O(groups) running state; emits a net retract+insert only for groups a Δ touches')
      sinkNode = {
        op: 'Incremental HashAggregate',
        detail: keys.length ? `GROUP BY ${keys.join(', ')}` : '(ungrouped — one row)',
        extra,
        children: [producer],
      }
    } else if (shape.distinct) {
      sinkNode = {
        op: 'Incremental DISTINCT',
        detail: this.sink.outputColumns.join(', '),
        extra: ['keeps each row’s pre-distinct multiplicity; flips a row in/out as its count crosses 0'],
        children: [producer],
      }
    } else {
      sinkNode = {
        op: 'Incremental Project (bag)',
        detail: this.sink.outputColumns.join(', '),
        extra: ['linear: result += π(Δ)'],
        children: [producer],
      }
    }

    return {
      op: 'MaterializedView',
      detail: this.name,
      extra: [
        this.shapeLabel,
        `${this.rowCount()} row${this.rowCount() === 1 ? '' : 's'} materialized`,
        `${this.stats.steps} maintenance step${this.stats.steps === 1 ? '' : 's'} applied`,
      ],
      children: [sinkNode],
    }
  }
}
