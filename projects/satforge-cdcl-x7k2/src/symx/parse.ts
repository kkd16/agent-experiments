// A hand-written tokenizer + recursive-descent parser for Mini. No dependencies,
// no parser generator — the whole language fits in one file. Errors carry a
// 1-based line number so the studio can point at the offending source line.

import type { BExpr, Expr, Program, RelOp, Stmt } from './ast'

export type ParseResult = { ok: true; program: Program } | { ok: false; error: string; line: number }

type TokKind =
  | 'ident'
  | 'num'
  | 'op' // punctuation / operator
  | 'eof'

interface Tok {
  kind: TokKind
  text: string
  line: number
}

const KEYWORDS = new Set(['input', 'if', 'else', 'while', 'assume', 'assert', 'true', 'false'])

class Lexer {
  private i = 0
  private line = 1
  private readonly s: string
  constructor(s: string) {
    this.s = s
  }

  private static readonly MULTI = ['==', '!=', '<=', '>=', '&&', '||']

  tokenize(): Tok[] {
    const out: Tok[] = []
    const s = this.s
    while (this.i < s.length) {
      const c = s[this.i]
      if (c === '\n') {
        this.line++
        this.i++
        continue
      }
      if (c === ' ' || c === '\t' || c === '\r') {
        this.i++
        continue
      }
      // line comment: // ... or #
      if ((c === '/' && s[this.i + 1] === '/') || c === '#') {
        while (this.i < s.length && s[this.i] !== '\n') this.i++
        continue
      }
      if (c >= '0' && c <= '9') {
        let j = this.i
        while (j < s.length && s[j] >= '0' && s[j] <= '9') j++
        out.push({ kind: 'num', text: s.slice(this.i, j), line: this.line })
        this.i = j
        continue
      }
      if (isIdentStart(c)) {
        let j = this.i
        while (j < s.length && isIdentPart(s[j])) j++
        out.push({ kind: 'ident', text: s.slice(this.i, j), line: this.line })
        this.i = j
        continue
      }
      const two = s.slice(this.i, this.i + 2)
      if (Lexer.MULTI.includes(two)) {
        out.push({ kind: 'op', text: two, line: this.line })
        this.i += 2
        continue
      }
      if ('+-*(){};=<>!'.includes(c)) {
        out.push({ kind: 'op', text: c, line: this.line })
        this.i++
        continue
      }
      throw new ParseError(`unexpected character '${c}'`, this.line)
    }
    out.push({ kind: 'eof', text: '', line: this.line })
    return out
  }
}

function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'
}
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= '0' && c <= '9')
}

class ParseError extends Error {
  readonly line: number
  constructor(message: string, line: number) {
    super(message)
    this.name = 'ParseError'
    this.line = line
  }
}

class Parser {
  private p = 0
  private whileId = 0
  private readonly inputs: string[] = []
  private readonly seenInputs = new Set<string>()
  private readonly toks: Tok[]

  constructor(toks: Tok[]) {
    this.toks = toks
  }

  private peek(): Tok {
    return this.toks[this.p]
  }
  private next(): Tok {
    return this.toks[this.p++]
  }
  private at(text: string): boolean {
    const t = this.peek()
    return (t.kind === 'op' || t.kind === 'ident') && t.text === text
  }
  private eat(text: string): void {
    if (!this.at(text)) throw new ParseError(`expected '${text}' but found '${this.peek().text || 'end of input'}'`, this.peek().line)
    this.next()
  }

  parseProgram(): Program {
    const body: Stmt[] = []
    while (this.peek().kind !== 'eof') body.push(this.parseStmt())
    return { inputs: this.inputs, body }
  }

  private parseBlock(): Stmt[] {
    // Either a braced block or a single statement.
    if (this.at('{')) {
      this.eat('{')
      const out: Stmt[] = []
      while (!this.at('}')) {
        if (this.peek().kind === 'eof') throw new ParseError("unclosed '{'", this.peek().line)
        out.push(this.parseStmt())
      }
      this.eat('}')
      return out
    }
    return [this.parseStmt()]
  }

  private parseStmt(): Stmt {
    const t = this.peek()
    if (t.kind === 'ident' && t.text === 'input') {
      this.next()
      const name = this.expectIdent()
      this.eat(';')
      if (this.seenInputs.has(name)) throw new ParseError(`input '${name}' declared twice`, t.line)
      this.seenInputs.add(name)
      this.inputs.push(name)
      return { kind: 'input', name }
    }
    if (t.kind === 'ident' && t.text === 'if') {
      this.next()
      this.eat('(')
      const cond = this.parseBExpr()
      this.eat(')')
      const then = this.parseBlock()
      let els: Stmt[] = []
      if (this.at('else')) {
        this.next()
        els = this.parseBlock()
      }
      return { kind: 'if', cond, then, else: els }
    }
    if (t.kind === 'ident' && t.text === 'while') {
      this.next()
      this.eat('(')
      const cond = this.parseBExpr()
      this.eat(')')
      const body = this.parseBlock()
      return { kind: 'while', id: this.whileId++, cond, body }
    }
    if (t.kind === 'ident' && (t.text === 'assume' || t.text === 'assert')) {
      const which = t.text
      this.next()
      this.eat('(')
      const cond = this.parseBExpr()
      this.eat(')')
      this.eat(';')
      return { kind: which, cond, text: bexprSrc(cond) }
    }
    if (t.kind === 'ident' && !KEYWORDS.has(t.text)) {
      // assignment: IDENT = expr ;
      const name = this.next().text
      this.eat('=')
      const e = this.parseExpr()
      this.eat(';')
      return { kind: 'assign', name, e }
    }
    throw new ParseError(`unexpected '${t.text || 'end of input'}' at start of statement`, t.line)
  }

  private expectIdent(): string {
    const t = this.peek()
    if (t.kind !== 'ident' || KEYWORDS.has(t.text)) throw new ParseError(`expected a name but found '${t.text || 'end of input'}'`, t.line)
    this.next()
    return t.text
  }

  // ---- Boolean expressions: || (lowest) > && > ! > comparison ----
  private parseBExpr(): BExpr {
    return this.parseOr()
  }
  private parseOr(): BExpr {
    let a = this.parseAnd()
    while (this.at('||')) {
      this.next()
      a = { kind: 'or', a, b: this.parseAnd() }
    }
    return a
  }
  private parseAnd(): BExpr {
    let a = this.parseNot()
    while (this.at('&&')) {
      this.next()
      a = { kind: 'and', a, b: this.parseNot() }
    }
    return a
  }
  private parseNot(): BExpr {
    if (this.at('!')) {
      this.next()
      return { kind: 'not', e: this.parseNot() }
    }
    return this.parseBAtom()
  }
  private parseBAtom(): BExpr {
    if (this.at('true')) {
      this.next()
      return { kind: 'blit', value: true }
    }
    if (this.at('false')) {
      this.next()
      return { kind: 'blit', value: false }
    }
    // A parenthesized boolean, or a comparison whose first operand starts with '('.
    // Disambiguate: try a comparison first; a bare "(bexpr)" is allowed only when
    // no relational operator follows the closing paren at this level. We take the
    // simple route: parse an expression; if a relop follows, it's a comparison;
    // otherwise, if we consumed exactly a parenthesized group, treat it as a
    // grouped boolean.
    if (this.at('(')) {
      const save = this.p
      // Attempt: grouped boolean expression.
      try {
        this.next() // (
        const inner = this.parseBExpr()
        if (this.at(')')) {
          this.next()
          if (!this.relopAhead()) return inner
        }
      } catch {
        // fall through to comparison parsing
      }
      this.p = save
    }
    return this.parseCmp()
  }
  private relopAhead(): boolean {
    const t = this.peek()
    return t.kind === 'op' && (['==', '!=', '<=', '>=', '<', '>'] as string[]).includes(t.text)
  }
  private parseCmp(): BExpr {
    const a = this.parseExpr()
    const t = this.peek()
    if (t.kind === 'op' && (['==', '!=', '<=', '>=', '<', '>'] as string[]).includes(t.text)) {
      this.next()
      const b = this.parseExpr()
      return { kind: 'cmp', op: t.text as RelOp, a, b }
    }
    throw new ParseError(`expected a comparison operator (==, !=, <=, >=, <, >) but found '${t.text || 'end of input'}'`, t.line)
  }

  // ---- Arithmetic: + - (lowest) > * > unary - > atom ----
  private parseExpr(): Expr {
    let a = this.parseTerm()
    while (this.at('+') || this.at('-')) {
      const op = this.next().text as '+' | '-'
      a = { kind: 'bin', op, a, b: this.parseTerm() }
    }
    return a
  }
  private parseTerm(): Expr {
    let a = this.parseUnary()
    while (this.at('*')) {
      this.next()
      a = { kind: 'bin', op: '*', a, b: this.parseUnary() }
    }
    return a
  }
  private parseUnary(): Expr {
    if (this.at('-')) {
      this.next()
      return { kind: 'neg', e: this.parseUnary() }
    }
    if (this.at('+')) {
      this.next()
      return this.parseUnary()
    }
    return this.parseFactor()
  }
  private parseFactor(): Expr {
    const t = this.peek()
    if (t.kind === 'num') {
      this.next()
      return { kind: 'num', value: BigInt(t.text) }
    }
    if (this.at('(')) {
      this.next()
      const e = this.parseExpr()
      this.eat(')')
      return e
    }
    if (t.kind === 'ident' && !KEYWORDS.has(t.text)) {
      this.next()
      return { kind: 'var', name: t.text }
    }
    throw new ParseError(`expected a number, name or '(' but found '${t.text || 'end of input'}'`, t.line)
  }
}

// Reconstruct a compact source string for an assume/assert (used as its label).
function bexprSrc(b: BExpr): string {
  // Lazy import avoided; delegate to ast's printer via a tiny local re-impl to
  // keep the label identical to how the AST renders.
  return renderB(b)
}
function renderB(b: BExpr): string {
  switch (b.kind) {
    case 'blit':
      return b.value ? 'true' : 'false'
    case 'not':
      return `!${b.e.kind === 'and' || b.e.kind === 'or' ? `(${renderB(b.e)})` : renderB(b.e)}`
    case 'and':
      return `${wrap(b.a)} && ${wrap(b.b)}`
    case 'or':
      return `${wrap(b.a)} || ${wrap(b.b)}`
    case 'cmp':
      return `${renderE(b.a)} ${b.op} ${renderE(b.b)}`
  }
}
function wrap(b: BExpr): string {
  return b.kind === 'and' || b.kind === 'or' ? `(${renderB(b)})` : renderB(b)
}
function renderE(e: Expr): string {
  switch (e.kind) {
    case 'num':
      return e.value.toString()
    case 'var':
      return e.name
    case 'neg':
      return `-${e.e.kind === 'bin' ? `(${renderE(e.e)})` : renderE(e.e)}`
    case 'bin': {
      const l = e.op === '*' && e.a.kind === 'bin' && e.a.op !== '*' ? `(${renderE(e.a)})` : renderE(e.a)
      const r = e.op === '*' && e.b.kind === 'bin' && e.b.op !== '*' ? `(${renderE(e.b)})` : renderE(e.b)
      return `${l} ${e.op} ${r}`
    }
  }
}

export function parseProgram(src: string): ParseResult {
  try {
    const toks = new Lexer(src).tokenize()
    const program = new Parser(toks).parseProgram()
    return { ok: true, program }
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, error: e.message, line: e.line }
    return { ok: false, error: e instanceof Error ? e.message : 'parse error', line: 0 }
  }
}
