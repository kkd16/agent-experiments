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

import { SqlError, type ColumnType, type SqlValue } from './types'
import { compileExpr, exprKey, type CompileCtx, type Evaluator } from './eval'
import { resolveColumn, type Binding, type Schema } from './schema'
import { isAggregate, type Expr, type SelectStmt, type ColumnExpr } from './ast'
import type { Database, Table } from './catalog'
import {
  Distinct,
  Filter,
  HashJoin,
  IndexScan,
  Limit,
  NestedLoopJoin,
  Project,
  SeqScan,
  Sort,
  type Operator,
  type RangeBound,
  type SortKey,
} from './operators'
import { HashAggregate, type AggName, type AggSpec } from './aggregate'

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
    case 'literal':
    case 'star':
      break
  }
}
/** Does every column in `e` resolve against `schema`? */
function resolvableIn(e: Expr, schema: Schema): boolean {
  const cols: ColumnExpr[] = []
  collectColumns(e, cols)
  for (const c of cols) {
    try {
      resolveColumn(schema, c.table, c.name)
    } catch {
      return false
    }
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
    case 'literal':
    case 'column':
    case 'star':
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
      if (e.name === 'AVG') return 'REAL'
      if (['SUM', 'MIN', 'MAX', 'ABS', 'ROUND', 'SQRT', 'CEIL', 'FLOOR', 'POW', 'MOD'].includes(e.name))
        return 'REAL'
      if (['UPPER', 'LOWER', 'TRIM', 'CONCAT', 'SUBSTR', 'REPLACE', 'TYPEOF'].includes(e.name)) return 'TEXT'
      if (e.name === 'LENGTH') return 'INTEGER'
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
      return 'BOOLEAN'
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
    if (!leftKey && part.kind === 'binary' && part.op === '=') {
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
export function planSelect(stmt: SelectStmt, db: Database): Operator {
  const wherePreds = conjuncts(stmt.where)
  const consumed = new Set<Expr>()

  if (!stmt.from) {
    // SELECT without FROM — evaluate a single synthetic row of constants.
    return planConstantSelect(stmt)
  }

  // --- base relation --------------------------------------------------------
  const baseTable = db.getTable(stmt.from.table)
  const baseAlias = stmt.from.alias ?? baseTable.name
  let schema: Schema = tableSchema(baseTable, baseAlias)

  let op: Operator
  const baseApplicable = wherePreds.filter((p) => !consumed.has(p) && resolvableIn(p, schema))
  const idx = tryIndexScan(baseTable, schema, baseApplicable)
  if (idx) {
    op = idx.op
    idx.consumed.forEach((p) => consumed.add(p))
  } else {
    op = new SeqScan(baseTable, schema)
  }
  op = applyPushdown(op, schema, wherePreds, consumed)

  // --- joins ----------------------------------------------------------------
  for (const join of stmt.joins) {
    const rt = db.getTable(join.table)
    const rAlias = join.alias ?? rt.name
    const rSchema = tableSchema(rt, rAlias)
    // Push WHERE predicates that reference only the right table onto its scan.
    let rightOp: Operator = new SeqScan(rt, rSchema)
    rightOp = applyPushdown(rightOp, rSchema, wherePreds, consumed)

    const combined: Schema = [...schema, ...rSchema]
    if (join.type === 'CROSS' || !join.on) {
      op = new NestedLoopJoin(op, rightOp, null, 'CROSS', combined)
    } else {
      const equi = extractEquiJoin(join.on, schema, rSchema)
      if (equi && equi.residual.length === 0) {
        op = new HashJoin(op, rightOp, equi.leftKey, equi.rightKey, join.type === 'LEFT' ? 'LEFT' : 'INNER', combined)
      } else if (equi && join.type === 'INNER') {
        op = new HashJoin(op, rightOp, equi.leftKey, equi.rightKey, 'INNER', combined)
        const resid = andAll(equi.residual)!
        op = new Filter(op, compileExpr(resid, { resolve: (t, n) => resolveColumn(combined, t, n) }), exprLabel(resid))
      } else {
        const pred = compileExpr(join.on, { resolve: (t, n) => resolveColumn(combined, t, n) })
        op = new NestedLoopJoin(op, rightOp, pred, join.type === 'LEFT' ? 'LEFT' : 'INNER', combined)
      }
    }
    schema = combined
  }

  // Any remaining WHERE predicates (multi-table) apply now.
  op = applyPushdown(op, schema, wherePreds, consumed)

  // --- aggregation ----------------------------------------------------------
  const aggMap = new Map<string, Expr>()
  for (const item of stmt.columns) findAggregates(item.expr, aggMap)
  if (stmt.having) findAggregates(stmt.having, aggMap)
  for (const o of stmt.orderBy) findAggregates(o.expr, aggMap)
  const grouped = stmt.groupBy.length > 0 || aggMap.size > 0

  let outCtx: CompileCtx
  if (grouped) {
    const preCtx: CompileCtx = { resolve: (t, n) => resolveColumn(schema, t, n) }
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

    outCtx = {
      resolve: (t, n) => {
        // A bare column is only valid post-grouping if it's a grouping key.
        const k = exprKey({ kind: 'column', table: t, name: n })
        const slot = groupKeyMap.get(k)
        if (slot !== undefined) return slot
        throw new SqlError(
          `column "${t ? `${t}.${n}` : n}" must appear in GROUP BY or be used in an aggregate`,
          'bind',
        )
      },
      lookup: (e) => {
        const gk = groupKeyMap.get(exprKey(e))
        if (gk !== undefined) return gk
        const ak = aggSlot.get(exprKey(e))
        if (ak !== undefined) return ak
        return undefined
      },
    }
    schema = aggSchema
  } else {
    outCtx = { resolve: (t, n) => resolveColumn(schema, t, n) }
  }

  // --- HAVING ---------------------------------------------------------------
  if (stmt.having) {
    op = new Filter(op, compileExpr(stmt.having, outCtx), `HAVING ${exprLabel(stmt.having)}`)
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
        projExprs.push({ kind: 'column', table: b.table || undefined, name: b.name })
        projLabels.push(b.name)
        projTypes.push(b.type)
      }
      continue
    }
    projExprs.push(item.expr)
    const label = item.alias ?? exprLabel(item.expr)
    projLabels.push(label)
    projTypes.push(inferType(item.expr, schema, outCtx))
    if (item.alias) aliasMap.set(item.alias.toLowerCase(), item.expr)
  }
  if (projExprs.length === 0) throw new SqlError('SELECT requires at least one column', 'bind')

  // --- ORDER BY (before projection, with alias substitution) ----------------
  if (stmt.orderBy.length > 0) {
    const keys: SortKey[] = stmt.orderBy.map((o) => {
      let e = o.expr
      if (e.kind === 'column' && !e.table && aliasMap.has(e.name.toLowerCase())) {
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
  if (stmt.limit !== undefined) op = new Limit(op, stmt.limit, stmt.offset ?? 0)

  return op
}

// SELECT <exprs> with no FROM clause — a one-row constant projection.
function planConstantSelect(stmt: SelectStmt): Operator {
  const ctx: CompileCtx = {
    resolve: () => {
      throw new SqlError('column reference requires a FROM clause', 'bind')
    },
  }
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

function applyPushdown(op: Operator, schema: Schema, preds: Expr[], consumed: Set<Expr>): Operator {
  const applicable = preds.filter((p) => !consumed.has(p) && resolvableIn(p, schema))
  if (applicable.length === 0) return op
  applicable.forEach((p) => consumed.add(p))
  const combined = andAll(applicable)!
  const pred = compileExpr(combined, { resolve: (t, n) => resolveColumn(schema, t, n) })
  return new Filter(op, pred, exprLabel(combined))
}

// `Binding` re-exported so the engine can describe result columns.
export type { Binding }
