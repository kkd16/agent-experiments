// Chomsky Normal Form — the textbook pipeline START → TERM → BIN → DEL → UNIT.
// Each step is language-preserving (a fuzzer invariant, not a promise), and the
// result has every rule in one of two shapes: `A → B C` (two nonterminals) or
// `A → a` (one terminal), plus at most one `S₀ → ε` when the empty string is in
// the language. CYK needs exactly this shape.

import type { Grammar, Rule, Sym } from './grammar';
import { freshName, makeGrammar, nt, ruleKey, seqKey, term } from './grammar';
import { nullableSet } from './analysis';

export interface CnfStep {
  step: string;
  detail: string;
  rules: number;
  nonterminals: number;
}

export interface CnfResult {
  grammar: Grammar;
  epsilon: boolean; // is the empty string in the language?
  trace: CnfStep[];
}

function dedupeRules(rules: Rule[]): Rule[] {
  const seen = new Set<string>();
  const out: Rule[] = [];
  for (const r of rules) {
    const k = ruleKey(r);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

function takenNames(rules: Rule[], start: string): Set<string> {
  const taken = new Set<string>([start]);
  for (const r of rules) {
    taken.add(r.lhs);
    for (const s of r.rhs) if (s.kind === 'N') taken.add(s.name);
  }
  return taken;
}

/** START — a fresh start symbol that never appears on a right-hand side. */
function stepStart(g: Grammar): { start: string; rules: Rule[] } {
  const taken = takenNames(g.rules, g.start);
  const s0 = freshName('S0', taken);
  const rules: Rule[] = [{ lhs: s0, rhs: [nt(g.start)] }, ...g.rules];
  return { start: s0, rules };
}

/** TERM — isolate terminals: in any rhs of length ≥ 2, replace `a` by `T_a` and add `T_a → a`. */
function stepTerm(start: string, rules: Rule[]): Rule[] {
  const taken = takenNames(rules, start);
  const termNt = new Map<string, string>(); // terminal → its lifting nonterminal
  const liftRules: Rule[] = [];
  const liftFor = (a: string): string => {
    let name = termNt.get(a);
    if (name === undefined) {
      name = freshName(`T_${a}`, taken);
      taken.add(name);
      termNt.set(a, name);
      liftRules.push({ lhs: name, rhs: [term(a)] });
    }
    return name;
  };
  const out: Rule[] = [];
  for (const r of rules) {
    if (r.rhs.length >= 2) {
      out.push({ lhs: r.lhs, rhs: r.rhs.map((s) => (s.kind === 'T' ? nt(liftFor(s.name)) : s)) });
    } else {
      out.push(r);
    }
  }
  return [...out, ...liftRules];
}

/** BIN — break any rhs of length ≥ 3 (all nonterminals after TERM) into a right chain of binary rules. */
function stepBin(start: string, rules: Rule[]): Rule[] {
  const taken = takenNames(rules, start);
  const out: Rule[] = [];
  for (const r of rules) {
    if (r.rhs.length <= 2) {
      out.push(r);
      continue;
    }
    // A → X1 X2 … Xk  ⇒  A → X1 C1, C1 → X2 C2, …, C_{k-2} → X_{k-1} Xk
    let lhs = r.lhs;
    for (let i = 0; i < r.rhs.length - 2; i++) {
      const c = freshName(`${r.lhs}_${i + 1}`, taken);
      taken.add(c);
      out.push({ lhs, rhs: [r.rhs[i], nt(c)] });
      lhs = c;
    }
    out.push({ lhs, rhs: [r.rhs[r.rhs.length - 2], r.rhs[r.rhs.length - 1]] });
  }
  return out;
}

/**
 * DEL — remove ε-productions. For every rule, emit all versions with each
 * subset of its nullable occurrences deleted, but never the empty rhs. Then drop
 * all `A → ε`. `epsilon` records whether the language contained the empty string
 * (the new start was nullable), so the caller can add back `S₀ → ε`.
 */
function stepDel(start: string, rules: Rule[]): { rules: Rule[]; epsilon: boolean } {
  const nullable = nullableSet(makeGrammar(start, rules));
  const epsilon = nullable.has(start);
  const out: Rule[] = [];
  for (const r of rules) {
    if (r.rhs.length === 0) continue; // drop the ε-rule itself
    // positions of nullable nonterminals in this rhs
    const nullablePos: number[] = [];
    for (let i = 0; i < r.rhs.length; i++) {
      const s = r.rhs[i];
      if (s.kind === 'N' && nullable.has(s.name)) nullablePos.push(i);
    }
    const m = nullablePos.length;
    // iterate over every subset of nullable positions to *delete*
    for (let mask = 0; mask < 1 << m; mask++) {
      const remove = new Set<number>();
      for (let b = 0; b < m; b++) if (mask & (1 << b)) remove.add(nullablePos[b]);
      const rhs: Sym[] = [];
      for (let i = 0; i < r.rhs.length; i++) if (!remove.has(i)) rhs.push(r.rhs[i]);
      if (rhs.length === 0) continue; // never introduce a new ε-rule
      out.push({ lhs: r.lhs, rhs });
    }
  }
  return { rules: dedupeRules(out), epsilon };
}

/**
 * UNIT — remove unit productions `A → B`. Compute the reflexive-transitive
 * unit-pair closure, then for every pair (A,B) copy B's non-unit rules onto A.
 */
function stepUnit(rules: Rule[]): Rule[] {
  // unit edges A → B
  const unitSucc = new Map<string, Set<string>>();
  const nonUnitByLhs = new Map<string, Rule[]>();
  for (const r of rules) {
    if (r.rhs.length === 1 && r.rhs[0].kind === 'N') {
      let s = unitSucc.get(r.lhs);
      if (!s) unitSucc.set(r.lhs, (s = new Set()));
      s.add(r.rhs[0].name);
    } else {
      let l = nonUnitByLhs.get(r.lhs);
      if (!l) nonUnitByLhs.set(r.lhs, (l = []));
      l.push(r);
    }
  }
  const out: Rule[] = [];
  const lhses = new Set(rules.map((r) => r.lhs));
  for (const A of lhses) {
    // reflexive-transitive closure of unit edges from A
    const reach = new Set<string>([A]);
    const stack = [A];
    while (stack.length) {
      const x = stack.pop() as string;
      for (const y of unitSucc.get(x) ?? []) if (!reach.has(y)) {
        reach.add(y);
        stack.push(y);
      }
    }
    for (const B of reach) {
      for (const r of nonUnitByLhs.get(B) ?? []) out.push({ lhs: A, rhs: r.rhs });
    }
  }
  return dedupeRules(out);
}

export function toChomskyNormalForm(input: Grammar): CnfResult {
  const trace: CnfStep[] = [];
  const record = (step: string, detail: string, start: string, rules: Rule[]) => {
    const nts = new Set<string>([start]);
    for (const r of rules) {
      nts.add(r.lhs);
      for (const s of r.rhs) if (s.kind === 'N') nts.add(s.name);
    }
    trace.push({ step, detail, rules: rules.length, nonterminals: nts.size });
  };

  record('input', 'the grammar as given', input.start, input.rules);

  const s = stepStart(input);
  record('START', 'add a fresh start symbol S₀ → S (so the start never recurses on a rhs)', s.start, s.rules);

  let rules = stepTerm(s.start, s.rules);
  record('TERM', 'lift every terminal in a length-≥2 body to its own nonterminal T_a → a', s.start, rules);

  rules = stepBin(s.start, rules);
  record('BIN', 'break every body of length ≥ 3 into a chain of binary rules', s.start, rules);

  const del = stepDel(s.start, rules);
  rules = del.rules;
  record('DEL', 'delete ε-productions by expanding every subset of nullable symbols', s.start, rules);

  rules = stepUnit(rules);
  record('UNIT', 'remove unit productions A → B by copying B’s bodies onto A', s.start, rules);

  // add back S₀ → ε iff ε is in the language
  if (del.epsilon) rules = [...rules, { lhs: s.start, rhs: [] }];

  // final trim: drop any symbols made useless by the transforms, but keep S₀→ε
  const finalRules = dedupeRules(rules);
  const grammar = makeGrammar(s.start, finalRules);
  record('CNF', del.epsilon ? 'add S₀ → ε (the empty string is in the language)' : 'final Chomsky normal form', grammar.start, grammar.rules);

  return { grammar, epsilon: del.epsilon, trace };
}

/** Is every rule of `g` in Chomsky normal form? (Used by the verifier as a shape check.) */
export function isChomskyNormalForm(g: Grammar): boolean {
  for (const r of g.rules) {
    if (r.rhs.length === 0) {
      if (r.lhs !== g.start) return false; // only S₀ → ε allowed
      continue;
    }
    if (r.rhs.length === 1) {
      if (r.rhs[0].kind !== 'T') return false;
      continue;
    }
    if (r.rhs.length === 2) {
      if (r.rhs[0].kind !== 'N' || r.rhs[1].kind !== 'N') return false;
      continue;
    }
    return false;
  }
  return true;
}

/** Key helper the verifier uses to compare rule sets structurally. */
export { seqKey };
