// A hand-written recursive-descent / precedence-climbing parser for CTL, in the forgiving spirit of
// the regex / LTL / grammar / Turing-machine parsers elsewhere in the app. It accepts both Unicode
// and plain ASCII so the formula box is comfortable to type into:
//
//   ¬ ! ~                 negation
//   ∧ & &&  /\            conjunction
//   ∨ | ||  \/            disjunction
//   →  -> =>              implication
//   ↔  <-> <=>            bi-implication
//   E ∃                   the existential path quantifier ("for some path")
//   A ∀                   the universal path quantifier   ("for all paths")
//   X F G                 next / eventually / always  (written EX, AF, EG, …)
//   U R W                 until / release / weak-until (written E[a U b], A[a R b], …)
//   ⊤ true  /  ⊥ false    the constants
//
// CTL's defining syntactic rule: a path quantifier `E`/`A` must be *immediately* followed by a single
// temporal operator. So `EX φ`, `AF φ`, `EG φ` for the unary modalities, and the bracketed binaries
// `E[φ U ψ]`, `A[φ R ψ]`. The single capitals E A X F G U R W are reserved, so propositions are
// written as lower-case (or multi-letter) identifiers — `p`, `req`, `ack` — exactly as in the model.
//
// Precedence, tightest first:  unary (¬ and the quantified temporals) > ∧ > ∨ > → > ↔.
// ∧ and ∨ associate left; →, ↔ associate right.

import type { Ctl } from './formula'

interface ParseOk {
  ok: true
  formula: Ctl
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
  | { t: 'lp' | 'rp' | 'lb' | 'rb' | 'not' | 'and' | 'or' | 'imp' | 'iff' }
  | { t: 'true' | 'false' | 'eof' }
  | { t: 'E' | 'A' | 'X' | 'F' | 'G' | 'U' | 'R' | 'W' }
  | { t: 'atom'; name: string }

interface Token {
  tok: Tok
  pos: number
}

const ID_START = /[A-Za-z_]/
const ID_CONT = /[A-Za-z0-9_]/

// The eight reserved capitals. Unlike LTL (where `G F p` is spaced), CTL glues the quantifier and the
// temporal operator — `AG`, `EF`, `EX` — so each of these must lex as its OWN single-character token
// rather than being swallowed into a multi-letter identifier. Propositions are therefore written in
// lower case (the convention the Kripke DSL already uses for labels).
const RESERVED_CAP: Record<string, Tok['t']> = {
  E: 'E',
  A: 'A',
  X: 'X',
  F: 'F',
  G: 'G',
  U: 'U',
  R: 'R',
  W: 'W',
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
    // A reserved capital is always its own token (so `AG`, `EF`, `EX` split into quantifier+temporal).
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

const BINARY: Partial<Record<Tok['t'], { prec: number; right: boolean; make: (a: Ctl, b: Ctl) => Ctl }>> = {
  iff: { prec: 1, right: true, make: (a, b) => ({ k: 'iff', a, b }) },
  imp: { prec: 2, right: true, make: (a, b) => ({ k: 'imp', a, b }) },
  or: { prec: 3, right: false, make: (a, b) => ({ k: 'or', a, b }) },
  and: { prec: 4, right: false, make: (a, b) => ({ k: 'and', a, b }) },
}

const TOK_NAME: Record<Tok['t'], string> = {
  lp: '(',
  rp: ')',
  lb: '[',
  rb: ']',
  not: '¬',
  and: '∧',
  or: '∨',
  imp: '→',
  iff: '↔',
  E: 'E',
  A: 'A',
  X: 'X',
  F: 'F',
  G: 'G',
  U: 'U',
  R: 'R',
  W: 'W',
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
  private expect(t: Tok['t'], what: string): Token {
    const here = this.advance()
    if (here.tok.t !== t) throw new ParseError(`expected ${what}`, here.pos)
    return here
  }

  parse(): Ctl {
    const f = this.expr(0)
    const here = this.peek()
    if (here.tok.t !== 'eof') {
      throw new ParseError(`unexpected “${TOK_NAME[here.tok.t]}” — expected an operator or end`, here.pos)
    }
    return f
  }

  private expr(minPrec: number): Ctl {
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

  private unary(): Ctl {
    const here = this.peek()
    if (here.tok.t === 'not') {
      this.advance()
      return { k: 'not', a: this.unary() }
    }
    if (here.tok.t === 'E' || here.tok.t === 'A') {
      this.advance()
      return this.quantified(here.tok.t, here.pos)
    }
    return this.primary()
  }

  /** Parse the body after a quantifier `E`/`A`: a unary temporal (X/F/G) or a bracketed binary. */
  private quantified(q: 'E' | 'A', qpos: number): Ctl {
    const here = this.advance()
    switch (here.tok.t) {
      case 'X':
        return q === 'E' ? { k: 'EX', a: this.unary() } : { k: 'AX', a: this.unary() }
      case 'F':
        return q === 'E' ? { k: 'EF', a: this.unary() } : { k: 'AF', a: this.unary() }
      case 'G':
        return q === 'E' ? { k: 'EG', a: this.unary() } : { k: 'AG', a: this.unary() }
      case 'lb': {
        const a = this.expr(0)
        const opTok = this.advance()
        const op = opTok.tok.t
        if (op !== 'U' && op !== 'R' && op !== 'W') {
          throw new ParseError(`expected U, R or W inside ${q}[…]`, opTok.pos)
        }
        const b = this.expr(0)
        this.expect('rb', 'a closing “]”')
        return this.makeBinary(q, op, a, b)
      }
      default:
        throw new ParseError(
          `“${q}” must be followed by X, F, G or “[ … U/R/W … ]”`,
          here.tok.t === 'eof' ? qpos : here.pos,
        )
    }
  }

  private makeBinary(q: 'E' | 'A', op: 'U' | 'R' | 'W', a: Ctl, b: Ctl): Ctl {
    if (op === 'U') return q === 'E' ? { k: 'EU', a, b } : { k: 'AU', a, b }
    if (op === 'R') return q === 'E' ? { k: 'ER', a, b } : { k: 'AR', a, b }
    // a W b ≡ b R (a ∨ b)  — weak-until desugars to release.
    const rb: Ctl = { k: 'or', a, b }
    return q === 'E' ? { k: 'ER', a: b, b: rb } : { k: 'AR', a: b, b: rb }
  }

  private primary(): Ctl {
    const here = this.advance()
    switch (here.tok.t) {
      case 'lp': {
        const inner = this.expr(0)
        this.expect('rp', 'a closing “)”')
        return inner
      }
      case 'true':
        return { k: 'true' }
      case 'false':
        return { k: 'false' }
      case 'atom':
        return { k: 'atom', name: here.tok.name }
      case 'X':
      case 'F':
      case 'G':
      case 'U':
      case 'R':
      case 'W':
        throw new ParseError(`“${TOK_NAME[here.tok.t]}” must follow a quantifier E or A`, here.pos)
      case 'eof':
        throw new ParseError('unexpected end of formula', here.pos)
      default:
        throw new ParseError(`unexpected “${TOK_NAME[here.tok.t]}” — expected a proposition`, here.pos)
    }
  }
}

/** Parse a CTL formula. Returns either the AST or a message + column for an inline error marker. */
export function parseCtl(src: string): ParseResult {
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
