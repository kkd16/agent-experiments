// Tolerant syntax highlighter for the editor overlay.
//
// Unlike the real lexer it never throws (source is often mid-edit) and it emits
// a segment for *every* character — including whitespace — so the highlighted
// <pre> layer lines up exactly with the underlying <textarea>.

export type TokClass =
  | 'kw'
  | 'num'
  | 'str'
  | 'op'
  | 'punc'
  | 'ident'
  | 'comment'
  | 'ws'
  | 'unknown'

export interface HiSeg {
  text: string
  cls: TokClass
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

const OP_CHARS = new Set(['+', '-', '*', '/', '<', '>', '=', '!', '^', '|', '&', ':', '.'])
const PUNCT = new Set(['(', ')', '[', ']', ',', ';'])

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch)
}
function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_']/.test(ch)
}
function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

export function highlight(src: string): HiSeg[] {
  const segs: HiSeg[] = []
  let i = 0
  const push = (text: string, cls: TokClass): void => {
    if (text.length) segs.push({ text, cls })
  }

  while (i < src.length) {
    const ch = src[i]

    // whitespace runs
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      let j = i
      while (j < src.length && /\s/.test(src[j])) j++
      push(src.slice(i, j), 'ws')
      i = j
      continue
    }

    // line comment
    if (ch === '/' && src[i + 1] === '/') {
      let j = i
      while (j < src.length && src[j] !== '\n') j++
      push(src.slice(i, j), 'comment')
      i = j
      continue
    }

    // block comment (* ... *)
    if (ch === '(' && src[i + 1] === '*') {
      let j = i + 2
      let depth = 1
      while (j < src.length && depth > 0) {
        if (src[j] === '(' && src[j + 1] === '*') {
          depth++
          j += 2
        } else if (src[j] === '*' && src[j + 1] === ')') {
          depth--
          j += 2
        } else {
          j++
        }
      }
      push(src.slice(i, j), 'comment')
      i = j
      continue
    }

    // strings
    if (ch === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"' && src[j] !== '\n') {
        if (src[j] === '\\') j++
        j++
      }
      if (src[j] === '"') j++
      push(src.slice(i, j), 'str')
      i = j
      continue
    }

    // numbers
    if (isDigit(ch)) {
      let j = i
      while (j < src.length && isDigit(src[j])) j++
      if (src[j] === '.' && isDigit(src[j + 1])) {
        j++
        while (j < src.length && isDigit(src[j])) j++
      }
      if (src[j] === 'e' || src[j] === 'E') {
        j++
        if (src[j] === '+' || src[j] === '-') j++
        while (j < src.length && isDigit(src[j])) j++
      }
      push(src.slice(i, j), 'num')
      i = j
      continue
    }

    // identifiers / keywords
    if (isIdentStart(ch)) {
      let j = i
      while (j < src.length && isIdentPart(src[j])) j++
      const word = src.slice(i, j)
      push(word, KEYWORDS.has(word) ? 'kw' : 'ident')
      i = j
      continue
    }

    // operators
    if (OP_CHARS.has(ch)) {
      let j = i
      while (j < src.length && OP_CHARS.has(src[j])) j++
      push(src.slice(i, j), 'op')
      i = j
      continue
    }

    // punctuation
    if (PUNCT.has(ch)) {
      push(ch, 'punc')
      i++
      continue
    }

    push(ch, 'unknown')
    i++
  }

  return segs
}
