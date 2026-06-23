// Inclusion & universality by antichains (De Wulf–Doyen–Henzinger–Raskin,
// CAV 2006). The classic way to decide `L(A) ⊆ L(B)` is to determinise and
// complement B, then test emptiness of `L(A) ∩ co-L(B)` — paying for the full
// subset construction on B. The antichain method searches the *same* product
// lazily and keeps only its ⊑-minimal frontier, so it usually touches a tiny
// fraction of the subsets.
//
// We look for a counterexample — a word in `L(A) \ L(B)`. A search state is a
// **macrostate** `(q, S)`: a single existential A-state `q` (the run we are
// guessing in the nondeterministic A) paired with the determinised B-subset
// `S` of every B-state reachable on the same prefix. A macrostate is "bad" when
// `q` is A-accepting while `S` holds no B-accepting state — that prefix is a
// witness. The ordering `(q, S) ⊑ (q, S')  ⇔  S ⊆ S'` makes the smaller B-subset
// *more dangerous* (it accepts fewer continuations), so we keep only minimal
// S per q: anything bad-reachable from a pruned `(q, S')` is bad-reachable from
// the retained `(q, S ⊆ S')`. Sound, and dramatically smaller than the full
// product.
//
// Equivalence falls out as inclusion both ways; universality `L(N) = Σ*`
// (over N's own alphabet) is inclusion of a one-state all-accepting automaton.

import type { NFA } from './nfa';
import { buildCombined, move, makeWitness, type Combined, type Witness } from './coalgebra';
import { CharSet } from './charset';

export interface InclusionResult {
  included: boolean;
  witness: Witness | null; // a word in L(A) \ L(B) when not included
  antichainSize: number; // peak size of the retained minimal frontier
  explored: number; // macrostates expanded
  naiveExplored: number | null; // macrostates a no-pruning search would expand (null if it blew the budget)
  budgetHit: boolean;
}

interface Macro {
  q: number; // single A-state (combined id, in A-range)
  s: Set<number>; // B-subset (combined ids, in B-range)
}

function keyOfSet(s: Set<number>): string {
  return [...s].sort((a, b) => a - b).join(',');
}
function subset(a: Set<number>, b: Set<number>): boolean {
  if (a.size > b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

const DEFAULT_BUDGET = 30000;

// Decide L(A) ⊆ L(B) on a pre-built combined automaton.
function decideInclusionOn(c: Combined, budget: number): InclusionResult {
  // A's existential states are the combined ids < offsetB; B's subset lives in
  // [offsetB, stateCount). `move` ε-closes and respects the disjoint union, so
  // a singleton {q} steps within A and the subset steps within B.
  const acceptA = c.acceptA;
  const acceptB = c.acceptB;

  // Antichain frontier: per A-state q, the list of retained minimal B-subsets.
  const frontier = new Map<number, Set<number>[]>();
  let antichainSize = 0;

  // A macrostate is subsumed (skip) if some retained (q, S') has S' ⊆ S.
  const subsumed = (q: number, s: Set<number>): boolean => {
    const list = frontier.get(q);
    if (!list) return false;
    for (const sp of list) if (subset(sp, s)) return true;
    return false;
  };
  // Insert (q, S), dropping any retained S'' ⊇ S (S is now the more dangerous).
  const insert = (q: number, s: Set<number>) => {
    const list = frontier.get(q) ?? [];
    const kept = list.filter((sp) => !subset(s, sp));
    kept.push(s);
    frontier.set(q, kept);
    let total = 0;
    for (const l of frontier.values()) total += l.length;
    if (total > antichainSize) antichainSize = total;
  };

  interface Node {
    m: Macro;
    parentKey: string | null;
    code: number;
  }
  const macroKey = (m: Macro) => m.q + ':' + keyOfSet(m.s);
  const parent = new Map<string, { parentKey: string | null; code: number }>();
  const pathTo = (k: string): number[] => {
    const codes: number[] = [];
    let cur: string | null = k;
    for (;;) {
      const info: { parentKey: string | null; code: number } | undefined = cur ? parent.get(cur) : undefined;
      if (!info || info.parentKey === null) break;
      codes.push(info.code);
      cur = info.parentKey;
    }
    return codes.reverse();
  };

  // Initial macrostates: every A-state in ε-closure(start_A) paired with the
  // ε-closed B-start subset.
  const sB0 = c.startB;
  const queue: Node[] = [];
  for (const q of c.startA) {
    const m: Macro = { q, s: sB0 };
    const k = macroKey(m);
    if (!parent.has(k)) {
      parent.set(k, { parentKey: null, code: -1 });
      queue.push({ m, parentKey: null, code: -1 });
    }
  }

  let explored = 0;
  while (queue.length) {
    if (explored > budget) {
      return { included: false, witness: null, antichainSize, explored, naiveExplored: null, budgetHit: true };
    }
    const { m } = queue.shift()!;
    const k = macroKey(m);
    if (subsumed(m.q, m.s)) continue;

    // Bad macrostate ⇒ counterexample word found.
    const aAcc = m.q === acceptA;
    const bAcc = m.s.has(acceptB);
    if (aAcc && !bAcc) {
      return { included: false, witness: makeWitness(pathTo(k)), antichainSize, explored, naiveExplored: null, budgetHit: false };
    }

    insert(m.q, m.s);
    explored++;

    for (let ai = 0; ai < c.atoms.length; ai++) {
      // A steps existentially: branch over each successor A-state.
      const aNext = move(c, new Set([m.q]), ai);
      if (aNext.size === 0) continue; // this A-run dies on this symbol
      const sNext = move(c, m.s, ai);
      for (const q2 of aNext) {
        const m2: Macro = { q: q2, s: sNext };
        if (subsumed(q2, sNext)) continue;
        const k2 = macroKey(m2);
        if (!parent.has(k2)) {
          parent.set(k2, { parentKey: k, code: c.atoms[ai].rep });
          queue.push({ m: m2, parentKey: k, code: c.atoms[ai].rep });
        }
      }
    }
  }

  // For the headline comparison, count how many macrostates a *no-pruning*
  // search would expand on the same product (capped by the budget).
  const naiveExplored = countNaive(c, budget);
  return { included: true, witness: null, antichainSize, explored, naiveExplored, budgetHit: false };
}

// The same forward product without antichain subsumption — every distinct
// (q, S) is its own node. This is what determinise-and-complement pays; we run
// it only to quantify the antichain's win, and cap it at the budget.
function countNaive(c: Combined, budget: number): number | null {
  const sB0 = c.startB;
  const seen = new Set<string>();
  const queue: { q: number; s: Set<number> }[] = [];
  const key = (q: number, s: Set<number>) => q + ':' + keyOfSet(s);
  for (const q of c.startA) {
    const k = key(q, sB0);
    if (!seen.has(k)) {
      seen.add(k);
      queue.push({ q, s: sB0 });
    }
  }
  let n = 0;
  while (queue.length) {
    if (n > budget) return null;
    const { q, s } = queue.shift()!;
    n++;
    const aAcc = q === c.acceptA;
    const bAcc = s.has(c.acceptB);
    if (aAcc && !bAcc) continue; // a bad state; the pruned search stops here too
    for (let ai = 0; ai < c.atoms.length; ai++) {
      const aNext = move(c, new Set([q]), ai);
      if (aNext.size === 0) continue;
      const sNext = move(c, s, ai);
      for (const q2 of aNext) {
        const k = key(q2, sNext);
        if (!seen.has(k)) {
          seen.add(k);
          queue.push({ q: q2, s: sNext });
        }
      }
    }
  }
  return n;
}

export function decideInclusion(a: NFA, b: NFA, budget = DEFAULT_BUDGET): InclusionResult {
  return decideInclusionOn(buildCombined(a, b), budget);
}

// --- The 5-way language relation, the antichain way -------------------------

export type Relation = 'equal' | 'subset' | 'superset' | 'disjoint' | 'overlap';

export interface RelationReport {
  relation: Relation;
  aSubB: InclusionResult; // L(A) ⊆ L(B)
  bSubA: InclusionResult; // L(B) ⊆ L(A)
  inAnotB: Witness | null;
  inBnotA: Witness | null;
  inBoth: Witness | null; // a shared word, when the languages intersect
}

// Nonemptiness of L(A) ∩ L(B): a forward BFS over (S_A, S_B) determinised
// subsets, returning the shortest shared word (or null if disjoint).
function intersectionWitness(c: Combined): Witness | null {
  const key = (sa: Set<number>, sb: Set<number>) => keyOfSet(sa) + '|' + keyOfSet(sb);
  // A-only and B-only subsets, restricted to each side's id range.
  const restrict = (set: Set<number>, lo: number, hi: number) => {
    const out = new Set<number>();
    for (const x of set) if (x >= lo && x < hi) out.add(x);
    return out;
  };
  const sa0 = restrict(c.startA, 0, c.offsetB);
  const sb0 = restrict(c.startB, c.offsetB, c.stateCount);
  const parent = new Map<string, { parentKey: string | null; code: number }>();
  const start = key(sa0, sb0);
  parent.set(start, { parentKey: null, code: -1 });
  const queue: { sa: Set<number>; sb: Set<number> }[] = [{ sa: sa0, sb: sb0 }];
  const pathTo = (k: string): number[] => {
    const codes: number[] = [];
    let cur: string | null = k;
    for (;;) {
      const info: { parentKey: string | null; code: number } | undefined = cur ? parent.get(cur) : undefined;
      if (!info || info.parentKey === null) break;
      codes.push(info.code);
      cur = info.parentKey;
    }
    return codes.reverse();
  };
  while (queue.length) {
    const { sa, sb } = queue.shift()!;
    if (sa.has(c.acceptA) && sb.has(c.acceptB)) return makeWitness(pathTo(key(sa, sb)));
    for (let ai = 0; ai < c.atoms.length; ai++) {
      const na = move(c, sa, ai);
      const nb = move(c, sb, ai);
      const k = key(na, nb);
      if (!parent.has(k)) {
        parent.set(k, { parentKey: key(sa, sb), code: c.atoms[ai].rep });
        queue.push({ sa: na, sb: nb });
      }
    }
  }
  return null;
}

export function relationByAntichains(a: NFA, b: NFA, budget = DEFAULT_BUDGET): RelationReport {
  const c = buildCombined(a, b);
  const aSubB = decideInclusionOn(c, budget);
  const bSubA = decideInclusionOn(buildCombined(b, a), budget);
  let relation: Relation;
  if (aSubB.included && bSubA.included) relation = 'equal';
  else if (aSubB.included) relation = 'subset';
  else if (bSubA.included) relation = 'superset';
  else {
    const both = intersectionWitness(c);
    relation = both ? 'overlap' : 'disjoint';
  }
  const inBoth = relation === 'equal' || relation === 'disjoint' ? null : intersectionWitness(c);
  return {
    relation,
    aSubB,
    bSubA,
    inAnotB: aSubB.witness,
    inBnotA: bSubA.witness,
    inBoth,
  };
}

// --- Universality: is L(N) = Σ* over N's own alphabet? ----------------------
//
// Build a one-state automaton that accepts every nonempty... actually every
// string over N's alphabet, and test its inclusion in N. We assemble it on N's
// atoms so the shared alphabet is exactly N's.

export interface UniversalityResult {
  universal: boolean;
  witness: Witness | null; // shortest rejected word when not universal
  antichainSize: number;
  explored: number;
}

export function decideUniversality(n: NFA, budget = DEFAULT_BUDGET): UniversalityResult {
  // A universal NFA over N's alphabet: a single accepting state with a self-loop
  // on every code point N mentions. We synthesise it directly as a combined
  // automaton would, but it is easiest to build a real NFA: one state, start =
  // accept = 0, looping on the union of all of N's symbol sets.
  const univ = buildUniversalLike(n);
  const res = decideInclusion(univ, n, budget);
  return {
    universal: res.included,
    witness: res.witness,
    antichainSize: res.antichainSize,
    explored: res.explored,
  };
}

// A 2-state NFA accepting Σ* over exactly the alphabet N mentions: state 0 is
// start+accept, with a symbol self-loop carrying the union of every edge set in
// N. (ε already accepted since start is accepting.)
function buildUniversalLike(n: NFA): NFA {
  // Collect the union of N's symbol sets as one CharSet.
  const sets = n.edges.filter((e) => e.set).map((e) => e.set!);
  if (sets.length === 0) {
    // N has no symbols at all — its alphabet is empty, Σ* = {ε}. A single
    // accepting state with no edges recognises exactly {ε}.
    return { start: 0, accept: 0, stateCount: 1, edges: [] };
  }
  // Union via the CharSet algebra already on the edges.
  const all = CharSet.union(sets);
  return { start: 0, accept: 0, stateCount: 1, edges: [{ from: 0, to: 0, set: all }] };
}
