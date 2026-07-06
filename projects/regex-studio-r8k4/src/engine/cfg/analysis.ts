// The structural analysis of a grammar — the fixpoints that decide which
// symbols matter, whether the language is empty or finite, and the per-symbol
// minimum terminal yield that drives shortest-word and all the search pruning.

import type { Grammar, Rule } from './grammar';
import { makeGrammar } from './grammar';

/** Nonterminals that can derive the empty string (`A ⇒* ε`). Least fixpoint. */
export function nullableSet(g: Grammar): Set<string> {
  const nullable = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of g.rules) {
      if (nullable.has(r.lhs)) continue;
      // A → γ makes A nullable iff every symbol of γ is a nullable nonterminal
      if (r.rhs.every((s) => s.kind === 'N' && nullable.has(s.name))) {
        nullable.add(r.lhs);
        changed = true;
      }
    }
  }
  return nullable;
}

/** Nonterminals that derive *some* terminal string (`A ⇒* w ∈ Σ*`). Least fixpoint. */
export function generatingSet(g: Grammar): Set<string> {
  const generating = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of g.rules) {
      if (generating.has(r.lhs)) continue;
      if (r.rhs.every((s) => s.kind === 'T' || generating.has(s.name))) {
        generating.add(r.lhs);
        changed = true;
      }
    }
  }
  return generating;
}

/** Nonterminals reachable from the start symbol through the productions. */
export function reachableSet(g: Grammar): Set<string> {
  const reachable = new Set<string>([g.start]);
  const byLhs = new Map<string, Rule[]>();
  for (const r of g.rules) {
    const list = byLhs.get(r.lhs);
    if (list) list.push(r);
    else byLhs.set(r.lhs, [r]);
  }
  const stack = [g.start];
  while (stack.length) {
    const A = stack.pop() as string;
    for (const r of byLhs.get(A) ?? []) {
      for (const s of r.rhs) {
        if (s.kind === 'N' && !reachable.has(s.name)) {
          reachable.add(s.name);
          stack.push(s.name);
        }
      }
    }
  }
  return reachable;
}

/**
 * Remove useless symbols, language-preservingly: first drop every nonterminal
 * that can't generate a terminal string (and any rule mentioning one), then drop
 * every nonterminal unreachable from the start. Order matters — generating
 * before reachable. If the start itself is non-generating the language is empty
 * and we return a single-nonterminal grammar with no rules.
 */
export function removeUseless(g: Grammar): Grammar {
  const generating = generatingSet(g);
  if (!generating.has(g.start)) {
    return { start: g.start, nonterminals: [g.start], terminals: [], rules: [] };
  }
  // keep only generating nonterminals and rules whose every nonterminal is generating
  const genRules = g.rules.filter((r) => generating.has(r.lhs) && r.rhs.every((s) => s.kind === 'T' || generating.has(s.name)));
  const g1 = makeGrammar(g.start, genRules);

  const reachable = reachableSet(g1);
  const reachRules = g1.rules.filter((r) => reachable.has(r.lhs) && r.rhs.every((s) => s.kind === 'T' || reachable.has(s.name)));
  return makeGrammar(g.start, reachRules);
}

/** The language is empty iff the start symbol cannot generate any terminal string. */
export function isEmptyLanguage(g: Grammar): boolean {
  return !generatingSet(g).has(g.start);
}

/**
 * The minimum length of a terminal string derivable from each symbol
 * (∞ = never). A Bellman-Ford-style relaxation over `min` and `sum`, which
 * converges because lengths only decrease and are bounded below by 0.
 */
export function minYield(g: Grammar): Map<string, number> {
  const best = new Map<string, number>();
  for (const A of g.nonterminals) best.set(A, Infinity);
  const symMin = (name: string, kind: 'T' | 'N'): number => (kind === 'T' ? 1 : (best.get(name) ?? Infinity));
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of g.rules) {
      let sum = 0;
      for (const s of r.rhs) {
        sum += symMin(s.name, s.kind);
        if (sum === Infinity) break;
      }
      if (sum < (best.get(r.lhs) ?? Infinity)) {
        best.set(r.lhs, sum);
        changed = true;
      }
    }
  }
  return best;
}

/** Minimum terminal yield of a whole right-hand side under a `minYield` map. */
export function seqMinYield(rhs: Grammar['rules'][number]['rhs'], best: Map<string, number>): number {
  let sum = 0;
  for (const s of rhs) {
    sum += s.kind === 'T' ? 1 : best.get(s.name) ?? Infinity;
    if (sum === Infinity) return Infinity;
  }
  return sum;
}

export interface FinitenessResult {
  empty: boolean;
  finite: boolean;
  // a self-embedding nonterminal witnessing infiniteness (A ⇒⁺ αAβ, useful), if any
  recursiveWitness: string | null;
}

/**
 * Emptiness + finiteness. On the trimmed grammar (no useless symbols), the
 * language is infinite iff some useful nonterminal is *recursive* — it can reach
 * itself through the "derives" graph (A → …B…, and B ⇒* A). A trimmed grammar's
 * every nonterminal both generates a word and is reachable, so any such cycle
 * genuinely pumps arbitrarily long words. (Care: a nonterminal that only reaches
 * itself via a single unit step still pumps once ε-productions have been kept,
 * because it is on a reachable, generating cycle.)
 */
export function analyzeFiniteness(g: Grammar): FinitenessResult {
  if (isEmptyLanguage(g)) return { empty: true, finite: true, recursiveWitness: null };
  const trimmed = removeUseless(g);
  // build the "occurs in a body" graph over useful nonterminals: edge A→B if B
  // appears on the rhs of some A-rule.
  const succ = new Map<string, Set<string>>();
  for (const A of trimmed.nonterminals) succ.set(A, new Set());
  for (const r of trimmed.rules) {
    const s = succ.get(r.lhs);
    if (!s) continue;
    for (const sym of r.rhs) if (sym.kind === 'N') s.add(sym.name);
  }
  // A is recursive iff A can reach A in this graph.
  for (const A of trimmed.nonterminals) {
    const seen = new Set<string>();
    const stack = [...(succ.get(A) ?? [])];
    let found = false;
    while (stack.length) {
      const x = stack.pop() as string;
      if (x === A) {
        found = true;
        break;
      }
      if (seen.has(x)) continue;
      seen.add(x);
      for (const y of succ.get(x) ?? []) stack.push(y);
    }
    if (found) return { empty: false, finite: false, recursiveWitness: A };
  }
  return { empty: false, finite: true, recursiveWitness: null };
}
