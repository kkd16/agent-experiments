// The engine: the public entry point that runs SQL text end-to-end.
//
//   SQL text → parse → (plan → optimize → execute) → results
//
// It owns the Database, drives DDL/DML directly, plans+runs SELECTs through
// the operator tree, renders EXPLAIN plans, and implements snapshot-based
// transactions (BEGIN/COMMIT/ROLLBACK).

import { parse } from './parser'
import { Database, Table, type Row, type SerializedDb } from './catalog'
import { planSelect } from './planner'
import { compileExpr, truthy, type CompileCtx } from './eval'
import { resolveColumn, type Binding, type Schema } from './schema'
import { SqlError, coerceTo, type SqlValue } from './types'
import type { Operator, PlanNode } from './operators'
import type { Expr, OnConflictClause, SelectStmt, Statement } from './ast'

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
    // Statement atomicity: a mutating statement that fails part-way (a constraint
    // violation on row 50 of a bulk insert, a cascade that hits a RESTRICT) leaves
    // the database exactly as it was. We snapshot first and roll back on any throw.
    if (isMutation(stmt.kind)) {
      const snap = this.db.snapshot()
      try {
        return this.dispatch(stmt, sql)
      } catch (err) {
        this.db = Database.restore(snap)
        throw err
      }
    }
    return this.dispatch(stmt, sql)
  }

  private dispatch(stmt: Statement, sql: string): QueryResult {
    const t0 = performance.now()
    switch (stmt.kind) {
      case 'create_table':
        return this.createTable(stmt, sql, t0)
      case 'alter_table':
        return this.alterTable(stmt, sql, t0)
      case 'drop_table':
        return this.dropTable(stmt, sql, t0)
      case 'create_view':
        return this.createView(stmt, sql, t0)
      case 'drop_view':
        return this.dropView(stmt, sql, t0)
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
    if (this.db.hasView(stmt.name)) {
      throw new SqlError(`"${stmt.name}" already exists as a view`, 'ddl')
    }
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
    this.db.createTable(stmt.name, stmt.columns, stmt.constraints)
    return msg(`table "${stmt.name}" created (${stmt.columns.length} columns)`, sql, t0)
  }

  private alterTable(stmt: Extract<Statement, { kind: 'alter_table' }>, sql: string, t0: number): QueryResult {
    const table = this.db.getTable(stmt.table)
    const a = stmt.action
    switch (a.kind) {
      case 'add_column': {
        table.addColumn(a.column)
        if (a.column.primaryKey || a.column.unique) {
          table.createIndex(`${table.name}_${a.column.name}_key`, [a.column.name], true)
        }
        return msg(`column "${a.column.name}" added to "${table.name}"`, sql, t0)
      }
      case 'drop_column': {
        const used = table.columnDependents(a.column)
        if (used.length > 0) {
          throw new SqlError(`cannot drop column "${a.column}" — used by ${used.join(', ')}`, 'ddl')
        }
        for (const other of this.db.tables.values()) {
          for (const fk of other.constraints.foreignKeys) {
            if (fk.refTable.toLowerCase() === table.name.toLowerCase() && fk.refColumns.some((c) => c.toLowerCase() === a.column.toLowerCase())) {
              throw new SqlError(`cannot drop column "${a.column}" — referenced by FOREIGN KEY on "${other.name}"`, 'ddl')
            }
          }
        }
        table.dropColumn(a.column)
        return msg(`column "${a.column}" dropped from "${table.name}"`, sql, t0)
      }
      case 'rename_table': {
        if (this.db.hasTable(a.to)) throw new SqlError(`table "${a.to}" already exists`, 'ddl')
        const old = table.name
        this.db.tables.delete(old.toLowerCase())
        table.name = a.to
        this.db.tables.set(a.to.toLowerCase(), table)
        for (const other of this.db.tables.values()) {
          for (const fk of other.constraints.foreignKeys) {
            if (fk.refTable.toLowerCase() === old.toLowerCase()) fk.refTable = a.to
          }
        }
        return msg(`table "${old}" renamed to "${a.to}"`, sql, t0)
      }
      case 'rename_column': {
        table.renameColumn(a.column, a.to)
        for (const other of this.db.tables.values()) {
          for (const fk of other.constraints.foreignKeys) {
            if (fk.refTable.toLowerCase() === table.name.toLowerCase()) {
              fk.refColumns = fk.refColumns.map((c) => (c.toLowerCase() === a.column.toLowerCase() ? a.to : c))
            }
          }
        }
        return msg(`column "${a.column}" renamed to "${a.to}" in "${table.name}"`, sql, t0)
      }
      case 'add_check': {
        table.constraints.checks.push(a.check)
        table.invalidateChecks()
        for (const row of table.heap.values()) table.validateRow(row)
        return msg(`CHECK constraint added to "${table.name}"`, sql, t0)
      }
      case 'add_unique': {
        if (!table.uniqueIndexOn(a.columns)) {
          table.createIndex(`${table.name}_uniq_${a.columns.join('_')}`, a.columns, true)
        }
        table.constraints.uniques.push(a.columns)
        return msg(`UNIQUE constraint added to "${table.name}" (${a.columns.join(', ')})`, sql, t0)
      }
      case 'add_foreign_key': {
        this.db.validateForeignKey(table, a.fk)
        // Verify existing rows satisfy the new reference before recording it.
        for (const row of table.heap.values()) {
          this.db.checkReferencesFor(table, row, a.fk)
        }
        table.constraints.foreignKeys.push(a.fk)
        return msg(`FOREIGN KEY added to "${table.name}" (${a.fk.columns.join(', ')})`, sql, t0)
      }
    }
  }

  private dropTable(stmt: Extract<Statement, { kind: 'drop_table' }>, sql: string, t0: number): QueryResult {
    if (!this.db.hasTable(stmt.name)) {
      if (stmt.ifExists) return msg(`table "${stmt.name}" does not exist, skipped`, sql, t0)
      throw new SqlError(`unknown table "${stmt.name}"`, 'ddl')
    }
    this.db.dropTable(stmt.name)
    return msg(`table "${stmt.name}" dropped`, sql, t0)
  }

  private createView(stmt: Extract<Statement, { kind: 'create_view' }>, sql: string, t0: number): QueryResult {
    if (this.db.hasTable(stmt.name)) {
      throw new SqlError(`"${stmt.name}" already exists as a table`, 'ddl')
    }
    if (this.db.hasView(stmt.name) && !stmt.orReplace) {
      if (stmt.ifNotExists) return msg(`view "${stmt.name}" already exists, skipped`, sql, t0)
      throw new SqlError(`view "${stmt.name}" already exists (use CREATE OR REPLACE VIEW)`, 'ddl')
    }
    // Register first, then validate by planning the body — so a self-referential
    // or otherwise broken definition is caught (and rolled back, since this
    // statement is atomic). Planning binds every column and resolves every
    // relation without executing the main pipeline.
    this.db.setView({ name: stmt.name, columns: stmt.columns, select: stmt.select })
    const op = planSelect(stmt.select, this.db)
    if (stmt.columns && stmt.columns.length !== op.schema.length) {
      throw new SqlError(
        `CREATE VIEW "${stmt.name}" declares ${stmt.columns.length} columns but its query yields ${op.schema.length}`,
        'ddl',
      )
    }
    const verb = this.db.hasView(stmt.name) && stmt.orReplace ? 'created or replaced' : 'created'
    return msg(`view "${stmt.name}" ${verb} (${op.schema.length} columns)`, sql, t0)
  }

  private dropView(stmt: Extract<Statement, { kind: 'drop_view' }>, sql: string, t0: number): QueryResult {
    if (!this.db.hasView(stmt.name)) {
      if (stmt.ifExists) return msg(`view "${stmt.name}" does not exist, skipped`, sql, t0)
      throw new SqlError(`unknown view "${stmt.name}"`, 'ddl')
    }
    this.db.dropView(stmt.name)
    return msg(`view "${stmt.name}" dropped`, sql, t0)
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

    const provided = new Set(colIndexes)
    const onConflict = stmt.onConflict
    // Pre-compile the upsert resolver once (resolves the target table's own
    // columns to the existing row, and EXCLUDED.* to the proposed row).
    const upsert = onConflict ? this.prepareUpsert(table, onConflict) : null

    let inserted = 0
    let updated = 0
    const insertValues = (values: SqlValue[]): void => {
      const row: Row = new Array(table.columns.length).fill(null)
      for (let i = 0; i < values.length; i++) {
        row[colIndexes[i]] = coerceTo(table.columns[colIndexes[i]].type, values[i])
      }
      // Columns not supplied take their DEFAULT (if any); the rest stay NULL.
      for (let i = 0; i < table.columns.length; i++) {
        const col = table.columns[i]
        if (!provided.has(i) && col.default) {
          row[i] = coerceTo(col.type, evalConstant(col.default))
        }
      }
      if (upsert) {
        // Coerce types up front so the arbiter key matches the stored index keys.
        for (let i = 0; i < table.columns.length; i++) {
          row[i] = coerceTo(table.columns[i].type, row[i], table.columns[i].scale)
        }
        const rowid = upsert.findConflict(row)
        if (rowid !== null) {
          if (upsert.apply(rowid, row)) updated++
          return
        }
      }
      this.db.insertChecked(table, row)
      inserted++
    }

    if (stmt.select) {
      // INSERT … SELECT — run the query and feed each result row in.
      const rows = runOperator(planSelect(stmt.select, this.db))
      for (const r of rows) {
        if (r.length !== targetCols.length) {
          throw new SqlError(`INSERT … SELECT produced ${r.length} columns for ${targetCols.length} target columns`, 'bind')
        }
        insertValues(r)
      }
    } else {
      for (const rowExprs of stmt.rows) {
        if (rowExprs.length !== targetCols.length) {
          throw new SqlError(`INSERT has ${rowExprs.length} values for ${targetCols.length} columns`, 'bind')
        }
        insertValues(rowExprs.map((e) => compileExpr(e, CONST_CTX)([])))
      }
    }
    if (onConflict) {
      return msg(`${inserted} inserted, ${updated} updated in "${stmt.table}"`, sql, t0, inserted + updated)
    }
    return msg(`${inserted} row${inserted === 1 ? '' : 's'} inserted into "${stmt.table}"`, sql, t0, inserted)
  }

  /** Build the machinery for `INSERT … ON CONFLICT`: an arbiter-key conflict
   *  probe and (for DO UPDATE) a compiled assignment applier. The applier
   *  evaluates SET/WHERE over a combined row `[existing… , proposed…]`, so the
   *  table's own columns read the existing row and `EXCLUDED.*` the new one. */
  private prepareUpsert(table: Table, oc: OnConflictClause) {
    // The arbiter unique indexes: the one matching the named target columns, or
    // every UNIQUE/PRIMARY KEY index when no target was given.
    const arbiters = table.allIndexes().filter((idx) => {
      if (!idx.meta.unique) return false
      if (!oc.target) return true
      const have = idx.meta.columns.map((c) => c.toLowerCase()).sort()
      const want = oc.target.map((c) => c.toLowerCase()).sort()
      return have.length === want.length && have.every((c, i) => c === want[i])
    })
    if (oc.target && arbiters.length === 0) {
      throw new SqlError(`ON CONFLICT (${oc.target.join(', ')}) matches no UNIQUE or PRIMARY KEY constraint on "${table.name}"`, 'bind')
    }
    if (!oc.target && arbiters.length === 0) {
      throw new SqlError(`ON CONFLICT requires "${table.name}" to have a UNIQUE or PRIMARY KEY constraint`, 'bind')
    }

    const findConflict = (row: Row): number | null => {
      for (const idx of arbiters) {
        const key = idx.keyOf(row)
        if (key.some((k) => k === null)) continue // a NULL component never conflicts
        const hits = idx.tree.search(key)
        if (hits.length > 0) return hits[0]
      }
      return null
    }

    // DO UPDATE: compile the assignments and the optional WHERE against the
    // combined row `[existing… , proposed…]`. Column index `n` is the existing
    // row; `width + n` is EXCLUDED (the proposed row). DO NOTHING compiles to no
    // setters, so `apply` is a no-op that reports "not updated".
    const action = oc.action
    const width = table.columns.length
    const ctx: CompileCtx = {
      resolve: (t, n) => {
        if (t && t.toLowerCase() === 'excluded') return width + table.requireColumnIndex(n)
        if (t && t.toLowerCase() !== table.name.toLowerCase()) {
          throw new SqlError(`ON CONFLICT update may only reference "${table.name}" or EXCLUDED, not "${t}"`, 'bind')
        }
        return table.requireColumnIndex(n)
      },
    }
    const setters =
      action.kind === 'update'
        ? action.assignments.map((a) => ({ i: table.requireColumnIndex(a.column), fn: compileExpr(a.value, ctx) }))
        : []
    const wherePred = action.kind === 'update' && action.where ? compileExpr(action.where, ctx) : null

    const apply = (rowid: number, proposed: Row): boolean => {
      if (action.kind === 'nothing') return false
      const existing = table.heap.get(rowid)
      if (!existing) return false
      const combined = existing.concat(proposed)
      if (wherePred && !truthy(wherePred(combined))) return false
      const next = existing.slice()
      for (const s of setters) next[s.i] = coerceTo(table.columns[s.i].type, s.fn(combined), table.columns[s.i].scale)
      this.db.updateChecked(table, rowid, next)
      return true
    }
    return { findConflict, apply }
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
      const row = table.heap.get(rowid)
      if (!row) continue // a prior row's cascade may have removed it
      const next = row.slice()
      for (const s of setters) next[s.i] = coerceTo(table.columns[s.i].type, s.fn(row))
      this.db.updateChecked(table, rowid, next)
    }
    return msg(`${targets.length} row${targets.length === 1 ? '' : 's'} updated in "${stmt.table}"`, sql, t0, targets.length)
  }

  private delete(stmt: Extract<Statement, { kind: 'delete' }>, sql: string, t0: number): QueryResult {
    const table = this.db.getTable(stmt.table)
    const schema: Schema = table.columns.map((c) => ({ table: table.name, name: c.name, type: c.type }))
    const pred = stmt.where ? compileExpr(stmt.where, { resolve: (t, n) => resolveColumn(schema, t, n) }) : null
    const targets: number[] = []
    for (const [rowid, row] of table.heap) if (!pred || truthy(pred(row))) targets.push(rowid)
    for (const rowid of targets) this.db.deleteChecked(table, rowid)
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

/** Statement kinds that mutate persistent state and so run atomically. */
function isMutation(kind: Statement['kind']): boolean {
  return (
    kind === 'insert' ||
    kind === 'update' ||
    kind === 'delete' ||
    kind === 'create_table' ||
    kind === 'alter_table' ||
    kind === 'drop_table' ||
    kind === 'create_view' ||
    kind === 'drop_view' ||
    kind === 'create_index'
  )
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
