// The engine: the public entry point that runs SQL text end-to-end.
//
//   SQL text → parse → (plan → optimize → execute) → results
//
// It owns the Database, drives DDL/DML directly, plans+runs SELECTs through
// the operator tree, renders EXPLAIN plans, and implements snapshot-based
// transactions (BEGIN/COMMIT/ROLLBACK).

import { parse } from './parser'
import { Database, Table, type Row, type SerializedDb } from './catalog'
import { planSelect, planWithJoinTrace, inferType, type JoinOrderTrace } from './planner'
import { adviseIndexes, type AdviceResult } from './advisor'
import { compileExpr, truthy, setUserFunctionHook, type CompileCtx, type Evaluator, type UserScalarFn } from './eval'
import { resolveColumn, type Binding, type Schema } from './schema'
import { SqlError, coerceTo, type ColumnType, type SqlValue } from './types'
import { callRoutine, fireTrigger, routineFromStmt, triggerFromStmt, type PlHost, type Routine } from './pl'
import type { Operator, PlanNode } from './operators'
import type {
  CallStmt,
  CreateRoutineStmt,
  CreateTriggerStmt,
  Expr,
  MergeStmt,
  OnConflictClause,
  SelectItem,
  SelectStmt,
  Statement,
} from './ast'

export interface RowsResult {
  kind: 'rows'
  columns: Binding[]
  rows: Row[]
  rowCount: number
  elapsedMs: number
  sql: string
  /** RAISE NOTICE/WARNING/… messages emitted while running the statement. */
  notices?: string[]
}
export interface MessageResult {
  kind: 'message'
  message: string
  rowCount?: number
  elapsedMs: number
  sql: string
  /** RAISE NOTICE/WARNING/… messages emitted while running the statement. */
  notices?: string[]
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

export class Engine implements PlHost {
  db: Database
  private txnStack: SerializedDb[] = []
  /** Named savepoints within the current transaction (innermost last). */
  private savepoints: { name: string; snap: SerializedDb }[] = []
  /** RAISE NOTICE/… messages collected while running the current statement. */
  private notices: string[] = []
  /** Routine/trigger call nesting (guards runaway recursion). */
  private callDepth = 0

  constructor(db = new Database()) {
    this.db = db
  }

  /** Point the expression compiler's user-function resolver at this engine, so a
   *  stored function called inside any SQL expression runs our interpreter
   *  against the *current* database. Reinstalled per `execute()` because the
   *  hook is process-global and several engines may coexist (e.g. in tests). */
  private installHooks(): void {
    const call = (name: string): UserScalarFn | undefined => {
      const r = this.db.getRoutine(name)
      if (!r || r.isProcedure || r.returnsTrigger) return undefined
      return (args) => callRoutine(this, r, args)
    }
    const returnType = (name: string): ColumnType | undefined => {
      const r = this.db.getRoutine(name)
      return r && !r.isProcedure && !r.returnsTrigger ? r.returns?.type : undefined
    }
    setUserFunctionHook(call, returnType)
  }

  /** Run a script of one or more `;`-separated statements. */
  execute(sql: string): QueryResult[] {
    this.installHooks()
    const stmts = parse(sql)
    const results: QueryResult[] = []
    for (const stmt of stmts) {
      results.push(this.runStatement(stmt, sql))
    }
    return results
  }

  private runStatement(stmt: Statement, sql: string): QueryResult {
    this.notices = []
    // Statement atomicity: a mutating statement that fails part-way (a constraint
    // violation on row 50 of a bulk insert, a cascade that hits a RESTRICT) leaves
    // the database exactly as it was. We snapshot first and roll back on any throw.
    let result: QueryResult
    if (isMutation(stmt.kind)) {
      const snap = this.db.snapshot()
      try {
        result = this.dispatch(stmt, sql)
      } catch (err) {
        this.db = Database.restore(snap)
        throw err
      }
    } else {
      result = this.dispatch(stmt, sql)
    }
    if (this.notices.length && (result.kind === 'rows' || result.kind === 'message')) {
      result.notices = this.notices.slice()
    }
    return result
  }

  // --- PlHost (services the procedural interpreter calls back into) ---------
  queryRows(select: SelectStmt): { schema: Binding[]; rows: Row[] } {
    const op = planSelect(select, this.db)
    return { schema: op.schema, rows: runOperator(op) }
  }
  /** The what-if Index Advisor: recommend indexes for a SELECT by re-planning it
   *  under hypothetical indexes (HypoPG-style). Read-only — your data is untouched. */
  advise(selectSql: string): AdviceResult {
    return adviseIndexes(this.db, selectSql)
  }

  /** Plan a SELECT and return its plan tree plus the join-order DP search trace
   *  (null when the query has too few reorderable joins). For the Optimizer Lab. */
  planAndTrace(selectSql: string): { plan: PlanNode; trace: JoinOrderTrace | null } {
    const stmts = parse(selectSql)
    if (stmts.length !== 1) throw new SqlError('Provide exactly one SELECT statement.', 'plan')
    let s = stmts[0]
    if (s.kind === 'explain') s = s.statement
    if (s.kind !== 'select') throw new SqlError('Only SELECT statements can be planned here.', 'plan')
    return planWithJoinTrace(s, this.db)
  }
  execStatement(stmt: Statement): void {
    this.dispatch(stmt, '')
  }
  emitNotice(text: string): void {
    this.notices.push(text)
  }
  getRoutine(name: string): Routine | undefined {
    return this.db.getRoutine(name)
  }
  enterCall(): void {
    if (++this.callDepth > 200) {
      this.callDepth--
      throw new SqlError('routine/trigger recursion too deep', 'eval')
    }
  }
  leaveCall(): void {
    this.callDepth--
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
      case 'merge':
        return this.merge(stmt, sql, t0)
      case 'truncate':
        return this.truncate(stmt, sql, t0)
      case 'select':
        return this.select(stmt, sql, t0)
      case 'explain':
        return this.explain(stmt, sql, t0)
      case 'txn':
        return this.txn(stmt, sql, t0)
      case 'create_routine':
        return this.createRoutine(stmt, sql, t0)
      case 'drop_routine':
        return this.dropRoutine(stmt, sql, t0)
      case 'call':
        return this.callProcedure(stmt, sql, t0)
      case 'create_trigger':
        return this.createTrigger(stmt, sql, t0)
      case 'drop_trigger':
        return this.dropTrigger(stmt, sql, t0)
    }
  }

  // --- PL/QF: routines, procedures & triggers -------------------------------
  private createRoutine(stmt: CreateRoutineStmt, sql: string, t0: number): QueryResult {
    if (this.db.getRoutine(stmt.name) && !stmt.orReplace) {
      throw new SqlError(`routine "${stmt.name}" already exists (use CREATE OR REPLACE)`, 'ddl')
    }
    // Validate parameter / variable / NEW.* references by attempting to bind the
    // body against an empty frame would require executing it — instead we trust
    // the parse and surface runtime errors on first call, like PL/pgSQL.
    this.db.setRoutine(routineFromStmt(stmt))
    const what = stmt.isProcedure ? 'procedure' : stmt.returnsTrigger ? 'trigger function' : 'function'
    return msg(`${what} "${stmt.name}" created`, sql, t0)
  }

  private dropRoutine(stmt: Extract<Statement, { kind: 'drop_routine' }>, sql: string, t0: number): QueryResult {
    const existing = this.db.getRoutine(stmt.name)
    if (!existing) {
      if (stmt.ifExists) return msg(`routine "${stmt.name}" does not exist, skipped`, sql, t0)
      throw new SqlError(`unknown ${stmt.isProcedure ? 'procedure' : 'function'} "${stmt.name}"`, 'ddl')
    }
    // Refuse to drop a function a trigger still depends on.
    for (const tg of this.db.triggers.values()) {
      if (tg.functionName.toLowerCase() === stmt.name.toLowerCase()) {
        throw new SqlError(`cannot drop "${stmt.name}" — trigger "${tg.name}" depends on it`, 'ddl')
      }
    }
    this.db.dropRoutine(stmt.name)
    return msg(`${stmt.isProcedure ? 'procedure' : 'function'} "${stmt.name}" dropped`, sql, t0)
  }

  private callProcedure(stmt: CallStmt, sql: string, t0: number): QueryResult {
    const routine = this.db.getRoutine(stmt.name)
    if (!routine) throw new SqlError(`unknown procedure "${stmt.name}"`, 'eval')
    if (routine.returnsTrigger) throw new SqlError(`"${stmt.name}" is a trigger function and cannot be CALLed`, 'eval')
    const args = stmt.args.map((a) => evalConstant(a))
    const ret = callRoutine(this, routine, args)
    if (!routine.isProcedure && ret !== null) {
      // CALL of a (non-void) function: surface its return value as a 1×1 result.
      return {
        kind: 'rows',
        columns: [{ table: '', name: stmt.name.toLowerCase(), type: routine.returns?.type ?? 'TEXT' }],
        rows: [[ret]],
        rowCount: 1,
        elapsedMs: performance.now() - t0,
        sql,
      }
    }
    return msg(`called "${stmt.name}"`, sql, t0)
  }

  private createTrigger(stmt: CreateTriggerStmt, sql: string, t0: number): QueryResult {
    if (this.db.triggers.has(stmt.name.toLowerCase()) && !stmt.orReplace) {
      throw new SqlError(`trigger "${stmt.name}" already exists (use CREATE OR REPLACE)`, 'ddl')
    }
    if (!this.db.hasTable(stmt.table)) throw new SqlError(`unknown table "${stmt.table}"`, 'ddl')
    const fn = this.db.getRoutine(stmt.functionName)
    if (!fn) throw new SqlError(`trigger function "${stmt.functionName}()" does not exist`, 'ddl')
    if (!fn.returnsTrigger) throw new SqlError(`function "${stmt.functionName}()" is not declared RETURNS TRIGGER`, 'ddl')
    this.db.setTrigger(triggerFromStmt(stmt))
    return msg(`trigger "${stmt.name}" created on "${stmt.table}"`, sql, t0)
  }

  private dropTrigger(stmt: Extract<Statement, { kind: 'drop_trigger' }>, sql: string, t0: number): QueryResult {
    if (!this.db.triggers.has(stmt.name.toLowerCase())) {
      if (stmt.ifExists) return msg(`trigger "${stmt.name}" does not exist, skipped`, sql, t0)
      throw new SqlError(`unknown trigger "${stmt.name}"`, 'ddl')
    }
    this.db.dropTrigger(stmt.name)
    return msg(`trigger "${stmt.name}" dropped`, sql, t0)
  }

  // --- row-level trigger firing (BEFORE/AFTER INSERT/UPDATE/DELETE) ---------
  /** BEFORE INSERT: returns the row to insert (possibly rewritten) or null to
   *  skip. No-op (returns `row`) when the table has no BEFORE INSERT triggers. */
  private beforeInsert(table: Table, row: Row): Row | null {
    let cur: Row | null = row
    for (const tg of this.db.triggersFor(table.name, 'BEFORE', 'INSERT')) {
      cur = fireTrigger(this, { trigger: tg, op: 'INSERT', columns: table.columns, newRow: cur, oldRow: null })
      if (cur === null) return null
    }
    return cur
  }
  private afterInsert(table: Table, row: Row): void {
    for (const tg of this.db.triggersFor(table.name, 'AFTER', 'INSERT')) {
      fireTrigger(this, { trigger: tg, op: 'INSERT', columns: table.columns, newRow: row, oldRow: null })
    }
  }
  /** BEFORE UPDATE: returns the new row image (possibly rewritten) or null. */
  private beforeUpdate(table: Table, oldRow: Row, newRow: Row): Row | null {
    let cur: Row | null = newRow
    for (const tg of this.db.triggersFor(table.name, 'BEFORE', 'UPDATE')) {
      cur = fireTrigger(this, { trigger: tg, op: 'UPDATE', columns: table.columns, newRow: cur, oldRow })
      if (cur === null) return null
    }
    return cur
  }
  private afterUpdate(table: Table, oldRow: Row, newRow: Row): void {
    for (const tg of this.db.triggersFor(table.name, 'AFTER', 'UPDATE')) {
      fireTrigger(this, { trigger: tg, op: 'UPDATE', columns: table.columns, newRow, oldRow })
    }
  }
  /** BEFORE DELETE: false cancels the delete of this row. */
  private beforeDelete(table: Table, oldRow: Row): boolean {
    for (const tg of this.db.triggersFor(table.name, 'BEFORE', 'DELETE')) {
      const res = fireTrigger(this, { trigger: tg, op: 'DELETE', columns: table.columns, newRow: null, oldRow })
      if (res === null) return false
    }
    return true
  }
  private afterDelete(table: Table, oldRow: Row): void {
    for (const tg of this.db.triggersFor(table.name, 'AFTER', 'DELETE')) {
      fireTrigger(this, { trigger: tg, op: 'DELETE', columns: table.columns, newRow: null, oldRow })
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
    const cols = stmt.columns.join(', ')
    if (stmt.using === 'GIN') {
      if (stmt.columns.length !== 1) throw new SqlError('a GIN index covers exactly one column', 'ddl')
      if (stmt.unique) throw new SqlError('a GIN index cannot be UNIQUE', 'ddl')
      const gt = table.columnType(stmt.columns[0])
      if (gt !== 'TSVECTOR' && gt !== 'ARRAY') {
        throw new SqlError(`a GIN index requires a TSVECTOR or array column (got ${gt})`, 'ddl')
      }
      table.createGinIndex(stmt.name, stmt.columns[0])
      return msg(`GIN index "${stmt.name}" created on ${stmt.table} (${cols})`, sql, t0)
    }
    if (stmt.using && stmt.using !== 'BTREE') throw new SqlError(`unknown index method "${stmt.using}"`, 'ddl')
    table.createIndex(stmt.name, stmt.columns, stmt.unique)
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
    const affected: Row[] = []
    const insertValues = (values: SqlValue[]): void => {
      const row: Row = new Array(table.columns.length).fill(null)
      for (let i = 0; i < values.length; i++) {
        row[colIndexes[i]] = coerceTo(table.columns[colIndexes[i]].type, values[i], undefined, table.columns[colIndexes[i]].elemType)
      }
      // Columns not supplied take their DEFAULT (if any); the rest stay NULL.
      for (let i = 0; i < table.columns.length; i++) {
        const col = table.columns[i]
        if (!provided.has(i) && col.default) {
          row[i] = coerceTo(col.type, evalConstant(col.default), undefined, col.elemType)
        }
      }
      if (upsert) {
        // Coerce types up front so the arbiter key matches the stored index keys.
        for (let i = 0; i < table.columns.length; i++) {
          row[i] = coerceTo(table.columns[i].type, row[i], table.columns[i].scale, table.columns[i].elemType)
        }
        const rowid = upsert.findConflict(row)
        if (rowid !== null) {
          if (upsert.apply(rowid, row)) {
            updated++
            if (stmt.returning) affected.push(table.heap.get(rowid)!.slice())
          }
          return
        }
      }
      // Fire BEFORE/AFTER INSERT row triggers (a BEFORE trigger may rewrite the
      // row or return NULL to skip it). Triggers are bypassed on the upsert path.
      const finalRow = onConflict ? row : this.beforeInsert(table, row)
      if (finalRow === null) return
      this.db.insertChecked(table, finalRow)
      inserted++
      if (stmt.returning) affected.push(finalRow.slice())
      if (!onConflict) this.afterInsert(table, finalRow)
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
    if (stmt.returning) return returningResult(stmt.returning, table, affected, sql, t0)
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
      for (const s of setters) next[s.i] = coerceTo(table.columns[s.i].type, s.fn(combined), table.columns[s.i].scale, table.columns[s.i].elemType)
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
    const affected: Row[] = []
    let updated = 0
    for (const rowid of targets) {
      const row = table.heap.get(rowid)
      if (!row) continue // a prior row's cascade may have removed it
      const oldRow = row.slice()
      const next = row.slice()
      for (const s of setters) next[s.i] = coerceTo(table.columns[s.i].type, s.fn(row), undefined, table.columns[s.i].elemType)
      const finalRow = this.beforeUpdate(table, oldRow, next)
      if (finalRow === null) continue // a BEFORE trigger cancelled this row
      this.db.updateChecked(table, rowid, finalRow)
      updated++
      this.afterUpdate(table, oldRow, table.heap.get(rowid) ?? finalRow)
      if (stmt.returning) affected.push((table.heap.get(rowid) ?? finalRow).slice())
    }
    if (stmt.returning) return returningResult(stmt.returning, table, affected, sql, t0)
    return msg(`${updated} row${updated === 1 ? '' : 's'} updated in "${stmt.table}"`, sql, t0, updated)
  }

  private delete(stmt: Extract<Statement, { kind: 'delete' }>, sql: string, t0: number): QueryResult {
    const table = this.db.getTable(stmt.table)
    const schema: Schema = table.columns.map((c) => ({ table: table.name, name: c.name, type: c.type }))
    const pred = stmt.where ? compileExpr(stmt.where, { resolve: (t, n) => resolveColumn(schema, t, n) }) : null
    const targets: number[] = []
    for (const [rowid, row] of table.heap) if (!pred || truthy(pred(row))) targets.push(rowid)
    const affected: Row[] = []
    let deleted = 0
    for (const rowid of targets) {
      // A prior row's self-referential cascade may already have removed this one.
      const row = table.heap.get(rowid)
      if (!row) continue
      if (!this.beforeDelete(table, row)) continue // a BEFORE trigger cancelled it
      // RETURNING captures the row image before it (and any cascade) is removed.
      const image = row.slice()
      this.db.deleteChecked(table, rowid)
      deleted++
      this.afterDelete(table, image)
      if (stmt.returning) affected.push(image)
    }
    if (stmt.returning) return returningResult(stmt.returning, table, affected, sql, t0)
    return msg(`${deleted} row${deleted === 1 ? '' : 's'} deleted from "${stmt.table}"`, sql, t0, deleted)
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
        this.savepoints = []
        return msg('transaction committed', sql, t0)
      case 'rollback': {
        if (this.txnStack.length === 0) throw new SqlError('no transaction in progress', 'txn')
        const snap = this.txnStack.pop()!
        this.db = Database.restore(snap)
        this.savepoints = []
        return msg('transaction rolled back', sql, t0)
      }
      case 'savepoint': {
        if (this.txnStack.length === 0) throw new SqlError('SAVEPOINT can only be used inside a transaction block', 'txn')
        this.savepoints.push({ name: stmt.savepoint!, snap: this.db.snapshot() })
        return msg(`savepoint "${stmt.savepoint}" established`, sql, t0)
      }
      case 'release': {
        const i = this.findSavepoint(stmt.savepoint!)
        // RELEASE destroys the named savepoint and every later one (without
        // undoing their work — the changes fold into the enclosing scope).
        this.savepoints.splice(i)
        return msg(`savepoint "${stmt.savepoint}" released`, sql, t0)
      }
      case 'rollback_to': {
        const i = this.findSavepoint(stmt.savepoint!)
        // ROLLBACK TO restores the savepoint's image and discards every later
        // savepoint, but *keeps* the named one (so it can be rolled back to again).
        this.db = Database.restore(this.savepoints[i].snap)
        this.savepoints.splice(i + 1)
        return msg(`rolled back to savepoint "${stmt.savepoint}"`, sql, t0)
      }
    }
  }

  /** Index of the most recent savepoint with `name` (errors if none exists). */
  private findSavepoint(name: string): number {
    for (let i = this.savepoints.length - 1; i >= 0; i--) {
      if (this.savepoints[i].name.toLowerCase() === name.toLowerCase()) return i
    }
    throw new SqlError(`savepoint "${name}" does not exist`, 'txn')
  }

  // --- MERGE ----------------------------------------------------------------
  private merge(stmt: MergeStmt, sql: string, t0: number): QueryResult {
    const target = this.db.getTable(stmt.target)
    const targetRel = stmt.targetAlias ?? target.name
    const width = target.columns.length

    // Run the source to completion (a table / derived table / VALUES / function).
    const sourceSelect: SelectStmt = {
      kind: 'select',
      distinct: false,
      columns: [{ expr: { kind: 'star' } }],
      from: stmt.source,
      joins: [],
      groupBy: [],
      orderBy: [],
    }
    const sourceOp = planSelect(sourceSelect, this.db)
    const sourceRows = runOperator(sourceOp)
    // A `SELECT *` projection drops table qualifiers, so re-tag the source
    // columns under the source's relation name (its alias, or the table name)
    // so `src.col` resolves in ON / WHEN expressions. Names already reflect any
    // column aliases the planner applied.
    const sourceRel = stmt.source.alias ?? stmt.source.table ?? ''
    const sourceSchema: Schema = sourceOp.schema.map((b) => ({ table: sourceRel, name: b.name, type: b.type }))
    const sourceWidth = sourceSchema.length

    // Everything is compiled against the combined row `[target… | source…]`, so
    // an arm can read both sides; the unused side is filled with NULLs.
    const targetSchema: Schema = target.columns.map((c) => ({ table: targetRel, name: c.name, type: c.type }))
    const combinedSchema = targetSchema.concat(sourceSchema)
    const combinedCtx: CompileCtx = { resolve: (tbl, n) => resolveColumn(combinedSchema, tbl, n) }
    const onPred = compileExpr(stmt.on, combinedCtx)

    // Pre-compile every WHEN arm.
    interface CompiledWhen {
      match: 'matched' | 'not_matched' | 'not_matched_by_source'
      cond: Evaluator | null
      action:
        | { kind: 'update'; setters: { i: number; fn: Evaluator }[] }
        | { kind: 'delete' }
        | { kind: 'insert'; colIdx: number[]; provided: Set<number>; valFns: Evaluator[] | null }
        | { kind: 'nothing' }
    }
    const compiled: CompiledWhen[] = stmt.whens.map((w) => {
      const cond = w.condition ? compileExpr(w.condition, combinedCtx) : null
      const a = w.action
      if (a.kind === 'update') {
        const setters = a.assignments.map((asg) => ({ i: target.requireColumnIndex(asg.column), fn: compileExpr(asg.value, combinedCtx) }))
        return { match: w.match, cond, action: { kind: 'update', setters } }
      }
      if (a.kind === 'insert') {
        const cols = a.columns ?? target.columns.map((c) => c.name)
        const colIdx = cols.map((c) => target.requireColumnIndex(c))
        const valFns = a.defaultValues ? null : (a.values ?? []).map((v) => compileExpr(v, combinedCtx))
        if (valFns && valFns.length !== colIdx.length) {
          throw new SqlError(`MERGE INSERT has ${valFns.length} values for ${colIdx.length} columns`, 'bind')
        }
        return { match: w.match, cond, action: { kind: 'insert', colIdx, provided: new Set(colIdx), valFns } }
      }
      return { match: w.match, cond, action: a.kind === 'delete' ? { kind: 'delete' } : { kind: 'nothing' } }
    })
    const matchedWhens = compiled.filter((w) => w.match === 'matched')
    const notMatchedWhens = compiled.filter((w) => w.match === 'not_matched')
    const bySourceWhens = compiled.filter((w) => w.match === 'not_matched_by_source')

    // Set-based semantics: match against the target image at statement start.
    const snapshot = [...target.heap.keys()].map((id) => ({ id, row: target.heap.get(id)!.slice() }))
    const everMatched = new Set<number>()
    const touched = new Set<number>()
    const affected: Row[] = []
    let nIns = 0
    let nUpd = 0
    let nDel = 0

    const doInsert = (action: Extract<CompiledWhen['action'], { kind: 'insert' }>, combined: Row): void => {
      const row: Row = new Array(width).fill(null)
      if (action.valFns) {
        for (let k = 0; k < action.colIdx.length; k++) {
          row[action.colIdx[k]] = coerceTo(target.columns[action.colIdx[k]].type, action.valFns[k](combined), undefined, target.columns[action.colIdx[k]].elemType)
        }
      }
      for (let i = 0; i < width; i++) {
        if (!action.provided.has(i) && target.columns[i].default) {
          row[i] = coerceTo(target.columns[i].type, evalConstant(target.columns[i].default!), undefined, target.columns[i].elemType)
        }
      }
      this.db.insertChecked(target, row)
      nIns++
      if (stmt.returning) affected.push(row.slice())
    }
    const fire = (w: CompiledWhen | undefined, id: number, oldRow: Row, combined: Row): void => {
      if (!w) return
      const a = w.action
      if (a.kind === 'nothing') {
        touched.add(id)
        return
      }
      if (a.kind === 'delete') {
        touched.add(id)
        if (stmt.returning) affected.push(oldRow.slice())
        this.db.deleteChecked(target, id)
        nDel++
        return
      }
      if (a.kind === 'update') {
        touched.add(id)
        const next = (target.heap.get(id) ?? oldRow).slice()
        for (const s of a.setters) next[s.i] = coerceTo(target.columns[s.i].type, s.fn(combined), target.columns[s.i].scale, target.columns[s.i].elemType)
        this.db.updateChecked(target, id, next)
        nUpd++
        if (stmt.returning) affected.push((target.heap.get(id) ?? next).slice())
      }
    }

    for (const src of sourceRows) {
      let matchedAny = false
      for (const { id, row: trow } of snapshot) {
        const combined = trow.concat(src)
        if (!truthy(onPred(combined))) continue
        matchedAny = true
        everMatched.add(id)
        if (!target.heap.has(id)) continue // already deleted by an earlier action
        if (touched.has(id)) {
          throw new SqlError('MERGE command cannot affect the same target row more than once', 'eval')
        }
        const w = matchedWhens.find((c) => !c.cond || truthy(c.cond(combined)))
        if (w) fire(w, id, trow, combined)
      }
      if (!matchedAny && notMatchedWhens.length) {
        const combined = (new Array(width).fill(null) as Row).concat(src)
        const w = notMatchedWhens.find((c) => !c.cond || truthy(c.cond(combined)))
        if (w && w.action.kind === 'insert') doInsert(w.action, combined)
      }
    }

    // WHEN NOT MATCHED BY SOURCE: target rows no source row ever matched.
    if (bySourceWhens.length) {
      const nullSrc: Row = new Array(sourceWidth).fill(null)
      for (const { id, row: trow } of snapshot) {
        if (everMatched.has(id) || touched.has(id) || !target.heap.has(id)) continue
        const combined = trow.concat(nullSrc)
        const w = bySourceWhens.find((c) => !c.cond || truthy(c.cond(combined)))
        if (w) fire(w, id, trow, combined)
      }
    }

    if (stmt.returning) return returningResult(stmt.returning, target, affected, sql, t0, targetRel)
    return msg(`${nIns} inserted, ${nUpd} updated, ${nDel} deleted in "${target.name}"`, sql, t0, nIns + nUpd + nDel)
  }

  // --- TRUNCATE -------------------------------------------------------------
  private truncate(stmt: Extract<Statement, { kind: 'truncate' }>, sql: string, t0: number): QueryResult {
    // Resolve the requested tables, then (CASCADE) pull in every table that
    // transitively references them so no dangling reference survives.
    const set = new Map<string, Table>()
    for (const n of stmt.tables) {
      const t = this.db.getTable(n)
      set.set(t.name.toLowerCase(), t)
    }
    for (;;) {
      let grew = false
      for (const parent of [...set.values()]) {
        for (const child of this.db.tables.values()) {
          if (set.has(child.name.toLowerCase())) continue
          const refs = child.constraints.foreignKeys.some((fk) => fk.refTable.toLowerCase() === parent.name.toLowerCase())
          if (!refs) continue
          if (!stmt.cascade) {
            throw new SqlError(`cannot TRUNCATE "${parent.name}" because "${child.name}" references it — use CASCADE`, 'constraint')
          }
          set.set(child.name.toLowerCase(), child)
          grew = true
        }
      }
      if (!grew) break
    }
    for (const t of set.values()) t.truncate(stmt.restartIdentity)
    const names = [...set.values()].map((t) => `"${t.name}"`).join(', ')
    return msg(`truncated ${names}`, sql, t0, 0)
  }
}

/** Statement kinds that mutate persistent state and so run atomically. */
function isMutation(kind: Statement['kind']): boolean {
  return (
    kind === 'insert' ||
    kind === 'update' ||
    kind === 'delete' ||
    kind === 'merge' ||
    kind === 'truncate' ||
    kind === 'create_table' ||
    kind === 'alter_table' ||
    kind === 'drop_table' ||
    kind === 'create_view' ||
    kind === 'drop_view' ||
    kind === 'create_index' ||
    kind === 'create_routine' ||
    kind === 'drop_routine' ||
    kind === 'call' ||
    kind === 'create_trigger' ||
    kind === 'drop_trigger'
  )
}

// --- RETURNING ---------------------------------------------------------------
/** Project the affected rows of a mutating statement through its RETURNING
 *  select-list, yielding a RowsResult exactly like a SELECT would. The list is
 *  bound to the target table's schema (under `relName`, its alias if any), so
 *  bare columns, `*`, `rel.*`, expressions and aliases all work. */
function returningResult(
  items: SelectItem[],
  table: Table,
  rows: Row[],
  sql: string,
  t0: number,
  relName?: string,
): RowsResult {
  const rel = relName ?? table.name
  const schema: Schema = table.columns.map((c) => ({ table: rel, name: c.name, type: c.type }))
  const ctx: CompileCtx = { resolve: (t, n) => resolveColumn(schema, t, n) }
  const columns: Binding[] = []
  const evals: Evaluator[] = []
  for (const item of items) {
    if (item.expr.kind === 'star') {
      const star = item.expr
      if (star.table && star.table.toLowerCase() !== rel.toLowerCase()) {
        throw new SqlError(`unknown table "${star.table}" in RETURNING`, 'bind')
      }
      schema.forEach((b, i) => {
        columns.push(b)
        evals.push((row) => row[i])
      })
      continue
    }
    columns.push({ table: '', name: item.alias ?? returningLabel(item.expr), type: inferType(item.expr, schema, ctx) })
    evals.push(compileExpr(item.expr, ctx))
  }
  const out = rows.map((r) => evals.map((fn) => fn(r)))
  return { kind: 'rows', columns, rows: out, rowCount: out.length, elapsedMs: performance.now() - t0, sql }
}

/** A reasonable output column name for a RETURNING item without an alias. */
function returningLabel(e: Expr): string {
  switch (e.kind) {
    case 'column':
      return e.name
    case 'func':
      return e.name.toLowerCase()
    case 'cast':
      return returningLabel(e.expr)
    default:
      return 'column'
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
