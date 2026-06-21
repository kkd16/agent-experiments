// Physical operators — the Volcano / iterator execution model.
//
// Every operator exposes open()/next()/close(). next() returns one row at a
// time (or null at end), pulling from its children. This is exactly how
// classic query engines stream results without materialising everything, and
// it lets EXPLAIN render the operator tree the optimizer chose.

import { hashKey, orderValues, type SqlValue } from './types'
import { isTemporal, formatTemporal } from './temporal'
import type { Row, Table, IndexHandle, GinIndexHandle } from './catalog'
import type { IndexKey } from './storage/btree'
import type { Schema } from './schema'
import type { Evaluator } from './eval'
import { ginCandidates, tsMatch, asTsVector, type TsQuery } from './fts'

/** Per-operator memory accounting, attached to spillable operators after they
 *  run (EXPLAIN ANALYZE) or predicted from estimates (plain EXPLAIN). Drives the
 *  Execution Lab's memory bars and the `EXPLAIN` spill annotations. */
export interface MemStats {
  /** Algorithm actually used, e.g. `top-N heapsort`, `in-memory hash`, `grace hash join`. */
  method: string
  /** The `work_mem` budget (rows) this operator was planned under. */
  budget: number
  /** Peak rows held in memory at once. */
  peakRows: number
  /** Rows (or groups) that spilled past the budget. */
  spilledRows: number
  /** Number of partitions a spill fanned out into (Grace operators). */
  partitions?: number
  /** Number of merge / re-aggregation passes (recursion depth + 1). */
  passes?: number
  /** True once the operator has actually executed (ANALYZE), false for a prediction. */
  measured: boolean
}

export interface PlanNode {
  op: string
  detail: string
  estRows: number
  estCost: number
  actualRows: number
  extra: string[]
  children: PlanNode[]
  /** Memory accounting for spillable operators (Sort / HashAggregate / HashJoin). */
  mem?: MemStats
}

/** Default `work_mem` (rows budget). Generous enough that the seed data never
 *  spills, so existing in-memory plans are byte-for-byte unchanged; lower it with
 *  `SET work_mem = N` to exercise the spilling paths (and the Execution Lab). */
export const DEFAULT_WORK_MEM = 100_000

/** A tiny, deterministic string hash (FNV-1a) for partitioning spill buckets.
 *  Salted so a re-partition of an overflowing partition uses a different split. */
export function spillHash(s: string, salt: number): number {
  let h = 0x811c9dc5 ^ salt
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0)
}

export interface Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  open(): void
  next(): Row | null
  close(): void
  plan(): PlanNode
}

// Cost-model knobs. Cost is in arbitrary, comparable units.
const CPU_TUPLE = 0.01
const CPU_OP = 0.0025

// ---------------------------------------------------------------------------
export class SeqScan implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  /** The base table being scanned — exposed so the planner can recognise a bare
   *  base-relation leaf and turn it into the inner side of an index nested loop. */
  readonly table: Table
  private iter: IterableIterator<Row> | null = null

  constructor(table: Table, schema: Schema) {
    this.table = table
    this.schema = schema
    this.estRows = table.rowCount()
    this.estCost = this.estRows * CPU_TUPLE
  }
  open() {
    this.iter = this.table.heap.values()
  }
  next(): Row | null {
    const n = this.iter!.next()
    if (n.done) return null
    this.actualRows++
    return n.value
  }
  close() {
    this.iter = null
  }
  plan(): PlanNode {
    return {
      op: 'SeqScan',
      detail: this.table.name,
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra: [`heap: ${this.table.rowCount()} rows`],
      children: [],
    }
  }
}

/** A range bound on a (possibly composite, possibly prefix) index key. */
export type RangeBound = { key: IndexKey; inclusive: boolean } | null

export class IndexScan implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private readonly table: Table
  private readonly index: IndexHandle
  private readonly lo: RangeBound
  private readonly hi: RangeBound
  private rowids: number[] = []
  private pos = 0

  constructor(
    table: Table,
    index: IndexHandle,
    schema: Schema,
    lo: RangeBound,
    hi: RangeBound,
    estRows?: number,
  ) {
    this.table = table
    this.index = index
    this.schema = schema
    this.lo = lo
    this.hi = hi
    const total = table.rowCount()
    if (estRows !== undefined) {
      this.estRows = Math.max(1, Math.round(estRows))
    } else {
      const isEq = lo && hi && keysEqual(lo.key, hi.key)
      this.estRows = isEq
        ? Math.max(1, Math.round(total / Math.max(1, index.stats().entries || 1)))
        : Math.ceil(total / 3)
    }
    const h = index.stats().height
    this.estCost = h * CPU_OP + this.estRows * CPU_TUPLE
  }
  open() {
    this.rowids = this.index.tree.range(
      this.lo ? this.lo.key : null,
      this.hi ? this.hi.key : null,
      this.lo ? this.lo.inclusive : true,
      this.hi ? this.hi.inclusive : true,
    )
    this.pos = 0
  }
  next(): Row | null {
    while (this.pos < this.rowids.length) {
      const row = this.table.heap.get(this.rowids[this.pos++])
      if (row) {
        this.actualRows++
        return row
      }
    }
    return null
  }
  close() {
    this.rowids = []
  }
  plan(): PlanNode {
    const s = this.index.stats()
    const bound = (b: RangeBound, sym: string) => (b ? `${sym}${b.inclusive ? '=' : ''} ${fmtKey(b.key)}` : '')
    const cond = [bound(this.lo, '>'), bound(this.hi, '<')].filter(Boolean).join(' AND ') || 'full'
    return {
      op: 'IndexScan',
      detail: `${this.table.name} via ${this.index.meta.name}`,
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra: [
        `on (${this.index.meta.columns.join(', ')}) ${cond}`,
        `B+Tree h=${s.height} nodes=${s.nodes} order=${s.order}`,
      ],
      children: [],
    }
  }
}

// Index-only (covering) scan: when every column the query needs from a table is
// already stored in the index, we can answer straight from the B+Tree leaves and
// skip the heap fetch entirely. The emitted row *is* the index key tuple.
export class IndexOnlyScan implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private readonly index: IndexHandle
  private readonly lo: RangeBound
  private readonly hi: RangeBound
  private keys: IndexKey[] = []
  private pos = 0

  constructor(index: IndexHandle, schema: Schema, lo: RangeBound, hi: RangeBound, estRows: number) {
    this.index = index
    this.schema = schema
    this.lo = lo
    this.hi = hi
    this.estRows = Math.max(1, Math.round(estRows))
    const h = index.stats().height
    // Cheaper than a heap-fetching IndexScan: no random heap access per row.
    this.estCost = h * CPU_OP + this.estRows * CPU_TUPLE * 0.5
  }
  open() {
    this.keys = this.index.tree.rangeKeys(
      this.lo ? this.lo.key : null,
      this.hi ? this.hi.key : null,
      this.lo ? this.lo.inclusive : true,
      this.hi ? this.hi.inclusive : true,
    )
    this.pos = 0
  }
  next(): Row | null {
    if (this.pos >= this.keys.length) return null
    this.actualRows++
    return this.keys[this.pos++].slice()
  }
  close() {
    this.keys = []
  }
  plan(): PlanNode {
    const s = this.index.stats()
    const bound = (b: RangeBound, sym: string) => (b ? `${sym}${b.inclusive ? '=' : ''} ${fmtKey(b.key)}` : '')
    const cond = [bound(this.lo, '>'), bound(this.hi, '<')].filter(Boolean).join(' AND ') || 'full'
    return {
      op: 'IndexOnlyScan',
      detail: `${this.index.meta.name}`,
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra: [
        `on (${this.index.meta.columns.join(', ')}) ${cond}`,
        'covering: all needed columns come from the index — heap not touched',
        `B+Tree h=${s.height} nodes=${s.nodes} order=${s.order}`,
      ],
      children: [],
    }
  }
}

/** One indexed predicate feeding a bitmap: a range over a single-column index. */
export interface BitmapInput {
  index: IndexHandle
  lo: RangeBound
  hi: RangeBound
}

// Bitmap AND scan: probe several single-column indexes, build a row-id set from
// each, intersect them, then fetch the surviving heap rows in physical order.
// This is how real engines combine independent indexes for a multi-predicate
// filter (`WHERE a = ? AND b = ?`) when no single composite index covers both.
export class BitmapAnd implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private readonly table: Table
  private readonly inputs: BitmapInput[]
  private rows: Row[] = []
  private pos = 0
  private matched = 0

  constructor(table: Table, schema: Schema, inputs: BitmapInput[], estRows: number) {
    this.table = table
    this.schema = schema
    this.inputs = inputs
    this.estRows = Math.max(1, Math.round(estRows))
    const h = Math.max(1, ...inputs.map((i) => i.index.stats().height))
    this.estCost = inputs.length * h * CPU_OP + this.estRows * CPU_TUPLE
  }
  open() {
    let acc: Set<number> | null = null
    for (const inp of this.inputs) {
      const ids = inp.index.tree.range(
        inp.lo ? inp.lo.key : null,
        inp.hi ? inp.hi.key : null,
        inp.lo ? inp.lo.inclusive : true,
        inp.hi ? inp.hi.inclusive : true,
      )
      if (acc === null) {
        acc = new Set(ids)
      } else {
        // Intersect, scanning the (already smaller) accumulator.
        const probe = new Set(ids)
        const next = new Set<number>()
        for (const r of acc) if (probe.has(r)) next.add(r)
        acc = next
      }
    }
    // Fetch in physical (row-id) order — the bitmap heap scan pattern.
    const rowids = acc ? [...acc].sort((a, b) => a - b) : []
    this.matched = rowids.length
    this.rows = []
    for (const rid of rowids) {
      const row = this.table.heap.get(rid)
      if (row) this.rows.push(row)
    }
    this.pos = 0
  }
  next(): Row | null {
    if (this.pos >= this.rows.length) return null
    this.actualRows++
    return this.rows[this.pos++]
  }
  close() {
    this.rows = []
  }
  plan(): PlanNode {
    const children: PlanNode[] = this.inputs.map((inp) => {
      const bound = (b: RangeBound, sym: string) => (b ? `${sym}${b.inclusive ? '=' : ''} ${fmtKey(b.key)}` : '')
      const cond = [bound(inp.lo, '>'), bound(inp.hi, '<')].filter(Boolean).join(' AND ') || 'full'
      return {
        op: 'BitmapIndexScan',
        detail: `${this.table.name} via ${inp.index.meta.name}`,
        estRows: 0,
        estCost: 0,
        actualRows: 0,
        extra: [`on (${inp.index.meta.columns.join(', ')}) ${cond}`],
        children: [],
      }
    })
    return {
      op: 'BitmapAnd',
      detail: this.table.name,
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra: [`intersect ${this.inputs.length} index bitmaps → ${this.matched || this.estRows} rows, then heap-fetch`],
      children,
    }
  }
}

// Bitmap OR scan: union the row-id sets of several index ranges (typically one
// point lookup per value of an `IN (…)` list, or `a = 1 OR a = 2`), then fetch
// the surviving heap rows in physical order. The OR counterpart to BitmapAnd.
export class BitmapOr implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private readonly table: Table
  private readonly inputs: BitmapInput[]
  private readonly label: string
  private rows: Row[] = []
  private pos = 0
  private matched = 0

  constructor(table: Table, schema: Schema, inputs: BitmapInput[], estRows: number, label: string) {
    this.table = table
    this.schema = schema
    this.inputs = inputs
    this.label = label
    this.estRows = Math.max(1, Math.round(estRows))
    const h = Math.max(1, ...inputs.map((i) => i.index.stats().height))
    this.estCost = inputs.length * h * CPU_OP + this.estRows * CPU_TUPLE
  }
  open() {
    const acc = new Set<number>()
    for (const inp of this.inputs) {
      const ids = inp.index.tree.range(
        inp.lo ? inp.lo.key : null,
        inp.hi ? inp.hi.key : null,
        inp.lo ? inp.lo.inclusive : true,
        inp.hi ? inp.hi.inclusive : true,
      )
      for (const id of ids) acc.add(id)
    }
    const rowids = [...acc].sort((a, b) => a - b)
    this.matched = rowids.length
    this.rows = []
    for (const rid of rowids) {
      const row = this.table.heap.get(rid)
      if (row) this.rows.push(row)
    }
    this.pos = 0
  }
  next(): Row | null {
    if (this.pos >= this.rows.length) return null
    this.actualRows++
    return this.rows[this.pos++]
  }
  close() {
    this.rows = []
  }
  plan(): PlanNode {
    return {
      op: 'BitmapOr',
      detail: `${this.table.name} via ${this.inputs[0].index.meta.name}`,
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra: [`union ${this.inputs.length} index lookups (${this.label}) → ${this.matched || this.estRows} rows`],
      children: [],
    }
  }
}

// GIN index scan: walk the (constant) tsquery to a candidate rowid set via the
// inverted index, fetch those heap rows in physical order, and recheck `@@`
// exactly (GIN postings are lossy — they ignore phrase positions and weight
// filters — so the recheck is what makes the answer precise). The query
// determines candidates at open() time, so it always sees the live index.
export class GinScan implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private readonly table: Table
  private readonly gin: GinIndexHandle
  private readonly query: TsQuery
  private readonly colIndex: number
  private rows: Row[] = []
  private pos = 0
  private matched = 0
  private candidateCount = 0
  private scannedAll = false

  constructor(table: Table, schema: Schema, gin: GinIndexHandle, query: TsQuery, colIndex: number, estRows: number) {
    this.table = table
    this.schema = schema
    this.gin = gin
    this.query = query
    this.colIndex = colIndex
    this.estRows = Math.max(1, Math.round(estRows))
    this.estCost = Math.max(1, gin.lexemeCount) * CPU_OP + this.estRows * CPU_TUPLE
  }
  open() {
    const cand = ginCandidates(this.query.node, this.gin)
    let rowids: number[]
    if (cand === null) {
      // The query can't be bounded by the index (e.g. a top-level NOT) — fall
      // back to every row, still rechecking `@@` for a correct answer.
      this.scannedAll = true
      rowids = [...this.table.heap.keys()]
    } else {
      rowids = [...cand].sort((a, b) => a - b)
    }
    this.candidateCount = rowids.length
    this.rows = []
    for (const rid of rowids) {
      const row = this.table.heap.get(rid)
      if (!row) continue
      const cell = row[this.colIndex]
      const vec = cell === null || cell === undefined ? null : asTsVector(cell)
      if (vec && tsMatch(vec, this.query)) this.rows.push(row)
    }
    this.matched = this.rows.length
    this.pos = 0
  }
  next(): Row | null {
    if (this.pos >= this.rows.length) return null
    this.actualRows++
    return this.rows[this.pos++]
  }
  close() {
    this.rows = []
  }
  plan(): PlanNode {
    const cand = this.scannedAll ? `all ${this.candidateCount} rows (unbounded query)` : `${this.candidateCount} candidates`
    return {
      op: 'GinScan',
      detail: `${this.table.name} via ${this.gin.name}`,
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra: [`@@ on ${this.gin.column}: ${cand} → recheck → ${this.matched || this.estRows} rows`],
      children: [],
    }
  }
}

// GIN index scan over an *array* column: probe the inverted index for the search
// element keys, combine the posting lists (AND for `@>`, OR for `&&` / `= ANY`)
// into a candidate rowid set, then recheck the exact predicate on each candidate
// (GIN membership is element-level, so a multi-element `@>` or duplicate handling
// still needs the precise operator to confirm). Mirrors the tsvector GinScan.
export class ArrayGinScan implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private readonly table: Table
  private readonly gin: GinIndexHandle
  private readonly keys: string[]
  private readonly mode: 'and' | 'or'
  private readonly recheck: Evaluator
  private readonly label: string
  private rows: Row[] = []
  private pos = 0
  private matched = 0
  private candidateCount = 0

  constructor(
    table: Table,
    schema: Schema,
    gin: GinIndexHandle,
    keys: string[],
    mode: 'and' | 'or',
    recheck: Evaluator,
    label: string,
    estRows: number,
  ) {
    this.table = table
    this.schema = schema
    this.gin = gin
    this.keys = keys
    this.mode = mode
    this.recheck = recheck
    this.label = label
    this.estRows = Math.max(1, Math.round(estRows))
    this.estCost = Math.max(1, this.keys.length) * CPU_OP + this.estRows * CPU_TUPLE
  }
  private candidates(): Set<number> {
    if (this.keys.length === 0) return new Set()
    if (this.mode === 'or') {
      const out = new Set<number>()
      for (const k of this.keys) {
        const ids = this.gin.exact(k)
        if (ids) for (const id of ids) out.add(id)
      }
      return out
    }
    // AND: start from the smallest posting list and intersect the rest. Any key
    // with no posting list makes the result empty.
    let acc: Set<number> | null = null
    for (const k of this.keys) {
      const ids = this.gin.exact(k)
      if (!ids) return new Set()
      if (acc === null) acc = new Set(ids)
      else for (const id of [...acc]) if (!ids.has(id)) acc.delete(id)
    }
    return acc ?? new Set()
  }
  open() {
    const rowids = [...this.candidates()].sort((a, b) => a - b)
    this.candidateCount = rowids.length
    this.rows = []
    for (const rid of rowids) {
      const row = this.table.heap.get(rid)
      if (row && this.recheck(row) === true) this.rows.push(row)
    }
    this.matched = this.rows.length
    this.pos = 0
  }
  next(): Row | null {
    if (this.pos >= this.rows.length) return null
    this.actualRows++
    return this.rows[this.pos++]
  }
  close() {
    this.rows = []
  }
  plan(): PlanNode {
    return {
      op: 'GinScan',
      detail: `${this.table.name} via ${this.gin.name}`,
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra: [`${this.label} on ${this.gin.column}: ${this.candidateCount} candidates → recheck → ${this.matched || this.estRows} rows`],
      children: [],
    }
  }
}

function keysEqual(a: IndexKey, b: IndexKey): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (orderValues(a[i], b[i]) !== 0) return false
  return true
}
function fmt(v: SqlValue): string {
  if (v === null) return 'NULL'
  if (typeof v === 'string') return `'${v}'`
  if (isTemporal(v)) return `'${formatTemporal(v)}'`
  return String(v)
}
function fmtKey(k: IndexKey): string {
  return k.length === 1 ? fmt(k[0]) : `(${k.map(fmt).join(', ')})`
}

export class Filter implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private readonly child: Operator
  private readonly pred: Evaluator
  private readonly label: string

  constructor(child: Operator, pred: Evaluator, label: string, selectivity = 0.3) {
    this.child = child
    this.pred = pred
    this.label = label
    this.schema = child.schema
    this.estRows = Math.max(1, Math.round(child.estRows * selectivity))
    this.estCost = child.estCost + child.estRows * CPU_OP
  }
  open() {
    this.child.open()
  }
  next(): Row | null {
    for (;;) {
      const row = this.child.next()
      if (row === null) return null
      if (this.pred(row) === true) {
        this.actualRows++
        return row
      }
    }
  }
  close() {
    this.child.close()
  }
  plan(): PlanNode {
    return {
      op: 'Filter',
      detail: this.label,
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra: [],
      children: [this.child.plan()],
    }
  }
}

export class Project implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private readonly child: Operator
  private readonly exprs: Evaluator[]
  private readonly labels: string[]

  constructor(child: Operator, exprs: Evaluator[], schema: Schema, labels: string[]) {
    this.child = child
    this.exprs = exprs
    this.schema = schema
    this.labels = labels
    this.estRows = child.estRows
    this.estCost = child.estCost + child.estRows * exprs.length * CPU_OP
  }
  open() {
    this.child.open()
  }
  next(): Row | null {
    const row = this.child.next()
    if (row === null) return null
    this.actualRows++
    return this.exprs.map((e) => e(row))
  }
  close() {
    this.child.close()
  }
  plan(): PlanNode {
    return {
      op: 'Project',
      detail: this.labels.join(', '),
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra: [],
      children: [this.child.plan()],
    }
  }
}

export type JoinExecType = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS'

export class NestedLoopJoin implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private readonly left: Operator
  private readonly right: Operator
  private readonly pred: Evaluator | null
  private readonly joinType: JoinExecType
  private readonly leftWidth: number
  private readonly rightWidth: number
  private rows: Row[] = []
  private pos = 0

  constructor(
    left: Operator,
    right: Operator,
    pred: Evaluator | null,
    joinType: JoinExecType,
    schema: Schema,
    estRows?: number,
  ) {
    this.left = left
    this.right = right
    this.pred = pred
    this.joinType = joinType
    this.schema = schema
    this.leftWidth = left.schema.length
    this.rightWidth = right.schema.length
    this.estRows =
      estRows !== undefined
        ? Math.max(1, Math.round(estRows))
        : joinType === 'CROSS'
          ? left.estRows * right.estRows
          : Math.max(left.estRows, left.estRows * right.estRows * 0.3)
    this.estCost = left.estCost + left.estRows * right.estCost + left.estRows * right.estRows * CPU_OP
  }
  open() {
    const rightRows = drain(this.right)
    const leftRows = drain(this.left)
    const emitLeftNull = this.joinType === 'LEFT' || this.joinType === 'FULL'
    const emitRightNull = this.joinType === 'RIGHT' || this.joinType === 'FULL'
    const rightMatched = new Array(rightRows.length).fill(false)
    const out: Row[] = []
    for (const l of leftRows) {
      let matched = false
      for (let j = 0; j < rightRows.length; j++) {
        const combined = l.concat(rightRows[j])
        if (this.pred === null || this.pred(combined) === true) {
          matched = true
          rightMatched[j] = true
          out.push(combined)
        }
      }
      if (!matched && emitLeftNull) out.push(l.concat(new Array(this.rightWidth).fill(null)))
    }
    if (emitRightNull) {
      const leftNulls = new Array(this.leftWidth).fill(null)
      for (let j = 0; j < rightRows.length; j++) {
        if (!rightMatched[j]) out.push(leftNulls.concat(rightRows[j]))
      }
    }
    this.rows = out
    this.pos = 0
  }
  next(): Row | null {
    if (this.pos >= this.rows.length) return null
    this.actualRows++
    return this.rows[this.pos++]
  }
  close() {
    this.rows = []
  }
  plan(): PlanNode {
    return {
      op: this.joinType === 'CROSS' ? 'CrossJoin' : `NestedLoopJoin (${this.joinType})`,
      detail: '',
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra: ['rows are re-scanned for each outer row'],
      children: [this.left.plan(), this.right.plan()],
    }
  }
}

// An index nested-loop join: for each outer (left) row, probe a B+Tree on the
// inner table's join column and fetch the matching inner rows, instead of
// building a whole hash table. This is the textbook win when the outer side is
// tiny (a selective driver) and the inner side is large but indexed on the key —
// the cost is ~|outer| index descents rather than a scan-and-build of |inner|.
// Supports INNER and LEFT (the left/outer side is the preserved one).
export class IndexNestedLoopJoin implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private readonly left: Operator
  private readonly innerTable: Table
  private readonly index: IndexHandle
  private readonly leftKey: Evaluator
  private readonly joinType: 'INNER' | 'LEFT'
  private readonly innerWidth: number
  private rows: Row[] = []
  private pos = 0
  private probes = 0

  constructor(
    left: Operator,
    innerTable: Table,
    index: IndexHandle,
    leftKey: Evaluator,
    joinType: 'INNER' | 'LEFT',
    schema: Schema,
    innerWidth: number,
    estRows?: number,
  ) {
    this.left = left
    this.innerTable = innerTable
    this.index = index
    this.leftKey = leftKey
    this.joinType = joinType
    this.schema = schema
    this.innerWidth = innerWidth
    this.estRows = estRows !== undefined ? Math.max(1, Math.round(estRows)) : Math.max(left.estRows, 1)
    const h = Math.max(1, index.stats().height)
    // Per outer row: one B+Tree descent plus a fetch of the matched inner rows.
    const matchPerProbe = Math.max(1, this.estRows / Math.max(1, left.estRows))
    this.estCost = left.estCost + left.estRows * (h * CPU_OP + matchPerProbe * CPU_TUPLE)
  }
  open() {
    const out: Row[] = []
    const emitNull = this.joinType === 'LEFT'
    this.probes = 0
    this.left.open()
    try {
      for (let l = this.left.next(); l !== null; l = this.left.next()) {
        const k = this.leftKey(l)
        let matched = false
        if (k !== null) {
          this.probes++
          // Exact-match probe: range [k, k] inclusive over the inner index.
          for (const rid of this.index.tree.range([k], [k], true, true)) {
            const innerRow = this.innerTable.heap.get(rid)
            if (innerRow) {
              matched = true
              out.push(l.concat(innerRow))
            }
          }
        }
        if (!matched && emitNull) out.push(l.concat(new Array(this.innerWidth).fill(null)))
      }
    } finally {
      this.left.close()
    }
    this.rows = out
    this.pos = 0
  }
  next(): Row | null {
    if (this.pos >= this.rows.length) return null
    this.actualRows++
    return this.rows[this.pos++]
  }
  close() {
    this.rows = []
  }
  plan(): PlanNode {
    const s = this.index.stats()
    const innerNode: PlanNode = {
      op: 'IndexProbe',
      detail: `${this.innerTable.name} via ${this.index.meta.name}`,
      estRows: Math.max(1, Math.round(this.estRows / Math.max(1, this.left.estRows))),
      estCost: 0,
      actualRows: 0,
      extra: [`on (${this.index.meta.columns.join(', ')}) = outer key`, `B+Tree h=${s.height}`],
      children: [],
    }
    return {
      op: `IndexNestedLoopJoin (${this.joinType})`,
      detail: '',
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra: [`probe the inner index once per outer row (${this.probes || Math.round(this.left.estRows)} probes)`],
      children: [this.left.plan(), innerNode],
    }
  }
}

/**
 * A LATERAL join: the right side may reference the left side's columns, so it is
 * re-evaluated once per left row (a correlated nested loop). `buildRight(leftRow)`
 * produces the right rows for one outer row — for a LATERAL subquery it re-runs a
 * correlated plan; for a LATERAL table function it re-evaluates the function's
 * arguments against the outer row. An INNER lateral drops outer rows with no
 * right match; a LEFT one null-extends them.
 */
export class LateralJoin implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private rows: Row[] = []
  private pos = 0
  private readonly left: Operator
  private readonly rightWidth: number
  private readonly buildRight: (leftRow: Row) => Row[]
  private readonly pred: Evaluator | null
  private readonly leftJoin: boolean
  private readonly rightLabel: string

  constructor(
    left: Operator,
    rightWidth: number,
    buildRight: (leftRow: Row) => Row[],
    pred: Evaluator | null,
    leftJoin: boolean,
    schema: Schema,
    rightLabel: string,
  ) {
    this.left = left
    this.rightWidth = rightWidth
    this.buildRight = buildRight
    this.pred = pred
    this.leftJoin = leftJoin
    this.rightLabel = rightLabel
    this.schema = schema
    // No statistics for the correlated side; assume a small fan-out.
    this.estRows = Math.max(left.estRows, left.estRows * 4)
    this.estCost = left.estCost + left.estRows * 8 * CPU_OP
  }
  open() {
    const out: Row[] = []
    const leftRows = drain(this.left)
    for (const l of leftRows) {
      let matched = false
      for (const r of this.buildRight(l)) {
        const combined = l.concat(r)
        if (this.pred === null || this.pred(combined) === true) {
          matched = true
          out.push(combined)
        }
      }
      if (!matched && this.leftJoin) out.push(l.concat(new Array(this.rightWidth).fill(null)))
    }
    this.rows = out
    this.pos = 0
  }
  next(): Row | null {
    if (this.pos >= this.rows.length) return null
    this.actualRows++
    return this.rows[this.pos++]
  }
  close() {
    this.rows = []
  }
  plan(): PlanNode {
    return {
      op: `LateralJoin (${this.leftJoin ? 'LEFT' : 'INNER'})`,
      detail: this.rightLabel,
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra: ['right side re-evaluated per outer row'],
      children: [this.left.plan()],
    }
  }
}

/** A keyed row: the row plus the canonical hash of its (single-column) join key.
 *  NULL-key rows are excluded — they can never participate in an equijoin. */
interface Keyed {
  r: Row
  hk: string
}
const GRACE_MAX_DEPTH = 6

export class HashJoin implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private readonly left: Operator
  private readonly right: Operator
  private readonly leftKey: Evaluator
  private readonly rightKey: Evaluator
  private readonly joinType: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL'
  private readonly leftWidth: number
  private readonly rightWidth: number
  private readonly workMem: number
  private rows: Row[] = []
  private pos = 0
  private buildSize = 0
  // Spill diagnostics surfaced in EXPLAIN / the Execution Lab.
  private grace = false
  private peakRows = 0
  private spilledRows = 0
  private partitions = 0
  private passes = 1
  private opened = false

  constructor(
    left: Operator,
    right: Operator,
    leftKey: Evaluator,
    rightKey: Evaluator,
    joinType: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL',
    schema: Schema,
    estRows?: number,
    workMem?: number,
  ) {
    this.left = left
    this.right = right
    this.leftKey = leftKey
    this.rightKey = rightKey
    this.joinType = joinType
    this.schema = schema
    this.leftWidth = left.schema.length
    this.rightWidth = right.schema.length
    this.workMem = workMem ?? DEFAULT_WORK_MEM
    this.estRows = estRows !== undefined ? Math.max(1, Math.round(estRows)) : Math.max(left.estRows, right.estRows)
    this.estCost = left.estCost + right.estCost + (left.estRows + right.estRows) * CPU_OP
  }
  open() {
    this.opened = true
    const rightRows = drain(this.right)
    const leftRows = drain(this.left)
    this.buildSize = rightRows.length
    const emitLeftNull = this.joinType === 'LEFT' || this.joinType === 'FULL'
    const emitRightNull = this.joinType === 'RIGHT' || this.joinType === 'FULL'
    const rNull = new Array(this.rightWidth).fill(null)
    const lNull = new Array(this.leftWidth).fill(null)
    const out: Row[] = []
    this.grace = rightRows.length > this.workMem
    this.peakRows = 0
    this.spilledRows = 0
    this.partitions = 0
    this.passes = 1

    if (!this.grace) {
      // --- in-memory hash join (the build side fits work_mem) -----------------
      // Identical to the classic single-pass algorithm: build on the right
      // (NULL keys kept so RIGHT/FULL can still emit them), probe with the left
      // in order, then trail the unmatched right rows. This path is byte-for-byte
      // what the engine did before work_mem existed.
      this.peakRows = rightRows.length
      const table = new Map<string, number[]>()
      rightRows.forEach((r, i) => {
        const k = this.rightKey(r)
        if (k === null) return
        const key = hashKey([k])
        const arr = table.get(key)
        if (arr) arr.push(i)
        else table.set(key, [i])
      })
      const rightMatched = new Array(rightRows.length).fill(false)
      for (const l of leftRows) {
        const k = this.leftKey(l)
        const bucket = k === null ? undefined : table.get(hashKey([k]))
        if (bucket && bucket.length) {
          for (const j of bucket) {
            rightMatched[j] = true
            out.push(l.concat(rightRows[j]))
          }
        } else if (emitLeftNull) {
          out.push(l.concat(rNull))
        }
      }
      if (emitRightNull) {
        rightRows.forEach((r, j) => {
          if (!rightMatched[j]) out.push(lNull.concat(r))
        })
      }
      this.rows = out
      this.pos = 0
      return
    }

    // --- Grace hash join (the build side overflows work_mem) ------------------
    // Split off NULL-key rows: `x = NULL` is unknown, so they never match; they
    // still surface as unmatched rows for the preserved side of an outer join.
    const L: Keyed[] = []
    const R: Keyed[] = []
    for (const l of leftRows) {
      const k = this.leftKey(l)
      if (k === null) {
        if (emitLeftNull) out.push(l.concat(rNull))
      } else L.push({ r: l, hk: hashKey([k]) })
    }
    for (const r of rightRows) {
      const k = this.rightKey(r)
      if (k === null) {
        if (emitRightNull) out.push(lNull.concat(r))
      } else R.push({ r, hk: hashKey([k]) })
    }
    this.joinPart(L, R, 0, emitLeftNull, emitRightNull, rNull, lNull, out)

    this.rows = out
    this.pos = 0
  }
  /** Recursive Grace hash join: build the right side in memory once it fits the
   *  budget, else partition both inputs by a salted hash of the key and recurse.
   *  Equal keys hash identically, so a group never spans partitions — every
   *  match (and every outer-join non-match) is found within one partition. */
  private joinPart(
    L: Keyed[],
    R: Keyed[],
    depth: number,
    emitLeftNull: boolean,
    emitRightNull: boolean,
    rNull: SqlValue[],
    lNull: SqlValue[],
    out: Row[],
  ): void {
    if (R.length <= this.workMem || depth >= GRACE_MAX_DEPTH) {
      // In-memory hash join: build on the (now budget-sized) right partition.
      this.peakRows = Math.max(this.peakRows, R.length)
      const table = new Map<string, number[]>()
      R.forEach((r, i) => {
        const arr = table.get(r.hk)
        if (arr) arr.push(i)
        else table.set(r.hk, [i])
      })
      const matched = emitRightNull ? new Array(R.length).fill(false) : null
      for (const l of L) {
        const bucket = table.get(l.hk)
        if (bucket && bucket.length) {
          for (const j of bucket) {
            if (matched) matched[j] = true
            out.push(l.r.concat(R[j].r))
          }
        } else if (emitLeftNull) {
          out.push(l.r.concat(rNull))
        }
      }
      if (matched) {
        for (let j = 0; j < R.length; j++) if (!matched[j]) out.push(lNull.concat(R[j].r))
      }
      return
    }
    // Partition both sides and recurse — the build side doesn't fit in work_mem.
    const P = Math.min(64, Math.max(2, Math.ceil(R.length / Math.max(1, this.workMem))))
    this.partitions = Math.max(this.partitions, P)
    this.passes = Math.max(this.passes, depth + 2)
    this.spilledRows += L.length + R.length
    const lp: Keyed[][] = Array.from({ length: P }, () => [])
    const rp: Keyed[][] = Array.from({ length: P }, () => [])
    for (const l of L) lp[spillHash(l.hk, depth + 1) % P].push(l)
    for (const r of R) rp[spillHash(r.hk, depth + 1) % P].push(r)
    for (let p = 0; p < P; p++) {
      if (rp[p].length === 0 && lp[p].length === 0) continue
      this.joinPart(lp[p], rp[p], depth + 1, emitLeftNull, emitRightNull, rNull, lNull, out)
    }
  }
  next(): Row | null {
    if (this.pos >= this.rows.length) return null
    this.actualRows++
    return this.rows[this.pos++]
  }
  close() {
    this.rows = []
  }
  plan(): PlanNode {
    const willSpill = this.right.estRows > this.workMem
    const measured = this.opened
    const grace = measured ? this.grace : willSpill
    const extra = grace
      ? measured
        ? [`grace hash join: ${this.partitions} partitions, ${this.passes} pass(es), spilled ${this.spilledRows} rows (work_mem ${this.workMem})`]
        : [`grace hash join (build ${this.right.estRows} rows > work_mem ${this.workMem})`]
      : [`build hash table on right input (${this.buildSize || this.right.estRows} rows)`]
    const mem: MemStats = {
      method: grace ? 'grace hash join' : 'in-memory hash',
      budget: this.workMem,
      peakRows: measured ? this.peakRows : Math.min(this.right.estRows, this.workMem),
      spilledRows: measured ? this.spilledRows : grace ? this.right.estRows : 0,
      partitions: grace ? (measured ? this.partitions : Math.ceil(this.right.estRows / Math.max(1, this.workMem))) : undefined,
      passes: measured ? this.passes : grace ? 2 : 1,
      measured,
    }
    return {
      op: `HashJoin (${this.joinType})`,
      detail: '',
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra,
      children: [this.left.plan(), this.right.plan()],
      mem,
    }
  }
}

// A semi-/anti-join: emit each LEFT row at most once, depending on whether a
// matching RIGHT row exists. This is what a correlated `[NOT] EXISTS (…)` (and
// some IN-subqueries) decorrelate to — instead of re-running the subquery per
// outer row, we build the inner side once into a hash set of key tuples and
// probe it. The RIGHT operator yields exactly the inner key columns (in the same
// order as `leftKeys`). NULL keys never match — exactly EXISTS / NOT EXISTS
// semantics (`x = NULL` is unknown). With no keys at all (an uncorrelated
// EXISTS) the test degrades to "is the inner side non-empty?".
export class HashSemiJoin implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private readonly left: Operator
  private readonly right: Operator
  private readonly leftKeys: Evaluator[]
  private readonly anti: boolean
  private rows: Row[] = []
  private pos = 0
  private buildSize = 0

  constructor(left: Operator, right: Operator, leftKeys: Evaluator[], anti: boolean, schema: Schema) {
    this.left = left
    this.right = right
    this.leftKeys = leftKeys
    this.anti = anti
    this.schema = schema
    // A semi-join can at most pass everything through; an anti-join too. Use the
    // left estimate, halved for the typical selectivity of an existence filter.
    this.estRows = Math.max(1, Math.round(left.estRows / 2))
    this.estCost = left.estCost + right.estCost + (left.estRows + right.estRows) * CPU_OP
  }
  open() {
    const innerRows = drain(this.right)
    this.buildSize = innerRows.length
    const keyed = this.leftKeys.length > 0
    const set = new Set<string>()
    if (keyed) {
      for (const r of innerRows) {
        if (r.some((v) => v === null)) continue // a NULL key never matches
        set.add(hashKey(r))
      }
    }
    const innerNonEmpty = innerRows.length > 0
    const out: Row[] = []
    for (const l of drain(this.left)) {
      let match: boolean
      if (!keyed) {
        match = innerNonEmpty
      } else {
        const k = this.leftKeys.map((fn) => fn(l))
        match = k.some((v) => v === null) ? false : set.has(hashKey(k))
      }
      if (this.anti ? !match : match) out.push(l)
    }
    this.rows = out
    this.pos = 0
  }
  next(): Row | null {
    if (this.pos >= this.rows.length) return null
    this.actualRows++
    return this.rows[this.pos++]
  }
  close() {
    this.rows = []
  }
  plan(): PlanNode {
    const kind = this.anti ? 'AntiJoin (hash)' : 'SemiJoin (hash)'
    const detail = this.leftKeys.length ? `${this.leftKeys.length} key${this.leftKeys.length === 1 ? '' : 's'}` : 'uncorrelated'
    return {
      op: kind,
      detail,
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra: [`build set on inner keys (${this.buildSize} rows)`, this.anti ? 'keep left rows with NO match' : 'keep left rows WITH a match'],
      children: [this.left.plan(), this.right.plan()],
    }
  }
}

// Sort–merge join: sort both inputs on the join key, then sweep them in lockstep
// emitting matches for each equal-key block. An alternative to HashJoin that the
// planner picks when its cost model prefers it (typically large, comparably
// sized inputs). Handles duplicate keys via block cross-products and supports
// every outer-join flavour.
export class MergeJoin implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private readonly left: Operator
  private readonly right: Operator
  private readonly leftKey: Evaluator
  private readonly rightKey: Evaluator
  private readonly joinType: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL'
  private readonly leftWidth: number
  private readonly rightWidth: number
  private rows: Row[] = []
  private pos = 0

  constructor(
    left: Operator,
    right: Operator,
    leftKey: Evaluator,
    rightKey: Evaluator,
    joinType: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL',
    schema: Schema,
    estRows?: number,
  ) {
    this.left = left
    this.right = right
    this.leftKey = leftKey
    this.rightKey = rightKey
    this.joinType = joinType
    this.schema = schema
    this.leftWidth = left.schema.length
    this.rightWidth = right.schema.length
    this.estRows = estRows !== undefined ? Math.max(1, Math.round(estRows)) : Math.max(left.estRows, right.estRows)
    const nl = Math.max(1, left.estRows)
    const nr = Math.max(1, right.estRows)
    this.estCost =
      left.estCost +
      right.estCost +
      (nl * Math.log2(nl + 1) + nr * Math.log2(nr + 1)) * CPU_OP +
      (nl + nr) * CPU_OP
  }
  open() {
    const L = drain(this.left).map((r) => ({ r, k: this.leftKey(r) }))
    const R = drain(this.right).map((r) => ({ r, k: this.rightKey(r) }))
    L.sort((a, b) => orderValues(a.k, b.k))
    R.sort((a, b) => orderValues(a.k, b.k))
    const emitLeftNull = this.joinType === 'LEFT' || this.joinType === 'FULL'
    const emitRightNull = this.joinType === 'RIGHT' || this.joinType === 'FULL'
    const rNull = new Array(this.rightWidth).fill(null)
    const lNull = new Array(this.leftWidth).fill(null)
    const out: Row[] = []
    let i = 0
    let j = 0
    while (i < L.length && j < R.length) {
      const lk = L[i].k
      const rk = R[j].k
      // NULL keys never participate in an equijoin match.
      if (lk === null) {
        if (emitLeftNull) out.push(L[i].r.concat(rNull))
        i++
        continue
      }
      if (rk === null) {
        if (emitRightNull) out.push(lNull.concat(R[j].r))
        j++
        continue
      }
      const c = orderValues(lk, rk)
      if (c < 0) {
        if (emitLeftNull) out.push(L[i].r.concat(rNull))
        i++
      } else if (c > 0) {
        if (emitRightNull) out.push(lNull.concat(R[j].r))
        j++
      } else {
        let i2 = i
        while (i2 < L.length && L[i2].k !== null && orderValues(L[i2].k, lk) === 0) i2++
        let j2 = j
        while (j2 < R.length && R[j2].k !== null && orderValues(R[j2].k, rk) === 0) j2++
        for (let a = i; a < i2; a++) for (let b = j; b < j2; b++) out.push(L[a].r.concat(R[b].r))
        i = i2
        j = j2
      }
    }
    while (i < L.length) {
      if (emitLeftNull) out.push(L[i].r.concat(rNull))
      i++
    }
    while (j < R.length) {
      if (emitRightNull) out.push(lNull.concat(R[j].r))
      j++
    }
    this.rows = out
    this.pos = 0
  }
  next(): Row | null {
    if (this.pos >= this.rows.length) return null
    this.actualRows++
    return this.rows[this.pos++]
  }
  close() {
    this.rows = []
  }
  plan(): PlanNode {
    return {
      op: `MergeJoin (${this.joinType})`,
      detail: '',
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra: ['sort both inputs on the join key, then merge'],
      children: [this.left.plan(), this.right.plan()],
    }
  }
}

export interface SortKey {
  eval: Evaluator
  dir: 'ASC' | 'DESC'
}

// Rows-per-sorted-run before the Sort spills to an external (run-generating)
// merge sort. Small inputs sort in one pass; larger ones are split into sorted
// runs that are then k-way merged — the classic external-sort algorithm, here
// reported in EXPLAIN so you can watch it kick in. The effective run size is
// capped by `work_mem`, so lowering the budget produces more, smaller runs.
const SORT_RUN_SIZE = 1024

export class Sort implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private readonly child: Operator
  private readonly keys: SortKey[]
  /** Top-N bound: rows to retain (LIMIT + OFFSET), or undefined for a full sort. */
  private readonly topN: number | undefined
  private readonly workMem: number
  private rows: Row[] = []
  private pos = 0
  // Diagnostics surfaced in EXPLAIN / the Execution Lab.
  private runs = 1
  private passes = 0
  private method: 'in-memory' | 'external' | 'topN' = 'in-memory'
  private peakRows = 0
  private spilledRows = 0
  private inputRows = 0
  private opened = false

  constructor(child: Operator, keys: SortKey[], opts?: { limit?: number; workMem?: number }) {
    this.child = child
    this.keys = keys
    this.topN = opts?.limit
    this.workMem = opts?.workMem ?? DEFAULT_WORK_MEM
    this.schema = child.schema
    this.estRows = this.topN !== undefined ? Math.min(child.estRows, this.topN) : child.estRows
    const n = Math.max(1, child.estRows)
    // A bounded top-N sort costs n·log(k), not n·log(n).
    const sortFactor = this.topN !== undefined ? Math.log2(Math.max(2, this.topN)) : Math.log2(n + 1)
    this.estCost = child.estCost + n * sortFactor * CPU_OP
  }
  private cmp = (a: Row, b: Row): number => {
    for (const k of this.keys) {
      const c = orderValues(k.eval(a), k.eval(b))
      if (c !== 0) return k.dir === 'ASC' ? c : -c
    }
    return 0
  }
  private runSize(): number {
    return Math.max(1, Math.min(SORT_RUN_SIZE, this.workMem))
  }
  open() {
    this.opened = true
    this.child.open()
    const input: Row[] = []
    for (let r = this.child.next(); r !== null; r = this.child.next()) input.push(r)
    this.child.close()
    this.inputRows = input.length

    // --- top-N heapsort ------------------------------------------------------
    // When a LIMIT bounds the sort, keep only the k smallest rows in a bounded
    // max-heap (O(k) memory) instead of sorting everything. The result is
    // provably identical to a stable full sort then slice: ties break on input
    // position, so the same k rows survive in the same order.
    if (this.topN !== undefined && this.topN < input.length) {
      this.method = 'topN'
      this.rows = topNSort(input, this.cmp, this.topN)
      this.peakRows = this.topN
      this.spilledRows = 0
      this.runs = 1
      this.passes = 1
      this.pos = 0
      return
    }

    const runSize = this.runSize()
    if (input.length <= runSize) {
      input.sort(this.cmp)
      this.rows = input
      this.method = 'in-memory'
      this.runs = 1
      this.passes = 1
      this.peakRows = input.length
      this.spilledRows = 0
      this.pos = 0
      return
    }

    // --- external merge sort -------------------------------------------------
    this.method = 'external'
    // Pass 0: cut the input into work_mem-sized runs and sort each in place.
    let runs: Row[][] = []
    for (let i = 0; i < input.length; i += runSize) {
      const run = input.slice(i, i + runSize)
      run.sort(this.cmp)
      runs.push(run)
    }
    this.runs = runs.length
    let passes = 1
    // Merge passes: pairwise (binary) merge until a single run remains.
    while (runs.length > 1) {
      const next: Row[][] = []
      for (let i = 0; i < runs.length; i += 2) {
        if (i + 1 < runs.length) next.push(mergeRuns(runs[i], runs[i + 1], this.cmp))
        else next.push(runs[i])
      }
      runs = next
      passes++
    }
    this.passes = passes
    this.peakRows = runSize
    this.spilledRows = input.length
    this.rows = runs[0] ?? []
    this.pos = 0
  }
  next(): Row | null {
    if (this.pos >= this.rows.length) return null
    this.actualRows++
    return this.rows[this.pos++]
  }
  close() {
    this.rows = []
  }
  plan(): PlanNode {
    const runSize = this.runSize()
    // When EXPLAIN hasn't executed us, predict the algorithm from the estimate.
    const predTopN = this.topN !== undefined && this.topN < this.child.estRows
    const predExternal = !predTopN && this.child.estRows > runSize
    const method = this.opened ? this.method : predTopN ? 'topN' : predExternal ? 'external' : 'in-memory'
    const extra: string[] = []
    const mem: MemStats = {
      method:
        method === 'topN'
          ? 'top-N heapsort'
          : method === 'external'
            ? 'external merge sort'
            : 'quicksort (in memory)',
      budget: this.workMem,
      peakRows: this.opened ? this.peakRows : method === 'topN' ? (this.topN ?? 0) : method === 'external' ? runSize : this.child.estRows,
      spilledRows: this.opened ? this.spilledRows : method === 'external' ? this.child.estRows : 0,
      passes: this.opened ? this.passes : method === 'external' ? Math.ceil(Math.log2(Math.max(2, this.child.estRows / runSize))) + 1 : 1,
      measured: this.opened,
    }
    if (method === 'topN') {
      extra.push(this.opened ? `top-N heapsort: kept ${this.topN} of ${this.inputRows} rows (heap of ${this.topN})` : `top-N heapsort (keep ${this.topN})`)
    } else if (method === 'external') {
      extra.push(
        this.opened
          ? `external merge sort: ${this.runs} runs, ${this.passes} passes (run size ${runSize}, work_mem ${this.workMem})`
          : `external merge sort (est. ${Math.ceil(this.child.estRows / runSize)} runs, run size ${runSize})`,
      )
    } else {
      extra.push('in-memory sort')
    }
    return {
      op: 'Sort',
      detail: this.keys.map((_, i) => `key${i}`).join(', '),
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra,
      children: [this.child.plan()],
      mem,
    }
  }
}

/** Keep the `k` smallest rows under `cmp` (ties broken by original input
 *  position) and return them sorted ascending. A bounded max-heap gives O(n·log k)
 *  time and O(k) memory; the result equals a stable full sort then `slice(0, k)`. */
function topNSort(input: Row[], cmp: (a: Row, b: Row) => number, k: number): Row[] {
  // worse(a, b) > 0 ⇒ a should be evicted before b (a sorts later / has a larger
  // original index among ties), so the heap root is always the current "worst".
  const worse = (a: { r: Row; i: number }, b: { r: Row; i: number }): number => {
    const c = cmp(a.r, b.r)
    return c !== 0 ? c : a.i - b.i
  }
  const heap: { r: Row; i: number }[] = []
  const siftUp = (n: number) => {
    while (n > 0) {
      const p = (n - 1) >> 1
      if (worse(heap[n], heap[p]) <= 0) break
      ;[heap[n], heap[p]] = [heap[p], heap[n]]
      n = p
    }
  }
  const siftDown = (n: number) => {
    const len = heap.length
    for (;;) {
      let largest = n
      const l = 2 * n + 1
      const r = 2 * n + 2
      if (l < len && worse(heap[l], heap[largest]) > 0) largest = l
      if (r < len && worse(heap[r], heap[largest]) > 0) largest = r
      if (largest === n) break
      ;[heap[n], heap[largest]] = [heap[largest], heap[n]]
      n = largest
    }
  }
  for (let i = 0; i < input.length; i++) {
    const item = { r: input[i], i }
    if (heap.length < k) {
      heap.push(item)
      siftUp(heap.length - 1)
    } else if (worse(item, heap[0]) < 0) {
      // The new row is better than the current worst — it belongs in the top k.
      heap[0] = item
      siftDown(0)
    }
  }
  return heap.sort(worse).map((x) => x.r)
}

/** Stable merge of two already-sorted runs. */
function mergeRuns(a: Row[], b: Row[], cmp: (x: Row, y: Row) => number): Row[] {
  const out: Row[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (cmp(a[i], b[j]) <= 0) out.push(a[i++])
    else out.push(b[j++])
  }
  while (i < a.length) out.push(a[i++])
  while (j < b.length) out.push(b[j++])
  return out
}

export class Distinct implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private readonly child: Operator
  private seen = new Set<string>()

  constructor(child: Operator) {
    this.child = child
    this.schema = child.schema
    this.estRows = Math.max(1, Math.round(child.estRows * 0.7))
    this.estCost = child.estCost + child.estRows * CPU_OP
  }
  open() {
    this.child.open()
    this.seen = new Set()
  }
  next(): Row | null {
    for (;;) {
      const row = this.child.next()
      if (row === null) return null
      const key = hashKey(row)
      if (this.seen.has(key)) continue
      this.seen.add(key)
      this.actualRows++
      return row
    }
  }
  close() {
    this.child.close()
    this.seen = new Set()
  }
  plan(): PlanNode {
    return {
      op: 'Distinct',
      detail: '',
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra: [],
      children: [this.child.plan()],
    }
  }
}

export type SetOpKind = 'UNION' | 'INTERSECT' | 'EXCEPT'

// Set operations with full multiset (ALL) and set (DISTINCT) semantics.
export class SetOpExec implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private readonly left: Operator
  private readonly right: Operator
  private readonly op: SetOpKind
  private readonly all: boolean
  private rows: Row[] = []
  private pos = 0

  constructor(left: Operator, right: Operator, op: SetOpKind, all: boolean, schema: Schema) {
    this.left = left
    this.right = right
    this.op = op
    this.all = all
    this.schema = schema
    this.estRows = op === 'UNION' ? left.estRows + right.estRows : left.estRows
    this.estCost = left.estCost + right.estCost + (left.estRows + right.estRows) * CPU_OP
  }
  open() {
    const l = drain(this.left)
    const r = drain(this.right)
    this.rows = this.combine(l, r)
    this.pos = 0
  }
  private combine(l: Row[], r: Row[]): Row[] {
    if (this.op === 'UNION') {
      const merged = l.concat(r)
      return this.all ? merged : dedupe(merged)
    }
    // Count occurrences on the right for INTERSECT / EXCEPT.
    const rCounts = new Map<string, number>()
    for (const row of r) {
      const k = hashKey(row)
      rCounts.set(k, (rCounts.get(k) ?? 0) + 1)
    }
    if (this.op === 'EXCEPT') {
      return this.all ? exceptAll(l, rCounts) : exceptDistinct(l, rCounts)
    }
    // INTERSECT
    const out: Row[] = []
    const taken = new Map<string, number>()
    for (const row of l) {
      const k = hashKey(row)
      const avail = rCounts.get(k) ?? 0
      const used = taken.get(k) ?? 0
      if (used >= avail) continue
      if (!this.all && used >= 1) continue // distinct: at most one
      out.push(row)
      taken.set(k, used + 1)
    }
    return out
  }
  next(): Row | null {
    if (this.pos >= this.rows.length) return null
    this.actualRows++
    return this.rows[this.pos++]
  }
  close() {
    this.rows = []
  }
  plan(): PlanNode {
    return {
      op: `${this.op}${this.all ? ' ALL' : ''}`,
      detail: '',
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra: [this.all ? 'multiset semantics' : 'distinct result'],
      children: [this.left.plan(), this.right.plan()],
    }
  }
}

function drain(op: Operator): Row[] {
  const rows: Row[] = []
  op.open()
  try {
    for (let r = op.next(); r !== null; r = op.next()) rows.push(r)
  } finally {
    op.close()
  }
  return rows
}
function dedupe(rows: Row[]): Row[] {
  const seen = new Set<string>()
  const out: Row[] = []
  for (const row of rows) {
    const k = hashKey(row)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(row)
    }
  }
  return out
}
// EXCEPT ALL: each left row is kept unless it is "cancelled" by a matching
// right row (multiset difference).
function exceptAll(l: Row[], rCounts: Map<string, number>): Row[] {
  const used = new Map<string, number>()
  const out: Row[] = []
  for (const row of l) {
    const k = hashKey(row)
    const avail = rCounts.get(k) ?? 0
    const taken = used.get(k) ?? 0
    if (taken < avail) {
      used.set(k, taken + 1)
    } else {
      out.push(row)
    }
  }
  return out
}
// EXCEPT (distinct): distinct left rows that do not appear on the right.
function exceptDistinct(l: Row[], rCounts: Map<string, number>): Row[] {
  const emitted = new Set<string>()
  const out: Row[] = []
  for (const row of l) {
    const k = hashKey(row)
    if ((rCounts.get(k) ?? 0) > 0) continue
    if (emitted.has(k)) continue
    emitted.add(k)
    out.push(row)
  }
  return out
}

export class Limit implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private readonly child: Operator
  private readonly limit: number
  private readonly offset: number
  private emitted = 0
  private skipped = 0

  constructor(child: Operator, limit: number, offset: number) {
    this.child = child
    this.limit = limit
    this.offset = offset
    this.schema = child.schema
    this.estRows = Math.min(child.estRows, limit)
    this.estCost = child.estCost
  }
  open() {
    this.child.open()
    this.emitted = 0
    this.skipped = 0
  }
  next(): Row | null {
    while (this.skipped < this.offset) {
      if (this.child.next() === null) return null
      this.skipped++
    }
    if (this.emitted >= this.limit) return null
    const row = this.child.next()
    if (row === null) return null
    this.emitted++
    this.actualRows++
    return row
  }
  close() {
    this.child.close()
  }
  plan(): PlanNode {
    return {
      op: 'Limit',
      detail: `limit ${this.limit}${this.offset ? ` offset ${this.offset}` : ''}`,
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra: [],
      children: [this.child.plan()],
    }
  }
}
