// Aether — parser
//
// A Pratt (precedence-climbing) parser. Function application is juxtaposition
// (`f x y`) and binds tighter than every binary operator; `let`, `fn` and `if`
// are prefix forms whose bodies extend as far right as possible. Multi-argument
// `fn a b -> e` and `let f a b = e` desugar to curried single-argument lambdas.

import type { BinaryOp, Expr, UnaryOp } from './ast.ts'
import type { Span, Token } from './lexer.ts'
import { tokenize } from './lexer.ts'

export class ParseError extends Error {
  span: Span
  constructor(message: string, span: Span) {
    super(message)
    this.name = 'ParseError'
    this.span = span
  }
}

// Left binding power for each infix operator. Higher binds tighter.
const INFIX_BP: Record<string, number> = {
  ';': 1,
  '||': 2,
  '&&': 3,
  '==': 4,
  '!=': 4,
  '<': 4,
  '>': 4,
  '<=': 4,
  '>=': 4,
  '::': 5,
  '^': 5,
  '++': 5,
  '+': 6,
  '-': 6,
  '+.': 6,
  '-.': 6,
  '*': 7,
  '/': 7,
  '*.': 7,
  '/.': 7,
}

// Right-associative operators recurse with a slightly lower minimum bp.
const RIGHT_ASSOC = new Set([';', '::', '^', '++'])

const UNARY_BP = 8

class Parser {
  private toks: Token[]
  private pos = 0

  constructor(toks: Token[]) {
    this.toks = toks
  }

  private peek(): Token {
    return this.toks[this.pos]
  }
  private next(): Token {
    return this.toks[this.pos++]
  }
  private at(kind: Token['kind'], value?: string): boolean {
    const t = this.peek()
    return t.kind === kind && (value === undefined || t.value === value)
  }
  private expect(kind: Token['kind'], value: string): Token {
    if (!this.at(kind, value)) {
      const t = this.peek()
      throw new ParseError(`expected ${JSON.stringify(value)} but found ${JSON.stringify(t.value)}`, t.span)
    }
    return this.next()
  }

  private spanFrom(start: Span, end: Span): Span {
    return { start: start.start, end: end.end, line: start.line, col: start.col }
  }

  parseProgram(): Expr {
    const e = this.parseExpr(0)
    if (!this.at('eof')) {
      const t = this.peek()
      throw new ParseError(`unexpected trailing input ${JSON.stringify(t.value)}`, t.span)
    }
    return e
  }

  parseExpr(minBp: number): Expr {
    let left = this.parsePrefix()
    for (;;) {
      const t = this.peek()
      const opStr = t.value
      const isInfix =
        (t.kind === 'op' && opStr in INFIX_BP) || (t.kind === 'punc' && opStr === ';')
      if (!isInfix) break
      const lbp = INFIX_BP[opStr]
      if (lbp <= minBp) break
      this.next()
      const rbp = RIGHT_ASSOC.has(opStr) ? lbp - 1 : lbp
      const right = this.parseExpr(rbp)
      const span = this.spanFrom(left.span, right.span)
      if (opStr === ';') {
        left = { kind: 'seq', first: left, rest: right, span }
      } else {
        left = { kind: 'binop', op: opStr as BinaryOp, left, right, span }
      }
    }
    return left
  }

  private parsePrefix(): Expr {
    const t = this.peek()

    if (t.kind === 'keyword') {
      if (t.value === 'let') return this.parseLet()
      if (t.value === 'fn') return this.parseLambda()
      if (t.value === 'if') return this.parseIf()
    }

    if (t.kind === 'op' && (t.value === '-' || t.value === '!')) {
      this.next()
      const operand = this.parseExpr(UNARY_BP)
      return { kind: 'unop', op: t.value as UnaryOp, operand, span: this.spanFrom(t.span, operand.span) }
    }

    return this.parseApp()
  }

  // application: a head atom followed by zero or more argument atoms
  private parseApp(): Expr {
    let head = this.parseAtom()
    while (this.startsAtom()) {
      const arg = this.parseAtom()
      head = { kind: 'app', fn: head, arg, span: this.spanFrom(head.span, arg.span) }
    }
    return head
  }

  private startsAtom(): boolean {
    const t = this.peek()
    if (t.kind === 'int' || t.kind === 'float' || t.kind === 'string' || t.kind === 'ident') return true
    if (t.kind === 'keyword' && (t.value === 'true' || t.value === 'false')) return true
    if (t.kind === 'punc' && (t.value === '(' || t.value === '[')) return true
    return false
  }

  private parseAtom(): Expr {
    const t = this.peek()
    switch (t.kind) {
      case 'int':
        this.next()
        return { kind: 'int', value: parseInt(t.value, 10), span: t.span }
      case 'float':
        this.next()
        return { kind: 'float', value: parseFloat(t.value), span: t.span }
      case 'string':
        this.next()
        return { kind: 'str', value: t.value, span: t.span }
      case 'ident':
        this.next()
        return { kind: 'var', name: t.value, span: t.span }
      case 'keyword':
        if (t.value === 'true' || t.value === 'false') {
          this.next()
          return { kind: 'bool', value: t.value === 'true', span: t.span }
        }
        throw new ParseError(`unexpected keyword ${JSON.stringify(t.value)}`, t.span)
      case 'punc':
        if (t.value === '(') return this.parseParen()
        if (t.value === '[') return this.parseList()
        throw new ParseError(`unexpected ${JSON.stringify(t.value)}`, t.span)
      default:
        throw new ParseError(`unexpected ${JSON.stringify(t.value)}`, t.span)
    }
  }

  private parseParen(): Expr {
    const open = this.expect('punc', '(')
    // unit literal: ()
    if (this.at('punc', ')')) {
      const close = this.next()
      return { kind: 'unit', span: this.spanFrom(open.span, close.span) }
    }
    const first = this.parseExpr(0)
    if (this.at('punc', ',')) {
      const elements = [first]
      while (this.at('punc', ',')) {
        this.next()
        elements.push(this.parseExpr(0))
      }
      const close = this.expect('punc', ')')
      return { kind: 'tuple', elements, span: this.spanFrom(open.span, close.span) }
    }
    this.expect('punc', ')')
    return first
  }

  private parseList(): Expr {
    const open = this.expect('punc', '[')
    const elements: Expr[] = []
    if (!this.at('punc', ']')) {
      elements.push(this.parseExpr(0))
      while (this.at('punc', ',')) {
        this.next()
        elements.push(this.parseExpr(0))
      }
    }
    const close = this.expect('punc', ']')
    return { kind: 'list', elements, span: this.spanFrom(open.span, close.span) }
  }

  private parseLambda(): Expr {
    const start = this.expect('keyword', 'fn')
    const params: string[] = []
    while (this.at('ident')) {
      params.push(this.next().value)
    }
    if (params.length === 0) {
      throw new ParseError('fn needs at least one parameter', this.peek().span)
    }
    this.expect('op', '->')
    const body = this.parseExpr(0)
    const span = this.spanFrom(start.span, body.span)
    // curry right-to-left into nested single-parameter lambdas
    let acc: Expr = body
    for (let k = params.length - 1; k >= 0; k--) {
      acc = { kind: 'lambda', param: params[k], body: acc, span }
    }
    return acc
  }

  private parseLet(): Expr {
    const start = this.expect('keyword', 'let')
    let recursive = false
    if (this.at('keyword', 'rec')) {
      this.next()
      recursive = true
    }
    if (!this.at('ident')) {
      throw new ParseError('expected a name after let', this.peek().span)
    }
    const name = this.next().value
    // optional parameters: `let f a b = ...` sugar for `let f = fn a b -> ...`
    const params: string[] = []
    while (this.at('ident')) {
      params.push(this.next().value)
    }
    this.expect('op', '=')
    let value = this.parseExpr(0)
    for (let k = params.length - 1; k >= 0; k--) {
      value = { kind: 'lambda', param: params[k], body: value, span: value.span }
    }
    this.expect('keyword', 'in')
    const body = this.parseExpr(0)
    return {
      kind: 'let',
      name,
      value,
      body,
      recursive,
      span: this.spanFrom(start.span, body.span),
    }
  }

  private parseIf(): Expr {
    const start = this.expect('keyword', 'if')
    const cond = this.parseExpr(0)
    this.expect('keyword', 'then')
    const thenE = this.parseExpr(0)
    this.expect('keyword', 'else')
    const elseE = this.parseExpr(0)
    return { kind: 'if', cond, then: thenE, else: elseE, span: this.spanFrom(start.span, elseE.span) }
  }
}

export function parse(src: string): Expr {
  const toks = tokenize(src)
  return new Parser(toks).parseProgram()
}

export function parseTokens(toks: Token[]): Expr {
  return new Parser(toks).parseProgram()
}
