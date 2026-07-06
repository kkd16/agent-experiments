// CYK — the O(n³) dynamic-programming recognizer on a Chomsky-normal-form
// grammar. It fills a triangular table `P[i][len]` = the set of nonterminals
// deriving the substring `w[i..i+len)`, bottom-up over increasing lengths, and
// keeps a backpointer per cell so one parse tree can be read back out.

import type { Grammar } from './grammar';
import type { ParseTree } from './tree';
import { leaf, node } from './tree';

type Back = { kind: 'term'; a: string } | { kind: 'bin'; B: string; C: string; split: number };

export interface CykResult {
  accepted: boolean;
  n: number;
  // cells[i][len] (len ≥ 1) = the nonterminals deriving w[i..i+len); flattened
  // as cells[i] indexed by len-1. cells is length n, cells[i] length n-i.
  cells: string[][][];
  tree: ParseTree | null;
  emptyAccepted: boolean; // matched the empty string via S₀ → ε
}

export function cyk(cnf: Grammar, w: string): CykResult {
  const chars = [...w];
  const n = chars.length;

  // index the CNF rules
  const termRules = new Map<string, string[]>(); // terminal → [A : A → a]
  const binRules: { A: string; B: string; C: string }[] = [];
  let hasEpsilon = false;
  for (const r of cnf.rules) {
    if (r.rhs.length === 0) {
      if (r.lhs === cnf.start) hasEpsilon = true;
    } else if (r.rhs.length === 1 && r.rhs[0].kind === 'T') {
      const a = r.rhs[0].name;
      const l = termRules.get(a);
      if (l) l.push(r.lhs);
      else termRules.set(a, [r.lhs]);
    } else if (r.rhs.length === 2 && r.rhs[0].kind === 'N' && r.rhs[1].kind === 'N') {
      binRules.push({ A: r.lhs, B: r.rhs[0].name, C: r.rhs[1].name });
    }
    // any other shape is not CNF — ignored (isChomskyNormalForm guards this)
  }

  if (n === 0) {
    return { accepted: hasEpsilon, n: 0, cells: [], tree: hasEpsilon ? node(cnf.start, []) : null, emptyAccepted: hasEpsilon };
  }

  // sets[i][len-1] = Set<string>, back[i][len-1] = Map<string, Back>
  const sets: Set<string>[][] = [];
  const back: Map<string, Back>[][] = [];
  for (let i = 0; i < n; i++) {
    sets.push(new Array(n - i).fill(null).map(() => new Set<string>()));
    back.push(new Array(n - i).fill(null).map(() => new Map<string, Back>()));
  }

  // length 1
  for (let i = 0; i < n; i++) {
    for (const A of termRules.get(chars[i]) ?? []) {
      if (!sets[i][0].has(A)) {
        sets[i][0].add(A);
        back[i][0].set(A, { kind: 'term', a: chars[i] });
      }
    }
  }
  // length 2..n
  for (let len = 2; len <= n; len++) {
    for (let i = 0; i + len <= n; i++) {
      for (let split = 1; split < len; split++) {
        const left = sets[i][split - 1];
        const right = sets[i + split][len - split - 1];
        if (left.size === 0 || right.size === 0) continue;
        for (const { A, B, C } of binRules) {
          if (left.has(B) && right.has(C) && !sets[i][len - 1].has(A)) {
            sets[i][len - 1].add(A);
            back[i][len - 1].set(A, { kind: 'bin', B, C, split });
          }
        }
      }
    }
  }

  const accepted = sets[0][n - 1].has(cnf.start);

  // read one parse tree back from the backpointers
  const build = (A: string, i: number, len: number): ParseTree => {
    const b = back[i][len - 1].get(A);
    if (!b) return node(A, []); // shouldn't happen when accepted
    if (b.kind === 'term') return node(A, [leaf(b.a)]);
    return node(A, [build(b.B, i, b.split), build(b.C, i + b.split, len - b.split)]);
  };

  const cells: string[][][] = sets.map((row) => row.map((s) => [...s]));
  return {
    accepted,
    n,
    cells,
    tree: accepted ? build(cnf.start, 0, n) : null,
    emptyAccepted: false,
  };
}
