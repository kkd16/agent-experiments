// Hash aggregation operator + accumulators.
//
// Computes GROUP BY with COUNT/SUM/AVG/MIN/MAX (including DISTINCT variants).
// Output rows are [groupKey0..groupKeyN, agg0..aggM] so downstream HAVING /
// projection can read both grouping columns and aggregate results positionally.

import { hashKey, orderValues, formatValue, type SqlValue } from './types'
import { makeJson, jsonOf, toJson, type Json } from './json'
import {
  isDecimal,
  addDecimal,
  divDecimal,
  fromInt as decFromInt,
  toNumber as decToNumber,
  DECIMAL_ZERO,
  DIV_DEFAULT_SCALE,
  type DecimalValue,
} from './decimal'
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
  | 'PERCENTILE_CONT'
  | 'PERCENTILE_DISC'
  | 'MODE'
  | 'JSON_AGG'
  | 'JSON_OBJECT_AGG'

export interface AggSpec {
  name: AggName
  star: boolean
  distinct: boolean
  arg: Evaluator | null
  /** Second argument evaluator (the value of `JSON_OBJECT_AGG(key, value)`). */
  arg2?: Evaluator | null
  label: string
  /** Separator for STRING_AGG / GROUP_CONCAT. */
  sep?: string
  /** Aggregate FILTER (WHERE …) predicate — rows where it isn't true are skipped. */
  filter?: Evaluator
  /** Percentile fraction (0..1) for PERCENTILE_CONT / PERCENTILE_DISC. */
  fraction?: number
  /** Sort direction of the WITHIN GROUP (ORDER BY …) key, for ordered-set aggs. */
  dir?: 'ASC' | 'DESC'
}

function needsList(name: AggName): boolean {
  return (
    name === 'STRING_AGG' ||
    name === 'GROUP_CONCAT' ||
    name === 'MEDIAN' ||
    name === 'PERCENTILE_CONT' ||
    name === 'PERCENTILE_DISC' ||
    name === 'MODE'
  )
}

class Accumulator {
  count = 0
  sum = 0
  min: SqlValue = null
  max: SqlValue = null
  hasValue = false
  seen: Set<string> | null
  // Exact running total when every summed value is a DECIMAL/integer; the
  // moment a non-integer REAL appears `decExact` flips off and SUM/AVG fall
  // back to the float `sum`. `sawDecimal` ensures pure-integer SUMs stay INTEGER.
  private decSum: DecimalValue = DECIMAL_ZERO
  private decExact = true
  private sawDecimal = false
  // Welford's online variance over the numeric values only.
  private nc = 0
  private mean = 0
  private m2 = 0
  // Buffered values for order-/distribution-sensitive aggregates.
  private list: SqlValue[] | null
  // Buffers for the JSON aggregates (which keep NULLs, unlike the others).
  private jsonArr: Json[] | null
  private jsonObj: { [k: string]: Json } | null
  private jsonSeen = 0
  constructor(spec: AggSpec) {
    this.seen = spec.distinct ? new Set() : null
    this.list = needsList(spec.name) ? [] : null
    this.jsonArr = spec.name === 'JSON_AGG' ? [] : null
    this.jsonObj = spec.name === 'JSON_OBJECT_AGG' ? {} : null
  }
  update(spec: AggSpec, row: Row): void {
    if (spec.filter && spec.filter(row) !== true) return
    // JSON aggregates buffer their own way: json_agg keeps NULL elements, and
    // json_object_agg pairs a (text) key with a JSON value, skipping NULL keys.
    if (this.jsonArr) {
      this.jsonArr.push(toJson(spec.arg ? spec.arg(row) : null))
      this.jsonSeen++
      return
    }
    if (this.jsonObj) {
      const k = spec.arg ? spec.arg(row) : null
      if (k === null) return
      this.jsonObj[formatValue(k)] = toJson(spec.arg2 ? spec.arg2(row) : null)
      this.jsonSeen++
      return
    }
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
    const num =
      typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : isDecimal(v) ? decToNumber(v) : null
    if (num !== null) {
      this.sum += num
      this.nc++
      const d = num - this.mean
      this.mean += d / this.nc
      this.m2 += d * (num - this.mean)
      // Exact-decimal running total.
      if (isDecimal(v)) {
        this.sawDecimal = true
        this.decSum = addDecimal(this.decSum, v)
      } else if (typeof v === 'boolean') {
        this.decSum = addDecimal(this.decSum, decFromInt(v ? 1 : 0))
      } else if (Number.isInteger(num)) {
        this.decSum = addDecimal(this.decSum, decFromInt(num))
      } else {
        this.decExact = false
      }
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
      case 'JSON_AGG':
        return this.jsonSeen > 0 && this.jsonArr ? makeJson(this.jsonArr) : null
      case 'JSON_OBJECT_AGG':
        return this.jsonSeen > 0 && this.jsonObj ? jsonOf(this.jsonObj) : null
      case 'COUNT':
        return this.count
      case 'SUM':
        if (!this.hasValue) return null
        return this.sawDecimal && this.decExact ? this.decSum : this.sum
      case 'AVG':
        if (!this.hasValue) return null
        if (this.sawDecimal && this.decExact) {
          const scale = Math.max(this.decSum.s, DIV_DEFAULT_SCALE)
          return divDecimal(this.decSum, decFromInt(this.count), scale) ?? this.sum / this.count
        }
        return this.sum / this.count
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
          .map((x) => (typeof x === 'number' ? x : typeof x === 'boolean' ? (x ? 1 : 0) : isDecimal(x) ? decToNumber(x) : NaN))
          .filter((x) => !Number.isNaN(x))
          .sort((a, b) => a - b)
        if (nums.length === 0) return null
        const mid = nums.length >> 1
        return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2
      }
      case 'PERCENTILE_CONT': {
        // Continuous percentile with linear interpolation between neighbours.
        if (!this.list) return null
        const nums = this.list
          .map((x) => (typeof x === 'number' ? x : typeof x === 'boolean' ? (x ? 1 : 0) : isDecimal(x) ? decToNumber(x) : NaN))
          .filter((x) => !Number.isNaN(x))
          .sort((a, b) => a - b)
        if (nums.length === 0) return null
        if (spec.dir === 'DESC') nums.reverse()
        const f = clampFraction(spec.fraction)
        const rank = f * (nums.length - 1)
        const lo = Math.floor(rank)
        const hi = Math.ceil(rank)
        if (lo === hi) return nums[lo]
        return nums[lo] + (nums[hi] - nums[lo]) * (rank - lo)
      }
      case 'PERCENTILE_DISC': {
        // Discrete percentile: the first value whose cumulative fraction ≥ f.
        // Works for any orderable type (numbers, text, …), no interpolation.
        if (!this.list) return null
        const vals = this.list.filter((x) => x !== null)
        if (vals.length === 0) return null
        vals.sort(orderValues)
        if (spec.dir === 'DESC') vals.reverse()
        const f = clampFraction(spec.fraction)
        let idx = Math.ceil(f * vals.length) - 1
        if (idx < 0) idx = 0
        if (idx >= vals.length) idx = vals.length - 1
        return vals[idx]
      }
      case 'MODE': {
        // The most frequent value; ties resolved toward the smallest value.
        if (!this.list) return null
        const vals = this.list.filter((x) => x !== null)
        if (vals.length === 0) return null
        const counts = new Map<string, { v: SqlValue; n: number }>()
        for (const v of vals) {
          const k = hashKey([v])
          const e = counts.get(k)
          if (e) e.n++
          else counts.set(k, { v, n: 1 })
        }
        let best: { v: SqlValue; n: number } | null = null
        for (const e of counts.values()) {
          if (!best || e.n > best.n || (e.n === best.n && orderValues(e.v, best.v) < 0)) best = e
        }
        return best ? best.v : null
      }
    }
  }
}

/** Clamp a percentile fraction into [0, 1] (defaulting a missing one to 0). */
function clampFraction(f: number | undefined): number {
  if (f === undefined || Number.isNaN(f)) return 0
  return Math.max(0, Math.min(1, f))
}

interface Group {
  keys: SqlValue[]
  accs: Accumulator[]
  /** Bitmap of grouping-expression indexes active in this group's grouping set
   *  (bit i set ⇒ expression i participates; cleared ⇒ rolled up to NULL). */
  bitmap: number
}

export class HashAggregate implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private readonly child: Operator
  private readonly groupExprs: Evaluator[]
  private readonly aggs: AggSpec[]
  /** One entry per grouping set: the indexes into `groupExprs` it groups on. */
  private readonly groupingSets: number[][]
  /** Append a trailing INTEGER column holding each row's grouping-set bitmap. */
  private readonly emitGroupingCol: boolean
  private groups: Group[] = []
  private pos = 0

  constructor(
    child: Operator,
    groupExprs: Evaluator[],
    aggs: AggSpec[],
    schema: Schema,
    groupingSets?: number[][],
    emitGroupingCol = false,
  ) {
    this.child = child
    this.groupExprs = groupExprs
    this.aggs = aggs
    this.schema = schema
    this.groupingSets = groupingSets ?? [groupExprs.map((_, i) => i)]
    this.emitGroupingCol = emitGroupingCol
    const sets = this.groupingSets.length
    this.estRows = groupExprs.length === 0 ? sets : Math.max(1, Math.round(child.estRows * 0.5 * sets))
    this.estCost = child.estCost + child.estRows * sets * (aggs.length + groupExprs.length) * 0.0025
  }
  private bitmapOf(set: number[]): number {
    let bm = 0
    for (const i of set) bm |= 1 << i
    return bm
  }
  open() {
    this.child.open()
    const map = new Map<string, Group>()
    let any = false
    for (let r = this.child.next(); r !== null; r = this.child.next()) {
      any = true
      const allKeys = this.groupExprs.map((g) => g(r))
      // Each input row contributes to one group per grouping set.
      for (let s = 0; s < this.groupingSets.length; s++) {
        const set = this.groupingSets[s]
        // Identity within a set is its included key values; prefix with the set
        // index so two sets that collapse to the same key stay distinct.
        const idKey = s + ' ' + hashKey(set.map((i) => allKeys[i]))
        let group = map.get(idKey)
        if (!group) {
          const keys = this.groupExprs.map((_, i) => (set.includes(i) ? allKeys[i] : null))
          group = { keys, accs: this.aggs.map((a) => new Accumulator(a)), bitmap: this.bitmapOf(set) }
          map.set(idKey, group)
        }
        for (let i = 0; i < this.aggs.length; i++) group.accs[i].update(this.aggs[i], r)
      }
    }
    this.child.close()
    this.groups = [...map.values()]
    // A grand-total grouping set (the empty set) always yields exactly one row,
    // even over an empty input — including the plain whole-table aggregate.
    if (!any) {
      for (let s = 0; s < this.groupingSets.length; s++) {
        if (this.groupingSets[s].length === 0) {
          this.groups.push({
            keys: this.groupExprs.map(() => null),
            accs: this.aggs.map((a) => new Accumulator(a)),
            bitmap: 0,
          })
        }
      }
    }
    this.pos = 0
  }
  next(): Row | null {
    if (this.pos >= this.groups.length) return null
    const g = this.groups[this.pos++]
    this.actualRows++
    const out: Row = g.keys.slice()
    for (let i = 0; i < this.aggs.length; i++) out.push(g.accs[i].finalize(this.aggs[i]))
    if (this.emitGroupingCol) out.push(g.bitmap)
    return out
  }
  close() {
    this.groups = []
  }
  plan(): PlanNode {
    const multi = this.groupingSets.length > 1
    const detail =
      (this.groupExprs.length ? `group by ${this.groupExprs.length} key(s); ` : 'whole table; ') +
      this.aggs.map((a) => a.label).join(', ')
    const extra: string[] = []
    if (this.groupExprs.length) extra.push('build hash table on grouping keys')
    if (multi) extra.push(`${this.groupingSets.length} grouping sets (ROLLUP/CUBE/GROUPING SETS)`)
    return {
      op: multi ? 'GroupingSetsAggregate' : 'HashAggregate',
      detail,
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra,
      children: [this.child.plan()],
    }
  }
}
