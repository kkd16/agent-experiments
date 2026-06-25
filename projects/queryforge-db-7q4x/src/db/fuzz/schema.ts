// The fuzzer's world generator: a seed → a small random relational schema, populated
// with random rows (lots of NULLs and duplicates to stress three-valued logic and
// grouping), plus a couple of secondary indexes so the optimizer has access paths it
// could get wrong. Everything is emitted as ordinary DDL/DML so the *real* engine
// builds the database exactly as a user would.

import type { SqlValue } from '../types'
import { Engine } from '../engine'
import type { Rng } from './rng'

export type GColType = 'INTEGER' | 'REAL' | 'TEXT' | 'BOOLEAN'

export interface GCol {
  name: string
  type: GColType
  nullable: boolean
}

export interface GTable {
  name: string
  /** Data columns (excludes the implicit `id INTEGER PRIMARY KEY`). */
  cols: GCol[]
  /** Row values, aligned to `[id, ...cols]`. `id` is 1..n, dense. */
  rows: SqlValue[][]
  /** Names of columns carrying a secondary B-tree index. */
  indexed: string[]
}

export interface FuzzSchema {
  tables: GTable[]
}

const TEXT_POOL = ['a', 'b', 'c', 'ab', 'aa', '', 'z']
const TYPES: GColType[] = ['INTEGER', 'REAL', 'TEXT', 'BOOLEAN']

/** Render a SqlValue as a SQL literal the parser will read back as the same value. */
export function litSql(v: SqlValue): string {
  if (v === null) return 'NULL'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v)
    return v.toFixed(2) // keep REAL literals fractional so type inference stays REAL
  }
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`
  return `'${String(v)}'`
}

/** One random value for a column type. `nullChance` injects NULLs into nullable columns. */
function randValue(rng: Rng, type: GColType, nullable: boolean): SqlValue {
  if (nullable && rng.chance(0.28)) return null
  switch (type) {
    case 'INTEGER':
      return rng.int(0, 6) // small domain → duplicates for GROUP BY / DISTINCT
    case 'REAL':
      return rng.int(0, 8) / 2 // 0, 0.5, 1, … exact in binary
    case 'TEXT':
      return rng.pick(TEXT_POOL)
    case 'BOOLEAN':
      return rng.chance()
  }
}

/** Build a random schema: 1–2 tables, each with 2–4 typed columns and 6–20 rows. */
export function genSchema(rng: Rng): FuzzSchema {
  const nTables = rng.int(1, 2)
  const tables: GTable[] = []
  for (let t = 0; t < nTables; t++) {
    const nCols = rng.int(2, 4)
    const cols: GCol[] = []
    for (let c = 0; c < nCols; c++) {
      cols.push({ name: `c${c}`, type: rng.pick(TYPES), nullable: rng.chance(0.6) })
    }
    const nRows = rng.int(6, 20)
    const rows: SqlValue[][] = []
    for (let r = 0; r < nRows; r++) {
      rows.push([r + 1, ...cols.map((col) => randValue(rng, col.type, col.nullable))])
    }
    // Index 0–2 columns (the PK already gives one unique access path on id).
    const indexed = cols.filter(() => rng.chance(0.4)).map((c) => c.name)
    tables.push({ name: `t${t}`, cols, rows, indexed })
  }
  return { tables }
}

/** The DDL + DML that materializes a schema, statement by statement. */
export function schemaToSql(schema: FuzzSchema): string[] {
  const out: string[] = []
  for (const tbl of schema.tables) {
    const colDefs = ['id INTEGER PRIMARY KEY', ...tbl.cols.map((c) => `${c.name} ${c.type}`)]
    out.push(`CREATE TABLE ${tbl.name} (${colDefs.join(', ')})`)
    if (tbl.rows.length) {
      const colNames = ['id', ...tbl.cols.map((c) => c.name)]
      const values = tbl.rows.map((r) => `(${r.map(litSql).join(', ')})`).join(', ')
      out.push(`INSERT INTO ${tbl.name} (${colNames.join(', ')}) VALUES ${values}`)
    }
    for (const col of tbl.indexed) {
      out.push(`CREATE INDEX idx_${tbl.name}_${col} ON ${tbl.name} (${col})`)
    }
  }
  return out
}

/** Spin up a fresh engine and build the schema into it. */
export function buildEngine(schema: FuzzSchema): Engine {
  const e = new Engine()
  for (const stmt of schemaToSql(schema)) e.execute(stmt)
  return e
}
