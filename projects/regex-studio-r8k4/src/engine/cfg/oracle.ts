// The ground truth — an *exact*, always-terminating span dynamic program,
// independent of CYK (which needs CNF), Earley (a chart parser) and the PDA (a
// stack machine). `derivable[i][len]` is the set of nonterminals deriving
// `w[i..i+len)`, filled bottom-up over increasing lengths with a same-span
// fixpoint so unit- and ε-cycles converge (monotone, bounded by |N|). This is
// robust where a naive leftmost search is not: left recursion, ε- and unit-
// cycles all terminate. Enumeration and the ambiguity witness sit on top.

import type { Grammar, Rule, Sym } from './grammar';
import { minYield, nullableSet, seqMinYield } from './analysis';
import type { ParseTree } from './tree';
import { leaf, node, treeSignature, treeYield } from './tree';

function rulesByLhs(g: Grammar): Map<string, Rule[]> {
  const m = new Map<string, Rule[]>();
  for (const r of g.rules) {
    const l = m.get(r.lhs);
    if (l) l.push(r);
    else m.set(r.lhs, [r]);
  }
  return m;
}

/**
 * Exact membership `w ∈ L(g)` by the span DP. `der[i][len]` (len 0..n) holds the
 * nonterminals deriving the substring starting at `i` of length `len`; len 0 is
 * exactly the nullable set. Each cell is closed under the productions to a
 * fixpoint, so a rule whose body spans the whole cell (with the rest deriving ε)
 * — the unit/ε-cyclic case — is handled without ever looping forever.
 */
export function derives(g: Grammar, w: string): boolean {
  const chars = [...w];
  const n = chars.length;
  const nullable = nullableSet(g);

  // der[i] is an array indexed by len (0..n-i); der[i][len] = Set<string>
  const der: Set<string>[][] = [];
  for (let i = 0; i <= n; i++) {
    der.push(Array.from({ length: n - i + 1 }, () => new Set<string>()));
    der[i][0] = new Set(nullable); // the empty span is derived by exactly the nullable nonterminals
  }

  // Can `seq` derive chars[i..i+len)? DP over (position in seq, chars consumed),
  // consulting `der` for sub-spans (a same-span reference is allowed: it reads
  // the cell currently being built, which is why the caller iterates to fixpoint).
  const matchSeq = (seq: Sym[], i: number, len: number): boolean => {
    // reachable[p] = can seq[0..t) consume exactly p chars — build forward
    let front = new Set<number>([0]);
    for (const X of seq) {
      const next = new Set<number>();
      for (const p of front) {
        if (X.kind === 'T') {
          if (p < len && chars[i + p] === X.name) next.add(p + 1);
        } else {
          for (let q = p; q <= len; q++) {
            if (der[i + p][q - p].has(X.name)) next.add(q);
          }
        }
      }
      front = next;
      if (front.size === 0) break;
    }
    return front.has(len);
  };

  for (let len = 1; len <= n; len++) {
    for (let i = 0; i + len <= n; i++) {
      const cell = der[i][len];
      let changed = true;
      while (changed) {
        changed = false;
        for (const r of g.rules) {
          if (cell.has(r.lhs)) continue;
          if (matchSeq(r.rhs, i, len)) {
            cell.add(r.lhs);
            changed = true;
          }
        }
      }
    }
  }

  if (n === 0) return nullable.has(g.start);
  return der[0][n].has(g.start);
}

/**
 * All terminal words of length ≤ maxLen in the language, deduped, sorted by
 * (length, lexicographic), up to `limit`. A leftmost sentential-form search with
 * min-yield pruning, plus a hard form-length cap and node budget so left-
 * recursive / nullable-padding grammars stay bounded (`truncated` flags a cap).
 */
export function enumerateWords(g: Grammar, maxLen: number, limit: number): { words: string[]; truncated: boolean } {
  const best = minYield(g);
  const byLhs = rulesByLhs(g);
  const found = new Set<string>();
  const seen = new Set<string>();
  const key = (form: Sym[]) => form.map((s) => (s.kind === 'N' ? 'N' : 'T') + s.name).join(',');
  const startForm: Sym[] = [{ kind: 'N', name: g.start }];
  if (seqMinYield(startForm, best) > maxLen) return { words: [], truncated: false };
  const lenCap = maxLen + 10; // nullable padding beyond this is never needed for words ≤ maxLen
  const queue: Sym[][] = [startForm];
  seen.add(key(startForm));
  let expanded = 0;
  let truncated = false;

  while (queue.length) {
    const form = queue.shift() as Sym[];
    // leftmost nonterminal
    let idx = -1;
    for (let i = 0; i < form.length; i++) if (form[i].kind === 'N') {
      idx = i;
      break;
    }
    if (idx === -1) {
      // fully terminal
      const word = form.map((s) => s.name).join('');
      if (word.length <= maxLen) found.add(word);
      continue;
    }
    if (++expanded > 60000) {
      truncated = true;
      break;
    }
    const A = form[idx].name;
    const pre = form.slice(0, idx);
    const post = form.slice(idx + 1);
    for (const r of byLhs.get(A) ?? []) {
      const next = [...pre, ...r.rhs, ...post];
      if (next.length > lenCap) {
        truncated = true;
        continue;
      }
      if (seqMinYield(next, best) > maxLen) continue;
      const k = key(next);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push(next);
    }
    if (found.size > limit * 8) {
      truncated = true;
      break;
    }
  }

  const words = [...found].sort((a, b) => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0));
  if (words.length > limit) return { words: words.slice(0, limit), truncated: true };
  return { words, truncated };
}

/** The shortest word in the language (lexicographically least among shortest), or null if empty. */
export function shortestWord(g: Grammar, maxLen: number): string | null {
  const e = enumerateWords(g, maxLen, 1);
  return e.words.length ? e.words[0] : null;
}

// ---- ambiguity: a sound, memoised two-tree search over the original grammar ----

/**
 * Up to two *distinct* parse trees of `w` from the start symbol, over the
 * original grammar. `trees(A,i,j)` is memoised on the span (so the search is
 * polynomial, not exponential) and keeps at most two trees per span — enough to
 * witness ambiguity of any parent — with an in-progress guard that breaks same-
 * span unit/ε cycles. Sound: any two trees it returns are genuine derivations;
 * incomplete only on those cyclic same-span cases.
 */
export function rootTrees(g: Grammar, w: string): ParseTree[] {
  const byLhs = rulesByLhs(g);
  const memo = new Map<string, ParseTree[]>();
  const inProgress = new Set<string>();
  const CAP = 2; // trees kept per span
  const WIDTH = 12; // combos frontier width

  const trees = (A: string, i: number, j: number): ParseTree[] => {
    const key = `${A}|${i}|${j}`;
    const cached = memo.get(key);
    if (cached) return cached;
    if (inProgress.has(key)) return []; // same-span cycle — cut (keeps it sound)
    inProgress.add(key);

    const out: ParseTree[] = [];
    const sigs = new Set<string>();
    const push = (t: ParseTree) => {
      const s = treeSignature(t);
      if (!sigs.has(s)) {
        sigs.add(s);
        out.push(t);
      }
    };
    for (const r of byLhs.get(A) ?? []) {
      if (out.length >= CAP) break;
      for (const kids of combos(r.rhs, i, j)) {
        push(node(A, kids));
        if (out.length >= CAP) break;
      }
    }

    inProgress.delete(key);
    memo.set(key, out);
    return out;
  };

  // child-lists spelling seq across w[i..j); a small forward DP over the rhs,
  // frontier-capped so it stays bounded on wide/ambiguous grammars.
  const combos = (seq: Sym[], i: number, j: number): ParseTree[][] => {
    let states: { p: number; kids: ParseTree[] }[] = [{ p: i, kids: [] }];
    for (const X of seq) {
      const next: { p: number; kids: ParseTree[] }[] = [];
      for (const st of states) {
        if (X.kind === 'T') {
          if (st.p < j && w[st.p] === X.name) next.push({ p: st.p + 1, kids: [...st.kids, leaf(X.name)] });
        } else {
          for (let q = st.p; q <= j; q++) {
            for (const t of trees(X.name, st.p, q)) {
              next.push({ p: q, kids: [...st.kids, t] });
              if (next.length >= WIDTH) break;
            }
            if (next.length >= WIDTH) break;
          }
        }
        if (next.length >= WIDTH) break;
      }
      states = next.slice(0, WIDTH);
      if (states.length === 0) break;
    }
    return states.filter((s) => s.p === j).map((s) => s.kids);
  };

  return trees(g.start, 0, w.length).filter((t) => treeYield(t) === w);
}

export interface AmbiguityWitness {
  word: string;
  tree1: ParseTree;
  tree2: ParseTree;
}

/** Search for an ambiguity witness among language words up to `maxLen`. */
export function findAmbiguity(g: Grammar, maxLen: number): { checked: number; witness: AmbiguityWitness | null; bounded: boolean } {
  const words = enumerateWords(g, maxLen, 400);
  let checked = 0;
  for (const w of words.words) {
    checked++;
    const valid = rootTrees(g, w);
    if (valid.length >= 2) return { checked, witness: { word: w, tree1: valid[0], tree2: valid[1] }, bounded: words.truncated };
  }
  return { checked, witness: null, bounded: words.truncated };
}
