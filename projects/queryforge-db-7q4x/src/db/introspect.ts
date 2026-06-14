// Read-only views over the catalog for the UI (schema browser, B+Tree stats).

import type { Database } from './catalog'
import type { BTreeStats } from './storage/btree'
import type { ColumnDef } from './ast'
import type { SqlValue } from './types'

export interface IndexInfo {
  name: string
  columns: string[]
  unique: boolean
  stats: BTreeStats
}
export interface ColumnStatInfo {
  column: string
  ndistinct: number
  nullCount: number
  min: SqlValue
  max: SqlValue
}
export interface TableInfo {
  name: string
  columns: ColumnDef[]
  rowCount: number
  indexes: IndexInfo[]
  /** Per-column statistics, present only once the table has been analyzed. */
  stats: ColumnStatInfo[] | null
}

export function describeSchema(db: Database): TableInfo[] {
  const out: TableInfo[] = []
  for (const t of db.tables.values()) {
    let stats: ColumnStatInfo[] | null = null
    if (t.hasStats()) {
      const ts = t.ensureStats()
      stats = [...ts.columns.values()].map((c) => ({
        column: c.column,
        ndistinct: c.ndistinct,
        nullCount: c.nullCount,
        min: c.min,
        max: c.max,
      }))
    }
    out.push({
      name: t.name,
      columns: t.columns,
      rowCount: t.rowCount(),
      indexes: [...t.indexes.values()].map((i) => ({
        name: i.meta.name,
        columns: i.meta.columns,
        unique: i.meta.unique,
        stats: i.stats(),
      })),
      stats,
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
