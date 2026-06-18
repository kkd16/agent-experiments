// Recursive-descent parser with a Pratt (precedence-climbing) expression
// sub-parser. Produces the AST defined in ast.ts.

import {
  tokenize,
  identName,
  stringValue,
  type Token,
} from './lexer'
import { SCALAR_FUNCTION_NAMES, exprKey } from './eval'
import { SqlError, type ColumnType, type SqlValue } from './types'
import { parseDate, parseTime, parseTimestamp, parseInterval } from './temporal'
import { parseDecimal as parseDecimalLit } from './decimal'
import { emptyConstraints } from './ast'
import type {
  BinaryOp,
  CheckConstraint,
  ColumnDef,
  CteDef,
  Expr,
  ExplainStmt,
  ForeignKeyDef,
  FromItem,
  JoinClause,
  JoinType,
  NamedWindow,
  OnConflictClause,
  OrderItem,
  WindowSpec,
  FrameExclude,
  RefAction,
  SelectItem,
  SelectStmt,
  SetOp,
  SetOpKind,
  Statement,
  TableConstraints,
} from './ast'

// Binary operator precedence (higher binds tighter).
const PRECEDENCE: Record<string, number> = {
  OR: 1,
  AND: 2,
  '=': 4, '<>': 4, '<': 4, '<=': 4, '>': 4, '>=': 4,
  // JSON containment / existence + the full-text `@@` match sit at the
  // comparison level (they're boolean).
  '@>': 4, '<@': 4, '?': 4, '@@': 4,
  '||': 5,
  '+': 6, '-': 6,
  '*': 7, '/': 7, '%': 7,
  // JSON path extraction binds tighter than arithmetic, like a field access.
  '->': 8, '->>': 8, '#>': 8, '#>>': 8,
}

// Comparison-family keywords that act at precedence 4 (NOT/IS/IN/LIKE/BETWEEN).
const COMPARISON_PREC = 4

class Parser {
  private readonly toks: Token[]
  private pos = 0

  constructor(toks: Token[]) {
    this.toks = toks
  }

  private peek(o = 0): Token {
    return this.toks[Math.min(this.pos + o, this.toks.length - 1)]
  }
  private next(): Token {
    return this.toks[this.pos++]
  }
  private at(value: string): boolean {
    return this.peek().value === value && this.peek().kind !== 'string'
  }
  private atKind(kind: Token['kind']): boolean {
    return this.peek().kind === kind
  }
  private accept(value: string): boolean {
    if (this.at(value)) {
      this.pos++
      return true
    }
    return false
  }
  private expect(value: string): Token {
    if (!this.at(value)) {
      const t = this.peek()
      throw new SqlError(
        `expected ${JSON.stringify(value)} but found ${t.kind === 'eof' ? 'end of input' : JSON.stringify(t.text)} at line ${t.line}, col ${t.col}`,
        'parse',
      )
    }
    return this.next()
  }
  private err(msg: string): SqlError {
    const t = this.peek()
    return new SqlError(`${msg} (near ${t.kind === 'eof' ? 'end of input' : JSON.stringify(t.text)}, line ${t.line})`, 'parse')
  }

  // --- name helpers -------------------------------------------------------
  private parseIdent(what = 'identifier'): string {
    const t = this.peek()
    if (t.kind === 'ident') {
      this.pos++
      return identName(t)
    }
    // Allow some non-reserved keywords as identifiers where unambiguous.
    throw this.err(`expected ${what}`)
  }

  // ========================================================================
  // Statements
  // ========================================================================
  parseProgram(): Statement[] {
    const stmts: Statement[] = []
    while (!this.atKind('eof')) {
      if (this.accept(';')) continue
      stmts.push(this.parseStatement())
      if (!this.atKind('eof')) {
        if (!this.accept(';')) throw this.err('expected ";" between statements')
      }
    }
    return stmts
  }

  parseStatement(): Statement {
    const kw = this.peek().value
    switch (kw) {
      case 'SELECT':
        return this.parseSelect()
      case 'VALUES': {
        const stmt = this.valuesToSelect(this.parseValuesRows())
        this.parseTail(stmt)
        return stmt
      }
      case 'WITH':
        return this.parseWith()
      case 'INSERT':
        return this.parseInsert()
      case 'UPDATE':
        return this.parseUpdate()
      case 'DELETE':
        return this.parseDelete()
      case 'CREATE':
        return this.parseCreate()
      case 'ALTER':
        return this.parseAlter()
      case 'DROP':
        return this.parseDrop()
      case 'EXPLAIN':
        return this.parseExplain()
      case 'ANALYZE':
        return this.parseAnalyze()
      case 'BEGIN':
      case 'COMMIT':
      case 'ROLLBACK':
        return this.parseTxn()
      default:
        throw this.err(`unexpected statement; expected SELECT/INSERT/UPDATE/DELETE/CREATE/DROP/EXPLAIN`)
    }
  }

  private parseTxn(): Statement {
    const t = this.next().value
    this.accept('TRANSACTION')
    if (t === 'BEGIN') return { kind: 'txn', action: 'begin' }
    if (t === 'COMMIT') return { kind: 'txn', action: 'commit' }
    return { kind: 'txn', action: 'rollback' }
  }

  private parseExplain(): ExplainStmt {
    this.expect('EXPLAIN')
    const analyze = this.accept('ANALYZE')
    return { kind: 'explain', analyze, statement: this.parseStatement() }
  }

  private parseAnalyze(): Statement {
    this.expect('ANALYZE')
    let table: string | undefined
    if (this.atKind('ident')) table = this.parseIdent('table name')
    return { kind: 'analyze', table }
  }

  private parseTypeName(): { type: ColumnType; precision?: number; scale?: number } {
    const t = this.next().value
    switch (t) {
      case 'INTEGER':
      case 'INT':
        return { type: 'INTEGER' }
      case 'REAL':
      case 'FLOAT':
        return { type: 'REAL' }
      case 'DECIMAL':
      case 'NUMERIC':
      case 'DEC': {
        // Optional DECIMAL(precision) / DECIMAL(precision, scale).
        let precision: number | undefined
        let scale: number | undefined
        if (this.accept('(')) {
          precision = this.parseUintToken('precision')
          if (this.accept(',')) scale = this.parseUintToken('scale')
          this.expect(')')
        }
        return { type: 'DECIMAL', precision, scale }
      }
      case 'TEXT':
      case 'STRING':
        return { type: 'TEXT' }
      case 'BOOLEAN':
      case 'BOOL':
        return { type: 'BOOLEAN' }
      case 'DATE':
        return { type: 'DATE' }
      case 'TIME':
        return { type: 'TIME' }
      case 'TIMESTAMP':
      case 'DATETIME':
        return { type: 'TIMESTAMP' }
      case 'INTERVAL':
        return { type: 'INTERVAL' }
      case 'JSON':
      case 'JSONB':
        return { type: 'JSON' }
      case 'TSVECTOR':
        return { type: 'TSVECTOR' }
      case 'TSQUERY':
        return { type: 'TSQUERY' }
      default:
        throw this.err('expected a column type (INTEGER, REAL, DECIMAL, TEXT, BOOLEAN, DATE, TIME, TIMESTAMP, INTERVAL, JSON, TSVECTOR, TSQUERY)')
    }
  }

  /** Parse a bare non-negative integer token (DECIMAL precision / scale). */
  private parseUintToken(what: string): number {
    const tok = this.next()
    if (tok.kind !== 'number' || !/^\d+$/.test(tok.value)) throw this.err(`expected an integer ${what}`)
    return Number(tok.value)
  }

  private parseCreate(): Statement {
    this.expect('CREATE')
    // CREATE OR REPLACE VIEW …
    if (this.at('OR')) {
      this.expect('OR')
      this.expect('REPLACE')
      return this.parseCreateView(true)
    }
    if (this.at('VIEW')) return this.parseCreateView(false)
    if (this.at('TABLE')) return this.parseCreateTable()
    if (this.at('INDEX') || this.at('UNIQUE')) return this.parseCreateIndex()
    throw this.err('expected TABLE, VIEW or INDEX after CREATE')
  }

  private parseCreateView(orReplace: boolean): Statement {
    this.expect('VIEW')
    const ifNotExists = this.parseIfNotExists()
    const name = this.parseIdent('view name')
    let columns: string[] | undefined
    if (this.at('(')) columns = this.parseColumnList()
    this.expect('AS')
    const select = this.parseSubquerySelect()
    return { kind: 'create_view', name, columns, select, orReplace, ifNotExists }
  }

  private parseCreateTable(): Statement {
    this.expect('TABLE')
    const ifNotExists = this.parseIfNotExists()
    const name = this.parseIdent('table name')
    this.expect('(')
    const columns: ColumnDef[] = []
    const constraints: TableConstraints = emptyConstraints()
    do {
      // A table element is either a table-level constraint or a column def.
      if (this.atTableConstraint()) this.parseTableConstraint(constraints)
      else this.parseColumnDef(columns, constraints)
    } while (this.accept(','))
    this.expect(')')
    return { kind: 'create_table', name, columns, constraints, ifNotExists }
  }

  /** Does the next token begin a *table-level* constraint (vs. a column def)? */
  private atTableConstraint(): boolean {
    return (
      this.at('CONSTRAINT') ||
      this.at('PRIMARY') ||
      this.at('FOREIGN') ||
      this.at('CHECK') ||
      this.at('UNIQUE')
    )
  }

  private parseTableConstraint(c: TableConstraints): void {
    let name: string | undefined
    if (this.accept('CONSTRAINT')) name = this.parseIdent('constraint name')
    if (this.accept('PRIMARY')) {
      this.expect('KEY')
      if (c.primaryKey) throw this.err('a table may have only one PRIMARY KEY')
      c.primaryKey = this.parseColumnList()
    } else if (this.accept('UNIQUE')) {
      c.uniques.push(this.parseColumnList())
    } else if (this.accept('CHECK')) {
      c.checks.push({ name, expr: this.parseParenExpr() })
    } else if (this.accept('FOREIGN')) {
      this.expect('KEY')
      const columns = this.parseColumnList()
      c.foreignKeys.push(this.parseReferences(name, columns))
    } else {
      throw this.err('expected a table constraint (PRIMARY KEY / UNIQUE / CHECK / FOREIGN KEY)')
    }
  }

  /** Parse the `REFERENCES parent[(cols)] [ON DELETE …] [ON UPDATE …]` tail. */
  private parseReferences(name: string | undefined, columns: string[]): ForeignKeyDef {
    this.expect('REFERENCES')
    const refTable = this.parseIdent('referenced table')
    const refColumns = this.at('(') ? this.parseColumnList() : []
    let onDelete: RefAction = 'NO ACTION'
    let onUpdate: RefAction = 'NO ACTION'
    while (this.accept('ON')) {
      if (this.accept('DELETE')) onDelete = this.parseRefAction()
      else if (this.accept('UPDATE')) onUpdate = this.parseRefAction()
      else throw this.err('expected DELETE or UPDATE after ON')
    }
    return { name, columns, refTable, refColumns, onDelete, onUpdate }
  }

  private parseRefAction(): RefAction {
    if (this.accept('CASCADE')) return 'CASCADE'
    if (this.accept('RESTRICT')) return 'RESTRICT'
    if (this.accept('NO')) {
      this.expect('ACTION')
      return 'NO ACTION'
    }
    if (this.accept('SET')) {
      if (this.accept('NULL')) return 'SET NULL'
      if (this.accept('DEFAULT')) return 'SET DEFAULT'
      throw this.err('expected NULL or DEFAULT after SET')
    }
    throw this.err('expected a referential action (CASCADE / RESTRICT / NO ACTION / SET NULL / SET DEFAULT)')
  }

  private parseColumnList(): string[] {
    this.expect('(')
    const cols: string[] = []
    do {
      cols.push(this.parseIdent('column name'))
    } while (this.accept(','))
    this.expect(')')
    return cols
  }

  private parseParenExpr(): Expr {
    this.expect('(')
    const e = this.parseExpr()
    this.expect(')')
    return e
  }

  private parseIfNotExists(): boolean {
    if (this.accept('IF')) {
      this.expect('NOT')
      this.expect('EXISTS')
      return true
    }
    return false
  }

  /** Parse one column definition, folding any inline constraints into `c`. */
  private parseColumnDef(columns: ColumnDef[], c: TableConstraints): void {
    const name = this.parseIdent('column name')
    const ty = this.parseTypeName()
    const def: ColumnDef = {
      name,
      type: ty.type,
      primaryKey: false,
      notNull: false,
      unique: false,
      ...(ty.precision !== undefined ? { precision: ty.precision } : {}),
      ...(ty.scale !== undefined ? { scale: ty.scale } : {}),
    }
    for (;;) {
      if (this.accept('CONSTRAINT')) {
        // A named inline constraint; the name is attached to whatever follows.
        const cname = this.parseIdent('constraint name')
        this.parseInlineConstraint(def, c, cname)
      } else if (this.atInlineConstraint()) {
        this.parseInlineConstraint(def, c, undefined)
      } else {
        break
      }
    }
    columns.push(def)
  }

  private atInlineConstraint(): boolean {
    return (
      this.at('PRIMARY') ||
      this.at('NOT') ||
      this.at('NULL') ||
      this.at('UNIQUE') ||
      this.at('DEFAULT') ||
      this.at('CHECK') ||
      this.at('REFERENCES')
    )
  }

  private parseInlineConstraint(def: ColumnDef, c: TableConstraints, name: string | undefined): void {
    if (this.accept('PRIMARY')) {
      this.expect('KEY')
      def.primaryKey = true
      def.notNull = true
    } else if (this.accept('NOT')) {
      this.expect('NULL')
      def.notNull = true
    } else if (this.accept('NULL')) {
      // An explicit NULL-ability marker; no-op (the default).
    } else if (this.accept('UNIQUE')) {
      def.unique = true
    } else if (this.accept('DEFAULT')) {
      def.default = this.parseDefaultValue()
    } else if (this.accept('CHECK')) {
      c.checks.push({ name, expr: this.parseParenExpr() })
    } else if (this.accept('REFERENCES')) {
      // Column-level FK: rewind so parseReferences can consume REFERENCES.
      this.pos--
      c.foreignKeys.push(this.parseReferences(name, [def.name]))
    } else {
      throw this.err('expected a column constraint')
    }
  }

  /** A DEFAULT value: a (possibly signed/parenthesised) term — restricted so it
   *  never swallows a following `NOT NULL` or another column constraint. */
  private parseDefaultValue(): Expr {
    return this.parseUnary()
  }

  private parseAlter(): Statement {
    this.expect('ALTER')
    this.expect('TABLE')
    const table = this.parseIdent('table name')
    if (this.accept('RENAME')) {
      if (this.accept('TO')) return { kind: 'alter_table', table, action: { kind: 'rename_table', to: this.parseIdent('new table name') } }
      this.accept('COLUMN')
      const column = this.parseIdent('column name')
      this.expect('TO')
      return { kind: 'alter_table', table, action: { kind: 'rename_column', column, to: this.parseIdent('new column name') } }
    }
    if (this.accept('DROP')) {
      this.accept('COLUMN')
      return { kind: 'alter_table', table, action: { kind: 'drop_column', column: this.parseIdent('column name') } }
    }
    if (this.accept('ADD')) {
      // ADD <table-constraint> | ADD [COLUMN] <column-def>
      let name: string | undefined
      if (this.accept('CONSTRAINT')) name = this.parseIdent('constraint name')
      if (this.accept('CHECK')) {
        const check: CheckConstraint = { name, expr: this.parseParenExpr() }
        return { kind: 'alter_table', table, action: { kind: 'add_check', check } }
      }
      if (this.accept('UNIQUE')) {
        return { kind: 'alter_table', table, action: { kind: 'add_unique', columns: this.parseColumnList() } }
      }
      if (this.accept('FOREIGN')) {
        this.expect('KEY')
        const columns = this.parseColumnList()
        const fk = this.parseReferences(name, columns)
        return { kind: 'alter_table', table, action: { kind: 'add_foreign_key', fk } }
      }
      if (name !== undefined) throw this.err('expected CHECK / UNIQUE / FOREIGN KEY after CONSTRAINT name')
      this.accept('COLUMN')
      const columns: ColumnDef[] = []
      const scratch = emptyConstraints()
      this.parseColumnDef(columns, scratch)
      return { kind: 'alter_table', table, action: { kind: 'add_column', column: columns[0] } }
    }
    throw this.err('expected ADD / DROP / RENAME after ALTER TABLE')
  }

  private parseCreateIndex(): Statement {
    const unique = this.accept('UNIQUE')
    this.expect('INDEX')
    const ifNotExists = this.parseIfNotExists()
    const name = this.parseIdent('index name')
    this.expect('ON')
    const table = this.parseIdent('table name')
    // Optional access method: `USING gin` / `USING btree`.
    let using: string | undefined
    if (this.accept('USING')) using = this.parseIdent('index method').toUpperCase()
    this.expect('(')
    const columns: string[] = []
    do {
      columns.push(this.parseIdent('column name'))
    } while (this.accept(','))
    this.expect(')')
    return { kind: 'create_index', name, table, columns, unique, ifNotExists, using }
  }

  private parseDrop(): Statement {
    this.expect('DROP')
    if (this.accept('VIEW')) {
      const ifExists = this.accept('IF') ? (this.expect('EXISTS'), true) : false
      const name = this.parseIdent('view name')
      return { kind: 'drop_view', name, ifExists }
    }
    this.expect('TABLE')
    const ifExists = this.accept('IF') ? (this.expect('EXISTS'), true) : false
    const name = this.parseIdent('table name')
    return { kind: 'drop_table', name, ifExists }
  }

  private parseInsert(): Statement {
    this.expect('INSERT')
    this.expect('INTO')
    const table = this.parseIdent('table name')
    let columns: string[] | undefined
    if (this.accept('(')) {
      columns = []
      do {
        columns.push(this.parseIdent('column name'))
      } while (this.accept(','))
      this.expect(')')
    }
    // INSERT … SELECT
    if (this.at('SELECT') || this.at('WITH')) {
      const select = this.parseSubquerySelect()
      const onConflict = this.parseOnConflict()
      return { kind: 'insert', table, columns, rows: [], select, onConflict }
    }
    this.expect('VALUES')
    const rows: Expr[][] = []
    do {
      this.expect('(')
      const row: Expr[] = []
      do {
        row.push(this.parseExpr())
      } while (this.accept(','))
      this.expect(')')
      rows.push(row)
    } while (this.accept(','))
    const onConflict = this.parseOnConflict()
    return { kind: 'insert', table, columns, rows, onConflict }
  }

  /** Parse an optional `ON CONFLICT [(cols)] DO NOTHING | DO UPDATE SET … [WHERE …]`. */
  private parseOnConflict(): OnConflictClause | undefined {
    if (!this.accept('ON')) return undefined
    this.expect('CONFLICT')
    let target: string[] | undefined
    if (this.at('(')) target = this.parseColumnList()
    this.expect('DO')
    if (this.accept('NOTHING')) {
      return { target, action: { kind: 'nothing' } }
    }
    this.expect('UPDATE')
    this.expect('SET')
    const assignments: { column: string; value: Expr }[] = []
    do {
      const column = this.parseIdent('column name')
      this.expect('=')
      assignments.push({ column, value: this.parseExpr() })
    } while (this.accept(','))
    const where = this.accept('WHERE') ? this.parseExpr() : undefined
    return { target, action: { kind: 'update', assignments, where } }
  }

  private parseUpdate(): Statement {
    this.expect('UPDATE')
    const table = this.parseIdent('table name')
    this.expect('SET')
    const assignments: { column: string; value: Expr }[] = []
    do {
      const column = this.parseIdent('column name')
      this.expect('=')
      assignments.push({ column, value: this.parseExpr() })
    } while (this.accept(','))
    const where = this.accept('WHERE') ? this.parseExpr() : undefined
    return { kind: 'update', table, assignments, where }
  }

  private parseDelete(): Statement {
    this.expect('DELETE')
    this.expect('FROM')
    const table = this.parseIdent('table name')
    const where = this.accept('WHERE') ? this.parseExpr() : undefined
    return { kind: 'delete', table, where }
  }

  // ========================================================================
  // SELECT (with WITH-prefix, compound set operations, and a trailing tail)
  // ========================================================================
  private parseWith(): SelectStmt {
    this.expect('WITH')
    const recursive = this.accept('RECURSIVE')
    const ctes: CteDef[] = []
    do {
      const name = this.parseIdent('CTE name')
      let columns: string[] | undefined
      if (this.accept('(')) {
        columns = []
        do {
          columns.push(this.parseIdent('column name'))
        } while (this.accept(','))
        this.expect(')')
      }
      this.expect('AS')
      this.expect('(')
      const select = this.parseSubquerySelect()
      this.expect(')')
      ctes.push({ name, columns, select })
    } while (this.accept(','))
    const stmt = this.parseSelect()
    stmt.ctes = ctes
    stmt.recursive = recursive
    return stmt
  }

  /** A query that may itself begin with WITH or VALUES (used inside parens). */
  private parseSubquerySelect(): SelectStmt {
    if (this.at('WITH')) return this.parseWith()
    if (this.at('VALUES')) {
      const stmt = this.valuesToSelect(this.parseValuesRows())
      this.parseTail(stmt)
      return stmt
    }
    return this.parseSelect()
  }

  // VALUES (…), (…), … — a row-set literal. Parsed into a list of constant rows.
  private parseValuesRows(): Expr[][] {
    this.expect('VALUES')
    const rows: Expr[][] = []
    do {
      this.expect('(')
      const row: Expr[] = []
      do {
        row.push(this.parseExpr())
      } while (this.accept(','))
      this.expect(')')
      if (rows.length && row.length !== rows[0].length) {
        throw this.err('every VALUES row must have the same number of columns')
      }
      rows.push(row)
    } while (this.accept(','))
    return rows
  }

  // Desugar a VALUES row-set into a UNION ALL of constant SELECTs, so the rest
  // of the engine (derived tables, set-op type unification) handles it for free.
  private valuesToSelect(rows: Expr[][]): SelectStmt {
    const core = (row: Expr[], nameCols: boolean): SelectStmt => ({
      kind: 'select',
      distinct: false,
      columns: row.map((expr, ci) => ({ expr, alias: nameCols ? `column${ci + 1}` : undefined })),
      joins: [],
      groupBy: [],
      orderBy: [],
      limit: undefined,
      offset: undefined,
    })
    const first = core(rows[0], true)
    if (rows.length > 1) {
      first.setOps = rows.slice(1).map((r) => ({ op: 'UNION' as const, all: true, select: core(r, false) }))
    }
    return first
  }

  private parseSelect(): SelectStmt {
    const first = this.parseSelectCore()
    const setOps: SetOp[] = []
    for (;;) {
      let op: SetOpKind
      if (this.accept('UNION')) op = 'UNION'
      else if (this.accept('INTERSECT')) op = 'INTERSECT'
      else if (this.accept('EXCEPT')) op = 'EXCEPT'
      else break
      const all = this.accept('ALL')
      if (!all) this.accept('DISTINCT')
      setOps.push({ op, all, select: this.parseSelectCore() })
    }
    this.parseTail(first)
    if (setOps.length) first.setOps = setOps
    return first
  }

  // One SELECT branch: everything up to (but not including) ORDER BY/LIMIT.
  private parseSelectCore(): SelectStmt {
    this.expect('SELECT')
    const distinct = this.accept('DISTINCT')
    if (!distinct) this.accept('ALL') // SELECT ALL is the (default) opposite of DISTINCT
    const columns = this.parseSelectList()

    let from: SelectStmt['from']
    const joins: JoinClause[] = []
    if (this.accept('FROM')) {
      from = this.parseFromItem()
      for (;;) {
        const join = this.tryParseJoin()
        if (!join) break
        joins.push(join)
      }
    }

    const where = this.accept('WHERE') ? this.parseExpr() : undefined

    let groupBy: Expr[] = []
    let groupingSets: Expr[][] | undefined
    if (this.accept('GROUP')) {
      this.expect('BY')
      const parsed = this.parseGroupBy()
      groupBy = parsed.groupBy
      groupingSets = parsed.groupingSets
    }
    const having = this.accept('HAVING') ? this.parseExpr() : undefined

    // WINDOW w AS (spec), … — named window definitions referenced by `OVER w`.
    let windows: NamedWindow[] | undefined
    if (this.at('WINDOW') && this.peek(2).value === 'AS') {
      windows = this.parseWindowClause()
    }

    return {
      kind: 'select',
      distinct,
      columns,
      from,
      joins,
      where,
      groupBy,
      groupingSets,
      having,
      windows,
      orderBy: [],
      limit: undefined,
      offset: undefined,
    }
  }

  // GROUP BY <element>, … where each element is a plain expression or one of the
  // multidimensional forms ROLLUP(…) / CUBE(…) / GROUPING SETS(…). We expand the
  // elements into a flat list of grouping sets (their cross product) and a
  // deduplicated union of all grouping expressions (`groupBy`).
  private parseGroupBy(): { groupBy: Expr[]; groupingSets?: Expr[][] } {
    // Each element contributes a list of "partial sets" (each a list of exprs);
    // the final grouping sets are the cross product of every element's list.
    const elementSets: Expr[][][] = []
    let multidimensional = false
    do {
      if (this.at('ROLLUP') && this.peek(1).value === '(') {
        this.next()
        const cols = this.parseParenExprList()
        // ROLLUP(a,b,c) → (a,b,c),(a,b),(a),()
        const sets: Expr[][] = []
        for (let k = cols.length; k >= 0; k--) sets.push(cols.slice(0, k))
        elementSets.push(sets)
        multidimensional = true
      } else if (this.at('CUBE') && this.peek(1).value === '(') {
        this.next()
        const cols = this.parseParenExprList()
        elementSets.push(powerSet(cols))
        multidimensional = true
      } else if (this.at('GROUPING') && this.peek(1).value === 'SETS') {
        this.next() // GROUPING
        this.next() // SETS
        this.expect('(')
        const sets: Expr[][] = []
        do {
          if (this.at('(')) sets.push(this.parseParenExprList())
          else sets.push([this.parseExpr()])
        } while (this.accept(','))
        this.expect(')')
        elementSets.push(sets)
        multidimensional = true
      } else {
        // A plain grouping expression: always present (a single partial set).
        elementSets.push([[this.parseExpr()]])
      }
    } while (this.accept(','))

    // Cross product of the per-element partial-set lists.
    let combos: Expr[][] = [[]]
    for (const sets of elementSets) {
      const next: Expr[][] = []
      for (const combo of combos) for (const s of sets) next.push([...combo, ...s])
      combos = next
    }

    // Deduplicate all grouping expressions into the union `groupBy`.
    const groupBy: Expr[] = []
    const seen = new Map<string, Expr>()
    for (const set of combos) {
      for (const ex of set) {
        const k = exprKey(ex)
        if (!seen.has(k)) {
          seen.set(k, ex)
          groupBy.push(ex)
        }
      }
    }
    return multidimensional ? { groupBy, groupingSets: combos } : { groupBy }
  }

  private parseParenExprList(): Expr[] {
    this.expect('(')
    const list: Expr[] = []
    if (!this.at(')')) {
      do {
        list.push(this.parseExpr())
      } while (this.accept(','))
    }
    this.expect(')')
    return list
  }

  // ORDER BY / LIMIT / OFFSET — bind to the whole (possibly compound) query.
  private parseTail(stmt: SelectStmt): void {
    if (this.accept('ORDER')) {
      this.expect('BY')
      const orderBy: OrderItem[] = []
      do {
        const expr = this.parseExpr()
        const dir = this.accept('DESC') ? 'DESC' : (this.accept('ASC'), 'ASC')
        orderBy.push({ expr, dir })
      } while (this.accept(','))
      stmt.orderBy = orderBy
    }
    if (this.accept('LIMIT')) {
      stmt.limit = this.parseIntLiteral('LIMIT')
      if (this.accept('OFFSET')) stmt.offset = this.parseIntLiteral('OFFSET')
    }
    if (this.accept('OFFSET')) stmt.offset = this.parseIntLiteral('OFFSET')
  }

  private parseIntLiteral(what: string): number {
    const t = this.peek()
    if (t.kind !== 'number') throw this.err(`expected integer after ${what}`)
    this.pos++
    return Math.trunc(Number(t.text))
  }

  private parseSelectList(): SelectItem[] {
    const items: SelectItem[] = []
    do {
      if (this.at('*')) {
        this.next()
        items.push({ expr: { kind: 'star' } })
        continue
      }
      // table.* form
      if (this.atKind('ident') && this.peek(1).value === '.' && this.peek(2).value === '*') {
        const table = identName(this.next())
        this.next() // .
        this.next() // *
        items.push({ expr: { kind: 'star', table } })
        continue
      }
      const expr = this.parseExpr()
      let alias: string | undefined
      if (this.accept('AS')) alias = this.parseIdent('alias')
      else if (this.atKind('ident')) alias = identName(this.next())
      items.push({ expr, alias })
    } while (this.accept(','))
    return items
  }

  private parseFromItem(): FromItem {
    if (this.at('(')) {
      this.next()
      const subquery = this.parseSubquerySelect()
      this.expect(')')
      const { alias, columnAliases } = this.parseOptionalAliasWithColumns()
      return { subquery, alias, columnAliases }
    }
    // A set-returning table function: `name(args) [AS] alias [(cols)]`.
    if (this.atTableFunc()) {
      const tableFunc = this.parseTableFuncRef()
      const { alias, columnAliases } = this.parseOptionalAliasWithColumns()
      return { tableFunc, alias, columnAliases }
    }
    const table = this.parseIdent('table name')
    const { alias, columnAliases } = this.parseOptionalAliasWithColumns()
    return { table, alias, columnAliases }
  }

  /** A FROM source that's a function call (`ident(` or a function keyword). */
  private atTableFunc(): boolean {
    const t = this.peek()
    return this.peek(1).value === '(' && (t.kind === 'ident' || this.isFunctionName(t.value))
  }

  private parseTableFuncRef(): { name: string; args: Expr[] } {
    const nameTok = this.next()
    const name = (nameTok.kind === 'ident' ? identName(nameTok) : nameTok.value).toUpperCase()
    this.expect('(')
    const args: Expr[] = []
    if (!this.at(')')) {
      do {
        args.push(this.parseExpr())
      } while (this.accept(','))
    }
    this.expect(')')
    return { name, args }
  }

  private parseOptionalAlias(): string | undefined {
    if (this.accept('AS')) return this.parseIdent('alias')
    if (this.atKind('ident')) return identName(this.next())
    return undefined
  }

  // An optional relation alias plus optional column aliases: `t (x, y)`.
  private parseOptionalAliasWithColumns(): { alias?: string; columnAliases?: string[] } {
    const alias = this.parseOptionalAlias()
    if (!alias || !this.at('(')) return { alias }
    this.next()
    const columnAliases: string[] = []
    do {
      columnAliases.push(this.parseIdent('column alias'))
    } while (this.accept(','))
    this.expect(')')
    return { alias, columnAliases }
  }

  private tryParseJoin(): JoinClause | null {
    let type: JoinType
    if (this.accept('CROSS')) {
      this.expect('JOIN')
      type = 'CROSS'
    } else if (this.accept('INNER')) {
      this.expect('JOIN')
      type = 'INNER'
    } else if (this.accept('LEFT')) {
      this.accept('OUTER')
      this.expect('JOIN')
      type = 'LEFT'
    } else if (this.accept('RIGHT')) {
      this.accept('OUTER')
      this.expect('JOIN')
      type = 'RIGHT'
    } else if (this.accept('FULL')) {
      this.accept('OUTER')
      this.expect('JOIN')
      type = 'FULL'
    } else if (this.accept('JOIN')) {
      type = 'INNER'
    } else {
      return null
    }
    let table: string | undefined
    let subquery: SelectStmt | undefined
    let tableFunc: { name: string; args: Expr[] } | undefined
    if (this.at('(')) {
      this.next()
      subquery = this.parseSubquerySelect()
      this.expect(')')
    } else if (this.atTableFunc()) {
      tableFunc = this.parseTableFuncRef()
    } else {
      table = this.parseIdent('table name')
    }
    const { alias, columnAliases } = this.parseOptionalAliasWithColumns()
    let on: Expr | undefined
    if (type !== 'CROSS') {
      this.expect('ON')
      on = this.parseExpr()
    }
    return { type, table, subquery, tableFunc, alias, columnAliases, on }
  }

  // ========================================================================
  // Expressions (Pratt parser)
  // ========================================================================
  parseExpr(minPrec = 0): Expr {
    let left = this.parseUnary()

    for (;;) {
      const t = this.peek()
      const v = t.value

      // Postfix `::TYPE` cast binds tighter than everything (it's a field-access
      // -like suffix), so handle it before any precedence gate.
      if (v === '::') {
        this.next()
        const ty = this.parseTypeName()
        left = { kind: 'cast', expr: left, type: ty.type, ...(ty.scale !== undefined ? { scale: ty.scale } : {}) }
        continue
      }

      // Postfix comparison forms at precedence 4.
      if (COMPARISON_PREC >= minPrec) {
        if (v === 'IS') {
          this.next()
          const negated = this.accept('NOT')
          this.expect('NULL')
          left = { kind: 'isnull', expr: left, negated }
          continue
        }
        if (v === 'NOT' && this.peek(1).value === 'BETWEEN') {
          this.next()
          left = this.parseBetween(left, true)
          continue
        }
        if (v === 'BETWEEN') {
          left = this.parseBetween(left, false)
          continue
        }
        if (v === 'NOT' && this.peek(1).value === 'IN') {
          this.next()
          left = this.parseIn(left, true)
          continue
        }
        if (v === 'IN') {
          left = this.parseIn(left, false)
          continue
        }
        if (v === 'NOT' && this.peek(1).value === 'LIKE') {
          this.next()
          left = this.parseLike(left, true)
          continue
        }
        if (v === 'LIKE') {
          left = this.parseLike(left, false)
          continue
        }
      }

      const prec = PRECEDENCE[v]
      if (prec === undefined || prec < minPrec) break
      // Treat only operator/keyword tokens as binary ops (not strings).
      if (t.kind === 'string') break
      this.next()
      // Quantified comparison: <op> ANY|SOME|ALL (SELECT …)
      if (
        prec === COMPARISON_PREC &&
        (this.at('ANY') || this.at('SOME') || this.at('ALL')) &&
        this.peek(1).value === '('
      ) {
        const quantifier: 'ANY' | 'ALL' = this.accept('ALL') ? 'ALL' : (this.next(), 'ANY')
        this.expect('(')
        const select = this.parseSubquerySelect()
        this.expect(')')
        left = { kind: 'quantified', op: v as '=' | '<>' | '<' | '<=' | '>' | '>=', quantifier, expr: left, select }
        continue
      }
      const right = this.parseExpr(prec + 1)
      left = { kind: 'binary', op: v as BinaryOp, left, right }
    }
    return left
  }

  private parseBetween(expr: Expr, negated: boolean): Expr {
    this.expect('BETWEEN')
    const lo = this.parseExpr(COMPARISON_PREC + 1)
    this.expect('AND')
    const hi = this.parseExpr(COMPARISON_PREC + 1)
    return { kind: 'between', expr, lo, hi, negated }
  }

  private parseIn(expr: Expr, negated: boolean): Expr {
    this.expect('IN')
    this.expect('(')
    if (this.at('SELECT') || this.at('WITH')) {
      const select = this.parseSubquerySelect()
      this.expect(')')
      return { kind: 'in_subquery', expr, select, negated }
    }
    const list: Expr[] = []
    do {
      list.push(this.parseExpr())
    } while (this.accept(','))
    this.expect(')')
    return { kind: 'in', expr, list, negated }
  }

  private parseLike(expr: Expr, negated: boolean): Expr {
    this.expect('LIKE')
    const pattern = this.parseExpr(COMPARISON_PREC + 1)
    return { kind: 'like', expr, pattern, negated }
  }

  private parseUnary(): Expr {
    if (this.accept('NOT')) return { kind: 'unary', op: 'NOT', expr: this.parseUnary() }
    if (this.at('-')) {
      this.next()
      return { kind: 'unary', op: '-', expr: this.parseUnary() }
    }
    if (this.at('+')) {
      this.next()
      return { kind: 'unary', op: '+', expr: this.parseUnary() }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): Expr {
    const t = this.peek()

    if (t.kind === 'number') {
      this.next()
      return { kind: 'literal', value: Number(t.text) }
    }
    if (t.kind === 'string') {
      this.next()
      return { kind: 'literal', value: stringValue(t) }
    }
    if (t.value === 'TRUE') {
      this.next()
      return { kind: 'literal', value: true }
    }
    if (t.value === 'FALSE') {
      this.next()
      return { kind: 'literal', value: false }
    }
    if (t.value === 'NULL') {
      this.next()
      return { kind: 'literal', value: null }
    }
    // Typed temporal literals: DATE '…', TIME '…', TIMESTAMP '…', INTERVAL '…'.
    // (Disambiguated from the DATE(x) function by the following string token.)
    if (
      (t.value === 'DATE' || t.value === 'TIME' || t.value === 'TIMESTAMP' || t.value === 'INTERVAL') &&
      this.peek(1).kind === 'string'
    ) {
      this.next()
      const lit = stringValue(this.next())
      return { kind: 'literal', value: parseTemporalLiteral(t.value, lit) }
    }
    // Typed exact-numeric literal: DECIMAL '123.45' / NUMERIC '…' / DEC '…'.
    if ((t.value === 'DECIMAL' || t.value === 'NUMERIC' || t.value === 'DEC') && this.peek(1).kind === 'string') {
      this.next()
      const lit = stringValue(this.next())
      const v = parseDecimalLit(lit)
      if (!v) throw new SqlError(`invalid DECIMAL literal: '${lit}'`, 'parse')
      return { kind: 'literal', value: v }
    }
    // Niladic temporal keywords usable without parentheses, per the SQL
    // standard: CURRENT_DATE, CURRENT_TIME, CURRENT_TIMESTAMP.
    if (
      (t.value === 'CURRENT_DATE' || t.value === 'CURRENT_TIME' || t.value === 'CURRENT_TIMESTAMP') &&
      this.peek(1).value !== '('
    ) {
      this.next()
      return { kind: 'func', name: t.value, args: [], distinct: false, star: false }
    }
    // EXTRACT(field FROM expr) — the SQL-standard spelling.
    if (t.value === 'EXTRACT' && this.peek(1).value === '(') return this.parseExtract()
    if (t.value === 'CASE') return this.parseCase()
    if (t.value === 'CAST') return this.parseCast()
    if (t.value === 'EXISTS' && this.peek(1).value === '(') {
      this.next()
      this.expect('(')
      const select = this.parseSubquerySelect()
      this.expect(')')
      return { kind: 'exists', select, negated: false }
    }
    if (this.at('(')) {
      this.next()
      // A parenthesized subquery vs. a grouped expression.
      if (this.at('SELECT') || this.at('WITH')) {
        const select = this.parseSubquerySelect()
        this.expect(')')
        return { kind: 'subquery', select }
      }
      const e = this.parseExpr()
      this.expect(')')
      return e
    }

    // Function call (including keyword-named functions like LEFT/RIGHT).
    if (this.peek(1).value === '(' && (t.kind === 'ident' || this.isFunctionName(t.value))) {
      return this.parseFunc()
    }

    // Column reference.
    if (t.kind === 'ident') {
      // qualified column table.col
      if (this.peek(1).value === '.') {
        const table = identName(this.next())
        this.next() // .
        const name = this.parseIdent('column name')
        return { kind: 'column', table, name }
      }
      this.next()
      return { kind: 'column', name: identName(t) }
    }

    throw this.err('expected an expression')
  }

  private isFunctionName(v: string): boolean {
    return this.isAggregateKeyword(v) || SCALAR_FUNCTION_NAMES.has(v)
  }
  private isAggregateKeyword(v: string): boolean {
    return v === 'COUNT' || v === 'SUM' || v === 'AVG' || v === 'MIN' || v === 'MAX'
  }

  private parseFunc(): Expr {
    const nameTok = this.next()
    const rawName = nameTok.kind === 'ident' ? identName(nameTok) : nameTok.value
    const name = rawName.toUpperCase()
    this.expect('(')
    let distinct = false
    let star = false
    const args: Expr[] = []
    if (this.at('*')) {
      this.next()
      star = true
    } else if (!this.at(')')) {
      distinct = this.accept('DISTINCT')
      do {
        args.push(this.parseExpr())
      } while (this.accept(','))
    }
    this.expect(')')

    // Ordered-set aggregate tail: WITHIN GROUP (ORDER BY <key> [ASC|DESC], …).
    // The aggregated value comes from this ORDER BY, not the call arguments
    // (which carry the percentile fraction).
    let withinGroup: OrderItem[] | undefined
    if (this.at('WITHIN') && this.peek(1).value === 'GROUP') {
      this.next() // WITHIN
      this.next() // GROUP
      this.expect('(')
      this.expect('ORDER')
      this.expect('BY')
      withinGroup = []
      do {
        const expr = this.parseExpr()
        const dir = this.accept('DESC') ? 'DESC' : (this.accept('ASC'), 'ASC')
        withinGroup.push({ expr, dir })
      } while (this.accept(','))
      this.expect(')')
    }

    // Null treatment for value/offset functions: `… IGNORE NULLS | RESPECT NULLS`.
    let ignoreNulls = false
    if (this.at('IGNORE') && this.peek(1).value === 'NULLS') {
      this.next()
      this.next()
      ignoreNulls = true
    } else if (this.at('RESPECT') && this.peek(1).value === 'NULLS') {
      this.next()
      this.next()
    }

    // Aggregate FILTER (WHERE pred) — disambiguated from a "filter" alias by the
    // required opening parenthesis.
    let filter: Expr | undefined
    if (this.at('FILTER') && this.peek(1).value === '(') {
      this.next() // FILTER
      this.expect('(')
      this.expect('WHERE')
      filter = this.parseExpr()
      this.expect(')')
    }

    // Window form: name(args) OVER ( … ) | OVER window_name
    if (this.at('OVER')) {
      this.next()
      if (this.at('(')) {
        this.expect('(')
        const spec = this.parseOverBody()
        this.expect(')')
        return { kind: 'window', name, args, spec, withinGroup, filter, ignoreNulls }
      }
      // Bare reference to a WINDOW-clause name.
      const windowRef = this.next().text.toLowerCase()
      return {
        kind: 'window',
        name,
        args,
        spec: { partitionBy: [], orderBy: [] },
        windowRef,
        withinGroup,
        filter,
        ignoreNulls,
      }
    }

    return { kind: 'func', name, args, distinct, star, filter, withinGroup }
  }

  // The `WINDOW w AS (spec), w2 AS (spec)` clause — named window definitions.
  private parseWindowClause(): NamedWindow[] {
    this.expect('WINDOW')
    const out: NamedWindow[] = []
    do {
      const name = this.next().text.toLowerCase()
      this.expect('AS')
      this.expect('(')
      const spec = this.parseOverBody()
      this.expect(')')
      out.push({ name, spec })
    } while (this.accept(','))
    return out
  }

  // The body inside an `OVER ( … )` (or a `WINDOW name AS ( … )` definition):
  //   [existing_window_name] [PARTITION BY …] [ORDER BY …] [frame]
  private parseOverBody(): WindowSpec {
    // A leading bare identifier (not PARTITION/ORDER, which are keywords, nor the
    // GROUPS frame keyword) references a named window to inherit from.
    let base: string | undefined
    if (this.peek().kind === 'ident' && this.peek().value !== 'GROUPS') {
      base = this.next().text.toLowerCase()
    }
    const partitionBy: Expr[] = []
    if (this.accept('PARTITION')) {
      this.expect('BY')
      do {
        partitionBy.push(this.parseExpr())
      } while (this.accept(','))
    }
    const orderBy: OrderItem[] = []
    if (this.accept('ORDER')) {
      this.expect('BY')
      do {
        const expr = this.parseExpr()
        const dir = this.accept('DESC') ? 'DESC' : (this.accept('ASC'), 'ASC')
        orderBy.push({ expr, dir })
      } while (this.accept(','))
    }
    const frame = this.tryParseFrame()
    return { base, partitionBy, orderBy, frame }
  }

  // ROWS|RANGE|GROUPS [BETWEEN] <bound> [AND <bound>] [EXCLUDE …] — a frame.
  private tryParseFrame(): import('./ast').WindowFrame | undefined {
    let mode: 'ROWS' | 'RANGE' | 'GROUPS'
    if (this.accept('ROWS')) mode = 'ROWS'
    else if (this.accept('RANGE')) mode = 'RANGE'
    else if (this.accept('GROUPS')) mode = 'GROUPS'
    else return undefined
    let start: import('./ast').FrameBound
    let end: import('./ast').FrameBound
    if (this.accept('BETWEEN')) {
      start = this.parseFrameBound()
      this.expect('AND')
      end = this.parseFrameBound()
    } else {
      // Single-bound form: "<bound>" means BETWEEN <bound> AND CURRENT ROW.
      start = this.parseFrameBound()
      end = { type: 'CURRENT_ROW' }
    }
    const exclude = this.parseFrameExclude()
    return { mode, start, end, exclude }
  }

  // EXCLUDE NO OTHERS | CURRENT ROW | GROUP | TIES.
  private parseFrameExclude(): FrameExclude | undefined {
    if (!this.accept('EXCLUDE')) return undefined
    if (this.accept('CURRENT')) {
      this.expect('ROW')
      return 'CURRENT_ROW'
    }
    if (this.accept('GROUP')) return 'GROUP'
    if (this.accept('TIES')) return 'TIES'
    this.expect('NO')
    this.expect('OTHERS')
    return 'NO_OTHERS'
  }

  private parseFrameBound(): import('./ast').FrameBound {
    if (this.accept('UNBOUNDED')) {
      if (this.accept('PRECEDING')) return { type: 'UNBOUNDED_PRECEDING' }
      this.expect('FOLLOWING')
      return { type: 'UNBOUNDED_FOLLOWING' }
    }
    if (this.accept('CURRENT')) {
      this.expect('ROW')
      return { type: 'CURRENT_ROW' }
    }
    const offset = this.parseExpr(COMPARISON_PREC + 1)
    if (this.accept('PRECEDING')) return { type: 'PRECEDING', offset }
    this.expect('FOLLOWING')
    return { type: 'FOLLOWING', offset }
  }

  private parseCase(): Expr {
    this.expect('CASE')
    let operand: Expr | undefined
    if (!this.at('WHEN')) operand = this.parseExpr()
    const whens: { when: Expr; then: Expr }[] = []
    while (this.accept('WHEN')) {
      const when = this.parseExpr()
      this.expect('THEN')
      const then = this.parseExpr()
      whens.push({ when, then })
    }
    if (whens.length === 0) throw this.err('CASE requires at least one WHEN')
    const elseExpr = this.accept('ELSE') ? this.parseExpr() : undefined
    this.expect('END')
    return { kind: 'case', operand, whens, else: elseExpr }
  }

  private parseExtract(): Expr {
    this.next() // EXTRACT
    this.expect('(')
    const fieldTok = this.next()
    const field = fieldTok.kind === 'ident' ? identName(fieldTok) : fieldTok.value
    this.expect('FROM')
    const expr = this.parseExpr()
    this.expect(')')
    return {
      kind: 'func',
      name: 'EXTRACT',
      args: [{ kind: 'literal', value: field }, expr],
      distinct: false,
      star: false,
    }
  }

  private parseCast(): Expr {
    this.expect('CAST')
    this.expect('(')
    const expr = this.parseExpr()
    this.expect('AS')
    const ty = this.parseTypeName()
    this.expect(')')
    return { kind: 'cast', expr, type: ty.type, ...(ty.scale !== undefined ? { scale: ty.scale } : {}) }
  }
}

// All 2^n subsets of `items`, ordered from the full set down to the empty set
// (the conventional CUBE output order, grand total last).
function powerSet(items: Expr[]): Expr[][] {
  const out: Expr[][] = []
  const n = items.length
  for (let mask = (1 << n) - 1; mask >= 0; mask--) {
    const set: Expr[] = []
    for (let i = 0; i < n; i++) if (mask & (1 << i)) set.push(items[i])
    out.push(set)
  }
  return out
}

/** Parse a typed temporal literal (`DATE '…'` etc.), throwing on bad syntax. */
function parseTemporalLiteral(kind: string, lit: string): SqlValue {
  const v =
    kind === 'DATE'
      ? parseDate(lit)
      : kind === 'TIME'
        ? parseTime(lit)
        : kind === 'TIMESTAMP'
          ? parseTimestamp(lit)
          : parseInterval(lit)
  if (!v) throw new SqlError(`invalid ${kind} literal: '${lit}'`, 'parse')
  return v
}

export function parse(sql: string): Statement[] {
  return new Parser(tokenize(sql)).parseProgram()
}

export function parseExpression(sql: string): Expr {
  const p = new Parser(tokenize(sql))
  return p.parseExpr()
}
