// The column store itself: a table sliced into **row groups**, each column in a
// group encoded independently (`encodings.ts`) and fronted by a **zone map**.
//
// A scan does three things a naive row store can't:
//   1. **Column projection** — only the columns a query touches are decoded.
//   2. **Zone-map pruning** — a row group whose min/max can't satisfy the
//      predicate is skipped whole, never decoded (Parquet's row-group stats,
//      ORC's stripe/row-index, the "data skipping" of every analytical engine).
//   3. **Late materialization** — evaluate the predicate on the predicate
//      columns first, then fetch the *projected* columns only at the row
//      offsets that survived (via `presentAt`'s random access).
//
// Every one of these only ever changes the *cost*: `scan` is proven, over
// thousands of seeded predicates, to return exactly what a brute-force filter
// over the original rows returns, and a pruned group is proven to truly hold no
// match. The metrics (`bytes`, `groupsScanned/Pruned`, `valuesDecoded`) are the
// honest cost signal the Lab visualises.

import { compareValues, valuesEqual, type SqlValue } from '../types'
import { plainSize, type ColumnChunk, type ZoneMap } from './types'
import { decodeColumn, decodePresent, encodeColumn, presentAt, isNullAt } from './encodings'
import { readAt } from './bitpack'

export type CompareOp = '=' | '<>' | '<' | '<=' | '>' | '>='

export type Predicate =
  | { kind: 'cmp'; col: string; op: CompareOp; value: SqlValue }
  | { kind: 'between'; col: string; lo: SqlValue; hi: SqlValue }
  | { kind: 'in'; col: string; values: SqlValue[] }
  | { kind: 'isnull'; col: string }
  | { kind: 'notnull'; col: string }

/** The column referenced by a predicate. */
export function predColumn(p: Predicate): string {
  return p.col
}

export interface RowGroup {
  rows: number
  chunks: Record<string, ColumnChunk>
}

export interface ScanMetrics {
  totalGroups: number
  groupsScanned: number
  groupsPruned: number
  /** Values a naive row store would read (every cell of every row). */
  fullScanValues: number
  /** Values this scan actually decoded (predicate cols in scanned groups +
   *  projected cols only at surviving rows). */
  valuesDecoded: number
  matched: number
}

export interface ScanResult {
  columns: string[]
  rows: SqlValue[][]
  metrics: ScanMetrics
}

/** Metrics for a **compressed-execution** scan, which evaluates a predicate
 *  directly against the encoded data (once per dictionary entry / RLE run)
 *  instead of decoding every value first. */
export interface CompressedMetrics {
  totalGroups: number
  groupsScanned: number
  groupsPruned: number
  /** Predicate comparisons a row store would make (every predicate on every row). */
  fullScanCompares: number
  /** Predicate comparisons this scan actually made — over dictionary entries /
   *  RLE runs where it can push down, over decoded values otherwise. */
  predEvaluations: number
  /** Projected cells materialized at surviving rows (late materialization). */
  valuesMaterialized: number
  /** Row groups in which at least one predicate ran directly on encoded data. */
  pushedGroups: number
  matched: number
}

export interface CompressedResult {
  columns: string[]
  rows: SqlValue[][]
  metrics: CompressedMetrics
}

// ---- row-level predicate evaluation (SQL three-valued: NULL ⇒ no match) -----

export function matchRow(p: Predicate, cell: SqlValue): boolean {
  switch (p.kind) {
    case 'isnull':
      return cell === null
    case 'notnull':
      return cell !== null
    case 'in':
      if (cell === null) return false
      return p.values.some((v) => valuesEqual(cell, v))
    case 'between': {
      if (cell === null) return false
      const lo = compareValues(cell, p.lo)
      const hi = compareValues(cell, p.hi)
      return lo !== null && hi !== null && lo >= 0 && hi <= 0
    }
    case 'cmp': {
      if (cell === null) return false
      const c = compareValues(cell, p.value)
      if (c === null) return false
      switch (p.op) {
        case '=':
          return c === 0
        case '<>':
          return c !== 0
        case '<':
          return c < 0
        case '<=':
          return c <= 0
        case '>':
          return c > 0
        case '>=':
          return c >= 0
      }
    }
  }
}

/** Compute a per-row match mask for one predicate against one encoded column —
 *  the heart of **compressed execution**. For a DICTIONARY column the predicate
 *  is evaluated once per *distinct* value (the dictionary), then the bit-packed
 *  codes are scanned against that tiny boolean table; for an RLE column it is
 *  evaluated once per *run*. Only when neither applies does it fall back to
 *  decoding the values. `evals` is the number of value comparisons actually made
 *  (the compressed-execution win); `pushed` records whether it ran on encoded
 *  data. NULL rows never match a value predicate (three-valued logic), matching
 *  `matchRow`. */
function predRowMask(chunk: ColumnChunk, p: Predicate): { mask: Uint8Array; evals: number; pushed: boolean } {
  const n = chunk.n
  const mask = new Uint8Array(n)
  if (p.kind === 'isnull') {
    for (let i = 0; i < n; i++) if (isNullAt(chunk.nulls, i)) mask[i] = 1
    return { mask, evals: 0, pushed: false }
  }
  if (p.kind === 'notnull') {
    for (let i = 0; i < n; i++) if (!isNullAt(chunk.nulls, i)) mask[i] = 1
    return { mask, evals: 0, pushed: false }
  }
  // value predicate: build a mask over the dense non-NULL ("present") values
  const present = chunk.present
  const pmask = new Uint8Array(present)
  let evals: number
  let pushed = false
  if (chunk.encoding === 'dict') {
    const { values, codes, width } = chunk.dict!
    const dictMask = values.map((v) => matchRow(p, v)) // one eval per distinct value
    evals = values.length
    pushed = true
    for (let j = 0; j < present; j++) pmask[j] = dictMask[readAt(codes, width, j)] ? 1 : 0
  } else if (chunk.encoding === 'rle') {
    const { values, lens, starts } = chunk.rle!
    evals = values.length // one eval per run
    pushed = true
    for (let r = 0; r < values.length; r++) {
      if (matchRow(p, values[r])) {
        const s = starts[r]
        for (let k = 0; k < lens[r]; k++) pmask[s + k] = 1
      }
    }
  } else {
    const vals = decodePresent(chunk)
    evals = vals.length
    for (let j = 0; j < present; j++) pmask[j] = matchRow(p, vals[j]) ? 1 : 0
  }
  // weave the present mask back through the NULL bitmap onto row positions
  let j = 0
  for (let i = 0; i < n; i++) {
    if (isNullAt(chunk.nulls, i)) continue
    mask[i] = pmask[j++]
  }
  return { mask, evals, pushed }
}

// ---- zone-map pruning (sound: only prunes a provably empty group) -----------

/** Could ANY row in a group with this zone map satisfy the predicate? Returns
 *  true whenever it cannot prove otherwise — so a `false` is a certificate the
 *  group holds no match, and pruning it can never change the answer. Every
 *  comparison that comes back incomparable (`null`) is treated as "unknown",
 *  which keeps the group. */
export function canMatch(p: Predicate, z: ZoneMap): boolean {
  const present = z.count - z.nullCount
  switch (p.kind) {
    case 'isnull':
      return z.nullCount > 0
    case 'notnull':
      return present > 0
    case 'in': {
      if (present === 0) return false
      // keep the group if any listed value could fall within [min, max]
      return p.values.some((v) => {
        const lo = compareValues(v, z.min)
        const hi = compareValues(v, z.max)
        return lo === null || hi === null || (lo >= 0 && hi <= 0)
      })
    }
    case 'between': {
      if (present === 0) return false
      const a = compareValues(z.max, p.lo) // max >= lo ?
      const b = compareValues(z.min, p.hi) // min <= hi ?
      if (a === null || b === null) return true
      return a >= 0 && b <= 0 // interval overlap
    }
    case 'cmp': {
      if (present === 0 || p.value === null) return false
      const cmin = compareValues(z.min, p.value)
      const cmax = compareValues(z.max, p.value)
      if (cmin === null || cmax === null) return true // incomparable ⇒ can't prune
      switch (p.op) {
        case '=':
          return cmin <= 0 && cmax >= 0 // min <= v <= max
        case '<':
          return cmin < 0 // some value below v ⇒ min < v
        case '<=':
          return cmin <= 0
        case '>':
          return cmax > 0
        case '>=':
          return cmax >= 0
        case '<>':
          // only prunable when every non-NULL value equals v (min == max == v)
          return !(z.distinct === 1 && cmin === 0)
      }
    }
  }
}

// ---- the store -------------------------------------------------------------

export class ColumnStore {
  readonly columns: string[]
  readonly rowGroupSize: number
  readonly totalRows: number
  readonly groups: RowGroup[]

  constructor(columns: string[], rows: SqlValue[][], rowGroupSize = 1024) {
    this.columns = columns.slice()
    this.rowGroupSize = Math.max(1, rowGroupSize)
    this.totalRows = rows.length
    this.groups = []
    for (let start = 0; start < rows.length; start += this.rowGroupSize) {
      const slice = rows.slice(start, start + this.rowGroupSize)
      const chunks: Record<string, ColumnChunk> = {}
      for (let c = 0; c < columns.length; c++) {
        chunks[columns[c]] = encodeColumn(slice.map((r) => r[c]))
      }
      this.groups.push({ rows: slice.length, chunks })
    }
  }

  /** Total modelled on-disk footprint of the encoded store. */
  columnarBytes(): number {
    let b = 0
    for (const g of this.groups) for (const col of this.columns) b += g.chunks[col].byteSize
    return b
  }

  /** Modelled footprint of the same data as a naive **row store**: every cell's
   *  value plus a per-row NULL bitmap. The compression-ratio denominator. */
  rowStoreBytes(): number {
    let b = this.totalRows * ((this.columns.length + 7) >> 3)
    for (const g of this.groups) {
      for (const col of this.columns) {
        for (const v of decodeColumn(g.chunks[col])) b += plainSize(v)
      }
    }
    return b
  }

  /** Reconstruct the original rows (used as the differential oracle's input and
   *  by the Lab to show a group's raw contents). */
  materialize(): SqlValue[][] {
    const out: SqlValue[][] = []
    for (const g of this.groups) {
      const cols = this.columns.map((c) => decodeColumn(g.chunks[c]))
      for (let i = 0; i < g.rows; i++) out.push(cols.map((col) => col[i]))
    }
    return out
  }

  /** Scan with a conjunction of predicates, projecting `project` columns
   *  (defaults to all). Prunes by zone map, projects columns, and
   *  late-materializes the projected columns at surviving rows. */
  scan(predicates: Predicate[] = [], project: string[] = this.columns): ScanResult {
    const predCols = Array.from(new Set(predicates.map(predColumn)))
    const metrics: ScanMetrics = {
      totalGroups: this.groups.length,
      groupsScanned: 0,
      groupsPruned: 0,
      fullScanValues: this.totalRows * this.columns.length,
      valuesDecoded: 0,
      matched: 0,
    }
    const rows: SqlValue[][] = []

    for (const g of this.groups) {
      // 1. zone-map pruning: skip the whole group if any conjunct can't match.
      if (predicates.some((p) => !canMatch(p, g.chunks[predColumn(p)].zone))) {
        metrics.groupsPruned++
        continue
      }
      metrics.groupsScanned++

      // 2. decode the predicate columns and evaluate the conjunction per row.
      const decoded: Record<string, SqlValue[]> = {}
      for (const col of predCols) {
        decoded[col] = decodeColumn(g.chunks[col])
        metrics.valuesDecoded += g.rows
      }
      const survivors: number[] = []
      for (let i = 0; i < g.rows; i++) {
        if (predicates.every((p) => matchRow(p, decoded[predColumn(p)][i]))) survivors.push(i)
      }
      metrics.matched += survivors.length

      // 3. late materialization: fetch each projected column only at survivors.
      const rank: Record<string, Int32Array> = {}
      for (const col of project) {
        if (col in decoded) continue
        // row → non-NULL ("present") index within the chunk (null-bitmap rank)
        const chunk = g.chunks[col]
        const r = new Int32Array(g.rows)
        let j = 0
        for (let i = 0; i < g.rows; i++) r[i] = isNullAt(chunk.nulls, i) ? -1 : j++
        rank[col] = r
      }
      for (const i of survivors) {
        rows.push(
          project.map((col) => {
            if (col in decoded) return decoded[col][i]
            const chunk = g.chunks[col]
            const pi = rank[col][i]
            metrics.valuesDecoded++
            return pi < 0 ? null : presentAt(chunk, pi)
          }),
        )
      }
    }
    return { columns: project.slice(), rows, metrics }
  }

  /** **Compressed-execution** scan — identical results to `scan`, but the
   *  predicate is evaluated directly on the encoded data (once per dictionary
   *  entry / RLE run) rather than by decoding every value first, and the
   *  projected columns are late-materialized only at survivors. This is
   *  ClickHouse's LowCardinality / DuckDB's compressed execution: a filter over
   *  a low-cardinality or run-heavy column touches the *distinct* values, not
   *  the rows. Proven equal to `scan` (and thus to a brute-force filter) in the
   *  self-tests — it only ever changes the cost. */
  scanCompressed(predicates: Predicate[] = [], project: string[] = this.columns): CompressedResult {
    const metrics: CompressedMetrics = {
      totalGroups: this.groups.length,
      groupsScanned: 0,
      groupsPruned: 0,
      fullScanCompares: this.totalRows * predicates.length,
      predEvaluations: 0,
      valuesMaterialized: 0,
      pushedGroups: 0,
      matched: 0,
    }
    const rows: SqlValue[][] = []

    for (const g of this.groups) {
      // zone-map pruning, same as scan().
      if (predicates.some((p) => !canMatch(p, g.chunks[predColumn(p)].zone))) {
        metrics.groupsPruned++
        continue
      }
      metrics.groupsScanned++

      // AND the encoded per-predicate row masks together.
      const survivor = new Uint8Array(g.rows).fill(1)
      let anyPushed = false
      for (const p of predicates) {
        const { mask, evals, pushed } = predRowMask(g.chunks[predColumn(p)], p)
        metrics.predEvaluations += evals
        anyPushed = anyPushed || pushed
        for (let i = 0; i < g.rows; i++) survivor[i] &= mask[i]
      }
      if (anyPushed) metrics.pushedGroups++

      // late-materialize the projected columns only at surviving rows.
      const rank: Record<string, Int32Array> = {}
      for (const col of project) {
        const chunk = g.chunks[col]
        const r = new Int32Array(g.rows)
        let j = 0
        for (let i = 0; i < g.rows; i++) r[i] = isNullAt(chunk.nulls, i) ? -1 : j++
        rank[col] = r
      }
      for (let i = 0; i < g.rows; i++) {
        if (!survivor[i]) continue
        metrics.matched++
        rows.push(
          project.map((col) => {
            const pi = rank[col][i]
            metrics.valuesMaterialized++
            return pi < 0 ? null : presentAt(g.chunks[col], pi)
          }),
        )
      }
    }
    return { columns: project.slice(), rows, metrics }
  }
}
