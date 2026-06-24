// LTL — linear temporal logic over *infinite* traces — and the parser, the
// negation-normal-form rewrite, and the desugaring to the small core the GPVW
// tableau consumes.
//
// Each position of an ω-word carries exactly one letter of Σ, so an atomic
// proposition `a` is "the current letter is a" (= Qa(now)). The temporal
// operators are the usual ones; `F`/`G`/`W`/`M` are syntactic sugar over the
// `U`/`R` core:
//
//   F φ ≡ true U φ           (eventually)
//   G φ ≡ false R φ          (globally / always)
//   φ W ψ ≡ (φ U ψ) ∨ G φ ≡ ψ R (ψ ∨ φ)   (weak until)
//   φ M ψ ≡ ψ U (φ ∧ ψ)     (strong release)
//
// The tableau only ever sees {X, U, R, ∧, ∨, literal}, so after NNF every
// negation sits on a proposition.

export type LTL =
  | { k: 'true' }
  | { k: 'false' }
  | { k: 'prop'; letter: string }
  | { k: 'not'; a: LTL }
  | { k: 'and'; a: LTL; b: LTL }
  | { k: 'or'; a: LTL; b: LTL }
  | { k: 'implies'; a: LTL; b: LTL }
  | { k: 'iff'; a: LTL; b: LTL }
  | { k: 'next'; a: LTL }
  | { k: 'eventually'; a: LTL }
  | { k: 'globally'; a: LTL }
  | { k: 'until'; a: LTL; b: LTL }
  | { k: 'release'; a: LTL; b: LTL }
  | { k: 'weakuntil'; a: LTL; b: LTL }
  | { k: 'strongrelease'; a: LTL; b: LTL };

export interface ParseError {
  message: string;
  index: number;
}

type TokKind =
  | 'lp' | 'rp' | 'eof' | 'not' | 'and' | 'or' | 'implies' | 'iff'
  | 'next' | 'eventually' | 'globally' | 'until' | 'release' | 'weakuntil'
  | 'strongrelease' | 'true' | 'false';
type Tok =
  | { t: TokKind; i: number }
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
    if (c === '◯' || c === '○' || c === '◌') { out.push({ t: 'next', i: at }); i++; continue; }
    if (c === '◇' || c === '♢' || c === '⋄') { out.push({ t: 'eventually', i: at }); i++; continue; }
    if (c === '□' || c === '■' || c === '▢') { out.push({ t: 'globally', i: at }); i++; continue; }
    if (c === '-' && s[i + 1] === '>') { out.push({ t: 'implies', i: at }); i += 2; continue; }
    if (c === '<' && s[i + 1] === '-' && s[i + 2] === '>') { out.push({ t: 'iff', i: at }); i += 3; continue; }
    if (/[A-Za-z]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      const w = s.slice(i, j);
      i = j;
      // Single capital temporal keywords; everything else is a proposition (a letter).
      if (w === 'X') { out.push({ t: 'next', i: at }); continue; }
      if (w === 'F') { out.push({ t: 'eventually', i: at }); continue; }
      if (w === 'G') { out.push({ t: 'globally', i: at }); continue; }
      if (w === 'U') { out.push({ t: 'until', i: at }); continue; }
      if (w === 'R' || w === 'V') { out.push({ t: 'release', i: at }); continue; }
      if (w === 'W') { out.push({ t: 'weakuntil', i: at }); continue; }
      if (w === 'M') { out.push({ t: 'strongrelease', i: at }); continue; }
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

// Precedence (low → high): ↔, →, ∨, ∧, {U R W M}, {¬ X F G unary}, atom.
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
    if (c.t === 'weakuntil') { this.adv(); return { k: 'weakuntil', a, b: this.binTemporal() }; }
    if (c.t === 'strongrelease') { this.adv(); return { k: 'strongrelease', a, b: this.binTemporal() }; }
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
    if (c.t === 'lp') {
      this.adv();
      const f = this.iff();
      if (this.cur().t !== 'rp') throw { message: `expected ')'`, index: this.cur().i } as ParseError;
      this.adv();
      return f;
    }
    if (c.t === 'true') { this.adv(); return { k: 'true' }; }
    if (c.t === 'false') { this.adv(); return { k: 'false' }; }
    if (c.t === 'prop') { this.adv(); return { k: 'prop', letter: c.letter }; }
    throw { message: 'expected a proposition', index: c.i } as ParseError;
  }
}

export function parseLTL(src: string): { ltl: LTL | null; error: ParseError | null } {
  try {
    const toks = lex(src);
    if (toks.length === 1) return { ltl: null, error: { message: 'empty formula', index: 0 } };
    return { ltl: new P(toks).parse(), error: null };
  } catch (e) {
    const err = e as ParseError;
    if (err && typeof err.index === 'number') return { ltl: null, error: err };
    return { ltl: null, error: { message: String((e as Error)?.message ?? e), index: 0 } };
  }
}

// ── the propositions referenced (so the panel can warn about letters off Σ) ──
export function propsOf(phi: LTL): Set<string> {
  const out = new Set<string>();
  const go = (f: LTL): void => {
    switch (f.k) {
      case 'prop': out.add(f.letter); return;
      case 'true': case 'false': return;
      case 'not': case 'next': case 'eventually': case 'globally': go(f.a); return;
      default: go(f.a); go(f.b);
    }
  };
  go(phi);
  return out;
}

// ── negation-normal form: push ¬ down to the literals ──────────────────────
// First desugar F/G/W/M to U/R, then push negations using the temporal duals.
export type Core =
  | { k: 'true' }
  | { k: 'false' }
  | { k: 'prop'; letter: string }
  | { k: 'nprop'; letter: string } // ¬prop — the only negated form NNF leaves
  | { k: 'and'; a: Core; b: Core }
  | { k: 'or'; a: Core; b: Core }
  | { k: 'next'; a: Core }
  | { k: 'until'; a: Core; b: Core }
  | { k: 'release'; a: Core; b: Core };

// nnf(φ): the NNF core of φ. neg=true means we are building ¬φ.
export function toCore(phi: LTL): Core {
  return nnf(phi, false);
}

function nnf(f: LTL, neg: boolean): Core {
  switch (f.k) {
    case 'true': return neg ? { k: 'false' } : { k: 'true' };
    case 'false': return neg ? { k: 'true' } : { k: 'false' };
    case 'prop': return neg ? { k: 'nprop', letter: f.letter } : { k: 'prop', letter: f.letter };
    case 'not': return nnf(f.a, !neg);
    case 'and':
      return neg
        ? { k: 'or', a: nnf(f.a, true), b: nnf(f.b, true) }
        : { k: 'and', a: nnf(f.a, false), b: nnf(f.b, false) };
    case 'or':
      return neg
        ? { k: 'and', a: nnf(f.a, true), b: nnf(f.b, true) }
        : { k: 'or', a: nnf(f.a, false), b: nnf(f.b, false) };
    case 'implies': // a→b ≡ ¬a ∨ b
      return nnf({ k: 'or', a: { k: 'not', a: f.a }, b: f.b }, neg);
    case 'iff': // a↔b ≡ (a→b) ∧ (b→a)
      return nnf(
        { k: 'and', a: { k: 'implies', a: f.a, b: f.b }, b: { k: 'implies', a: f.b, b: f.a } },
        neg,
      );
    case 'next': // ¬Xφ ≡ X¬φ (self-dual on infinite words)
      return { k: 'next', a: nnf(f.a, neg) };
    case 'eventually': // Fφ ≡ true U φ ; ¬Fφ ≡ G¬φ ≡ false R ¬φ
      return neg
        ? { k: 'release', a: { k: 'false' }, b: nnf(f.a, true) }
        : { k: 'until', a: { k: 'true' }, b: nnf(f.a, false) };
    case 'globally': // Gφ ≡ false R φ ; ¬Gφ ≡ F¬φ ≡ true U ¬φ
      return neg
        ? { k: 'until', a: { k: 'true' }, b: nnf(f.a, true) }
        : { k: 'release', a: { k: 'false' }, b: nnf(f.a, false) };
    case 'until': // ¬(φUψ) ≡ ¬φ R ¬ψ
      return neg
        ? { k: 'release', a: nnf(f.a, true), b: nnf(f.b, true) }
        : { k: 'until', a: nnf(f.a, false), b: nnf(f.b, false) };
    case 'release': // ¬(φRψ) ≡ ¬φ U ¬ψ
      return neg
        ? { k: 'until', a: nnf(f.a, true), b: nnf(f.b, true) }
        : { k: 'release', a: nnf(f.a, false), b: nnf(f.b, false) };
    case 'weakuntil': // φWψ ≡ ψ R (ψ ∨ φ) ; ¬(φWψ) ≡ ¬ψ U (¬ψ ∧ ¬φ) ≡ ¬ψ M ¬φ
      return nnf({ k: 'release', a: f.b, b: { k: 'or', a: f.b, b: f.a } }, neg);
    case 'strongrelease': // φMψ ≡ ψ U (φ ∧ ψ)
      return nnf({ k: 'until', a: f.b, b: { k: 'and', a: f.a, b: f.b } }, neg);
  }
}

// ── pretty-printers ─────────────────────────────────────────────────────────
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
      case 'weakuntil': return wrap(`${r(f.a, 4)} W ${r(f.b, 4)}`, 3);
      case 'strongrelease': return wrap(`${r(f.a, 4)} M ${r(f.b, 4)}`, 3);
      case 'implies': return wrap(`${r(f.a, 3)} → ${r(f.b, 2)}`, 2);
      case 'iff': return wrap(`${r(f.a, 2)} ↔ ${r(f.b, 2)}`, 1);
    }
  };
  return r(phi, 0);
}

export function coreToString(f: Core): string {
  const r = (g: Core, parent: number): string => {
    const wrap = (s: string, p: number) => (p < parent ? `(${s})` : s);
    switch (g.k) {
      case 'prop': return g.letter;
      case 'nprop': return `¬${g.letter}`;
      case 'true': return '⊤';
      case 'false': return '⊥';
      case 'next': return `X ${r(g.a, 5)}`;
      case 'and': return wrap(`${r(g.a, 4)} ∧ ${r(g.b, 4)}`, 4);
      case 'or': return wrap(`${r(g.a, 3)} ∨ ${r(g.b, 3)}`, 3);
      case 'until': return wrap(`${r(g.a, 4)} U ${r(g.b, 4)}`, 3);
      case 'release': return wrap(`${r(g.a, 4)} R ${r(g.b, 4)}`, 3);
    }
  };
  return r(f, 0);
}

// A stable canonical key for a Core node — used by the tableau to dedupe the
// formula sets (Old/New/Next) and to index accepting sets by Until-subformula.
export function coreKey(f: Core): string {
  switch (f.k) {
    case 'true': return 'T';
    case 'false': return 'F';
    case 'prop': return `p:${f.letter}`;
    case 'nprop': return `n:${f.letter}`;
    case 'next': return `X(${coreKey(f.a)})`;
    case 'and': return `&(${coreKey(f.a)},${coreKey(f.b)})`;
    case 'or': return `|(${coreKey(f.a)},${coreKey(f.b)})`;
    case 'until': return `U(${coreKey(f.a)},${coreKey(f.b)})`;
    case 'release': return `R(${coreKey(f.a)},${coreKey(f.b)})`;
  }
}
