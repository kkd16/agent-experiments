// A recursive-descent parser for MSO[<] concrete syntax, with friendly
// index-tagged errors (house style). Both ASCII and Unicode spellings:
//
//   exists x. forall y. (x < y -> Qa(x) & y in X)
//   ∃x. ∀y. (x < y → Qa(x) ∧ y ∈ X)
//
// First-order variables are lowercase (x, y, z, …); second-order/set variables
// are uppercase (X, Y, Z, …). The quantifier word is shared — the variable's
// case decides whether it binds a position or a set. Letter predicates are
// `Qa(x)`; successor is `S(x,y)`.

import type { Formula } from './ast';

export interface ParseError {
  message: string;
  index: number;
}

type Tok =
  | { t: 'lp' | 'rp' | 'comma' | 'dot' | 'eof' | 'not' | 'and' | 'or' | 'implies' | 'iff' | 'lt' | 'le' | 'eq' | 'in' | 'exists' | 'forall' | 'true' | 'false'; i: number }
  | { t: 'label'; letter: string; i: number }
  | { t: 'succ'; i: number }
  | { t: 'varfo'; name: string; i: number }
  | { t: 'varso'; name: string; i: number };

class Lexer {
  private i = 0;
  private readonly s: string;
  constructor(s: string) {
    this.s = s;
  }

  private peekCharSkippingSpace(from: number): string {
    let j = from;
    while (j < this.s.length && /\s/.test(this.s[j])) j++;
    return j < this.s.length ? this.s[j] : '';
  }

  tokens(): Tok[] {
    const out: Tok[] = [];
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];
      if (/\s/.test(c)) {
        this.i++;
        continue;
      }
      const at = this.i;
      if (c === '(') { out.push({ t: 'lp', i: at }); this.i++; continue; }
      if (c === ')') { out.push({ t: 'rp', i: at }); this.i++; continue; }
      if (c === ',') { out.push({ t: 'comma', i: at }); this.i++; continue; }
      if (c === '.') { out.push({ t: 'dot', i: at }); this.i++; continue; }
      if (c === '~' || c === '¬' || c === '!') { out.push({ t: 'not', i: at }); this.i++; continue; }
      if (c === '&' || c === '∧') { out.push({ t: 'and', i: at }); this.i++; continue; }
      if (c === '|' || c === '∨') { out.push({ t: 'or', i: at }); this.i++; continue; }
      if (c === '∈') { out.push({ t: 'in', i: at }); this.i++; continue; }
      if (c === '∃') { out.push({ t: 'exists', i: at }); this.i++; continue; }
      if (c === '∀') { out.push({ t: 'forall', i: at }); this.i++; continue; }
      if (c === '→' || c === '⇒') { out.push({ t: 'implies', i: at }); this.i++; continue; }
      if (c === '↔' || c === '⇔') { out.push({ t: 'iff', i: at }); this.i++; continue; }
      if (c === '≤') { out.push({ t: 'le', i: at }); this.i++; continue; }
      if (c === '=') { out.push({ t: 'eq', i: at }); this.i++; continue; }
      if (c === '<') {
        if (s[this.i + 1] === '-' && s[this.i + 2] === '>') { out.push({ t: 'iff', i: at }); this.i += 3; continue; }
        if (s[this.i + 1] === '=') { out.push({ t: 'le', i: at }); this.i += 2; continue; }
        out.push({ t: 'lt', i: at }); this.i++; continue;
      }
      if (c === '-' && s[this.i + 1] === '>') { out.push({ t: 'implies', i: at }); this.i += 2; continue; }
      if (/[A-Za-z]/.test(c)) {
        let j = this.i + 1;
        while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
        const word = s.slice(this.i, j);
        this.i = j;
        if (word === 'exists' || word === 'E') { out.push({ t: 'exists', i: at }); continue; }
        if (word === 'forall' || word === 'A') { out.push({ t: 'forall', i: at }); continue; }
        if (word === 'true') { out.push({ t: 'true', i: at }); continue; }
        if (word === 'false') { out.push({ t: 'false', i: at }); continue; }
        if (word === 'in') { out.push({ t: 'in', i: at }); continue; }
        if (word === 'S' && this.peekCharSkippingSpace(j) === '(') { out.push({ t: 'succ', i: at }); continue; }
        if (word[0] === 'Q' && word.length >= 2) { out.push({ t: 'label', letter: word.slice(1), i: at }); continue; }
        if (/[a-z]/.test(word[0])) out.push({ t: 'varfo', name: word, i: at });
        else out.push({ t: 'varso', name: word, i: at });
        continue;
      }
      throw { message: `unexpected character '${c}'`, index: at } as ParseError;
    }
    out.push({ t: 'eof', i: this.i });
    return out;
  }
}

class Parser {
  private p = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private cur(): Tok {
    return this.toks[this.p];
  }
  private advance(): Tok {
    return this.toks[this.p++];
  }
  private expect(t: Tok['t'], what: string): Tok {
    const c = this.cur();
    if (c.t !== t) throw { message: `expected ${what}`, index: c.i } as ParseError;
    return this.advance();
  }

  parse(): Formula {
    const f = this.iff();
    if (this.cur().t !== 'eof') throw { message: `unexpected trailing input`, index: this.cur().i } as ParseError;
    return f;
  }

  private iff(): Formula {
    let a = this.implies();
    while (this.cur().t === 'iff') {
      this.advance();
      a = { kind: 'iff', a, b: this.implies() };
    }
    return a;
  }
  private implies(): Formula {
    const a = this.or();
    if (this.cur().t === 'implies') {
      this.advance();
      return { kind: 'implies', a, b: this.implies() }; // right associative
    }
    return a;
  }
  private or(): Formula {
    let a = this.and();
    while (this.cur().t === 'or') {
      this.advance();
      a = { kind: 'or', a, b: this.and() };
    }
    return a;
  }
  private and(): Formula {
    let a = this.unary();
    while (this.cur().t === 'and') {
      this.advance();
      a = { kind: 'and', a, b: this.unary() };
    }
    return a;
  }
  private unary(): Formula {
    const c = this.cur();
    if (c.t === 'not') {
      this.advance();
      return { kind: 'not', a: this.unary() };
    }
    if (c.t === 'exists' || c.t === 'forall') {
      this.advance();
      const v = this.cur();
      if (v.t !== 'varfo' && v.t !== 'varso') throw { message: `expected a variable after the quantifier`, index: v.i } as ParseError;
      this.advance();
      if (this.cur().t === 'dot') this.advance();
      const body = this.iff();
      if (v.t === 'varfo') return { kind: c.t === 'exists' ? 'existsFO' : 'forallFO', v: v.name, a: body };
      return { kind: c.t === 'exists' ? 'existsSO' : 'forallSO', v: v.name, a: body };
    }
    return this.primary();
  }
  private primary(): Formula {
    const c = this.cur();
    if (c.t === 'lp') {
      this.advance();
      const f = this.iff();
      this.expect('rp', `')'`);
      return f;
    }
    if (c.t === 'true') { this.advance(); return { kind: 'true' }; }
    if (c.t === 'false') { this.advance(); return { kind: 'false' }; }
    if (c.t === 'label') {
      this.advance();
      this.expect('lp', `'(' after Q${c.letter}`);
      const x = this.expect('varfo', `a first-order variable`) as Extract<Tok, { t: 'varfo' }>;
      this.expect('rp', `')'`);
      return { kind: 'label', letter: c.letter, x: x.name };
    }
    if (c.t === 'succ') {
      this.advance();
      this.expect('lp', `'(' after S`);
      const x = this.expect('varfo', `a first-order variable`) as Extract<Tok, { t: 'varfo' }>;
      this.expect('comma', `','`);
      const y = this.expect('varfo', `a first-order variable`) as Extract<Tok, { t: 'varfo' }>;
      this.expect('rp', `')'`);
      return { kind: 'succ', x: x.name, y: y.name };
    }
    if (c.t === 'varfo') {
      this.advance();
      const op = this.cur();
      if (op.t === 'lt' || op.t === 'le' || op.t === 'eq') {
        this.advance();
        const y = this.expect('varfo', `a first-order variable`) as Extract<Tok, { t: 'varfo' }>;
        const kind = op.t === 'lt' ? 'lt' : op.t === 'le' ? 'le' : 'eq';
        return { kind, x: c.name, y: y.name };
      }
      if (op.t === 'in') {
        this.advance();
        const X = this.expect('varso', `a second-order (set) variable`) as Extract<Tok, { t: 'varso' }>;
        return { kind: 'mem', x: c.name, set: X.name };
      }
      throw { message: `expected <, <=, =, or 'in' after the variable '${c.name}'`, index: op.i } as ParseError;
    }
    throw { message: `expected a formula`, index: c.i } as ParseError;
  }
}

export function parseFormula(src: string): { formula: Formula | null; error: ParseError | null } {
  try {
    const toks = new Lexer(src).tokens();
    if (toks.length === 1) return { formula: null, error: { message: 'empty formula', index: 0 } };
    const formula = new Parser(toks).parse();
    return { formula, error: null };
  } catch (e) {
    const err = e as ParseError;
    if (err && typeof err.index === 'number') return { formula: null, error: err };
    return { formula: null, error: { message: String((e as Error)?.message ?? e), index: 0 } };
  }
}
