// A recursive-descent parser for Presburger concrete syntax, with friendly
// index-tagged errors (house style). ASCII and Unicode spellings both work:
//
//   forall x. exists y. (x < y & y = 2*x)
//   ∀x. ∃y. (x < y ∧ y = 2·x)
//   exists y. x = y + y            ("x is even")
//   3*x + 1 = 2*y                  (a linear Diophantine relation)
//   x = 1 (mod 2)                  (x is odd — a congruence)
//
// Variables are identifiers (x, y, z, n, …) ranging over ℕ. Terms are linear:
// integer coefficients, +, −, and multiplication of a constant by a variable
// (2*x, 2x, or 2·x). Atoms are comparisons t ⋈ t and congruences t = r (mod m).

import {
  type Formula,
  type LinTerm,
  type CmpOp,
  constTerm,
  varTerm,
  addTerms,
  subTerms,
  scaleTerm,
  pruneCoef,
} from './ast';

export interface ParseError {
  message: string;
  index: number;
}

type Tok =
  | { t: 'lp' | 'rp' | 'dot' | 'comma' | 'eof' | 'not' | 'and' | 'or' | 'implies' | 'iff'; i: number }
  | { t: 'plus' | 'minus' | 'star'; i: number }
  | { t: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'equiv'; i: number }
  | { t: 'exists' | 'forall' | 'true' | 'false'; i: number }
  | { t: 'num'; value: number; i: number }
  | { t: 'id'; name: string; i: number };

class Lexer {
  private i = 0;
  private readonly s: string;
  constructor(s: string) {
    this.s = s;
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
      if (c === '.') { out.push({ t: 'dot', i: at }); this.i++; continue; }
      if (c === ',') { out.push({ t: 'comma', i: at }); this.i++; continue; }
      if (c === '+') { out.push({ t: 'plus', i: at }); this.i++; continue; }
      if (c === '*' || c === '·') { out.push({ t: 'star', i: at }); this.i++; continue; }
      if (c === '−') { out.push({ t: 'minus', i: at }); this.i++; continue; }
      if (c === '~' || c === '¬') { out.push({ t: 'not', i: at }); this.i++; continue; }
      if (c === '&' || c === '∧') { out.push({ t: 'and', i: at }); this.i++; continue; }
      if (c === '|' || c === '∨') { out.push({ t: 'or', i: at }); this.i++; continue; }
      if (c === '∃') { out.push({ t: 'exists', i: at }); this.i++; continue; }
      if (c === '∀') { out.push({ t: 'forall', i: at }); this.i++; continue; }
      if (c === '→' || c === '⇒') { out.push({ t: 'implies', i: at }); this.i++; continue; }
      if (c === '↔' || c === '⇔') { out.push({ t: 'iff', i: at }); this.i++; continue; }
      if (c === '≤') { out.push({ t: 'le', i: at }); this.i++; continue; }
      if (c === '≥') { out.push({ t: 'ge', i: at }); this.i++; continue; }
      if (c === '≠') { out.push({ t: 'ne', i: at }); this.i++; continue; }
      if (c === '≡') { out.push({ t: 'equiv', i: at }); this.i++; continue; }
      if (c === '=') { out.push({ t: 'eq', i: at }); this.i++; continue; }
      if (c === '<') {
        if (s[this.i + 1] === '-' && s[this.i + 2] === '>') { out.push({ t: 'iff', i: at }); this.i += 3; continue; }
        if (s[this.i + 1] === '=') { out.push({ t: 'le', i: at }); this.i += 2; continue; }
        out.push({ t: 'lt', i: at }); this.i++; continue;
      }
      if (c === '>') {
        if (s[this.i + 1] === '=') { out.push({ t: 'ge', i: at }); this.i += 2; continue; }
        out.push({ t: 'gt', i: at }); this.i++; continue;
      }
      if (c === '-') {
        if (s[this.i + 1] === '>') { out.push({ t: 'implies', i: at }); this.i += 2; continue; }
        out.push({ t: 'minus', i: at }); this.i++; continue;
      }
      if (c === '!') {
        if (s[this.i + 1] === '=') { out.push({ t: 'ne', i: at }); this.i += 2; continue; }
        out.push({ t: 'not', i: at }); this.i++; continue;
      }
      if (/[0-9]/.test(c)) {
        let j = this.i + 1;
        while (j < s.length && /[0-9]/.test(s[j])) j++;
        out.push({ t: 'num', value: Number(s.slice(this.i, j)), i: at });
        this.i = j;
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        let j = this.i + 1;
        while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
        const word = s.slice(this.i, j);
        this.i = j;
        if (word === 'exists') { out.push({ t: 'exists', i: at }); continue; }
        if (word === 'forall') { out.push({ t: 'forall', i: at }); continue; }
        if (word === 'true') { out.push({ t: 'true', i: at }); continue; }
        if (word === 'false') { out.push({ t: 'false', i: at }); continue; }
        out.push({ t: 'id', name: word, i: at });
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
      const kind = c.t; // 'exists' | 'forall'
      const vars: string[] = [];
      // one or more bound variables: ∃x y z. φ  ≡  ∃x. ∃y. ∃z. φ
      while (this.cur().t === 'id') {
        vars.push((this.advance() as Extract<Tok, { t: 'id' }>).name);
        if (this.cur().t === 'comma') this.advance();
      }
      if (vars.length === 0) throw { message: `expected a variable after the quantifier`, index: this.cur().i } as ParseError;
      if (this.cur().t === 'dot') this.advance();
      let body = this.iff();
      for (let k = vars.length - 1; k >= 0; k--) body = { kind, v: vars[k], a: body };
      return body;
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
    return this.atom();
  }

  // atom: term  (= | < | <= | > | >= | != | ≡)  term  [ (mod m) ]
  private atom(): Formula {
    const left = this.term();
    const op = this.cur();
    const cmpMap: Partial<Record<Tok['t'], CmpOp>> = {
      eq: '=', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=',
    };
    if (op.t === 'equiv' || (op.t === 'eq')) {
      // possible congruence — but a plain '=' with no (mod m) is an equality.
      this.advance();
      const right = this.term();
      if (this.isMod()) {
        const m = this.consumeMod();
        // (left − right) ≡ 0 (mod m)  ⇒  Σ coef·v ≡ (right.konst − left.konst) (mod m)
        const diff = subTerms(left, right);
        return { kind: 'mod', coef: pruneCoef(diff.coef), r: right.konst - left.konst, m };
      }
      if (op.t === 'equiv') {
        throw { message: `'≡' is a congruence and must be followed by (mod m)`, index: op.i } as ParseError;
      }
      return this.cmp('=', left, right);
    }
    const mapped = cmpMap[op.t];
    if (mapped) {
      this.advance();
      const right = this.term();
      return this.cmp(mapped, left, right);
    }
    throw { message: `expected a comparison operator (=, <, <=, >, >=, !=) after the term`, index: op.i } as ParseError;
  }

  private cmp(operator: CmpOp, left: LinTerm, right: LinTerm): Formula {
    const diff = subTerms(left, right); // Σ coef·v + konst  ⋈  0
    const coef = pruneCoef(diff.coef);
    const c = -diff.konst; // Σ coef·v  ⋈  c
    return { kind: 'cmp', op: operator, coef, c };
  }

  private isMod(): boolean {
    if (this.cur().t !== 'lp') return false;
    const nxt = this.toks[this.p + 1];
    return nxt !== undefined && nxt.t === 'id' && nxt.name === 'mod';
  }
  private consumeMod(): number {
    this.expect('lp', `'('`);
    this.advance(); // the 'mod' id
    const m = this.expect('num', `a modulus`) as Extract<Tok, { t: 'num' }>;
    this.expect('rp', `')'`);
    if (m.value < 1) throw { message: `the modulus must be at least 1`, index: m.i } as ParseError;
    return m.value;
  }

  // term: mulTerm (('+' | '-') mulTerm)*
  private term(): LinTerm {
    let acc = this.signedMul();
    for (;;) {
      const c = this.cur();
      if (c.t === 'plus') {
        this.advance();
        acc = addTerms(acc, this.mul());
      } else if (c.t === 'minus') {
        this.advance();
        acc = subTerms(acc, this.mul());
      } else break;
    }
    return acc;
  }
  private signedMul(): LinTerm {
    if (this.cur().t === 'minus') {
      this.advance();
      return scaleTerm(this.mul(), -1);
    }
    if (this.cur().t === 'plus') this.advance();
    return this.mul();
  }
  // mul: NUM ('*'? factor)? | factor
  private mul(): LinTerm {
    const c = this.cur();
    if (c.t === 'num') {
      this.advance();
      if (this.cur().t === 'star') {
        this.advance();
        return scaleTerm(this.factor(), c.value);
      }
      // implicit multiplication: 2x — only if a *variable* follows. A following
      // '(' is NOT implicit mult (it would swallow a trailing (mod m) suffix);
      // use explicit 2*(…) for that.
      if (this.cur().t === 'id') return scaleTerm(this.factor(), c.value);
      return constTerm(c.value);
    }
    return this.factor();
  }
  private factor(): LinTerm {
    const c = this.cur();
    if (c.t === 'id') {
      this.advance();
      return varTerm(c.name);
    }
    if (c.t === 'num') {
      this.advance();
      return constTerm(c.value);
    }
    if (c.t === 'lp') {
      this.advance();
      const inner = this.term();
      this.expect('rp', `')'`);
      return inner;
    }
    throw { message: `expected a variable, number, or '(' in the term`, index: c.i } as ParseError;
  }
}

export function parsePresburger(src: string): { formula: Formula | null; error: ParseError | null } {
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
