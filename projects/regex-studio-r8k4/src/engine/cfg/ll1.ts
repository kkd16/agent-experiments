// LL(1) predictive parsing — the top-down, table-driven parser and the FIRST /
// FOLLOW theory behind it. Where CYK and Earley recognise *any* grammar, an
// LL(1) parser commits to one production per (nonterminal, lookahead) with no
// backtracking — and can only do so when the grammar has no conflicts. Building
// the table exposes exactly why: left recursion and common prefixes (and, more
// deeply, ambiguity) collide two productions into one cell.

import type { Grammar, Rule, Sym } from './grammar';
import { nullableSet } from './analysis';

export const END = '$'; // the end-of-input marker (our terminals are single non-$ chars)

export interface FirstResult {
  set: Set<string>;
  nullable: boolean;
}

/** FIRST(A) for every nonterminal — the terminals that can begin a string derived from A. */
export function firstSets(g: Grammar, nullable: Set<string>): Map<string, Set<string>> {
  const first = new Map<string, Set<string>>();
  for (const A of g.nonterminals) first.set(A, new Set());
  const firstOf = (s: Sym): Set<string> => (s.kind === 'T' ? new Set([s.name]) : first.get(s.name) ?? new Set());
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of g.rules) {
      const target = first.get(r.lhs);
      if (!target) continue;
      // add FIRST of each symbol until a non-nullable one
      for (const s of r.rhs) {
        const before = target.size;
        for (const a of firstOf(s)) target.add(a);
        if (target.size !== before) changed = true;
        if (s.kind === 'T' || !nullable.has(s.name)) break;
      }
    }
  }
  return first;
}

/** FIRST of a symbol sequence, plus whether the whole sequence is nullable. */
export function firstOfSeq(seq: Sym[], first: Map<string, Set<string>>, nullable: Set<string>): FirstResult {
  const set = new Set<string>();
  for (const s of seq) {
    if (s.kind === 'T') {
      set.add(s.name);
      return { set, nullable: false };
    }
    for (const a of first.get(s.name) ?? []) set.add(a);
    if (!nullable.has(s.name)) return { set, nullable: false };
  }
  return { set, nullable: true };
}

/** FOLLOW(A) — the terminals (and END) that can appear immediately after A in a derivation from the start. */
export function followSets(
  g: Grammar,
  first: Map<string, Set<string>>,
  nullable: Set<string>,
): Map<string, Set<string>> {
  const follow = new Map<string, Set<string>>();
  for (const A of g.nonterminals) follow.set(A, new Set());
  follow.get(g.start)?.add(END);
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of g.rules) {
      for (let i = 0; i < r.rhs.length; i++) {
        const B = r.rhs[i];
        if (B.kind !== 'N') continue;
        const target = follow.get(B.name);
        if (!target) continue;
        const before = target.size;
        const rest = firstOfSeq(r.rhs.slice(i + 1), first, nullable);
        for (const a of rest.set) target.add(a);
        if (rest.nullable) for (const a of follow.get(r.lhs) ?? []) target.add(a);
        if (target.size !== before) changed = true;
      }
    }
  }
  return follow;
}

export interface Ll1Cell {
  terminal: string;
  rules: number[]; // rule indices; length > 1 ⇒ a conflict
}

export interface Ll1Analysis {
  nullable: Set<string>;
  first: Map<string, Set<string>>;
  follow: Map<string, Set<string>>;
  // table[A] : terminal/END → rule indices
  table: Map<string, Map<string, number[]>>;
  terminals: string[]; // Σ ∪ {END}, for table columns
  isLL1: boolean;
  conflicts: { A: string; terminal: string; rules: number[] }[];
  leftRecursive: boolean;
}

/** Left-recursive iff some nonterminal can appear as its own leftmost derived symbol. */
function isLeftRecursive(g: Grammar, nullable: Set<string>): boolean {
  // edge A → B if B is a leftmost-reachable symbol of an A-rule (skipping nullable prefixes)
  const succ = new Map<string, Set<string>>();
  for (const A of g.nonterminals) succ.set(A, new Set());
  for (const r of g.rules) {
    for (const s of r.rhs) {
      if (s.kind === 'N') succ.get(r.lhs)?.add(s.name);
      if (s.kind === 'T' || !nullable.has(s.name)) break;
    }
  }
  for (const A of g.nonterminals) {
    const seen = new Set<string>();
    const stack = [...(succ.get(A) ?? [])];
    while (stack.length) {
      const x = stack.pop() as string;
      if (x === A) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      for (const y of succ.get(x) ?? []) stack.push(y);
    }
  }
  return false;
}

export function analyzeLL1(g: Grammar): Ll1Analysis {
  const nullable = nullableSet(g);
  const first = firstSets(g, nullable);
  const follow = followSets(g, first, nullable);

  const table = new Map<string, Map<string, number[]>>();
  for (const A of g.nonterminals) table.set(A, new Map());
  const put = (A: string, a: string, idx: number) => {
    const row = table.get(A) as Map<string, number[]>;
    const cell = row.get(a);
    if (cell) cell.push(idx);
    else row.set(a, [idx]);
  };
  g.rules.forEach((r: Rule, idx) => {
    const fs = firstOfSeq(r.rhs, first, nullable);
    for (const a of fs.set) put(r.lhs, a, idx);
    if (fs.nullable) for (const a of follow.get(r.lhs) ?? []) put(r.lhs, a, idx);
  });

  const conflicts: { A: string; terminal: string; rules: number[] }[] = [];
  for (const [A, row] of table) {
    for (const [a, rules] of row) {
      if (rules.length > 1) conflicts.push({ A, terminal: a, rules });
    }
  }
  const terminals = [...g.terminals, END];
  return {
    nullable,
    first,
    follow,
    table,
    terminals,
    isLL1: conflicts.length === 0,
    conflicts,
    leftRecursive: isLeftRecursive(g, nullable),
  };
}

export interface Ll1Step {
  stack: string[]; // top = last element
  pos: number; // input position (0..n); n means END
  action: string;
}

export interface Ll1ParseResult {
  ok: boolean; // true iff the grammar is LL(1) (deterministic parse ran)
  accepted: boolean;
  steps: Ll1Step[];
  error: string | null;
}

/**
 * Table-driven predictive parse. Only meaningful for an LL(1) grammar (a cell
 * with two productions is a nondeterministic choice a predictive parser can't
 * make); on a conflict this reports `ok:false` rather than guessing.
 */
export function parseLL1(g: Grammar, analysis: Ll1Analysis, w: string): Ll1ParseResult {
  if (!analysis.isLL1) return { ok: false, accepted: false, steps: [], error: 'grammar is not LL(1) — the table has a conflict' };
  const input = [...w];
  const n = input.length;
  // stack holds symbol names tagged; we store {kind,name}; top = last
  let stack: Sym[] = [{ kind: 'N', name: g.start }];
  const steps: Ll1Step[] = [];
  const snap = (action: string, pos: number) => {
    steps.push({ stack: stack.map((s) => s.name), pos, action });
  };
  snap('start — push the start symbol', 0);
  let pos = 0;
  let guard = 0;
  const maxSteps = 4000;
  while (stack.length > 0) {
    if (++guard > maxSteps) return { ok: true, accepted: false, steps, error: 'parse exceeded the step limit' };
    const top = stack[stack.length - 1];
    const look = pos < n ? input[pos] : END;
    if (top.kind === 'T') {
      if (top.name === look && pos < n) {
        stack = stack.slice(0, -1);
        pos++;
        snap(`match ‘${top.name}’`, pos);
      } else {
        return { ok: true, accepted: false, steps, error: `expected ‘${top.name}’ but saw ‘${look === END ? 'end of input' : look}’` };
      }
    } else {
      const row = analysis.table.get(top.name);
      const cell = row?.get(look);
      if (!cell || cell.length === 0) {
        return { ok: true, accepted: false, steps, error: `no production for ${top.name} on lookahead ‘${look === END ? 'end of input' : look}’` };
      }
      const rule = g.rules[cell[0]];
      stack = stack.slice(0, -1);
      for (let i = rule.rhs.length - 1; i >= 0; i--) stack.push(rule.rhs[i]);
      snap(`${top.name} → ${rule.rhs.length ? rule.rhs.map((s) => s.name).join(' ') : 'ε'}`, pos);
    }
  }
  const accepted = pos === n;
  snap(accepted ? 'accept — stack empty, input consumed ✓' : 'stack empty but input remains', pos);
  return { ok: true, accepted, steps, error: accepted ? null : 'input not fully consumed' };
}
