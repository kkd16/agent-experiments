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
// plus escaped metacharacters. It also parses the *non-regular* constructs the
// backtracking VM understands: anchors '^' '$', word boundaries '\b' '\B',
// backreferences '\1'…'\9', and lookaround '(?=…)' '(?!…)' '(?<=…)' '(?<!…)'.
// `analyzeFeatures` (in ast.ts) decides whether a parsed tree stays regular.

import type { ParseError, RegexNode } from './ast';
import { CharSet, DIGIT, DOT, SPACE, WORD } from './charset';

export interface ParseResult {
  ast: RegexNode | null;
  error: ParseError | null;
  groupCount: number;
  groupNames: Record<string, number>; // capture name → 1-based group index
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
  return runParser(source, false);
}

// The *extended* grammar: the same regex, plus the Boolean operators
// intersection `&`, complement `~` and difference `−` (`A − B = A & ~B`). It is
// opt-in so the classic pipeline and its differential-fuzz guarantees are
// untouched — in plain mode `& ~ −` stay literal characters exactly as before.
export function parseExtended(source: string): ParseResult {
  return runParser(source, true);
}

function runParser(source: string, extended: boolean): ParseResult {
  const p = new Parser(source, extended);
  try {
    const ast = p.parseAlt();
    if (p.pos < source.length) {
      throw new ParseFailure(`Unexpected '${source[p.pos]}'`, p.pos);
    }
    // Resolve named backreferences (\k<name>) now that every group name is known.
    // Forward references are allowed; an unknown name is a parse error.
    p.resolveNamedRefs();
    return { ast, error: null, groupCount: p.groupCount, groupNames: p.groupNames };
  } catch (e) {
    if (e instanceof ParseFailure) {
      return { ast: null, error: { message: e.msg, index: e.index }, groupCount: p.groupCount, groupNames: p.groupNames };
    }
    throw e;
  }
}

class Parser {
  pos = 0;
  groupCount = 0;
  groupNames: Record<string, number> = {};
  // Unresolved \k<name> nodes plus the source index, fixed up after parsing.
  private pendingNamedRefs: { node: { index: number; name?: string }; index: number }[] = [];
  private src: string;
  private extended: boolean;
  constructor(src: string, extended = false) {
    this.src = src;
    this.extended = extended;
  }

  // Walk once parsing is done and point every \k<name> at its group's index.
  resolveNamedRefs(): void {
    for (const { node, index } of this.pendingNamedRefs) {
      const target = this.groupNames[node.name!];
      if (target === undefined) throw new ParseFailure(`Unknown group name '${node.name}'`, index);
      node.index = target;
    }
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

  // A capture-group name: a JS-identifier-like token [A-Za-z_][A-Za-z0-9_]*.
  private readGroupName(): string {
    const start = this.pos;
    const first = this.peek() ?? '';
    if (!/[A-Za-z_]/.test(first)) throw new ParseFailure('Group name must start with a letter or underscore', this.pos);
    let name = this.eat();
    while (/[A-Za-z0-9_]/.test(this.peek() ?? '')) name += this.eat();
    if (name.length === 0) throw new ParseFailure('Empty group name', start);
    return name;
  }

  parseAlt(): RegexNode {
    const options = [this.parseInter()];
    while (this.peek() === '|') {
      this.eat();
      options.push(this.parseInter());
    }
    return options.length === 1 ? options[0] : { type: 'alt', options };
  }

  // Intersection `&` and difference `−`, left-associative, between `|` and
  // concatenation. Only active in extended mode — otherwise `&` and `−` are
  // ordinary literals and this collapses to a single concat (no behaviour change).
  parseInter(): RegexNode {
    let left = this.parseConcat();
    if (!this.extended) return left;
    while (this.peek() === '&' || this.peek() === '-') {
      const op = this.eat();
      const right = this.parseConcat();
      // A − B = A ∩ ¬B. Both fold into one n-ary intersect via the algebra later.
      const term: RegexNode = op === '-' ? { type: 'complement', node: right } : right;
      left = { type: 'intersect', parts: [left, term] };
    }
    return left;
  }

  parseConcat(): RegexNode {
    const parts: RegexNode[] = [];
    while (this.pos < this.src.length && this.peek() !== '|' && this.peek() !== ')' && !this.atInterOp()) {
      parts.push(this.parseUnary());
    }
    if (parts.length === 0) return { type: 'empty' };
    if (parts.length === 1) return parts[0];
    return { type: 'concat', parts };
  }

  // In extended mode `&` and `−` end the current concatenation (the intersection
  // layer above consumes them). In plain mode they are literal atoms.
  private atInterOp(): boolean {
    if (!this.extended) return false;
    const c = this.peek();
    return c === '&' || c === '-';
  }

  // Prefix complement `~` (extended mode), binding looser than postfix but
  // tighter than concatenation, so `~a*` = ~(a*) and `~ab` = (~a)b.
  parseUnary(): RegexNode {
    if (this.extended && this.peek() === '~') {
      this.eat();
      return { type: 'complement', node: this.parseUnary() };
    }
    return this.parseRepeat();
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
      // Group prefixes: (?:…) non-capturing, (?=…)/(?!…) lookahead,
      // (?<=…)/(?<!…) lookbehind. A bare '(' is a capturing group.
      if (this.peek() === '?') {
        const c1 = this.src[this.pos + 1];
        if (c1 === ':') {
          this.pos += 2;
          const inner = this.parseAlt();
          this.expect(')');
          return inner;
        }
        if (c1 === '=' || c1 === '!') {
          this.pos += 2;
          const inner = this.parseAlt();
          this.expect(')');
          return { type: 'look', dir: 'ahead', negate: c1 === '!', node: inner };
        }
        if (c1 === '<' && (this.src[this.pos + 2] === '=' || this.src[this.pos + 2] === '!')) {
          const neg = this.src[this.pos + 2] === '!';
          this.pos += 3;
          const inner = this.parseAlt();
          this.expect(')');
          return { type: 'look', dir: 'behind', negate: neg, node: inner };
        }
        // Named capture group: (?<name>…)
        if (c1 === '<') {
          this.pos += 2; // consume '?<'
          const nameStart = this.pos;
          const name = this.readGroupName();
          this.expect('>');
          if (this.groupNames[name] !== undefined) {
            throw new ParseFailure(`Duplicate group name '${name}'`, nameStart);
          }
          this.groupCount++;
          const myIndex = this.groupCount;
          this.groupNames[name] = myIndex;
          const inner = this.parseAlt();
          this.expect(')');
          return { type: 'group', node: inner, index: myIndex, name };
        }
        throw new ParseFailure('Unsupported group prefix — use (?:…), (?<name>…), (?=…), (?!…), (?<=…) or (?<!…)', this.pos);
      }
      this.groupCount++;
      const myIndex = this.groupCount;
      const inner = this.parseAlt();
      this.expect(')');
      return { type: 'group', node: inner, index: myIndex };
    }
    if (ch === '[') return this.parseClass();
    if (ch === '.') {
      this.eat();
      return { type: 'char', set: DOT, raw: '.' };
    }
    if (ch === '^') {
      this.eat();
      return { type: 'anchor', at: 'start' };
    }
    if (ch === '$') {
      this.eat();
      return { type: 'anchor', at: 'end' };
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
    // Word boundaries are zero-width assertions, not characters.
    if (ch === 'b') {
      this.eat();
      return { type: 'boundary', negate: false };
    }
    if (ch === 'B') {
      this.eat();
      return { type: 'boundary', negate: true };
    }
    // Backreference \1 … \9 (single digit; \0 stays the NUL literal).
    if (ch >= '1' && ch <= '9') {
      this.eat();
      return { type: 'backref', index: ch.charCodeAt(0) - 48 };
    }
    // Named backreference \k<name>. Resolved to a group index after parsing.
    if (ch === 'k' && this.src[this.pos + 1] === '<') {
      this.pos += 2; // consume 'k<'
      const nameStart = this.pos;
      const name = this.readGroupName();
      this.expect('>');
      const node: RegexNode = { type: 'backref', index: this.groupNames[name] ?? -1, name };
      if (node.index === -1) {
        // Forward reference — record for resolution once the whole tree is parsed.
        this.pendingNamedRefs.push({ node, index: nameStart });
      }
      return node;
    }
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
