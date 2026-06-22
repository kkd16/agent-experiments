// A hand-written recursive-descent parser for a practical regular-expression dialect.
//
// Grammar (lowest precedence first):
//   alt    := concat ('|' concat)*
//   concat := repeat*
//   repeat := atom ('*' | '+' | '?')*
//   atom   := '(' alt ')' | '[' class ']' | '.' | '\' escape | literal
//
// Supported: alternation `|`, grouping `(...)`, quantifiers `* + ?`, the wildcard `.`,
// character classes `[abc]` / `[a-z]` / `[^...]`, and escapes `\n \t \r \\ \. \d \w \s \( …`.
// `\d \w \s` expand to character classes. Everything is sugar over the AST in types.ts.

import type { Ast, CharPred, ClassItem } from './types'

export interface ParseError {
  message: string
  /** Column (0-based index into the source) where the problem was detected. */
  pos: number
}

export type ParseResult =
  | { ok: true; ast: Ast }
  | { ok: false; error: ParseError }

class Parser {
  private readonly src: string
  private i = 0

  constructor(src: string) {
    this.src = src
  }

  private peek(): string | undefined {
    return this.src[this.i]
  }

  private next(): string {
    return this.src[this.i++]
  }

  private eof(): boolean {
    return this.i >= this.src.length
  }

  private fail(message: string, pos = this.i): never {
    const e: ParseError = { message, pos }
    throw e
  }

  parse(): Ast {
    const ast = this.parseAlt()
    if (!this.eof()) {
      // A stray `)` or similar.
      this.fail(`Unexpected '${this.peek()}'`)
    }
    return ast
  }

  private parseAlt(): Ast {
    const options: Ast[] = [this.parseConcat()]
    while (this.peek() === '|') {
      this.next()
      options.push(this.parseConcat())
    }
    return options.length === 1 ? options[0] : { type: 'alt', options }
  }

  private parseConcat(): Ast {
    const parts: Ast[] = []
    while (!this.eof() && this.peek() !== '|' && this.peek() !== ')') {
      parts.push(this.parseRepeat())
    }
    if (parts.length === 0) return { type: 'epsilon' }
    if (parts.length === 1) return parts[0]
    return { type: 'concat', parts }
  }

  private parseRepeat(): Ast {
    let node = this.parseAtom()
    // Quantifiers stack: a** is legal (and idempotent).
    for (;;) {
      const c = this.peek()
      if (c === '*') {
        this.next()
        node = { type: 'star', node }
      } else if (c === '+') {
        this.next()
        node = { type: 'plus', node }
      } else if (c === '?') {
        this.next()
        node = { type: 'opt', node }
      } else {
        break
      }
    }
    return node
  }

  private parseAtom(): Ast {
    const c = this.peek()
    if (c === undefined) this.fail('Unexpected end of pattern')
    if (c === '(') {
      this.next()
      const inner = this.parseAlt()
      if (this.peek() !== ')') this.fail("Missing closing ')'", this.i)
      this.next()
      return inner
    }
    if (c === ')') this.fail("Unexpected ')'")
    if (c === '[') return this.parseClass()
    if (c === ']') this.fail("Unexpected ']' (did you mean '\\]'?)")
    if (c === '*' || c === '+' || c === '?') {
      this.fail(`Nothing to repeat before '${c}'`)
    }
    if (c === '.') {
      this.next()
      return { type: 'char', pred: { kind: 'any' } }
    }
    if (c === '\\') {
      return this.parseEscape()
    }
    // Plain literal.
    this.next()
    return { type: 'char', pred: { kind: 'lit', char: c } }
  }

  /** Parse a `\x` escape outside a class. Returns a char node (possibly a shorthand class). */
  private parseEscape(): Ast {
    this.next() // consume backslash
    if (this.eof()) this.fail('Dangling backslash')
    const e = this.next()
    const shorthand = SHORTHAND[e]
    if (shorthand) {
      return { type: 'char', pred: shorthand() }
    }
    return { type: 'char', pred: { kind: 'lit', char: unescapeChar(e) } }
  }

  private parseClass(): Ast {
    this.next() // consume '['
    let neg = false
    if (this.peek() === '^') {
      neg = true
      this.next()
    }
    const items: ClassItem[] = []
    // A `]` as the first character is a literal `]` (common regex convention).
    if (this.peek() === ']') {
      items.push({ kind: 'char', char: ']' })
      this.next()
    }
    while (!this.eof() && this.peek() !== ']') {
      const lo = this.classChar()
      // Range?  lo '-' hi, but a trailing '-' before ']' is a literal dash.
      if (this.peek() === '-' && this.src[this.i + 1] !== ']' && this.i + 1 < this.src.length) {
        this.next() // consume '-'
        const hi = this.classChar()
        if (hi.charCodeAt(0) < lo.charCodeAt(0)) {
          this.fail(`Reversed range '${lo}-${hi}' in character class`, this.i)
        }
        items.push({ kind: 'range', lo, hi })
      } else {
        items.push({ kind: 'char', char: lo })
      }
    }
    if (this.peek() !== ']') this.fail("Missing closing ']'", this.i)
    this.next()
    if (items.length === 0) this.fail('Empty character class')
    return { type: 'char', pred: { kind: 'class', neg, items } }
  }

  /** Read one (possibly escaped) character inside a class. */
  private classChar(): string {
    const c = this.next()
    if (c === '\\') {
      if (this.eof()) this.fail('Dangling backslash in character class')
      const e = this.next()
      // Shorthands aren't expanded mid-range; treat as their literal escape char.
      return unescapeChar(e)
    }
    return c
  }
}

function unescapeChar(e: string): string {
  switch (e) {
    case 'n':
      return '\n'
    case 't':
      return '\t'
    case 'r':
      return '\r'
    case '0':
      return '\0'
    default:
      return e // \\, \., \(, \[, … all map to the literal character
  }
}

// Shorthand classes expand to explicit character classes so the rest of the engine only ever
// deals with `lit` / `any` / `class`.
const SHORTHAND: Record<string, () => CharPred> = {
  d: () => ({ kind: 'class', neg: false, items: [{ kind: 'range', lo: '0', hi: '9' }] }),
  D: () => ({ kind: 'class', neg: true, items: [{ kind: 'range', lo: '0', hi: '9' }] }),
  w: () => ({
    kind: 'class',
    neg: false,
    items: [
      { kind: 'range', lo: 'a', hi: 'z' },
      { kind: 'range', lo: 'A', hi: 'Z' },
      { kind: 'range', lo: '0', hi: '9' },
      { kind: 'char', char: '_' },
    ],
  }),
  W: () => ({
    kind: 'class',
    neg: true,
    items: [
      { kind: 'range', lo: 'a', hi: 'z' },
      { kind: 'range', lo: 'A', hi: 'Z' },
      { kind: 'range', lo: '0', hi: '9' },
      { kind: 'char', char: '_' },
    ],
  }),
  s: () => ({
    kind: 'class',
    neg: false,
    items: [
      { kind: 'char', char: ' ' },
      { kind: 'char', char: '\t' },
      { kind: 'char', char: '\n' },
      { kind: 'char', char: '\r' },
    ],
  }),
  S: () => ({
    kind: 'class',
    neg: true,
    items: [
      { kind: 'char', char: ' ' },
      { kind: 'char', char: '\t' },
      { kind: 'char', char: '\n' },
      { kind: 'char', char: '\r' },
    ],
  }),
}

export function parse(src: string): ParseResult {
  try {
    const ast = new Parser(src).parse()
    return { ok: true, ast }
  } catch (err) {
    if (err && typeof err === 'object' && 'message' in err && 'pos' in err) {
      return { ok: false, error: err as ParseError }
    }
    throw err
  }
}
