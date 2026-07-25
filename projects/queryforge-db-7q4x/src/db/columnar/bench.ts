// The column-store benchmark: a synthetic dataset whose columns are drawn from
// the shapes a real analytical table has — a low-cardinality category, a
// monotone surrogate key, a clustered/run-heavy column, a wide-range integer,
// and a high-cardinality text column — plus a timestamp. Building the store over
// it shows the auto-encoder picking a *different* encoding per column (dict for
// the category, delta for the key/timestamp, RLE for the runs, frame-of-
// reference for the wide int) and the aggregate compression ratio vs a row
// store. A selective predicate on the sorted key then demonstrates zone-map
// pruning skipping most row groups. The RUM-style honest-cost counterpart to
// the LSM and Protocols benches — the numbers the Columnar Lab visualises.

import { Rng } from '../fuzz/rng'
import { asTemporalKind } from '../temporal'
import type { SqlValue } from '../types'
import { ColumnStore, type Predicate } from './store'
import { plainSize, type EncodingKind } from './types'
import { encodeColumnAs, availableEncodings } from './encodings'

export interface ColumnBench {
  name: string
  chosen: EncodingKind
  plainBytes: number
  chosenBytes: number
  ratio: number // plain / chosen
}

export interface BenchResult {
  rows: number
  groupSize: number
  rowStoreBytes: number
  columnarBytes: number
  ratio: number
  perColumn: ColumnBench[]
  // a selective range predicate on the sorted key + the pruning it achieves:
  prunePredicate: string
  totalGroups: number
  groupsScanned: number
  groupsPruned: number
  valuesDecoded: number
  fullScanValues: number
  matched: number
}

const CATEGORIES = ['north', 'south', 'east', 'west']
const STATUSES = ['active', 'churned', 'trial', 'active', 'active'] // skewed → runs

export const BENCH_COLUMNS = ['id', 'ts', 'region', 'status', 'amount', 'token'] as const

/** Deterministically generate the benchmark dataset. */
export function generateDataset(seed: number, nRows: number): { columns: string[]; rows: SqlValue[][] } {
  const rng = new Rng(seed)
  const columns = BENCH_COLUMNS.slice()
  const rows: SqlValue[][] = []
  let id = 1000
  let ts = 1_700_000_000
  let status = 0
  for (let i = 0; i < nRows; i++) {
    id += rng.int(1, 3) // monotone surrogate key → DELTA
    ts += rng.int(0, 5) // monotone timestamp → DELTA
    const region = rng.pick(CATEGORIES) // low card → DICTIONARY
    // status flips rarely → long runs → RLE
    if (rng.chance(0.15)) status = rng.int(0, STATUSES.length - 1)
    const amount = 10_000_000 + rng.int(0, 4095) // wide base, small per-group range → FOR
    const token = `tok_${rng.int(0, 1 << 28).toString(36)}` // high card → PLAIN/DICT
    rows.push([id, ts, region, STATUSES[status], amount, token])
  }
  return { columns, rows }
}

function plainBytesOf(values: SqlValue[]): number {
  let b = values.length > 0 ? (values.length + 7) >> 3 : 0
  for (const v of values) b += plainSize(v)
  return b
}

export function runBench(seed = 0xc0_1d, nRows = 8000, groupSize = 1024): BenchResult {
  const { columns, rows } = generateDataset(seed, nRows)
  const store = new ColumnStore(columns, rows, groupSize)

  const perColumn: ColumnBench[] = columns.map((name, c) => {
    const values = rows.map((r) => r[c])
    const plainB = plainBytesOf(values)
    // the chosen encoding = the smallest legal one (mirrors encodeColumn)
    let chosen: EncodingKind = 'plain'
    let chosenBytes = Infinity
    for (const k of availableEncodings(values)) {
      const sz = encodeColumnAs(k, values).byteSize
      if (sz < chosenBytes) {
        chosenBytes = sz
        chosen = k
      }
    }
    return { name, chosen, plainBytes: plainB, chosenBytes, ratio: plainB / chosenBytes }
  })

  // A selective range on the monotone id: keep the top ~5% of ids.
  const ids = rows.map((r) => r[0] as number).sort((a, b) => a - b)
  const cut = ids[Math.floor(ids.length * 0.95)]
  const pred: Predicate[] = [{ kind: 'cmp', col: 'id', op: '>=', value: cut }]
  const res = store.scan(pred, ['id', 'amount'])

  const rowStoreBytes = store.rowStoreBytes()
  const columnarBytes = store.columnarBytes()
  return {
    rows: nRows,
    groupSize,
    rowStoreBytes,
    columnarBytes,
    ratio: rowStoreBytes / columnarBytes,
    perColumn,
    prunePredicate: `id >= ${cut}`,
    totalGroups: res.metrics.totalGroups,
    groupsScanned: res.metrics.groupsScanned,
    groupsPruned: res.metrics.groupsPruned,
    valuesDecoded: res.metrics.valuesDecoded,
    fullScanValues: res.metrics.fullScanValues,
    matched: res.metrics.matched,
  }
}

/** A tiny helper the Lab reuses to make a DATE value (kept here so the bench and
 *  Lab share one construction path). */
export function makeDate(s: string): SqlValue {
  return asTemporalKind('date', s)
}
