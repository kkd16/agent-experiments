// Table & column statistics — the raw material a cost-based optimizer needs to
// estimate how many rows a predicate will keep.
//
// For every column we record the non-null/null counts, the number of distinct
// values, the min/max, an equi-depth histogram (bucket boundaries chosen so
// every bucket holds roughly the same number of rows), and the most-common
// values (an MCV list) for skewed distributions. From those we can estimate the
// selectivity of equality and range predicates the way real planners do.
//
// Stats are gathered by `ANALYZE` (or lazily, on first plan) and cached on the
// Table; any mutation drops the cache so the next plan re-gathers fresh numbers.

import { orderValues, valuesEqual, type ColumnType, type SqlValue } from './types'
import { isTemporal, temporalScalar, hashTemporal } from './temporal'
import type { Row } from './catalog'

const HIST_BUCKETS = 32
const MCV_LIMIT = 16

export interface ColumnStat {
  column: string
  type: ColumnType
  /** Non-null value count. */
  count: number
  nullCount: number
  ndistinct: number
  min: SqlValue
  max: SqlValue
  /** Equi-depth bucket boundaries (length ≤ HIST_BUCKETS+1, ascending). */
  histogram: SqlValue[]
  /** Most-common values with their absolute frequencies, descending. */
  mcv: { value: SqlValue; freq: number }[]
}

export interface TableStat {
  rowCount: number
  columns: Map<string, ColumnStat>
}

/** Compute statistics for one column from its already-extracted values. */
function columnStat(name: string, type: ColumnType, values: SqlValue[]): ColumnStat {
  const nonNull: SqlValue[] = []
  let nullCount = 0
  const freq = new Map<string, { value: SqlValue; n: number }>()
  for (const v of values) {
    if (v === null) {
      nullCount++
      continue
    }
    nonNull.push(v)
    const k = keyOf(v)
    const e = freq.get(k)
    if (e) e.n++
    else freq.set(k, { value: v, n: 1 })
  }
  nonNull.sort(orderValues)
  const ndistinct = freq.size
  const min = nonNull.length ? nonNull[0] : null
  const max = nonNull.length ? nonNull[nonNull.length - 1] : null

  // Equi-depth histogram: pick boundaries at evenly spaced ranks.
  const histogram: SqlValue[] = []
  if (nonNull.length > 0) {
    const buckets = Math.min(HIST_BUCKETS, nonNull.length)
    for (let b = 0; b <= buckets; b++) {
      const idx = Math.min(nonNull.length - 1, Math.round((b / buckets) * (nonNull.length - 1)))
      histogram.push(nonNull[idx])
    }
  }

  // Most-common values (helps skew + equality estimates).
  const mcv = [...freq.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, MCV_LIMIT)
    .filter((e) => e.n > 1)
    .map((e) => ({ value: e.value, freq: e.n }))

  return { column: name, type, count: nonNull.length, nullCount, ndistinct, min, max, histogram, mcv }
}

function keyOf(v: SqlValue): string {
  if (typeof v === 'string') return 's' + v
  if (typeof v === 'boolean') return 'b' + (v ? 1 : 0)
  if (isTemporal(v)) return 't' + hashTemporal(v)
  return 'n' + String(v)
}

/** Gather statistics for an entire table (one O(n·cols) pass over the heap). */
export function gatherTableStats(
  rows: Iterable<Row>,
  columns: { name: string; type: ColumnType }[],
): TableStat {
  const cols: SqlValue[][] = columns.map(() => [])
  let rowCount = 0
  for (const row of rows) {
    rowCount++
    for (let c = 0; c < columns.length; c++) cols[c].push(row[c] ?? null)
  }
  const map = new Map<string, ColumnStat>()
  columns.forEach((col, i) => {
    map.set(col.name.toLowerCase(), columnStat(col.name, col.type, cols[i]))
  })
  return { rowCount, columns: map }
}

// ---------------------------------------------------------------------------
// Selectivity estimation
// ---------------------------------------------------------------------------

/** Numeric position of a value for histogram interpolation (text → NaN). */
function num(v: SqlValue): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (isTemporal(v)) return temporalScalar(v)
  return NaN
}

/** Fraction of non-null values `<= x` (the histogram's empirical CDF). */
function cdf(stat: ColumnStat, x: SqlValue): number {
  const h = stat.histogram
  if (h.length < 2) return 0.5
  if (orderValues(x, h[0]) < 0) return 0
  if (orderValues(x, h[h.length - 1]) >= 0) return 1
  const buckets = h.length - 1
  for (let i = 0; i < buckets; i++) {
    const lo = h[i]
    const hi = h[i + 1]
    if (orderValues(x, hi) < 0) {
      // x is inside bucket i — interpolate within it for numeric columns.
      const nx = num(x)
      const nlo = num(lo)
      const nhi = num(hi)
      let frac = 0.5
      if (!Number.isNaN(nx) && !Number.isNaN(nlo) && !Number.isNaN(nhi) && nhi > nlo) {
        frac = Math.min(1, Math.max(0, (nx - nlo) / (nhi - nlo)))
      }
      return (i + frac) / buckets
    }
  }
  return 1
}

/** Estimated selectivity of `col = value` (fraction of all rows, 0..1). */
export function eqSelectivity(stat: ColumnStat, value: SqlValue): number {
  const total = stat.count + stat.nullCount
  if (total === 0) return 0
  if (value === null) return 0 // `col = NULL` is never true (use IS NULL)
  const hit = stat.mcv.find((m) => valuesEqual(m.value, value))
  if (hit) return hit.freq / total
  // Distribute remaining rows over the remaining distinct values.
  const mcvRows = stat.mcv.reduce((n, m) => n + m.freq, 0)
  const restDistinct = Math.max(1, stat.ndistinct - stat.mcv.length)
  const restRows = stat.count - mcvRows
  return restRows <= 0 ? 0.5 / total : restRows / restDistinct / total
}

/** Estimated selectivity of a range predicate over `col`. */
export function rangeSelectivity(
  stat: ColumnStat,
  lo: SqlValue | null,
  loInclusive: boolean,
  hi: SqlValue | null,
  hiInclusive: boolean,
): number {
  const total = stat.count + stat.nullCount
  if (total === 0 || stat.count === 0) return 0
  const nonNullFrac = stat.count / total
  let fLo = lo === null ? 0 : cdf(stat, lo)
  let fHi = hi === null ? 1 : cdf(stat, hi)
  // Inclusivity nudges are second-order; approximate with the equality mass.
  const eqMass = 1 / Math.max(1, stat.ndistinct)
  if (lo !== null && loInclusive) fLo = Math.max(0, fLo - eqMass / 2)
  if (hi !== null && hiInclusive) fHi = Math.min(1, fHi + eqMass / 2)
  return Math.max(0, Math.min(1, fHi - fLo)) * nonNullFrac
}

/** Estimated selectivity of `col IS [NOT] NULL`. */
export function nullSelectivity(stat: ColumnStat, negated: boolean): number {
  const total = stat.count + stat.nullCount
  if (total === 0) return 0
  const frac = stat.nullCount / total
  return negated ? 1 - frac : frac
}
