// Physical operators — the Volcano / iterator execution model.
//
// Every operator exposes open()/next()/close(). next() returns one row at a
// time (or null at end), pulling from its children. This is exactly how
// classic query engines stream results without materialising everything, and
// it lets EXPLAIN render the operator tree the optimizer chose.

import { hashKey, orderValues, type SqlValue } from './types'
import type { Row, Table, IndexHandle } from './catalog'
import type { Schema } from './schema'
import type { Evaluator } from './eval'

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

export type RangeBound = { value: SqlValue; inclusive: boolean } | null

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

  constructor(table: Table, index: IndexHandle, schema: Schema, lo: RangeBound, hi: RangeBound) {
    this.table = table
    this.index = index
    this.schema = schema
    this.lo = lo
    this.hi = hi
    const total = table.rowCount()
    // Equality estimate: assume good selectivity; range: ~1/3 of the table.
    const isEq = lo && hi && lo.value === hi.value
    this.estRows = isEq ? Math.max(1, Math.round(total / Math.max(1, index.stats().entries || 1))) : Math.ceil(total / 3)
    const h = index.stats().height
    this.estCost = h * CPU_OP + this.estRows * CPU_TUPLE
  }
  open() {
    this.rowids = this.index.tree.range(
      this.lo ? this.lo.value : null,
      this.hi ? this.hi.value : null,
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
    const bound = (b: RangeBound, sym: string) => (b ? `${sym}${b.inclusive ? '=' : ''} ${fmt(b.value)}` : '')
    const cond = [bound(this.lo, '>'), bound(this.hi, '<')].filter(Boolean).join(' AND ') || 'full'
    return {
      op: 'IndexScan',
      detail: `${this.table.name} via ${this.index.meta.name}`,
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra: [`on ${this.index.meta.column} (${cond})`, `B+Tree h=${s.height} nodes=${s.nodes} order=${s.order}`],
      children: [],
    }
  }
}

function fmt(v: SqlValue): string {
  return v === null ? 'NULL' : typeof v === 'string' ? `'${v}'` : String(v)
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

export interface SortKey {
  eval: Evaluator
  dir: 'ASC' | 'DESC'
}

export class Sort implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private readonly child: Operator
  private readonly keys: SortKey[]
  private rows: Row[] = []
  private pos = 0

  constructor(child: Operator, keys: SortKey[]) {
    this.child = child
    this.keys = keys
    this.schema = child.schema
    this.estRows = child.estRows
    const n = Math.max(1, child.estRows)
    this.estCost = child.estCost + n * Math.log2(n + 1) * CPU_OP
  }
  open() {
    this.child.open()
    this.rows = []
    for (let r = this.child.next(); r !== null; r = this.child.next()) this.rows.push(r)
    this.child.close()
    this.rows.sort((a, b) => {
      for (const k of this.keys) {
        const c = orderValues(k.eval(a), k.eval(b))
        if (c !== 0) return k.dir === 'ASC' ? c : -c
      }
      return 0
    })
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
      op: 'Sort',
      detail: this.keys.map((_, i) => `key${i}`).join(', '),
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra: ['in-memory quicksort'],
      children: [this.child.plan()],
    }
  }
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
