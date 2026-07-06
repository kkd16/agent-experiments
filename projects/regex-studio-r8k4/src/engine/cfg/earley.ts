// Earley — the general chart parser. It works directly on the *raw* grammar,
// no normalization, in O(n³): three operations (predict / scan / complete) over
// n+1 state sets, with the Aycock–Horspool nullable-predictor fix so
// ε-productions are handled without a magic completion. A parse-forest pointer
// walk reconstructs one derivation tree over the original grammar, which is
// validated before anyone displays it.

import type { Grammar, Rule, Sym } from './grammar';
import { nullableSet } from './analysis';
import type { ParseTree } from './tree';
import { leaf, node } from './tree';

interface Item {
  rule: number; // index into the augmented rule list
  dot: number;
  origin: number;
}

type Cause =
  | { kind: 'scan'; predSet: number; char: string }
  | { kind: 'complete'; predSet: number; childRule: number; childEnd: number }
  | { kind: 'nullable'; predSet: number; sym: string };

export interface EarleyResult {
  accepted: boolean;
  n: number;
  // per set: the formatted items (for the chart display)
  chart: string[][];
  itemCount: number;
  tree: ParseTree | null;
}

const AUG = '⟪start⟫';

function itemKey(set: number, it: Item): string {
  return `${set}|${it.rule}|${it.dot}|${it.origin}`;
}

export function earley(g: Grammar, w: string): EarleyResult {
  const input = [...w];
  const n = input.length;
  const rules: Rule[] = [{ lhs: AUG, rhs: [{ kind: 'N', name: g.start }] }, ...g.rules];
  const nullable = nullableSet({ ...g, start: g.start, rules }); // over augmented rules

  const rulesByLhs = new Map<string, number[]>();
  rules.forEach((r, idx) => {
    const l = rulesByLhs.get(r.lhs);
    if (l) l.push(idx);
    else rulesByLhs.set(r.lhs, [idx]);
  });

  const sets: Item[][] = Array.from({ length: n + 1 }, () => []);
  const keys: Set<string>[] = Array.from({ length: n + 1 }, () => new Set<string>());
  const causes = new Map<string, Cause[]>();

  const addItem = (set: number, it: Item, cause: Cause | null) => {
    const k = itemKey(set, it);
    if (!keys[set].has(k)) {
      keys[set].add(k);
      sets[set].push(it);
    }
    if (cause) {
      const list = causes.get(k);
      if (list) {
        // keep distinct causes (for ambiguity awareness); cap to avoid blow-up
        if (list.length < 8) list.push(cause);
      } else causes.set(k, [cause]);
    }
  };

  addItem(0, { rule: 0, dot: 0, origin: 0 }, null);

  for (let s = 0; s <= n; s++) {
    for (let ptr = 0; ptr < sets[s].length; ptr++) {
      const it = sets[s][ptr];
      const r = rules[it.rule];
      if (it.dot < r.rhs.length) {
        const X: Sym = r.rhs[it.dot];
        if (X.kind === 'N') {
          // PREDICT
          for (const idx of rulesByLhs.get(X.name) ?? []) {
            addItem(s, { rule: idx, dot: 0, origin: s }, null);
          }
          // nullable shortcut: advance over a nullable nonterminal in place
          if (nullable.has(X.name)) {
            addItem(s, { rule: it.rule, dot: it.dot + 1, origin: it.origin }, { kind: 'nullable', predSet: s, sym: X.name });
          }
        } else {
          // SCAN
          if (s < n && input[s] === X.name) {
            addItem(s + 1, { rule: it.rule, dot: it.dot + 1, origin: it.origin }, { kind: 'scan', predSet: s, char: X.name });
          }
        }
      } else {
        // COMPLETE — item is A → γ· spanning [origin, s)
        const A = r.lhs;
        for (const pit of sets[it.origin]) {
          const pr = rules[pit.rule];
          if (pit.dot < pr.rhs.length) {
            const Y = pr.rhs[pit.dot];
            if (Y.kind === 'N' && Y.name === A) {
              addItem(s, { rule: pit.rule, dot: pit.dot + 1, origin: pit.origin }, { kind: 'complete', predSet: it.origin, childRule: it.rule, childEnd: s });
            }
          }
        }
      }
    }
  }

  const accepted = keys[n].has(itemKey(n, { rule: 0, dot: 1, origin: 0 }));
  const itemCount = sets.reduce((a, s) => a + s.length, 0);

  // ---- reconstruct one tree (display-only; validated by the caller) ----
  // A global node budget guards against the exponential ε-forests a cyclic
  // nullable grammar (e.g. S → S A S | ε) would otherwise spin up.
  const budget = { n: 20000 };
  const overflow = () => budget.n <= 0;

  // The *smallest* ε-derivation tree for a nullable nonterminal: prefer a direct
  // `X → ε`, else a body of nullables, never revisiting a nonterminal on the way
  // down (so unit/ε cycles terminate).
  const buildEmpty = (name: string, visiting: Set<string>): ParseTree => {
    budget.n--;
    if (overflow()) return node(name, []);
    const opts = rulesByLhs.get(name) ?? [];
    // direct ε rule first
    for (const idx of opts) if (rules[idx].rhs.length === 0) return node(name, []);
    if (visiting.has(name)) return node(name, []); // cycle — approximate with a leaf-ε
    visiting.add(name);
    for (const idx of opts) {
      const rr = rules[idx];
      if (rr.rhs.length > 0 && rr.rhs.every((s) => s.kind === 'N' && nullable.has(s.name) && !visiting.has(s.name))) {
        const t = node(name, rr.rhs.map((s) => buildEmpty(s.name, visiting)));
        visiting.delete(name);
        return t;
      }
    }
    visiting.delete(name);
    return node(name, []);
  };

  // children of the item (rule, dot, origin) that ENDS in set `endSet`
  const buildChildren = (rule: number, dot: number, origin: number, endSet: number): ParseTree[] => {
    if (dot === 0 || overflow()) return [];
    budget.n--;
    const list = causes.get(itemKey(endSet, { rule, dot, origin }));
    if (!list || list.length === 0) return [];
    const c = list[0];
    const pre = buildChildren(rule, dot - 1, origin, c.predSet);
    let last: ParseTree;
    if (c.kind === 'scan') {
      last = leaf(c.char);
    } else if (c.kind === 'nullable') {
      last = buildEmpty(c.sym, new Set());
    } else {
      const cr = rules[c.childRule];
      last = node(cr.lhs, buildChildren(c.childRule, cr.rhs.length, c.predSet, c.childEnd));
    }
    return [...pre, last];
  };

  let tree: ParseTree | null = null;
  if (accepted) {
    // the augmented rule ⊤ → S ; its single child S spans [0, n)
    const kids = buildChildren(0, 1, 0, n);
    tree = !overflow() && kids.length === 1 ? kids[0] : null;
  }

  // ---- chart display ----
  const fmt = (it: Item): string => {
    const r = rules[it.rule];
    const parts = r.rhs.map((s) => s.name);
    parts.splice(it.dot, 0, '•');
    const body = parts.length ? parts.join(' ') : '•';
    return `${r.lhs} → ${body} (${it.origin})`;
  };
  const chart = sets.map((s) => s.map(fmt));

  return { accepted, n, chart, itemCount, tree };
}
