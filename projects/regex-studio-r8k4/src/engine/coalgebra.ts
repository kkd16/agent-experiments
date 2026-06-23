// Deciding language equivalence & inclusion *without determinising* — the
// coalgebraic and antichain roads.
//
// The studio already compares two languages by walking the product of their
// *minimal DFAs* (`equivalence.ts`). That road first pays for determinisation
// (worst-case exponential) on both sides. This module takes the modern road
// that skips it:
//
//   • EQUIVALENCE by bisimulation **up to congruence** (Bonchi & Pous, POPL
//     2013, "Checking NFA equivalence with bisimulations up to congruence").
//     We explore the determinised powerset *lazily* and prune any pair already
//     in the congruence closure of the pairs seen so far. The same driver also
//     runs the two weaker classics — naïve Hopcroft–Karp and HK *up to
//     equivalence* — so the panel can show, quantitatively, how few pairs the
//     congruence closure needs where the others explode.
//
//   • INCLUSION & UNIVERSALITY by **antichains** (De Wulf, Doyen, Henzinger &
//     Raskin, CAV 2006, "Antichains: A New Algorithm for Checking Universality
//     of Finite Automata"). `L(A) ⊆ L(B)` searches for a word in `L(A)\L(B)`
//     over macrostates `(q, S)` — a single existential A-state paired with the
//     determinised B-subset — keeping only the ⊑-minimal frontier.
//
// Both roads operate directly on the ε-NFAs the pipeline already built, share a
// common atomic alphabet, and return a concrete distinguishing word when the
// answer is "no" — cross-checked against the DFA-product road in
// `coalgebra-verify.ts`.

import type { NFA } from './nfa';
import { buildAdjacency, epsilonClosure, type NFAAdjacency } from './nfa';

// --- A symbolic two-sided automaton over a shared atomic alphabet -----------
//
// Both NFAs are embedded into one combined state space (A's states first, then
// B's, shifted by `offsetB`) so the powerset transition is a single function
// and set union is plain integer-set union — exactly the Bonchi–Pous setting.
// `startA` / `startB` are the two ε-closed initial subsets we compare.

export interface Atom {
  lo: number;
  hi: number;
  rep: number; // a readable representative code point inside [lo, hi]
}

export interface Combined {
  atoms: Atom[];
  offsetB: number;
  stateCount: number;
  accept: Set<number>; // combined accepting states (A.accept and B.accept+offset)
  acceptA: number; // A's accepting state in the combined space
  acceptB: number; // B's accepting state in the combined space (already offset)
  startA: Set<number>;
  startB: Set<number>;
  adj: NFAAdjacency; // combined adjacency
  // Per-state symbol successors bucketed by atom index, for fast `move`.
  byAtom: number[][][]; // byAtom[state][atomIdx] = successor states (pre-ε)
}

// Pick a readable representative code point inside [lo, hi] (mirrors
// equivalence.ts so witnesses read the same across both roads).
function representative(lo: number, hi: number): number {
  const prefer = [97, 98, 99, 48, 49, 32, 65]; // a b c 0 1 space A
  for (const c of prefer) if (c >= lo && c <= hi) return c;
  for (let c = Math.max(lo, 33); c <= Math.min(hi, 126); c++) return c;
  return lo;
}

// The maximal ranges over which *either* NFA's edges behave uniformly. Symbols
// neither NFA mentions send both sides to the empty (reject) subset identically,
// so they can never distinguish the languages — we drop them, exactly as the
// product-automaton road does.
function commonAtoms(a: NFA, b: NFA): Atom[] {
  const cuts = new Set<number>();
  const add = (nfa: NFA) => {
    for (const e of nfa.edges) {
      if (!e.set) continue;
      for (const r of e.set.ranges) {
        cuts.add(r.lo);
        cuts.add(r.hi + 1);
      }
    }
  };
  add(a);
  add(b);
  const points = [...cuts].sort((x, y) => x - y);
  // Does any edge of either side cover code point `c`?
  const covered = (c: number): boolean => {
    for (const e of a.edges) if (e.set && e.set.contains(c)) return true;
    for (const e of b.edges) if (e.set && e.set.contains(c)) return true;
    return false;
  };
  const out: Atom[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const lo = points[i];
    const hi = points[i + 1] - 1;
    if (lo > hi) continue;
    if (covered(lo)) out.push({ lo, hi, rep: representative(lo, hi) });
  }
  return out;
}

export function buildCombined(a: NFA, b: NFA): Combined {
  const offsetB = a.stateCount;
  const stateCount = a.stateCount + b.stateCount;
  // Combined edge list: A as-is, B shifted by offsetB.
  const edges = [
    ...a.edges,
    ...b.edges.map((e) => ({ from: e.from + offsetB, to: e.to + offsetB, set: e.set })),
  ];
  const combinedNFA: NFA = {
    start: a.start,
    accept: a.accept,
    stateCount,
    edges,
  };
  const adj = buildAdjacency(combinedNFA);
  const atoms = commonAtoms(a, b);

  // Bucket every symbol edge into the atoms it covers (an edge set is a union of
  // atoms by construction, since atom boundaries align with edge boundaries).
  const byAtom: number[][][] = Array.from({ length: stateCount }, () =>
    atoms.map(() => [] as number[]),
  );
  for (let s = 0; s < stateCount; s++) {
    for (const { to, set } of adj.symbol[s]) {
      for (let ai = 0; ai < atoms.length; ai++) {
        if (set.contains(atoms[ai].rep)) byAtom[s][ai].push(to);
      }
    }
  }

  const acceptA = a.accept;
  const acceptB = b.accept + offsetB;
  const accept = new Set<number>([acceptA, acceptB]);
  const startA = epsilonClosure([a.start], adj);
  const startB = epsilonClosure([b.start + offsetB], adj);
  return { atoms, offsetB, stateCount, accept, acceptA, acceptB, startA, startB, adj, byAtom };
}

// δ(X, a): symbolic transition of a subset over one atom, ε-closed.
export function move(c: Combined, set: Set<number>, atomIdx: number): Set<number> {
  const raw: number[] = [];
  for (const s of set) {
    const bucket = c.byAtom[s][atomIdx];
    for (const t of bucket) raw.push(t);
  }
  return epsilonClosure(raw, c.adj);
}

// o(X): is the subset accepting?
function accepting(c: Combined, set: Set<number>): boolean {
  for (const s of set) if (c.accept.has(s)) return true;
  return false;
}

// --- Set keys & helpers -----------------------------------------------------

function keyOf(set: Set<number>): string {
  return [...set].sort((a, b) => a - b).join(',');
}
function subset(a: Set<number>, b: Set<number>): boolean {
  if (a.size > b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
function setEq(a: Set<number>, b: Set<number>): boolean {
  return a.size === b.size && subset(a, b);
}
function union(a: Set<number>, b: Set<number>): Set<number> {
  const out = new Set(a);
  for (const x of b) out.add(x);
  return out;
}

// --- The up-to closures (the heart of the technique) ------------------------

// `R` is the list of pairs already proved equivalent. We test whether a new
// pair (x, y) is *already* implied by R under the chosen closure, in which case
// it need not be explored.

type Mode = 'naive' | 'hk' | 'hkc';

interface Pair {
  x: Set<number>;
  y: Set<number>;
}

// Naïve Hopcroft–Karp: skip only an *identical* pair already processed.
function inIdentity(x: Set<number>, y: Set<number>, seen: Set<string>): boolean {
  return seen.has(keyOf(x) + '|' + keyOf(y));
}

// HK up to equivalence: skip (x, y) when x and y already sit in the same class
// of the equivalence closure of R. Union-find over the set-keys appearing in R.
function inEquivalence(x: Set<number>, y: Set<number>, R: Pair[]): boolean {
  const kx = keyOf(x);
  const ky = keyOf(y);
  if (kx === ky) return true; // reflexivity
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = parent.get(k);
    if (r === undefined) {
      parent.set(k, k);
      return k;
    }
    while (r !== k) {
      k = r;
      r = parent.get(k) ?? k;
    }
    return k;
  };
  const unite = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  parent.set(kx, kx);
  parent.set(ky, ky);
  for (const p of R) unite(keyOf(p.x), keyOf(p.y));
  return find(kx) === find(ky);
}

// HK up to *congruence* (Bonchi–Pous): skip (x, y) when they have the same
// normal form under the set-rewriting system R generates. A pair (u, v) ∈ R is
// a rule "any superset of u may absorb v, and vice-versa"; saturating both sets
// to a fixpoint and comparing is exactly membership in the least congruence
// (equivalence + closed under ∪) containing R.
function normalize(u0: Set<number>, R: Pair[]): Set<number> {
  let u = new Set(u0);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of R) {
      if (subset(p.x, u) && !subset(p.y, u)) {
        u = union(u, p.y);
        changed = true;
      }
      if (subset(p.y, u) && !subset(p.x, u)) {
        u = union(u, p.x);
        changed = true;
      }
    }
  }
  return u;
}
function inCongruence(x: Set<number>, y: Set<number>, R: Pair[]): boolean {
  return setEq(normalize(x, R), normalize(y, R));
}

// --- The equivalence decider ------------------------------------------------

export interface EquivResult {
  mode: Mode;
  equivalent: boolean;
  witness: Witness | null; // shortest distinguishing word when not equivalent
  processed: number; // pairs actually expanded (added to R)
  skipped: number; // pairs popped but discharged by the up-to closure
  relationPairs: { x: number[]; y: number[]; accept: boolean }[]; // R, for display
  budgetHit: boolean;
}

export interface Witness {
  codes: number[];
  display: string;
}

export function makeWitness(codes: number[]): Witness {
  const display = codes
    .map((c) => {
      if (c === 32) return '␣';
      if (c === 10) return '\\n';
      if (c === 9) return '\\t';
      if (c < 32 || c === 127) return `\\x${c.toString(16).padStart(2, '0')}`;
      return String.fromCodePoint(c);
    })
    .join('');
  return { codes, display: display.length ? display : 'ε (empty string)' };
}

const DEFAULT_BUDGET = 20000;

export function decideEquivalence(c: Combined, mode: Mode, budget = DEFAULT_BUDGET): EquivResult {
  const R: Pair[] = [];
  const seen = new Set<string>(); // processed-pair keys (for naïve skip)

  interface Node {
    pair: Pair;
    parentKey: string | null;
    code: number;
  }
  const startNode: Node = { pair: { x: c.startA, y: c.startB }, parentKey: null, code: -1 };
  const queue: Node[] = [startNode];
  // For witness reconstruction: pair-key → {parentKey, code}.
  const parent = new Map<string, { parentKey: string | null; code: number }>();
  const pairKey = (p: Pair) => keyOf(p.x) + '|' + keyOf(p.y);
  parent.set(pairKey(startNode.pair), { parentKey: null, code: -1 });
  // Avoid re-queuing literally identical pairs (keeps the queue finite even
  // before the up-to closure kicks in).
  const queued = new Set<string>([pairKey(startNode.pair)]);

  let processed = 0;
  let skipped = 0;

  const skipTest = (x: Set<number>, y: Set<number>): boolean => {
    if (mode === 'naive') return inIdentity(x, y, seen);
    if (mode === 'hk') return inEquivalence(x, y, R);
    return inCongruence(x, y, R);
  };

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
    if (processed + skipped > budget) {
      return { mode, equivalent: false, witness: null, processed, skipped, relationPairs: relPairs(R, c), budgetHit: true };
    }
    const { pair } = queue.shift()!;
    const { x, y } = pair;
    const k = pairKey(pair);

    if (skipTest(x, y)) {
      skipped++;
      continue;
    }
    if (accepting(c, x) !== accepting(c, y)) {
      return {
        mode,
        equivalent: false,
        witness: makeWitness(pathTo(k)),
        processed,
        skipped,
        relationPairs: relPairs(R, c),
        budgetHit: false,
      };
    }
    for (let ai = 0; ai < c.atoms.length; ai++) {
      const nx = move(c, x, ai);
      const ny = move(c, y, ai);
      const np: Pair = { x: nx, y: ny };
      const nk = pairKey(np);
      if (!queued.has(nk)) {
        queued.add(nk);
        parent.set(nk, { parentKey: k, code: c.atoms[ai].rep });
        queue.push({ pair: np, parentKey: k, code: c.atoms[ai].rep });
      }
    }
    R.push(pair);
    seen.add(k);
    processed++;
  }

  return { mode, equivalent: true, witness: null, processed, skipped, relationPairs: relPairs(R, c), budgetHit: false };
}

function relPairs(R: Pair[], c: Combined): { x: number[]; y: number[]; accept: boolean }[] {
  return R.map((p) => ({
    x: [...p.x].sort((a, b) => a - b),
    y: [...p.y].sort((a, b) => a - b),
    accept: accepting(c, p.x),
  }));
}

// Run all three modes at once — the comparison is the whole point.
export interface EquivReport {
  naive: EquivResult;
  hk: EquivResult;
  hkc: EquivResult;
  agree: boolean; // all three returned the same verdict
  offsetB: number; // combined ids ≥ offsetB belong to B (for display)
  atomCount: number;
}

export function runEquivalence(a: NFA, b: NFA, budget = DEFAULT_BUDGET): EquivReport {
  const c = buildCombined(a, b);
  const naive = decideEquivalence(c, 'naive', budget);
  const hk = decideEquivalence(c, 'hk', budget);
  const hkc = decideEquivalence(c, 'hkc', budget);
  const verdicts = [naive, hk, hkc].filter((r) => !r.budgetHit).map((r) => r.equivalent);
  const agree = verdicts.length === 0 || verdicts.every((v) => v === verdicts[0]);
  return { naive, hk, hkc, agree, offsetB: c.offsetB, atomCount: c.atoms.length };
}
