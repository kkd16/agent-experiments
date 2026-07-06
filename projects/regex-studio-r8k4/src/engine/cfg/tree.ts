// Parse trees — the shared artifact produced by CYK (over the CNF grammar) and
// by Earley (over the original grammar), and enumerated by the ambiguity search.

import type { Grammar } from './grammar';

export interface ParseTree {
  label: string; // nonterminal name, or the terminal character
  terminal: boolean; // a terminal leaf?
  children: ParseTree[]; // for a nonterminal node; [] means it derived ε
}

export function leaf(a: string): ParseTree {
  return { label: a, terminal: true, children: [] };
}
export function node(label: string, children: ParseTree[]): ParseTree {
  return { label, terminal: false, children };
}

/** The terminal frontier (yield) of a tree, left to right. */
export function treeYield(t: ParseTree): string {
  if (t.terminal) return t.label;
  let out = '';
  for (const c of t.children) out += treeYield(c);
  return out;
}

/** A canonical string signature, so two derivations of one word can be compared. */
export function treeSignature(t: ParseTree): string {
  if (t.terminal) return t.label;
  return `${t.label}(${t.children.map(treeSignature).join('')})`;
}

/**
 * Validate that a tree is a genuine derivation in `g`: every internal node's
 * children spell one of its productions, and every leaf is a terminal of `g`.
 * The Earley reconstruction runs this before displaying a tree, so a
 * reconstruction bug can never surface a wrong tree.
 */
export function validateTree(g: Grammar, t: ParseTree): boolean {
  const prodKeys = new Set<string>();
  for (const r of g.rules) {
    prodKeys.add(`${r.lhs}=>${r.rhs.map((s) => (s.kind === 'N' ? 'N:' : 'T:') + s.name).join(',')}`);
  }
  const check = (x: ParseTree): boolean => {
    if (x.terminal) return true;
    const key = `${x.label}=>${x.children.map((c) => (c.terminal ? 'T:' : 'N:') + c.label).join(',')}`;
    if (!prodKeys.has(key)) return false;
    return x.children.every(check);
  };
  return check(t);
}
