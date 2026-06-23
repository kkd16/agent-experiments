// The monadic second-order logic of one successor (over finite words) — MSO[<].
//
// Terms are positions, named by first-order variables (lowercase: x, y, …).
// Second-order variables (uppercase: X, Y, …) range over *sets* of positions.
// Atoms: Qa(x) ("position x carries letter a"), order x<y / x<=y / x=y,
// successor S(x,y) ("y = x+1"), membership x∈X, and the constants true/false.
// Büchi–Elgot–Trakhtenbrot: a language is regular iff it is the set of words
// satisfying some MSO *sentence* (no free variables) over these atoms.

export type Formula =
  | { kind: 'true' }
  | { kind: 'false' }
  | { kind: 'label'; letter: string; x: string } // Qa(x)
  | { kind: 'lt'; x: string; y: string } // x < y
  | { kind: 'le'; x: string; y: string } // x <= y
  | { kind: 'eq'; x: string; y: string } // x = y
  | { kind: 'succ'; x: string; y: string } // S(x,y): y = x + 1
  | { kind: 'mem'; x: string; set: string } // x ∈ X
  | { kind: 'not'; a: Formula }
  | { kind: 'and'; a: Formula; b: Formula }
  | { kind: 'or'; a: Formula; b: Formula }
  | { kind: 'implies'; a: Formula; b: Formula }
  | { kind: 'iff'; a: Formula; b: Formula }
  | { kind: 'existsFO'; v: string; a: Formula }
  | { kind: 'forallFO'; v: string; a: Formula }
  | { kind: 'existsSO'; v: string; a: Formula }
  | { kind: 'forallSO'; v: string; a: Formula };

export interface FreeVars {
  fo: Set<string>;
  so: Set<string>;
}

export function freeVars(f: Formula): FreeVars {
  const fo = new Set<string>();
  const so = new Set<string>();
  walkFree(f, fo, so);
  return { fo, so };
}

function walkFree(f: Formula, fo: Set<string>, so: Set<string>): void {
  switch (f.kind) {
    case 'true':
    case 'false':
      return;
    case 'label':
      fo.add(f.x);
      return;
    case 'lt':
    case 'le':
    case 'eq':
    case 'succ':
      fo.add(f.x);
      fo.add(f.y);
      return;
    case 'mem':
      fo.add(f.x);
      so.add(f.set);
      return;
    case 'not':
      walkFree(f.a, fo, so);
      return;
    case 'and':
    case 'or':
    case 'implies':
    case 'iff':
      walkFree(f.a, fo, so);
      walkFree(f.b, fo, so);
      return;
    case 'existsFO':
    case 'forallFO': {
      const inner = freeVars(f.a);
      inner.fo.delete(f.v);
      for (const v of inner.fo) fo.add(v);
      for (const v of inner.so) so.add(v);
      return;
    }
    case 'existsSO':
    case 'forallSO': {
      const inner = freeVars(f.a);
      inner.so.delete(f.v);
      for (const v of inner.fo) fo.add(v);
      for (const v of inner.so) so.add(v);
      return;
    }
  }
}

// A sentence has no free variables — the Büchi theorem is about sentences.
export function isSentence(f: Formula): boolean {
  const fv = freeVars(f);
  return fv.fo.size === 0 && fv.so.size === 0;
}

// First-order: no second-order quantifier anywhere. By McNaughton–Papert an FO
// sentence defines a *star-free* language — checked live against the studio's
// own syntactic-monoid engine.
export function isFirstOrder(f: Formula): boolean {
  switch (f.kind) {
    case 'existsSO':
    case 'forallSO':
      return false;
    case 'not':
      return isFirstOrder(f.a);
    case 'and':
    case 'or':
    case 'implies':
    case 'iff':
      return isFirstOrder(f.a) && isFirstOrder(f.b);
    case 'existsFO':
    case 'forallFO':
      return isFirstOrder(f.a);
    default:
      return true;
  }
}

// Quantifier-rank style size: number of nodes, for the blow-up display.
export function formulaSize(f: Formula): number {
  switch (f.kind) {
    case 'not':
    case 'existsFO':
    case 'forallFO':
    case 'existsSO':
    case 'forallSO':
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

// Pretty-print a formula back to the canonical concrete syntax (Unicode).
export function formulaToString(f: Formula): string {
  return render(f, 0);
}

const PREC: Record<string, number> = { iff: 1, implies: 2, or: 3, and: 4 };

function render(f: Formula, parentPrec: number): string {
  switch (f.kind) {
    case 'true':
      return 'true';
    case 'false':
      return 'false';
    case 'label':
      return `Q${f.letter}(${f.x})`;
    case 'lt':
      return `${f.x} < ${f.y}`;
    case 'le':
      return `${f.x} ≤ ${f.y}`;
    case 'eq':
      return `${f.x} = ${f.y}`;
    case 'succ':
      return `S(${f.x},${f.y})`;
    case 'mem':
      return `${f.x} ∈ ${f.set}`;
    case 'not':
      return `¬${render(f.a, 5)}`;
    case 'and':
    case 'or':
    case 'implies':
    case 'iff': {
      const sym = f.kind === 'and' ? '∧' : f.kind === 'or' ? '∨' : f.kind === 'implies' ? '→' : '↔';
      const p = PREC[f.kind];
      const s = `${render(f.a, p + (f.kind === 'implies' || f.kind === 'iff' ? 0 : 1))} ${sym} ${render(f.b, p + 1)}`;
      return p < parentPrec ? `(${s})` : s;
    }
    case 'existsFO':
      return wrapQ(`∃${f.v}`, f.a, parentPrec);
    case 'forallFO':
      return wrapQ(`∀${f.v}`, f.a, parentPrec);
    case 'existsSO':
      return wrapQ(`∃${f.v}`, f.a, parentPrec);
    case 'forallSO':
      return wrapQ(`∀${f.v}`, f.a, parentPrec);
  }
}

function wrapQ(q: string, body: Formula, parentPrec: number): string {
  const s = `${q}. ${render(body, 1)}`;
  return parentPrec > 0 ? `(${s})` : s;
}
