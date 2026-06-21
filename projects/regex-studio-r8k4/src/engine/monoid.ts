// The algebraic theory of a regular language: its *syntactic monoid*.
//
// Every regular language L has a canonical finite monoid M(L) — the quotient of
// the free monoid Σ* by the syntactic congruence — and a classical theorem says
// M(L) is exactly the **transition monoid of the minimal complete DFA**: the
// monoid of state-transformations the input words induce. Build that monoid and
// you can *read the language's deepest properties off its algebra*:
//
//   • Schützenberger (1965): L is STAR-FREE  ⇔  M(L) is APERIODIC (group-free)
//   • McNaughton–Papert (1971): aperiodic  ⇔  L is FIRST-ORDER (FO[<]) definable
//                                          ⇔  the minimal DFA is COUNTER-FREE
//   • Simon (1975): L is PIECEWISE-TESTABLE ⇔ M(L) is J-trivial
//   • L is a GROUP language ⇔ M(L) is a group (the DFA is a permutation automaton)
//
// This module is the from-scratch finite-monoid toolkit behind the Algebra tab:
// it builds the transition monoid by BFS closure under composition, computes
// Green's relations R/L/J/H/D (the egg-box structure), finds the idempotents,
// and decides the variety membership above — each verdict cross-checked several
// independent ways so the panel can prove, not just assert, the answer.

import type { DFA } from './dfa';

// One element of the monoid: a transformation of the (complete) DFA's state set,
// together with a shortest word that realises it (for display). The empty word
// realises the identity.
export interface MonoidElement {
  id: number;
  transform: Int32Array; // transform[s] = state reached from s by reading the word
  word: number[]; // atom indices; [] = identity (ε)
  rank: number; // |image| — J-monotone, equal across a D-class
  idempotent: boolean;
}

export interface CompleteDFA {
  numStates: number; // includes the sink if one was added
  start: number;
  accept: boolean[]; // length numStates
  sink: number; // index of the added sink, or -1 if the DFA was already complete
  atomLabels: string[]; // human label per generator (atom)
  // table[s][a] = next state, always >= 0 (sink absorbs the missing edges)
  table: Int32Array[];
}

export interface SyntacticMonoid {
  complete: CompleteDFA;
  elements: MonoidElement[];
  size: number;
  identity: number; // element id of ε
  generators: number[]; // element id per atom (may repeat / equal identity)
  idempotents: number[]; // element ids of the idempotents (e·e = e)
  zero: number; // two-sided zero element id, or -1
  // mult[i * size + j] = id of the product i·j (apply i's word then j's word).
  // Present only when !truncated.
  mult: Int32Array | null;
  truncated: boolean; // hit the enumeration cap — the monoid is larger than `cap`
  cap: number;
}

const CAP = 1500; // |M| ≤ CAP for the full Cayley table + Green's relations

function transformKey(t: Int32Array): string {
  return t.join(',');
}

// Build the minimal *complete* DFA: re-add the dead sink the minimiser dropped,
// so every state has a total transition function (required for the transition
// monoid to be the syntactic monoid).
export function completeDFA(min: DFA): CompleteDFA {
  const N = min.states.length;
  const A = min.atoms.length;
  let needSink = false;
  for (let s = 0; s < N && !needSink; s++) {
    for (let a = 0; a < A; a++) {
      if (min.table[s][a] < 0) {
        needSink = true;
        break;
      }
    }
  }
  const sink = needSink ? N : -1;
  const numStates = needSink ? N + 1 : N;
  const table: Int32Array[] = [];
  for (let s = 0; s < N; s++) {
    const row = new Int32Array(A);
    for (let a = 0; a < A; a++) {
      const t = min.table[s][a];
      row[a] = t < 0 ? sink : t;
    }
    table.push(row);
  }
  if (needSink) {
    const row = new Int32Array(A);
    row.fill(sink);
    table.push(row);
  }
  const accept: boolean[] = [];
  for (let s = 0; s < N; s++) accept.push(min.states[s].accept);
  if (needSink) accept.push(false);
  const atomLabels = min.atoms.map((at) => at.set.label());
  return { numStates, start: min.start, accept, sink, atomLabels, table };
}

function imageRank(t: Int32Array): number {
  const seen = new Set<number>();
  for (let i = 0; i < t.length; i++) seen.add(t[i]);
  return seen.size;
}

// The transition monoid of a complete DFA, built by BFS closure of the
// generators (one transformation per atom) under composition.
export function buildSyntacticMonoid(min: DFA): SyntacticMonoid {
  const complete = completeDFA(min);
  const n = complete.numStates;
  const A = complete.table.length ? complete.table[0].length : 0;

  // Generator transforms: g_a[s] = δ(s, a).
  const genT: Int32Array[] = [];
  for (let a = 0; a < A; a++) {
    const g = new Int32Array(n);
    for (let s = 0; s < n; s++) g[s] = complete.table[s][a];
    genT.push(g);
  }

  const elements: MonoidElement[] = [];
  const indexByKey = new Map<string, number>();

  const idTransform = new Int32Array(n);
  for (let s = 0; s < n; s++) idTransform[s] = s;

  const intern = (t: Int32Array, word: number[]): number => {
    const key = transformKey(t);
    const existing = indexByKey.get(key);
    if (existing !== undefined) return existing;
    const id = elements.length;
    indexByKey.set(key, id);
    elements.push({ id, transform: t, word, rank: imageRank(t), idempotent: false });
    return id;
  };

  const identity = intern(idTransform, []);
  // compose(a, b)[s] = b.transform[a.transform[s]] — read a's word then b's.
  const compose = (a: Int32Array, b: Int32Array): Int32Array => {
    const out = new Int32Array(n);
    for (let s = 0; s < n; s++) out[s] = b[a[s]];
    return out;
  };

  let truncated = false;
  const queue = [identity];
  while (queue.length) {
    const id = queue.shift()!;
    const e = elements[id];
    for (let a = 0; a < A; a++) {
      const t = compose(e.transform, genT[a]);
      const key = transformKey(t);
      if (indexByKey.has(key)) continue;
      if (elements.length >= CAP) {
        truncated = true;
        break;
      }
      const newId = intern(t, [...e.word, a]);
      queue.push(newId);
    }
    if (truncated) break;
  }

  const generators: number[] = [];
  for (let a = 0; a < A; a++) generators.push(indexByKey.get(transformKey(genT[a]))!);

  const size = elements.length;
  let mult: Int32Array | null = null;
  const idempotents: number[] = [];
  let zero = -1;

  if (!truncated && size <= CAP) {
    mult = new Int32Array(size * size);
    for (let i = 0; i < size; i++) {
      const ti = elements[i].transform;
      for (let j = 0; j < size; j++) {
        const prod = compose(ti, elements[j].transform);
        mult[i * size + j] = indexByKey.get(transformKey(prod))!;
      }
    }
    for (let i = 0; i < size; i++) {
      if (mult[i * size + i] === i) {
        elements[i].idempotent = true;
        idempotents.push(i);
      }
    }
    // A two-sided zero z: z·x = x·z = z for every x.
    for (let z = 0; z < size && zero < 0; z++) {
      let isZero = true;
      for (let x = 0; x < size; x++) {
        if (mult[z * size + x] !== z || mult[x * size + z] !== z) {
          isZero = false;
          break;
        }
      }
      if (isZero) zero = z;
    }
  } else {
    // Without the table we can still flag idempotents from the transforms alone.
    for (let i = 0; i < size; i++) {
      const e = elements[i];
      const sq = compose(e.transform, e.transform);
      if (transformKey(sq) === transformKey(e.transform)) {
        e.idempotent = true;
        idempotents.push(i);
      }
    }
  }

  return { complete, elements, size, identity, generators, idempotents, zero, mult, truncated, cap: CAP };
}

// ── Green's relations ────────────────────────────────────────────────────────
//
// On the multiplication table: aR b ⇔ aM = bM (same right ideal), aL b ⇔ Ma=Mb,
// aJ b ⇔ MaM = MbM, H = R ∩ L, and D = R∘L = L∘R. In a finite monoid D = J, and
// since R∘L is already transitive, the D-classes are the connected components of
// the graph linking elements that share an R-class or an L-class.

export interface GreenStructure {
  rClassOf: number[]; // element id → R-class index
  lClassOf: number[];
  hClassOf: number[];
  dClassOf: number[];
  rClasses: number[][]; // members per class
  lClasses: number[][];
  hClasses: number[][];
  dClasses: DClass[];
  maxHSize: number; // largest H-class — 1 ⇔ aperiodic
  maxGroupOrder: number; // largest *group* H-class order (the counting modulus)
}

export interface DClass {
  id: number;
  members: number[];
  rows: number[]; // R-class indices in this D-class (egg-box rows)
  cols: number[]; // L-class indices in this D-class (egg-box columns)
  cell: Map<string, number>; // `${rIdx},${lIdx}` → H-class index
  rank: number; // common image-rank of its elements
  regular: boolean; // contains an idempotent
  groupOrder: number; // order of its group H-classes (0 if non-regular)
}

function classifyBy(keyOf: (i: number) => string, size: number): { of: number[]; classes: number[][] } {
  const of = new Array<number>(size).fill(-1);
  const classes: number[][] = [];
  const idByKey = new Map<string, number>();
  for (let i = 0; i < size; i++) {
    const key = keyOf(i);
    let c = idByKey.get(key);
    if (c === undefined) {
      c = classes.length;
      idByKey.set(key, c);
      classes.push([]);
    }
    of[i] = c;
    classes[c].push(i);
  }
  return { of, classes };
}

export function greenRelations(m: SyntacticMonoid): GreenStructure | null {
  if (m.truncated || !m.mult) return null;
  const size = m.size;
  const mult = m.mult;

  // Right ideal aM = { a·x : x }, as a sorted-set key.
  const rightKey = (a: number): string => {
    const set = new Set<number>();
    for (let x = 0; x < size; x++) set.add(mult[a * size + x]);
    return [...set].sort((p, q) => p - q).join(',');
  };
  const leftKey = (a: number): string => {
    const set = new Set<number>();
    for (let x = 0; x < size; x++) set.add(mult[x * size + a]);
    return [...set].sort((p, q) => p - q).join(',');
  };

  const R = classifyBy(rightKey, size);
  const L = classifyBy(leftKey, size);
  const H = classifyBy((i) => `${R.of[i]}|${L.of[i]}`, size);

  // D = connected components of (same R-class ∪ same L-class).
  const parent = new Array<number>(size);
  for (let i = 0; i < size; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const nx = parent[x];
      parent[x] = r;
      x = nx;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (const cls of R.classes) for (let k = 1; k < cls.length; k++) union(cls[0], cls[k]);
  for (const cls of L.classes) for (let k = 1; k < cls.length; k++) union(cls[0], cls[k]);

  const dRootToId = new Map<number, number>();
  const dClassOf = new Array<number>(size).fill(-1);
  const dMembers: number[][] = [];
  for (let i = 0; i < size; i++) {
    const root = find(i);
    let id = dRootToId.get(root);
    if (id === undefined) {
      id = dMembers.length;
      dRootToId.set(root, id);
      dMembers.push([]);
    }
    dClassOf[i] = id;
    dMembers[id].push(i);
  }

  const idemSet = new Set(m.idempotents);
  let maxHSize = 0;
  for (const h of H.classes) maxHSize = Math.max(maxHSize, h.length);

  const dClasses: DClass[] = dMembers.map((members, id) => {
    const rowsSet = new Set<number>();
    const colsSet = new Set<number>();
    const cell = new Map<string, number>();
    for (const e of members) {
      rowsSet.add(R.of[e]);
      colsSet.add(L.of[e]);
      cell.set(`${R.of[e]},${L.of[e]}`, H.of[e]);
    }
    const rows = [...rowsSet].sort((a, b) => a - b);
    const cols = [...colsSet].sort((a, b) => a - b);
    const regular = members.some((e) => idemSet.has(e));
    // The structure group order = size of any group H-class in the D-class.
    let groupOrder = 0;
    if (regular) {
      for (const e of members) {
        if (idemSet.has(e)) {
          groupOrder = H.classes[H.of[e]].length;
          break;
        }
      }
    }
    return { id, members, rows, cols, cell, rank: m.elements[members[0]].rank, regular, groupOrder };
  });

  // Order the egg-boxes by J-height: higher rank = J-greater (identity on top).
  dClasses.sort((a, b) => b.rank - a.rank || a.id - b.id);
  const reindex = new Map<number, number>();
  dClasses.forEach((d, i) => reindex.set(d.id, i));
  const dClassOf2 = dClassOf.map((d) => reindex.get(d)!);
  dClasses.forEach((d, i) => (d.id = i));

  let maxGroupOrder = 1;
  for (const d of dClasses) if (d.regular) maxGroupOrder = Math.max(maxGroupOrder, d.groupOrder);

  return {
    rClassOf: R.of,
    lClassOf: L.of,
    hClassOf: H.of,
    dClassOf: dClassOf2,
    rClasses: R.classes,
    lClasses: L.classes,
    hClasses: H.classes,
    dClasses,
    maxHSize,
    maxGroupOrder,
  };
}

// ── Counter-free test (the DFA side of Schützenberger / McNaughton–Papert) ────
//
// A DFA is counter-free iff no word w induces a non-trivial permutation on any
// subset of states: for every transformation t in the transition monoid, t
// restricted to its periodic points (its eventual image) is the identity. A
// counter of length > 1 is exactly a modular-counting feature like (aa)*.
export function counterFreeWitness(m: SyntacticMonoid): { counterFree: boolean; period: number; word: number[] | null } {
  const n = m.complete.numStates;
  let worstPeriod = 1;
  let worstWord: number[] | null = null;
  for (const e of m.elements) {
    const t = e.transform;
    // Land each state on its cycle by iterating n times, then measure the cycle.
    for (let s0 = 0; s0 < n; s0++) {
      let x = s0;
      for (let k = 0; k < n; k++) x = t[x];
      // x is now periodic; find its cycle length.
      let y = t[x];
      let len = 1;
      while (y !== x) {
        y = t[y];
        len++;
        if (len > n) break;
      }
      if (len > worstPeriod) {
        worstPeriod = len;
        worstWord = e.word;
      }
    }
  }
  return { counterFree: worstPeriod === 1, period: worstPeriod, word: worstWord };
}

// ── Variety membership / property panel ──────────────────────────────────────

export interface MonoidProperties {
  size: number;
  idempotentCount: number;
  hasZero: boolean;
  trivial: boolean; // |M| = 1
  commutative: boolean;
  band: boolean; // every element idempotent
  // The headline: aperiodic ⇔ star-free ⇔ FO[<] ⇔ counter-free. Cross-checked.
  aperiodic: boolean;
  aperiodicByHClasses: boolean; // every H-class singleton
  aperiodicByPowers: boolean; // every element group-free (mⁿ = mⁿ⁺¹)
  counterFree: boolean; // DFA-side test
  counterPeriod: number; // the largest counter found (1 ⇔ counter-free)
  counterWord: number[] | null;
  crossCheckOk: boolean; // all three aperiodicity computations agree
  jTrivial: boolean; // ⇒ piecewise testable (Simon)
  rTrivial: boolean;
  lTrivial: boolean;
  group: boolean; // M is a group ⇒ L is a group language
  countingModulus: number; // largest group order (1 ⇔ star-free)
}

// Group-free test on the powers of a single element: mⁿ stabilises to mⁿ⁺¹.
function groupFree(m: SyntacticMonoid): boolean {
  if (!m.mult) return false;
  const size = m.size;
  const mult = m.mult;
  for (let a = 0; a < size; a++) {
    let p = a;
    // mⁿ for n up to size+1 must reach a fixpoint mⁿ = mⁿ⁺¹.
    let stable = false;
    for (let k = 0; k <= size; k++) {
      const np = mult[p * size + a];
      if (np === p) {
        stable = true;
        break;
      }
      p = np;
    }
    if (!stable) return false;
  }
  return true;
}

export function monoidProperties(m: SyntacticMonoid, green: GreenStructure): MonoidProperties {
  const size = m.size;
  const mult = m.mult!;

  let commutative = true;
  for (let i = 0; i < size && commutative; i++) {
    for (let j = i + 1; j < size; j++) {
      if (mult[i * size + j] !== mult[j * size + i]) {
        commutative = false;
        break;
      }
    }
  }

  const aperiodicByHClasses = green.maxHSize === 1;
  const aperiodicByPowers = groupFree(m);
  const cf = counterFreeWitness(m);
  const aperiodic = aperiodicByHClasses;
  const crossCheckOk =
    aperiodicByHClasses === aperiodicByPowers && aperiodicByHClasses === cf.counterFree;

  const jTrivial = green.dClasses.length === size;
  const rTrivial = green.rClasses.length === size;
  const lTrivial = green.lClasses.length === size;
  const band = m.idempotents.length === size;
  const group = m.idempotents.length === 1;

  return {
    size,
    idempotentCount: m.idempotents.length,
    hasZero: m.zero >= 0,
    trivial: size === 1,
    commutative,
    band,
    aperiodic,
    aperiodicByHClasses,
    aperiodicByPowers,
    counterFree: cf.counterFree,
    counterPeriod: cf.period,
    counterWord: cf.word,
    crossCheckOk,
    jTrivial,
    rTrivial,
    lTrivial,
    group,
    countingModulus: green.maxGroupOrder,
  };
}

// Render a monoid element's word for display: ε for the identity, otherwise the
// atom labels concatenated (a class label like `[a-z]` is wrapped so it reads).
export function wordLabel(word: number[], atomLabels: string[]): string {
  if (word.length === 0) return 'ε';
  return word
    .map((a) => {
      const l = atomLabels[a] ?? '?';
      return l.length === 1 ? l : `(${l})`;
    })
    .join('');
}
