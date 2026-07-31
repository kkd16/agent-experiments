// A small recursive-descent parser for the surface LTL syntax.
//
// Precedence, loosest to tightest:
//   <->   (equivalence, left-assoc)
//   ->    (implication, right-assoc)
//   |     (or, left-assoc)         · also `||`
//   &     (and, left-assoc)        · also `&&`
//   U R W (binary temporals, right-assoc)
//   ! X F G   (unary prefixes, tightest)
//
// Atoms are identifiers; `true`/`false` are constants. Whitespace is
// insignificant. Parse errors carry a character offset for the editor.

import type { Ltl } from './ast'
import { and, atom, eventually, FALSE, globally, iff, imp, next, not, or, release, TRUE, until, wuntil } from './ast'

export class LtlParseError extends Error {
  pos: number
  constructor(message: string, pos: number) {
    super(message)
    this.name = 'LtlParseError'
    this.pos = pos
  }
}

type Tok =
  | { t: 'id'; v: string; p: number }
  | { t: 'op'; v: string; p: number }
  | { t: 'lp'; p: number }
  | { t: 'rp'; p: number }
  | { t: 'eof'; p: number }

const KEYWORDS = new Set(['X', 'F', 'G', 'U', 'R', 'W'])

function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  const n = src.length
  const three = (a: string) => src.startsWith(a, i)
  while (i < n) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    if (c === '(') {
      toks.push({ t: 'lp', p: i })
      i++
      continue
    }
    if (c === ')') {
      toks.push({ t: 'rp', p: i })
      i++
      continue
    }
    if (three('<->')) {
      toks.push({ t: 'op', v: '<->', p: i })
      i += 3
      continue
    }
    if (three('<=>')) {
      toks.push({ t: 'op', v: '<->', p: i })
      i += 3
      continue
    }
    if (three('->') || three('=>')) {
      toks.push({ t: 'op', v: '->', p: i })
      i += 2
      continue
    }
    if (three('&&')) {
      toks.push({ t: 'op', v: '&', p: i })
      i += 2
      continue
    }
    if (three('||')) {
      toks.push({ t: 'op', v: '|', p: i })
      i += 2
      continue
    }
    if (c === '&' || c === '|' || c === '!' || c === '~') {
      toks.push({ t: 'op', v: c === '~' ? '!' : c, p: i })
      i++
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++
      const word = src.slice(i, j)
      if (KEYWORDS.has(word)) toks.push({ t: 'op', v: word, p: i })
      else toks.push({ t: 'id', v: word, p: i })
      i = j
      continue
    }
    throw new LtlParseError(`Unexpected character ${JSON.stringify(c)}`, i)
  }
  toks.push({ t: 'eof', p: n })
  return toks
}

class Parser {
  private toks: Tok[]
  private k = 0
  constructor(src: string) {
    this.toks = tokenize(src)
  }
  private peek(): Tok {
    return this.toks[this.k]
  }
  private next(): Tok {
    return this.toks[this.k++]
  }
  private isOp(v: string): boolean {
    const t = this.peek()
    return t.t === 'op' && t.v === v
  }

  parse(): Ltl {
    const f = this.parseIff()
    const t = this.peek()
    if (t.t !== 'eof') throw new LtlParseError('Unexpected trailing input', t.p)
    return f
  }

  private parseIff(): Ltl {
    let left = this.parseImp()
    while (this.isOp('<->')) {
      this.next()
      left = iff(left, this.parseImp())
    }
    return left
  }

  private parseImp(): Ltl {
    const left = this.parseOr()
    if (this.isOp('->')) {
      this.next()
      return imp(left, this.parseImp()) // right-assoc
    }
    return left
  }

  private parseOr(): Ltl {
    let left = this.parseAnd()
    while (this.isOp('|')) {
      this.next()
      left = or(left, this.parseAnd())
    }
    return left
  }

  private parseAnd(): Ltl {
    let left = this.parseTemporalBin()
    while (this.isOp('&')) {
      this.next()
      left = and(left, this.parseTemporalBin())
    }
    return left
  }

  private parseTemporalBin(): Ltl {
    const left = this.parseUnary()
    if (this.isOp('U') || this.isOp('R') || this.isOp('W')) {
      const op = (this.next() as { v: string }).v
      const right = this.parseTemporalBin() // right-assoc
      if (op === 'U') return until(left, right)
      if (op === 'R') return release(left, right)
      return wuntil(left, right)
    }
    return left
  }

  private parseUnary(): Ltl {
    const t = this.peek()
    if (t.t === 'op' && (t.v === '!' || t.v === 'X' || t.v === 'F' || t.v === 'G')) {
      this.next()
      const inner = this.parseUnary()
      if (t.v === '!') return not(inner)
      if (t.v === 'X') return next(inner)
      if (t.v === 'F') return eventually(inner)
      return globally(inner)
    }
    return this.parseAtom()
  }

  private parseAtom(): Ltl {
    const t = this.next()
    if (t.t === 'lp') {
      const f = this.parseIff()
      const close = this.next()
      if (close.t !== 'rp') throw new LtlParseError('Expected )', close.p)
      return f
    }
    if (t.t === 'id') {
      if (t.v === 'true') return TRUE
      if (t.v === 'false') return FALSE
      return atom(t.v)
    }
    throw new LtlParseError('Expected a formula', t.p)
  }
}

/** Parse an LTL formula; throws {@link LtlParseError} on malformed input. */
export function parseLtl(src: string): Ltl {
  return new Parser(src).parse()
}

/** Parse, returning `null` (never throwing) on any error — handy for UIs. */
export function tryParseLtl(src: string): Ltl | null {
  try {
    return parseLtl(src)
  } catch {
    return null
  }
}
