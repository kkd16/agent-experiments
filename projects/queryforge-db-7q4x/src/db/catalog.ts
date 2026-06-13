// The catalog: tables, their columns, heap storage and secondary indexes.
//
// A Table stores rows in a "heap" keyed by a monotonically increasing rowid
// (the physical address), plus zero or more B+Tree indexes over individual
// columns. This mirrors how a real row-store works: the heap is the source of
// truth, indexes are derived structures the planner may exploit.

import { BTree, type BTreeStats } from './storage/btree'
import { SqlError, coerceTo, type ColumnType, type SqlValue } from './types'
import type { ColumnDef } from './ast'

export type Row = SqlValue[]

export interface IndexMeta {
  name: string
  column: string
  columnIndex: number
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
}

export class Table {
  readonly name: string
  readonly columns: ColumnDef[]
  /** rowid -> row. A Map preserves insertion order for stable scans. */
  readonly heap = new Map<number, Row>()
  readonly indexes = new Map<string, IndexHandle>()
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
      const key = row[idx.meta.columnIndex]
      if (idx.meta.unique && key !== null && idx.tree.search(key).length > 0) {
        this.heap.delete(rowid)
        throw new SqlError(`UNIQUE constraint violated on "${this.name}.${idx.meta.column}"`, 'constraint')
      }
      idx.tree.insert(key, rowid)
    }
    return rowid
  }

  deleteRow(rowid: number): void {
    const row = this.heap.get(rowid)
    if (!row) return
    for (const idx of this.indexes.values()) idx.tree.remove(row[idx.meta.columnIndex], rowid)
    this.heap.delete(rowid)
  }

  updateRow(rowid: number, newRow: Row): void {
    this.validateRow(newRow)
    const old = this.heap.get(rowid)
    if (!old) return
    for (const idx of this.indexes.values()) {
      idx.tree.remove(old[idx.meta.columnIndex], rowid)
    }
    this.heap.set(rowid, newRow)
    for (const idx of this.indexes.values()) idx.tree.insert(newRow[idx.meta.columnIndex], rowid)
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

  // --- indexes ------------------------------------------------------------
  createIndex(name: string, column: string, unique: boolean): IndexHandle {
    const columnIndex = this.columnIndex(column)
    if (columnIndex < 0) throw new SqlError(`no column "${column}" to index on "${this.name}"`, 'bind')
    const tree = new BTree()
    const handle = new IndexHandle({ name, column, columnIndex, unique }, tree)
    // Backfill existing rows.
    for (const [rowid, row] of this.heap) tree.insert(row[columnIndex], rowid)
    this.indexes.set(column.toLowerCase(), handle)
    return handle
  }

  indexForColumn(column: string): IndexHandle | undefined {
    return this.indexes.get(column.toLowerCase())
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
      if (c.primaryKey || c.unique) t.createIndex(`${name}_${c.name}_idx`, c.name, true)
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
          column: i.meta.column,
          unique: i.meta.unique,
        })),
      })
    }
    return { version: 1, tables }
  }

  static restore(snap: SerializedDb): Database {
    const db = new Database()
    for (const t of snap.tables) {
      const table = db.createTable(t.name, t.columns)
      for (const row of t.rows) table.insertRow(row.slice())
      for (const idx of t.indexes) {
        if (!table.indexForColumn(idx.column)) table.createIndex(idx.name, idx.column, idx.unique)
      }
    }
    return db
  }
}

export interface SerializedTable {
  name: string
  columns: ColumnDef[]
  rows: Row[]
  indexes: { name: string; column: string; unique: boolean }[]
}
export interface SerializedDb {
  version: number
  tables: SerializedTable[]
}
