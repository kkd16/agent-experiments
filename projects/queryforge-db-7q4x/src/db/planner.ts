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

import { SqlError, compareValues, hashKey, valueTypeOf, valuesEqual, type ColumnType, type SqlValue } from './types'
import { compileExpr, exprKey, TABLE_FUNCTIONS, userFunctionReturnType, type CompileCtx, type Evaluator, type OuterScope } from './eval'
import { resolveColumn, type Binding, type Schema } from './schema'
import {
  isAggregate,
  ORDERED_SET_AGGREGATES,
  type ColumnDef,
  type CteDef,
  type Expr,
  type ExistsExpr,
  type FromItem,
  type InSubqueryExpr,
  type JoinClause,
  type SelectItem,
  type SelectStmt,
  type ColumnExpr,
  type QuantifiedExpr,
  type SetOp,
  type SubqueryExpr,
  type WindowFrame,
  type WindowFuncExpr,
  type WindowSpec,
  type FrameBound,
} from './ast'
import { Database, Table, arrayGinKey, type IndexHandle, type Row } from './catalog'
import { isArray } from './array'
import type { IndexKey } from './storage/btree'
import { eqSelectivity, nullSelectivity, rangeSelectivity, type ColumnStat } from './stats'
import { asTsQuery } from './fts'
import {
  BitmapAnd,
  BitmapOr,
  Distinct,
  Filter,
  GinScan,
  ArrayGinScan,
  HashJoin,
  HashSemiJoin,
  IndexOnlyScan,
  IndexScan,
  LateralJoin,
  Limit,
  MergeJoin,
  NestedLoopJoin,
  Project,
  SeqScan,
  SetOpExec,
  Sort,
  type BitmapInput,
  type Operator,
  type RangeBound,
  type SortKey,
} from './operators'
import { HashAggregate, type AggName, type AggSpec } from './aggregate'
import { WindowExec, type FrameExec, type WindowSpecExec } from './window'

// ---------------------------------------------------------------------------
// Planning environment: the database plus an overlay of named relations
// (CTEs and derived tables) and a stack of enclosing scopes for correlated
// subqueries.
export interface PlanEnv {
  db: Database
  relations: Map<string, Table>
  outer: OuterScope[]
  /** Names of views currently being materialized, to break definition cycles. */
  viewTrail?: Set<string>
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
    case 'quantified_array':
      collectColumns(e.expr, out)
      collectColumns(e.array, out)
      break
    case 'array':
      e.elements.forEach((x) => collectColumns(x, out))
      break
    case 'subscript':
      collectColumns(e.base, out)
      if (e.index) collectColumns(e.index, out)
      if (e.upper) collectColumns(e.upper, out)
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
    case 'quantified_array':
      return containsSubquery(e.expr) || containsSubquery(e.array)
    case 'array':
      return e.elements.some(containsSubquery)
    case 'subscript':
      return (
        containsSubquery(e.base) ||
        (e.index ? containsSubquery(e.index) : false) ||
        (e.upper ? containsSubquery(e.upper) : false)
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
    case 'quantified_array':
      out.push(e.expr, e.array)
      break
    case 'array':
      out.push(...e.elements)
      break
    case 'subscript':
      out.push(e.base)
      if (e.index) out.push(e.index)
      if (e.upper) out.push(e.upper)
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

export function inferType(e: Expr, schema: Schema, ctx: CompileCtx): ColumnType {
  switch (e.kind) {
    case 'column':
      try {
        return schema[resolveColumn(schema, e.table, e.name)].type
      } catch {
        return 'TEXT'
      }
    case 'literal': {
      const vt = valueTypeOf(e.value)
      return vt === 'NULL' ? 'TEXT' : vt
    }
    case 'cast':
      return e.type
    case 'func':
      if (e.name === 'COUNT' || e.name === 'GROUPING' || e.name === 'GROUPING_ID') return 'INTEGER'
      // Ordered-set aggregates that return one of the ordered values keep that
      // value's type; PERCENTILE_CONT interpolates and is always REAL.
      if (e.name === 'PERCENTILE_DISC' || e.name === 'MODE') {
        return e.withinGroup && e.withinGroup[0] ? inferType(e.withinGroup[0].expr, schema, ctx) : 'TEXT'
      }
      if (['LENGTH', 'INSTR', 'ASCII', 'SIGN', 'DATEDIFF'].includes(e.name)) return 'INTEGER'
      if (['DATE_PART', 'EXTRACT'].includes(e.name)) return 'REAL'
      if (['CURRENT_DATE', 'TO_DATE', 'MAKE_DATE'].includes(e.name)) return 'DATE'
      if (['CURRENT_TIME', 'TO_TIME', 'MAKE_TIME'].includes(e.name)) return 'TIME'
      if (
        ['CURRENT_TIMESTAMP', 'CLOCK_TIMESTAMP', 'TO_TIMESTAMP', 'MAKE_TIMESTAMP', 'DATE_TRUNC'].includes(e.name)
      )
        return 'TIMESTAMP'
      if (['AGE', 'MAKE_INTERVAL', 'TO_INTERVAL', 'JUSTIFY_HOURS'].includes(e.name)) return 'INTERVAL'
      if (
        [
          'TO_JSON', 'JSON', 'JSON_BUILD_OBJECT', 'JSON_BUILD_ARRAY', 'JSON_OBJECT_KEYS',
          'JSON_EXTRACT_PATH', 'JSON_STRIP_NULLS', 'JSONB_SET', 'JSON_SET', 'JSON_AGG', 'JSON_OBJECT_AGG',
        ].includes(e.name)
      )
        return 'JSON'
      if (['JSON_TYPEOF', 'JSON_EXTRACT_PATH_TEXT', 'JSON_PRETTY'].includes(e.name)) return 'TEXT'
      if (e.name === 'JSON_ARRAY_LENGTH') return 'INTEGER'
      if (['JSON_VALID', 'JSON_CONTAINS', 'TS_MATCH'].includes(e.name)) return 'BOOLEAN'
      // Array functions.
      if (
        [
          'ARRAY_AGG', 'ARRAY_APPEND', 'ARRAY_PREPEND', 'ARRAY_CAT', 'ARRAY_REMOVE', 'ARRAY_REPLACE',
          'ARRAY_POSITIONS', 'STRING_TO_ARRAY', 'TRIM_ARRAY',
        ].includes(e.name)
      )
        return 'ARRAY'
      if (
        ['ARRAY_LENGTH', 'CARDINALITY', 'ARRAY_NDIMS', 'ARRAY_UPPER', 'ARRAY_LOWER', 'ARRAY_POSITION'].includes(e.name)
      )
        return 'INTEGER'
      if (['ARRAY_DIMS', 'ARRAY_TO_STRING'].includes(e.name)) return 'TEXT'
      // Full-text search result types.
      if (['TO_TSVECTOR', 'SETWEIGHT', 'STRIP'].includes(e.name)) return 'TSVECTOR'
      if (['TO_TSQUERY', 'PLAINTO_TSQUERY', 'PHRASETO_TSQUERY', 'WEBSEARCH_TO_TSQUERY', 'TSQUERY_AND', 'TSQUERY_OR', 'TSQUERY_NOT'].includes(e.name)) return 'TSQUERY'
      if (['TS_RANK', 'TS_RANK_CD'].includes(e.name)) return 'REAL'
      if (['NUMNODE', 'TSVECTOR_LENGTH'].includes(e.name)) return 'INTEGER'
      if (['TS_HEADLINE', 'QUERYTREE'].includes(e.name)) return 'TEXT'
      if (
        [
          'SUM', 'MIN', 'MAX', 'AVG', 'ABS', 'ROUND', 'SQRT', 'CEIL', 'CEILING', 'FLOOR', 'TRUNC',
          'POW', 'POWER', 'MOD', 'EXP', 'LN', 'LOG', 'LOG10', 'PI', 'SIN', 'COS', 'TAN', 'ASIN',
          'ACOS', 'ATAN', 'ATAN2', 'RADIANS', 'DEGREES', 'RANDOM', 'JULIANDAY',
          'STDDEV', 'STDDEV_SAMP', 'STDDEV_POP', 'VARIANCE', 'VAR_SAMP', 'VAR_POP', 'MEDIAN',
          'PERCENTILE_CONT',
        ].includes(e.name)
      )
        return 'REAL'
      if (
        [
          'UPPER', 'LOWER', 'INITCAP', 'TRIM', 'LTRIM', 'RTRIM', 'LPAD', 'RPAD', 'REPEAT', 'REVERSE',
          'LEFT', 'RIGHT', 'CONCAT', 'CONCAT_WS', 'SUBSTR', 'REPLACE', 'CHR', 'TYPEOF', 'NOW', 'DATE',
          'DATETIME', 'STRFTIME', 'DATE_ADD', 'TO_CHAR', 'STRING_AGG', 'GROUP_CONCAT',
        ].includes(e.name)
      )
        return 'TEXT'
      // A user-defined function carries its declared return type.
      return userFunctionReturnType(e.name) ?? 'TEXT'
    case 'binary':
      if (['=', '<>', '<', '<=', '>', '>=', 'AND', 'OR', '@>', '<@', '?', '@@', '&&'].includes(e.op)) return 'BOOLEAN'
      if (e.op === '->' || e.op === '#>') return 'JSON'
      if (e.op === '->>' || e.op === '#>>') return 'TEXT'
      if (e.op === '||') {
        const lt = inferType(e.left, schema, ctx)
        const rt = inferType(e.right, schema, ctx)
        if (lt === 'ARRAY' || rt === 'ARRAY') return 'ARRAY'
        if (lt === 'JSON' || lt === 'TSVECTOR' || lt === 'TSQUERY') return lt
        return 'TEXT'
      }
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
    case 'quantified_array':
      return 'BOOLEAN'
    case 'array':
      return 'ARRAY'
    case 'subscript':
      // A slice yields an array; a single subscript yields one element (whose
      // exact type we don't track positionally — TEXT is a safe display default).
      return e.slice ? 'ARRAY' : 'TEXT'
    case 'window':
      if (['ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'COUNT'].includes(e.name)) return 'INTEGER'
      if (['PERCENT_RANK', 'CUME_DIST', 'AVG'].includes(e.name)) return 'REAL'
      if (e.name === 'SUM') return 'REAL'
      if (
        [
          'STDDEV', 'STDDEV_SAMP', 'STDDEV_POP', 'VARIANCE', 'VAR_SAMP', 'VAR_POP',
          'PERCENTILE_CONT', 'MEDIAN',
        ].includes(e.name)
      )
        return 'REAL'
      // Ordered-set windows that return one of the ordered values keep its type.
      if (e.name === 'PERCENTILE_DISC' || e.name === 'MODE') {
        return e.withinGroup && e.withinGroup[0] ? inferType(e.withinGroup[0].expr, schema, ctx) : 'TEXT'
      }
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

// --- statistics-based selectivity ------------------------------------------
// A map from relation alias (lower-case) to the backing Table, so the optimizer
// can look up column statistics for predicates over base/derived relations.
type StatCtx = Map<string, Table>

const DEFAULT_SEL = 0.3

function statForColumn(sc: StatCtx, col: ColumnExpr): { stat: ColumnStat; rowCount: number } | null {
  for (const [alias, t] of sc) {
    if (col.table && col.table.toLowerCase() !== alias) continue
    if (t.columnIndex(col.name) < 0) continue
    const stat = t.ensureStats().columns.get(col.name.toLowerCase())
    if (stat) return { stat, rowCount: t.rowCount() }
  }
  return null
}

const FLIP = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '=': '=' } as const

/** Split a binary comparison into (column, op, const value) if it is sargable. */
function asColumnCompare(p: Expr): { col: ColumnExpr; op: '=' | '<' | '<=' | '>' | '>='; value: SqlValue } | null {
  if (p.kind !== 'binary') return null
  if (!['=', '<', '<=', '>', '>='].includes(p.op)) return null
  if (p.left.kind === 'column' && evalConst(p.right) !== undefined) {
    return { col: p.left, op: p.op as '=', value: evalConst(p.right)! }
  }
  if (p.right.kind === 'column' && evalConst(p.left) !== undefined) {
    return { col: p.right, op: FLIP[p.op as '='], value: evalConst(p.left)! }
  }
  return null
}

/** Estimate the fraction of rows a single predicate keeps (0..1). */
function predSelectivity(p: Expr, sc: StatCtx): number {
  switch (p.kind) {
    case 'binary': {
      if (p.op === 'AND') return predSelectivity(p.left, sc) * predSelectivity(p.right, sc)
      if (p.op === 'OR') {
        const a = predSelectivity(p.left, sc)
        const b = predSelectivity(p.right, sc)
        return Math.min(1, a + b - a * b)
      }
      const cmp = asColumnCompare(p)
      if (cmp) {
        const info = statForColumn(sc, cmp.col)
        if (!info) return cmp.op === '=' ? 0.1 : DEFAULT_SEL
        if (cmp.op === '=') return eqSelectivity(info.stat, cmp.value)
        if (cmp.op === '<') return rangeSelectivity(info.stat, null, true, cmp.value, false)
        if (cmp.op === '<=') return rangeSelectivity(info.stat, null, true, cmp.value, true)
        if (cmp.op === '>') return rangeSelectivity(info.stat, cmp.value, false, null, true)
        return rangeSelectivity(info.stat, cmp.value, true, null, true)
      }
      return DEFAULT_SEL
    }
    case 'between': {
      if (p.expr.kind === 'column') {
        const info = statForColumn(sc, p.expr)
        const lo = evalConst(p.lo)
        const hi = evalConst(p.hi)
        if (info && lo !== undefined && hi !== undefined) {
          const s = rangeSelectivity(info.stat, lo, true, hi, true)
          return p.negated ? 1 - s : s
        }
      }
      return p.negated ? 0.7 : 0.25
    }
    case 'isnull': {
      if (p.expr.kind === 'column') {
        const info = statForColumn(sc, p.expr)
        if (info) return nullSelectivity(info.stat, p.negated)
      }
      return p.negated ? 0.9 : 0.1
    }
    case 'in': {
      if (p.expr.kind === 'column') {
        const info = statForColumn(sc, p.expr)
        if (info) {
          let s = 0
          for (const item of p.list) {
            const v = evalConst(item)
            s += v === undefined ? 1 / Math.max(1, info.stat.ndistinct) : eqSelectivity(info.stat, v)
          }
          s = Math.min(1, s)
          return p.negated ? 1 - s : s
        }
      }
      return p.negated ? 0.7 : Math.min(0.5, 0.1 * p.list.length)
    }
    case 'like':
      return p.negated ? 0.75 : 0.25
    case 'unary':
      if (p.op === 'NOT') return Math.max(0, 1 - predSelectivity(p.expr, sc))
      return DEFAULT_SEL
    default:
      return DEFAULT_SEL
  }
}

/** Combined selectivity of a conjunction of predicates (independence assumed). */
function combinedSelectivity(preds: Expr[], sc: StatCtx): number {
  let s = 1
  for (const p of preds) s *= predSelectivity(p, sc)
  return Math.max(0, Math.min(1, s))
}

// --- index selection --------------------------------------------------------
interface IndexPlan {
  op: Operator
  consumed: Set<Expr>
}

interface Sarg {
  pred: Expr
  op: '=' | '<' | '<=' | '>' | '>='
  value: SqlValue
}

// Match an index against the available sargs: consume a leading run of equality
// columns, then optionally one trailing range column. Returns the matched key
// bounds and consumed predicates, or null if the leading column isn't covered.
function matchIndex(index: IndexHandle, byColumn: Map<string, Sarg[]>): {
  lo: RangeBound
  hi: RangeBound
  consumed: Set<Expr>
  isEq: boolean
} | null {
  const eqPrefix: SqlValue[] = []
  const consumed = new Set<Expr>()
  let rangeLo: { value: SqlValue; inclusive: boolean } | null = null
  let rangeHi: { value: SqlValue; inclusive: boolean } | null = null
  let usedRange = false
  for (const colName of index.meta.columns) {
    const sargs = byColumn.get(colName.toLowerCase())
    if (!sargs) break
    const eq = sargs.find((s) => s.op === '=')
    if (eq) {
      eqPrefix.push(eq.value)
      consumed.add(eq.pred)
      continue
    }
    // No equality on this column — use it as the trailing range, then stop.
    for (const s of sargs) {
      if (s.op === '>') rangeLo = { value: s.value, inclusive: false }
      else if (s.op === '>=') rangeLo = { value: s.value, inclusive: true }
      else if (s.op === '<') rangeHi = { value: s.value, inclusive: false }
      else if (s.op === '<=') rangeHi = { value: s.value, inclusive: true }
      consumed.add(s.pred)
      usedRange = true
    }
    break
  }
  if (eqPrefix.length === 0 && !usedRange) return null

  let lo: RangeBound
  let hi: RangeBound
  if (usedRange) {
    const loKey: IndexKey = rangeLo ? [...eqPrefix, rangeLo.value] : [...eqPrefix]
    const hiKey: IndexKey = rangeHi ? [...eqPrefix, rangeHi.value] : [...eqPrefix]
    lo = { key: loKey, inclusive: rangeLo ? rangeLo.inclusive : true }
    hi = { key: hiKey, inclusive: rangeHi ? rangeHi.inclusive : true }
  } else {
    // Pure equality-prefix scan: an exact prefix match on the index.
    lo = { key: [...eqPrefix], inclusive: true }
    hi = { key: [...eqPrefix], inclusive: true }
  }
  return { lo, hi, consumed, isEq: !usedRange }
}

function tryIndexScan(
  table: Table,
  baseSchema: Schema,
  preds: Expr[],
  sc: StatCtx,
  coverCols: Set<string> | null = null,
): IndexPlan | null {
  // Gather sargable comparisons grouped by indexed column name.
  const byColumn = new Map<string, Sarg[]>()
  for (const p of preds) {
    const cmp = asColumnCompare(p)
    if (!cmp) continue
    try {
      resolveColumn(baseSchema, cmp.col.table, cmp.col.name)
    } catch {
      continue
    }
    if (table.columnIndex(cmp.col.name) < 0) continue
    const key = cmp.col.name.toLowerCase()
    const list = byColumn.get(key) ?? []
    list.push({ pred: p, op: cmp.op, value: cmp.value })
    byColumn.set(key, list)
  }
  if (byColumn.size === 0) return null

  // Among all indexes, pick the match that consumes the most predicates
  // (longest usable prefix), preferring an all-equality match.
  let best: { index: IndexHandle; m: NonNullable<ReturnType<typeof matchIndex>> } | null = null
  for (const index of table.allIndexes()) {
    const m = matchIndex(index, byColumn)
    if (!m) continue
    if (
      !best ||
      m.consumed.size > best.m.consumed.size ||
      (m.consumed.size === best.m.consumed.size && m.isEq && !best.m.isEq)
    ) {
      best = { index, m }
    }
  }
  if (!best) return null

  const consumedPreds = [...best.m.consumed]
  const estRows = Math.max(1, Math.round(table.rowCount() * combinedSelectivity(consumedPreds, sc)))

  // Index-only (covering) scan: if every column the query needs from this table
  // is present in the chosen index, answer from the B+Tree and skip the heap.
  if (coverCols && indexCovers(best.index, coverCols)) {
    const alias = baseSchema.length ? baseSchema[0].table : table.name
    const idxSchema: Schema = best.index.meta.columns.map((name) => ({
      table: alias,
      name,
      type: table.columnType(name),
    }))
    return {
      op: new IndexOnlyScan(best.index, idxSchema, best.m.lo, best.m.hi, estRows),
      consumed: best.m.consumed,
    }
  }
  return {
    op: new IndexScan(table, best.index, baseSchema, best.m.lo, best.m.hi, estRows),
    consumed: best.m.consumed,
  }
}

/** Does `index` contain every column named in `cols` (a covering index)? */
function indexCovers(index: IndexHandle, cols: Set<string>): boolean {
  const have = new Set(index.meta.columns.map((c) => c.toLowerCase()))
  for (const c of cols) if (!have.has(c)) return false
  return true
}

// The set of column names a single-table query reads (for covering-index
// detection). Returns ok=false when we can't see every reference — a `SELECT *`,
// or any subquery whose (possibly correlated) columns collectColumns won't walk.
function coveringColumns(stmt: SelectStmt): { names: Set<string>; ok: boolean } {
  const names = new Set<string>()
  const exprs: Expr[] = []
  for (const it of stmt.columns) {
    if (it.expr.kind === 'star') return { names, ok: false }
    exprs.push(it.expr)
  }
  if (stmt.where) exprs.push(stmt.where)
  exprs.push(...stmt.groupBy)
  if (stmt.having) exprs.push(stmt.having)
  for (const o of stmt.orderBy) exprs.push(o.expr)
  for (const ex of exprs) {
    if (containsSubquery(ex)) return { names, ok: false }
    const cols: ColumnExpr[] = []
    collectColumns(ex, cols)
    for (const c of cols) names.add(c.name.toLowerCase())
  }
  return { names, ok: true }
}

// Build a single-column range bound for a sargable comparison (for bitmap scans).
function sargBound(op: '=' | '<' | '<=' | '>' | '>=', value: SqlValue): { lo: RangeBound; hi: RangeBound } {
  switch (op) {
    case '=':
      return { lo: { key: [value], inclusive: true }, hi: { key: [value], inclusive: true } }
    case '>':
      return { lo: { key: [value], inclusive: false }, hi: null }
    case '>=':
      return { lo: { key: [value], inclusive: true }, hi: null }
    case '<':
      return { lo: null, hi: { key: [value], inclusive: false } }
    case '<=':
      return { lo: null, hi: { key: [value], inclusive: true } }
  }
}

// Combine several single-column indexes for a multi-predicate filter: scan each
// index, intersect the row-id bitmaps, then heap-fetch. Used when no single
// (composite) index covers as many predicates as two or more separate ones do.
function tryBitmapAnd(table: Table, baseSchema: Schema, preds: Expr[], sc: StatCtx): IndexPlan | null {
  const inputs: BitmapInput[] = []
  const consumed = new Set<Expr>()
  const usedCols = new Set<string>()
  for (const p of preds) {
    const cmp = asColumnCompare(p)
    if (!cmp) continue
    try {
      resolveColumn(baseSchema, cmp.col.table, cmp.col.name)
    } catch {
      continue
    }
    const col = cmp.col.name.toLowerCase()
    if (usedCols.has(col)) continue
    const idx = table.indexForColumn(cmp.col.name)
    if (!idx) continue
    const { lo, hi } = sargBound(cmp.op, cmp.value)
    inputs.push({ index: idx, lo, hi })
    consumed.add(p)
    usedCols.add(col)
  }
  if (inputs.length < 2) return null
  const estRows = Math.max(1, Math.round(table.rowCount() * combinedSelectivity([...consumed], sc)))
  return { op: new BitmapAnd(table, baseSchema, inputs, estRows), consumed }
}

// Union the row-id sets of a single index across the values of an `IN (…)` list
// (or `a = 1 OR a = 2`) into one bitmap, then heap-fetch. Lets an IN-list use an
// index instead of falling back to a sequential scan + filter.
function tryBitmapOr(table: Table, baseSchema: Schema, preds: Expr[], sc: StatCtx): IndexPlan | null {
  for (const p of preds) {
    if (p.kind !== 'in' || p.negated || p.expr.kind !== 'column') continue
    try {
      resolveColumn(baseSchema, p.expr.table, p.expr.name)
    } catch {
      continue
    }
    const idx = table.indexForColumn(p.expr.name)
    if (!idx) continue
    const values: SqlValue[] = []
    let allConst = true
    for (const item of p.list) {
      const v = evalConst(item)
      if (v === undefined) {
        allConst = false
        break
      }
      values.push(v)
    }
    if (!allConst || values.length === 0) continue
    const inputs: BitmapInput[] = values.map((v) => ({
      index: idx,
      lo: { key: [v], inclusive: true },
      hi: { key: [v], inclusive: true },
    }))
    const estRows = Math.max(1, Math.round(table.rowCount() * combinedSelectivity([p], sc)))
    const label = `${p.expr.name} IN (${values.length} values)`
    return { op: new BitmapOr(table, baseSchema, inputs, estRows, label), consumed: new Set<Expr>([p]) }
  }
  return null
}

/** Evaluate a column-free, subquery-free expression at plan time, or undefined
 *  if it isn't actually constant. Used to extract a `@@` query's tsquery. */
function evalConstFull(e: Expr): SqlValue | undefined {
  if (containsSubquery(e)) return undefined
  let hasColumn = false
  const walk = (x: Expr) => {
    if (x.kind === 'column' || x.kind === 'star') { hasColumn = true; return }
    const kids: Expr[] = []
    collectChildren(x, kids)
    kids.forEach(walk)
  }
  walk(e)
  if (hasColumn) return undefined
  try {
    const fn = compileExpr(e, { resolve: () => { throw new SqlError('not constant', 'plan') } })
    const v = fn([])
    return v === null ? null : v
  } catch {
    return undefined
  }
}

// Use a GIN inverted index for a `col @@ <constant tsquery>` predicate: walk the
// query to a candidate rowset, then recheck `@@` exactly. The match operator is
// symmetric, so `query @@ col` works too.
function tryGinScan(table: Table, baseSchema: Schema, preds: Expr[]): IndexPlan | null {
  for (const p of preds) {
    if (p.kind !== 'binary' || p.op !== '@@') continue
    // Identify the document column side and the (constant) query side.
    let colExpr: Expr | null = null
    let queryExpr: Expr | null = null
    if (p.left.kind === 'column') { colExpr = p.left; queryExpr = p.right }
    else if (p.right.kind === 'column') { colExpr = p.right; queryExpr = p.left }
    if (!colExpr || !queryExpr || colExpr.kind !== 'column') continue
    const gin = table.ginIndexForColumn(colExpr.name)
    if (!gin) continue
    let colIndex: number
    try {
      colIndex = resolveColumn(baseSchema, colExpr.table, colExpr.name)
    } catch {
      continue
    }
    const qVal = evalConstFull(queryExpr)
    if (qVal === undefined) continue
    const query = asTsQuery(qVal)
    if (!query) continue
    // Estimate: most full-text predicates are quite selective.
    const estRows = Math.max(1, Math.round(table.rowCount() * 0.1))
    return { op: new GinScan(table, baseSchema, gin, query, colIndex, estRows), consumed: new Set<Expr>([p]) }
  }
  return null
}

// Use a GIN inverted index over an *array* column for `col @> array`,
// `array <@ col`, `col && array` or `x = ANY(col)`: probe the element posting
// lists (AND for @>, OR for && / = ANY), then recheck the exact predicate.
function tryArrayGinScan(table: Table, baseSchema: Schema, preds: Expr[]): IndexPlan | null {
  for (const p of preds) {
    let colExpr: ColumnExpr | null = null
    let constExpr: Expr | null = null
    let mode: 'and' | 'or' = 'and'
    let single = false // a `= ANY` probes a single search element, not an array
    if (p.kind === 'binary' && (p.op === '@>' || p.op === '<@' || p.op === '&&')) {
      const lc = p.left.kind === 'column' ? (p.left as ColumnExpr) : null
      const rc = p.right.kind === 'column' ? (p.right as ColumnExpr) : null
      if (p.op === '@>') {
        if (lc) { colExpr = lc; constExpr = p.right; mode = 'and' }
      } else if (p.op === '<@') {
        // `const <@ col` ≡ `col @> const`.
        if (rc) { colExpr = rc; constExpr = p.left; mode = 'and' }
      } else {
        // `&&` is symmetric.
        if (lc) { colExpr = lc; constExpr = p.right; mode = 'or' }
        else if (rc) { colExpr = rc; constExpr = p.left; mode = 'or' }
      }
    } else if (p.kind === 'quantified_array' && p.op === '=' && p.quantifier === 'ANY' && p.array.kind === 'column') {
      colExpr = p.array as ColumnExpr
      constExpr = p.expr
      mode = 'or'
      single = true
    }
    if (!colExpr || !constExpr) continue
    let colType: ColumnType
    try {
      colType = table.columnType(colExpr.name)
    } catch {
      continue
    }
    if (colType !== 'ARRAY') continue
    const gin = table.ginIndexForColumn(colExpr.name)
    if (!gin) continue
    const cval = evalConstFull(constExpr)
    if (cval === undefined) continue
    let keys: string[]
    if (single) {
      if (cval === null) continue
      keys = [arrayGinKey(cval)]
    } else {
      if (!isArray(cval)) continue
      keys = []
      for (const x of cval.items) if (x !== null) keys.push(arrayGinKey(x))
    }
    // An empty key set (e.g. `col @> ARRAY[]` — true for every row) isn't safely
    // index-bounded; let the sequential filter handle it.
    if (keys.length === 0) continue
    let recheck: Evaluator
    try {
      recheck = compileExpr(p, { resolve: (t, n) => resolveColumn(baseSchema, t, n) })
    } catch {
      continue
    }
    const label = p.kind === 'binary' ? p.op : '= ANY'
    const estRows = Math.max(1, Math.round(table.rowCount() * 0.1))
    return {
      op: new ArrayGinScan(table, baseSchema, gin, keys, mode, recheck, label, estRows),
      consumed: new Set<Expr>([p]),
    }
  }
  return null
}

// Pick the best index access path: a single (composite) index scan, a bitmap AND
// of several single-column indexes, a bitmap OR over an IN-list, or a GIN scan
// for a full-text `@@` predicate — whichever consumes the most predicates. Ties
// favour the single scan (no heap re-fetch), then the AND, then the OR.
function chooseIndexAccess(
  table: Table,
  schema: Schema,
  preds: Expr[],
  sc: StatCtx,
  coverCols: Set<string> | null = null,
): IndexPlan | null {
  const candidates = [
    tryIndexScan(table, schema, preds, sc, coverCols),
    tryBitmapAnd(table, schema, preds, sc),
    tryBitmapOr(table, schema, preds, sc),
    tryGinScan(table, schema, preds),
    tryArrayGinScan(table, schema, preds),
  ].filter((c): c is IndexPlan => c !== null)
  if (candidates.length === 0) return null
  let best = candidates[0]
  for (const c of candidates) if (c.consumed.size > best.consumed.size) best = c
  return best
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

// Cost-based pick between a hash join and a sort–merge join for an equijoin.
// Hash join is the default; merge join wins for large, comparably-sized inputs
// (its sort cost amortizes and it avoids building a big hash table) — the
// classic sweet spot for sort–merge.
const MERGE_JOIN_MIN_ROWS = 500
function chooseEquiJoin(
  left: Operator,
  right: Operator,
  leftKey: Evaluator,
  rightKey: Evaluator,
  type: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL',
  schema: Schema,
): Operator {
  const big = left.estRows >= MERGE_JOIN_MIN_ROWS && right.estRows >= MERGE_JOIN_MIN_ROWS
  const balanced = Math.max(left.estRows, right.estRows) <= 4 * Math.min(left.estRows, right.estRows) + 1
  if (big && balanced) return new MergeJoin(left, right, leftKey, rightKey, type, schema)
  return new HashJoin(left, right, leftKey, rightKey, type, schema)
}

// --- cost-based join reordering ---------------------------------------------
// Cap the search at this many relations so the 2^n subset DP stays cheap.
const MAX_REORDER_RELS = 8

/** Reorder only a pure chain of INNER joins (each with an ON predicate). Outer
 *  joins and CROSS joins change the answer when reordered, so we leave them. */
function canReorderJoins(stmt: SelectStmt): boolean {
  const n = stmt.joins.length + 1
  if (n < 3 || n > MAX_REORDER_RELS) return false
  // A LATERAL right side depends on the relations to its left, so its position
  // is fixed — never reorder a query that uses one.
  if (stmt.from?.lateral || stmt.joins.some((j) => j.lateral)) return false
  return stmt.joins.every((j) => j.type === 'INNER' && !!j.on)
}

interface JoinPlan {
  op: Operator
  schema: Schema
  applied: Set<Expr>
}

// Extend a left-deep plan covering some relation subset by one more relation
// leaf, applying every join/where predicate that first becomes resolvable here.
function joinStep(left: JoinPlan, rightOp: Operator, rightSchema: Schema, pool: Expr[], env: PlanEnv): JoinPlan {
  const combined: Schema = [...left.schema, ...rightSchema]
  const applicable = pool.filter(
    (p) => !left.applied.has(p) && resolvableIn(p, combined, env) && !resolvableIn(p, left.schema, env),
  )
  const applied = new Set(left.applied)
  applicable.forEach((p) => applied.add(p))

  let op: Operator
  if (applicable.length === 0) {
    // No connecting predicate yet — a (deprioritized) cartesian product.
    op = new NestedLoopJoin(left.op, rightOp, null, 'CROSS', combined)
  } else {
    const onExpr = andAll(applicable)!
    const equi = extractEquiJoin(onExpr, left.schema, rightSchema)
    if (equi && equi.residual.length === 0) {
      op = chooseEquiJoin(left.op, rightOp, equi.leftKey, equi.rightKey, 'INNER', combined)
    } else if (equi) {
      op = chooseEquiJoin(left.op, rightOp, equi.leftKey, equi.rightKey, 'INNER', combined)
      const resid = andAll(equi.residual)!
      op = new Filter(op, compileExpr(resid, exprCtx(combined, env)), exprLabel(resid))
    } else {
      op = new NestedLoopJoin(left.op, rightOp, compileExpr(onExpr, exprCtx(combined, env)), 'INNER', combined)
    }
  }
  return { op, schema: combined, applied }
}

function schemasIdentical(a: Schema, b: Schema): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// Plan a chain of INNER joins by searching left-deep orders with a subset DP.
// Returns null (so the caller falls back) if any predicate can't be placed.
function planJoinOrder(
  stmt: SelectStmt,
  env: PlanEnv,
  statTables: StatCtx,
  wherePreds: Expr[],
  consumed: Set<Expr>,
): { op: Operator; schema: Schema } | null {
  const items: (FromItem | JoinClause)[] = [stmt.from!, ...stmt.joins]
  const n = items.length

  const rels = items.map((it) => relationFor(it, env))
  rels.forEach((r) => statTables.set(r.alias.toLowerCase(), r.table))
  const relSchemas = rels.map((r) => tableSchema(r.table, r.alias))

  // A local consumed set so a failed attempt leaves the caller's state intact.
  const localConsumed = new Set(consumed)

  // Each relation's leaf: an index/seq scan with single-relation WHERE filters.
  const leaves: Operator[] = rels.map((r, i) => {
    const sch = relSchemas[i]
    const applicable = wherePreds.filter(
      (p) => !localConsumed.has(p) && !containsSubquery(p) && resolvableIn(p, sch, env),
    )
    let leaf: Operator
    const idx = chooseIndexAccess(r.table, sch, applicable, statTables)
    if (idx) {
      leaf = idx.op
      idx.consumed.forEach((p) => localConsumed.add(p))
    } else {
      leaf = new SeqScan(r.table, sch)
    }
    return applyPushdown(leaf, sch, wherePreds, localConsumed, env, false, statTables)
  })

  // Predicate pool: every JOIN ON conjunct + every still-unconsumed,
  // non-subquery WHERE conjunct (single-relation ones already sit in the leaves;
  // multi-relation ones become join predicates).
  const pool: Expr[] = []
  for (const j of stmt.joins) for (const c of conjuncts(j.on)) pool.push(c)
  const whereForPool: Expr[] = []
  for (const p of wherePreds) {
    if (localConsumed.has(p) || containsSubquery(p)) continue
    pool.push(p)
    whereForPool.push(p)
  }

  // Left-deep subset DP: dp[mask] = cheapest plan joining exactly that relation
  // subset. Ascending mask order guarantees every subset is finalized before it
  // is used to extend a larger one.
  const dp = new Map<number, JoinPlan>()
  for (let i = 0; i < n; i++) dp.set(1 << i, { op: leaves[i], schema: relSchemas[i], applied: new Set() })
  const full = (1 << n) - 1
  for (let mask = 1; mask <= full; mask++) {
    const left = dp.get(mask)
    if (!left) continue
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) continue
      const cand = joinStep(left, leaves[i], relSchemas[i], pool, env)
      const newMask = mask | (1 << i)
      const existing = dp.get(newMask)
      if (!existing || cand.op.estCost < existing.op.estCost) dp.set(newMask, cand)
    }
  }

  const finalPlan = dp.get(full)
  if (!finalPlan) return null
  // Never silently drop a predicate (e.g. an ambiguous unqualified column the
  // resolver couldn't place): fall back to the written-order planner instead.
  if (finalPlan.applied.size !== pool.length) return null

  for (const p of localConsumed) consumed.add(p)
  for (const p of whereForPool) consumed.add(p)

  // Restore the written column order so SELECT * is unaffected by reordering.
  const origSchema: Schema = relSchemas.flat()
  let op = finalPlan.op
  if (!schemasIdentical(op.schema, origSchema)) {
    const pos = new Map<Binding, number>()
    op.schema.forEach((b, i) => pos.set(b, i))
    const perm = origSchema.map((b) => pos.get(b)!)
    op = new Project(
      op,
      perm.map((i) => (row: Row) => row[i]),
      origSchema,
      origSchema.map((b) => b.name),
    )
  }
  return { op, schema: origSchema }
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
    // Unify the column types across all branches by position (INTEGER+REAL→REAL,
    // anything+TEXT→TEXT) so the compound's reported schema is consistent.
    const unified = unifyColumnTypes(operands.map((o) => o.schema))
    // Pass 1: collapse INTERSECT runs.
    for (let i = 0; i < ops.length; ) {
      if (ops[i].op === 'INTERSECT') {
        const merged = new SetOpExec(operands[i], operands[i + 1], 'INTERSECT', ops[i].all, unified)
        operands.splice(i, 2, merged)
        ops.splice(i, 1)
      } else {
        i++
      }
    }
    // Pass 2: fold remaining UNION/EXCEPT left to right.
    let op = operands[0]
    for (let i = 0; i < ops.length; i++) {
      op = new SetOpExec(op, operands[i + 1], ops[i].op, ops[i].all, unified)
    }
    if (stmt.orderBy.length) op = new Sort(op, compoundSortKeys(stmt.orderBy, op.schema, env2))
    if (stmt.limit !== undefined) op = new Limit(op, stmt.limit, stmt.offset ?? 0)
    return op
  }
  return planCore(stmt, env2, true)
}

// Combine two SQL types into the one that can hold both (the wider type).
const TYPE_RANK: Record<ColumnType, number> = {
  BOOLEAN: 0,
  INTEGER: 1,
  DECIMAL: 2,
  REAL: 3,
  INTERVAL: 4,
  TIME: 5,
  DATE: 6,
  TIMESTAMP: 7,
  JSON: 8,
  TSVECTOR: 8,
  TSQUERY: 8,
  ARRAY: 8,
  TEXT: 9,
}
function widerType(a: ColumnType, b: ColumnType): ColumnType {
  if (a === b) return a
  // BOOLEAN combined with a number stays numeric; TEXT absorbs everything.
  return TYPE_RANK[a] >= TYPE_RANK[b] ? a : b
}

// Unify a set of equal-arity schemas column-by-column, keeping the first
// branch's column names but widening each type to fit every branch.
function unifyColumnTypes(schemas: Schema[]): Schema {
  const first = schemas[0]
  return first.map((b, i) => {
    let type = b.type
    for (let s = 1; s < schemas.length; s++) type = widerType(type, schemas[s][i].type)
    return { table: '', name: b.name, type }
  })
}

// Resolve a named table or derived table to a (possibly transient) Table.
function relationFor(item: FromItem | JoinClause, env: PlanEnv): { table: Table; alias: string } {
  if (item.subquery) {
    const alias = item.alias ?? '__derived'
    const t = materialize(item.subquery, env, alias, item.columnAliases)
    return { table: t, alias }
  }
  if (item.tableFunc) {
    return tableFunctionRelation(item.tableFunc, item.alias, item.columnAliases)
  }
  const name = item.table!
  // CTEs / derived overlays (more local) win over a catalog view or base table.
  const overlay = env.relations.get(name.toLowerCase())
  if (overlay) return { table: overlay, alias: item.alias ?? overlay.name }
  // A view inlines its body as a derived table. It is resolved in the *catalog*
  // scope — a fresh env with no caller CTEs or correlations — so its meaning is
  // independent of where it's used; a trail breaks definition cycles.
  const view = env.db.getView(name)
  if (view) {
    const trail = env.viewTrail ?? new Set<string>()
    if (trail.has(name.toLowerCase())) {
      throw new SqlError(`view "${name}" is defined recursively (not supported)`, 'plan')
    }
    const childTrail = new Set(trail)
    childTrail.add(name.toLowerCase())
    const alias = item.alias ?? view.name
    const viewEnv: PlanEnv = { db: env.db, relations: new Map(), outer: [], viewTrail: childTrail }
    const t = materialize(view.select, viewEnv, alias, view.columns)
    return { table: t, alias }
  }
  const t = env.db.getTable(name)
  return { table: t, alias: item.alias ?? t.name }
}

// Materialize a set-returning table function (json_each / json_array_elements /
// …) into a synthetic single-use table, so the rest of the planner treats it
// exactly like a derived table. Arguments are evaluated in a constant context —
// LATERAL (referencing earlier FROM items) is not supported.
function tableFunctionRelation(
  tf: { name: string; args: Expr[] },
  alias: string | undefined,
  columnAliases: string[] | undefined,
): { table: Table; alias: string } {
  const fn = TABLE_FUNCTIONS[tf.name]
  if (!fn) throw new SqlError(`unknown table function ${tf.name}() in FROM`, 'plan')
  const constCtx: CompileCtx = {
    resolve: () => {
      throw new SqlError(`a ${tf.name}() argument cannot reference a column (LATERAL is not supported)`, 'plan')
    },
  }
  const argVals = tf.args.map((a) => compileExpr(a, constCtx)([]))
  const result = fn(argVals)
  const name = alias ?? tf.name.toLowerCase()
  const cols: ColumnDef[] = result.columns.map((c, i) => ({
    name: columnAliases?.[i] ?? c.name,
    type: c.type,
    primaryKey: false,
    notNull: false,
    unique: false,
  }))
  const table = new Table(name, cols)
  for (const r of result.rows) table.insertRawRow(r.slice())
  return { table, alias: name }
}

// Plan a LATERAL join: the right side (a subquery or a table function) may
// reference the columns produced by the relations to its left. Rather than
// materialize it once, we plan it against an outer scope over the left schema
// and re-evaluate it per left row inside a `LateralJoin` operator.
function planLateralJoin(leftOp: Operator, leftSchema: Schema, join: JoinClause, env: PlanEnv): Operator {
  if (join.type === 'RIGHT' || join.type === 'FULL') {
    throw new SqlError('LATERAL does not support RIGHT or FULL joins', 'plan')
  }
  const leftJoin = join.type === 'LEFT'
  let rightSchema: Schema
  let buildRight: (leftRow: Row) => Row[]
  let label: string

  if (join.subquery) {
    const alias = join.alias ?? '__lateral'
    // The subquery resolves its own columns locally and correlated ones through
    // a fresh outer scope over the left row (innermost last).
    const outer: OuterScope = { resolve: (t, n) => tryResolveIndex(leftSchema, t, n), row: null }
    const env2: PlanEnv = { ...env, outer: [...env.outer, outer] }
    const rightOp = planQuery(join.subquery, env2)
    rightSchema = rightOp.schema.map((b, i) => ({
      table: alias,
      name: join.columnAliases?.[i] ?? b.name,
      type: b.type,
    }))
    buildRight = (leftRow) => {
      outer.row = leftRow
      return drain(rightOp)
    }
    label = `lateral ${alias}`
  } else if (join.tableFunc) {
    const tf = join.tableFunc
    const fn = TABLE_FUNCTIONS[tf.name]
    if (!fn) throw new SqlError(`unknown table function ${tf.name}() in FROM`, 'plan')
    const alias = join.alias ?? tf.name.toLowerCase()
    // Compile the function arguments against the left row directly (a LATERAL
    // function call sees the left columns as locals).
    const argFns = tf.args.map((a) => compileExpr(a, exprCtx(leftSchema, env)))
    // Probe the column shape once with NULL arguments (every table function
    // returns its fixed columns even for a NULL/empty input).
    const probeRow: Row = new Array(leftSchema.length).fill(null)
    const probe = fn(argFns.map((f) => f(probeRow)))
    rightSchema = probe.columns.map((c, i) => ({
      table: alias,
      name: join.columnAliases?.[i] ?? c.name,
      type: c.type,
    }))
    buildRight = (leftRow) => fn(argFns.map((f) => f(leftRow))).rows
    label = `lateral ${tf.name.toLowerCase()}()`
  } else {
    throw new SqlError('LATERAL requires a subquery or a table function', 'plan')
  }

  const combined: Schema = [...leftSchema, ...rightSchema]
  const pred = join.on ? compileExpr(join.on, exprCtx(combined, env)) : null
  return new LateralJoin(leftOp, rightSchema.length, buildRight, pred, leftJoin, combined, label)
}

// A top-level `EXISTS (…)` conjunct, or a `NOT EXISTS (…)` one (which parses as
// a unary NOT over an EXISTS). Returns an ExistsExpr with the effective `negated`
// flag folded in, or null if the conjunct isn't an existence test.
function asExistsConjunct(p: Expr): ExistsExpr | null {
  if (p.kind === 'exists') return p
  if (p.kind === 'unary' && p.op === 'NOT' && p.expr.kind === 'exists') {
    return { ...p.expr, negated: !p.expr.negated }
  }
  return null
}

// Attempt to decorrelate a `[NOT] EXISTS (subquery)` WHERE conjunct into a hash
// semi-/anti-join over the post-FROM rows (`outerSchema`). Returns the join
// inputs on success, or null when the shape isn't provably equivalent (the
// caller then leaves the predicate for the normal per-row evaluator).
//
// The supported shape is a single-relation existence subquery whose WHERE is a
// conjunction of (a) equi-correlations `innerExpr = outerExpr` (which become the
// join keys) and (b) inner-local predicates (which stay inside the build side).
// Anything that touches the outer scope in another way, or uses grouping /
// aggregates / set-ops / LIMIT / joins, bails — keeping the rewrite sound.
function tryDecorrelateExists(
  e: ExistsExpr,
  outerSchema: Schema,
  env: PlanEnv,
): { leftKeys: Evaluator[]; rightOp: Operator; anti: boolean } | null {
  const sel = e.select
  if (!sel.from) return null
  if (sel.joins.length > 0) return null
  if (sel.groupBy.length > 0 || sel.groupingSets || sel.having) return null
  if (sel.setOps && sel.setOps.length) return null
  if (sel.limit !== undefined || sel.offset !== undefined) return null
  // An aggregate with no GROUP BY always yields exactly one row, so EXISTS would
  // be trivially true — different semantics from a row-existence test. Bail.
  const aggMap = new Map<string, Expr>()
  for (const it of sel.columns) findAggregates(it.expr, aggMap)
  if (aggMap.size > 0) return null

  // Resolve the inner relation to learn its schema (so we can tell inner column
  // references from correlated outer ones).
  let inner: { table: Table; alias: string }
  try {
    inner = relationFor(sel.from, env)
  } catch {
    return null
  }
  const innerSchema = tableSchema(inner.table, inner.alias)
  const innerRef = (c: ColumnExpr) => tryResolveIndex(innerSchema, c.table, c.name) !== null
  const outerRef = (c: ColumnExpr) => tryResolveIndex(outerSchema, c.table, c.name) !== null
  // Classify an expression as unambiguously inner-only, outer-only, or constant.
  const classify = (ex: Expr): 'inner' | 'outer' | 'const' | null => {
    if (containsSubquery(ex)) return null
    const cols: ColumnExpr[] = []
    collectColumns(ex, cols)
    if (cols.length === 0) return 'const'
    if (cols.every((c) => innerRef(c) && !outerRef(c))) return 'inner'
    if (cols.every((c) => outerRef(c) && !innerRef(c))) return 'outer'
    return null
  }

  const innerKeys: Expr[] = []
  const outerKeys: Expr[] = []
  const localPreds: Expr[] = []
  for (const conj of conjuncts(sel.where)) {
    if (conj.kind === 'binary' && conj.op === '=') {
      const lc = classify(conj.left)
      const rc = classify(conj.right)
      if (lc === 'inner' && rc === 'outer') {
        innerKeys.push(conj.left)
        outerKeys.push(conj.right)
        continue
      }
      if (lc === 'outer' && rc === 'inner') {
        innerKeys.push(conj.right)
        outerKeys.push(conj.left)
        continue
      }
    }
    const cl = classify(conj)
    if (cl === 'inner' || cl === 'const') {
      localPreds.push(conj)
      continue
    }
    return null // references the outer scope in a non-equi way — can't decorrelate
  }

  // Build side: the inner key expressions (or a constant for an uncorrelated
  // EXISTS), filtered by the inner-local predicates, re-using the full planner.
  const buildColumns: SelectItem[] = innerKeys.length
    ? innerKeys.map((ex) => ({ expr: ex }))
    : [{ expr: { kind: 'literal', value: 1 } as Expr }]
  const buildSel: SelectStmt = {
    kind: 'select',
    distinct: false,
    columns: buildColumns,
    from: sel.from,
    joins: [],
    where: andAll(localPreds),
    groupBy: [],
    orderBy: [],
    ctes: sel.ctes,
    recursive: sel.recursive,
  }
  let rightOp: Operator
  try {
    rightOp = planQuery(buildSel, env)
  } catch {
    return null
  }
  const leftKeys = outerKeys.map((ex) => compileExpr(ex, exprCtx(outerSchema, env)))
  return { leftKeys, rightOp, anti: e.negated }
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

  // Relation alias -> Table, so selectivity estimation can find column stats.
  const statTables: StatCtx = new Map()

  let op: Operator
  let schema: Schema

  // --- cost-based join reordering -------------------------------------------
  // For a chain of two or more INNER joins, search left-deep join orders with a
  // Selinger-style subset DP and keep the cheapest. Outer joins / CROSS chains
  // aren't freely reorderable, so they fall through to the written-order planner.
  const reordered = canReorderJoins(stmt) ? planJoinOrder(stmt, env, statTables, wherePreds, consumed) : null
  if (reordered) {
    op = reordered.op
    schema = reordered.schema
  } else {
    // --- base relation (written order) --------------------------------------
    const base = relationFor(stmt.from, env)
    statTables.set(base.alias.toLowerCase(), base.table)
    schema = tableSchema(base.table, base.alias)

    if (basePreserved) {
      const baseApplicable = wherePreds.filter((p) => !consumed.has(p) && resolvableIn(p, schema, env))
      // Covering-index detection only for a single base table (no joins / derived
      // relation), where every column reference belongs to this table.
      const cover = stmt.joins.length === 0 && !stmt.from!.subquery ? coveringColumns(stmt) : null
      const idx = chooseIndexAccess(base.table, schema, baseApplicable, statTables, cover?.ok ? cover.names : null)
      if (idx) {
        op = idx.op
        // A covering (index-only) scan emits only the indexed columns, so adopt
        // the operator's own schema for downstream resolution.
        schema = idx.op.schema
        idx.consumed.forEach((p) => consumed.add(p))
      } else {
        op = new SeqScan(base.table, schema)
      }
      op = applyPushdown(op, schema, wherePreds, consumed, env, false, statTables)
    } else {
      op = new SeqScan(base.table, schema)
    }

    // --- joins --------------------------------------------------------------
    for (const join of stmt.joins) {
      // A LATERAL right side correlates to the columns produced so far, so it is
      // re-evaluated per outer row by a dedicated correlated-nested-loop operator.
      if (join.lateral) {
        op = planLateralJoin(op, schema, join, env)
        schema = op.schema
        continue
      }
      const right = relationFor(join, env)
      statTables.set(right.alias.toLowerCase(), right.table)
      const rSchema = tableSchema(right.table, right.alias)
      // Only push WHERE predicates onto the right input for INNER joins; for an
      // outer join the right side may be null-extended, so its WHERE predicates
      // must run after the join (the final pushdown stage).
      let rightOp: Operator = new SeqScan(right.table, rSchema)
      if (join.type === 'INNER') {
        rightOp = applyPushdown(rightOp, rSchema, wherePreds, consumed, env, false, statTables)
      }

      const combined: Schema = [...schema, ...rSchema]
      const outerType: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' =
        join.type === 'LEFT' || join.type === 'RIGHT' || join.type === 'FULL' ? join.type : 'INNER'
      if (join.type === 'CROSS' || !join.on) {
        op = new NestedLoopJoin(op, rightOp, null, 'CROSS', combined)
      } else {
        const equi = extractEquiJoin(join.on, schema, rSchema)
        if (equi && equi.residual.length === 0) {
          op = chooseEquiJoin(op, rightOp, equi.leftKey, equi.rightKey, outerType, combined)
        } else if (equi && join.type === 'INNER') {
          op = chooseEquiJoin(op, rightOp, equi.leftKey, equi.rightKey, 'INNER', combined)
          const resid = andAll(equi.residual)!
          op = new Filter(op, compileExpr(resid, exprCtx(combined, env)), exprLabel(resid))
        } else {
          const pred = compileExpr(join.on, exprCtx(combined, env))
          op = new NestedLoopJoin(op, rightOp, pred, outerType, combined)
        }
      }
      schema = combined
    }
  }

  // --- subquery decorrelation -----------------------------------------------
  // Rewrite a top-level `WHERE … [NOT] EXISTS (…)` conjunct into a hash semi-/
  // anti-join when its correlation decomposes into equi-keys + inner-local
  // predicates. This turns a per-outer-row subquery re-execution into a single
  // build+probe. Any shape we can't prove equivalent is left untouched for the
  // normal per-row evaluator below, so an answer can never change.
  for (const p of wherePreds) {
    if (consumed.has(p)) continue
    const ex = asExistsConjunct(p)
    if (!ex) continue
    const dec = tryDecorrelateExists(ex, schema, env)
    if (dec) {
      op = new HashSemiJoin(op, dec.rightOp, dec.leftKeys, dec.anti, schema)
      consumed.add(p)
    }
  }

  // Any remaining WHERE predicates (multi-table / subquery) apply now.
  op = applyPushdown(op, schema, wherePreds, consumed, env, true, statTables)

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
      // STRING_AGG(x, sep) / GROUP_CONCAT(x, sep): the (optional) 2nd arg is a
      // constant separator, not an aggregated value.
      const isStringAgg = e.name === 'STRING_AGG' || e.name === 'GROUP_CONCAT'
      const sep =
        isStringAgg && e.args[1] && e.args[1].kind === 'literal' && e.args[1].value !== null
          ? String(e.args[1].value)
          : undefined

      // Ordered-set aggregates (PERCENTILE_CONT/DISC, MODE): the aggregated value
      // is the WITHIN GROUP (ORDER BY …) key; the call's argument is the fraction.
      if (ORDERED_SET_AGGREGATES.has(e.name)) {
        if (!e.withinGroup || e.withinGroup.length !== 1) {
          throw new SqlError(`${e.name} requires WITHIN GROUP (ORDER BY <expr>)`, 'bind')
        }
        let fraction: number | undefined
        if (e.name === 'PERCENTILE_CONT' || e.name === 'PERCENTILE_DISC') {
          const fv = e.args.length ? evalConst(e.args[0]) : undefined
          if (typeof fv !== 'number') {
            throw new SqlError(`${e.name} expects a numeric fraction between 0 and 1`, 'bind')
          }
          fraction = fv
        }
        return {
          name: e.name as AggName,
          star: false,
          distinct: false,
          arg: compileExpr(e.withinGroup[0].expr, preCtx),
          label: exprLabel(e),
          fraction,
          dir: e.withinGroup[0].dir,
          filter: e.filter ? compileExpr(e.filter, preCtx) : undefined,
        }
      }

      // JSON_OBJECT_AGG(key, value): the 2nd argument is the per-row value.
      const arg2 =
        e.name === 'JSON_OBJECT_AGG' && e.args[1] ? compileExpr(e.args[1], preCtx) : undefined

      return {
        name: e.name as AggName,
        star: e.star,
        distinct: e.distinct,
        arg: e.star || e.args.length === 0 ? null : compileExpr(e.args[0], preCtx),
        arg2,
        label: exprLabel(e),
        sep,
        filter: e.filter ? compileExpr(e.filter, preCtx) : undefined,
      }
    })

    // Output schema of the aggregate: group keys, then aggregates, then a hidden
    // grouping-set bitmap column (`__gset`) that powers the GROUPING() function.
    const aggSchema: Schema = [
      ...stmt.groupBy.map((g, i) => ({
        table: '',
        name: g.kind === 'column' ? g.name : `group${i}`,
        type: inferType(g, schema, preCtx),
      })),
      ...aggExprs.map((e) => ({ table: '', name: exprLabel(e), type: inferType(e, schema, preCtx) })),
      { table: '', name: '__gset', type: 'INTEGER' as ColumnType },
    ]
    // Map each expanded grouping set to slot indexes into the grouping keys.
    const groupingSetsIdx: number[][] | undefined = stmt.groupingSets
      ? stmt.groupingSets.map((set) =>
          set.map((ge) => {
            const slot = groupKeyMap.get(exprKey(ge))
            if (slot === undefined) throw new SqlError('a grouping-set column must appear in GROUP BY', 'plan')
            return slot
          }),
        )
      : undefined
    const gsetSlot = stmt.groupBy.length + aggExprs.length
    op = new HashAggregate(op, groupEvals, aggSpecs, aggSchema, groupingSetsIdx, true)

    // GROUPING(a, …) → an integer whose bits flag which arguments were rolled up
    // (1 = aggregated away to NULL in this grouping set, 0 = present).
    const compileGrouping = (e: Expr): Evaluator => {
      if (e.kind !== 'func') throw new SqlError('internal: GROUPING must be a function', 'plan')
      if (e.args.length === 0) throw new SqlError('GROUPING() requires at least one argument', 'bind')
      const indices = e.args.map((arg) => {
        const slot = groupKeyMap.get(exprKey(arg))
        if (slot === undefined) throw new SqlError('GROUPING() argument must be a GROUP BY expression', 'bind')
        return slot
      })
      return (row) => {
        const bm = typeof row[gsetSlot] === 'number' ? (row[gsetSlot] as number) : 0
        let result = 0
        for (const i of indices) result = (result << 1) | ((bm & (1 << i)) === 0 ? 1 : 0)
        return result
      }
    }

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
      compileGrouping,
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
  const windowPlan = planWindowFns(
    stmt.columns,
    stmt.orderBy,
    outCtx,
    schema,
    stmt.windows,
    stmt.qualify ? [stmt.qualify] : undefined,
  )
  if (windowPlan) {
    op = new WindowExec(op, windowPlan.specs, windowPlan.schema)
    const prevResolve = outCtx.resolve
    const prevLookup = outCtx.lookup
    const prevGrouping = outCtx.compileGrouping
    outCtx = exprCtx(windowPlan.schema, env, {
      resolve: prevResolve,
      lookup: (e) => windowPlan.lookup(e) ?? prevLookup?.(e),
      compileGrouping: prevGrouping,
    })
    schema = windowPlan.schema
  }

  // --- QUALIFY (filter on window results, after the window stage) ------------
  if (stmt.qualify) {
    op = new Filter(op, compileExpr(stmt.qualify, outCtx), `QUALIFY ${exprLabel(stmt.qualify)}`)
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
        if (!b.table && b.name.startsWith('__')) continue // hide internal scratch columns
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
    compileGrouping?: CompileCtx['compileGrouping']
  },
): CompileCtx {
  const resolve = extra?.resolve ?? ((t: string | undefined, n: string) => resolveColumn(schema, t, n))
  const ctx: CompileCtx = {
    resolve,
    lookup: extra?.lookup,
    outer: env.outer.length ? env.outer : undefined,
    compileWindow: extra?.compileWindow,
    compileGrouping: extra?.compileGrouping,
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

// Compile an AST window frame into executable bounds (offset exprs compiled).
function compileFrame(frame: WindowFrame, ctx: CompileCtx): FrameExec {
  const bound = (b: FrameBound) => ({
    type: b.type,
    offset: b.offset ? compileExpr(b.offset, ctx) : undefined,
  })
  return {
    mode: frame.mode,
    start: bound(frame.start),
    end: bound(frame.end),
    exclude: frame.exclude ?? 'NO_OTHERS',
  }
}

// Merge a window spec against a named base (the WINDOW clause), applying the
// standard inheritance rules: the base supplies PARTITION BY; the referencing
// spec may add ORDER BY (only if the base has none) and a frame (the base must
// have none). Resolves base chains, guarding against cycles.
function mergeWindowBase(spec: WindowSpec, named: Map<string, WindowSpec>, seen: Set<string>): WindowSpec {
  if (!spec.base) return spec
  if (seen.has(spec.base)) throw new SqlError(`circular reference to window "${spec.base}"`, 'bind')
  const baseDef = named.get(spec.base)
  if (!baseDef) throw new SqlError(`window "${spec.base}" does not exist`, 'bind')
  const base = mergeWindowBase(baseDef, named, new Set([...seen, spec.base]))
  if (spec.partitionBy.length) {
    throw new SqlError(`cannot override PARTITION BY of referenced window "${spec.base}"`, 'bind')
  }
  if (base.orderBy.length && spec.orderBy.length) {
    throw new SqlError(`cannot override ORDER BY of referenced window "${spec.base}"`, 'bind')
  }
  if (base.frame) {
    throw new SqlError(`cannot reference window "${spec.base}" — it specifies a frame`, 'bind')
  }
  return {
    partitionBy: base.partitionBy,
    orderBy: spec.orderBy.length ? spec.orderBy : base.orderBy,
    frame: spec.frame,
  }
}

// The effective window spec for a window function call, resolving a bare
// `OVER name` reference or an inline `OVER (name …)` base against the WINDOW clause.
function resolveWindowSpec(w: WindowFuncExpr, named: Map<string, WindowSpec>): WindowSpec {
  if (w.windowRef) {
    const def = named.get(w.windowRef)
    if (!def) throw new SqlError(`window "${w.windowRef}" does not exist`, 'bind')
    return mergeWindowBase(def, named, new Set([w.windowRef]))
  }
  return mergeWindowBase(w.spec, named, new Set())
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
  namedDefs?: SelectStmt['windows'],
  extra?: Expr[],
): WindowPlanResult | null {
  const found = new Map<string, WindowFuncExpr>()
  for (const it of columns) collectWindows(it.expr, found)
  for (const o of orderBy) collectWindows(o.expr, found)
  for (const e of extra ?? []) collectWindows(e, found)
  if (found.size === 0) return null
  const named = new Map<string, WindowSpec>()
  for (const nw of namedDefs ?? []) named.set(nw.name, nw.spec)
  const exprs = [...found.values()]
  const specs: WindowSpecExec[] = exprs.map((w) => {
    const spec = resolveWindowSpec(w, named)
    if (ORDERED_SET_AGGREGATES.has(w.name) && !(w.withinGroup && w.withinGroup[0])) {
      throw new SqlError(`${w.name} requires WITHIN GROUP (ORDER BY <expr>) as a window function`, 'bind')
    }
    return {
      name: w.name,
      args: w.args.map((a) => compileExpr(a, ctx)),
      partition: spec.partitionBy.map((p) => compileExpr(p, ctx)),
      order: spec.orderBy.map((o) => ({ eval: compileExpr(o.expr, ctx), dir: o.dir })),
      frame: spec.frame ? compileFrame(spec.frame, ctx) : undefined,
      ignoreNulls: w.ignoreNulls,
      filter: w.filter ? compileExpr(w.filter, ctx) : undefined,
      withinGroup:
        w.withinGroup && w.withinGroup[0]
          ? { eval: compileExpr(w.withinGroup[0].expr, ctx), dir: w.withinGroup[0].dir }
          : undefined,
      label: exprLabel(w),
    }
  })
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
  sc: StatCtx,
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
  const selectivity = combinedSelectivity(applicable, sc)
  return new Filter(op, pred, exprLabel(combined), selectivity)
}

// `Binding` re-exported so the engine can describe result columns.
export type { Binding }
