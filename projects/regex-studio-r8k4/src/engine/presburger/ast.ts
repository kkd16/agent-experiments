// Presburger arithmetic — the first-order theory of ⟨ℕ, +, <⟩ (with congruences).
//
// This is the number-theoretic twin of the studio's MSO[<] "Logic" tab. Where
// Büchi–Elgot–Trakhtenbrot reads a *string* logic into an automaton over word
// positions, Büchi–Bruyère–Villemaire reads *arithmetic* into an automaton over
// the **binary digits** of a tuple of naturals: a formula with free variables
// x₁…x_k compiles to a finite automaton over the alphabet {0,1}^k, one *track*
// per variable, and it accepts exactly the base-2 encodings (least-significant
// digit first) of the tuples that satisfy the formula. Quantifier elimination is
// projection; the boolean connectives are product / union / complement. That an
// automaton can decide every Presburger sentence is a 1960s landmark — the
// automata-theoretic decision procedure for Presburger arithmetic.
//
// Atoms are already normalised to a linear form  Σ aᵢ·xᵢ  ⋈  c  (for a
// comparison) or  Σ aᵢ·xᵢ ≡ r (mod m)  (for a congruence), so the compiler and
// the oracle both read the same canonical data — no term AST to interpret twice.

export type CmpOp = '=' | '<=' | '<' | '>=' | '>' | '!=';

// A linear term Σ coef[v]·v + konst, built up by the parser.
export interface LinTerm {
  coef: Record<string, number>;
  konst: number;
}

export type Formula =
  | { kind: 'true' }
  | { kind: 'false' }
  // Σ coef·v  OP  c   (the constant has been moved to the right-hand side)
  | { kind: 'cmp'; op: CmpOp; coef: Record<string, number>; c: number }
  // Σ coef·v ≡ r (mod m),  m ≥ 1
  | { kind: 'mod'; coef: Record<string, number>; r: number; m: number }
  | { kind: 'not'; a: Formula }
  | { kind: 'and'; a: Formula; b: Formula }
  | { kind: 'or'; a: Formula; b: Formula }
  | { kind: 'implies'; a: Formula; b: Formula }
  | { kind: 'iff'; a: Formula; b: Formula }
  | { kind: 'exists'; v: string; a: Formula }
  | { kind: 'forall'; v: string; a: Formula };

// ── linear-term algebra (used by the parser) ──────────────────────────────────
export function constTerm(k: number): LinTerm {
  return { coef: {}, konst: k };
}
export function varTerm(name: string): LinTerm {
  return { coef: { [name]: 1 }, konst: 0 };
}
export function addTerms(a: LinTerm, b: LinTerm): LinTerm {
  const coef: Record<string, number> = { ...a.coef };
  for (const [v, k] of Object.entries(b.coef)) coef[v] = (coef[v] ?? 0) + k;
  return { coef, konst: a.konst + b.konst };
}
export function scaleTerm(a: LinTerm, s: number): LinTerm {
  const coef: Record<string, number> = {};
  for (const [v, k] of Object.entries(a.coef)) coef[v] = k * s;
  return { coef, konst: a.konst * s };
}
export function subTerms(a: LinTerm, b: LinTerm): LinTerm {
  return addTerms(a, scaleTerm(b, -1));
}

// Drop zero coefficients so free-variable analysis and track lists agree with
// what actually influences the value.
export function pruneCoef(coef: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [v, k] of Object.entries(coef)) if (k !== 0) out[v] = k;
  return out;
}

export function variablesOf(coef: Record<string, number>): string[] {
  return Object.keys(pruneCoef(coef)).sort();
}

// ── free variables ────────────────────────────────────────────────────────────
export function freeVars(f: Formula): Set<string> {
  const out = new Set<string>();
  walk(f, out);
  return out;
}
function walk(f: Formula, out: Set<string>): void {
  switch (f.kind) {
    case 'true':
    case 'false':
      return;
    case 'cmp':
    case 'mod':
      for (const v of variablesOf(f.coef)) out.add(v);
      return;
    case 'not':
      walk(f.a, out);
      return;
    case 'and':
    case 'or':
    case 'implies':
    case 'iff':
      walk(f.a, out);
      walk(f.b, out);
      return;
    case 'exists':
    case 'forall': {
      const inner = freeVars(f.a);
      inner.delete(f.v);
      for (const v of inner) out.add(v);
      return;
    }
  }
}

export function isSentence(f: Formula): boolean {
  return freeVars(f).size === 0;
}

// Node count, for the construction-blow-up display.
export function formulaSize(f: Formula): number {
  switch (f.kind) {
    case 'not':
    case 'exists':
    case 'forall':
      return 1 + formulaSize(f.a);
    case 'and':
    case 'or':
    case 'implies':
    case 'iff':
      return 1 + formulaSize(f.a) + formulaSize(f.b);
    default:
      return 1;
  }
}

// ── pretty-printing (canonical Unicode) ───────────────────────────────────────
const PREC: Record<string, number> = { iff: 1, implies: 2, or: 3, and: 4 };

export function formulaToString(f: Formula): string {
  return render(f, 0);
}

function renderLinear(coef: Record<string, number>): string {
  const terms = variablesOf(coef);
  if (terms.length === 0) return '0';
  const parts: string[] = [];
  terms.forEach((v, i) => {
    const k = coef[v];
    const mag = Math.abs(k);
    const sign = k < 0 ? '−' : '+';
    const body = mag === 1 ? v : `${mag}·${v}`;
    if (i === 0) parts.push(k < 0 ? `−${body}` : body);
    else parts.push(` ${sign} ${body}`);
  });
  return parts.join('');
}

function renderConst(c: number): string {
  return c < 0 ? `−${Math.abs(c)}` : String(c);
}

const OP_SYM: Record<CmpOp, string> = { '=': '=', '<=': '≤', '<': '<', '>=': '≥', '>': '>', '!=': '≠' };

function render(f: Formula, parentPrec: number): string {
  switch (f.kind) {
    case 'true':
      return 'true';
    case 'false':
      return 'false';
    case 'cmp':
      return `${renderLinear(f.coef)} ${OP_SYM[f.op]} ${renderConst(f.c)}`;
    case 'mod':
      return `${renderLinear(f.coef)} ≡ ${renderConst(f.r)} (mod ${f.m})`;
    case 'not':
      return `¬${render(f.a, 5)}`;
    case 'and':
    case 'or':
    case 'implies':
    case 'iff': {
      const sym = f.kind === 'and' ? '∧' : f.kind === 'or' ? '∨' : f.kind === 'implies' ? '→' : '↔';
      const p = PREC[f.kind];
      const left = render(f.a, p + (f.kind === 'implies' || f.kind === 'iff' ? 0 : 1));
      const right = render(f.b, p + 1);
      const s = `${left} ${sym} ${right}`;
      return p < parentPrec ? `(${s})` : s;
    }
    case 'exists':
      return wrapQ(`∃${f.v}`, f.a, parentPrec);
    case 'forall':
      return wrapQ(`∀${f.v}`, f.a, parentPrec);
  }
}

function wrapQ(q: string, body: Formula, parentPrec: number): string {
  const s = `${q}. ${render(body, 1)}`;
  return parentPrec > 0 ? `(${s})` : s;
}
