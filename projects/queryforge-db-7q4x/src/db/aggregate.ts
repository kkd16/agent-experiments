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

export type AggName =
  | 'COUNT'
  | 'SUM'
  | 'AVG'
  | 'MIN'
  | 'MAX'
  | 'STDDEV'
  | 'STDDEV_SAMP'
  | 'STDDEV_POP'
  | 'VARIANCE'
  | 'VAR_SAMP'
  | 'VAR_POP'
  | 'STRING_AGG'
  | 'GROUP_CONCAT'
  | 'MEDIAN'

export interface AggSpec {
  name: AggName
  star: boolean
  distinct: boolean
  arg: Evaluator | null
  label: string
  /** Separator for STRING_AGG / GROUP_CONCAT. */
  sep?: string
  /** Aggregate FILTER (WHERE …) predicate — rows where it isn't true are skipped. */
  filter?: Evaluator
}

function needsList(name: AggName): boolean {
  return name === 'STRING_AGG' || name === 'GROUP_CONCAT' || name === 'MEDIAN'
}

class Accumulator {
  count = 0
  sum = 0
  min: SqlValue = null
  max: SqlValue = null
  hasValue = false
  seen: Set<string> | null
  // Welford's online variance over the numeric values only.
  private nc = 0
  private mean = 0
  private m2 = 0
  // Buffered values for order-/distribution-sensitive aggregates.
  private list: SqlValue[] | null
  constructor(spec: AggSpec) {
    this.seen = spec.distinct ? new Set() : null
    this.list = needsList(spec.name) ? [] : null
  }
  update(spec: AggSpec, row: Row): void {
    if (spec.filter && spec.filter(row) !== true) return
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
    const num = typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : null
    if (num !== null) {
      this.sum += num
      this.nc++
      const d = num - this.mean
      this.mean += d / this.nc
      this.m2 += d * (num - this.mean)
    }
    if (!this.hasValue) {
      this.min = v
      this.max = v
      this.hasValue = true
    } else {
      if (orderValues(v, this.min) < 0) this.min = v
      if (orderValues(v, this.max) > 0) this.max = v
    }
    if (this.list !== null) this.list.push(v)
  }
  finalize(spec: AggSpec): SqlValue {
    switch (spec.name) {
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
      case 'VARIANCE':
      case 'VAR_SAMP':
        return this.nc < 2 ? null : this.m2 / (this.nc - 1)
      case 'VAR_POP':
        return this.nc < 1 ? null : this.m2 / this.nc
      case 'STDDEV':
      case 'STDDEV_SAMP':
        return this.nc < 2 ? null : Math.sqrt(this.m2 / (this.nc - 1))
      case 'STDDEV_POP':
        return this.nc < 1 ? null : Math.sqrt(this.m2 / this.nc)
      case 'STRING_AGG':
      case 'GROUP_CONCAT': {
        if (!this.list || this.list.length === 0) return null
        const sep = spec.sep ?? (spec.name === 'GROUP_CONCAT' ? ',' : '')
        return this.list.map((x) => String(x)).join(sep)
      }
      case 'MEDIAN': {
        if (!this.list) return null
        const nums = this.list
          .map((x) => (typeof x === 'number' ? x : typeof x === 'boolean' ? (x ? 1 : 0) : NaN))
          .filter((x) => !Number.isNaN(x))
          .sort((a, b) => a - b)
        if (nums.length === 0) return null
        const mid = nums.length >> 1
        return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2
      }
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
        group = { keys, accs: this.aggs.map((a) => new Accumulator(a)) }
        map.set(key, group)
      }
      for (let i = 0; i < this.aggs.length; i++) group.accs[i].update(this.aggs[i], r)
    }
    this.child.close()
    this.groups = [...map.values()]
    // Whole-table aggregate over an empty input still yields one row.
    if (!any && this.groupExprs.length === 0) {
      this.groups = [{ keys: [], accs: this.aggs.map((a) => new Accumulator(a)) }]
    }
    this.pos = 0
  }
  next(): Row | null {
    if (this.pos >= this.groups.length) return null
    const g = this.groups[this.pos++]
    this.actualRows++
    const out: Row = g.keys.slice()
    for (let i = 0; i < this.aggs.length; i++) out.push(g.accs[i].finalize(this.aggs[i]))
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
