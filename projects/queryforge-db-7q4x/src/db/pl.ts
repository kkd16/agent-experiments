// PL/QF — the procedural-language interpreter.
//
// This runs the bodies of stored functions, procedures and trigger functions.
// It is deliberately decoupled from the engine: everything it needs from the
// outside world (running an embedded SQL statement, running a query for its
// rows, emitting a RAISE NOTICE) arrives through a small `PlHost` interface,
// which the engine implements. So pl.ts depends only on the AST, the catalog
// value layer and the expression compiler — never on engine.ts.
//
// The one interesting trick is how embedded SQL sees procedural variables: a
// statement like `INSERT INTO audit VALUES (NEW.id, now())` is run by first
// *substituting* every in-scope variable (and record field) as a literal, then
// handing the rewritten statement to the normal engine. That keeps the SQL
// pipeline completely unaware that PL exists.

import { compileExpr, type CompileCtx } from './eval'
import { SqlError, coerceTo, formatValue, type ColumnType, type SqlValue } from './types'
import type { Row } from './catalog'
import type { Binding } from './schema'
import type {
  CreateRoutineStmt,
  CreateTriggerStmt,
  Expr,
  PlStmt,
  SelectStmt,
  Statement,
  TypedName,
} from './ast'

/** A stored routine (function or procedure) as registered in the catalog. */
export interface Routine {
  name: string
  isProcedure: boolean
  params: TypedName[]
  returns?: { type: ColumnType; scale?: number; elemType?: ColumnType }
  returnsTrigger: boolean
  body: PlStmt
}
/** A registered trigger. */
export interface Trigger {
  name: string
  timing: 'BEFORE' | 'AFTER'
  events: ('INSERT' | 'UPDATE' | 'DELETE')[]
  table: string
  when?: Expr
  functionName: string
}

/** What the interpreter needs from the engine to execute embedded SQL. */
export interface PlHost {
  /** Run a query and return its schema + materialized rows. */
  queryRows(select: SelectStmt): { schema: Binding[]; rows: Row[] }
  /** Run a data-modifying / embedded statement (INSERT/UPDATE/DELETE/CALL/…). */
  execStatement(stmt: Statement): void
  /** Surface a `RAISE NOTICE/WARNING/INFO/…` message. */
  emitNotice(text: string): void
  /** Look up a routine by (case-insensitive) name. */
  getRoutine(name: string): Routine | undefined
  /** Bounds runaway recursion across nested routine/trigger calls. */
  enterCall(): void
  leaveCall(): void
}

/** A scalar procedural variable / parameter. */
interface PlVar {
  type: ColumnType
  scale?: number
  elemType?: ColumnType
  value: SqlValue
}
/** A record variable (NEW/OLD or a query-loop row): field name → value. */
interface PlRecord {
  fields: Map<string, SqlValue>
}

/** A lexical scope. Nested BEGIN blocks chain to their parent; name resolution
 *  walks up, and assignment updates the nearest frame that declares the name. */
class Frame {
  readonly scalars = new Map<string, PlVar>()
  readonly records = new Map<string, PlRecord>()
  readonly parent?: Frame
  constructor(parent?: Frame) {
    this.parent = parent
  }

  declareScalar(name: string, v: PlVar): void {
    this.scalars.set(name.toLowerCase(), v)
  }
  declareRecord(name: string, r: PlRecord): void {
    this.records.set(name.toLowerCase(), r)
  }
  findScalar(name: string): PlVar | undefined {
    return this.scalars.get(name.toLowerCase()) ?? this.parent?.findScalar(name)
  }
  findRecord(name: string): PlRecord | undefined {
    return this.records.get(name.toLowerCase()) ?? this.parent?.findRecord(name)
  }
  /** Flatten every visible scalar (nearest wins) for expression evaluation. */
  visibleScalars(into = new Map<string, PlVar>()): Map<string, PlVar> {
    if (this.parent) this.parent.visibleScalars(into)
    for (const [k, v] of this.scalars) into.set(k, v)
    return into
  }
  visibleRecords(into = new Map<string, PlRecord>()): Map<string, PlRecord> {
    if (this.parent) this.parent.visibleRecords(into)
    for (const [k, v] of this.records) into.set(k, v)
    return into
  }
}

/** Control-flow signal bubbled up out of a statement list. */
type Signal =
  | { type: 'normal' }
  | { type: 'return'; value: SqlValue; record?: PlRecord }
  | { type: 'exit'; label?: string }
  | { type: 'continue'; label?: string }

const NORMAL: Signal = { type: 'normal' }
const MAX_LOOP_ITERS = 1_000_000

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Invoke a function/procedure with already-evaluated argument values. Returns
 *  the function's value (or null for a procedure). */
export function callRoutine(host: PlHost, routine: Routine, args: SqlValue[]): SqlValue {
  if (args.length !== routine.params.length) {
    throw new SqlError(
      `${routine.isProcedure ? 'procedure' : 'function'} ${routine.name}() expects ${routine.params.length} argument(s), got ${args.length}`,
      'eval',
    )
  }
  host.enterCall()
  try {
    const frame = new Frame()
    routine.params.forEach((p, i) => {
      frame.declareScalar(p.name, {
        type: p.type,
        scale: p.scale,
        elemType: p.elemType,
        value: coerceTo(p.type, args[i], p.scale, p.elemType),
      })
    })
    const sig = execBlock(host, routine.body, frame)
    if (sig.type === 'return') {
      if (routine.isProcedure) return null
      const rt = routine.returns
      return rt ? coerceTo(rt.type, sig.value, rt.scale, rt.elemType) : sig.value
    }
    // Falling off the end: procedures are fine; a value function returns NULL.
    return null
  } finally {
    host.leaveCall()
  }
}

/** Context handed to a row-level trigger function. */
export interface TriggerInvocation {
  trigger: Trigger
  op: 'INSERT' | 'UPDATE' | 'DELETE'
  columns: { name: string }[]
  /** The new row image (INSERT/UPDATE); null for DELETE. */
  newRow: Row | null
  /** The old row image (UPDATE/DELETE); null for INSERT. */
  oldRow: Row | null
}

/** Run a trigger function. Returns the row the operation should proceed with
 *  (the possibly-rewritten NEW for a BEFORE trigger), or null to cancel/skip
 *  the row. AFTER triggers always proceed (their return is advisory). */
export function fireTrigger(host: PlHost, inv: TriggerInvocation): Row | null {
  const routine = host.getRoutine(inv.trigger.functionName)
  if (!routine) throw new SqlError(`trigger "${inv.trigger.name}" calls missing function "${inv.trigger.functionName}()"`, 'eval')
  if (!routine.returnsTrigger) throw new SqlError(`function "${routine.name}()" is not a trigger function (RETURNS TRIGGER)`, 'eval')

  host.enterCall()
  try {
    const frame = new Frame()
    const newRec = inv.newRow ? recordFromRow(inv.columns, inv.newRow) : undefined
    const oldRec = inv.oldRow ? recordFromRow(inv.columns, inv.oldRow) : undefined
    if (newRec) frame.declareRecord('NEW', newRec)
    if (oldRec) frame.declareRecord('OLD', oldRec)
    // TG_* magic variables.
    const tg: [string, SqlValue][] = [
      ['TG_OP', inv.op],
      ['TG_NAME', inv.trigger.name],
      ['TG_WHEN', inv.trigger.timing],
      ['TG_LEVEL', 'ROW'],
      ['TG_TABLE_NAME', inv.trigger.table],
    ]
    for (const [n, v] of tg) frame.declareScalar(n, { type: 'TEXT', value: v })

    // A `WHEN (cond)` gate that doesn't hold skips the body and proceeds unchanged.
    if (inv.trigger.when && !truthyVal(evalExpr(inv.trigger.when, frame))) {
      return inv.newRow ?? inv.oldRow
    }

    const sig = execBlock(host, routine.body, frame)
    if (inv.trigger.timing === 'AFTER') return inv.newRow ?? inv.oldRow

    // BEFORE: the return value decides the fate of the row.
    if (sig.type !== 'return') {
      // Falling off the end of a BEFORE trigger == returning NULL (cancel).
      return null
    }
    if (sig.record) return rowFromRecord(inv.columns, sig.record)
    if (sig.value === null) return null
    // RETURN of a non-record scalar in a BEFORE trigger: only NEW/OLD/NULL are
    // meaningful; treat any other value as "proceed unchanged".
    return inv.newRow ?? inv.oldRow
  } finally {
    host.leaveCall()
  }
}

// ---------------------------------------------------------------------------
// Statement execution
// ---------------------------------------------------------------------------

function execBlock(host: PlHost, block: PlStmt, parent: Frame): Signal {
  if (block.kind !== 'pl_block') return execStmt(host, block, parent)
  const frame = new Frame(parent)
  for (const d of block.declares) {
    frame.declareScalar(d.name, {
      type: d.type,
      scale: d.scale,
      elemType: d.elemType,
      value: d.default ? coerceTo(d.type, evalExpr(d.default, frame), d.scale, d.elemType) : null,
    })
  }
  return execList(host, block.body, frame)
}

function execList(host: PlHost, list: PlStmt[], frame: Frame): Signal {
  for (const s of list) {
    const sig = execStmt(host, s, frame)
    if (sig.type !== 'normal') return sig
  }
  return NORMAL
}

function execStmt(host: PlHost, s: PlStmt, frame: Frame): Signal {
  switch (s.kind) {
    case 'pl_null':
      return NORMAL
    case 'pl_block':
      return execBlock(host, s, frame)
    case 'pl_assign':
      return execAssign(s, frame)
    case 'pl_return': {
      if (s.value === undefined) return { type: 'return', value: null }
      // `RETURN <record-name>` (a bare identifier naming a visible record).
      if (s.value.kind === 'column' && !s.value.table) {
        const rec = frame.findRecord(s.value.name)
        if (rec) return { type: 'return', value: null, record: rec }
      }
      return { type: 'return', value: evalExpr(s.value, frame) }
    }
    case 'pl_if': {
      for (const arm of s.arms) {
        if (truthyVal(evalExpr(arm.cond, frame))) return execList(host, arm.body, frame)
      }
      if (s.elseBody) return execList(host, s.elseBody, frame)
      return NORMAL
    }
    case 'pl_while':
      return execLoop(host, s.label, s.body, frame, () => truthyVal(evalExpr(s.cond, frame)))
    case 'pl_loop':
      return execLoop(host, s.label, s.body, frame, () => true)
    case 'pl_for_range':
      return execForRange(host, s, frame)
    case 'pl_for_query':
      return execForQuery(host, s, frame)
    case 'pl_exit':
      if (s.when && !truthyVal(evalExpr(s.when, frame))) return NORMAL
      return { type: 'exit', label: s.label }
    case 'pl_continue':
      if (s.when && !truthyVal(evalExpr(s.when, frame))) return NORMAL
      return { type: 'continue', label: s.label }
    case 'pl_raise':
      return execRaise(host, s, frame)
    case 'pl_perform': {
      host.queryRows(substSelect(s.query, frame))
      return NORMAL
    }
    case 'pl_select_into':
      return execSelectInto(host, s, frame)
    case 'pl_call': {
      const routine = host.getRoutine(s.name)
      if (!routine) throw new SqlError(`unknown procedure "${s.name}"`, 'eval')
      const args = s.args.map((a) => evalExpr(a, frame))
      callRoutine(host, routine, args)
      return NORMAL
    }
    case 'pl_sql':
      host.execStatement(substStatement(s.statement, frame))
      return NORMAL
  }
}

function execAssign(s: Extract<PlStmt, { kind: 'pl_assign' }>, frame: Frame): Signal {
  const value = evalExpr(s.value, frame)
  if (s.field) {
    const rec = frame.findRecord(s.target)
    if (!rec) throw new SqlError(`"${s.target}" is not a record variable`, 'eval')
    if (!rec.fields.has(s.field.toLowerCase())) {
      throw new SqlError(`record "${s.target}" has no field "${s.field}"`, 'eval')
    }
    rec.fields.set(s.field.toLowerCase(), value)
    return NORMAL
  }
  const v = frame.findScalar(s.target)
  if (!v) throw new SqlError(`unknown variable "${s.target}"`, 'eval')
  v.value = coerceTo(v.type, value, v.scale, v.elemType)
  return NORMAL
}

function execLoop(host: PlHost, label: string | undefined, body: PlStmt[], frame: Frame, cond: () => boolean): Signal {
  let iters = 0
  while (cond()) {
    if (++iters > MAX_LOOP_ITERS) throw new SqlError('loop exceeded the maximum iteration budget', 'eval')
    const sig = execList(host, body, frame)
    const handled = handleLoopSignal(sig, label)
    if (handled === 'break') break
    if (handled === 'propagate') return sig
  }
  return NORMAL
}

function execForRange(host: PlHost, s: Extract<PlStmt, { kind: 'pl_for_range' }>, parent: Frame): Signal {
  // The bounds are written start..end: ascending normally, descending under
  // REVERSE (so `REVERSE 10..0` counts 10 down to 0). The first bound is always
  // the starting value, not the minimum.
  const start = Number(evalExpr(s.lo, parent))
  const end = Number(evalExpr(s.hi, parent))
  const step = s.step ? Math.abs(Number(evalExpr(s.step, parent))) || 1 : 1
  const frame = new Frame(parent)
  const loopVar: PlVar = { type: 'INTEGER', value: null }
  frame.declareScalar(s.var, loopVar)
  let iters = 0
  for (let i = start; s.reverse ? i >= end : i <= end; i += s.reverse ? -step : step) {
    if (++iters > MAX_LOOP_ITERS) throw new SqlError('FOR loop exceeded the maximum iteration budget', 'eval')
    loopVar.value = i
    const sig = execList(host, s.body, frame)
    const handled = handleLoopSignal(sig, s.label)
    if (handled === 'break') break
    if (handled === 'propagate') return sig
  }
  return NORMAL
}

function execForQuery(host: PlHost, s: Extract<PlStmt, { kind: 'pl_for_query' }>, parent: Frame): Signal {
  const { schema, rows } = host.queryRows(substSelect(s.query, parent))
  const frame = new Frame(parent)
  const rec: PlRecord = { fields: new Map() }
  frame.declareRecord(s.var, rec)
  for (const row of rows) {
    rec.fields.clear()
    schema.forEach((b, i) => rec.fields.set(b.name.toLowerCase(), row[i]))
    const sig = execList(host, s.body, frame)
    const handled = handleLoopSignal(sig, s.label)
    if (handled === 'break') break
    if (handled === 'propagate') return sig
  }
  return NORMAL
}

/** Decide what a loop body's exit signal does: keep looping, break out, or
 *  propagate (a RETURN, or an EXIT/CONTINUE aimed at an enclosing label). */
function handleLoopSignal(sig: Signal, label: string | undefined): 'continue' | 'break' | 'propagate' {
  if (sig.type === 'normal') return 'continue'
  if (sig.type === 'return') return 'propagate'
  if (!sig.label || sig.label.toLowerCase() === label?.toLowerCase()) {
    return sig.type === 'exit' ? 'break' : 'continue'
  }
  return 'propagate'
}

function execRaise(host: PlHost, s: Extract<PlStmt, { kind: 'pl_raise' }>, frame: Frame): Signal {
  const text = formatRaise(s.message ?? '', s.args.map((a) => evalExpr(a, frame)))
  if (s.level === 'EXCEPTION') throw new SqlError(text || 'raised exception', 'raise')
  host.emitNotice(`${s.level}: ${text}`)
  return NORMAL
}

function execSelectInto(host: PlHost, s: Extract<PlStmt, { kind: 'pl_select_into' }>, frame: Frame): Signal {
  const { schema, rows } = host.queryRows(substSelect(s.query, frame))
  if (s.strict && rows.length !== 1) {
    throw new SqlError(`SELECT INTO STRICT expected exactly one row, got ${rows.length}`, 'eval')
  }
  const row = rows[0]
  s.targets.forEach((t, i) => {
    const v = frame.findScalar(t)
    if (!v) throw new SqlError(`unknown variable "${t}" in SELECT … INTO`, 'eval')
    if (i >= schema.length) throw new SqlError(`SELECT … INTO has more targets than result columns`, 'eval')
    v.value = row ? coerceTo(v.type, row[i], v.scale, v.elemType) : null
  })
  return NORMAL
}

// ---------------------------------------------------------------------------
// Expression evaluation over a frame
// ---------------------------------------------------------------------------

/** Evaluate a procedural expression against the current variable frame. We
 *  build a synthetic row of the visible variables/record-fields and compile the
 *  expression to read from it; recompiling per evaluation is cheap (PL
 *  expressions are tiny) and keeps the frame the single source of truth. */
function evalExpr(expr: Expr, frame: Frame): SqlValue {
  const scalars = frame.visibleScalars()
  const records = frame.visibleRecords()
  const slots: SqlValue[] = []
  const index = new Map<string, number>()
  for (const [name, v] of scalars) {
    index.set(name, slots.length)
    slots.push(v.value)
  }
  for (const [rname, rec] of records) {
    for (const [field, value] of rec.fields) {
      index.set(`${rname}.${field}`, slots.length)
      slots.push(value)
    }
  }
  const ctx: CompileCtx = {
    resolve: (table, name) => {
      const key = table ? `${table.toLowerCase()}.${name.toLowerCase()}` : name.toLowerCase()
      const i = index.get(key)
      if (i !== undefined) return i
      if (table && records.has(table.toLowerCase())) {
        throw new SqlError(`record "${table}" has no field "${name}"`, 'eval')
      }
      throw new SqlError(`unknown variable "${table ? `${table}.${name}` : name}"`, 'eval')
    },
  }
  return compileExpr(expr, ctx)(slots)
}

/** Three-valued truthiness for control-flow conditions (NULL is false). */
function truthyVal(v: SqlValue): boolean {
  return v === true
}

// ---------------------------------------------------------------------------
// Variable substitution into embedded SQL
// ---------------------------------------------------------------------------
//
// Before an embedded statement reaches the engine, every bare identifier that
// names an in-scope scalar variable — and every `record.field` whose record is
// in scope — is replaced by a literal of its current value. Identifiers that do
// not name a variable (real table columns, qualifiers, aliases) pass through
// untouched. This is the substitution model PL/pgSQL uses, made explicit.

function substStatement(stmt: Statement, frame: Frame): Statement {
  const scalars = frame.visibleScalars()
  const records = frame.visibleRecords()
  const f = (e: Expr): Expr => substVarsInExpr(e, scalars, records)
  switch (stmt.kind) {
    case 'insert':
      return {
        ...stmt,
        rows: stmt.rows.map((r) => r.map(f)),
        select: stmt.select ? substSelectWith(stmt.select, scalars, records) : undefined,
        onConflict: stmt.onConflict
          ? {
              ...stmt.onConflict,
              action:
                stmt.onConflict.action.kind === 'update'
                  ? {
                      kind: 'update',
                      assignments: stmt.onConflict.action.assignments.map((a) => ({ column: a.column, value: f(a.value) })),
                      where: stmt.onConflict.action.where ? f(stmt.onConflict.action.where) : undefined,
                    }
                  : stmt.onConflict.action,
            }
          : undefined,
        returning: stmt.returning?.map((it) => ({ ...it, expr: f(it.expr) })),
      }
    case 'update':
      return {
        ...stmt,
        assignments: stmt.assignments.map((a) => ({ column: a.column, value: f(a.value) })),
        where: stmt.where ? f(stmt.where) : undefined,
        returning: stmt.returning?.map((it) => ({ ...it, expr: f(it.expr) })),
      }
    case 'delete':
      return {
        ...stmt,
        where: stmt.where ? f(stmt.where) : undefined,
        returning: stmt.returning?.map((it) => ({ ...it, expr: f(it.expr) })),
      }
    case 'select':
      return substSelectWith(stmt, scalars, records)
    case 'call':
      return { ...stmt, args: stmt.args.map(f) }
    default:
      // Other statements have no variable-bearing expressions we substitute.
      return stmt
  }
}

function substSelect(select: SelectStmt, frame: Frame): SelectStmt {
  return substSelectWith(select, frame.visibleScalars(), frame.visibleRecords())
}

function substSelectWith(select: SelectStmt, scalars: Map<string, PlVar>, records: Map<string, PlRecord>): SelectStmt {
  const f = (e: Expr): Expr => substVarsInExpr(e, scalars, records)
  return {
    ...select,
    columns: select.columns.map((it) => ({ ...it, expr: f(it.expr) })),
    from: select.from ? { ...select.from, subquery: select.from.subquery ? substSelectWith(select.from.subquery, scalars, records) : undefined } : undefined,
    joins: select.joins.map((j) => ({
      ...j,
      on: j.on ? f(j.on) : undefined,
      subquery: j.subquery ? substSelectWith(j.subquery, scalars, records) : undefined,
    })),
    where: select.where ? f(select.where) : undefined,
    groupBy: select.groupBy.map(f),
    having: select.having ? f(select.having) : undefined,
    qualify: select.qualify ? f(select.qualify) : undefined,
    orderBy: select.orderBy.map((o) => ({ ...o, expr: f(o.expr) })),
    setOps: select.setOps?.map((so) => ({ ...so, select: substSelectWith(so.select, scalars, records) })),
    ctes: select.ctes?.map((c) => ({ ...c, select: substSelectWith(c.select, scalars, records) })),
    into: undefined,
  }
}

/** Rewrite an expression, replacing variable references with literals. */
function substVarsInExpr(e: Expr, scalars: Map<string, PlVar>, records: Map<string, PlRecord>): Expr {
  return mapExpr(e, (node) => {
    if (node.kind === 'column') {
      if (node.table) {
        const rec = records.get(node.table.toLowerCase())
        if (rec) {
          const field = node.name.toLowerCase()
          if (!rec.fields.has(field)) throw new SqlError(`record "${node.table}" has no field "${node.name}"`, 'eval')
          return { kind: 'literal', value: rec.fields.get(field)! }
        }
        return node
      }
      const v = scalars.get(node.name.toLowerCase())
      if (v) return { kind: 'literal', value: v.value }
      return node
    }
    return node
  }, scalars, records)
}

/** Bottom-up rewrite of an expression tree. `f` may replace any node; nested
 *  SELECTs are recursed through so a subquery's variable refs are substituted
 *  too. Exhaustive over Expr so nothing slips through unsubstituted. */
function mapExpr(
  e: Expr,
  f: (e: Expr) => Expr,
  scalars: Map<string, PlVar>,
  records: Map<string, PlRecord>,
): Expr {
  const rec = (x: Expr): Expr => mapExpr(x, f, scalars, records)
  const sub = (s: SelectStmt): SelectStmt => substSelectWith(s, scalars, records)
  switch (e.kind) {
    case 'literal':
    case 'star':
      return f(e)
    case 'column':
      return f(e)
    case 'unary':
      return f({ ...e, expr: rec(e.expr) })
    case 'binary':
      return f({ ...e, left: rec(e.left), right: rec(e.right) })
    case 'between':
      return f({ ...e, expr: rec(e.expr), lo: rec(e.lo), hi: rec(e.hi) })
    case 'in':
      return f({ ...e, expr: rec(e.expr), list: e.list.map(rec) })
    case 'like':
      return f({ ...e, expr: rec(e.expr), pattern: rec(e.pattern) })
    case 'isnull':
      return f({ ...e, expr: rec(e.expr) })
    case 'func':
      return f({ ...e, args: e.args.map(rec), filter: e.filter ? rec(e.filter) : undefined })
    case 'case':
      return f({
        ...e,
        operand: e.operand ? rec(e.operand) : undefined,
        whens: e.whens.map((w) => ({ when: rec(w.when), then: rec(w.then) })),
        else: e.else ? rec(e.else) : undefined,
      })
    case 'cast':
      return f({ ...e, expr: rec(e.expr) })
    case 'subquery':
      return f({ ...e, select: sub(e.select) })
    case 'exists':
      return f({ ...e, select: sub(e.select) })
    case 'in_subquery':
      return f({ ...e, expr: rec(e.expr), select: sub(e.select) })
    case 'quantified':
      return f({ ...e, expr: rec(e.expr), select: sub(e.select) })
    case 'quantified_array':
      return f({ ...e, expr: rec(e.expr), array: rec(e.array) })
    case 'array':
      return f({ ...e, elements: e.elements.map(rec) })
    case 'subscript':
      return f({ ...e, base: rec(e.base), index: e.index ? rec(e.index) : undefined, upper: e.upper ? rec(e.upper) : undefined })
    case 'window':
      return f({ ...e, args: e.args.map(rec), filter: e.filter ? rec(e.filter) : undefined })
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function recordFromRow(columns: { name: string }[], row: Row): PlRecord {
  const fields = new Map<string, SqlValue>()
  columns.forEach((c, i) => fields.set(c.name.toLowerCase(), row[i] ?? null))
  return { fields }
}
function rowFromRecord(columns: { name: string }[], rec: PlRecord): Row {
  return columns.map((c) => rec.fields.get(c.name.toLowerCase()) ?? null)
}

/** Fill `%` placeholders in a RAISE format string left-to-right (`%%` → `%`). */
function formatRaise(fmt: string, args: SqlValue[]): string {
  let ai = 0
  let out = ''
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] === '%') {
      if (fmt[i + 1] === '%') {
        out += '%'
        i++
      } else {
        out += ai < args.length ? formatValue(args[ai++]) : ''
      }
    } else {
      out += fmt[i]
    }
  }
  return out
}

/** Build the catalog routine record from a parsed CREATE statement. */
export function routineFromStmt(stmt: CreateRoutineStmt): Routine {
  return {
    name: stmt.name,
    isProcedure: stmt.isProcedure,
    params: stmt.params,
    returns: stmt.returns,
    returnsTrigger: stmt.returnsTrigger,
    body: stmt.body,
  }
}
/** Build the catalog trigger record from a parsed CREATE statement. */
export function triggerFromStmt(stmt: CreateTriggerStmt): Trigger {
  return {
    name: stmt.name,
    timing: stmt.timing,
    events: stmt.events,
    table: stmt.table,
    when: stmt.when,
    functionName: stmt.functionName,
  }
}
