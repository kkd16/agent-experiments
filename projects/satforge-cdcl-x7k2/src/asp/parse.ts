// A hand-written tokenizer + recursive-descent parser for the ASP language
// described in `ast.ts`. Tolerant enough for a studio: it collects a clear error
// with a line number and keeps going where it can. `%` starts a line comment.

import type { Term, Arg, Atom, BodyLit, CondLit, Head, Rule, CompareOp } from './ast'

export class AspParseError extends Error {
  line: number
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`)
    this.name = 'AspParseError'
    this.line = line
  }
}

type Tok =
  | { k: 'int'; v: number; line: number }
  | { k: 'id'; v: string; line: number } // lowercase-initial identifier (const / predicate)
  | { k: 'var'; v: string; line: number } // uppercase-initial or _ identifier
  | { k: 'op'; v: string; line: number } // punctuation / operator
  | { k: 'kw'; v: string; line: number } // keyword (`not`)
  | { k: 'eof'; line: number }

const MULTI = ['..', ':-', '!=', '<=', '>=']
const SINGLE = new Set(['(', ')', '{', '}', ',', ';', '.', ':', '+', '-', '*', '/', '\\', '=', '<', '>'])

function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  let line = 1
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '\n') {
      line++
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    if (c === '%') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    // multi-char operators
    let matched = false
    for (const m of MULTI) {
      if (src.startsWith(m, i)) {
        toks.push({ k: 'op', v: m, line })
        i += m.length
        matched = true
        break
      }
    }
    if (matched) continue
    if (SINGLE.has(c)) {
      toks.push({ k: 'op', v: c, line })
      i++
      continue
    }
    if (c >= '0' && c <= '9') {
      let j = i
      while (j < n && src[j] >= '0' && src[j] <= '9') j++
      toks.push({ k: 'int', v: Number(src.slice(i, j)), line })
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++
      const word = src.slice(i, j)
      i = j
      if (word === 'not') toks.push({ k: 'kw', v: 'not', line })
      else if (/^[A-Z_]/.test(word)) toks.push({ k: 'var', v: word, line })
      else toks.push({ k: 'id', v: word, line })
      continue
    }
    throw new AspParseError(`unexpected character '${c}'`, line)
  }
  toks.push({ k: 'eof', line })
  return toks
}

class Parser {
  toks: Tok[]
  pos = 0
  constructor(toks: Tok[]) {
    this.toks = toks
  }
  peek(o = 0): Tok {
    return this.toks[Math.min(this.pos + o, this.toks.length - 1)]
  }
  next(): Tok {
    return this.toks[this.pos++]
  }
  get line(): number {
    return this.peek().line
  }
  isOp(v: string, o = 0): boolean {
    const t = this.peek(o)
    return t.k === 'op' && t.v === v
  }
  expectOp(v: string): void {
    if (!this.isOp(v)) throw new AspParseError(`expected '${v}'`, this.line)
    this.pos++
  }

  // ---- terms -------------------------------------------------------------
  parseTerm(): Term {
    return this.parseAdd()
  }
  parseAdd(): Term {
    let a = this.parseMul()
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.next() as { v: string }).v as '+' | '-'
      const b = this.parseMul()
      a = { t: 'bin', op, a, b }
    }
    return a
  }
  parseMul(): Term {
    let a = this.parseUnary()
    while (this.isOp('*') || this.isOp('/') || this.isOp('\\')) {
      const op = (this.next() as { v: string }).v as '*' | '/' | '\\'
      const b = this.parseUnary()
      a = { t: 'bin', op, a, b }
    }
    return a
  }
  parseUnary(): Term {
    if (this.isOp('-')) {
      this.next()
      return { t: 'neg', a: this.parseUnary() }
    }
    return this.parsePrimary()
  }
  parsePrimary(): Term {
    const t = this.peek()
    if (t.k === 'int') {
      this.next()
      return { t: 'int', v: t.v }
    }
    if (t.k === 'var') {
      this.next()
      return { t: 'var', name: t.v }
    }
    if (t.k === 'id') {
      this.next()
      return { t: 'const', name: t.v }
    }
    if (this.isOp('(')) {
      this.next()
      const inner = this.parseAdd()
      this.expectOp(')')
      return inner
    }
    throw new AspParseError(`expected a term`, t.line)
  }

  // ---- atoms -------------------------------------------------------------
  parseAtom(): Atom {
    const t = this.peek()
    if (t.k !== 'id') throw new AspParseError(`expected a predicate name`, t.line)
    this.next()
    const args: Arg[] = []
    if (this.isOp('(')) {
      this.next()
      if (!this.isOp(')')) {
        args.push(this.parseArg())
        while (this.isOp(',')) {
          this.next()
          args.push(this.parseArg())
        }
      }
      this.expectOp(')')
    }
    return { pred: t.v, args }
  }
  parseArg(): Arg {
    const lo = this.parseTerm()
    if (this.isOp('..')) {
      this.next()
      const hi = this.parseTerm()
      return { a: 'range', lo, hi }
    }
    return { a: 'term', term: lo }
  }

  // ---- body literals -----------------------------------------------------
  private relop(): CompareOp | null {
    const t = this.peek()
    if (t.k === 'op' && ['=', '!=', '<', '<=', '>', '>='].includes(t.v)) {
      this.next()
      return t.v as CompareOp
    }
    return null
  }
  parseBodyLit(): BodyLit {
    const first = this.peek()
    if (first.k === 'kw' && first.v === 'not') {
      this.next()
      return { k: 'neg', atom: this.parseAtom() }
    }
    const t = this.peek()
    // A variable / number / paren / minus can only begin a comparison.
    if (t.k === 'var' || t.k === 'int' || this.isOp('(') || this.isOp('-')) {
      const a = this.parseTerm()
      const op = this.relop()
      if (!op) throw new AspParseError(`expected a comparison operator`, this.line)
      const b = this.parseTerm()
      return { k: 'cmp', op, a, b }
    }
    // A lowercase identifier is an atom — unless it is a bare constant used as
    // the left side of a comparison (`n = 3`).
    const atom = this.parseAtom()
    const op = this.relop()
    if (op) {
      if (atom.args.length !== 0)
        throw new AspParseError(`cannot compare the atom '${atom.pred}(...)'`, this.line)
      const b = this.parseTerm()
      return { k: 'cmp', op, a: { t: 'const', name: atom.pred }, b }
    }
    return { k: 'pos', atom }
  }
  parseBody(): BodyLit[] {
    const lits: BodyLit[] = [this.parseBodyLit()]
    while (this.isOp(',')) {
      this.next()
      lits.push(this.parseBodyLit())
    }
    return lits
  }

  // ---- heads -------------------------------------------------------------
  parseCondLit(): CondLit {
    const atom = this.parseAtom()
    const cond: BodyLit[] = []
    if (this.isOp(':')) {
      this.next()
      cond.push(this.parseBodyLit())
      while (this.isOp(',')) {
        this.next()
        cond.push(this.parseBodyLit())
      }
    }
    return { atom, cond }
  }
  parseChoice(lo: Term | null): Head {
    this.expectOp('{')
    const elems: CondLit[] = []
    if (!this.isOp('}')) {
      elems.push(this.parseCondLit())
      while (this.isOp(';')) {
        this.next()
        elems.push(this.parseCondLit())
      }
    }
    this.expectOp('}')
    let hi: Term | null = null
    const t = this.peek()
    if (t.k === 'int' || t.k === 'var' || this.isOp('(') || this.isOp('-')) {
      hi = this.parseTerm()
    }
    return { h: 'choice', lo, hi, elems }
  }
  parseHead(): Head {
    if (this.isOp('{')) return this.parseChoice(null)
    // A leading bound like `1 { ... }` — try a term followed by '{'.
    const save = this.pos
    if (this.peek().k === 'int' || this.peek().k === 'var' || this.isOp('(')) {
      try {
        const lo = this.parseTerm()
        if (this.isOp('{')) return this.parseChoice(lo)
      } catch {
        /* fall through */
      }
      this.pos = save
    }
    return { h: 'atom', atom: this.parseAtom() }
  }

  // ---- statements --------------------------------------------------------
  parseStatement(): Rule | null {
    // skip directives beginning with '#': consume up to '.'
    const line = this.line
    if (this.isOp(':-')) {
      this.next()
      const body = this.parseBody()
      this.expectOp('.')
      return { head: { h: 'constraint' }, body, line }
    }
    const head = this.parseHead()
    let body: BodyLit[] = []
    if (this.isOp(':-')) {
      this.next()
      body = this.parseBody()
    }
    this.expectOp('.')
    return { head, body, line }
  }
}

export interface ParseResult {
  rules: Rule[]
  errors: string[]
}

/** Parse a whole program. Each statement that fails is skipped with a recorded
 *  error, so the studio can show partial results and diagnostics together. */
export function parseProgram(src: string): ParseResult {
  const errors: string[] = []
  let toks: Tok[]
  try {
    toks = tokenize(src)
  } catch (e) {
    return { rules: [], errors: [(e as Error).message] }
  }
  const p = new Parser(toks)
  const rules: Rule[] = []
  while (p.peek().k !== 'eof') {
    const start = p.pos
    try {
      const r = p.parseStatement()
      if (r) rules.push(r)
    } catch (e) {
      errors.push((e as Error).message)
      // recover: skip to the next '.' and past it
      while (p.peek().k !== 'eof' && !(p.isOp('.'))) p.next()
      if (p.peek().k !== 'eof') p.next()
      if (p.pos === start) p.next() // guarantee progress
    }
  }
  return { rules, errors }
}
