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
import { decodeColumn, encodeColumn, presentAt, isNullAt } from './encodings'

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
}
