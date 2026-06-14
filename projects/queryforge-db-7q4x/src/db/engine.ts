// The engine: the public entry point that runs SQL text end-to-end.
//
//   SQL text → parse → (plan → optimize → execute) → results
//
// It owns the Database, drives DDL/DML directly, plans+runs SELECTs through
// the operator tree, renders EXPLAIN plans, and implements snapshot-based
// transactions (BEGIN/COMMIT/ROLLBACK).

import { parse } from './parser'
import { Database, type Row, type SerializedDb } from './catalog'
import { planSelect } from './planner'
import { compileExpr, truthy, type CompileCtx } from './eval'
import { resolveColumn, type Binding, type Schema } from './schema'
import { SqlError, coerceTo, type SqlValue } from './types'
import type { Operator, PlanNode } from './operators'
import type { Expr, SelectStmt, Statement } from './ast'

export interface RowsResult {
  kind: 'rows'
  columns: Binding[]
  rows: Row[]
  rowCount: number
  elapsedMs: number
  sql: string
}
export interface MessageResult {
  kind: 'message'
  message: string
  rowCount?: number
  elapsedMs: number
  sql: string
}
export interface ExplainResult {
  kind: 'explain'
  plan: PlanNode
  analyze: boolean
  elapsedMs: number
  sql: string
}
export type QueryResult = RowsResult | MessageResult | ExplainResult

const CONST_CTX: CompileCtx = {
  resolve: () => {
    throw new SqlError('column references are not allowed here', 'bind')
  },
}

export class Engine {
  db: Database
  private txnStack: SerializedDb[] = []

  constructor(db = new Database()) {
    this.db = db
  }

  /** Run a script of one or more `;`-separated statements. */
  execute(sql: string): QueryResult[] {
    const stmts = parse(sql)
    const results: QueryResult[] = []
    for (const stmt of stmts) {
      results.push(this.runStatement(stmt, sql))
    }
    return results
  }

  private runStatement(stmt: Statement, sql: string): QueryResult {
    const t0 = performance.now()
    switch (stmt.kind) {
      case 'create_table':
        return this.createTable(stmt, sql, t0)
      case 'drop_table':
        return this.dropTable(stmt, sql, t0)
      case 'create_index':
        return this.createIndex(stmt, sql, t0)
      case 'analyze':
        return this.analyze(stmt, sql, t0)
      case 'insert':
        return this.insert(stmt, sql, t0)
      case 'update':
        return this.update(stmt, sql, t0)
      case 'delete':
        return this.delete(stmt, sql, t0)
      case 'select':
        return this.select(stmt, sql, t0)
      case 'explain':
        return this.explain(stmt, sql, t0)
      case 'txn':
        return this.txn(stmt, sql, t0)
    }
  }

  // --- DDL ------------------------------------------------------------------
  private createTable(stmt: Extract<Statement, { kind: 'create_table' }>, sql: string, t0: number): QueryResult {
    if (this.db.hasTable(stmt.name)) {
      if (stmt.ifNotExists) return msg(`table "${stmt.name}" already exists, skipped`, sql, t0)
      throw new SqlError(`table "${stmt.name}" already exists`, 'ddl')
    }
    if (stmt.columns.length === 0) throw new SqlError('CREATE TABLE requires at least one column', 'ddl')
    const seen = new Set<string>()
    for (const c of stmt.columns) {
      if (seen.has(c.name.toLowerCase())) throw new SqlError(`duplicate column "${c.name}"`, 'ddl')
      seen.add(c.name.toLowerCase())
    }
    this.db.createTable(stmt.name, stmt.columns)
    return msg(`table "${stmt.name}" created (${stmt.columns.length} columns)`, sql, t0)
  }

  private dropTable(stmt: Extract<Statement, { kind: 'drop_table' }>, sql: string, t0: number): QueryResult {
    if (!this.db.hasTable(stmt.name)) {
      if (stmt.ifExists) return msg(`table "${stmt.name}" does not exist, skipped`, sql, t0)
      throw new SqlError(`unknown table "${stmt.name}"`, 'ddl')
    }
    this.db.dropTable(stmt.name)
    return msg(`table "${stmt.name}" dropped`, sql, t0)
  }

  private createIndex(stmt: Extract<Statement, { kind: 'create_index' }>, sql: string, t0: number): QueryResult {
    const table = this.db.getTable(stmt.table)
    if (table.hasIndexNamed(stmt.name)) {
      if (stmt.ifNotExists) return msg(`index "${stmt.name}" already exists, skipped`, sql, t0)
      throw new SqlError(`index "${stmt.name}" already exists`, 'ddl')
    }
    table.createIndex(stmt.name, stmt.columns, stmt.unique)
    const cols = stmt.columns.join(', ')
    return msg(`index "${stmt.name}" created on ${stmt.table} (${cols})`, sql, t0)
  }

  private analyze(stmt: Extract<Statement, { kind: 'analyze' }>, sql: string, t0: number): QueryResult {
    if (stmt.table) {
      const table = this.db.getTable(stmt.table)
      const s = table.analyze()
      return msg(`analyzed "${stmt.table}" (${s.rowCount} rows, ${s.columns.size} columns)`, sql, t0)
    }
    let n = 0
    for (const t of this.db.tables.values()) {
      t.analyze()
      n++
    }
    return msg(`analyzed ${n} table${n === 1 ? '' : 's'}`, sql, t0)
  }

  // --- DML ------------------------------------------------------------------
  private insert(stmt: Extract<Statement, { kind: 'insert' }>, sql: string, t0: number): QueryResult {
    const table = this.db.getTable(stmt.table)
    const targetCols = stmt.columns ?? table.columns.map((c) => c.name)
    const colIndexes = targetCols.map((name) => {
      const i = table.columnIndex(name)
      if (i < 0) throw new SqlError(`no column "${name}" in "${stmt.table}"`, 'bind')
      return i
    })

    const insertValues = (values: SqlValue[]): void => {
      const row: Row = new Array(table.columns.length).fill(null)
      for (let i = 0; i < values.length; i++) {
        row[colIndexes[i]] = coerceTo(table.columns[colIndexes[i]].type, values[i])
      }
      table.insertRow(row)
    }

    let count = 0
    if (stmt.select) {
      // INSERT … SELECT — run the query and feed each result row in.
      const rows = runOperator(planSelect(stmt.select, this.db))
      for (const r of rows) {
        if (r.length !== targetCols.length) {
          throw new SqlError(`INSERT … SELECT produced ${r.length} columns for ${targetCols.length} target columns`, 'bind')
        }
        insertValues(r)
        count++
      }
    } else {
      for (const rowExprs of stmt.rows) {
        if (rowExprs.length !== targetCols.length) {
          throw new SqlError(`INSERT has ${rowExprs.length} values for ${targetCols.length} columns`, 'bind')
        }
        insertValues(rowExprs.map((e) => compileExpr(e, CONST_CTX)([])))
        count++
      }
    }
    return msg(`${count} row${count === 1 ? '' : 's'} inserted into "${stmt.table}"`, sql, t0, count)
  }

  private update(stmt: Extract<Statement, { kind: 'update' }>, sql: string, t0: number): QueryResult {
    const table = this.db.getTable(stmt.table)
    const schema: Schema = table.columns.map((c) => ({ table: table.name, name: c.name, type: c.type }))
    const ctx: CompileCtx = { resolve: (t, n) => resolveColumn(schema, t, n) }
    const pred = stmt.where ? compileExpr(stmt.where, ctx) : null
    const setters = stmt.assignments.map((a) => {
      const i = table.columnIndex(a.column)
      if (i < 0) throw new SqlError(`no column "${a.column}" in "${stmt.table}"`, 'bind')
      return { i, fn: compileExpr(a.value, ctx) }
    })
    const targets: number[] = []
    for (const [rowid, row] of table.heap) if (!pred || truthy(pred(row))) targets.push(rowid)
    for (const rowid of targets) {
      const row = table.heap.get(rowid)!
      const next = row.slice()
      for (const s of setters) next[s.i] = coerceTo(table.columns[s.i].type, s.fn(row))
      table.updateRow(rowid, next)
    }
    return msg(`${targets.length} row${targets.length === 1 ? '' : 's'} updated in "${stmt.table}"`, sql, t0, targets.length)
  }

  private delete(stmt: Extract<Statement, { kind: 'delete' }>, sql: string, t0: number): QueryResult {
    const table = this.db.getTable(stmt.table)
    const schema: Schema = table.columns.map((c) => ({ table: table.name, name: c.name, type: c.type }))
    const pred = stmt.where ? compileExpr(stmt.where, { resolve: (t, n) => resolveColumn(schema, t, n) }) : null
    const targets: number[] = []
    for (const [rowid, row] of table.heap) if (!pred || truthy(pred(row))) targets.push(rowid)
    for (const rowid of targets) table.deleteRow(rowid)
    return msg(`${targets.length} row${targets.length === 1 ? '' : 's'} deleted from "${stmt.table}"`, sql, t0, targets.length)
  }

  // --- SELECT / EXPLAIN -----------------------------------------------------
  private select(stmt: SelectStmt, sql: string, t0: number): RowsResult {
    const op = planSelect(stmt, this.db)
    const rows = runOperator(op)
    return {
      kind: 'rows',
      columns: op.schema,
      rows,
      rowCount: rows.length,
      elapsedMs: performance.now() - t0,
      sql,
    }
  }

  private explain(stmt: Extract<Statement, { kind: 'explain' }>, sql: string, t0: number): ExplainResult {
    const inner = stmt.statement
    if (inner.kind !== 'select') {
      throw new SqlError('EXPLAIN currently supports SELECT statements', 'plan')
    }
    const op = planSelect(inner, this.db)
    if (stmt.analyze) runOperator(op)
    return { kind: 'explain', plan: op.plan(), analyze: stmt.analyze, elapsedMs: performance.now() - t0, sql }
  }

  // --- transactions ---------------------------------------------------------
  private txn(stmt: Extract<Statement, { kind: 'txn' }>, sql: string, t0: number): QueryResult {
    switch (stmt.action) {
      case 'begin':
        this.txnStack.push(this.db.snapshot())
        return msg('transaction started', sql, t0)
      case 'commit':
        if (this.txnStack.length === 0) throw new SqlError('no transaction in progress', 'txn')
        this.txnStack.pop()
        return msg('transaction committed', sql, t0)
      case 'rollback': {
        if (this.txnStack.length === 0) throw new SqlError('no transaction in progress', 'txn')
        const snap = this.txnStack.pop()!
        this.db = Database.restore(snap)
        return msg('transaction rolled back', sql, t0)
      }
    }
  }
}

function runOperator(op: Operator): Row[] {
  const rows: Row[] = []
  op.open()
  try {
    for (let r = op.next(); r !== null; r = op.next()) rows.push(r)
  } finally {
    op.close()
  }
  return rows
}

function msg(text: string, sql: string, t0: number, rowCount?: number): MessageResult {
  return { kind: 'message', message: text, rowCount, elapsedMs: performance.now() - t0, sql }
}

/** Evaluate a single constant expression (handy for tests / the REPL). */
export function evalConstant(expr: Expr): SqlValue {
  return compileExpr(expr, CONST_CTX)([])
}
