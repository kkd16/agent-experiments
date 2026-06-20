// A recursive-descent parser turning a regex source string into a RegexNode AST.
//
// Grammar (precedence low → high):
//   alt    := concat ('|' concat)*
//   concat := repeat*
//   repeat := atom quantifier*
//   atom   := '(' alt ')' | '[' class ']' | '.' | escape | literal
//
// Supported: literals, '.', '*', '+', '?', '{m}', '{m,}', '{m,n}', lazy '?'
// suffix, alternation '|', grouping '( )', character classes '[ ]' / '[^ ]'
// with ranges and escapes, and the escapes \d \D \w \W \s \S \t \n \r \f \v \0
// plus escaped metacharacters. Anchors (^ $) and backreferences are reported as
// friendly errors — see JOURNAL.md backlog.

import type { ParseError, RegexNode } from './ast';
import { CharSet, DIGIT, DOT, SPACE, WORD } from './charset';

export interface ParseResult {
  ast: RegexNode | null;
  error: ParseError | null;
  groupCount: number;
}

class ParseFailure extends Error {
  msg: string;
  index: number;
  constructor(msg: string, index: number) {
    super(msg);
    this.msg = msg;
    this.index = index;
  }
}

const META = new Set(['(', ')', '[', ']', '{', '}', '*', '+', '?', '|', '.', '\\', '^', '$']);

export function parse(source: string): ParseResult {
  const p = new Parser(source);
  try {
    const ast = p.parseAlt();
    if (p.pos < source.length) {
      throw new ParseFailure(`Unexpected '${source[p.pos]}'`, p.pos);
    }
    return { ast, error: null, groupCount: p.groupCount };
  } catch (e) {
    if (e instanceof ParseFailure) {
      return { ast: null, error: { message: e.msg, index: e.index }, groupCount: p.groupCount };
    }
    throw e;
  }
}

class Parser {
  pos = 0;
  groupCount = 0;
  private src: string;
  constructor(src: string) {
    this.src = src;
  }

  private peek(): string | undefined {
    return this.src[this.pos];
  }
  private eat(): string {
    return this.src[this.pos++];
  }
  private expect(ch: string): void {
    if (this.peek() !== ch) throw new ParseFailure(`Expected '${ch}'`, this.pos);
    this.pos++;
  }

  parseAlt(): RegexNode {
    const options = [this.parseConcat()];
    while (this.peek() === '|') {
      this.eat();
      options.push(this.parseConcat());
    }
    return options.length === 1 ? options[0] : { type: 'alt', options };
  }

  parseConcat(): RegexNode {
    const parts: RegexNode[] = [];
    while (this.pos < this.src.length && this.peek() !== '|' && this.peek() !== ')') {
      parts.push(this.parseRepeat());
    }
    if (parts.length === 0) return { type: 'empty' };
    if (parts.length === 1) return parts[0];
    return { type: 'concat', parts };
  }

  parseRepeat(): RegexNode {
    let node = this.parseAtom();
    for (;;) {
      const ch = this.peek();
      if (ch === '*' || ch === '+' || ch === '?') {
        this.eat();
        const lazy = this.peek() === '?';
        if (lazy) this.eat();
        if (ch === '*') node = { type: 'star', node, lazy };
        else if (ch === '+') node = { type: 'plus', node, lazy };
        else node = { type: 'opt', node, lazy };
      } else if (ch === '{') {
        const saved = this.pos;
        const bounds = this.tryParseBounds();
        if (!bounds) {
          this.pos = saved;
          break; // a literal '{'
        }
        const lazy = this.peek() === '?';
        if (lazy) this.eat();
        node = { type: 'repeat', node, min: bounds.min, max: bounds.max, lazy };
      } else {
        break;
      }
    }
    return node;
  }

  private tryParseBounds(): { min: number; max: number | null } | null {
    // Caller has confirmed peek() === '{'.
    this.eat();
    const start = this.pos;
    let min = '';
    while (/[0-9]/.test(this.peek() ?? '')) min += this.eat();
    if (min === '') {
      this.pos = start - 1;
      return null;
    }
    let max: number | null = parseInt(min, 10);
    if (this.peek() === ',') {
      this.eat();
      let maxStr = '';
      while (/[0-9]/.test(this.peek() ?? '')) maxStr += this.eat();
      max = maxStr === '' ? null : parseInt(maxStr, 10);
    }
    if (this.peek() !== '}') return null;
    this.eat();
    const minN = parseInt(min, 10);
    if (max !== null && max < minN) throw new ParseFailure(`Quantifier {${minN},${max}} is out of order`, start);
    return { min: minN, max };
  }

  parseAtom(): RegexNode {
    const ch = this.peek();
    if (ch === undefined) throw new ParseFailure('Unexpected end of pattern', this.pos);
    if (ch === '(') {
      this.eat();
      // Support non-capturing groups (?:...).
      let capturing = true;
      if (this.peek() === '?' && this.src[this.pos + 1] === ':') {
        this.pos += 2;
        capturing = false;
      } else if (this.peek() === '?') {
        throw new ParseFailure('Only (?:…) non-capturing groups are supported', this.pos);
      }
      const inner = this.parseAlt();
      this.expect(')');
      if (!capturing) return inner;
      this.groupCount++;
      return { type: 'group', node: inner, index: this.groupCount };
    }
    if (ch === '[') return this.parseClass();
    if (ch === '.') {
      this.eat();
      return { type: 'char', set: DOT, raw: '.' };
    }
    if (ch === '^' || ch === '$') {
      throw new ParseFailure(`Anchors ('${ch}') are not supported yet`, this.pos);
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      throw new ParseFailure(`Unbalanced '${ch}'`, this.pos);
    }
    if (ch === '*' || ch === '+' || ch === '?') {
      throw new ParseFailure(`Nothing to repeat before '${ch}'`, this.pos);
    }
    if (ch === '\\') return this.parseEscape();
    this.eat();
    return { type: 'char', set: CharSet.fromChar(ch.codePointAt(0)!), raw: ch };
  }

  private parseEscape(): RegexNode {
    const start = this.pos;
    this.eat(); // backslash
    const ch = this.peek();
    if (ch === undefined) throw new ParseFailure('Trailing backslash', start);
    const classSet = escapeClass(ch);
    if (classSet) {
      this.eat();
      return { type: 'char', set: classSet, raw: '\\' + ch };
    }
    const lit = escapeLiteral(ch);
    if (lit !== null) {
      this.eat();
      return { type: 'char', set: CharSet.fromChar(lit), raw: '\\' + ch };
    }
    // An escaped metacharacter or plain char.
    this.eat();
    return { type: 'char', set: CharSet.fromChar(ch.codePointAt(0)!), raw: '\\' + ch };
  }

  private parseClass(): RegexNode {
    const start = this.pos;
    this.expect('[');
    let negate = false;
    if (this.peek() === '^') {
      negate = true;
      this.eat();
    }
    const sets: CharSet[] = [];
    let first = true;
    while (this.peek() !== ']') {
      if (this.pos >= this.src.length) throw new ParseFailure('Unterminated character class', start);
      // A ']' as the very first member is a literal.
      const lo = this.readClassAtom(first);
      first = false;
      if (lo.kind === 'set') {
        sets.push(lo.set);
        continue;
      }
      // Possible range: a-z
      if (this.peek() === '-' && this.src[this.pos + 1] !== ']' && this.pos + 1 < this.src.length) {
        this.eat(); // '-'
        const hi = this.readClassAtom(false);
        if (hi.kind === 'set') {
          // e.g. [a-\d] — treat '-' literally.
          sets.push(CharSet.fromChar(lo.code));
          sets.push(CharSet.fromChar(45));
          sets.push(hi.set);
        } else {
          if (hi.code < lo.code) throw new ParseFailure('Character class range is out of order', start);
          sets.push(CharSet.fromRange(lo.code, hi.code));
        }
      } else {
        sets.push(CharSet.fromChar(lo.code));
      }
    }
    this.expect(']');
    let set = CharSet.union(sets);
    if (negate) set = set.negate();
    if (set.isEmpty() && !negate) throw new ParseFailure('Empty character class', start);
    return { type: 'char', set, raw: this.src.slice(start, this.pos) };
  }

  private readClassAtom(firstBracket: boolean): { kind: 'code'; code: number } | { kind: 'set'; set: CharSet } {
    const ch = this.peek();
    if (ch === ']' && firstBracket) {
      this.eat();
      return { kind: 'code', code: 93 };
    }
    if (ch === '\\') {
      this.eat();
      const esc = this.peek();
      if (esc === undefined) throw new ParseFailure('Trailing backslash in class', this.pos);
      const cls = escapeClass(esc);
      if (cls) {
        this.eat();
        return { kind: 'set', set: cls };
      }
      const lit = escapeLiteral(esc);
      this.eat();
      return { kind: 'code', code: lit !== null ? lit : esc.codePointAt(0)! };
    }
    this.eat();
    return { kind: 'code', code: ch!.codePointAt(0)! };
  }
}

function escapeClass(ch: string): CharSet | null {
  switch (ch) {
    case 'd':
      return DIGIT;
    case 'D':
      return DIGIT.negate();
    case 'w':
      return WORD;
    case 'W':
      return WORD.negate();
    case 's':
      return SPACE;
    case 'S':
      return SPACE.negate();
    default:
      return null;
  }
}

function escapeLiteral(ch: string): number | null {
  switch (ch) {
    case 'n':
      return 10;
    case 't':
      return 9;
    case 'r':
      return 13;
    case 'f':
      return 12;
    case 'v':
      return 11;
    case '0':
      return 0;
    default:
      return null;
  }
}

export function isMetacharacter(ch: string): boolean {
  return META.has(ch);
}
