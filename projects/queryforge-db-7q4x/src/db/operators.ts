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

export interface PlanNode {
  op: string
  detail: string
  estRows: number
  estCost: number
  actualRows: number
  extra: string[]
  children: PlanNode[]
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
  private readonly table: Table
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

  constructor(left: Operator, right: Operator, pred: Evaluator | null, joinType: JoinExecType, schema: Schema) {
    this.left = left
    this.right = right
    this.pred = pred
    this.joinType = joinType
    this.schema = schema
    this.leftWidth = left.schema.length
    this.rightWidth = right.schema.length
    this.estRows =
      joinType === 'CROSS' ? left.estRows * right.estRows : Math.max(left.estRows, left.estRows * right.estRows * 0.3)
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
  private rows: Row[] = []
  private pos = 0
  private buildSize = 0

  constructor(
    left: Operator,
    right: Operator,
    leftKey: Evaluator,
    rightKey: Evaluator,
    joinType: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL',
    schema: Schema,
  ) {
    this.left = left
    this.right = right
    this.leftKey = leftKey
    this.rightKey = rightKey
    this.joinType = joinType
    this.schema = schema
    this.leftWidth = left.schema.length
    this.rightWidth = right.schema.length
    this.estRows = Math.max(left.estRows, right.estRows)
    this.estCost = left.estCost + right.estCost + (left.estRows + right.estRows) * CPU_OP
  }
  open() {
    // Build a hash table on the right input (NULL keys never match but are kept
    // so RIGHT/FULL can still emit them as unmatched).
    const rightRows = drain(this.right)
    this.buildSize = rightRows.length
    const table = new Map<string, number[]>()
    rightRows.forEach((r, i) => {
      const k = this.rightKey(r)
      if (k === null) return
      const key = hashKey([k])
      const arr = table.get(key)
      if (arr) arr.push(i)
      else table.set(key, [i])
    })
    const emitLeftNull = this.joinType === 'LEFT' || this.joinType === 'FULL'
    const emitRightNull = this.joinType === 'RIGHT' || this.joinType === 'FULL'
    const rightMatched = new Array(rightRows.length).fill(false)
    const out: Row[] = []

    for (const l of drain(this.left)) {
      const k = this.leftKey(l)
      const bucket = k === null ? undefined : table.get(hashKey([k]))
      if (bucket && bucket.length) {
        for (const j of bucket) {
          rightMatched[j] = true
          out.push(l.concat(rightRows[j]))
        }
      } else if (emitLeftNull) {
        out.push(l.concat(new Array(this.rightWidth).fill(null)))
      }
    }
    if (emitRightNull) {
      const leftNulls = new Array(this.leftWidth).fill(null)
      rightRows.forEach((r, j) => {
        if (!rightMatched[j]) out.push(leftNulls.concat(r))
      })
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
      op: `HashJoin (${this.joinType})`,
      detail: '',
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra: [`build hash table on right input (${this.buildSize || this.right.estRows} rows)`],
      children: [this.left.plan(), this.right.plan()],
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
  ) {
    this.left = left
    this.right = right
    this.leftKey = leftKey
    this.rightKey = rightKey
    this.joinType = joinType
    this.schema = schema
    this.leftWidth = left.schema.length
    this.rightWidth = right.schema.length
    this.estRows = Math.max(left.estRows, right.estRows)
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
// reported in EXPLAIN so you can watch it kick in.
const SORT_RUN_SIZE = 1024

export class Sort implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private readonly child: Operator
  private readonly keys: SortKey[]
  private rows: Row[] = []
  private pos = 0
  // Diagnostics surfaced in EXPLAIN.
  private runs = 1
  private passes = 0
  private external = false
  private opened = false

  constructor(child: Operator, keys: SortKey[]) {
    this.child = child
    this.keys = keys
    this.schema = child.schema
    this.estRows = child.estRows
    const n = Math.max(1, child.estRows)
    this.estCost = child.estCost + n * Math.log2(n + 1) * CPU_OP
  }
  private cmp = (a: Row, b: Row): number => {
    for (const k of this.keys) {
      const c = orderValues(k.eval(a), k.eval(b))
      if (c !== 0) return k.dir === 'ASC' ? c : -c
    }
    return 0
  }
  open() {
    this.opened = true
    this.child.open()
    const input: Row[] = []
    for (let r = this.child.next(); r !== null; r = this.child.next()) input.push(r)
    this.child.close()

    if (input.length <= SORT_RUN_SIZE) {
      input.sort(this.cmp)
      this.rows = input
      this.runs = 1
      this.passes = 1
      this.external = false
      this.pos = 0
      return
    }

    // --- external merge sort -------------------------------------------------
    this.external = true
    // Pass 0: cut the input into fixed-size runs and sort each in place.
    let runs: Row[][] = []
    for (let i = 0; i < input.length; i += SORT_RUN_SIZE) {
      const run = input.slice(i, i + SORT_RUN_SIZE)
      run.sort(this.cmp)
      runs.push(run)
    }
    this.runs = runs.length
    let passes = 1
    // Merge passes: pairwise k-way (binary) merge until a single run remains.
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
    // When EXPLAIN hasn't actually executed us, predict spilling from the
    // estimated input size so the plan still shows the algorithm we'd use.
    const willSpill = this.opened ? this.external : this.child.estRows > SORT_RUN_SIZE
    const extra = willSpill
      ? this.opened
        ? [`external merge sort: ${this.runs} runs, ${this.passes} passes (run size ${SORT_RUN_SIZE})`]
        : [`external merge sort (est. ${Math.ceil(this.child.estRows / SORT_RUN_SIZE)} runs, run size ${SORT_RUN_SIZE})`]
      : ['in-memory sort']
    return {
      op: 'Sort',
      detail: this.keys.map((_, i) => `key${i}`).join(', '),
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra,
      children: [this.child.plan()],
    }
  }
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
