// A hand-written recursive-descent parser for LTL, in the forgiving spirit of the regex / grammar /
// Turing-machine parsers elsewhere in the app. It accepts both Unicode operators and plain ASCII so
// the formula box is comfortable to type into:
//
//   ¬ ! ~                 negation
//   ∧ & &&  /\            conjunction
//   ∨ | ||  \/            disjunction
//   →  -> =>              implication
//   ↔  <-> <=>            bi-implication
//   X  ○                  next
//   F  ◇  <>              eventually
//   G  □  []              always
//   U  R  W               until / release / weak-until (written infix:  a U b)
//   ⊤ true  /  ⊥ false    the constants
//
// Atoms are identifiers (`p`, `req`, `ack_2`). The single capitals X F G U R W are reserved as
// operators, so propositions are written in lower case (the conventional choice anyway).
//
// Precedence, tightest first:  unary (¬ X F G) > {U R W} > ∧ > ∨ > → > ↔.
// ∧ and ∨ associate left; →, ↔, and the temporal binaries associate right.

import type { Ltl } from './formula'

type Tok =
  | { t: 'lp' | 'rp' | 'not' | 'next' | 'fin' | 'glob' | 'true' | 'false' | 'eof' }
  | { t: 'and' | 'or' | 'imp' | 'iff' | 'until' | 'release' | 'wuntil' }
  | { t: 'atom'; name: string }

interface Token {
  tok: Tok
  pos: number // column where the token starts (0-based)
}

export interface ParseOk {
  ok: true
  formula: Ltl
}
export interface ParseErr {
  ok: false
  message: string
  pos: number
}
export type ParseResult = ParseOk | ParseErr

class ParseError extends Error {
  pos: number
  constructor(message: string, pos: number) {
    super(message)
    this.pos = pos
  }
}

const ID_START = /[A-Za-z_]/
const ID_CONT = /[A-Za-z0-9_]/

/** Map a finished identifier to its token (constant, reserved operator letter, or atom). */
function identToken(name: string): Tok {
  if (name === 'true') return { t: 'true' }
  if (name === 'false') return { t: 'false' }
  if (name.length === 1) {
    switch (name) {
      case 'X':
        return { t: 'next' }
      case 'F':
        return { t: 'fin' }
      case 'G':
        return { t: 'glob' }
      case 'U':
        return { t: 'until' }
      case 'R':
        return { t: 'release' }
      case 'W':
        return { t: 'wuntil' }
    }
  }
  return { t: 'atom', name }
}

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  const push = (tok: Tok, pos: number) => out.push({ tok, pos })
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    const start = i
    // Two-/three-character ASCII operators first.
    const two = src.slice(i, i + 2)
    const three = src.slice(i, i + 3)
    if (three === '<->' || three === '<=>') {
      push({ t: 'iff' }, start)
      i += 3
      continue
    }
    if (two === '->' || two === '=>') {
      push({ t: 'imp' }, start)
      i += 2
      continue
    }
    if (two === '<>') {
      push({ t: 'fin' }, start)
      i += 2
      continue
    }
    if (two === '[]') {
      push({ t: 'glob' }, start)
      i += 2
      continue
    }
    if (two === '&&' || two === '/\\') {
      push({ t: 'and' }, start)
      i += 2
      continue
    }
    if (two === '||' || two === '\\/') {
      push({ t: 'or' }, start)
      i += 2
      continue
    }
    // Single characters (ASCII + Unicode).
    switch (c) {
      case '(':
        push({ t: 'lp' }, start)
        i++
        continue
      case ')':
        push({ t: 'rp' }, start)
        i++
        continue
      case '!':
      case '~':
      case '¬':
        push({ t: 'not' }, start)
        i++
        continue
      case '&':
      case '∧':
        push({ t: 'and' }, start)
        i++
        continue
      case '|':
      case '∨':
        push({ t: 'or' }, start)
        i++
        continue
      case '→':
        push({ t: 'imp' }, start)
        i++
        continue
      case '↔':
        push({ t: 'iff' }, start)
        i++
        continue
      case '○':
      case '◯':
        push({ t: 'next' }, start)
        i++
        continue
      case '◇':
        push({ t: 'fin' }, start)
        i++
        continue
      case '□':
        push({ t: 'glob' }, start)
        i++
        continue
      case '⊤':
        push({ t: 'true' }, start)
        i++
        continue
      case '⊥':
        push({ t: 'false' }, start)
        i++
        continue
    }
    if (ID_START.test(c)) {
      let j = i + 1
      while (j < src.length && ID_CONT.test(src[j])) j++
      push(identToken(src.slice(i, j)), start)
      i = j
      continue
    }
    throw new ParseError(`unexpected character “${c}”`, start)
  }
  push({ t: 'eof' }, src.length)
  return out
}

// Binary-operator table: precedence (higher binds tighter) + associativity + AST builder.
const BINARY: Partial<
  Record<Tok['t'], { prec: number; right: boolean; make: (a: Ltl, b: Ltl) => Ltl }>
> = {
  iff: { prec: 1, right: true, make: (a, b) => ({ k: 'iff', a, b }) },
  imp: { prec: 2, right: true, make: (a, b) => ({ k: 'imp', a, b }) },
  or: { prec: 3, right: false, make: (a, b) => ({ k: 'or', a, b }) },
  and: { prec: 4, right: false, make: (a, b) => ({ k: 'and', a, b }) },
  until: { prec: 5, right: true, make: (a, b) => ({ k: 'until', a, b }) },
  release: { prec: 5, right: true, make: (a, b) => ({ k: 'release', a, b }) },
  wuntil: { prec: 5, right: true, make: (a, b) => ({ k: 'wuntil', a, b }) },
}

const UNARY: Partial<Record<Tok['t'], (a: Ltl) => Ltl>> = {
  not: (a) => ({ k: 'not', a }),
  next: (a) => ({ k: 'next', a }),
  fin: (a) => ({ k: 'fin', a }),
  glob: (a) => ({ k: 'glob', a }),
}

const TOK_NAME: Record<Tok['t'], string> = {
  lp: '(',
  rp: ')',
  not: '¬',
  next: 'X',
  fin: 'F',
  glob: 'G',
  and: '∧',
  or: '∨',
  imp: '→',
  iff: '↔',
  until: 'U',
  release: 'R',
  wuntil: 'W',
  true: '⊤',
  false: '⊥',
  atom: 'proposition',
  eof: 'end of input',
}

class Parser {
  private p = 0
  private toks: Token[]
  constructor(toks: Token[]) {
    this.toks = toks
  }

  private peek(): Token {
    return this.toks[this.p]
  }
  private advance(): Token {
    return this.toks[this.p++]
  }

  parse(): Ltl {
    const f = this.expr(0)
    const here = this.peek()
    if (here.tok.t !== 'eof') {
      throw new ParseError(`unexpected “${TOK_NAME[here.tok.t]}” — expected an operator or end`, here.pos)
    }
    return f
  }

  // Precedence-climbing: parse a unary/primary, then fold in binary operators of high-enough prec.
  private expr(minPrec: number): Ltl {
    let lhs = this.unary()
    for (;;) {
      const here = this.peek()
      const bin = BINARY[here.tok.t]
      if (!bin || bin.prec < minPrec) break
      this.advance()
      const nextMin = bin.right ? bin.prec : bin.prec + 1
      const rhs = this.expr(nextMin)
      lhs = bin.make(lhs, rhs)
    }
    return lhs
  }

  private unary(): Ltl {
    const here = this.peek()
    const u = UNARY[here.tok.t]
    if (u) {
      this.advance()
      return u(this.unary())
    }
    return this.primary()
  }

  private primary(): Ltl {
    const here = this.advance()
    switch (here.tok.t) {
      case 'lp': {
        const inner = this.expr(0)
        const close = this.advance()
        if (close.tok.t !== 'rp') {
          throw new ParseError('expected a closing “)”', close.pos)
        }
        return inner
      }
      case 'true':
        return { k: 'true' }
      case 'false':
        return { k: 'false' }
      case 'atom':
        return { k: 'atom', name: here.tok.name }
      case 'eof':
        throw new ParseError('unexpected end of formula', here.pos)
      default:
        throw new ParseError(`unexpected “${TOK_NAME[here.tok.t]}” — expected a proposition`, here.pos)
    }
  }
}

/** Parse an LTL formula. Returns either the AST or a message + column for an inline error marker. */
export function parseLtl(src: string): ParseResult {
  try {
    const toks = tokenize(src)
    // An empty formula is a (common) error worth a friendly message rather than "unexpected end".
    if (toks.length === 1) return { ok: false, message: 'enter a formula', pos: 0 }
    const formula = new Parser(toks).parse()
    return { ok: true, formula }
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, message: e.message, pos: e.pos }
    return { ok: false, message: 'could not parse the formula', pos: 0 }
  }
}
