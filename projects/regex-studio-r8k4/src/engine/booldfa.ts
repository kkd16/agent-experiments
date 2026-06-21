// Boolean operations on DFAs the *classical* way — the independent gold standard
// the Boolean-derivative engine (`ereg.ts`) is cross-checked against.
//
// Intersection / union / difference are the **product automaton** A×B: walk both
// machines in lock-step over a common alphabet refinement and accept a product
// state by the chosen Boolean combination of the two component verdicts.
// Complement is **complete-then-flip**: a partial DFA rejects an unmentioned
// character by falling into an implicit dead sink, so to complement it correctly
// we first make that sink explicit (completing the machine over all of Σ) and
// then flip every accepting bit — the dead sink, now reachable, becomes accepting.
//
// Both emit a DFA in the studio's own shape, so `compareDFAs` can prove
// `derivativeDFA(A & B) ≡ product(DFA A, DFA B)` and
// `derivativeDFA(~A) ≡ complement(DFA A)` — tying the brand-new engine to the
// classic Thompson→subset→Moore pipeline.

import { CharSet, MAX_CODE_POINT } from './charset';
import { atomIndexFor, type Atom, type DFA, type DFAState, type DFATransition } from './dfa';

export type BoolOp = 'and' | 'or' | 'sub'; // ∩ ∪ (A∖B)

function combine(op: BoolOp, a: boolean, b: boolean): boolean {
  switch (op) {
    case 'and':
      return a && b;
    case 'or':
      return a || b;
    case 'sub':
      return a && !b;
  }
}

// Maximal ranges over which both DFAs behave uniformly, covering every symbol
// either machine mentions. Symbols neither references send both to a reject sink
// identically, so they never matter to ∩/∪/∖ (each needs at least one operand to
// accept) — we skip them, exactly as the equivalence checker does.
function refine(a: DFA, b: DFA): Atom[] {
  const cuts = new Set<number>();
  for (const at of a.atoms) {
    cuts.add(at.lo);
    cuts.add(at.hi + 1);
  }
  for (const at of b.atoms) {
    cuts.add(at.lo);
    cuts.add(at.hi + 1);
  }
  const points = [...cuts].sort((x, y) => x - y);
  const out: Atom[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const lo = points[i];
    const hi = points[i + 1] - 1;
    if (lo > hi) continue;
    const inA = atomIndexFor(a.atoms, lo) >= 0;
    const inB = atomIndexFor(b.atoms, lo) >= 0;
    if (inA || inB) out.push({ set: CharSet.fromRange(lo, hi), lo, hi });
  }
  return out;
}

function step(dfa: DFA, state: number, code: number): number {
  if (state < 0) return -1;
  const idx = atomIndexFor(dfa.atoms, code);
  if (idx < 0) return -1;
  return dfa.table[state][idx];
}

function accepts(dfa: DFA, state: number): boolean {
  return state >= 0 && dfa.states[state].accept;
}

function collapseEdges(table: number[][], atoms: Atom[], n: number): DFATransition[] {
  const edgeAccum = new Map<string, { from: number; to: number; sets: CharSet[] }>();
  for (let from = 0; from < n; from++) {
    for (let a = 0; a < atoms.length; a++) {
      const to = table[from][a];
      if (to < 0) continue;
      const key = `${from}->${to}`;
      const acc = edgeAccum.get(key) ?? { from, to, sets: [] };
      acc.sets.push(atoms[a].set);
      edgeAccum.set(key, acc);
    }
  }
  return [...edgeAccum.values()].map((e) => ({ from: e.from, to: e.to, set: CharSet.union(e.sets) }));
}

export function productDFA(a: DFA, b: DFA, op: BoolOp): DFA {
  const atoms = refine(a, b);
  const states: DFAState[] = [];
  const table: number[][] = [];
  const idByKey = new Map<string, number>();
  const comps: { sa: number; sb: number }[] = [];

  const intern = (sa: number, sb: number): number => {
    const key = `${sa},${sb}`;
    const found = idByKey.get(key);
    if (found !== undefined) return found;
    const id = states.length;
    idByKey.set(key, id);
    states.push({ id, nfaStates: [], accept: combine(op, accepts(a, sa), accepts(b, sb)) });
    comps.push({ sa, sb });
    table.push(new Array(atoms.length).fill(-1));
    return id;
  };

  const startId = intern(a.start, b.start);
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift()!;
    const { sa, sb } = comps[id];
    for (let k = 0; k < atoms.length; k++) {
      const na = step(a, sa, atoms[k].lo);
      const nb = step(b, sb, atoms[k].lo);
      if (na < 0 && nb < 0) continue; // both dead — a reject sink, leave implicit
      const before = states.length;
      const to = intern(na, nb);
      table[id][k] = to;
      if (to === before) queue.push(to);
    }
  }

  return {
    start: startId,
    states,
    transitions: collapseEdges(table, atoms, states.length),
    atoms,
    table: table.map((row) => Int32Array.from(row)),
  };
}

// Complete `a` over the whole of Σ (every code point gets a real transition,
// uncovered ones landing in an explicit dead sink), then flip every accept bit.
export function complementDFA(a: DFA): DFA {
  // Partition all of Σ at the original atom boundaries.
  const cuts = new Set<number>([0, MAX_CODE_POINT + 1]);
  for (const at of a.atoms) {
    cuts.add(at.lo);
    cuts.add(at.hi + 1);
  }
  const points = [...cuts].sort((x, y) => x - y);
  const atoms: Atom[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const lo = points[i];
    const hi = points[i + 1] - 1;
    if (lo <= hi) atoms.push({ set: CharSet.fromRange(lo, hi), lo, hi });
  }

  const N = a.states.length;
  const DEAD = N;
  const total = N + 1;
  const table: number[][] = Array.from({ length: total }, () => new Array(atoms.length).fill(-1));
  for (let s = 0; s < N; s++) {
    for (let k = 0; k < atoms.length; k++) {
      const idx = atomIndexFor(a.atoms, atoms[k].lo);
      const to = idx < 0 ? -1 : a.table[s][idx];
      table[s][k] = to < 0 ? DEAD : to;
    }
  }
  for (let k = 0; k < atoms.length; k++) table[DEAD][k] = DEAD; // sink self-loops

  const states: DFAState[] = [];
  for (let s = 0; s < N; s++) states.push({ id: s, nfaStates: [], accept: !a.states[s].accept });
  states.push({ id: DEAD, nfaStates: [], accept: true }); // the rejecting sink now accepts

  return {
    start: a.start,
    states,
    transitions: collapseEdges(table, atoms, total),
    atoms,
    table: table.map((row) => Int32Array.from(row)),
  };
}
