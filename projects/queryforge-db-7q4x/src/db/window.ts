// Window-function executor.
//
// A WindowExec buffers its child's rows, then for each window specification it
// partitions the rows (PARTITION BY), orders each partition (ORDER BY) and
// computes the function across the partition — appending one scratch column per
// window function. The Project above reads those columns positionally.
//
// Framing follows the SQL standard:
//   • ranking / offset functions (ROW_NUMBER…NTILE, LAG/LEAD) read the ordered
//     partition and ignore frames (LAG/LEAD honour IGNORE NULLS);
//   • the default frame is RANGE UNBOUNDED PRECEDING .. CURRENT ROW (a running,
//     peer-aware aggregate; the whole partition when unordered);
//   • explicit frames support all three modes — ROWS (physical rows), RANGE
//     (value offsets over numbers/decimals/temporals) and GROUPS (peer groups) —
//     plus the EXCLUDE clause (NO OTHERS / CURRENT ROW / GROUP / TIES);
//   • frame-sensitive functions are the aggregates (COUNT/SUM/AVG/MIN/MAX and the
//     statistical STDDEV/VARIANCE family), the value functions (FIRST_VALUE/
//     LAST_VALUE/NTH_VALUE, with IGNORE NULLS), the ordered-set aggregates
//     (PERCENTILE_CONT/DISC, MODE, MEDIAN) and aggregate FILTER (WHERE …).

import { hashKey, orderValues, type SqlValue } from './types'
import {
  isDecimal,
  addDecimal,
  subDecimal,
  divDecimal,
  fromInt as decFromInt,
  fromNumber as decFromNumber,
  toNumber as decToNumber,
  DECIMAL_ZERO,
  DIV_DEFAULT_SCALE,
} from './decimal'
import { isTemporal, applyIntervalMs, mkDate, mkTime, mkTimestamp, MS_PER_DAY } from './temporal'
import type { Row } from './catalog'
import type { Schema } from './schema'
import type { Evaluator } from './eval'
import type { Operator, PlanNode } from './operators'
import type { FrameBoundType, FrameMode, FrameExclude } from './ast'

export interface WindowOrderKey {
  eval: Evaluator
  dir: 'ASC' | 'DESC'
}
export interface FrameBoundExec {
  type: FrameBoundType
  /** Compiled offset for N PRECEDING / N FOLLOWING (rows/groups: a count; range: a value). */
  offset?: Evaluator
}
export interface FrameExec {
  mode: FrameMode
  start: FrameBoundExec
  end: FrameBoundExec
  /** Frame exclusion; 'NO_OTHERS' is the standard default. */
  exclude: FrameExclude
}
export interface WindowSpecExec {
  name: string
  args: Evaluator[]
  partition: Evaluator[]
  order: WindowOrderKey[]
  /** Explicit frame; undefined → the function's standard default frame. */
  frame?: FrameExec
  /** IGNORE NULLS for value/offset functions. */
  ignoreNulls?: boolean
  /** Aggregate-window FILTER (WHERE …) — only matching rows in the frame contribute. */
  filter?: Evaluator
  /** Ordered-set window key: PERCENTILE/MODE WITHIN GROUP (ORDER BY key). */
  withinGroup?: WindowOrderKey
  label: string
}

const VALUE_FUNCS = new Set(['FIRST_VALUE', 'LAST_VALUE', 'NTH_VALUE'])
const AGG_FUNCS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'])
const STAT_FUNCS = new Set([
  'STDDEV', 'STDDEV_SAMP', 'STDDEV_POP', 'VARIANCE', 'VAR_SAMP', 'VAR_POP',
])
const OSET_FUNCS = new Set(['PERCENTILE_CONT', 'PERCENTILE_DISC', 'MODE', 'MEDIAN'])
// Functions whose result depends on the window frame.
const FRAME_SENSITIVE = new Set([...VALUE_FUNCS, ...AGG_FUNCS, ...STAT_FUNCS, ...OSET_FUNCS])
// Functions the legacy default-frame fast paths below do NOT handle, so they
// always route through the general per-row frame machinery.
const FRAME_ONLY = new Set([...STAT_FUNCS, ...OSET_FUNCS])

// Does this spec need the general (per-row) frame path rather than a fast path?
function needsFramePath(spec: WindowSpecExec): boolean {
  if (!FRAME_SENSITIVE.has(spec.name)) return false
  return (
    !!spec.frame ||
    !!spec.filter ||
    FRAME_ONLY.has(spec.name) ||
    (!!spec.ignoreNulls && VALUE_FUNCS.has(spec.name))
  )
}

function cmpOrder(a: Row, b: Row, keys: WindowOrderKey[]): number {
  for (const k of keys) {
    const c = orderValues(k.eval(a), k.eval(b))
    if (c !== 0) return k.dir === 'ASC' ? c : -c
  }
  return 0
}

// Numeric coercion that matches the GROUP BY aggregates (bool→0/1, decimal→number).
function toNum(v: SqlValue): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (isDecimal(v)) return decToNumber(v)
  return NaN
}

function clampFraction(f: number): number {
  if (Number.isNaN(f)) return 0
  return Math.max(0, Math.min(1, f))
}

function isInterval(v: SqlValue): boolean {
  return typeof v === 'object' && v !== null && (v as { t?: string }).t === 'interval'
}

// base ± offset in value space (for RANGE bounds). `sign` is +1/−1. Numbers add
// numerically; DECIMAL stays exact; DATE/TIME/TIMESTAMP take an INTERVAL offset.
function shiftValue(base: SqlValue, offset: SqlValue, sign: 1 | -1): SqlValue {
  if (base === null || offset === null) return base
  if (typeof base === 'number') {
    const d = toNum(offset)
    return base + sign * (Number.isNaN(d) ? 0 : d)
  }
  if (isDecimal(base)) {
    const off = isDecimal(offset) ? offset : decFromNumber(toNum(offset)) ?? DECIMAL_ZERO
    return sign === 1 ? addDecimal(base, off) : subDecimal(base, off)
  }
  if (isTemporal(base) && isInterval(offset)) {
    const iv = offset as Parameters<typeof applyIntervalMs>[1]
    switch (base.t) {
      case 'date': {
        const ms = applyIntervalMs(base.days * MS_PER_DAY, iv, sign)
        return mkDate(Math.round(ms / MS_PER_DAY))
      }
      case 'timestamp':
        return mkTimestamp(applyIntervalMs(base.ms, iv, sign))
      case 'time':
        // Only the sub-day (ms) component of the interval is meaningful for TIME.
        return mkTime(base.ms + sign * iv.ms)
      default:
        return base
    }
  }
  // Incompatible offset/key types: leave the boundary at the current value.
  return base
}

// ── the general per-row frame path ─────────────────────────────────────────

interface FrameCtx {
  n: number
  groupIndex: number[]
  peerStart: (k: number) => number
  peerEnd: (k: number) => number
  keyAt: (k: number) => SqlValue
  dir: 'ASC' | 'DESC'
  dirCmp: (a: SqlValue, b: SqlValue) => number
}

// Lower-index bound of the frame for row `i`.
function frameStart(frame: FrameExec, rows: Row[], i: number, c: FrameCtx): number {
  const b = frame.start
  switch (b.type) {
    case 'UNBOUNDED_PRECEDING':
      return 0
    case 'UNBOUNDED_FOLLOWING':
      return c.n // empty (start past the end)
    case 'CURRENT_ROW':
      return frame.mode === 'ROWS' ? i : c.peerStart(i)
    case 'PRECEDING':
    case 'FOLLOWING': {
      if (frame.mode === 'ROWS') {
        const d = b.offset ? Math.trunc(Number(b.offset(rows[i])) || 0) : 0
        return b.type === 'PRECEDING' ? i - d : i + d
      }
      if (frame.mode === 'GROUPS') {
        const d = b.offset ? Math.trunc(Number(b.offset(rows[i])) || 0) : 0
        const target = b.type === 'PRECEDING' ? c.groupIndex[i] - d : c.groupIndex[i] + d
        let k = 0
        while (k < c.n && c.groupIndex[k] < target) k++
        return k
      }
      // RANGE.
      const off = b.offset ? b.offset(rows[i]) : null
      const sign: 1 | -1 = b.type === 'PRECEDING' ? (c.dir === 'ASC' ? -1 : 1) : c.dir === 'ASC' ? 1 : -1
      const bound = shiftValue(c.keyAt(i), off, sign)
      let k = 0
      while (k < c.n && c.dirCmp(c.keyAt(k), bound) < 0) k++
      return k
    }
  }
}

// Upper-index bound of the frame for row `i`.
function frameEnd(frame: FrameExec, rows: Row[], i: number, c: FrameCtx): number {
  const b = frame.end
  switch (b.type) {
    case 'UNBOUNDED_PRECEDING':
      return -1 // empty (end before the start)
    case 'UNBOUNDED_FOLLOWING':
      return c.n - 1
    case 'CURRENT_ROW':
      return frame.mode === 'ROWS' ? i : c.peerEnd(i)
    case 'PRECEDING':
    case 'FOLLOWING': {
      if (frame.mode === 'ROWS') {
        const d = b.offset ? Math.trunc(Number(b.offset(rows[i])) || 0) : 0
        return b.type === 'PRECEDING' ? i - d : i + d
      }
      if (frame.mode === 'GROUPS') {
        const d = b.offset ? Math.trunc(Number(b.offset(rows[i])) || 0) : 0
        const target = b.type === 'PRECEDING' ? c.groupIndex[i] - d : c.groupIndex[i] + d
        let k = c.n - 1
        while (k >= 0 && c.groupIndex[k] > target) k--
        return k
      }
      // RANGE.
      const off = b.offset ? b.offset(rows[i]) : null
      const sign: 1 | -1 = b.type === 'PRECEDING' ? (c.dir === 'ASC' ? -1 : 1) : c.dir === 'ASC' ? 1 : -1
      const bound = shiftValue(c.keyAt(i), off, sign)
      let k = c.n - 1
      while (k >= 0 && c.dirCmp(c.keyAt(k), bound) > 0) k--
      return k
    }
  }
}

// Build the list of in-frame row indices for row `i`, after EXCLUDE.
function frameIndices(frame: FrameExec, rows: Row[], i: number, c: FrameCtx): number[] {
  const s = Math.max(0, frameStart(frame, rows, i, c))
  const e = Math.min(c.n - 1, frameEnd(frame, rows, i, c))
  const idxs: number[] = []
  if (s > e) return idxs
  let exLo = -1
  let exHi = -2
  if (frame.exclude === 'GROUP' || frame.exclude === 'TIES') {
    exLo = c.peerStart(i)
    exHi = c.peerEnd(i)
  }
  for (let k = s; k <= e; k++) {
    if (frame.exclude === 'CURRENT_ROW' && k === i) continue
    if (frame.exclude === 'GROUP' && k >= exLo && k <= exHi) continue
    if (frame.exclude === 'TIES' && k !== i && k >= exLo && k <= exHi) continue
    idxs.push(k)
  }
  return idxs
}

// Aggregate / statistical functions over an arbitrary index list (honours FILTER).
function aggregateIndices(spec: WindowSpecExec, rows: Row[], idxs: number[]): SqlValue {
  const star = spec.args.length === 0
  const filt = spec.filter
  let count = 0
  let sum = 0
  let mn: SqlValue = null
  let mx: SqlValue = null
  let decSum = DECIMAL_ZERO
  let decExact = true
  let sawDecimal = false
  // Welford accumulators for the variance/stddev family.
  let nc = 0
  let mean = 0
  let m2 = 0
  for (const i of idxs) {
    if (filt && filt(rows[i]) !== true) continue
    const v = star ? 1 : spec.args[0](rows[i])
    if (!star && v === null) continue
    count++
    let num: number | null = null
    if (typeof v === 'number') {
      num = v
      sum += v
      if (Number.isInteger(v)) decSum = addDecimal(decSum, decFromInt(v))
      else decExact = false
    } else if (typeof v === 'boolean') {
      num = v ? 1 : 0
      sum += num
      decSum = addDecimal(decSum, decFromInt(num))
    } else if (isDecimal(v)) {
      num = decToNumber(v)
      sum += num
      sawDecimal = true
      decSum = addDecimal(decSum, v)
    }
    if (num !== null) {
      nc++
      const d = num - mean
      mean += d / nc
      m2 += d * (num - mean)
    }
    if (mn === null || orderValues(v, mn) < 0) mn = v
    if (mx === null || orderValues(v, mx) > 0) mx = v
  }
  const exact = sawDecimal && decExact
  switch (spec.name) {
    case 'COUNT':
      return count
    case 'SUM':
      return count === 0 ? null : exact ? decSum : sum
    case 'AVG':
      if (count === 0) return null
      return exact
        ? divDecimal(decSum, decFromInt(count), Math.max(decSum.s, DIV_DEFAULT_SCALE)) ?? sum / count
        : sum / count
    case 'MIN':
      return mn
    case 'MAX':
      return mx
    case 'VARIANCE':
    case 'VAR_SAMP':
      return nc < 2 ? null : m2 / (nc - 1)
    case 'VAR_POP':
      return nc < 1 ? null : m2 / nc
    case 'STDDEV':
    case 'STDDEV_SAMP':
      return nc < 2 ? null : Math.sqrt(m2 / (nc - 1))
    case 'STDDEV_POP':
      return nc < 1 ? null : Math.sqrt(m2 / nc)
    default:
      return null
  }
}

// Ordered-set windows (PERCENTILE_CONT/DISC, MODE) + MEDIAN over an index list.
function orderedSetIndices(spec: WindowSpecExec, rows: Row[], idxs: number[], cur: number): SqlValue {
  const filt = spec.filter
  let valEval: Evaluator | undefined
  let dir: 'ASC' | 'DESC' = 'ASC'
  let fraction: number
  if (spec.name === 'MEDIAN') {
    valEval = spec.args[0]
    fraction = 0.5
  } else {
    valEval = spec.withinGroup?.eval
    dir = spec.withinGroup?.dir ?? 'ASC'
    fraction = spec.args[0] ? clampFraction(Number(spec.args[0](rows[cur]))) : 0
  }
  if (!valEval) return null
  const vals: SqlValue[] = []
  for (const i of idxs) {
    if (filt && filt(rows[i]) !== true) continue
    const v = valEval(rows[i])
    if (v !== null) vals.push(v)
  }
  if (vals.length === 0) return null

  if (spec.name === 'MODE') {
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

  if (spec.name === 'PERCENTILE_DISC') {
    vals.sort(orderValues)
    if (dir === 'DESC') vals.reverse()
    let idx = Math.ceil(fraction * vals.length) - 1
    if (idx < 0) idx = 0
    if (idx >= vals.length) idx = vals.length - 1
    return vals[idx]
  }

  // PERCENTILE_CONT / MEDIAN: linear interpolation over the numeric values.
  const nums = vals.map(toNum).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b)
  if (nums.length === 0) return null
  if (dir === 'DESC') nums.reverse()
  const rank = fraction * (nums.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return nums[lo]
  return nums[lo] + (nums[hi] - nums[lo]) * (rank - lo)
}

// Value functions (FIRST_VALUE/LAST_VALUE/NTH_VALUE) over an index list,
// honouring IGNORE NULLS.
function valueFnIndices(spec: WindowSpecExec, rows: Row[], idxs: number[], cur: number): SqlValue {
  if (idxs.length === 0) return null
  const arg0 = spec.args[0]
  const valOf = (k: number): SqlValue => (arg0 ? arg0(rows[k]) : null)
  const ign = !!spec.ignoreNulls
  if (spec.name === 'FIRST_VALUE') {
    if (!ign) return valOf(idxs[0])
    for (const k of idxs) {
      const v = valOf(k)
      if (v !== null) return v
    }
    return null
  }
  if (spec.name === 'LAST_VALUE') {
    if (!ign) return valOf(idxs[idxs.length - 1])
    for (let j = idxs.length - 1; j >= 0; j--) {
      const v = valOf(idxs[j])
      if (v !== null) return v
    }
    return null
  }
  // NTH_VALUE(expr, n): n counts from the start of the frame.
  const nth = spec.args[1] ? Math.trunc(Number(spec.args[1](rows[cur]))) : 1
  if (nth < 1) return null
  if (!ign) {
    const idx = idxs[nth - 1]
    return idx === undefined ? null : valOf(idx)
  }
  let seen = 0
  for (const k of idxs) {
    const v = valOf(k)
    if (v !== null) {
      seen++
      if (seen === nth) return v
    }
  }
  return null
}

function computeFrameValue(spec: WindowSpecExec, rows: Row[], idxs: number[], cur: number): SqlValue {
  if (VALUE_FUNCS.has(spec.name)) return valueFnIndices(spec, rows, idxs, cur)
  if (OSET_FUNCS.has(spec.name)) return orderedSetIndices(spec, rows, idxs, cur)
  return aggregateIndices(spec, rows, idxs)
}

// The general path: synthesise the default frame when none is given, precompute
// peer/group structure, then evaluate the function per row over its frame.
function computeFramePath(spec: WindowSpecExec, rows: Row[], out: SqlValue[]): void {
  const n = rows.length
  const ordered = spec.order.length > 0
  const frame: FrameExec = spec.frame ?? {
    mode: 'RANGE',
    start: { type: 'UNBOUNDED_PRECEDING' },
    end: { type: 'CURRENT_ROW' },
    exclude: 'NO_OTHERS',
  }
  const samePeer = (a: number, b: number) => !ordered || cmpOrder(rows[a], rows[b], spec.order) === 0
  const groupIndex = new Array<number>(n)
  let g = 0
  for (let i = 0; i < n; i++) {
    if (i > 0 && !samePeer(i - 1, i)) g++
    groupIndex[i] = g
  }
  const peerStart = (k: number): number => {
    let s = k
    while (s > 0 && samePeer(s - 1, k)) s--
    return s
  }
  const peerEnd = (k: number): number => {
    let e = k
    while (e + 1 < n && samePeer(e + 1, k)) e++
    return e
  }
  const ordEval = spec.order[0]?.eval
  const dir = spec.order[0]?.dir ?? 'ASC'
  const sgn = dir === 'ASC' ? 1 : -1
  const ctx: FrameCtx = {
    n,
    groupIndex,
    peerStart,
    peerEnd,
    keyAt: (k) => (ordEval ? ordEval(rows[k]) : null),
    dir,
    dirCmp: (a, b) => orderValues(a, b) * sgn,
  }
  for (let i = 0; i < n; i++) {
    const idxs = frameIndices(frame, rows, i, ctx)
    out[i] = computeFrameValue(spec, rows, idxs, i)
  }
}

// Compute one window function's value for every row of one ordered partition.
// `out` is filled positionally (parallel to `rows`).
function computePartition(spec: WindowSpecExec, rows: Row[], out: SqlValue[]): void {
  const n = rows.length
  const ordered = spec.order.length > 0
  const arg0 = (i: number): SqlValue => (spec.args[0] ? spec.args[0](rows[i]) : null)

  // General per-row frame machinery (explicit frames, EXCLUDE, statistical /
  // ordered-set windows, FILTER, IGNORE NULLS on value functions).
  if (needsFramePath(spec)) {
    computeFramePath(spec, rows, out)
    return
  }

  // Peer boundaries for ranking. With no ORDER BY every row of the partition is
  // a peer of every other (so RANK/DENSE_RANK are all 1, CUME_DIST all 1).
  const samePeer = (i: number, j: number) => !ordered || cmpOrder(rows[i], rows[j], spec.order) === 0

  switch (spec.name) {
    case 'ROW_NUMBER':
      for (let i = 0; i < n; i++) out[i] = i + 1
      return
    case 'RANK': {
      let rank = 1
      for (let i = 0; i < n; i++) {
        if (i > 0 && !samePeer(i, i - 1)) rank = i + 1
        out[i] = rank
      }
      return
    }
    case 'DENSE_RANK': {
      let rank = 0
      for (let i = 0; i < n; i++) {
        if (i === 0 || !samePeer(i, i - 1)) rank++
        out[i] = rank
      }
      return
    }
    case 'PERCENT_RANK': {
      let rank = 1
      for (let i = 0; i < n; i++) {
        if (i > 0 && !samePeer(i, i - 1)) rank = i + 1
        out[i] = n <= 1 ? 0 : (rank - 1) / (n - 1)
      }
      return
    }
    case 'CUME_DIST': {
      for (let i = 0; i < n; i++) {
        // # of rows whose order key <= current (peers included).
        let j = i
        while (j + 1 < n && samePeer(j + 1, i)) j++
        out[i] = (j + 1) / n
      }
      return
    }
    case 'NTILE': {
      const buckets = Math.max(1, Number(spec.args[0] ? spec.args[0](rows[0]) : 1) || 1)
      const base = Math.floor(n / buckets)
      const rem = n % buckets
      let idx = 0
      for (let b = 0; b < buckets; b++) {
        const size = base + (b < rem ? 1 : 0)
        for (let k = 0; k < size && idx < n; k++) out[idx++] = b + 1
      }
      return
    }
    case 'LAG':
    case 'LEAD': {
      // Offset is constant (read once); the default is evaluated per row.
      const offset = spec.args[1] ? Number(spec.args[1](rows[0])) : 1
      if (spec.ignoreNulls) {
        const step = spec.name === 'LAG' ? -1 : 1
        for (let i = 0; i < n; i++) {
          let cnt = 0
          let found: SqlValue = null
          for (let j = i + step; j >= 0 && j < n; j += step) {
            const v = arg0(j)
            if (v !== null) {
              cnt++
              if (cnt === offset) {
                found = v
                break
              }
            }
          }
          out[i] = found !== null ? found : spec.args[2] ? spec.args[2](rows[i]) : null
        }
        return
      }
      for (let i = 0; i < n; i++) {
        const j = spec.name === 'LAG' ? i - offset : i + offset
        out[i] = j >= 0 && j < n ? arg0(j) : spec.args[2] ? spec.args[2](rows[i]) : null
      }
      return
    }
    case 'FIRST_VALUE':
      // First row of the frame is always the partition start.
      for (let i = 0; i < n; i++) out[i] = arg0(0)
      return
    case 'LAST_VALUE': {
      // Default frame ends at the current row, so LAST_VALUE returns the value
      // at the end of the current row's peer group (the whole partition when
      // unordered — samePeer is then always true).
      let i = 0
      while (i < n) {
        let j = i
        while (j + 1 < n && samePeer(j + 1, i)) j++
        const v = arg0(j)
        for (let k = i; k <= j; k++) out[k] = v
        i = j + 1
      }
      return
    }
    case 'NTH_VALUE': {
      const k = spec.args[1] ? Number(spec.args[1](rows[0])) : 1
      const v = k >= 1 && k <= n ? arg0(k - 1) : null
      for (let i = 0; i < n; i++) out[i] = v
      return
    }
    // Aggregate windows (default frame) ----------------------------------------
    case 'COUNT':
    case 'SUM':
    case 'AVG':
    case 'MIN':
    case 'MAX': {
      // Default frame is RANGE UNBOUNDED PRECEDING .. CURRENT ROW: a running
      // aggregate up to (and including) the current peer group.
      const upto = (end: number): SqlValue => {
        const idxs: number[] = []
        for (let k = 0; k <= end; k++) idxs.push(k)
        return aggregateIndices(spec, rows, idxs)
      }
      if (ordered) {
        let i = 0
        while (i < n) {
          let j = i
          while (j + 1 < n && samePeer(j + 1, i)) j++
          const v = upto(j)
          for (let k = i; k <= j; k++) out[k] = v
          i = j + 1
        }
      } else {
        const v = upto(n - 1)
        for (let i = 0; i < n; i++) out[i] = v
      }
      return
    }
    default:
      throw new Error(`unsupported window function ${spec.name}`)
  }
}

export class WindowExec implements Operator {
  readonly schema: Schema
  estRows: number
  estCost: number
  actualRows = 0
  private readonly child: Operator
  private readonly specs: WindowSpecExec[]
  private rows: Row[] = []
  private pos = 0

  constructor(child: Operator, specs: WindowSpecExec[], schema: Schema) {
    this.child = child
    this.specs = specs
    this.schema = schema
    this.estRows = child.estRows
    this.estCost = child.estCost + child.estRows * Math.log2(child.estRows + 2) * specs.length * 0.0025
  }

  open() {
    this.child.open()
    const input: Row[] = []
    for (let r = this.child.next(); r !== null; r = this.child.next()) input.push(r)
    this.child.close()

    const width = input.length ? input[0].length : 0
    // Each row gets `specs.length` scratch slots appended.
    const out: Row[] = input.map((r) => {
      const copy = r.slice()
      for (let s = 0; s < this.specs.length; s++) copy.push(null)
      return copy
    })

    this.specs.forEach((spec, si) => {
      // Partition rows (preserving an index back into `out`).
      const buckets = new Map<string, number[]>()
      for (let i = 0; i < input.length; i++) {
        const key = hashKey(spec.partition.map((p) => p(input[i])))
        const arr = buckets.get(key)
        if (arr) arr.push(i)
        else buckets.set(key, [i])
      }
      for (const idxs of buckets.values()) {
        if (spec.order.length) {
          idxs.sort((a, b) => cmpOrder(input[a], input[b], spec.order) || a - b)
        }
        const partRows = idxs.map((i) => input[i])
        const res: SqlValue[] = new Array(partRows.length).fill(null)
        computePartition(spec, partRows, res)
        for (let k = 0; k < idxs.length; k++) out[idxs[k]][width + si] = res[k]
      }
    })

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
      op: 'Window',
      detail: this.specs.map((s) => s.label).join(', '),
      estRows: this.estRows,
      estCost: this.estCost,
      actualRows: this.actualRows,
      extra: ['partition + order, one pass per function'],
      children: [this.child.plan()],
    }
  }
}
