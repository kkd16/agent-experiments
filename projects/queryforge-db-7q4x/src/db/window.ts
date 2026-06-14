// Window-function executor.
//
// A WindowExec buffers its child's rows, then for each window specification it
// partitions the rows (PARTITION BY), orders each partition (ORDER BY) and
// computes the function across the partition — appending one scratch column per
// window function. The Project above reads those columns positionally.
//
// Frames are simplified but follow the useful defaults:
//   • ranking / offset functions use the ordered partition;
//   • FIRST_VALUE/LAST_VALUE/NTH_VALUE and *unordered* aggregates use the whole
//     partition;
//   • *ordered* aggregates (SUM/AVG/… OVER (ORDER BY …)) use a running frame
//     (UNBOUNDED PRECEDING → CURRENT ROW), the standard cumulative behaviour.

import { hashKey, orderValues, type SqlValue } from './types'
import type { Row } from './catalog'
import type { Schema } from './schema'
import type { Evaluator } from './eval'
import type { Operator, PlanNode } from './operators'
import type { FrameBoundType, FrameMode } from './ast'

export interface WindowOrderKey {
  eval: Evaluator
  dir: 'ASC' | 'DESC'
}
export interface FrameBoundExec {
  type: FrameBoundType
  /** Compiled offset for N PRECEDING / N FOLLOWING. */
  offset?: Evaluator
}
export interface FrameExec {
  mode: FrameMode
  start: FrameBoundExec
  end: FrameBoundExec
}
export interface WindowSpecExec {
  name: string
  args: Evaluator[]
  partition: Evaluator[]
  order: WindowOrderKey[]
  /** Explicit frame; undefined → the function's standard default frame. */
  frame?: FrameExec
  label: string
}

// Functions whose result depends on the window frame (everything except the
// ranking/offset family, which always read the whole ordered partition).
const FRAME_SENSITIVE = new Set([
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'FIRST_VALUE', 'LAST_VALUE', 'NTH_VALUE',
])

function cmpOrder(a: Row, b: Row, keys: WindowOrderKey[]): number {
  for (const k of keys) {
    const c = orderValues(k.eval(a), k.eval(b))
    if (c !== 0) return k.dir === 'ASC' ? c : -c
  }
  return 0
}

// Aggregate `arg0` over rows[s..e] (inclusive) for a frame-windowed function.
function aggregateRange(spec: WindowSpecExec, rows: Row[], s: number, e: number): SqlValue {
  const star = spec.args.length === 0
  let count = 0
  let sum = 0
  let mn: SqlValue = null
  let mx: SqlValue = null
  for (let i = s; i <= e; i++) {
    const v = star ? 1 : spec.args[0](rows[i])
    if (!star && v === null) continue
    count++
    if (typeof v === 'number') sum += v
    else if (typeof v === 'boolean') sum += v ? 1 : 0
    if (mn === null || orderValues(v, mn) < 0) mn = v
    if (mx === null || orderValues(v, mx) > 0) mx = v
  }
  switch (spec.name) {
    case 'COUNT': return count
    case 'SUM': return count === 0 ? null : sum
    case 'AVG': return count === 0 ? null : sum / count
    case 'MIN': return mn
    default: return mx
  }
}

// Resolve an explicit frame to [start, end] row indices for row `i`.
function frameBounds(
  frame: FrameExec,
  rows: Row[],
  i: number,
  orderVal: (k: number) => number,
  peerStart: (k: number) => number,
  peerEnd: (k: number) => number,
): [number, number] {
  const n = rows.length
  const offsetAt = (b: FrameBoundExec): number => (b.offset ? Number(b.offset(rows[i])) || 0 : 0)
  const resolveStart = (b: FrameBoundExec): number => {
    switch (b.type) {
      case 'UNBOUNDED_PRECEDING': return 0
      case 'UNBOUNDED_FOLLOWING': return n // empty (start past end)
      case 'CURRENT_ROW': return frame.mode === 'RANGE' ? peerStart(i) : i
      case 'PRECEDING':
        if (frame.mode === 'ROWS') return i - offsetAt(b)
        { const lo = orderVal(i) - offsetAt(b); let k = 0; while (k < n && orderVal(k) < lo) k++; return k }
      case 'FOLLOWING':
        if (frame.mode === 'ROWS') return i + offsetAt(b)
        { const lo = orderVal(i) + offsetAt(b); let k = 0; while (k < n && orderVal(k) < lo) k++; return k }
    }
  }
  const resolveEnd = (b: FrameBoundExec): number => {
    switch (b.type) {
      case 'UNBOUNDED_PRECEDING': return -1 // empty (end before start)
      case 'UNBOUNDED_FOLLOWING': return n - 1
      case 'CURRENT_ROW': return frame.mode === 'RANGE' ? peerEnd(i) : i
      case 'PRECEDING':
        if (frame.mode === 'ROWS') return i - offsetAt(b)
        { const hi = orderVal(i) - offsetAt(b); let k = n - 1; while (k >= 0 && orderVal(k) > hi) k--; return k }
      case 'FOLLOWING':
        if (frame.mode === 'ROWS') return i + offsetAt(b)
        { const hi = orderVal(i) + offsetAt(b); let k = n - 1; while (k >= 0 && orderVal(k) > hi) k--; return k }
    }
  }
  const s = Math.max(0, resolveStart(frame.start))
  const e = Math.min(n - 1, resolveEnd(frame.end))
  return [s, e]
}

// Compute one window function's value for every row of one ordered partition.
// `out` is filled positionally (parallel to `rows`).
function computePartition(spec: WindowSpecExec, rows: Row[], out: SqlValue[]): void {
  const n = rows.length
  const ordered = spec.order.length > 0
  const arg0 = (i: number): SqlValue => (spec.args[0] ? spec.args[0](rows[i]) : null)

  // Explicit frame on a frame-sensitive function: compute per-row.
  if (spec.frame && FRAME_SENSITIVE.has(spec.name)) {
    const ordEval = spec.order[0]?.eval
    const orderVal = (k: number): number => {
      if (!ordEval) return 0
      const v = ordEval(rows[k])
      return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : 0
    }
    const samePeer = (a: number, b: number) => !ordered || cmpOrder(rows[a], rows[b], spec.order) === 0
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
    for (let i = 0; i < n; i++) {
      const [s, e] = frameBounds(spec.frame, rows, i, orderVal, peerStart, peerEnd)
      if (s > e) {
        out[i] = spec.name === 'COUNT' ? 0 : null
        continue
      }
      if (spec.name === 'FIRST_VALUE') out[i] = arg0(s)
      else if (spec.name === 'LAST_VALUE') out[i] = arg0(e)
      else if (spec.name === 'NTH_VALUE') {
        const k = spec.args[1] ? Number(spec.args[1](rows[i])) : 1
        const idx = s + k - 1
        out[i] = k >= 1 && idx <= e ? arg0(idx) : null
      } else out[i] = aggregateRange(spec, rows, s, e)
    }
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
    // Aggregate windows ------------------------------------------------------
    case 'COUNT':
    case 'SUM':
    case 'AVG':
    case 'MIN':
    case 'MAX': {
      const star = spec.args.length === 0
      const upto = (end: number): SqlValue => {
        let count = 0
        let sum = 0
        let mn: SqlValue = null
        let mx: SqlValue = null
        for (let i = 0; i <= end; i++) {
          const v = star ? 1 : arg0(i)
          if (!star && v === null) continue
          count++
          if (typeof v === 'number') sum += v
          else if (typeof v === 'boolean') sum += v ? 1 : 0
          if (mn === null || orderValues(v, mn) < 0) mn = v
          if (mx === null || orderValues(v, mx) > 0) mx = v
        }
        switch (spec.name) {
          case 'COUNT': return count
          case 'SUM': return count === 0 ? null : sum
          case 'AVG': return count === 0 ? null : sum / count
          case 'MIN': return mn
          default: return mx
        }
      }
      if (ordered) {
        // Running frame: extend the peer group so peers share a value.
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
