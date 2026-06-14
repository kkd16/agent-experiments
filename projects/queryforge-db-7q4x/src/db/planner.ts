// The query planner / optimizer.
//
// Turns a SELECT AST into a tree of physical operators, applying a handful of
// classic rule-based optimizations:
//   - predicate pushdown      (apply filters as early as the schema allows)
//   - index selection         (SeqScan -> IndexScan when a B+Tree covers a
//                              sargable predicate)
//   - join-algorithm choice   (HashJoin for equijoins, NestedLoop otherwise)
//   - aggregate planning       (GROUP BY / HAVING via HashAggregate)
// Each operator carries an estimated row count + cost so EXPLAIN can show the
// shape — and the reasoning — behind the chosen plan.

import { SqlError, compareValues, hashKey, valuesEqual, type ColumnType, type SqlValue } from './types'
import { compileExpr, exprKey, type CompileCtx, type Evaluator, type OuterScope } from './eval'
import { resolveColumn, type Binding, type Schema } from './schema'
import {
  isAggregate,
  type ColumnDef,
  type CteDef,
  type Expr,
  type ExistsExpr,
  type FromItem,
  type InSubqueryExpr,
  type JoinClause,
  type SelectStmt,
  type ColumnExpr,
  type QuantifiedExpr,
  type SetOp,
  type SubqueryExpr,
  type WindowFuncExpr,
} from './ast'
import { Database, Table, type Row } from './catalog'
import {
  Distinct,
  Filter,
  HashJoin,
  IndexScan,
  Limit,
  NestedLoopJoin,
  Project,
  SeqScan,
  SetOpExec,
  Sort,
  type Operator,
  type RangeBound,
  type SortKey,
} from './operators'
import { HashAggregate, type AggName, type AggSpec } from './aggregate'
import { WindowExec, type WindowSpecExec } from './window'

// ---------------------------------------------------------------------------
// Planning environment: the database plus an overlay of named relations
// (CTEs and derived tables) and a stack of enclosing scopes for correlated
// subqueries.
export interface PlanEnv {
  db: Database
  relations: Map<string, Table>
  outer: OuterScope[]
}

function envGetTable(env: PlanEnv, name: string): Table {
  return env.relations.get(name.toLowerCase()) ?? env.db.getTable(name)
}

/** Run an operator to completion, collecting all rows. */
function drain(op: Operator): Row[] {
  const rows: Row[] = []
  op.open()
  try {
    for (let r = op.next(); r !== null; r = op.next()) rows.push(r)
  } finally {
    op.close()
  }
  return rows
}

// --- small AST utilities ----------------------------------------------------
function conjuncts(e: Expr | undefined): Expr[] {
  if (!e) return []
  if (e.kind === 'binary' && e.op === 'AND') return [...conjuncts(e.left), ...conjuncts(e.right)]
  return [e]
}
function andAll(es: Expr[]): Expr | undefined {
  if (es.length === 0) return undefined
  return es.reduce((acc, e) => ({ kind: 'binary', op: 'AND', left: acc, right: e }))
}
function collectColumns(e: Expr, out: ColumnExpr[]): void {
  switch (e.kind) {
    case 'column':
      out.push(e)
      break
    case 'unary':
    case 'cast':
      collectColumns(e.expr, out)
      break
    case 'binary':
      collectColumns(e.left, out)
      collectColumns(e.right, out)
      break
    case 'between':
      collectColumns(e.expr, out)
      collectColumns(e.lo, out)
      collectColumns(e.hi, out)
      break
    case 'in':
      collectColumns(e.expr, out)
      e.list.forEach((x) => collectColumns(x, out))
      break
    case 'like':
      collectColumns(e.expr, out)
      collectColumns(e.pattern, out)
      break
    case 'isnull':
      collectColumns(e.expr, out)
      break
    case 'func':
      e.args.forEach((x) => collectColumns(x, out))
      break
    case 'case':
      if (e.operand) collectColumns(e.operand, out)
      e.whens.forEach((w) => {
        collectColumns(w.when, out)
        collectColumns(w.then, out)
      })
      if (e.else) collectColumns(e.else, out)
      break
    case 'in_subquery':
    case 'quantified':
      // Only the left-hand operand belongs to this scope; the subquery body is
      // opaque (and is never pushed down — see containsSubquery).
      collectColumns(e.expr, out)
      break
    case 'window':
      e.args.forEach((a) => collectColumns(a, out))
      e.spec.partitionBy.forEach((p) => collectColumns(p, out))
      e.spec.orderBy.forEach((o) => collectColumns(o.expr, out))
      break
    case 'literal':
    case 'star':
    case 'subquery':
    case 'exists':
      break
  }
}

/** True if `e` contains a subquery anywhere — such predicates are never pushed
 *  below the level where all their (possibly correlated) inputs are available. */
function containsSubquery(e: Expr): boolean {
  switch (e.kind) {
    case 'subquery':
    case 'exists':
    case 'in_subquery':
    case 'quantified':
      return true
    case 'unary':
    case 'cast':
      return containsSubquery(e.expr)
    case 'binary':
      return containsSubquery(e.left) || containsSubquery(e.right)
    case 'between':
      return containsSubquery(e.expr) || containsSubquery(e.lo) || containsSubquery(e.hi)
    case 'in':
      return containsSubquery(e.expr) || e.list.some(containsSubquery)
    case 'like':
      return containsSubquery(e.expr) || containsSubquery(e.pattern)
    case 'isnull':
      return containsSubquery(e.expr)
    case 'func':
      return e.args.some(containsSubquery)
    case 'case':
      return (
        (e.operand ? containsSubquery(e.operand) : false) ||
        e.whens.some((w) => containsSubquery(w.when) || containsSubquery(w.then)) ||
        (e.else ? containsSubquery(e.else) : false)
      )
    default:
      return false
  }
}
/** Does every column in `e` resolve against `schema` (or, when `env` is given,
 *  against an enclosing scope as a correlated reference)? */
function resolvableIn(e: Expr, schema: Schema, env?: PlanEnv): boolean {
  const cols: ColumnExpr[] = []
  collectColumns(e, cols)
  for (const c of cols) {
    if (tryResolveIndex(schema, c.table, c.name) !== null) continue
    if (env && env.outer.some((s) => s.resolve(c.table, c.name) !== null)) continue
    return false
  }
  return true
}
function evalConst(e: Expr): SqlValue | undefined {
  if (e.kind === 'literal') return e.value
  if (e.kind === 'unary' && (e.op === '-' || e.op === '+')) {
    const inner = evalConst(e.expr)
    if (typeof inner === 'number') return e.op === '-' ? -inner : inner
  }
  return undefined
}
function findAggregates(e: Expr, out: Map<string, Expr>): void {
  if (e.kind === 'func' && isAggregate(e.name)) {
    out.set(exprKey(e), e)
    return // don't descend into aggregate args looking for nested aggregates
  }
  const kids: Expr[] = []
  collectChildren(e, kids)
  kids.forEach((k) => findAggregates(k, out))
}
function collectChildren(e: Expr, out: Expr[]): void {
  switch (e.kind) {
    case 'unary':
    case 'cast':
      out.push(e.expr)
      break
    case 'binary':
      out.push(e.left, e.right)
      break
    case 'between':
      out.push(e.expr, e.lo, e.hi)
      break
    case 'in':
      out.push(e.expr, ...e.list)
      break
    case 'like':
      out.push(e.expr, e.pattern)
      break
    case 'isnull':
      out.push(e.expr)
      break
    case 'func':
      out.push(...e.args)
      break
    case 'case':
      if (e.operand) out.push(e.operand)
      e.whens.forEach((w) => out.push(w.when, w.then))
      if (e.else) out.push(e.else)
      break
    case 'in_subquery':
    case 'quantified':
      out.push(e.expr)
      break
    case 'literal':
    case 'column':
    case 'star':
    case 'subquery':
    case 'exists':
    case 'window':
      // Aggregates inside a subquery or window belong to that nested context,
      // not the current GROUP BY — don't descend.
      break
  }
}

function tableSchema(table: Table, alias: string): Schema {
  return table.columns.map((c) => ({ table: alias, name: c.name, type: c.type }))
}

function exprLabel(e: Expr): string {
  switch (e.kind) {
    case 'column':
      return e.table ? `${e.table}.${e.name}` : e.name
    case 'literal':
      return e.value === null ? 'NULL' : String(e.value)
    case 'func':
      return `${e.name}(${e.star ? '*' : e.args.map(exprLabel).join(', ')})`
    case 'binary':
      return `${exprLabel(e.left)} ${e.op} ${exprLabel(e.right)}`
    case 'unary':
      return `${e.op}${exprLabel(e.expr)}`
    case 'cast':
      return `CAST(${exprLabel(e.expr)} AS ${e.type})`
    case 'case':
      return 'CASE…END'
    case 'subquery':
      return '(subquery)'
    case 'exists':
      return `${e.negated ? 'NOT ' : ''}EXISTS(…)`
    case 'in_subquery':
      return `${exprLabel(e.expr)} ${e.negated ? 'NOT ' : ''}IN (subquery)`
    case 'quantified':
      return `${exprLabel(e.expr)} ${e.op} ${e.quantifier} (subquery)`
    case 'window': {
      const args = e.args.length ? e.args.map(exprLabel).join(', ') : ''
      const parts: string[] = []
      if (e.spec.partitionBy.length) parts.push(`PARTITION BY ${e.spec.partitionBy.map(exprLabel).join(', ')}`)
      if (e.spec.orderBy.length) parts.push(`ORDER BY ${e.spec.orderBy.map((o) => `${exprLabel(o.expr)} ${o.dir}`).join(', ')}`)
      return `${e.name}(${args}) OVER (${parts.join(' ')})`
    }
    default:
      return 'expr'
  }
}

function inferType(e: Expr, schema: Schema, ctx: CompileCtx): ColumnType {
  switch (e.kind) {
    case 'column':
      try {
        return schema[resolveColumn(schema, e.table, e.name)].type
      } catch {
        return 'TEXT'
      }
    case 'literal':
      if (typeof e.value === 'number') return Number.isInteger(e.value) ? 'INTEGER' : 'REAL'
      if (typeof e.value === 'boolean') return 'BOOLEAN'
      return 'TEXT'
    case 'cast':
      return e.type
    case 'func':
      if (e.name === 'COUNT') return 'INTEGER'
      if (['LENGTH', 'INSTR', 'ASCII', 'SIGN', 'DATE_PART', 'EXTRACT', 'DATEDIFF'].includes(e.name)) return 'INTEGER'
      if (
        [
          'SUM', 'MIN', 'MAX', 'AVG', 'ABS', 'ROUND', 'SQRT', 'CEIL', 'CEILING', 'FLOOR', 'TRUNC',
          'POW', 'POWER', 'MOD', 'EXP', 'LN', 'LOG', 'LOG10', 'PI', 'SIN', 'COS', 'TAN', 'ASIN',
          'ACOS', 'ATAN', 'ATAN2', 'RADIANS', 'DEGREES', 'RANDOM', 'JULIANDAY',
        ].includes(e.name)
      )
        return 'REAL'
      if (
        [
          'UPPER', 'LOWER', 'INITCAP', 'TRIM', 'LTRIM', 'RTRIM', 'LPAD', 'RPAD', 'REPEAT', 'REVERSE',
          'LEFT', 'RIGHT', 'CONCAT', 'CONCAT_WS', 'SUBSTR', 'REPLACE', 'CHR', 'TYPEOF', 'NOW', 'DATE',
          'DATETIME', 'STRFTIME', 'DATE_ADD',
        ].includes(e.name)
      )
        return 'TEXT'
      return 'TEXT'
    case 'binary':
      if (['=', '<>', '<', '<=', '>', '>=', 'AND', 'OR'].includes(e.op)) return 'BOOLEAN'
      if (e.op === '||') return 'TEXT'
      return 'REAL'
    case 'unary':
      return e.op === 'NOT' ? 'BOOLEAN' : 'REAL'
    case 'between':
    case 'in':
    case 'like':
    case 'isnull':
    case 'exists':
    case 'in_subquery':
    case 'quantified':
      return 'BOOLEAN'
    case 'window':
      if (['ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'COUNT'].includes(e.name)) return 'INTEGER'
      if (['PERCENT_RANK', 'CUME_DIST', 'AVG'].includes(e.name)) return 'REAL'
      if (e.name === 'SUM') return 'REAL'
      if (['LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE', 'NTH_VALUE', 'MIN', 'MAX'].includes(e.name))
        return e.args[0] ? inferType(e.args[0], schema, ctx) : 'REAL'
      return 'REAL'
    case 'subquery':
      return e.select.columns.length === 1 && e.select.columns[0].expr.kind !== 'star'
        ? 'TEXT'
        : 'TEXT'
    default:
      void ctx
      return 'TEXT'
  }
}

// --- index selection --------------------------------------------------------
interface IndexPlan {
  op: Operator
  consumed: Set<Expr>
}

function tryIndexScan(table: Table, baseSchema: Schema, preds: Expr[]): IndexPlan | null {
  // Gather sargable comparisons grouped by indexed column.
  interface Sarg {
    pred: Expr
    op: '=' | '<' | '<=' | '>' | '>='
    value: SqlValue
  }
  const byColumn = new Map<string, Sarg[]>()
  for (const p of preds) {
    if (p.kind !== 'binary') continue
    const ops = ['=', '<', '<=', '>', '>=']
    if (!ops.includes(p.op)) continue
    let col: ColumnExpr | null = null
    let constVal: SqlValue | undefined
    let op = p.op as Sarg['op']
    if (p.left.kind === 'column' && evalConst(p.right) !== undefined) {
      col = p.left
      constVal = evalConst(p.right)
    } else if (p.right.kind === 'column' && evalConst(p.left) !== undefined) {
      col = p.right
      constVal = evalConst(p.left)
      // flip operator direction
      op = ({ '<': '>', '<=': '>=', '>': '<', '>=': '<=', '=': '=' } as const)[op]
    }
    if (!col || constVal === undefined) continue
    // column must belong to this table and be indexed
    try {
      resolveColumn(baseSchema, col.table, col.name)
    } catch {
      continue
    }
    if (!table.indexForColumn(col.name)) continue
    const key = col.name.toLowerCase()
    const list = byColumn.get(key) ?? []
    list.push({ pred: p, op, value: constVal })
    byColumn.set(key, list)
  }
  if (byColumn.size === 0) return null

  // Prefer a column with an equality (best selectivity), else any range.
  let chosen: { column: string; sargs: Sarg[] } | null = null
  for (const [column, sargs] of byColumn) {
    const hasEq = sargs.some((s) => s.op === '=')
    if (hasEq) {
      chosen = { column, sargs: sargs.filter((s) => s.op === '=').slice(0, 1) }
      break
    }
    if (!chosen) chosen = { column, sargs }
  }
  if (!chosen) return null
  const index = table.indexForColumn(chosen.column)!

  let lo: RangeBound = null
  let hi: RangeBound = null
  const consumed = new Set<Expr>()
  for (const s of chosen.sargs) {
    consumed.add(s.pred)
    if (s.op === '=') {
      lo = { value: s.value, inclusive: true }
      hi = { value: s.value, inclusive: true }
    } else if (s.op === '>') lo = { value: s.value, inclusive: false }
    else if (s.op === '>=') lo = { value: s.value, inclusive: true }
    else if (s.op === '<') hi = { value: s.value, inclusive: false }
    else if (s.op === '<=') hi = { value: s.value, inclusive: true }
  }
  return { op: new IndexScan(table, index, baseSchema, lo, hi), consumed }
}

// --- equijoin extraction ----------------------------------------------------
interface EquiJoin {
  leftKey: Evaluator
  rightKey: Evaluator
  residual: Expr[]
}
function extractEquiJoin(on: Expr, leftSchema: Schema, rightSchema: Schema): EquiJoin | null {
  const parts = conjuncts(on)
  let leftKey: Evaluator | null = null
  let rightKey: Evaluator | null = null
  const residual: Expr[] = []
  const leftCtx: CompileCtx = { resolve: (t, n) => resolveColumn(leftSchema, t, n) }
  const rightCtx: CompileCtx = { resolve: (t, n) => resolveColumn(rightSchema, t, n) }
  for (const part of parts) {
    // A subquery is never a hash-join key — leave it to the residual filter,
    // which is compiled with a subquery-aware context.
    if (!leftKey && part.kind === 'binary' && part.op === '=' && !containsSubquery(part)) {
      const lInLeft = resolvableIn(part.left, leftSchema)
      const rInRight = resolvableIn(part.right, rightSchema)
      const lInRight = resolvableIn(part.left, rightSchema)
      const rInLeft = resolvableIn(part.right, leftSchema)
      if (lInLeft && rInRight && !(lInRight && rInLeft && false)) {
        leftKey = compileExpr(part.left, leftCtx)
        rightKey = compileExpr(part.right, rightCtx)
        continue
      }
      if (lInRight && rInLeft) {
        leftKey = compileExpr(part.right, leftCtx)
        rightKey = compileExpr(part.left, rightCtx)
        continue
      }
    }
    residual.push(part)
  }
  if (!leftKey || !rightKey) return null
  return { leftKey, rightKey, residual }
}

// ============================================================================
// Public entry point: plan a (possibly compound, possibly WITH-prefixed) query.
export function planSelect(stmt: SelectStmt, db: Database): Operator {
  return planQuery(stmt, { db, relations: new Map(), outer: [] })
}

// Plan a full query: materialize CTEs, plan the leading core, then fold in any
// set-operation tail (UNION/INTERSECT/EXCEPT) with a compound ORDER BY/LIMIT.
function planQuery(stmt: SelectStmt, env: PlanEnv): Operator {
  const env2 = stmt.ctes && stmt.ctes.length ? withCtes(stmt, env) : env
  if (stmt.setOps && stmt.setOps.length) {
    // Plan every branch, then fold with set-operation precedence: INTERSECT
    // binds tighter than UNION/EXCEPT (SQL standard).
    const operands: Operator[] = [planCore(stmt, env2, false)]
    const ops: { op: SetOp['op']; all: boolean }[] = []
    for (const so of stmt.setOps) {
      const rhs = planCore(so.select, env2, false)
      if (rhs.schema.length !== operands[0].schema.length) {
        throw new SqlError(`each ${so.op} query must return the same number of columns`, 'bind')
      }
      operands.push(rhs)
      ops.push({ op: so.op, all: so.all })
    }
    // Pass 1: collapse INTERSECT runs.
    for (let i = 0; i < ops.length; ) {
      if (ops[i].op === 'INTERSECT') {
        const merged = new SetOpExec(operands[i], operands[i + 1], 'INTERSECT', ops[i].all, operands[i].schema)
        operands.splice(i, 2, merged)
        ops.splice(i, 1)
      } else {
        i++
      }
    }
    // Pass 2: fold remaining UNION/EXCEPT left to right.
    let op = operands[0]
    for (let i = 0; i < ops.length; i++) {
      op = new SetOpExec(op, operands[i + 1], ops[i].op, ops[i].all, op.schema)
    }
    if (stmt.orderBy.length) op = new Sort(op, compoundSortKeys(stmt.orderBy, op.schema, env2))
    if (stmt.limit !== undefined) op = new Limit(op, stmt.limit, stmt.offset ?? 0)
    return op
  }
  return planCore(stmt, env2, true)
}

// Resolve a named table or derived table to a (possibly transient) Table.
function relationFor(item: FromItem | JoinClause, env: PlanEnv): { table: Table; alias: string } {
  if (item.subquery) {
    const alias = item.alias ?? '__derived'
    const t = materialize(item.subquery, env, alias)
    return { table: t, alias }
  }
  const t = envGetTable(env, item.table!)
  return { table: t, alias: item.alias ?? t.name }
}

// Plan a single SELECT core (no set-op tail). When `embedOrderLimit` is false
// (a compound branch), ORDER BY / LIMIT are left for the compound level.
function planCore(stmt: SelectStmt, env: PlanEnv, embedOrderLimit: boolean): Operator {
  const wherePreds = conjuncts(stmt.where)
  const consumed = new Set<Expr>()

  if (!stmt.from) {
    // SELECT without FROM — evaluate a single synthetic row of constants.
    return planConstantSelect(stmt, env)
  }

  // A RIGHT/FULL join makes the *base* (left-most) relation nullable, so we must
  // not filter it early — predicate pushdown to it would drop rows that an outer
  // join should null-extend. Keep all WHERE predicates for the final stage then.
  const basePreserved = !stmt.joins.some((j) => j.type === 'RIGHT' || j.type === 'FULL')

  // --- base relation --------------------------------------------------------
  const base = relationFor(stmt.from, env)
  let schema: Schema = tableSchema(base.table, base.alias)

  let op: Operator
  if (basePreserved) {
    const baseApplicable = wherePreds.filter((p) => !consumed.has(p) && resolvableIn(p, schema, env))
    const idx = tryIndexScan(base.table, schema, baseApplicable)
    if (idx) {
      op = idx.op
      idx.consumed.forEach((p) => consumed.add(p))
    } else {
      op = new SeqScan(base.table, schema)
    }
    op = applyPushdown(op, schema, wherePreds, consumed, env, false)
  } else {
    op = new SeqScan(base.table, schema)
  }

  // --- joins ----------------------------------------------------------------
  for (const join of stmt.joins) {
    const right = relationFor(join, env)
    const rSchema = tableSchema(right.table, right.alias)
    // Only push WHERE predicates onto the right input for INNER joins; for an
    // outer join the right side may be null-extended, so its WHERE predicates
    // must run after the join (the final pushdown stage).
    let rightOp: Operator = new SeqScan(right.table, rSchema)
    if (join.type === 'INNER') {
      rightOp = applyPushdown(rightOp, rSchema, wherePreds, consumed, env, false)
    }

    const combined: Schema = [...schema, ...rSchema]
    const outerType: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' =
      join.type === 'LEFT' || join.type === 'RIGHT' || join.type === 'FULL' ? join.type : 'INNER'
    if (join.type === 'CROSS' || !join.on) {
      op = new NestedLoopJoin(op, rightOp, null, 'CROSS', combined)
    } else {
      const equi = extractEquiJoin(join.on, schema, rSchema)
      if (equi && equi.residual.length === 0) {
        op = new HashJoin(op, rightOp, equi.leftKey, equi.rightKey, outerType, combined)
      } else if (equi && join.type === 'INNER') {
        op = new HashJoin(op, rightOp, equi.leftKey, equi.rightKey, 'INNER', combined)
        const resid = andAll(equi.residual)!
        op = new Filter(op, compileExpr(resid, exprCtx(combined, env)), exprLabel(resid))
      } else {
        const pred = compileExpr(join.on, exprCtx(combined, env))
        op = new NestedLoopJoin(op, rightOp, pred, outerType, combined)
      }
    }
    schema = combined
  }

  // Any remaining WHERE predicates (multi-table / subquery) apply now.
  op = applyPushdown(op, schema, wherePreds, consumed, env, true)

  // --- aggregation ----------------------------------------------------------
  const aggMap = new Map<string, Expr>()
  for (const item of stmt.columns) findAggregates(item.expr, aggMap)
  if (stmt.having) findAggregates(stmt.having, aggMap)
  for (const o of stmt.orderBy) findAggregates(o.expr, aggMap)
  const grouped = stmt.groupBy.length > 0 || aggMap.size > 0

  let outCtx: CompileCtx
  if (grouped) {
    const preCtx = exprCtx(schema, env)
    const groupEvals = stmt.groupBy.map((g) => compileExpr(g, preCtx))
    const groupKeyMap = new Map<string, number>()
    stmt.groupBy.forEach((g, i) => groupKeyMap.set(exprKey(g), i))

    const aggExprs = [...aggMap.values()]
    const aggSlot = new Map<string, number>()
    const aggSpecs: AggSpec[] = aggExprs.map((e, i) => {
      if (e.kind !== 'func') throw new SqlError('internal: non-func aggregate', 'plan')
      aggSlot.set(exprKey(e), stmt.groupBy.length + i)
      return {
        name: e.name as AggName,
        star: e.star,
        distinct: e.distinct,
        arg: e.star || e.args.length === 0 ? null : compileExpr(e.args[0], preCtx),
        label: exprLabel(e),
      }
    })

    // Output schema of the aggregate: group keys then aggregates.
    const aggSchema: Schema = [
      ...stmt.groupBy.map((g, i) => ({
        table: '',
        name: g.kind === 'column' ? g.name : `group${i}`,
        type: inferType(g, schema, preCtx),
      })),
      ...aggExprs.map((e) => ({ table: '', name: exprLabel(e), type: inferType(e, schema, preCtx) })),
    ]
    op = new HashAggregate(op, groupEvals, aggSpecs, aggSchema)

    const groupResolve = (t: string | undefined, n: string): number => {
      // A bare column is only valid post-grouping if it's a grouping key.
      const k = exprKey({ kind: 'column', table: t, name: n })
      const slot = groupKeyMap.get(k)
      if (slot !== undefined) return slot
      throw new SqlError(
        `column "${t ? `${t}.${n}` : n}" must appear in GROUP BY or be used in an aggregate`,
        'bind',
      )
    }
    outCtx = exprCtx(aggSchema, env, {
      resolve: groupResolve,
      lookup: (e) => {
        const gk = groupKeyMap.get(exprKey(e))
        if (gk !== undefined) return gk
        const ak = aggSlot.get(exprKey(e))
        if (ak !== undefined) return ak
        return undefined
      },
    })
    schema = aggSchema
  } else {
    outCtx = exprCtx(schema, env)
  }

  // --- HAVING ---------------------------------------------------------------
  if (stmt.having) {
    op = new Filter(op, compileExpr(stmt.having, outCtx), `HAVING ${exprLabel(stmt.having)}`)
  }

  // --- window functions -----------------------------------------------------
  const windowPlan = planWindowFns(stmt.columns, stmt.orderBy, outCtx, schema)
  if (windowPlan) {
    op = new WindowExec(op, windowPlan.specs, windowPlan.schema)
    const prevResolve = outCtx.resolve
    const prevLookup = outCtx.lookup
    outCtx = exprCtx(windowPlan.schema, env, {
      resolve: prevResolve,
      lookup: (e) => windowPlan.lookup(e) ?? prevLookup?.(e),
    })
    schema = windowPlan.schema
  }

  // --- expand projection list (resolve aliases for ORDER BY) ----------------
  const projExprs: Expr[] = []
  const projLabels: string[] = []
  const projTypes: ColumnType[] = []
  const aliasMap = new Map<string, Expr>()
  for (const item of stmt.columns) {
    if (item.expr.kind === 'star') {
      const want = item.expr.table?.toLowerCase()
      for (const b of schema) {
        if (want && b.table.toLowerCase() !== want) continue
        if (!b.table && b.name.startsWith('__win')) continue // hide window scratch columns
        projExprs.push({ kind: 'column', table: b.table || undefined, name: b.name })
        projLabels.push(b.name)
        projTypes.push(b.type)
      }
      continue
    }
    projExprs.push(item.expr)
    // A bare column projects under its *unqualified* name (SQL semantics) — so
    // `SELECT c.id` yields a column named `id`, which keeps derived tables and
    // CTEs referenceable.
    const label = item.alias ?? (item.expr.kind === 'column' ? item.expr.name : exprLabel(item.expr))
    projLabels.push(label)
    projTypes.push(inferType(item.expr, schema, outCtx))
    if (item.alias) aliasMap.set(item.alias.toLowerCase(), item.expr)
  }
  if (projExprs.length === 0) throw new SqlError('SELECT requires at least one column', 'bind')

  // --- ORDER BY (before projection, with alias substitution) ----------------
  if (embedOrderLimit && stmt.orderBy.length > 0) {
    const keys: SortKey[] = stmt.orderBy.map((o) => {
      let e = o.expr
      // ORDER BY <n> refers to the n-th output column (1-based).
      if (e.kind === 'literal' && typeof e.value === 'number') {
        const idx = e.value - 1
        if (idx < 0 || idx >= projExprs.length) {
          throw new SqlError(`ORDER BY position ${e.value} is out of range`, 'bind')
        }
        e = projExprs[idx]
      } else if (e.kind === 'column' && !e.table && aliasMap.has(e.name.toLowerCase())) {
        e = aliasMap.get(e.name.toLowerCase())!
      }
      return { eval: compileExpr(e, outCtx), dir: o.dir }
    })
    op = new Sort(op, keys)
  }

  // --- projection -----------------------------------------------------------
  const outSchema: Schema = projExprs.map((_, i) => ({ table: '', name: projLabels[i], type: projTypes[i] }))
  op = new Project(op, projExprs.map((e) => compileExpr(e, outCtx)), outSchema, projLabels)

  if (stmt.distinct) op = new Distinct(op)
  if (embedOrderLimit && stmt.limit !== undefined) op = new Limit(op, stmt.limit, stmt.offset ?? 0)

  return op
}

// SELECT <exprs> with no FROM clause — a one-row constant projection.
function planConstantSelect(stmt: SelectStmt, env: PlanEnv): Operator {
  const ctx = exprCtx([], env, {
    resolve: () => {
      throw new SqlError('column reference requires a FROM clause', 'bind')
    },
  })
  const exprs: Evaluator[] = []
  const labels: string[] = []
  const schema: Schema = []
  for (const item of stmt.columns) {
    if (item.expr.kind === 'star') throw new SqlError('SELECT * requires a FROM clause', 'bind')
    exprs.push(compileExpr(item.expr, ctx))
    const label = item.alias ?? exprLabel(item.expr)
    labels.push(label)
    schema.push({ table: '', name: label, type: inferType(item.expr, [], ctx) })
  }
  const one: Operator = new SingleRow()
  return new Project(one, exprs, schema, labels)
}

// ---------------------------------------------------------------------------
// CTEs / derived tables / subqueries / set-op ORDER BY
// ---------------------------------------------------------------------------

function tryResolveIndex(schema: Schema, table: string | undefined, name: string): number | null {
  try {
    return resolveColumn(schema, table, name)
  } catch {
    return null
  }
}

// Build a CompileCtx for user expressions over `schema`, wired for correlated
// column resolution (against env.outer) and subqueries.
function exprCtx(
  schema: Schema,
  env: PlanEnv,
  extra?: {
    resolve?: CompileCtx['resolve']
    lookup?: CompileCtx['lookup']
    compileWindow?: CompileCtx['compileWindow']
  },
): CompileCtx {
  const resolve = extra?.resolve ?? ((t: string | undefined, n: string) => resolveColumn(schema, t, n))
  const ctx: CompileCtx = {
    resolve,
    lookup: extra?.lookup,
    outer: env.outer.length ? env.outer : undefined,
    compileWindow: extra?.compileWindow,
  }
  ctx.compileSubquery = (e) => compileSubqueryExpr(e, schema, env, ctx)
  return ctx
}

// Compile a scalar/IN/EXISTS subquery into an evaluator. Correlated references
// to the enclosing `schema` are resolved through a per-subquery OuterScope whose
// `row` the evaluator sets before each (re-)execution; uncorrelated subqueries
// are executed once and cached.
function compileSubqueryExpr(
  e: SubqueryExpr | ExistsExpr | InSubqueryExpr | QuantifiedExpr,
  schema: Schema,
  env: PlanEnv,
  outerCtx: CompileCtx,
): Evaluator {
  // `correlated` is set if this subquery — or anything nested inside it —
  // references this scope OR any *enclosing* scope. That makes it unsafe to
  // cache (its result varies as some outer row changes). We detect references to
  // enclosing scopes by wrapping them so a hit also flips our flag.
  let correlated = false
  const scope: OuterScope = {
    resolve: (t, n) => {
      const i = tryResolveIndex(schema, t, n)
      if (i !== null) correlated = true
      return i
    },
    row: null,
  }
  const wrappedOuter: OuterScope[] = env.outer.map((s) => ({
    resolve: (t, n) => {
      const i = s.resolve(t, n)
      if (i !== null) correlated = true
      return i
    },
    get row() {
      return s.row
    },
    set row(v: Row | null) {
      s.row = v
    },
  }))
  const innerEnv: PlanEnv = { db: env.db, relations: env.relations, outer: [...wrappedOuter, scope] }
  const innerOp = planQuery(e.select, innerEnv)

  if (e.kind === 'subquery' || e.kind === 'in_subquery' || e.kind === 'quantified') {
    if (innerOp.schema.length !== 1) {
      throw new SqlError('a subquery used as a value must return exactly one column', 'bind')
    }
  }

  if (e.kind === 'subquery') {
    let cached: { v: SqlValue } | null = null
    return (row) => {
      if (!correlated && cached) return cached.v
      scope.row = row
      const rows = drain(innerOp)
      if (rows.length > 1) throw new SqlError('scalar subquery returned more than one row', 'eval')
      const v = rows.length === 0 ? null : rows[0][0]
      if (!correlated) cached = { v }
      return v
    }
  }
  if (e.kind === 'exists') {
    const neg = e.negated
    let cached: { v: SqlValue } | null = null
    return (row) => {
      if (!correlated && cached) return cached.v
      scope.row = row
      innerOp.open()
      try {
        const has = innerOp.next() !== null
        const v = neg ? !has : has
        if (!correlated) cached = { v }
        return v
      } finally {
        innerOp.close()
      }
    }
  }
  const lhs = compileExpr(e.expr, outerCtx)
  const gatherVals = (row: Row, cache: { v: SqlValue[] | null }): SqlValue[] => {
    if (!correlated && cache.v) return cache.v
    scope.row = row
    const vals = drain(innerOp).map((r) => r[0])
    if (!correlated) cache.v = vals
    return vals
  }

  if (e.kind === 'quantified') {
    const cmp = comparator(e.op)
    const isAny = e.quantifier === 'ANY'
    const cache: { v: SqlValue[] | null } = { v: null }
    return (row) => {
      const x = lhs(row)
      const vals = gatherVals(row, cache)
      // Empty set: ANY → false, ALL → true (SQL standard).
      if (vals.length === 0) return !isAny
      if (x === null) return null
      let sawNull = false
      for (const y of vals) {
        if (y === null) {
          sawNull = true
          continue
        }
        const c = compareValues(x, y)
        const truth = c !== null && cmp(c)
        if (isAny && truth) return true
        if (!isAny && !truth) return false
      }
      // ANY: no match (NULL if a NULL was seen, else false).
      // ALL: all matched (NULL if a NULL was seen, else true).
      return sawNull ? null : !isAny
    }
  }

  // in_subquery
  const neg = e.negated
  const cache: { v: SqlValue[] | null } = { v: null }
  return (row) => {
    const x = lhs(row)
    const vals = gatherVals(row, cache)
    if (x === null) return null
    let sawNull = false
    for (const y of vals) {
      if (y === null) {
        sawNull = true
        continue
      }
      if (valuesEqual(x, y)) return !neg
    }
    if (sawNull) return null
    return neg
  }
}

// A comparison predicate over the sign of compareValues(lhs, rhs).
function comparator(op: '=' | '<>' | '<' | '<=' | '>' | '>='): (c: number) => boolean {
  switch (op) {
    case '=':
      return (c) => c === 0
    case '<>':
      return (c) => c !== 0
    case '<':
      return (c) => c < 0
    case '<=':
      return (c) => c <= 0
    case '>':
      return (c) => c > 0
    case '>=':
      return (c) => c >= 0
  }
}

// Derive column types from the actual rows (the static inferType is only a
// best-effort label and can be wrong, e.g. for CASE/COALESCE/subqueries). This
// keeps materialized relations lossless — we never coerce a number to TEXT.
function dataDrivenColumns(rows: Row[], base: Schema, names: (string | undefined)[]): ColumnDef[] {
  return base.map((b, i) => {
    let sawStr = false
    let sawBool = false
    let sawReal = false
    let sawInt = false
    for (const r of rows) {
      const v = r[i]
      if (v === null) continue
      if (typeof v === 'string') sawStr = true
      else if (typeof v === 'boolean') sawBool = true
      else if (Number.isInteger(v)) sawInt = true
      else sawReal = true
    }
    let type: ColumnType
    if (sawStr) type = 'TEXT'
    else if (sawReal || (sawInt && sawBool)) type = 'REAL'
    else if (sawInt) type = 'INTEGER'
    else if (sawBool) type = 'BOOLEAN'
    else type = b.type // all-null column — keep the static guess
    return { name: names[i] ?? b.name ?? `col${i + 1}`, type, primaryKey: false, notNull: false, unique: false }
  })
}

// Materialize a query's result into a transient in-memory table (used for CTEs
// and derived tables). Re-uses the full executor, so the relation behaves
// exactly like a base table for scans, joins and indexes.
function materialize(stmt: SelectStmt, env: PlanEnv, name: string, columnNames?: string[]): Table {
  const op = planQuery(stmt, env)
  const rows = drain(op)
  const cols = dataDrivenColumns(rows, op.schema, op.schema.map((_, i) => columnNames?.[i]))
  const t = new Table(name, cols)
  for (const r of rows) t.insertRawRow(r.slice())
  return t
}

// Build a child env with each CTE materialized (earlier CTEs visible to later).
function withCtes(stmt: SelectStmt, env: PlanEnv): PlanEnv {
  const relations = new Map(env.relations)
  const childEnv: PlanEnv = { db: env.db, relations, outer: env.outer }
  for (const cte of stmt.ctes!) {
    const t =
      stmt.recursive && isRecursiveCte(cte)
        ? materializeRecursive(cte, childEnv)
        : materialize(cte.select, childEnv, cte.name, cte.columns)
    relations.set(cte.name.toLowerCase(), t)
  }
  return childEnv
}

function isRecursiveCte(cte: CteDef): boolean {
  return !!(cte.select.setOps && cte.select.setOps.length) && referencesRelation(cte.select, cte.name)
}

function referencesRelation(stmt: SelectStmt, name: string): boolean {
  const ln = name.toLowerCase()
  const inItem = (it?: FromItem | JoinClause): boolean =>
    !!it && (it.table?.toLowerCase() === ln || (!!it.subquery && referencesRelation(it.subquery, name)))
  if (inItem(stmt.from)) return true
  for (const j of stmt.joins) if (inItem(j)) return true
  if (stmt.setOps) for (const so of stmt.setOps) if (referencesRelation(so.select, name)) return true
  return false
}

const MAX_RECURSION_ROWS = 100_000

// Evaluate a recursive CTE with classic semi-naive iteration: run the anchor,
// then repeatedly run the recursive term(s) with the CTE bound to the rows
// produced in the previous round, accumulating until a fixpoint (or a guard).
function materializeRecursive(cte: CteDef, env: PlanEnv): Table {
  const sel = cte.select
  const setOps = sel.setOps!
  const coreStmt: SelectStmt = {
    ...sel,
    setOps: undefined,
    ctes: undefined,
    orderBy: [],
    limit: undefined,
    offset: undefined,
  }
  // Split the branches into anchor terms (no self-reference, run once) and
  // recursive terms (reference the CTE, iterated to a fixpoint).
  const branches: SelectStmt[] = [coreStmt, ...setOps.map((s) => ({ ...s.select, ctes: undefined }))]
  const anchors = branches.filter((b) => !referencesRelation(b, cte.name))
  const recursives = branches.filter((b) => referencesRelation(b, cte.name))
  if (anchors.length === 0) {
    throw new SqlError('recursive CTE has no non-recursive (anchor) term', 'plan')
  }
  const distinct = setOps.some((s) => !s.all)

  const anchorOps = anchors.map((b) => planQuery(b, env))
  const anchorRows: Row[] = []
  for (const op of anchorOps) for (const r of drain(op)) anchorRows.push(r)
  const baseSchema = anchorOps[0].schema
  const cols = dataDrivenColumns(
    anchorRows,
    baseSchema,
    baseSchema.map((_, i) => cte.columns?.[i]),
  )
  const result = new Table(cte.name, cols)
  const seen = new Set<string>()
  let total = 0
  const add = (r: Row): boolean => {
    if (distinct) {
      const k = hashKey(r)
      if (seen.has(k)) return false
      seen.add(k)
    }
    result.insertRawRow(r.slice())
    if (++total > MAX_RECURSION_ROWS) {
      throw new SqlError('recursive CTE exceeded the row limit (possible non-terminating recursion)', 'eval')
    }
    return true
  }
  let frontier: Row[] = anchorRows.filter(add)
  while (frontier.length) {
    const wt = new Table(cte.name, cols)
    for (const r of frontier) wt.insertRawRow(r.slice())
    const childRel = new Map(env.relations)
    childRel.set(cte.name.toLowerCase(), wt)
    const childEnv: PlanEnv = { db: env.db, relations: childRel, outer: env.outer }
    const next: Row[] = []
    for (const b of recursives) {
      const op = planQuery(b, childEnv)
      for (const r of drain(op)) if (add(r)) next.push(r)
    }
    frontier = next
  }
  return result
}

// ---------------------------------------------------------------------------
// Window functions
// ---------------------------------------------------------------------------

interface WindowPlanResult {
  specs: WindowSpecExec[]
  schema: Schema
  lookup: (e: Expr) => number | undefined
}

function collectWindows(e: Expr, out: Map<string, WindowFuncExpr>): void {
  if (e.kind === 'window') {
    out.set(exprKey(e), e)
    return
  }
  const kids: Expr[] = []
  collectChildren(e, kids)
  kids.forEach((k) => collectWindows(k, out))
}

// Find the window functions referenced by the SELECT list / ORDER BY, compile
// their args + PARTITION BY + ORDER BY against the (post-aggregation) ctx, and
// describe the extra columns a WindowExec will append.
function planWindowFns(
  columns: SelectStmt['columns'],
  orderBy: SelectStmt['orderBy'],
  ctx: CompileCtx,
  schema: Schema,
): WindowPlanResult | null {
  const found = new Map<string, WindowFuncExpr>()
  for (const it of columns) collectWindows(it.expr, found)
  for (const o of orderBy) collectWindows(o.expr, found)
  if (found.size === 0) return null
  const exprs = [...found.values()]
  const specs: WindowSpecExec[] = exprs.map((w) => ({
    name: w.name,
    args: w.args.map((a) => compileExpr(a, ctx)),
    partition: w.spec.partitionBy.map((p) => compileExpr(p, ctx)),
    order: w.spec.orderBy.map((o) => ({ eval: compileExpr(o.expr, ctx), dir: o.dir })),
    label: exprLabel(w),
  }))
  const winSchema: Schema = [
    ...schema,
    ...exprs.map((w, i) => ({ table: '', name: `__win${i}`, type: inferType(w, schema, ctx) })),
  ]
  const slot = new Map<string, number>()
  exprs.forEach((w, i) => slot.set(exprKey(w), schema.length + i))
  return { specs, schema: winSchema, lookup: (e) => slot.get(exprKey(e)) }
}

// ORDER BY for a compound (set-op) query: resolve keys by output ordinal or
// against the output column names.
function compoundSortKeys(orderBy: SelectStmt['orderBy'], schema: Schema, env: PlanEnv): SortKey[] {
  const ctx = exprCtx(schema, env)
  return orderBy.map((o) => {
    if (o.expr.kind === 'literal' && typeof o.expr.value === 'number') {
      const idx = o.expr.value - 1
      if (idx < 0 || idx >= schema.length) {
        throw new SqlError(`ORDER BY position ${o.expr.value} is out of range`, 'bind')
      }
      return { eval: (row: Row) => row[idx], dir: o.dir }
    }
    return { eval: compileExpr(o.expr, ctx), dir: o.dir }
  })
}

// Emits exactly one empty row (for FROM-less SELECT).
class SingleRow implements Operator {
  readonly schema: Schema = []
  estRows = 1
  estCost = 0
  private done = false
  open() {
    this.done = false
  }
  next() {
    if (this.done) return null
    this.done = true
    return [] as SqlValue[]
  }
  close() {}
  plan() {
    return { op: 'Result', detail: 'single row', estRows: 1, estCost: 0, actualRows: this.done ? 1 : 0, extra: [], children: [] }
  }
}

function applyPushdown(
  op: Operator,
  schema: Schema,
  preds: Expr[],
  consumed: Set<Expr>,
  env: PlanEnv,
  final: boolean,
): Operator {
  // Predicates containing a subquery are only applied at the `final` stage,
  // where every (possibly correlated) input is in scope.
  const applicable = preds.filter(
    (p) => !consumed.has(p) && (final || !containsSubquery(p)) && resolvableIn(p, schema, env),
  )
  if (applicable.length === 0) return op
  applicable.forEach((p) => consumed.add(p))
  const combined = andAll(applicable)!
  const pred = compileExpr(combined, exprCtx(schema, env))
  return new Filter(op, pred, exprLabel(combined))
}

// `Binding` re-exported so the engine can describe result columns.
export type { Binding }
