// Abstract syntax tree for the QueryForge SQL dialect.
//
// Everything is a plain discriminated union keyed on `kind` so the binder,
// planner and (eventual) printer can pattern-match exhaustively.

import type { ColumnType, SqlValue } from './types'

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%'
  | '=' | '<>' | '<' | '<=' | '>' | '>='
  | 'AND' | 'OR' | '||'

export type UnaryOp = 'NOT' | '-' | '+'

export interface LiteralExpr {
  kind: 'literal'
  value: SqlValue
}
export interface ColumnExpr {
  kind: 'column'
  table?: string
  name: string
}
export interface StarExpr {
  kind: 'star'
  table?: string
}
export interface UnaryExpr {
  kind: 'unary'
  op: UnaryOp
  expr: Expr
}
export interface BinaryExpr {
  kind: 'binary'
  op: BinaryOp
  left: Expr
  right: Expr
}
export interface BetweenExpr {
  kind: 'between'
  expr: Expr
  lo: Expr
  hi: Expr
  negated: boolean
}
export interface InExpr {
  kind: 'in'
  expr: Expr
  list: Expr[]
  negated: boolean
}
export interface LikeExpr {
  kind: 'like'
  expr: Expr
  pattern: Expr
  negated: boolean
}
export interface IsNullExpr {
  kind: 'isnull'
  expr: Expr
  negated: boolean
}
export interface FuncExpr {
  kind: 'func'
  name: string
  args: Expr[]
  /** COUNT(DISTINCT x) etc. */
  distinct: boolean
  /** COUNT(*) */
  star: boolean
}
export interface CaseExpr {
  kind: 'case'
  operand?: Expr
  whens: { when: Expr; then: Expr }[]
  else?: Expr
}
export interface CastExpr {
  kind: 'cast'
  expr: Expr
  type: ColumnType
}
/** A scalar subquery: `(SELECT … )` yielding (at most) one row / one column. */
export interface SubqueryExpr {
  kind: 'subquery'
  select: SelectStmt
}
/** `[NOT] EXISTS (SELECT …)`. */
export interface ExistsExpr {
  kind: 'exists'
  select: SelectStmt
  negated: boolean
}
/** `expr [NOT] IN (SELECT …)`. */
export interface InSubqueryExpr {
  kind: 'in_subquery'
  expr: Expr
  select: SelectStmt
  negated: boolean
}
export interface WindowSpec {
  partitionBy: Expr[]
  orderBy: OrderItem[]
}
/** A window function call: `name(args) OVER (PARTITION BY … ORDER BY …)`. */
export interface WindowFuncExpr {
  kind: 'window'
  name: string
  args: Expr[]
  spec: WindowSpec
}

export type Expr =
  | LiteralExpr
  | ColumnExpr
  | StarExpr
  | UnaryExpr
  | BinaryExpr
  | BetweenExpr
  | InExpr
  | LikeExpr
  | IsNullExpr
  | FuncExpr
  | CaseExpr
  | CastExpr
  | SubqueryExpr
  | ExistsExpr
  | InSubqueryExpr
  | WindowFuncExpr

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export interface ColumnDef {
  name: string
  type: ColumnType
  primaryKey: boolean
  notNull: boolean
  unique: boolean
}

export interface CreateTableStmt {
  kind: 'create_table'
  name: string
  columns: ColumnDef[]
  ifNotExists: boolean
}
export interface DropTableStmt {
  kind: 'drop_table'
  name: string
  ifExists: boolean
}
export interface CreateIndexStmt {
  kind: 'create_index'
  name: string
  table: string
  column: string
  unique: boolean
  ifNotExists: boolean
}
export interface InsertStmt {
  kind: 'insert'
  table: string
  columns?: string[]
  rows: Expr[][]
  /** INSERT … SELECT — when present, `rows` is empty and this query supplies them. */
  select?: SelectStmt
}
export interface UpdateStmt {
  kind: 'update'
  table: string
  assignments: { column: string; value: Expr }[]
  where?: Expr
}
export interface DeleteStmt {
  kind: 'delete'
  table: string
  where?: Expr
}

export interface SelectItem {
  expr: Expr
  alias?: string
}
/** A relation in FROM/JOIN: either a named table/CTE, or a derived table. */
export interface FromItem {
  table?: string
  subquery?: SelectStmt
  alias?: string
}
export type JoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS'
export interface JoinClause {
  type: JoinType
  table?: string
  subquery?: SelectStmt
  alias?: string
  on?: Expr
}
export interface OrderItem {
  expr: Expr
  dir: 'ASC' | 'DESC'
}

export type SetOpKind = 'UNION' | 'INTERSECT' | 'EXCEPT'
/** A compound-query tail: `<core> UNION/INTERSECT/EXCEPT [ALL] <select>`. */
export interface SetOp {
  op: SetOpKind
  all: boolean
  select: SelectStmt
}
/** A common table expression (`WITH name [(cols)] AS (select)`). */
export interface CteDef {
  name: string
  columns?: string[]
  select: SelectStmt
}

export interface SelectStmt {
  kind: 'select'
  distinct: boolean
  columns: SelectItem[]
  from?: FromItem
  joins: JoinClause[]
  where?: Expr
  groupBy: Expr[]
  having?: Expr
  orderBy: OrderItem[]
  limit?: number
  offset?: number
  /** CTEs attached to this query (WITH …). */
  ctes?: CteDef[]
  /** Whether the WITH was declared RECURSIVE. */
  recursive?: boolean
  /** Set-operation tail; when present, orderBy/limit/offset bind to the compound. */
  setOps?: SetOp[]
}
export interface ExplainStmt {
  kind: 'explain'
  analyze: boolean
  statement: Statement
}
export interface TxnStmt {
  kind: 'txn'
  action: 'begin' | 'commit' | 'rollback'
}

export type Statement =
  | CreateTableStmt
  | DropTableStmt
  | CreateIndexStmt
  | InsertStmt
  | UpdateStmt
  | DeleteStmt
  | SelectStmt
  | ExplainStmt
  | TxnStmt

// Aggregate function names recognised by the planner.
export const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'])

export function isAggregate(name: string): boolean {
  return AGGREGATES.has(name.toUpperCase())
}
