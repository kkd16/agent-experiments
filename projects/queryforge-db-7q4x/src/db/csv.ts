// CSV → SQL: a small, dependency-free RFC-4180-ish parser plus a generator that
// turns a pasted/loaded CSV into a CREATE TABLE + bulk INSERT script. Column
// types are inferred from the data. Identifiers are emitted double-quoted so
// header names that collide with SQL keywords still work.

import type { ColumnType } from './types'

/** Parse CSV text into a matrix of string cells (handles quotes, commas, CRLF
 *  and embedded newlines). Trailing blank lines are dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let started = false
  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
    started = false
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    started = true
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
      continue
    }
    if (c === '"') inQuotes = true
    else if (c === ',') pushField()
    else if (c === '\r') {
      if (text[i + 1] === '\n') i++
      pushRow()
    } else if (c === '\n') pushRow()
    else field += c
  }
  if (started || field.length || row.length) pushRow()
  // Drop fully-empty trailing rows.
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}

const INT_RE = /^-?\d+$/
const REAL_RE = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
const BOOL_RE = /^(true|false|t|f)$/i

function inferColumnType(values: string[]): ColumnType {
  let any = false
  let allInt = true
  let allReal = true
  let allBool = true
  for (const raw of values) {
    const v = raw.trim()
    if (v === '') continue
    any = true
    if (!INT_RE.test(v)) allInt = false
    if (!REAL_RE.test(v)) allReal = false
    if (!BOOL_RE.test(v)) allBool = false
  }
  if (!any) return 'TEXT'
  if (allInt) return 'INTEGER'
  if (allReal) return 'REAL'
  if (allBool) return 'BOOLEAN'
  return 'TEXT'
}

function sanitizeIdent(name: string, fallback: string): string {
  const t = name.trim()
  return t === '' ? fallback : t
}
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}
function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

function renderValue(raw: string, type: ColumnType): string {
  const v = raw.trim()
  if (v === '') return 'NULL'
  switch (type) {
    case 'INTEGER':
    case 'REAL':
    case 'DECIMAL':
      return REAL_RE.test(v) || INT_RE.test(v) ? v : sqlString(raw)
    case 'BOOLEAN':
      if (/^(true|t)$/i.test(v)) return 'TRUE'
      if (/^(false|f)$/i.test(v)) return 'FALSE'
      return 'NULL'
    case 'TEXT':
    case 'DATE':
    case 'TIME':
    case 'TIMESTAMP':
    case 'INTERVAL':
    case 'JSON':
    case 'TSVECTOR':
    case 'TSQUERY':
    case 'ARRAY':
      return sqlString(raw)
  }
}

export interface CsvImportResult {
  tableName: string
  columns: { name: string; type: ColumnType }[]
  rowCount: number
  /** CREATE TABLE + INSERT script. */
  sql: string
  /** A SELECT to preview the freshly imported table. */
  previewSql: string
}

export interface CsvImportOptions {
  tableName: string
  hasHeader: boolean
}

export function csvToSql(text: string, opts: CsvImportOptions): CsvImportResult {
  const matrix = parseCsv(text)
  if (matrix.length === 0) throw new Error('no rows found in the CSV')
  const ncols = Math.max(...matrix.map((r) => r.length))
  // Normalize ragged rows.
  for (const r of matrix) while (r.length < ncols) r.push('')

  const header = opts.hasHeader ? matrix[0] : matrix[0].map((_, i) => `col${i + 1}`)
  const dataRows = opts.hasHeader ? matrix.slice(1) : matrix
  if (dataRows.length === 0) throw new Error('the CSV has a header but no data rows')

  const seen = new Set<string>()
  const colNames = header.map((h, i) => {
    let name = sanitizeIdent(h, `col${i + 1}`)
    let candidate = name
    let n = 2
    while (seen.has(candidate.toLowerCase())) candidate = `${name}_${n++}`
    name = candidate
    seen.add(name.toLowerCase())
    return name
  })

  const columns = colNames.map((name, i) => ({
    name,
    type: inferColumnType(dataRows.map((r) => r[i] ?? '')),
  }))

  const tableName = sanitizeIdent(opts.tableName, 'imported')
  const qTable = quoteIdent(tableName)
  const colDefs = columns.map((c) => `${quoteIdent(c.name)} ${c.type}`).join(', ')
  const colList = columns.map((c) => quoteIdent(c.name)).join(', ')

  const tuples = dataRows.map(
    (r) => `(${columns.map((c, i) => renderValue(r[i] ?? '', c.type)).join(', ')})`,
  )
  const sql =
    `DROP TABLE IF EXISTS ${qTable};\n` +
    `CREATE TABLE ${qTable} (${colDefs});\n` +
    `INSERT INTO ${qTable} (${colList}) VALUES\n${tuples.join(',\n')};`

  return {
    tableName,
    columns,
    rowCount: dataRows.length,
    sql,
    previewSql: `SELECT * FROM ${qTable} LIMIT 50;`,
  }
}
