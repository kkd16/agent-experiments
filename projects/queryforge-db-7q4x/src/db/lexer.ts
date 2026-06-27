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
  // NB: KEY is intentionally *not* reserved (Postgres treats it as a non-reserved
  // word too) so it can be a column name — e.g. the `key` column of json_each().
  // `PRIMARY KEY` / `FOREIGN KEY` still parse because expect()/at() match by value.
  'CREATE', 'TABLE', 'DROP', 'INDEX', 'ON', 'PRIMARY', 'NOT', 'NULL', 'UNIQUE',
  'DISTINCT', 'AS', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER',
  'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC', 'DESC', 'LIMIT', 'OFFSET',
  'AND', 'OR', 'IN', 'IS', 'LIKE', 'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'CAST', 'EXPLAIN', 'ANALYZE', 'IF', 'EXISTS', 'TRUE', 'FALSE',
  'INTEGER', 'INT', 'REAL', 'FLOAT', 'TEXT', 'STRING', 'BOOLEAN', 'BOOL',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION',
  'UNION', 'INTERSECT', 'EXCEPT', 'ALL', 'WITH', 'RECURSIVE', 'OVER', 'PARTITION',
  'ANY', 'SOME',
  'ROWS', 'RANGE', 'GROUPS', 'UNBOUNDED', 'PRECEDING', 'FOLLOWING', 'CURRENT', 'ROW',
  'WINDOW', 'EXCLUDE', 'QUALIFY',
  'FOREIGN', 'REFERENCES', 'CHECK', 'DEFAULT', 'CONSTRAINT',
  'ALTER', 'ADD', 'COLUMN', 'RENAME', 'TO',
  // v11 — productive DML & transaction control. These are highlighted as
  // keywords but are NOT reserved (the parser matches them by token value, and
  // `parseIdent` still rejects only the reserved set), so existing column names
  // keep working. MERGE/USING/MATCHED/RETURNING/SAVEPOINT/RELEASE/TRUNCATE/LATERAL
  // only ever appear in statement position or after a keyword, never as a name
  // in the shipped corpus.
  'MERGE', 'USING', 'MATCHED', 'RETURNING', 'SAVEPOINT', 'RELEASE', 'TRUNCATE', 'LATERAL',
  // v13 — PL/QF procedural language & triggers. Highlighted as keywords; matched
  // by token value in statement position, so they never need to be reserved
  // against identifiers the parser reads via `parseIdent`. Short, ambiguous words
  // (LOOP/WHILE/FOR/RETURN/EXIT/CONTINUE) are intentionally left non-reserved.
  'FUNCTION', 'PROCEDURE', 'TRIGGER', 'RETURNS', 'DECLARE', 'RAISE', 'PERFORM',
  'ELSIF', 'BEFORE', 'AFTER', 'EXECUTE', 'CALL', 'LANGUAGE',
  // v17 — session settings. SET is already reserved (UPDATE … SET); SHOW/RESET
  // only ever appear in statement position, matched by token value.
  'SHOW', 'RESET',
  // v33 — incremental materialized views. MATERIALIZED/REFRESH only ever appear
  // in statement position (after CREATE/DROP, or leading a REFRESH), so reserving
  // them is harmless and gives them proper editor highlighting.
  'MATERIALIZED', 'REFRESH',
])

// Multi-character operators, longest first so the scanner is greedy. The
// 3-char JSON path operators (`->>`, `#>>`) must be tried before the 2-char
// ones (`->`, `#>`), which in turn precede the single-char operators.
const THREE_OPS = ['->>', '#>>']
// `..` is the integer-range delimiter in a PL `FOR i IN lo..hi LOOP`.
const MULTI_OPS = ['<=', '>=', '<>', '!=', '||', '==', '->', '#>', '@@', '@>', '<@', '::', '&&', '..']
const SINGLE_OPS = new Set(['<', '>', '=', '+', '-', '*', '/', '%', '?'])
// `[` / `]` delimit array literals and subscripts; `:` separates slice bounds.
const PUNCT = new Set(['(', ')', ',', ';', '.', '[', ']', ':'])

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

    // Dollar-quoted string literals: $$ … $$ or $tag$ … $tag$ (Postgres-style),
    // used for procedural function bodies so the body never escapes its own
    // quotes. The opening delimiter is `$` <tag> `$` where <tag> is an empty or
    // identifier-like label; the literal runs to the next identical delimiter.
    if (c === '$') {
      const tagStart = i + 1
      let j = tagStart
      while (j < n && isIdentPart(src[j])) j++
      if (src[j] === '$') {
        const delim = src.slice(i, j + 1) // e.g. "$$" or "$body$"
        const bodyStart = j + 1
        const close = src.indexOf(delim, bodyStart)
        if (close < 0) throw new SqlError(`unterminated dollar-quoted string starting at line ${line}`, 'lex')
        // Track newlines inside the body so later error lines stay accurate.
        for (let k = i; k < close + delim.length; k++) {
          if (src[k] === '\n') {
            line++
            lineStart = k + 1
          }
        }
        push('string', i, close + delim.length)
        i = close + delim.length
        continue
      }
      // A lone `$` that doesn't open a dollar-quote is not part of the dialect.
      throw new SqlError(`unexpected character "$" at line ${line}, col ${i - lineStart + 1}`, 'lex')
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
      // Consume a decimal point only when a digit follows — so `1..n` (a range)
      // leaves the `..` for the operator scanner rather than eating one dot.
      if (src[i] === '.' && isDigit(src[i + 1] ?? '')) {
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

    // Multi-char operators (3-char first, then 2-char).
    const three = src.slice(i, i + 3)
    if (THREE_OPS.includes(three)) {
      push('operator', i, i + 3)
      i += 3
      continue
    }
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

/** Parse a string-literal token into its runtime value (handles '' escapes).
 *  Dollar-quoted bodies are returned verbatim (no escape processing). */
export function stringValue(tok: Token): string {
  if (tok.text.startsWith('$')) return dollarBody(tok.text)
  return tok.text.slice(1, -1).replace(/''/g, "'")
}

/** Is this string token a dollar-quoted literal (`$$ … $$`)? */
export function isDollarQuoted(tok: Token): boolean {
  return tok.kind === 'string' && tok.text.startsWith('$')
}

/** Extract the inner body of a dollar-quoted literal, stripping both `$tag$`
 *  delimiters. (For `$body$abc$body$` this returns `abc`.) */
export function dollarBody(text: string): string {
  const close = text.indexOf('$', 1)
  const delimLen = close + 1
  return text.slice(delimLen, text.length - delimLen)
}
