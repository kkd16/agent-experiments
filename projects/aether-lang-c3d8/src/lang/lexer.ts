// Aether — lexer
//
// Turns source text into a flat list of tokens, each carrying its exact source
// span so later stages (parser, type checker, editor) can point back at the
// original characters. Hand-written scanner: no regex-driven tokenizer, so error
// positions stay precise and the whole pipeline is debuggable.

export type TokKind =
  | 'int'
  | 'float'
  | 'string'
  | 'ident'
  | 'keyword'
  | 'op'
  | 'punc'
  | 'eof'

export interface Span {
  /** absolute character offset of the first char (inclusive) */
  start: number
  /** absolute character offset just past the last char (exclusive) */
  end: number
  /** 1-based line of `start` */
  line: number
  /** 1-based column of `start` */
  col: number
}

export interface Token {
  kind: TokKind
  /** the raw lexeme (for strings: the decoded value) */
  value: string
  span: Span
}

export class LexError extends Error {
  span: Span
  constructor(message: string, span: Span) {
    super(message)
    this.name = 'LexError'
    this.span = span
  }
}

const KEYWORDS = new Set([
  'let',
  'rec',
  'in',
  'fn',
  'if',
  'then',
  'else',
  'true',
  'false',
  'and',
  'match',
  'with',
  'type',
])

// Multi-character operators, longest first so the scanner is greedy.
const OPERATORS = [
  '->',
  '::',
  '++',
  '|>',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '+.',
  '-.',
  '*.',
  '/.',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
  '=',
  '!',
  '^',
  '|',
]

const PUNCT = new Set(['(', ')', '[', ']', ',', ';', '{', '}', '.'])

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch)
}
function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_']/.test(ch)
}
function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  let line = 1
  let col = 1

  const here = (start: number, sl: number, sc: number): Span => ({
    start,
    end: i,
    line: sl,
    col: sc,
  })

  const advance = (): string => {
    const ch = src[i]
    i++
    if (ch === '\n') {
      line++
      col = 1
    } else {
      col++
    }
    return ch
  }

  while (i < src.length) {
    const ch = src[i]
    const startOff = i
    const startLine = line
    const startCol = col

    // whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      advance()
      continue
    }

    // line comment: // ...
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') advance()
      continue
    }

    // block comment: (* ... *) with nesting
    if (ch === '(' && src[i + 1] === '*') {
      advance()
      advance()
      let depth = 1
      while (i < src.length && depth > 0) {
        if (src[i] === '(' && src[i + 1] === '*') {
          advance()
          advance()
          depth++
        } else if (src[i] === '*' && src[i + 1] === ')') {
          advance()
          advance()
          depth--
        } else {
          advance()
        }
      }
      if (depth > 0) {
        throw new LexError('unterminated block comment', here(startOff, startLine, startCol))
      }
      continue
    }

    // numbers: int or float (with optional fraction / exponent)
    if (isDigit(ch)) {
      while (i < src.length && isDigit(src[i])) advance()
      let isFloat = false
      if (src[i] === '.' && isDigit(src[i + 1])) {
        isFloat = true
        advance() // '.'
        while (i < src.length && isDigit(src[i])) advance()
      }
      if (src[i] === 'e' || src[i] === 'E') {
        isFloat = true
        advance()
        if (src[i] === '+' || src[i] === '-') advance()
        if (!isDigit(src[i])) {
          throw new LexError('malformed exponent in number', here(startOff, startLine, startCol))
        }
        while (i < src.length && isDigit(src[i])) advance()
      }
      const raw = src.slice(startOff, i)
      tokens.push({ kind: isFloat ? 'float' : 'int', value: raw, span: here(startOff, startLine, startCol) })
      continue
    }

    // identifiers / keywords
    if (isIdentStart(ch)) {
      while (i < src.length && isIdentPart(src[i])) advance()
      const raw = src.slice(startOff, i)
      tokens.push({
        kind: KEYWORDS.has(raw) ? 'keyword' : 'ident',
        value: raw,
        span: here(startOff, startLine, startCol),
      })
      continue
    }

    // string literals with escapes
    if (ch === '"') {
      advance() // opening quote
      let out = ''
      let closed = false
      while (i < src.length) {
        const c = src[i]
        if (c === '"') {
          advance()
          closed = true
          break
        }
        if (c === '\\') {
          advance()
          const esc = src[i]
          if (esc === undefined) break
          advance()
          switch (esc) {
            case 'n':
              out += '\n'
              break
            case 't':
              out += '\t'
              break
            case 'r':
              out += '\r'
              break
            case '\\':
              out += '\\'
              break
            case '"':
              out += '"'
              break
            case '0':
              out += '\0'
              break
            default:
              out += esc
          }
          continue
        }
        if (c === '\n') {
          throw new LexError('unterminated string literal', here(startOff, startLine, startCol))
        }
        out += c
        advance()
      }
      if (!closed) {
        throw new LexError('unterminated string literal', here(startOff, startLine, startCol))
      }
      tokens.push({ kind: 'string', value: out, span: here(startOff, startLine, startCol) })
      continue
    }

    // operators (greedy, longest match)
    let matchedOp: string | null = null
    for (const op of OPERATORS) {
      if (src.startsWith(op, i)) {
        matchedOp = op
        break
      }
    }
    if (matchedOp) {
      for (let k = 0; k < matchedOp.length; k++) advance()
      tokens.push({ kind: 'op', value: matchedOp, span: here(startOff, startLine, startCol) })
      continue
    }

    // punctuation
    if (PUNCT.has(ch)) {
      advance()
      tokens.push({ kind: 'punc', value: ch, span: here(startOff, startLine, startCol) })
      continue
    }

    throw new LexError(`unexpected character ${JSON.stringify(ch)}`, here(startOff, startLine, startCol))
  }

  tokens.push({ kind: 'eof', value: '<eof>', span: { start: i, end: i, line, col } })
  return tokens
}
