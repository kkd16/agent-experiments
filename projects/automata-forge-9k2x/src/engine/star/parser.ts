// A hand-written recursive-descent / precedence-climbing parser for CTL*, in the forgiving spirit of
// the regex / LTL / CTL / grammar / Turing-machine parsers elsewhere in the app. It is essentially
// the LTL parser with two extra prefix operators — the path quantifiers `E` and `A` — that may be
// nested arbitrarily, which is exactly what lifts the language from CTL/LTL to full CTL*.
//
// Accepted notation (Unicode + ASCII):
//   ¬ ! ~                 negation
//   ∧ & &&  /\            conjunction
//   ∨ | ||  \/            disjunction
//   →  -> =>              implication
//   ↔  <-> <=>            bi-implication
//   X ○                   next
//   F ◇ <>                eventually
//   G □ []                always
//   U R W                 until / release / weak-until (infix:  a U b)
//   E ∃                   "along some path"
//   A ∀                   "along all paths"
//   ⊤ true / ⊥ false      the constants
//
// A quantifier binds a following *unary* path body, so the CTL idioms keep their reading:
//   `A G F p`   = A(G(F p))          unary chains need no brackets
//   `AG p & q`  = (A(G p)) ∧ q       ∧ is NOT swallowed by the quantifier
//   `E[p U q]`  = E(p U q)           a binary path body is bracketed, as in CTL
//   `A[(G F p) -> (G F q)]`          arbitrary path formulas via the bracket form
//   `EF AG p`   = E(F(A(G p)))       free nesting — the whole point of CTL*
//
// The eight capitals E A X F G U R W are reserved single-character tokens (so `AG`, `EF` split into
// quantifier + temporal), hence propositions are lower-case identifiers — the convention the Kripke
// DSL already uses for labels.
//
// Precedence, tightest first:  unary (¬ X F G E A) > {U R W} > ∧ > ∨ > → > ↔.

import type { Star } from './formula'

interface ParseOk {
  ok: true
  formula: Star
}
interface ParseErr {
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

type Tok =
  | { t: 'lp' | 'rp' | 'lb' | 'rb' | 'not' | 'next' | 'fin' | 'glob' }
  | { t: 'and' | 'or' | 'imp' | 'iff' | 'until' | 'release' | 'wuntil' }
  | { t: 'E' | 'A' | 'true' | 'false' | 'eof' }
  | { t: 'atom'; name: string }

interface Token {
  tok: Tok
  pos: number
}

const ID_START = /[A-Za-z_]/
const ID_CONT = /[A-Za-z0-9_]/

// The reserved capitals, each its own token.
const RESERVED_CAP: Record<string, Tok['t']> = {
  E: 'E',
  A: 'A',
  X: 'next',
  F: 'fin',
  G: 'glob',
  U: 'until',
  R: 'release',
  W: 'wuntil',
}

function identToken(name: string): Tok {
  if (name === 'true') return { t: 'true' }
  if (name === 'false') return { t: 'false' }
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
    switch (c) {
      case '(':
        push({ t: 'lp' }, start)
        i++
        continue
      case ')':
        push({ t: 'rp' }, start)
        i++
        continue
      case '[':
        push({ t: 'lb' }, start)
        i++
        continue
      case ']':
        push({ t: 'rb' }, start)
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
      case '∃':
        push({ t: 'E' }, start)
        i++
        continue
      case '∀':
        push({ t: 'A' }, start)
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
    if (RESERVED_CAP[c]) {
      push({ t: RESERVED_CAP[c] } as Tok, start)
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

const BINARY: Partial<
  Record<Tok['t'], { prec: number; right: boolean; make: (a: Star, b: Star) => Star }>
> = {
  iff: { prec: 1, right: true, make: (a, b) => ({ k: 'iff', a, b }) },
  imp: { prec: 2, right: true, make: (a, b) => ({ k: 'imp', a, b }) },
  or: { prec: 3, right: false, make: (a, b) => ({ k: 'or', a, b }) },
  and: { prec: 4, right: false, make: (a, b) => ({ k: 'and', a, b }) },
  until: { prec: 5, right: true, make: (a, b) => ({ k: 'until', a, b }) },
  release: { prec: 5, right: true, make: (a, b) => ({ k: 'release', a, b }) },
  wuntil: { prec: 5, right: true, make: (a, b) => ({ k: 'wuntil', a, b }) },
}

const UNARY: Partial<Record<Tok['t'], (a: Star) => Star>> = {
  not: (a) => ({ k: 'not', a }),
  next: (a) => ({ k: 'next', a }),
  fin: (a) => ({ k: 'fin', a }),
  glob: (a) => ({ k: 'glob', a }),
}

const TOK_NAME: Record<Tok['t'], string> = {
  lp: '(',
  rp: ')',
  lb: '[',
  rb: ']',
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
  E: 'E',
  A: 'A',
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

  parse(): Star {
    const f = this.expr(0)
    const here = this.peek()
    if (here.tok.t !== 'eof') {
      throw new ParseError(
        `unexpected “${TOK_NAME[here.tok.t]}” — expected an operator or end`,
        here.pos,
      )
    }
    return f
  }

  private expr(minPrec: number): Star {
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

  private unary(): Star {
    const here = this.peek()
    const u = UNARY[here.tok.t]
    if (u) {
      this.advance()
      return u(this.unary())
    }
    if (here.tok.t === 'E' || here.tok.t === 'A') {
      this.advance()
      return { k: here.tok.t, a: this.quantBody(here.tok.t, here.pos) }
    }
    return this.primary()
  }

  /** The path formula a quantifier binds: a bracketed `[ … ]` (any path formula) or a unary body. */
  private quantBody(q: 'E' | 'A', qpos: number): Star {
    const here = this.peek()
    if (here.tok.t === 'lb') {
      this.advance()
      const inner = this.expr(0)
      const close = this.advance()
      if (close.tok.t !== 'rb') throw new ParseError('expected a closing “]”', close.pos)
      return inner
    }
    if (here.tok.t === 'eof') {
      throw new ParseError(`“${q}” must be followed by a path formula (e.g. ${q} F p or ${q}[p U q])`, qpos)
    }
    return this.unary()
  }

  private primary(): Star {
    const here = this.advance()
    switch (here.tok.t) {
      case 'lp': {
        const inner = this.expr(0)
        const close = this.advance()
        if (close.tok.t !== 'rp') throw new ParseError('expected a closing “)”', close.pos)
        return inner
      }
      case 'lb': {
        // A bare bracket is read as a grouping too (so `[p U q]` parses), for forgiveness.
        const inner = this.expr(0)
        const close = this.advance()
        if (close.tok.t !== 'rb') throw new ParseError('expected a closing “]”', close.pos)
        return inner
      }
      case 'true':
        return { k: 'true' }
      case 'false':
        return { k: 'false' }
      case 'atom':
        return { k: 'atom', name: here.tok.name }
      case 'until':
      case 'release':
      case 'wuntil':
        throw new ParseError(`“${TOK_NAME[here.tok.t]}” is an infix operator — write “a ${TOK_NAME[here.tok.t]} b”`, here.pos)
      case 'eof':
        throw new ParseError('unexpected end of formula', here.pos)
      default:
        throw new ParseError(`unexpected “${TOK_NAME[here.tok.t]}” — expected a proposition`, here.pos)
    }
  }
}

/** Parse a CTL* formula. Returns either the AST or a message + column for an inline error marker. */
export function parseStar(src: string): ParseResult {
  try {
    const toks = tokenize(src)
    if (toks.length === 1) return { ok: false, message: 'enter a formula', pos: 0 }
    const formula = new Parser(toks).parse()
    return { ok: true, formula }
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, message: e.message, pos: e.pos }
    return { ok: false, message: 'could not parse the formula', pos: 0 }
  }
}
