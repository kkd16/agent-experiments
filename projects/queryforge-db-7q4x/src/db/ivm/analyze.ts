// Eligibility analysis for incrementally-maintained materialized views.
//
// Incremental maintenance is exact only for a well-defined subset of SQL — the
// "SPJ-A" core (Select–Project–Join–Aggregate) where every operator is a linear
// (or, for joins of distinct relations, bilinear) map over Z-sets. This module
// is the gate: it walks a parsed SELECT and either returns the structural facts
// the dataflow builder needs, or throws a precise `SqlError` explaining exactly
// which feature put the query outside the maintainable subset.
//
// The deliberate restrictions (each chosen so the incremental math stays exact):
//   • a single SELECT — no UNION/INTERSECT/EXCEPT, no CTEs, no set-ops tail;
//   • FROM/JOIN over *base tables only*, each referenced at most once (no
//     self-joins — that would need the bilinear cross-term), INNER/CROSS only;
//   • no correlated machinery in predicates: no subqueries, EXISTS, IN (SELECT),
//     quantified comparisons or window functions;
//   • no LIMIT/OFFSET (top-N is not a linear map);
//   • aggregation, when present, groups by plain columns and projects only those
//     grouping columns plus aggregates drawn from the byte-exact set
//     (COUNT, MIN, MAX, and SUM/AVG over INTEGER) — see `parseAggregate`.

import { SqlError } from '../types'
import { isAggregate, type Expr, type SelectStmt, type SelectItem, type FuncExpr } from '../ast'
import type { Schema } from '../schema'

/** A base relation referenced by the view (resolved to its catalog name + alias). */
export interface IvmRelation {
  /** The catalog table name as written. */
  table: string
  /** The alias the rest of the query refers to it by (defaults to the table name). */
  alias: string
}

/** One aggregate output column, normalized to the maintainable kinds. */
export interface IvmAggregate {
  func: 'COUNT_STAR' | 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX'
  /** The single column argument (absent for COUNT(*)). */
  arg?: Expr
}

/** One output column of an aggregated view: either a grouping column (an index
 *  into the GROUP BY list) or an aggregate. */
export type GroupedOutput =
  | { kind: 'key'; keyIndex: number; label: string }
  | { kind: 'agg'; agg: IvmAggregate; label: string }

export type IvmShape =
  | { mode: 'bag'; distinct: boolean }
  | { mode: 'grouped'; groupBy: Expr[]; outputs: GroupedOutput[] }

export interface IvmAnalysis {
  relations: IvmRelation[]
  shape: IvmShape
}

function reject(reason: string): never {
  throw new SqlError(
    `this query cannot back an incremental MATERIALIZED VIEW — ${reason}. ` +
      `Supported: single-level SELECT … FROM base-tables [INNER/CROSS JOIN …] [WHERE …] ` +
      `[GROUP BY cols] with COUNT/SUM/AVG(integer)/MIN/MAX aggregates.`,
    'plan',
  )
}

/** Collect every column reference inside an expression (recursively), so the
 *  join planner can decide at which depth a predicate becomes evaluable. Also
 *  doubles as the rejection point for any non-SPJ-A expression node. */
export function collectColumns(e: Expr, out: { table?: string; name: string }[]): void {
  switch (e.kind) {
    case 'literal':
      return
    case 'column':
      out.push({ table: e.table, name: e.name })
      return
    case 'star':
      return
    case 'unary':
      collectColumns(e.expr, out)
      return
    case 'binary':
      collectColumns(e.left, out)
      collectColumns(e.right, out)
      return
    case 'between':
      collectColumns(e.expr, out)
      collectColumns(e.lo, out)
      collectColumns(e.hi, out)
      return
    case 'in':
      collectColumns(e.expr, out)
      for (const x of e.list) collectColumns(x, out)
      return
    case 'like':
      collectColumns(e.expr, out)
      collectColumns(e.pattern, out)
      return
    case 'isnull':
      collectColumns(e.expr, out)
      return
    case 'case':
      if (e.operand) collectColumns(e.operand, out)
      for (const w of e.whens) {
        collectColumns(w.when, out)
        collectColumns(w.then, out)
      }
      if (e.else) collectColumns(e.else, out)
      return
    case 'cast':
      collectColumns(e.expr, out)
      return
    case 'func':
      for (const a of e.args) collectColumns(a, out)
      return
    case 'array':
      for (const x of e.elements) collectColumns(x, out)
      return
    case 'subscript':
      collectColumns(e.base, out)
      if (e.index) collectColumns(e.index, out)
      if (e.upper) collectColumns(e.upper, out)
      return
    case 'quantified_array':
      collectColumns(e.expr, out)
      collectColumns(e.array, out)
      return
    // The remaining node kinds are correlation/windowing machinery the analyzer
    // forbids in a maintainable view; reaching them means the predicate slipped
    // past `assertScalar`, so fail loudly rather than silently miss a column.
    case 'subquery':
    case 'exists':
    case 'in_subquery':
    case 'quantified':
    case 'window':
      reject('a predicate or expression uses a subquery or window function')
  }
}

/** Reject any expression that isn't a pure scalar (no aggregates, windows,
 *  subqueries) — used for WHERE/ON predicates and bag-mode projections. */
function assertScalar(e: Expr, where: string): void {
  walkAssertScalar(e, where)
}

function walkAssertScalar(e: Expr, where: string): void {
  switch (e.kind) {
    case 'subquery':
    case 'exists':
    case 'in_subquery':
    case 'quantified':
      reject(`a subquery in ${where}`)
      break
    case 'window':
      reject(`a window function in ${where}`)
      break
    case 'func':
      if (isAggregate(e.name)) reject(`an aggregate in ${where}`)
      for (const a of e.args) walkAssertScalar(a, where)
      break
    case 'literal':
    case 'column':
    case 'star':
      break
    case 'unary':
      walkAssertScalar(e.expr, where)
      break
    case 'binary':
      walkAssertScalar(e.left, where)
      walkAssertScalar(e.right, where)
      break
    case 'between':
      walkAssertScalar(e.expr, where)
      walkAssertScalar(e.lo, where)
      walkAssertScalar(e.hi, where)
      break
    case 'in':
      walkAssertScalar(e.expr, where)
      for (const x of e.list) walkAssertScalar(x, where)
      break
    case 'like':
      walkAssertScalar(e.expr, where)
      walkAssertScalar(e.pattern, where)
      break
    case 'isnull':
      walkAssertScalar(e.expr, where)
      break
    case 'case':
      if (e.operand) walkAssertScalar(e.operand, where)
      for (const w of e.whens) {
        walkAssertScalar(w.when, where)
        walkAssertScalar(w.then, where)
      }
      if (e.else) walkAssertScalar(e.else, where)
      break
    case 'cast':
      walkAssertScalar(e.expr, where)
      break
    case 'array':
      for (const x of e.elements) walkAssertScalar(x, where)
      break
    case 'subscript':
      walkAssertScalar(e.base, where)
      if (e.index) walkAssertScalar(e.index, where)
      if (e.upper) walkAssertScalar(e.upper, where)
      break
    case 'quantified_array':
      walkAssertScalar(e.expr, where)
      walkAssertScalar(e.array, where)
      break
  }
}

/** Does any output column contain an aggregate call? (Determines bag vs grouped.) */
function hasAggregate(items: SelectItem[]): boolean {
  let found = false
  const scan = (e: Expr): void => {
    if (found) return
    if (e.kind === 'func' && isAggregate(e.name)) {
      found = true
      return
    }
    const kids: Expr[] = []
    collectChildExprs(e, kids)
    for (const k of kids) scan(k)
  }
  for (const it of items) scan(it.expr)
  return found
}

/** Immediate sub-expressions of a node (shallow), for generic scanning. */
function collectChildExprs(e: Expr, out: Expr[]): void {
  switch (e.kind) {
    case 'unary':
    case 'isnull':
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
    case 'case':
      if (e.operand) out.push(e.operand)
      for (const w of e.whens) out.push(w.when, w.then)
      if (e.else) out.push(e.else)
      break
    case 'func':
      out.push(...e.args)
      break
    case 'array':
      out.push(...e.elements)
      break
    case 'subscript':
      out.push(e.base)
      if (e.index) out.push(e.index)
      if (e.upper) out.push(e.upper)
      break
    case 'quantified_array':
      out.push(e.expr, e.array)
      break
    default:
      break
  }
}

/** Normalize a `FuncExpr` aggregate to a maintainable `IvmAggregate`, or reject. */
function parseAggregate(f: FuncExpr): IvmAggregate {
  const name = f.name.toUpperCase()
  if (f.distinct) reject(`a DISTINCT aggregate (${name}) is not yet incrementally maintained`)
  if (f.filter) reject(`an aggregate FILTER clause is not yet incrementally maintained`)
  if (f.withinGroup) reject(`an ordered-set aggregate (${name}) is not yet incrementally maintained`)
  if (name === 'COUNT') {
    if (f.star) return { func: 'COUNT_STAR' }
    if (f.args.length !== 1) reject('COUNT takes exactly one argument (or *)')
    return { func: 'COUNT', arg: f.args[0] }
  }
  if (name === 'SUM' || name === 'AVG' || name === 'MIN' || name === 'MAX') {
    if (f.args.length !== 1) reject(`${name} takes exactly one argument`)
    return { func: name, arg: f.args[0] }
  }
  reject(`the aggregate ${name}() is not in the incrementally-maintained set (COUNT/SUM/AVG/MIN/MAX)`)
}

/** Full structural analysis of a candidate materialized-view query. Throws a
 *  descriptive `SqlError` for anything outside the maintainable subset. */
export function analyzeView(select: SelectStmt): IvmAnalysis {
  if (select.kind !== 'select') reject('only SELECT statements can define a materialized view')
  if (select.setOps && select.setOps.length) reject('a set operation (UNION/INTERSECT/EXCEPT)')
  if (select.ctes && select.ctes.length) reject('a WITH clause (CTE)')
  if (select.windows && select.windows.length) reject('a WINDOW clause')
  if (select.qualify) reject('a QUALIFY clause')
  if (select.limit !== undefined || select.offset !== undefined) reject('LIMIT/OFFSET (a top-N is not linear)')
  if (select.having) reject('a HAVING clause is not yet supported')
  if (select.groupingSets) reject('GROUPING SETS / ROLLUP / CUBE')
  if (!select.from || !select.from.table) reject('the FROM clause must be a base table (no subqueries or table functions)')

  // Relations: FROM table, then each join. Base tables only, INNER/CROSS only,
  // each table referenced at most once.
  const relations: IvmRelation[] = []
  const seen = new Set<string>()
  const addRel = (table: string | undefined, alias: string | undefined): void => {
    if (!table) reject('a derived table / subquery / table function in FROM')
    const lc = table.toLowerCase()
    if (seen.has(lc)) reject(`the table "${table}" appears more than once (self-joins are not supported)`)
    seen.add(lc)
    relations.push({ table, alias: alias ?? table })
  }
  addRel(select.from.table, select.from.alias)
  for (const j of select.joins) {
    if (j.type !== 'INNER' && j.type !== 'CROSS') reject(`a ${j.type} JOIN (only INNER and CROSS are maintainable)`)
    if (j.lateral) reject('a LATERAL join')
    if (!j.table) reject('a derived table / subquery / table function in a JOIN')
    addRel(j.table, j.alias)
    if (j.on) assertScalar(j.on, 'a JOIN … ON predicate')
  }
  if (select.where) assertScalar(select.where, 'the WHERE clause')

  // Shape: grouped (GROUP BY and/or aggregates) vs a plain bag/distinct projection.
  const grouped = (select.groupBy && select.groupBy.length > 0) || hasAggregate(select.columns)
  if (!grouped) {
    for (const it of select.columns) {
      if (it.expr.kind !== 'star') assertScalar(it.expr, 'the SELECT list')
    }
    return { relations, shape: { mode: 'bag', distinct: select.distinct } }
  }

  // Grouped: GROUP BY must be plain columns; each output is a grouping column or
  // an aggregate over a column.
  const groupBy = select.groupBy
  for (const g of groupBy) {
    if (g.kind !== 'column') reject('GROUP BY must list plain columns for an incremental view')
  }
  const keyOf = (e: Expr): number => {
    if (e.kind !== 'column') return -1
    return groupBy.findIndex(
      (g) => g.kind === 'column' && g.name.toLowerCase() === e.name.toLowerCase() && (e.table ?? g.table ?? '').toLowerCase() === (g.table ?? e.table ?? '').toLowerCase(),
    )
  }
  const outputs: GroupedOutput[] = []
  select.columns.forEach((it, i) => {
    const label = it.alias ?? defaultLabel(it, i)
    if (it.expr.kind === 'func' && isAggregate(it.expr.name)) {
      outputs.push({ kind: 'agg', agg: parseAggregate(it.expr), label })
      return
    }
    if (it.expr.kind === 'column') {
      const ki = keyOf(it.expr)
      if (ki >= 0) {
        outputs.push({ kind: 'key', keyIndex: ki, label })
        return
      }
      reject(`column "${it.expr.name}" is neither grouped nor aggregated`)
    }
    reject('a grouped view may only project its GROUP BY columns and aggregates')
  })
  return { relations, shape: { mode: 'grouped', groupBy, outputs } }
}

/** A reasonable default output-column label when none was aliased. */
function defaultLabel(it: SelectItem, i: number): string {
  if (it.expr.kind === 'column') return it.expr.name
  if (it.expr.kind === 'func') return it.expr.name.toLowerCase()
  return `col${i + 1}`
}

export type { Schema }
