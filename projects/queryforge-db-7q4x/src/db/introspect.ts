// Read-only views over the catalog for the UI (schema browser, B+Tree stats).

import type { Database } from './catalog'
import type { BTreeStats } from './storage/btree'
import type { ColumnDef, Expr, FromItem, JoinClause, RefAction, SelectStmt } from './ast'
import { formatValue, type SqlValue } from './types'

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
export interface ForeignKeyInfo {
  columns: string[]
  refTable: string
  refColumns: string[]
  onDelete: RefAction
  onUpdate: RefAction
}
export interface ConstraintInfo {
  primaryKey: string[] | null
  uniques: string[][]
  checks: { name?: string; sql: string }[]
  foreignKeys: ForeignKeyInfo[]
  /** Per-column DEFAULT expressions, rendered as SQL (keyed by column name). */
  defaults: Record<string, string>
}
export interface TableInfo {
  name: string
  columns: ColumnDef[]
  rowCount: number
  indexes: IndexInfo[]
  constraints: ConstraintInfo
  /** Per-column statistics, present only once the table has been analyzed. */
  stats: ColumnStatInfo[] | null
}
export interface ViewInfo {
  name: string
  /** Declared output column names, if the view named them. */
  columns?: string[]
  /** A best-effort one-line rendering of the view's defining query. */
  definition: string
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
    const c = t.constraints
    const defaults: Record<string, string> = {}
    for (const col of t.columns) if (col.default) defaults[col.name] = exprToSql(col.default)
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
      constraints: {
        primaryKey: c.primaryKey ?? (t.columns.some((col) => col.primaryKey) ? t.columns.filter((col) => col.primaryKey).map((col) => col.name) : null),
        uniques: c.uniques,
        checks: c.checks.map((chk) => ({ name: chk.name, sql: exprToSql(chk.expr) })),
        foreignKeys: c.foreignKeys.map((fk) => ({
          columns: fk.columns,
          refTable: fk.refTable,
          refColumns: fk.refColumns,
          onDelete: fk.onDelete,
          onUpdate: fk.onUpdate,
        })),
        defaults,
      },
      stats,
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function describeViews(db: Database): ViewInfo[] {
  const out: ViewInfo[] = []
  for (const v of db.views.values()) {
    out.push({ name: v.name, columns: v.columns, definition: selectToSql(v.select) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** A compact one-line rendering of a SELECT — for showing a view's definition in
 *  the schema browser. Best-effort (covers the common shape), not round-trippable. */
function selectToSql(s: SelectStmt): string {
  const prefix = s.ctes && s.ctes.length ? 'WITH … ' : ''
  const cols = s.columns
    .map((c) => (c.expr.kind === 'star' ? '*' : exprToSql(c.expr) + (c.alias ? ` AS ${c.alias}` : '')))
    .join(', ')
  const fromItem = (it: FromItem | JoinClause): string =>
    it.subquery ? `(…)${it.alias ? ` ${it.alias}` : ''}` : `${it.table}${it.alias && it.alias !== it.table ? ` ${it.alias}` : ''}`
  let from = ''
  if (s.from) {
    from = ' FROM ' + fromItem(s.from)
    for (const j of s.joins) from += ` ${j.type} JOIN ${fromItem(j)}${j.on ? ` ON ${exprToSql(j.on)}` : ''}`
  }
  const where = s.where ? ' WHERE ' + exprToSql(s.where) : ''
  const group = s.groupBy.length ? ' GROUP BY ' + s.groupBy.map(exprToSql).join(', ') : ''
  const setop = s.setOps && s.setOps.length ? ` ${s.setOps[0].op}${s.setOps[0].all ? ' ALL' : ''} …` : ''
  return `${prefix}SELECT ${cols}${from}${where}${group}${setop}`
}

/** A compact, human-readable SQL rendering of an expression (for CHECK/DEFAULT
 *  display in the schema browser — not a round-trippable serializer). */
export function exprToSql(e: Expr): string {
  switch (e.kind) {
    case 'literal':
      return typeof e.value === 'string' ? `'${e.value.replace(/'/g, "''")}'` : formatValue(e.value)
    case 'column':
      return e.table ? `${e.table}.${e.name}` : e.name
    case 'star':
      return e.table ? `${e.table}.*` : '*'
    case 'unary':
      return e.op === 'NOT' ? `NOT ${exprToSql(e.expr)}` : `${e.op}${exprToSql(e.expr)}`
    case 'binary':
      return `${exprToSql(e.left)} ${e.op} ${exprToSql(e.right)}`
    case 'between':
      return `${exprToSql(e.expr)}${e.negated ? ' NOT' : ''} BETWEEN ${exprToSql(e.lo)} AND ${exprToSql(e.hi)}`
    case 'in':
      return `${exprToSql(e.expr)}${e.negated ? ' NOT' : ''} IN (${e.list.map(exprToSql).join(', ')})`
    case 'like':
      return `${exprToSql(e.expr)}${e.negated ? ' NOT' : ''} LIKE ${exprToSql(e.pattern)}`
    case 'isnull':
      return `${exprToSql(e.expr)} IS${e.negated ? ' NOT' : ''} NULL`
    case 'func':
      return `${e.name}(${e.star ? '*' : e.args.map(exprToSql).join(', ')})`
    case 'cast':
      return `CAST(${exprToSql(e.expr)} AS ${e.type})`
    case 'case': {
      const ops = e.operand ? ` ${exprToSql(e.operand)}` : ''
      const whens = e.whens.map((w) => `WHEN ${exprToSql(w.when)} THEN ${exprToSql(w.then)}`).join(' ')
      const els = e.else ? ` ELSE ${exprToSql(e.else)}` : ''
      return `CASE${ops} ${whens}${els} END`
    }
    default:
      return '…'
  }
}
