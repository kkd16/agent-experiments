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
  // JSON path extraction, containment and key existence.
  | '->' | '->>' | '#>' | '#>>' | '@>' | '<@' | '?' | '@@'

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
  /** Aggregate `FILTER (WHERE …)` — only rows matching it are aggregated. */
  filter?: Expr
  /** Ordered-set aggregate sort key: `… WITHIN GROUP (ORDER BY …)`
   *  (PERCENTILE_CONT/PERCENTILE_DISC/MODE). */
  withinGroup?: OrderItem[]
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
  /** Target fractional scale for `CAST(x AS DECIMAL(p, s))`. */
  scale?: number
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
/** `expr <op> ANY|ALL (SELECT …)` (SOME is a synonym for ANY). */
export interface QuantifiedExpr {
  kind: 'quantified'
  op: '=' | '<>' | '<' | '<=' | '>' | '>='
  quantifier: 'ANY' | 'ALL'
  expr: Expr
  select: SelectStmt
}
export type FrameMode = 'ROWS' | 'RANGE' | 'GROUPS'
export type FrameBoundType =
  | 'UNBOUNDED_PRECEDING'
  | 'PRECEDING'
  | 'CURRENT_ROW'
  | 'FOLLOWING'
  | 'UNBOUNDED_FOLLOWING'
/** `EXCLUDE …` frame exclusion (SQL:2003). Default (omitted) is NO OTHERS. */
export type FrameExclude = 'NO_OTHERS' | 'CURRENT_ROW' | 'GROUP' | 'TIES'
export interface FrameBound {
  type: FrameBoundType
  /** Row/value offset for N PRECEDING / N FOLLOWING. */
  offset?: Expr
}
export interface WindowFrame {
  mode: FrameMode
  start: FrameBound
  end: FrameBound
  /** `EXCLUDE …`; undefined → NO OTHERS. */
  exclude?: FrameExclude
}
export interface WindowSpec {
  /** A referenced named window (the `w` in `OVER (w ORDER BY …)`); resolved at bind. */
  base?: string
  partitionBy: Expr[]
  orderBy: OrderItem[]
  /** Explicit frame (ROWS/RANGE/GROUPS BETWEEN …); undefined → the standard default. */
  frame?: WindowFrame
}
/** A `WINDOW name AS (spec)` definition from a query's WINDOW clause. */
export interface NamedWindow {
  name: string
  spec: WindowSpec
}
/** A window function call: `name(args) OVER (PARTITION BY … ORDER BY …)`. */
export interface WindowFuncExpr {
  kind: 'window'
  name: string
  args: Expr[]
  spec: WindowSpec
  /** Ordered-set window aggregate key: `PERCENTILE_CONT(f) WITHIN GROUP (ORDER BY x) OVER …`. */
  withinGroup?: OrderItem[]
  /** Aggregate-window `FILTER (WHERE …)` — only matching rows in the frame contribute. */
  filter?: Expr
  /** `IGNORE NULLS` for value/offset functions (default RESPECT NULLS). */
  ignoreNulls?: boolean
  /** A bare `OVER name` with no parenthesised spec referenced this WINDOW-clause name. */
  windowRef?: string
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
  | QuantifiedExpr
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
  /** Declared precision for `DECIMAL(precision, scale)` (informational). */
  precision?: number
  /** Declared fractional scale for `DECIMAL(precision, scale)`; rounds on store. */
  scale?: number
  /** A `DEFAULT <expr>` supplying the value when the column is omitted on INSERT. */
  default?: Expr
}

/** A referential action for `ON DELETE` / `ON UPDATE`. */
export type RefAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT'

/** A `FOREIGN KEY (cols) REFERENCES parent(cols) [ON DELETE …] [ON UPDATE …]`. */
export interface ForeignKeyDef {
  name?: string
  /** The child columns that reference the parent. */
  columns: string[]
  refTable: string
  /** The referenced parent columns (the parent's PK when omitted in SQL). */
  refColumns: string[]
  onDelete: RefAction
  onUpdate: RefAction
}

/** A named-or-anonymous `CHECK (<expr>)` row constraint. */
export interface CheckConstraint {
  name?: string
  expr: Expr
}

/** Table-level declarative constraints, normalized from column- and table-level SQL. */
export interface TableConstraints {
  /** The single primary key (one or more columns), if declared. */
  primaryKey?: string[]
  /** Each `UNIQUE (…)` group (single- or multi-column). */
  uniques: string[][]
  checks: CheckConstraint[]
  foreignKeys: ForeignKeyDef[]
}

export function emptyConstraints(): TableConstraints {
  return { uniques: [], checks: [], foreignKeys: [] }
}

export interface CreateTableStmt {
  kind: 'create_table'
  name: string
  columns: ColumnDef[]
  constraints: TableConstraints
  ifNotExists: boolean
}

/** `ALTER TABLE t ADD COLUMN … | ADD <constraint> | DROP COLUMN … | RENAME …`. */
export interface AlterTableStmt {
  kind: 'alter_table'
  table: string
  action:
    | { kind: 'add_column'; column: ColumnDef }
    | { kind: 'drop_column'; column: string }
    | { kind: 'rename_table'; to: string }
    | { kind: 'rename_column'; column: string; to: string }
    | { kind: 'add_check'; check: CheckConstraint }
    | { kind: 'add_foreign_key'; fk: ForeignKeyDef }
    | { kind: 'add_unique'; columns: string[] }
}
export interface DropTableStmt {
  kind: 'drop_table'
  name: string
  ifExists: boolean
}
/** `CREATE [OR REPLACE] VIEW name [(cols)] AS <query>`. A view is a named query
 *  that the planner inlines (re-plans) wherever the view name appears. */
export interface CreateViewStmt {
  kind: 'create_view'
  name: string
  /** Optional output column names — `CREATE VIEW v (a, b) AS …`. */
  columns?: string[]
  select: SelectStmt
  orReplace: boolean
  ifNotExists: boolean
}
/** `DROP VIEW [IF EXISTS] name`. */
export interface DropViewStmt {
  kind: 'drop_view'
  name: string
  ifExists: boolean
}
export interface CreateIndexStmt {
  kind: 'create_index'
  name: string
  table: string
  /** Indexed columns, in order (length 1 for a single-column index). */
  columns: string[]
  unique: boolean
  ifNotExists: boolean
  /** Access method from `USING <method>` (e.g. `GIN`). Default is a B+Tree. */
  using?: string
}
/** `ANALYZE [table]` — (re)gather optimizer statistics. */
export interface AnalyzeStmt {
  kind: 'analyze'
  table?: string
}
/** `INSERT … ON CONFLICT [(cols)] DO NOTHING | DO UPDATE SET … [WHERE …]`.
 *  The conflict `target` (the arbiter columns) is optional; when omitted, any
 *  UNIQUE/PRIMARY KEY conflict triggers the action. In a `DO UPDATE`, the
 *  pseudo-table `EXCLUDED` refers to the row proposed for insertion. */
export interface OnConflictClause {
  /** The arbiter columns; undefined → any unique constraint. */
  target?: string[]
  action:
    | { kind: 'nothing' }
    | { kind: 'update'; assignments: { column: string; value: Expr }[]; where?: Expr }
}

export interface InsertStmt {
  kind: 'insert'
  table: string
  columns?: string[]
  rows: Expr[][]
  /** INSERT … SELECT — when present, `rows` is empty and this query supplies them. */
  select?: SelectStmt
  /** `ON CONFLICT …` upsert clause. */
  onConflict?: OnConflictClause
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
/** A set-returning table function in FROM — `json_each(expr)`, etc. */
export interface TableFuncRef {
  name: string
  args: Expr[]
}
export interface FromItem {
  table?: string
  subquery?: SelectStmt
  /** A set-returning table function source — `FROM json_array_elements(j) t`. */
  tableFunc?: TableFuncRef
  alias?: string
  /** Optional column aliases — `FROM (…) t (x, y)` (incl. VALUES constructors). */
  columnAliases?: string[]
}
export type JoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS'
export interface JoinClause {
  type: JoinType
  table?: string
  subquery?: SelectStmt
  tableFunc?: TableFuncRef
  alias?: string
  columnAliases?: string[]
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
  /** Expanded grouping sets (ROLLUP/CUBE/GROUPING SETS). Each inner array is one
   *  grouping set, listing the subset of grouping expressions that are active in
   *  it; the rest are aggregated to NULL. Undefined for a plain GROUP BY. */
  groupingSets?: Expr[][]
  having?: Expr
  /** Named windows from a `WINDOW w AS (…)` clause, referenced by `OVER w`. */
  windows?: NamedWindow[]
  /** `QUALIFY <predicate>` — filters on window-function results post-windowing. */
  qualify?: Expr
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
  | AlterTableStmt
  | DropTableStmt
  | CreateViewStmt
  | DropViewStmt
  | CreateIndexStmt
  | AnalyzeStmt
  | InsertStmt
  | UpdateStmt
  | DeleteStmt
  | SelectStmt
  | ExplainStmt
  | TxnStmt

// Aggregate function names recognised by the planner.
export const AGGREGATES = new Set([
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
  'STDDEV', 'STDDEV_SAMP', 'STDDEV_POP', 'VARIANCE', 'VAR_SAMP', 'VAR_POP',
  'STRING_AGG', 'GROUP_CONCAT', 'MEDIAN',
  'PERCENTILE_CONT', 'PERCENTILE_DISC', 'MODE',
  'JSON_AGG', 'JSON_OBJECT_AGG',
])

/** Ordered-set aggregates: their value to aggregate comes from a
 *  `WITHIN GROUP (ORDER BY …)` clause rather than the parenthesized arguments. */
export const ORDERED_SET_AGGREGATES = new Set(['PERCENTILE_CONT', 'PERCENTILE_DISC', 'MODE'])

export function isAggregate(name: string): boolean {
  return AGGREGATES.has(name.toUpperCase())
}
