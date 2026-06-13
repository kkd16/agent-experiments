// Read-only views over the catalog for the UI (schema browser, B+Tree stats).

import type { Database } from './catalog'
import type { BTreeStats } from './storage/btree'
import type { ColumnDef } from './ast'

export interface IndexInfo {
  name: string
  column: string
  unique: boolean
  stats: BTreeStats
}
export interface TableInfo {
  name: string
  columns: ColumnDef[]
  rowCount: number
  indexes: IndexInfo[]
}

export function describeSchema(db: Database): TableInfo[] {
  const out: TableInfo[] = []
  for (const t of db.tables.values()) {
    out.push({
      name: t.name,
      columns: t.columns,
      rowCount: t.rowCount(),
      indexes: [...t.indexes.values()].map((i) => ({
        name: i.meta.name,
        column: i.meta.column,
        unique: i.meta.unique,
        stats: i.stats(),
      })),
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
