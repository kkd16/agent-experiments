// Recursive-descent parser with a Pratt (precedence-climbing) expression
// sub-parser. Produces the AST defined in ast.ts.

import {
  tokenize,
  identName,
  stringValue,
  type Token,
} from './lexer'
import { SqlError, type ColumnType } from './types'
import type {
  BinaryOp,
  ColumnDef,
  Expr,
  ExplainStmt,
  JoinClause,
  JoinType,
  OrderItem,
  SelectItem,
  SelectStmt,
  Statement,
} from './ast'

// Binary operator precedence (higher binds tighter).
const PRECEDENCE: Record<string, number> = {
  OR: 1,
  AND: 2,
  '=': 4, '<>': 4, '<': 4, '<=': 4, '>': 4, '>=': 4,
  '||': 5,
  '+': 6, '-': 6,
  '*': 7, '/': 7, '%': 7,
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
      case 'INSERT':
        return this.parseInsert()
      case 'UPDATE':
        return this.parseUpdate()
      case 'DELETE':
        return this.parseDelete()
      case 'CREATE':
        return this.parseCreate()
      case 'DROP':
        return this.parseDrop()
      case 'EXPLAIN':
        return this.parseExplain()
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

  private parseTypeName(): ColumnType {
    const t = this.next().value
    switch (t) {
      case 'INTEGER':
      case 'INT':
        return 'INTEGER'
      case 'REAL':
      case 'FLOAT':
        return 'REAL'
      case 'TEXT':
      case 'STRING':
        return 'TEXT'
      case 'BOOLEAN':
      case 'BOOL':
        return 'BOOLEAN'
      default:
        throw this.err('expected a column type (INTEGER, REAL, TEXT, BOOLEAN)')
    }
  }

  private parseCreate(): Statement {
    this.expect('CREATE')
    if (this.at('TABLE')) return this.parseCreateTable()
    if (this.at('INDEX') || this.at('UNIQUE')) return this.parseCreateIndex()
    throw this.err('expected TABLE or INDEX after CREATE')
  }

  private parseCreateTable(): Statement {
    this.expect('TABLE')
    const ifNotExists = this.parseIfNotExists()
    const name = this.parseIdent('table name')
    this.expect('(')
    const columns: ColumnDef[] = []
    do {
      columns.push(this.parseColumnDef())
    } while (this.accept(','))
    this.expect(')')
    return { kind: 'create_table', name, columns, ifNotExists }
  }

  private parseIfNotExists(): boolean {
    if (this.accept('IF')) {
      this.expect('NOT')
      this.expect('EXISTS')
      return true
    }
    return false
  }

  private parseColumnDef(): ColumnDef {
    const name = this.parseIdent('column name')
    const type = this.parseTypeName()
    const def: ColumnDef = { name, type, primaryKey: false, notNull: false, unique: false }
    for (;;) {
      if (this.accept('PRIMARY')) {
        this.expect('KEY')
        def.primaryKey = true
        def.notNull = true
      } else if (this.accept('NOT')) {
        this.expect('NULL')
        def.notNull = true
      } else if (this.accept('UNIQUE')) {
        def.unique = true
      } else {
        break
      }
    }
    return def
  }

  private parseCreateIndex(): Statement {
    const unique = this.accept('UNIQUE')
    this.expect('INDEX')
    const ifNotExists = this.parseIfNotExists()
    const name = this.parseIdent('index name')
    this.expect('ON')
    const table = this.parseIdent('table name')
    this.expect('(')
    const column = this.parseIdent('column name')
    this.expect(')')
    return { kind: 'create_index', name, table, column, unique, ifNotExists }
  }

  private parseDrop(): Statement {
    this.expect('DROP')
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
    return { kind: 'insert', table, columns, rows }
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
  // SELECT
  // ========================================================================
  private parseSelect(): SelectStmt {
    this.expect('SELECT')
    const distinct = this.accept('DISTINCT')
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
    if (this.accept('GROUP')) {
      this.expect('BY')
      groupBy = []
      do {
        groupBy.push(this.parseExpr())
      } while (this.accept(','))
    }
    const having = this.accept('HAVING') ? this.parseExpr() : undefined

    let orderBy: OrderItem[] = []
    if (this.accept('ORDER')) {
      this.expect('BY')
      orderBy = []
      do {
        const expr = this.parseExpr()
        const dir = this.accept('DESC') ? 'DESC' : (this.accept('ASC'), 'ASC')
        orderBy.push({ expr, dir })
      } while (this.accept(','))
    }

    let limit: number | undefined
    let offset: number | undefined
    if (this.accept('LIMIT')) {
      limit = this.parseIntLiteral('LIMIT')
      if (this.accept('OFFSET')) offset = this.parseIntLiteral('OFFSET')
    }
    if (this.accept('OFFSET')) offset = this.parseIntLiteral('OFFSET')

    return { kind: 'select', distinct, columns, from, joins, where, groupBy, having, orderBy, limit, offset }
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

  private parseFromItem(): SelectStmt['from'] {
    const table = this.parseIdent('table name')
    const alias = this.parseOptionalAlias()
    return { table, alias }
  }

  private parseOptionalAlias(): string | undefined {
    if (this.accept('AS')) return this.parseIdent('alias')
    if (this.atKind('ident')) return identName(this.next())
    return undefined
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
    } else if (this.accept('JOIN')) {
      type = 'INNER'
    } else {
      return null
    }
    const table = this.parseIdent('table name')
    const alias = this.parseOptionalAlias()
    let on: Expr | undefined
    if (type !== 'CROSS') {
      this.expect('ON')
      on = this.parseExpr()
    }
    return { type, table, alias, on }
  }

  // ========================================================================
  // Expressions (Pratt parser)
  // ========================================================================
  parseExpr(minPrec = 0): Expr {
    let left = this.parseUnary()

    for (;;) {
      const t = this.peek()
      const v = t.value

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
    if (t.value === 'CASE') return this.parseCase()
    if (t.value === 'CAST') return this.parseCast()
    if (this.accept('(')) {
      const e = this.parseExpr()
      this.expect(')')
      return e
    }

    // Function call or column reference.
    if (t.kind === 'ident' || this.isFunctionKeyword(t.value)) {
      // function call: name(
      if (this.peek(1).value === '(') {
        return this.parseFunc()
      }
      // qualified column table.col
      if (t.kind === 'ident' && this.peek(1).value === '.') {
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

  private isFunctionKeyword(v: string): boolean {
    return v === 'COUNT' || v === 'SUM' || v === 'AVG' || v === 'MIN' || v === 'MAX'
  }

  private parseFunc(): Expr {
    const nameTok = this.next()
    const name = nameTok.kind === 'ident' ? identName(nameTok) : nameTok.value
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
    return { kind: 'func', name: name.toUpperCase(), args, distinct, star }
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

  private parseCast(): Expr {
    this.expect('CAST')
    this.expect('(')
    const expr = this.parseExpr()
    this.expect('AS')
    const type = this.parseTypeName()
    this.expect(')')
    return { kind: 'cast', expr, type }
  }
}

export function parse(sql: string): Statement[] {
  return new Parser(tokenize(sql)).parseProgram()
}

export function parseExpression(sql: string): Expr {
  const p = new Parser(tokenize(sql))
  return p.parseExpr()
}
