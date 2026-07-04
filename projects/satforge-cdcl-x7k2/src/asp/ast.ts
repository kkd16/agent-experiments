// The non-ground AST for the ASP front-end language — a gringo-flavoured subset:
// normal rules, integrity constraints, choice rules with cardinality bounds and
// conditional literals, first-order variables, integer arithmetic, comparison
// built-ins and `1..n` intervals. Function terms are deliberately excluded so the
// Herbrand base stays finite and grounding always terminates.

export type Term =
  | { t: 'int'; v: number }
  | { t: 'const'; name: string } // a symbolic constant (lowercase identifier)
  | { t: 'var'; name: string } // a first-order variable (uppercase or _)
  | { t: 'neg'; a: Term } // unary minus
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '\\'; a: Term; b: Term }

/** An argument position: a term, or a `lo..hi` interval that expands at grounding. */
export type Arg = { a: 'term'; term: Term } | { a: 'range'; lo: Term; hi: Term }

export interface Atom {
  pred: string
  args: Arg[]
}

export type CompareOp = '=' | '!=' | '<' | '<=' | '>' | '>='

export type BodyLit =
  | { k: 'pos'; atom: Atom }
  | { k: 'neg'; atom: Atom } // default negation: `not atom`
  | { k: 'cmp'; op: CompareOp; a: Term; b: Term }

/** One element of a choice: a head atom, optionally guarded by a condition
 *  (`h(X) : dom(X)`) whose local variables expand the head over its domain. */
export interface CondLit {
  atom: Atom
  cond: BodyLit[]
}

export type Head =
  | { h: 'atom'; atom: Atom }
  | { h: 'choice'; lo: Term | null; hi: Term | null; elems: CondLit[] }
  | { h: 'constraint' }

export interface Rule {
  head: Head
  body: BodyLit[]
  /** 1-based source line the rule began on (for error messages). */
  line: number
}

export function varsOfTerm(t: Term, out: Set<string>): void {
  if (t.t === 'var') out.add(t.name)
  else if (t.t === 'neg') varsOfTerm(t.a, out)
  else if (t.t === 'bin') {
    varsOfTerm(t.a, out)
    varsOfTerm(t.b, out)
  }
}

export function varsOfArg(a: Arg, out: Set<string>): void {
  if (a.a === 'term') varsOfTerm(a.term, out)
  else {
    varsOfTerm(a.lo, out)
    varsOfTerm(a.hi, out)
  }
}

export function varsOfAtom(atom: Atom, out: Set<string>): void {
  for (const a of atom.args) varsOfArg(a, out)
}
