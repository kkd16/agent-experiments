import type { Token, TokenType } from './token';
import { KEYWORDS } from './token';
import { CompileError, lineColAt } from './diagnostics';
import type { Span } from './diagnostics';

// A hand-written, single-pass lexer. It produces an array of tokens terminated
// by an `eof` token. Comments (`// ...` and `/* ... */`) and whitespace are
// skipped. All numeric literals are decimal; a `.` or exponent makes a float.

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isIdentStart = (c: string): boolean =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c: string): boolean => isIdentStart(c) || isDigit(c);

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;

  const span = (start: number, end: number): Span => {
    const { line, col } = lineColAt(source, start);
    return { start, end, line, col };
  };
  const push = (type: TokenType, start: number, end: number, value = 0): void => {
    tokens.push({ type, text: source.slice(start, end), value, span: span(start, end) });
  };

  while (i < n) {
    const c = source[i];

    // whitespace
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }

    // line comment
    if (c === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    // block comment
    if (c === '/' && source[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      if (i >= n) throw new CompileError('unterminated block comment', span(start, n), 'lex');
      i += 2;
      continue;
    }

    // string literals — double-quoted, with C-style escapes. Strata strings are
    // byte strings (Latin-1): every decoded character must fit in one byte, so a
    // literal's length in characters equals its length in bytes. This keeps the
    // tree-walking interpreter (JS strings) and the wasm backend (linear-memory
    // byte buffers) byte-for-byte comparable.
    if (c === '"') {
      const start = i;
      i++;
      let out = '';
      while (i < n && source[i] !== '"') {
        let ch = source[i];
        if (ch === '\n') throw new CompileError('unterminated string literal', span(start, i), 'lex');
        if (ch === '\\') {
          i++;
          const e = source[i];
          switch (e) {
            case 'n': ch = '\n'; break;
            case 't': ch = '\t'; break;
            case 'r': ch = '\r'; break;
            case '0': ch = '\0'; break;
            case '\\': ch = '\\'; break;
            case '"': ch = '"'; break;
            case 'x': {
              const hex = source.slice(i + 1, i + 3);
              if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new CompileError('malformed \\x escape (expected two hex digits)', span(start, i + 1), 'lex');
              ch = String.fromCharCode(parseInt(hex, 16));
              i += 2;
              break;
            }
            default:
              throw new CompileError(`unknown escape '\\${e ?? ''}'`, span(start, i), 'lex');
          }
        } else if (ch.charCodeAt(0) > 0xff) {
          throw new CompileError('non-Latin-1 character in string literal (Strata strings are byte strings)', span(start, i), 'lex');
        }
        out += ch;
        i++;
      }
      if (i >= n) throw new CompileError('unterminated string literal', span(start, n), 'lex');
      i++; // closing quote
      tokens.push({ type: 'str_lit', text: source.slice(start, i), value: 0, str: out, span: span(start, i) });
      continue;
    }

    // numbers
    if (isDigit(c) || (c === '.' && isDigit(source[i + 1] ?? ''))) {
      const start = i;
      let isFloat = false;
      while (i < n && isDigit(source[i])) i++;
      if (source[i] === '.') {
        isFloat = true;
        i++;
        while (i < n && isDigit(source[i])) i++;
      }
      if (source[i] === 'e' || source[i] === 'E') {
        isFloat = true;
        i++;
        if (source[i] === '+' || source[i] === '-') i++;
        if (!isDigit(source[i] ?? '')) throw new CompileError('malformed exponent', span(start, i), 'lex');
        while (i < n && isDigit(source[i])) i++;
      }
      const text = source.slice(start, i);
      const value = Number(text);
      push(isFloat ? 'float_lit' : 'int_lit', start, i, value);
      continue;
    }

    // identifiers & keywords
    if (isIdentStart(c)) {
      const start = i;
      i++;
      while (i < n && isIdentPart(source[i])) i++;
      const text = source.slice(start, i);
      const kw = KEYWORDS[text];
      push(kw ?? 'ident', start, i);
      continue;
    }

    // multi-char operators (longest match first)
    const two = source.slice(i, i + 2);
    const twoCharOps: TokenType[] = ['->', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>'];
    if ((twoCharOps as string[]).includes(two)) {
      push(two as TokenType, i, i + 2);
      i += 2;
      continue;
    }

    const single = '(){}[],;:=+-*/%<>&|^!~?';
    if (single.includes(c)) {
      push(c as TokenType, i, i + 1);
      i++;
      continue;
    }

    throw new CompileError(`unexpected character '${c}'`, span(i, i + 1), 'lex');
  }

  tokens.push({ type: 'eof', text: '', value: 0, span: span(n, n) });
  return tokens;
}
