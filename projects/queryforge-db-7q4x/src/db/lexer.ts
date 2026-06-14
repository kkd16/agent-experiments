// Hand-written SQL tokenizer.
//
// This same tokenizer powers two things: the parser, and the syntax
// highlighter in the editor (we colour tokens by `kind`). Keeping a single
// source of truth means the editor highlights exactly the dialect the engine
// understands — including our keywords and operators.

import { SqlError } from './types'

export type TokenKind =
  | 'keyword'
  | 'ident'
  | 'number'
  | 'string'
  | 'operator'
  | 'punct'
  | 'comment'
  | 'eof'

export interface Token {
  kind: TokenKind
  /** Raw text as it appeared in the source. */
  text: string
  /** Upper-cased value for keyword/operator matching. */
  value: string
  start: number
  end: number
  line: number
  col: number
}

// The reserved keyword set of the QueryForge dialect.
export const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'CREATE', 'TABLE', 'DROP', 'INDEX', 'ON', 'PRIMARY', 'KEY', 'NOT', 'NULL', 'UNIQUE',
  'DISTINCT', 'AS', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER',
  'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC', 'DESC', 'LIMIT', 'OFFSET',
  'AND', 'OR', 'IN', 'IS', 'LIKE', 'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'CAST', 'EXPLAIN', 'ANALYZE', 'IF', 'EXISTS', 'TRUE', 'FALSE',
  'INTEGER', 'INT', 'REAL', 'FLOAT', 'TEXT', 'STRING', 'BOOLEAN', 'BOOL',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION',
  'UNION', 'INTERSECT', 'EXCEPT', 'ALL', 'WITH', 'RECURSIVE', 'OVER', 'PARTITION',
  'ANY', 'SOME',
])

// Multi-character operators, longest first so the scanner is greedy.
const MULTI_OPS = ['<=', '>=', '<>', '!=', '||', '==']
const SINGLE_OPS = new Set(['<', '>', '=', '+', '-', '*', '/', '%'])
const PUNCT = new Set(['(', ')', ',', ';', '.'])

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9'
}
function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'
}
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c)
}

export function tokenize(src: string, opts: { includeComments?: boolean } = {}): Token[] {
  const tokens: Token[] = []
  let i = 0
  let line = 1
  let lineStart = 0
  const n = src.length

  const push = (kind: TokenKind, start: number, end: number) => {
    const text = src.slice(start, end)
    tokens.push({
      kind,
      text,
      value: kind === 'string' ? text : text.toUpperCase(),
      start,
      end,
      line,
      col: start - lineStart + 1,
    })
  }

  while (i < n) {
    const c = src[i]

    // Newlines (track line numbers for error messages).
    if (c === '\n') {
      line++
      i++
      lineStart = i
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }

    // Line comments: -- ...
    if (c === '-' && src[i + 1] === '-') {
      const start = i
      while (i < n && src[i] !== '\n') i++
      if (opts.includeComments) push('comment', start, i)
      continue
    }
    // Block comments: /* ... */
    if (c === '/' && src[i + 1] === '*') {
      const start = i
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') {
          line++
          lineStart = i + 1
        }
        i++
      }
      i += 2
      if (opts.includeComments) push('comment', start, Math.min(i, n))
      continue
    }

    // String literals: single-quoted, '' is an escaped quote.
    if (c === "'") {
      const start = i
      i++
      while (i < n) {
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            i += 2
            continue
          }
          break
        }
        if (src[i] === '\n') {
          line++
          lineStart = i + 1
        }
        i++
      }
      if (i >= n) throw new SqlError(`unterminated string literal at line ${line}`, 'lex')
      i++ // closing quote
      push('string', start, i)
      continue
    }

    // Double-quoted identifiers.
    if (c === '"') {
      const start = i
      i++
      while (i < n && src[i] !== '"') i++
      if (i >= n) throw new SqlError(`unterminated quoted identifier at line ${line}`, 'lex')
      i++
      push('ident', start, i)
      continue
    }

    // Numbers: 123, 1.5, 1e10, .5
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      const start = i
      while (i < n && isDigit(src[i])) i++
      if (src[i] === '.') {
        i++
        while (i < n && isDigit(src[i])) i++
      }
      if (src[i] === 'e' || src[i] === 'E') {
        i++
        if (src[i] === '+' || src[i] === '-') i++
        while (i < n && isDigit(src[i])) i++
      }
      push('number', start, i)
      continue
    }

    // Identifiers / keywords.
    if (isIdentStart(c)) {
      const start = i
      while (i < n && isIdentPart(src[i])) i++
      const word = src.slice(start, i).toUpperCase()
      push(KEYWORDS.has(word) ? 'keyword' : 'ident', start, i)
      continue
    }

    // Multi-char operators.
    const two = src.slice(i, i + 2)
    if (MULTI_OPS.includes(two)) {
      push('operator', i, i + 2)
      i += 2
      continue
    }

    if (SINGLE_OPS.has(c)) {
      push('operator', i, i + 1)
      i++
      continue
    }
    if (PUNCT.has(c)) {
      push('punct', i, i + 1)
      i++
      continue
    }

    throw new SqlError(`unexpected character ${JSON.stringify(c)} at line ${line}, col ${i - lineStart + 1}`, 'lex')
  }

  tokens.push({ kind: 'eof', text: '', value: '', start: n, end: n, line, col: n - lineStart + 1 })
  return tokens
}

/** Strip quotes from a quoted identifier or unwrap a bare one. */
export function identName(tok: Token): string {
  if (tok.text.startsWith('"')) return tok.text.slice(1, -1)
  return tok.text
}

/** Parse a string-literal token into its runtime value (handles '' escapes). */
export function stringValue(tok: Token): string {
  return tok.text.slice(1, -1).replace(/''/g, "'")
}
