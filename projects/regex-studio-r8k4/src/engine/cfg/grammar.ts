// The context-free grammar data model — the first structure in the studio that
// reaches *outside* the regular languages. A grammar is a finite set of
// productions `A → γ` over two disjoint alphabets: terminals (the letters that
// end up in a word) and nonterminals (the variables that get rewritten). By
// convention here a terminal is a single character and a nonterminal is an
// uppercase-led token (`S`, `A'`, `T0`), which is exactly the studio's usual
// single-character alphabet plus a handful of variable names.

export interface Sym {
  kind: 'T' | 'N';
  name: string;
}

export interface Rule {
  lhs: string; // a nonterminal name
  rhs: Sym[]; // a (possibly empty) sequence of symbols; [] denotes ε
}

export interface Grammar {
  start: string;
  nonterminals: string[]; // includes start; deduped, in first-seen order
  terminals: string[]; // deduped, in first-seen order
  rules: Rule[];
}

export function term(name: string): Sym {
  return { kind: 'T', name };
}
export function nt(name: string): Sym {
  return { kind: 'N', name };
}
export function isN(s: Sym): boolean {
  return s.kind === 'N';
}
export function isT(s: Sym): boolean {
  return s.kind === 'T';
}

export function symKey(s: Sym): string {
  return (s.kind === 'N' ? 'N:' : 'T:') + s.name;
}
export function seqKey(seq: Sym[]): string {
  return seq.map(symKey).join(' ');
}
export function ruleKey(r: Rule): string {
  return `${r.lhs} -> ${seqKey(r.rhs)}`;
}

/** Pretty-print one symbol for the UI (ε already handled at the rhs level). */
export function symText(s: Sym): string {
  return s.name;
}

/** Pretty-print a right-hand side, showing ε for the empty sequence. */
export function rhsText(rhs: Sym[]): string {
  if (rhs.length === 0) return 'ε';
  return rhs.map((s) => s.name).join(' ');
}

/** Group a grammar's rules by their left-hand side, preserving nonterminal order. */
export function rulesByLhs(g: Grammar): Map<string, Rule[]> {
  const map = new Map<string, Rule[]>();
  for (const A of g.nonterminals) map.set(A, []);
  for (const r of g.rules) {
    const list = map.get(r.lhs);
    if (list) list.push(r);
    else map.set(r.lhs, [r]);
  }
  return map;
}

/**
 * Pretty-print the whole grammar in the studio's BNF style — one line per
 * nonterminal, its alternatives joined by ` | `, the start symbol first.
 */
export function grammarText(g: Grammar): string {
  const byLhs = rulesByLhs(g);
  const order = [g.start, ...g.nonterminals.filter((n) => n !== g.start)];
  const lines: string[] = [];
  for (const A of order) {
    const rules = byLhs.get(A);
    if (!rules || rules.length === 0) continue;
    const alts = rules.map((r) => rhsText(r.rhs)).join(' | ');
    lines.push(`${A} → ${alts}`);
  }
  return lines.join('\n');
}

/**
 * Rebuild the derived alphabets (nonterminals / terminals) from a rule list and
 * a start symbol, in first-seen order. Used after every transform so the model
 * stays internally consistent (no ghost symbols left in the alphabet arrays).
 */
export function makeGrammar(start: string, rules: Rule[]): Grammar {
  const nonterminals: string[] = [];
  const terminals: string[] = [];
  const seenN = new Set<string>();
  const seenT = new Set<string>();
  const addN = (n: string) => {
    if (!seenN.has(n)) {
      seenN.add(n);
      nonterminals.push(n);
    }
  };
  const addT = (t: string) => {
    if (!seenT.has(t)) {
      seenT.add(t);
      terminals.push(t);
    }
  };
  addN(start);
  for (const r of rules) {
    addN(r.lhs);
    for (const s of r.rhs) {
      if (s.kind === 'N') addN(s.name);
      else addT(s.name);
    }
  }
  return { start, nonterminals, terminals, rules };
}

/** A fresh nonterminal name not already used in `taken`. */
export function freshName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 0; ; i++) {
    const candidate = `${base}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
