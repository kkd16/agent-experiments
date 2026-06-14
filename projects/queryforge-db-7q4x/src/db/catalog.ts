// The catalog: tables, their columns, heap storage and secondary indexes.
//
// A Table stores rows in a "heap" keyed by a monotonically increasing rowid
// (the physical address), plus zero or more B+Tree indexes over one *or more*
// columns. This mirrors how a real row-store works: the heap is the source of
// truth, indexes are derived structures the planner may exploit.
//
// Each table also caches optimizer statistics (see ./stats); the cache is
// dropped on any mutation so the next plan sees fresh numbers.

import { BTree, type BTreeStats, type IndexKey } from './storage/btree'
import { gatherTableStats, type TableStat } from './stats'
import { SqlError, coerceTo, type ColumnType, type SqlValue } from './types'
import type { ColumnDef } from './ast'

export type Row = SqlValue[]

export interface IndexMeta {
  name: string
  /** The indexed columns, in order (length 1 for a single-column index). */
  columns: string[]
  /** Positional indexes of `columns` within the table's row. */
  columnIndexes: number[]
  unique: boolean
}

export class IndexHandle {
  readonly meta: IndexMeta
  readonly tree: BTree
  constructor(meta: IndexMeta, tree: BTree) {
    this.meta = meta
    this.tree = tree
  }
  stats(): BTreeStats {
    return this.tree.stats()
  }
  /** Build this index's key tuple from a heap row. */
  keyOf(row: Row): IndexKey {
    return this.meta.columnIndexes.map((i) => row[i])
  }
}

export class Table {
  readonly name: string
  readonly columns: ColumnDef[]
  /** rowid -> row. A Map preserves insertion order for stable scans. */
  readonly heap = new Map<number, Row>()
  /** index name (lower-case) -> handle. */
  readonly indexes = new Map<string, IndexHandle>()
  /** Cached optimizer statistics (null = stale / not yet gathered). */
  private statsCache: TableStat | null = null
  private nextRowId = 1

  constructor(name: string, columns: ColumnDef[]) {
    this.name = name
    this.columns = columns
  }

  columnIndex(name: string): number {
    return this.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase())
  }
  columnType(name: string): ColumnType {
    const i = this.columnIndex(name)
    if (i < 0) throw new SqlError(`no column "${name}" in table "${this.name}"`, 'bind')
    return this.columns[i].type
  }

  rowCount(): number {
    return this.heap.size
  }

  // --- mutation -----------------------------------------------------------
  insertRow(row: Row): number {
    this.validateRow(row)
    const rowid = this.nextRowId++
    this.heap.set(rowid, row)
    for (const idx of this.indexes.values()) {
      const key = idx.keyOf(row)
      if (idx.meta.unique && key.every((k) => k !== null) && idx.tree.search(key).length > 0) {
        this.heap.delete(rowid)
        throw new SqlError(`UNIQUE constraint violated on "${this.name}.${idx.meta.columns.join(', ')}"`, 'constraint')
      }
      idx.tree.insert(key, rowid)
    }
    this.statsCache = null
    return rowid
  }

  /** Insert a row verbatim (no coercion / constraint checks). Used for
   *  transient relations materialized from query results. */
  insertRawRow(row: Row): number {
    const rowid = this.nextRowId++
    this.heap.set(rowid, row)
    for (const idx of this.indexes.values()) idx.tree.insert(idx.keyOf(row), rowid)
    this.statsCache = null
    return rowid
  }

  deleteRow(rowid: number): void {
    const row = this.heap.get(rowid)
    if (!row) return
    for (const idx of this.indexes.values()) idx.tree.remove(idx.keyOf(row), rowid)
    this.heap.delete(rowid)
    this.statsCache = null
  }

  updateRow(rowid: number, newRow: Row): void {
    this.validateRow(newRow)
    const old = this.heap.get(rowid)
    if (!old) return
    for (const idx of this.indexes.values()) idx.tree.remove(idx.keyOf(old), rowid)
    this.heap.set(rowid, newRow)
    for (const idx of this.indexes.values()) idx.tree.insert(idx.keyOf(newRow), rowid)
    this.statsCache = null
  }

  private validateRow(row: Row): void {
    for (let i = 0; i < this.columns.length; i++) {
      const col = this.columns[i]
      if (row[i] === null && col.notNull) {
        throw new SqlError(`NOT NULL constraint violated on "${this.name}.${col.name}"`, 'constraint')
      }
      row[i] = coerceTo(col.type, row[i])
    }
  }

  // --- statistics ---------------------------------------------------------
  /** Return cached stats, gathering them lazily if stale. */
  ensureStats(): TableStat {
    if (!this.statsCache) {
      this.statsCache = gatherTableStats(
        this.heap.values(),
        this.columns.map((c) => ({ name: c.name, type: c.type })),
      )
    }
    return this.statsCache
  }
  /** Force a fresh stats gather (ANALYZE). */
  analyze(): TableStat {
    this.statsCache = null
    return this.ensureStats()
  }
  hasStats(): boolean {
    return this.statsCache !== null
  }

  // --- indexes ------------------------------------------------------------
  createIndex(name: string, columns: string[], unique: boolean): IndexHandle {
    const columnIndexes = columns.map((c) => {
      const i = this.columnIndex(c)
      if (i < 0) throw new SqlError(`no column "${c}" to index on "${this.name}"`, 'bind')
      return i
    })
    const tree = new BTree()
    const handle = new IndexHandle({ name, columns, columnIndexes, unique }, tree)
    // Backfill existing rows.
    for (const [rowid, row] of this.heap) tree.insert(handle.keyOf(row), rowid)
    this.indexes.set(name.toLowerCase(), handle)
    return handle
  }

  /** A single-column index on exactly `column`, if one exists. */
  indexForColumn(column: string): IndexHandle | undefined {
    const lc = column.toLowerCase()
    for (const idx of this.indexes.values()) {
      if (idx.meta.columns.length === 1 && idx.meta.columns[0].toLowerCase() === lc) return idx
    }
    return undefined
  }

  /** All indexes whose *leading* column is `column` (single or composite). */
  indexesLeadingWith(column: string): IndexHandle[] {
    const lc = column.toLowerCase()
    const out: IndexHandle[] = []
    for (const idx of this.indexes.values()) {
      if (idx.meta.columns[0]?.toLowerCase() === lc) out.push(idx)
    }
    return out
  }

  allIndexes(): IndexHandle[] {
    return [...this.indexes.values()]
  }
  hasIndexNamed(name: string): boolean {
    return this.indexes.has(name.toLowerCase())
  }
}

export class Database {
  readonly tables = new Map<string, Table>()

  getTable(name: string): Table {
    const t = this.tables.get(name.toLowerCase())
    if (!t) throw new SqlError(`unknown table "${name}"`, 'bind')
    return t
  }
  hasTable(name: string): boolean {
    return this.tables.has(name.toLowerCase())
  }
  createTable(name: string, columns: ColumnDef[]): Table {
    const t = new Table(name, columns)
    this.tables.set(name.toLowerCase(), t)
    // Auto-index primary keys / unique columns.
    for (const c of columns) {
      if (c.primaryKey || c.unique) t.createIndex(`${name}_${c.name}_idx`, [c.name], true)
    }
    return t
  }
  dropTable(name: string): void {
    this.tables.delete(name.toLowerCase())
  }

  /** Deep snapshot for transactions / persistence. */
  snapshot(): SerializedDb {
    const tables: SerializedTable[] = []
    for (const t of this.tables.values()) {
      tables.push({
        name: t.name,
        columns: t.columns,
        rows: [...t.heap.values()].map((r) => r.slice()),
        indexes: [...t.indexes.values()].map((i) => ({
          name: i.meta.name,
          columns: i.meta.columns,
          unique: i.meta.unique,
        })),
      })
    }
    return { version: 2, tables }
  }

  static restore(snap: SerializedDb): Database {
    const db = new Database()
    for (const t of snap.tables) {
      const table = db.createTable(t.name, t.columns)
      for (const row of t.rows) table.insertRow(row.slice())
      for (const idx of t.indexes) {
        // Back-compat: v1 snapshots stored a single `column`.
        const columns = idx.columns ?? (idx.column ? [idx.column] : [])
        if (columns.length && !table.hasIndexNamed(idx.name)) table.createIndex(idx.name, columns, idx.unique)
      }
    }
    return db
  }
}

export interface SerializedIndex {
  name: string
  columns?: string[]
  /** Legacy single-column form (v1 snapshots). */
  column?: string
  unique: boolean
}
export interface SerializedTable {
  name: string
  columns: ColumnDef[]
  rows: Row[]
  indexes: SerializedIndex[]
}
export interface SerializedDb {
  version: number
  tables: SerializedTable[]
}
