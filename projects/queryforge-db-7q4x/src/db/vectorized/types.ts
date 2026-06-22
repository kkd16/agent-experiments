// The vectorized engine's physical layer: a COLUMNAR store + a selection vector.
//
// The Volcano engine (the rest of QueryForge) is row-at-a-time: a tuple is a
// `SqlValue[]` pulled through a tree of `next()` calls. The vectorized engine
// flips the layout — it materializes a relation column-by-column into
// contiguous arrays (numeric columns into a `Float64Array`, so a million
// integers live in one packed buffer with zero per-value boxing) and then
// processes *batches* of rows. A batch is just a window of row indices plus a
// SELECTION VECTOR (`Int32Array`) listing which of them are still active; a
// filter narrows the selection instead of copying rows. This is the layout that
// makes the kernels in `kernels.ts` fast.

import type { ColumnType, SqlValue } from '../types'
import type { Table } from '../catalog'

/** The default vector (batch) width. ~1–2k is the classic sweet spot: big
 *  enough to amortize per-batch overhead, small enough that a column's working
 *  set stays in L1/L2 cache. The Lab sweeps this to show the curve. */
export const DEFAULT_VECTOR_SIZE = 1024

/** A numeric column packed into a `Float64Array` (INTEGER/REAL/BOOLEAN — all
 *  `number` in this engine, with BOOLEAN stored as 0/1). `nulls` is a 1-byte
 *  presence flag per row (1 ⇒ NULL); when the column has no NULLs it is `null`
 *  and the fast loops can skip the check entirely. */
export interface NumColumn {
  kind: 'f64'
  type: ColumnType
  data: Float64Array
  nulls: Uint8Array | null
}

/** Any column we don't pack numerically (TEXT, JSON, arrays, temporal, …). The
 *  vectorized engine never computes on these — it only carries them through to
 *  the output projection — so a plain `SqlValue[]` is all we need. */
export interface GenColumn {
  kind: 'gen'
  type: ColumnType
  data: SqlValue[]
}

export type Column = NumColumn | GenColumn

export interface ColumnStore {
  /** Positional, matching the table's column order. */
  columns: Column[]
  /** Lowercased column names, for resolving a `ColumnExpr` to a column index. */
  names: string[]
  rowCount: number
}

/** A numeric column is one whose declared type packs losslessly into a
 *  `Float64Array` *and* renders identically as a value: INTEGER and REAL. (We
 *  deliberately exclude BOOLEAN: it is a `number` internally but must render as
 *  TRUE/FALSE, so packing it would make a grouped/projected boolean disagree
 *  with the Volcano engine. A boolean column stays generic ⇒ such a query
 *  falls back to Volcano — correct over fast.) */
export function isNumericType(t: ColumnType): boolean {
  return t === 'INTEGER' || t === 'REAL'
}

/** Materialize a table's heap into a columnar store, ONCE. Rows are read in
 *  heap (insertion / rowid) order — the *same* order the Volcano `SeqScan`
 *  visits them — so an order-sensitive reduction (a floating-point `SUM`) lands
 *  on the identical bit pattern in both engines. */
export function buildColumnStore(table: Table): ColumnStore {
  const colDefs = table.columns
  const n = table.heap.size
  const ncols = colDefs.length
  const numeric = colDefs.map((c) => isNumericType(c.type))

  const numData: (Float64Array | null)[] = colDefs.map((_, j) => (numeric[j] ? new Float64Array(n) : null))
  const numNulls: (Uint8Array | null)[] = colDefs.map(() => null)
  const genData: (SqlValue[] | null)[] = colDefs.map((_, j) => (numeric[j] ? null : new Array<SqlValue>(n)))

  let r = 0
  for (const row of table.heap.values()) {
    for (let j = 0; j < ncols; j++) {
      const v = row[j]
      if (numeric[j]) {
        const arr = numData[j]!
        if (v === null) {
          let nulls = numNulls[j]
          if (!nulls) {
            nulls = new Uint8Array(n)
            numNulls[j] = nulls
          }
          nulls[r] = 1
          // data[r] stays 0; the null flag shadows it.
        } else {
          arr[r] = typeof v === 'boolean' ? (v ? 1 : 0) : (v as number)
        }
      } else {
        genData[j]![r] = v
      }
    }
    r++
  }

  const columns: Column[] = colDefs.map((c, j) =>
    numeric[j]
      ? { kind: 'f64', type: c.type, data: numData[j]!, nulls: numNulls[j] }
      : { kind: 'gen', type: c.type, data: genData[j]! },
  )

  return {
    columns,
    names: colDefs.map((c) => c.name.toLowerCase()),
    rowCount: n,
  }
}

/** Resolve a (possibly table-qualified) column name to its store index. */
export function columnIndex(store: ColumnStore, name: string): number {
  return store.names.indexOf(name.toLowerCase())
}
