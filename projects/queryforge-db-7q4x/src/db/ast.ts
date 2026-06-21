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
  // Array overlap.
  | '&&'

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
  /** Element type for an array cast `CAST(x AS INTEGER[])` / `x::int[]`. */
  elemType?: ColumnType
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
/** `expr <op> ANY|ALL (<array>)` — the array-operand form of the quantified
 *  comparison (e.g. `5 = ANY(tags)`), distinct from the subquery form above. */
export interface QuantifiedArrayExpr {
  kind: 'quantified_array'
  op: '=' | '<>' | '<' | '<=' | '>' | '>='
  quantifier: 'ANY' | 'ALL'
  expr: Expr
  array: Expr
}
/** `ARRAY[e1, e2, …]` — an array constructor. */
export interface ArrayExpr {
  kind: 'array'
  elements: Expr[]
}
/** `base[index]` (subscript) or `base[lower:upper]` (slice). For a slice either
 *  bound may be omitted (`base[:n]`, `base[n:]`), defaulting to the array ends. */
export interface SubscriptExpr {
  kind: 'subscript'
  base: Expr
  /** Present for both subscript and slice (the lower bound). */
  index?: Expr
  /** Present only for a slice (the upper bound); `slice` flags slice syntax. */
  upper?: Expr
  slice: boolean
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
  | QuantifiedArrayExpr
  | ArrayExpr
  | SubscriptExpr
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
  /** Element type for an array column `INTEGER[]` (type is then 'ARRAY'). */
  elemType?: ColumnType
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
  /** `RETURNING <select-list>` — project the inserted/updated rows as a result set. */
  returning?: SelectItem[]
}
export interface UpdateStmt {
  kind: 'update'
  table: string
  assignments: { column: string; value: Expr }[]
  where?: Expr
  /** `RETURNING <select-list>` — project the new row images as a result set. */
  returning?: SelectItem[]
}
export interface DeleteStmt {
  kind: 'delete'
  table: string
  where?: Expr
  /** `RETURNING <select-list>` — project the deleted (old) rows as a result set. */
  returning?: SelectItem[]
}

/** One `WHEN [NOT] MATCHED [BY SOURCE|TARGET] [AND <cond>] THEN <action>` arm of a MERGE. */
export interface MergeWhen {
  /** Which side the arm fires on: a target row matched by the source row
   *  (`matched`), a source row with no target match (`not_matched` — i.e. NOT
   *  MATCHED BY TARGET), or a target row no source row matched
   *  (`not_matched_by_source`). */
  match: 'matched' | 'not_matched' | 'not_matched_by_source'
  /** Optional extra `AND <condition>` gating this arm. */
  condition?: Expr
  action:
    | { kind: 'update'; assignments: { column: string; value: Expr }[] }
    | { kind: 'delete' }
    | { kind: 'insert'; columns?: string[]; values?: Expr[]; defaultValues?: boolean }
    | { kind: 'nothing' }
}

/** `MERGE INTO target [AS a] USING source [AS s] ON <cond> WHEN … THEN … [RETURNING …]`. */
export interface MergeStmt {
  kind: 'merge'
  target: string
  targetAlias?: string
  /** The data source: a table, derived table, table function, or VALUES. */
  source: FromItem
  on: Expr
  whens: MergeWhen[]
  returning?: SelectItem[]
}

/** `TRUNCATE TABLE t [, …] [RESTART IDENTITY] [CASCADE]`. */
export interface TruncateStmt {
  kind: 'truncate'
  tables: string[]
  restartIdentity: boolean
  cascade: boolean
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
  /** `LATERAL` — this item may reference columns of the FROM items to its left,
   *  evaluated per outer row by a correlated nested loop. */
  lateral?: boolean
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
  /** `JOIN LATERAL …` — the right side may reference the left side's columns. */
  lateral?: boolean
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
  /** `SELECT … INTO [STRICT] v1, v2 …` — a PL/QF extension. Only meaningful when
   *  the query runs inside a procedural body; a top-level query ignores it. */
  into?: { targets: string[]; strict: boolean }
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
  action: 'begin' | 'commit' | 'rollback' | 'savepoint' | 'release' | 'rollback_to'
  /** Savepoint name for `savepoint` / `release` / `rollback_to`. */
  savepoint?: string
}
/** `SET name = value` / `SET name TO value` / `RESET name` (value === null ⇒ reset
 *  the setting to its default). A session-configuration knob — e.g. `work_mem`. */
export interface SetStmt {
  kind: 'set'
  name: string
  /** The new integer value, or null for `RESET` / `SET … TO DEFAULT`. */
  value: number | null
}
/** `SHOW name` — report the current value of a session setting as a 1×1 result. */
export interface ShowStmt {
  kind: 'show'
  name: string
}

// ---------------------------------------------------------------------------
// PL/QF — the procedural language (stored functions/procedures + triggers)
// ---------------------------------------------------------------------------

/** A typed reference (a parameter or a DECLARE'd variable). */
export interface TypedName {
  name: string
  type: ColumnType
  scale?: number
  elemType?: ColumnType
  /** Optional default / initial value expression. */
  default?: Expr
}

/** Severity of a `RAISE` statement. EXCEPTION aborts; the rest emit a notice. */
export type RaiseLevel = 'EXCEPTION' | 'WARNING' | 'NOTICE' | 'INFO' | 'LOG' | 'DEBUG'

/** A procedural statement inside a routine/trigger body. */
export type PlStmt =
  | { kind: 'pl_block'; declares: TypedName[]; body: PlStmt[] }
  | { kind: 'pl_assign'; target: string; field?: string; value: Expr }
  | { kind: 'pl_return'; value?: Expr }
  | { kind: 'pl_if'; arms: { cond: Expr; body: PlStmt[] }[]; elseBody?: PlStmt[] }
  | { kind: 'pl_while'; cond: Expr; body: PlStmt[]; label?: string }
  | { kind: 'pl_loop'; body: PlStmt[]; label?: string }
  | { kind: 'pl_for_range'; var: string; lo: Expr; hi: Expr; step?: Expr; reverse: boolean; body: PlStmt[]; label?: string }
  | { kind: 'pl_for_query'; var: string; query: SelectStmt; body: PlStmt[]; label?: string }
  | { kind: 'pl_exit'; label?: string; when?: Expr }
  | { kind: 'pl_continue'; label?: string; when?: Expr }
  | { kind: 'pl_raise'; level: RaiseLevel; message?: string; args: Expr[] }
  | { kind: 'pl_perform'; query: SelectStmt }
  | { kind: 'pl_select_into'; query: SelectStmt; targets: string[]; strict: boolean }
  | { kind: 'pl_call'; name: string; args: Expr[] }
  | { kind: 'pl_sql'; statement: Statement }
  | { kind: 'pl_null' }

/** `CREATE [OR REPLACE] FUNCTION|PROCEDURE name(params) [RETURNS t] AS $$ … $$`. */
export interface CreateRoutineStmt {
  kind: 'create_routine'
  name: string
  isProcedure: boolean
  params: TypedName[]
  /** Return type; undefined for a procedure / a trigger function (see returnsTrigger). */
  returns?: { type: ColumnType; scale?: number; elemType?: ColumnType }
  /** `RETURNS TRIGGER` — a function usable as a trigger body (sees NEW/OLD). */
  returnsTrigger: boolean
  body: PlStmt
  orReplace: boolean
}
/** `DROP FUNCTION|PROCEDURE [IF EXISTS] name`. */
export interface DropRoutineStmt {
  kind: 'drop_routine'
  name: string
  isProcedure: boolean
  ifExists: boolean
}
/** `CALL name(args)` — invoke a procedure. */
export interface CallStmt {
  kind: 'call'
  name: string
  args: Expr[]
}
/** `CREATE [OR REPLACE] TRIGGER name {BEFORE|AFTER} {INSERT|UPDATE|DELETE [OR …]}
 *  ON table FOR EACH ROW [WHEN (cond)] EXECUTE FUNCTION f()`. */
export interface CreateTriggerStmt {
  kind: 'create_trigger'
  name: string
  timing: 'BEFORE' | 'AFTER'
  events: ('INSERT' | 'UPDATE' | 'DELETE')[]
  table: string
  when?: Expr
  functionName: string
  orReplace: boolean
}
/** `DROP TRIGGER [IF EXISTS] name [ON table]`. */
export interface DropTriggerStmt {
  kind: 'drop_trigger'
  name: string
  table?: string
  ifExists: boolean
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
  | MergeStmt
  | TruncateStmt
  | SelectStmt
  | ExplainStmt
  | TxnStmt
  | SetStmt
  | ShowStmt
  | CreateRoutineStmt
  | DropRoutineStmt
  | CallStmt
  | CreateTriggerStmt
  | DropTriggerStmt

// Aggregate function names recognised by the planner.
export const AGGREGATES = new Set([
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
  'STDDEV', 'STDDEV_SAMP', 'STDDEV_POP', 'VARIANCE', 'VAR_SAMP', 'VAR_POP',
  'STRING_AGG', 'GROUP_CONCAT', 'MEDIAN',
  'PERCENTILE_CONT', 'PERCENTILE_DISC', 'MODE',
  'JSON_AGG', 'JSON_OBJECT_AGG',
  'ARRAY_AGG',
])

/** Ordered-set aggregates: their value to aggregate comes from a
 *  `WITHIN GROUP (ORDER BY …)` clause rather than the parenthesized arguments. */
export const ORDERED_SET_AGGREGATES = new Set(['PERCENTILE_CONT', 'PERCENTILE_DISC', 'MODE'])

export function isAggregate(name: string): boolean {
  return AGGREGATES.has(name.toUpperCase())
}
