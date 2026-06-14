// A hand-written scanner for the C subset. Turns source text into a flat token stream.
// Comments and whitespace are skipped; string and char literals are decoded here (with full
// C escape handling) so the parser never has to think about escapes again.

import { KEYWORDS } from './token';
import type { Tok, TokKind } from './token';

export class CError extends Error {
  line: number;
  col: number;
  constructor(message: string, line: number, col: number) {
    super(message);
    this.name = 'CError';
    this.line = line;
    this.col = col;
  }
}

// Multi-character operators, longest first so maximal-munch works.
const PUNCT = [
  '<<=',
  '>>=',
  '...',
  '->',
  '++',
  '--',
  '<<',
  '>>',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '=',
  '<',
  '>',
  '!',
  '~',
  '&',
  '|',
  '^',
  '?',
  ':',
  ';',
  ',',
  '.',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
];

function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}
function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}
function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

export function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const n = src.length;

  const here = () => ({ line, col, start: i });
  const advance = (k = 1) => {
    for (let j = 0; j < k; j++) {
      if (src[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  while (i < n) {
    const c = src[i];

    // whitespace
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      advance();
      continue;
    }
    // line comment
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') advance();
      continue;
    }
    // preprocessor line (#define / #include / …): tolerated by skipping to end of line.
    if (c === '#') {
      while (i < n && src[i] !== '\n') advance();
      continue;
    }
    // block comment
    if (c === '/' && src[i + 1] === '*') {
      advance(2);
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) advance();
      if (i >= n) throw new CError('unterminated block comment', line, col);
      advance(2);
      continue;
    }

    const startPos = here();

    // identifier or keyword
    if (isIdentStart(c)) {
      let s = '';
      while (i < n && isIdentPart(src[i])) {
        s += src[i];
        advance();
      }
      const kind: TokKind = KEYWORDS.has(s) ? 'keyword' : 'ident';
      toks.push(mk(kind, s, startPos));
      continue;
    }

    // number (integer): decimal, 0x hex, 0 octal
    if (isDigit(c)) {
      let s = '';
      let val: number;
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        s = '0x';
        advance(2);
        let hs = '';
        while (i < n && /[0-9a-fA-F]/.test(src[i])) {
          hs += src[i];
          advance();
        }
        if (hs === '') throw new CError('malformed hex literal', startPos.line, startPos.col);
        val = parseInt(hs, 16) | 0;
        s += hs;
      } else if (c === '0' && isDigit(src[i + 1] ?? '')) {
        // octal
        s = '0';
        advance();
        let os = '';
        while (i < n && src[i] >= '0' && src[i] <= '7') {
          os += src[i];
          advance();
        }
        val = parseInt(os, 8) | 0;
        s += os;
      } else {
        while (i < n && isDigit(src[i])) {
          s += src[i];
          advance();
        }
        val = parseInt(s, 10) | 0;
      }
      // Skip an integer suffix (u/l) if present — we only have one integer width.
      while (i < n && /[uUlL]/.test(src[i])) advance();
      const t = mk('num', s, startPos);
      t.num = val;
      toks.push(t);
      continue;
    }

    // char literal
    if (c === "'") {
      advance();
      const { value: ch, raw } = readEscapedChar(() => src[i], advance, startPos);
      if (src[i] !== "'") throw new CError('unterminated char literal', startPos.line, startPos.col);
      advance();
      const t = mk('char', `'${raw}'`, startPos);
      t.num = ch & 0xff;
      // sign-extend char literal like a signed char
      t.num = (t.num << 24) >> 24;
      toks.push(t);
      continue;
    }

    // string literal
    if (c === '"') {
      advance();
      let out = '';
      while (i < n && src[i] !== '"') {
        if (src[i] === '\n') throw new CError('newline in string literal', startPos.line, startPos.col);
        const { value } = readEscapedChar(() => src[i], advance, startPos);
        out += String.fromCharCode(value & 0xff);
      }
      if (src[i] !== '"') throw new CError('unterminated string literal', startPos.line, startPos.col);
      advance();
      const t = mk('str', '"..."', startPos);
      t.str = out;
      toks.push(t);
      continue;
    }

    // punctuator (maximal munch)
    let matched: string | null = null;
    for (const p of PUNCT) {
      if (src.startsWith(p, i)) {
        matched = p;
        break;
      }
    }
    if (matched) {
      advance(matched.length);
      toks.push(mk('punct', matched, startPos));
      continue;
    }

    throw new CError(`unexpected character '${c}'`, line, col);
  }

  toks.push({ kind: 'eof', value: '', start: i, end: i, line, col });
  return toks;

  function mk(kind: TokKind, value: string, sp: { line: number; col: number; start: number }): Tok {
    return { kind, value, start: sp.start, end: i, line: sp.line, col: sp.col };
  }
}

// Decode a single (possibly escaped) character, advancing the cursor. Used by both char
// and string literals. Returns the byte value plus the raw text consumed (for char tokens).
function readEscapedChar(
  peek: () => string,
  advance: (k?: number) => void,
  sp: { line: number; col: number },
): { value: number; raw: string } {
  const c = peek();
  if (c === undefined || c === '') throw new CError('unexpected end of literal', sp.line, sp.col);
  if (c !== '\\') {
    advance();
    return { value: c.charCodeAt(0), raw: c };
  }
  // escape sequence
  advance(); // backslash
  const e = peek();
  const simple: Record<string, number> = {
    n: 10,
    t: 9,
    r: 13,
    '0': 0,
    '\\': 92,
    "'": 39,
    '"': 34,
    a: 7,
    b: 8,
    f: 12,
    v: 11,
  };
  if (e === 'x') {
    advance();
    let hs = '';
    while (/[0-9a-fA-F]/.test(peek())) {
      hs += peek();
      advance();
    }
    return { value: parseInt(hs || '0', 16) & 0xff, raw: `\\x${hs}` };
  }
  if (e in simple) {
    advance();
    return { value: simple[e], raw: `\\${e}` };
  }
  // unknown escape: take the char literally
  advance();
  return { value: e.charCodeAt(0), raw: `\\${e}` };
}
