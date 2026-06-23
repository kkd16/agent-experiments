// A precedence-climbing (Pratt) parser turning a token stream into an AST. The
// binding-power table encodes spreadsheet operator precedence exactly: range `:`
// and postfix `%` bind tightest, then unary minus, then `^` (right-associative),
// then `* /`, `+ -`, concatenation `&`, and finally the comparison operators. The
// quirky-but-correct consequence is that `-2^2` parses as `(-2)^2 = 4`, matching
// every mainstream spreadsheet.

import type { Node, BinaryOp } from './ast'
import type { CellRef } from './address'
import { parseRef } from './address'
import type { ErrorCode } from './values'
import { tokenize, LexError } from './lexer'
import type { Token } from './lexer'

export class ParseError extends Error {}

const BINARY_BP: Record<string, number> = {
  '=': 1,
  '<>': 1,
  '<': 1,
  '>': 1,
  '<=': 1,
  '>=': 1,
  '&': 3,
  '+': 5,
  '-': 5,
  '*': 7,
  '/': 7,
  '^': 9,
}
const UNARY_BP = 9
const PERCENT_BP = 13

const ERROR_CODES: ReadonlySet<string> = new Set([
  '#DIV/0!',
  '#VALUE!',
  '#NAME?',
  '#REF!',
  '#N/A',
  '#NUM!',
  '#CIRC!',
])

class Parser {
  private pos = 0
  private readonly tokens: Token[]
  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  private peek(): Token {
    return this.tokens[this.pos]
  }
  private next(): Token {
    return this.tokens[this.pos++]
  }
  private expect(type: Token['type']): Token {
    const t = this.peek()
    if (t.type !== type) throw new ParseError(`expected ${type} but found "${t.value || t.type}"`)
    return this.next()
  }

  parse(): Node {
    const node = this.parseExpr(0)
    if (this.peek().type !== 'eof') {
      throw new ParseError(`unexpected "${this.peek().value}" after a complete expression`)
    }
    return node
  }

  private parseExpr(minBp: number): Node {
    let left = this.parsePrefix()

    for (;;) {
      const t = this.peek()

      if (t.type === 'op' && t.value === '%') {
        if (PERCENT_BP <= minBp) break
        this.next()
        left = { type: 'percent', operand: left }
        continue
      }

      if (t.type !== 'op') break
      const bp = BINARY_BP[t.value]
      if (bp === undefined || bp <= minBp) break

      this.next()
      const rightAssoc = t.value === '^'
      const right = this.parseExpr(rightAssoc ? bp - 1 : bp)
      left = { type: 'binary', op: t.value as BinaryOp, left, right }
    }

    return left
  }

  private parsePrefix(): Node {
    const t = this.peek()

    if (t.type === 'op' && (t.value === '-' || t.value === '+')) {
      this.next()
      const operand = this.parseExpr(UNARY_BP)
      return { type: 'unary', op: t.value, operand }
    }

    if (t.type === 'num') {
      this.next()
      return { type: 'num', value: Number(t.value) }
    }

    if (t.type === 'str') {
      this.next()
      return { type: 'str', value: t.value }
    }

    if (t.type === 'name') {
      this.next()
      const upper = t.value.toUpperCase()
      if (upper === 'TRUE') return { type: 'bool', value: true }
      if (upper === 'FALSE') return { type: 'bool', value: false }
      if (ERROR_CODES.has(upper)) return { type: 'error', code: upper as ErrorCode }
      throw new ParseError(`unknown name "${t.value}"`)
    }

    if (t.type === 'ref') {
      this.next()
      const from = parseRef(t.value)
      if (!from) throw new ParseError(`invalid reference "${t.value}"`)
      if (this.peek().type === 'colon') {
        this.next()
        const toTok = this.peek()
        if (toTok.type !== 'ref') throw new ParseError('expected a reference after ":"')
        this.next()
        const to = parseRef(toTok.value)
        if (!to) throw new ParseError(`invalid reference "${toTok.value}"`)
        return { type: 'range', from, to }
      }
      return { type: 'ref', ref: from }
    }

    if (t.type === 'func') {
      this.next()
      this.expect('lparen')
      const args: Node[] = []
      if (this.peek().type !== 'rparen') {
        args.push(this.parseExpr(0))
        while (this.peek().type === 'comma') {
          this.next()
          args.push(this.parseExpr(0))
        }
      }
      this.expect('rparen')
      return { type: 'call', name: t.value, args }
    }

    if (t.type === 'lparen') {
      this.next()
      const inner = this.parseExpr(0)
      this.expect('rparen')
      return inner
    }

    throw new ParseError(`unexpected "${t.value || t.type}"`)
  }
}

/** Parse a formula body (the text after the leading `=`) into an AST. */
export function parseFormula(body: string): Node {
  try {
    return new Parser(tokenize(body)).parse()
  } catch (e) {
    if (e instanceof LexError || e instanceof ParseError) {
      throw new ParseError(e.message)
    }
    throw e
  }
}

/** Statically collect every cell coordinate a formula reads — its precedents. */
export function collectRefs(node: Node, out: CellRef[] = []): CellRef[] {
  switch (node.type) {
    case 'ref':
      out.push(node.ref)
      break
    case 'range':
      out.push(node.from, node.to)
      break
    case 'unary':
    case 'percent':
      collectRefs(node.operand, out)
      break
    case 'binary':
      collectRefs(node.left, out)
      collectRefs(node.right, out)
      break
    case 'call':
      for (const a of node.args) collectRefs(a, out)
      break
    default:
      break
  }
  return out
}
