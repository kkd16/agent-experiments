// The reverse direction: turn a DFA back into a regular expression by
// state elimination (the GNFA / Kleene construction). We add a fresh start and
// accept state, then "rip out" every original state one at a time, rerouting
// each path i → q → j through the removed state q with the rule
//
//     R(i,j)  ⟵  R(i,j)  |  R(i,q) · R(q,q)* · R(q,j)
//
// When only the new start and accept remain, the single edge between them is a
// regex for the whole language. A small algebraic simplifier keeps the output
// readable (∅/ε absorption, idempotent union, star collapsing). Each literal
// carries its real CharSet, so we can also emit an AST and re-verify that the
// reconstructed expression is equivalent to the DFA we started from.

import type { RegexNode } from './ast';
import { CharSet } from './charset';
import type { DFA } from './dfa';

type Rex =
  | { k: 'empty' } // ∅ — matches nothing
  | { k: 'eps' } // ε — the empty string
  | { k: 'lit'; set: CharSet; label: string } // a character-class leaf
  | { k: 'concat'; a: Rex; b: Rex }
  | { k: 'union'; a: Rex; b: Rex }
  | { k: 'star'; a: Rex };

const EMPTY: Rex = { k: 'empty' };
const EPS: Rex = { k: 'eps' };

// Structural key for the idempotence checks.
function key(r: Rex): string {
  switch (r.k) {
    case 'empty':
      return '∅';
    case 'eps':
      return 'ε';
    case 'lit':
      return `«${r.set.key()}»`;
    case 'concat':
      return `(${key(r.a)}·${key(r.b)})`;
    case 'union':
      return `(${key(r.a)}|${key(r.b)})`;
    case 'star':
      return `(${key(r.a)})*`;
  }
}

function concat(a: Rex, b: Rex): Rex {
  if (a.k === 'empty' || b.k === 'empty') return EMPTY;
  if (a.k === 'eps') return b;
  if (b.k === 'eps') return a;
  return { k: 'concat', a, b };
}

function union(a: Rex, b: Rex): Rex {
  if (a.k === 'empty') return b;
  if (b.k === 'empty') return a;
  if (key(a) === key(b)) return a;
  return { k: 'union', a, b };
}

function star(a: Rex): Rex {
  if (a.k === 'empty' || a.k === 'eps') return EPS;
  if (a.k === 'star') return a;
  return { k: 'star', a };
}

const ATOM = 4;
const STAR = 3;
const CONCAT = 2;
const UNION = 1;

function levelOf(r: Rex): number {
  switch (r.k) {
    case 'empty':
    case 'eps':
    case 'lit':
      return ATOM;
    case 'star':
      return STAR;
    case 'concat':
      return CONCAT;
    case 'union':
      return UNION;
  }
}

function render(r: Rex): string {
  const child = (c: Rex, min: number): string => {
    const s = render(c);
    return levelOf(c) < min ? `(${s})` : s;
  };
  switch (r.k) {
    case 'empty':
      return '∅';
    case 'eps':
      return 'ε';
    case 'lit':
      return r.set.equals(CharSet.fromRange(0, 0x10ffff)) ? '[\\s\\S]' : r.label;
    case 'star':
      return `${child(r.a, STAR)}*`;
    case 'concat':
      return `${child(r.a, CONCAT)}${child(r.b, CONCAT)}`;
    case 'union':
      return `${child(r.a, UNION)}|${child(r.b, UNION)}`;
  }
}

// Lower the algebra back into the engine's AST (so it can be re-compiled and
// checked for equivalence). ∅ becomes a char on the empty set, which matches
// nothing — exactly ∅'s meaning.
function toAst(r: Rex): RegexNode {
  switch (r.k) {
    case 'empty':
      return { type: 'char', set: CharSet.empty(), raw: '∅' };
    case 'eps':
      return { type: 'empty' };
    case 'lit':
      return { type: 'char', set: r.set, raw: r.label };
    case 'concat':
      return { type: 'concat', parts: [toAst(r.a), toAst(r.b)] };
    case 'union':
      return { type: 'alt', options: [toAst(r.a), toAst(r.b)] };
    case 'star':
      return { type: 'star', node: toAst(r.a), lazy: false };
  }
}

export interface SynthResult {
  regex: string; // the reconstructed pattern (display form)
  ast: RegexNode; // the same expression as an AST, for re-verification
  empty: boolean; // language is ∅ (no accepting path)
  epsilonOnly: boolean; // language is exactly {""}
}

export function dfaToRegex(dfa: DFA): SynthResult {
  const n = dfa.states.length;
  const S = n; // new start
  const F = n + 1; // new accept
  const total = n + 2;

  // Edge labels between every pair, default ∅.
  const edge: Rex[][] = Array.from({ length: total }, () => new Array<Rex>(total).fill(EMPTY));

  // Original DFA transitions (already merged per (from,to)) become literals.
  for (const t of dfa.transitions) {
    edge[t.from][t.to] = union(edge[t.from][t.to], { k: 'lit', set: t.set, label: t.set.label() });
  }
  // Wire the fresh start/accept with ε.
  edge[S][dfa.start] = EPS;
  for (const st of dfa.states) if (st.accept) edge[st.id][F] = union(edge[st.id][F], EPS);

  // Rip out each original state.
  for (let q = 0; q < n; q++) {
    const loop = star(edge[q][q]);
    for (let i = 0; i < total; i++) {
      if (i === q) continue;
      if (edge[i][q].k === 'empty') continue;
      for (let j = 0; j < total; j++) {
        if (j === q) continue;
        if (edge[q][j].k === 'empty') continue;
        const detour = concat(edge[i][q], concat(loop, edge[q][j]));
        edge[i][j] = union(edge[i][j], detour);
      }
    }
    // Disconnect q.
    for (let i = 0; i < total; i++) {
      edge[i][q] = EMPTY;
      edge[q][i] = EMPTY;
    }
  }

  const result = edge[S][F];
  return {
    regex: render(result),
    ast: toAst(result),
    empty: result.k === 'empty',
    epsilonOnly: result.k === 'eps',
  };
}
