// A hand-written parser for the Presburger surface syntax. It accepts both ASCII and unicode spellings
// so the same formula can be typed comfortably or read cleanly:
//
//   quantifiers   E x. / exists x. / ∃x.        A x. / forall x. / ∀x.   (several vars: `E x y. …`)
//   connectives   ↔ <-> <=> ,  → -> => ,  ∨ || or ,  ∧ && and ,  ¬ ! ~ not
//   comparisons   = == ,  != ≠ ,  < ,  <= ≤ ,  > ,  >= ≥
//   divisibility  d | term       (d a positive integer literal;  ¬(d | term) for “does not divide”)
//   terms         linear only:  2*x + 3y − z + 5   (a variable times a variable is a friendly error)
//
// Precedence (loosest → tightest): ↔ , → , ∨ , ∧ , ¬ / quantifier , atom.

import type { Cmp } from './atoms'
import type { Formula, LinTerm } from './formula'
import { addTerm, scaleTerm, varTerm, constTerm, zeroTerm } from './formula'

// ---------------------------------------------------------------------------
// Tokenizer.
// ---------------------------------------------------------------------------

type TokType =
  | 'num'
  | 'ident'
  | 'iff'
  | 'imp'
  | 'or'
  | 'and'
  | 'not'
  | 'exists'
  | 'forall'
  | 'le'
  | 'lt'
  | 'ge'
  | 'gt'
  | 'eq'
  | 'ne'
  | 'plus'
  | 'minus'
  | 'star'
  | 'lpar'
  | 'rpar'
  | 'dot'
  | 'mid'
  | 'top'
  | 'bot'
  | 'eof'

interface Tok {
  type: TokType
  text: string
  pos: number
  num?: number
}

const KEYWORDS: Record<string, TokType> = {
  E: 'exists',
  exists: 'exists',
  A: 'forall',
  forall: 'forall',
  or: 'or',
  and: 'and',
  not: 'not',
}

class ParseErr extends Error {
  pos: number
  constructor(pos: number, message: string) {
    super(message)
    this.pos = pos
  }
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  const push = (type: TokType, text: string, pos: number, num?: number) =>
    toks.push({ type, text, pos, num })
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    const start = i
    // Multi-character ASCII operators first.
    const two = src.slice(i, i + 2)
    const three = src.slice(i, i + 3)
    if (three === '<->' || three === '<=>') {
      push('iff', three, start)
      i += 3
      continue
    }
    if (two === '->' || two === '=>') {
      push('imp', two, start)
      i += 2
      continue
    }
    if (two === '||') {
      push('or', two, start)
      i += 2
      continue
    }
    if (two === '&&') {
      push('and', two, start)
      i += 2
      continue
    }
    if (two === '/\\') {
      push('and', two, start)
      i += 2
      continue
    }
    if (two === '\\/') {
      push('or', two, start)
      i += 2
      continue
    }
    if (two === '<=' || two === '=<') {
      push('le', two, start)
      i += 2
      continue
    }
    if (two === '>=' || two === '=>') {
      push('ge', two, start)
      i += 2
      continue
    }
    if (two === '!=' || two === '/=') {
      push('ne', two, start)
      i += 2
      continue
    }
    if (two === '==') {
      push('eq', two, start)
      i += 2
      continue
    }
    // Single-character / unicode operators.
    const single: Record<string, TokType> = {
      '↔': 'iff',
      '→': 'imp',
      '⇒': 'imp',
      '∨': 'or',
      '∧': 'and',
      '&': 'and',
      '¬': 'not',
      '!': 'not',
      '~': 'not',
      '∃': 'exists',
      '∀': 'forall',
      '≤': 'le',
      '≥': 'ge',
      '≠': 'ne',
      '<': 'lt',
      '>': 'gt',
      '=': 'eq',
      '+': 'plus',
      '−': 'minus',
      '-': 'minus',
      '*': 'star',
      '·': 'star',
      '(': 'lpar',
      ')': 'rpar',
      '.': 'dot',
      '|': 'mid',
      '⊤': 'top',
      '⊥': 'bot',
    }
    if (single[c]) {
      push(single[c], c, start)
      i++
      continue
    }
    if (c >= '0' && c <= '9') {
      let j = i
      while (j < src.length && src[j] >= '0' && src[j] <= '9') j++
      const text = src.slice(i, j)
      push('num', text, start, parseInt(text, 10))
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++
      const text = src.slice(i, j)
      const kw = KEYWORDS[text]
      push(kw ?? 'ident', text, start)
      i = j
      continue
    }
    throw new ParseErr(start, `unexpected character '${c}'`)
  }
  push('eof', '', src.length)
  return toks
}

// ---------------------------------------------------------------------------
// Parser (recursive descent + precedence-climbing for terms).
// ---------------------------------------------------------------------------

class Parser {
  private p = 0
  private toks: Tok[]
  constructor(toks: Tok[]) {
    this.toks = toks
  }

  private peek(): Tok {
    return this.toks[this.p]
  }
  private next(): Tok {
    return this.toks[this.p++]
  }
  private at(t: TokType): boolean {
    return this.peek().type === t
  }
  private expect(t: TokType, what: string): Tok {
    if (!this.at(t)) throw new ParseErr(this.peek().pos, `expected ${what}`)
    return this.next()
  }

  parse(): Formula {
    const f = this.formula()
    if (!this.at('eof')) throw new ParseErr(this.peek().pos, `unexpected '${this.peek().text}'`)
    return f
  }

  // formula ::= iff
  private formula(): Formula {
    return this.iff()
  }

  private iff(): Formula {
    let a = this.imp()
    while (this.at('iff')) {
      this.next()
      a = { kind: 'iff', a, b: this.imp() }
    }
    return a
  }

  private imp(): Formula {
    const a = this.orF()
    if (this.at('imp')) {
      this.next()
      return { kind: 'imp', a, b: this.imp() } // right-associative
    }
    return a
  }

  private orF(): Formula {
    let a = this.andF()
    while (this.at('or')) {
      this.next()
      a = { kind: 'or', a, b: this.andF() }
    }
    return a
  }

  private andF(): Formula {
    let a = this.unary()
    while (this.at('and')) {
      this.next()
      a = { kind: 'and', a, b: this.unary() }
    }
    return a
  }

  private unary(): Formula {
    if (this.at('not')) {
      this.next()
      return { kind: 'not', a: this.unary() }
    }
    if (this.at('exists') || this.at('forall')) {
      const q = this.next().type as 'exists' | 'forall'
      const names: string[] = []
      while (this.at('ident')) names.push(this.next().text)
      if (names.length === 0) throw new ParseErr(this.peek().pos, 'expected a variable after the quantifier')
      this.expect('dot', "'.' after the quantified variables")
      let body = this.formula()
      for (let k = names.length - 1; k >= 0; k--) body = { kind: q, v: names[k], a: body }
      return body
    }
    return this.atom()
  }

  private atom(): Formula {
    if (this.at('top')) {
      this.next()
      return { kind: 'true' }
    }
    if (this.at('bot')) {
      this.next()
      return { kind: 'false' }
    }
    // Divisibility:  <intlit> | term
    if (this.at('num')) {
      // Look ahead: a number immediately followed by `|` is a divisibility atom.
      const save = this.p
      const n = this.next()
      if (this.at('mid')) {
        this.next()
        const term = this.term()
        return { kind: 'div', divisor: n.num as number, term, neg: false }
      }
      this.p = save // not a divisibility — fall back to a comparison starting with this number
    }
    if (this.at('lpar')) {
      // Could be a parenthesized *formula* or a parenthesized *term* in a comparison. Try formula
      // first; if a comparison operator follows the ')', it was actually a term — reparse as term.
      const save = this.p
      try {
        this.next() // '('
        const f = this.formula()
        this.expect('rpar', "')'")
        if (this.isCmpOp(this.peek().type) || this.at('mid')) {
          // It was a term all along.
          this.p = save
        } else {
          return f
        }
      } catch {
        this.p = save
      }
    }
    return this.comparison()
  }

  private isCmpOp(t: TokType): boolean {
    return t === 'le' || t === 'lt' || t === 'ge' || t === 'gt' || t === 'eq' || t === 'ne'
  }

  private comparison(): Formula {
    const left = this.term()
    // A leading integer term followed by `|` is also divisibility (e.g. `(1+1) | x`).
    if (this.at('mid')) {
      if (Object.keys(left.coeffs).length !== 0)
        throw new ParseErr(this.peek().pos, 'the divisor left of ∣ must be a constant')
      this.next()
      const term = this.term()
      return { kind: 'div', divisor: left.c, term, neg: false }
    }
    const op = this.peek().type
    if (!this.isCmpOp(op)) throw new ParseErr(this.peek().pos, 'expected a comparison (=, <, ≤, …)')
    this.next()
    const right = this.term()
    return { kind: 'cmp', op: op as Cmp, left, right }
  }

  // term ::= sum of signed products
  private term(): LinTerm {
    let sign = 1
    if (this.at('plus')) this.next()
    else if (this.at('minus')) {
      this.next()
      sign = -1
    }
    let acc = scaleTerm(this.product(), sign)
    for (;;) {
      if (this.at('plus')) {
        this.next()
        acc = addTerm(acc, this.product())
      } else if (this.at('minus')) {
        this.next()
        acc = addTerm(acc, this.product(), -1)
      } else break
    }
    return acc
  }

  // product ::= factor (('*') factor)*  — but must stay linear (at most one variable factor).
  private product(): LinTerm {
    let acc = this.factor()
    while (this.at('star')) {
      this.next()
      const rhs = this.factor()
      acc = this.mulLinear(acc, rhs)
    }
    // Implicit multiplication: `2x` (a number immediately parsed as a factor followed by an ident).
    // Handled inside factor() for the common `<num><ident>` case.
    return acc
  }

  private mulLinear(a: LinTerm, b: LinTerm): LinTerm {
    const aConst = Object.keys(a.coeffs).length === 0
    const bConst = Object.keys(b.coeffs).length === 0
    if (aConst) return scaleTerm(b, a.c)
    if (bConst) return scaleTerm(a, b.c)
    throw new ParseErr(this.peek().pos, 'nonlinear term (a variable multiplied by a variable)')
  }

  private factor(): LinTerm {
    if (this.at('lpar')) {
      this.next()
      const t = this.term()
      this.expect('rpar', "')'")
      return t
    }
    if (this.at('minus')) {
      this.next()
      return scaleTerm(this.factor(), -1)
    }
    if (this.at('num')) {
      const n = this.next().num as number
      // Implicit coefficient: `2x`, `2·x`, `2(...)` — a number hugging a variable/paren.
      if (this.at('ident')) {
        const v = this.next().text
        return { coeffs: { [v]: n }, c: 0 }
      }
      return constTerm(n)
    }
    if (this.at('ident')) {
      return varTerm(this.next().text)
    }
    throw new ParseErr(this.peek().pos, 'expected a number, variable or (')
  }
}

export interface ParseResult {
  ok: boolean
  formula?: Formula
  pos?: number
  message?: string
}

export function parseFormula(src: string): ParseResult {
  try {
    const toks = tokenize(src)
    const f = new Parser(toks).parse()
    return { ok: true, formula: f }
  } catch (e) {
    if (e instanceof ParseErr) return { ok: false, pos: e.pos, message: e.message }
    return { ok: false, pos: 0, message: (e as Error).message }
  }
}

// Re-export so callers can build empty terms if needed.
export { zeroTerm }
