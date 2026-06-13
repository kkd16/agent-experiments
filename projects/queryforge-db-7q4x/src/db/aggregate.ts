// Hash aggregation operator + accumulators.
//
// Computes GROUP BY with COUNT/SUM/AVG/MIN/MAX (including DISTINCT variants).
// Output rows are [groupKey0..groupKeyN, agg0..aggM] so downstream HAVING /
// projection can read both grouping columns and aggregate results positionally.

import { hashKey, orderValues, type SqlValue } from './types'
import type { Row } from './catalog'
import type { Schema } from './schema'
import type { Evaluator } from './eval'
import type { Operator, PlanNode } from './operators'

export type AggName = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX'

export interface AggSpec {
  name: AggName
  star: boolean
  distinct: boolean
  arg: Evaluator | null
  label: string
}

class Accumulator {
  count = 0
  sum = 0
  min: SqlValue = null
  max: SqlValue = null
  hasValue = false
  seen: Set<string> | null
  constructor(distinct: boolean) {
    this.seen = distinct ? new Set() : null
  }
  update(spec: AggSpec, row: Row): void {
    if (spec.star) {
      this.count++
      return
    }
    const v = spec.arg ? spec.arg(row) : null
    if (v === null) return
    if (this.seen) {
      const k = hashKey([v])
      if (this.seen.has(k)) return
      this.seen.add(k)
    }
    this.count++
    if (typeof v === 'number') this.sum += v
    else if (typeof v === 'boolean') this.sum += v ? 1 : 0
    if (!this.hasValue) {
      this.min = v
      this.max = v
      this.hasValue = true
    } else {
      if (orderValues(v, this.min) < 0) this.min = v
      if (orderValues(v, this.max) > 0) this.max = v
    }
  }
  finalize(name: AggName): SqlValue {
    switch (name) {
      case 'COUNT':
        return this.count
      case 'SUM':
        return this.hasValue ? this.sum : null
      case 'AVG':
        return this.hasValue ? this.sum / this.count : null
      case 'MIN':
        return this.min
      case 'MAX':
        return this.max
    }
  }
}

interface Group {
  keys: SqlValue[]
  accs: Accumulator[]
}

export class HashAggregate implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private readonly child: Operator
  private readonly groupExprs: Evaluator[]
  private readonly aggs: AggSpec[]
  private groups: Group[] = []
  private pos = 0

  constructor(child: Operator, groupExprs: Evaluator[], aggs: AggSpec[], schema: Schema) {
    this.child = child
    this.groupExprs = groupExprs
    this.aggs = aggs
    this.schema = schema
    this.estRows = groupExprs.length === 0 ? 1 : Math.max(1, Math.round(child.estRows * 0.5))
    this.estCost = child.estCost + child.estRows * (aggs.length + groupExprs.length) * 0.0025
  }
  open() {
    this.child.open()
    const map = new Map<string, Group>()
    let any = false
    for (let r = this.child.next(); r !== null; r = this.child.next()) {
      any = true
      const keys = this.groupExprs.map((g) => g(r))
      const key = hashKey(keys)
      let group = map.get(key)
      if (!group) {
        group = { keys, accs: this.aggs.map((a) => new Accumulator(a.distinct)) }
        map.set(key, group)
      }
      for (let i = 0; i < this.aggs.length; i++) group.accs[i].update(this.aggs[i], r)
    }
    this.child.close()
    this.groups = [...map.values()]
    // Whole-table aggregate over an empty input still yields one row.
    if (!any && this.groupExprs.length === 0) {
      this.groups = [{ keys: [], accs: this.aggs.map((a) => new Accumulator(a.distinct)) }]
    }
    this.pos = 0
  }
  next(): Row | null {
    if (this.pos >= this.groups.length) return null
    const g = this.groups[this.pos++]
    this.actualRows++
    const out: Row = g.keys.slice()
    for (let i = 0; i < this.aggs.length; i++) out.push(g.accs[i].finalize(this.aggs[i].name))
    return out
  }
  close() {
    this.groups = []
  }
  plan(): PlanNode {
    const detail =
      (this.groupExprs.length ? `group by ${this.groupExprs.length} key(s); ` : 'whole table; ') +
      this.aggs.map((a) => a.label).join(', ')
    return {
      op: 'HashAggregate',
      detail,
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra: this.groupExprs.length ? ['build hash table on grouping keys'] : [],
      children: [this.child.plan()],
    }
  }
}
