// LTLf — linear temporal logic over *finite* traces — and Kamp's theorem made
// operational. Each position carries exactly one letter, so an atomic
// proposition `a` is "the current letter is a" = Qa(now). We parse LTLf and
// translate it into FO[<] with one free "now" variable, then close it at the
// first position. Because the result is first-order, it compiles (via the same
// Büchi pipeline) to a *star-free* automaton — which is Kamp's theorem
// (LTL = FO over a linear order) shown, not asserted.
//
//   ⟦a⟧(x)      = Qa(x)
//   ⟦X φ⟧(x)    = ∃y. S(x,y) ∧ ⟦φ⟧(y)               (strong next)
//   ⟦F φ⟧(x)    = ∃y. x ≤ y ∧ ⟦φ⟧(y)
//   ⟦G φ⟧(x)    = ∀y. x ≤ y → ⟦φ⟧(y)
//   ⟦φ U ψ⟧(x)  = ∃y. x ≤ y ∧ ⟦ψ⟧(y) ∧ ∀z. (x ≤ z ∧ z < y) → ⟦φ⟧(z)
//   ⟦φ R ψ⟧(x)  = ⟦¬(¬φ U ¬ψ)⟧(x)
//   sentence    = ∃x. first(x) ∧ ⟦φ⟧(x),   first(x) = ¬∃w. w < x

import type { Formula } from './ast';

export type LTL =
  | { k: 'prop'; letter: string }
  | { k: 'true' }
  | { k: 'false' }
  | { k: 'not'; a: LTL }
  | { k: 'and'; a: LTL; b: LTL }
  | { k: 'or'; a: LTL; b: LTL }
  | { k: 'implies'; a: LTL; b: LTL }
  | { k: 'iff'; a: LTL; b: LTL }
  | { k: 'next'; a: LTL }
  | { k: 'eventually'; a: LTL }
  | { k: 'globally'; a: LTL }
  | { k: 'until'; a: LTL; b: LTL }
  | { k: 'release'; a: LTL; b: LTL };

export interface ParseError {
  message: string;
  index: number;
}

type Tok =
  | { t: 'lp' | 'rp' | 'eof' | 'not' | 'and' | 'or' | 'implies' | 'iff' | 'next' | 'eventually' | 'globally' | 'until' | 'release' | 'true' | 'false'; i: number }
  | { t: 'prop'; letter: string; i: number };

function lex(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    const at = i;
    if (c === '(') { out.push({ t: 'lp', i: at }); i++; continue; }
    if (c === ')') { out.push({ t: 'rp', i: at }); i++; continue; }
    if (c === '~' || c === '¬' || c === '!') { out.push({ t: 'not', i: at }); i++; continue; }
    if (c === '&' || c === '∧') { out.push({ t: 'and', i: at }); i++; continue; }
    if (c === '|' || c === '∨') { out.push({ t: 'or', i: at }); i++; continue; }
    if (c === '→' || c === '⇒') { out.push({ t: 'implies', i: at }); i++; continue; }
    if (c === '↔' || c === '⇔') { out.push({ t: 'iff', i: at }); i++; continue; }
    if (c === '◯' || c === '○') { out.push({ t: 'next', i: at }); i++; continue; }
    if (c === '◇') { out.push({ t: 'eventually', i: at }); i++; continue; }
    if (c === '□' || c === '■') { out.push({ t: 'globally', i: at }); i++; continue; }
    if (c === '-' && s[i + 1] === '>') { out.push({ t: 'implies', i: at }); i += 2; continue; }
    if (c === '<' && s[i + 1] === '-' && s[i + 2] === '>') { out.push({ t: 'iff', i: at }); i += 3; continue; }
    if (/[A-Za-z]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      const w = s.slice(i, j);
      i = j;
      if (w === 'X') { out.push({ t: 'next', i: at }); continue; }
      if (w === 'F') { out.push({ t: 'eventually', i: at }); continue; }
      if (w === 'G') { out.push({ t: 'globally', i: at }); continue; }
      if (w === 'U') { out.push({ t: 'until', i: at }); continue; }
      if (w === 'R') { out.push({ t: 'release', i: at }); continue; }
      if (w === 'true') { out.push({ t: 'true', i: at }); continue; }
      if (w === 'false') { out.push({ t: 'false', i: at }); continue; }
      out.push({ t: 'prop', letter: w, i: at });
      continue;
    }
    throw { message: `unexpected character '${c}'`, index: at } as ParseError;
  }
  out.push({ t: 'eof', i });
  return out;
}

class P {
  private p = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }
  private cur() { return this.toks[this.p]; }
  private adv() { return this.toks[this.p++]; }

  parse(): LTL {
    const f = this.iff();
    if (this.cur().t !== 'eof') throw { message: 'unexpected trailing input', index: this.cur().i } as ParseError;
    return f;
  }
  private iff(): LTL {
    let a = this.implies();
    while (this.cur().t === 'iff') { this.adv(); a = { k: 'iff', a, b: this.implies() }; }
    return a;
  }
  private implies(): LTL {
    const a = this.or();
    if (this.cur().t === 'implies') { this.adv(); return { k: 'implies', a, b: this.implies() }; }
    return a;
  }
  private or(): LTL {
    let a = this.and();
    while (this.cur().t === 'or') { this.adv(); a = { k: 'or', a, b: this.and() }; }
    return a;
  }
  private and(): LTL {
    let a = this.binTemporal();
    while (this.cur().t === 'and') { this.adv(); a = { k: 'and', a, b: this.binTemporal() }; }
    return a;
  }
  private binTemporal(): LTL {
    const a = this.unary();
    const c = this.cur();
    if (c.t === 'until') { this.adv(); return { k: 'until', a, b: this.binTemporal() }; }
    if (c.t === 'release') { this.adv(); return { k: 'release', a, b: this.binTemporal() }; }
    return a;
  }
  private unary(): LTL {
    const c = this.cur();
    if (c.t === 'not') { this.adv(); return { k: 'not', a: this.unary() }; }
    if (c.t === 'next') { this.adv(); return { k: 'next', a: this.unary() }; }
    if (c.t === 'eventually') { this.adv(); return { k: 'eventually', a: this.unary() }; }
    if (c.t === 'globally') { this.adv(); return { k: 'globally', a: this.unary() }; }
    return this.atom();
  }
  private atom(): LTL {
    const c = this.cur();
    if (c.t === 'lp') { this.adv(); const f = this.iff(); if (this.cur().t !== 'rp') throw { message: `expected ')'`, index: this.cur().i } as ParseError; this.adv(); return f; }
    if (c.t === 'true') { this.adv(); return { k: 'true' }; }
    if (c.t === 'false') { this.adv(); return { k: 'false' }; }
    if (c.t === 'prop') { this.adv(); return { k: 'prop', letter: c.letter }; }
    throw { message: 'expected a proposition', index: c.i } as ParseError;
  }
}

// ── translation to FO[<] ────────────────────────────────────────────────────
class Fresh {
  private n = 0;
  next(): string {
    return `t${this.n++}`;
  }
}

function tr(phi: LTL, x: string, fresh: Fresh): Formula {
  switch (phi.k) {
    case 'prop':
      return { kind: 'label', letter: phi.letter, x };
    case 'true':
      return { kind: 'true' };
    case 'false':
      return { kind: 'false' };
    case 'not':
      return { kind: 'not', a: tr(phi.a, x, fresh) };
    case 'and':
      return { kind: 'and', a: tr(phi.a, x, fresh), b: tr(phi.b, x, fresh) };
    case 'or':
      return { kind: 'or', a: tr(phi.a, x, fresh), b: tr(phi.b, x, fresh) };
    case 'implies':
      return { kind: 'implies', a: tr(phi.a, x, fresh), b: tr(phi.b, x, fresh) };
    case 'iff':
      return { kind: 'iff', a: tr(phi.a, x, fresh), b: tr(phi.b, x, fresh) };
    case 'next': {
      const y = fresh.next();
      return { kind: 'existsFO', v: y, a: { kind: 'and', a: { kind: 'succ', x, y }, b: tr(phi.a, y, fresh) } };
    }
    case 'eventually': {
      const y = fresh.next();
      return { kind: 'existsFO', v: y, a: { kind: 'and', a: { kind: 'le', x, y }, b: tr(phi.a, y, fresh) } };
    }
    case 'globally': {
      const y = fresh.next();
      return { kind: 'forallFO', v: y, a: { kind: 'implies', a: { kind: 'le', x, y }, b: tr(phi.a, y, fresh) } };
    }
    case 'until': {
      const y = fresh.next();
      const z = fresh.next();
      const inner: Formula = {
        kind: 'and',
        a: { kind: 'le', x, y },
        b: {
          kind: 'and',
          a: tr(phi.b, y, fresh),
          b: {
            kind: 'forallFO',
            v: z,
            a: {
              kind: 'implies',
              a: { kind: 'and', a: { kind: 'le', x, y: z }, b: { kind: 'lt', x: z, y } },
              b: tr(phi.a, z, fresh),
            },
          },
        },
      };
      return { kind: 'existsFO', v: y, a: inner };
    }
    case 'release':
      return tr({ k: 'not', a: { k: 'until', a: { k: 'not', a: phi.a }, b: { k: 'not', a: phi.b } } }, x, fresh);
  }
}

// LTLf φ → the FO sentence whose language is { nonempty w : w,0 ⊨ φ }.
export function ltlToSentence(phi: LTL): Formula {
  const fresh = new Fresh();
  const x = fresh.next();
  const w = fresh.next();
  const first: Formula = { kind: 'not', a: { kind: 'existsFO', v: w, a: { kind: 'lt', x: w, y: x } } };
  return { kind: 'existsFO', v: x, a: { kind: 'and', a: first, b: tr(phi, x, fresh) } };
}

export function parseLTLf(src: string): { ltl: LTL | null; formula: Formula | null; error: ParseError | null } {
  try {
    const toks = lex(src);
    if (toks.length === 1) return { ltl: null, formula: null, error: { message: 'empty formula', index: 0 } };
    const ltl = new P(toks).parse();
    return { ltl, formula: ltlToSentence(ltl), error: null };
  } catch (e) {
    const err = e as ParseError;
    if (err && typeof err.index === 'number') return { ltl: null, formula: null, error: err };
    return { ltl: null, formula: null, error: { message: String((e as Error)?.message ?? e), index: 0 } };
  }
}

export function ltlToString(phi: LTL): string {
  const r = (f: LTL, parent: number): string => {
    const wrap = (s: string, p: number) => (p < parent ? `(${s})` : s);
    switch (f.k) {
      case 'prop': return f.letter;
      case 'true': return 'true';
      case 'false': return 'false';
      case 'not': return `¬${r(f.a, 5)}`;
      case 'next': return `X ${r(f.a, 5)}`;
      case 'eventually': return `F ${r(f.a, 5)}`;
      case 'globally': return `G ${r(f.a, 5)}`;
      case 'and': return wrap(`${r(f.a, 4)} ∧ ${r(f.b, 4)}`, 4);
      case 'or': return wrap(`${r(f.a, 3)} ∨ ${r(f.b, 3)}`, 3);
      case 'until': return wrap(`${r(f.a, 4)} U ${r(f.b, 4)}`, 3);
      case 'release': return wrap(`${r(f.a, 4)} R ${r(f.b, 4)}`, 3);
      case 'implies': return wrap(`${r(f.a, 3)} → ${r(f.b, 2)}`, 2);
      case 'iff': return wrap(`${r(f.a, 2)} ↔ ${r(f.b, 2)}`, 1);
    }
  };
  return r(phi, 0);
}
