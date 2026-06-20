// Subset construction: ε-NFA → deterministic finite automaton.
//
// The alphabet is first partitioned into "atomic" symbol classes — maximal
// character ranges that every NFA edge treats uniformly. Subset construction
// then branches once per atomic class instead of once per Unicode code point,
// which keeps the DFA finite and small.

import { CharSet } from './charset';
import type { NFA } from './nfa';
import { buildAdjacency, epsilonClosure } from './nfa';

export interface DFAState {
  id: number;
  nfaStates: number[]; // the NFA subset this DFA state represents
  accept: boolean;
}

export interface DFATransition {
  from: number;
  to: number;
  set: CharSet; // union of the atomic classes taking from → to
}

export interface Atom {
  set: CharSet;
  lo: number;
  hi: number;
}

export interface DFA {
  start: number;
  states: DFAState[];
  transitions: DFATransition[];
  atoms: Atom[];
  // table[state][atomIndex] = next state id, or -1 for the implicit dead sink.
  table: Int32Array[];
}

// Partition every code point touched by an NFA edge into disjoint atomic
// ranges. Boundaries are aligned so each atom is wholly inside or outside of
// every edge's CharSet.
export function partitionAlphabet(nfa: NFA): Atom[] {
  const cuts = new Set<number>();
  const union: CharSet[] = [];
  for (const e of nfa.edges) {
    if (!e.set) continue;
    union.push(e.set);
    for (const r of e.set.ranges) {
      cuts.add(r.lo);
      cuts.add(r.hi + 1);
    }
  }
  if (union.length === 0) return [];
  const covered = CharSet.union(union);
  const points = [...cuts].sort((a, b) => a - b);
  const atoms: Atom[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const lo = points[i];
    const hi = points[i + 1] - 1;
    if (lo > hi) continue;
    // Boundaries align with edge ranges, so testing the low endpoint suffices.
    if (covered.contains(lo)) atoms.push({ set: CharSet.fromRange(lo, hi), lo, hi });
  }
  return atoms;
}

function subsetKey(states: number[]): string {
  return states.join(',');
}

export function buildDFA(nfa: NFA): DFA {
  const adj = buildAdjacency(nfa);
  const atoms = partitionAlphabet(nfa);

  const startSet = [...epsilonClosure([nfa.start], adj)].sort((a, b) => a - b);
  const states: DFAState[] = [];
  const table: number[][] = [];
  const indexByKey = new Map<string, number>();

  const intern = (set: number[]): number => {
    const key = subsetKey(set);
    const existing = indexByKey.get(key);
    if (existing !== undefined) return existing;
    const id = states.length;
    indexByKey.set(key, id);
    states.push({ id, nfaStates: set, accept: set.includes(nfa.accept) });
    table.push(new Array(atoms.length).fill(-1));
    return id;
  };

  const startId = intern(startSet);
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift()!;
    const subset = states[id].nfaStates;
    for (let a = 0; a < atoms.length; a++) {
      const sample = atoms[a].lo;
      const moved = new Set<number>();
      for (const s of subset) {
        for (const edge of adj.symbol[s]) {
          if (edge.set.contains(sample)) moved.add(edge.to);
        }
      }
      if (moved.size === 0) continue;
      const next = [...epsilonClosure(moved, adj)].sort((x, y) => x - y);
      const before = states.length;
      const toId = intern(next);
      table[id][a] = toId;
      if (toId === before) queue.push(toId);
    }
  }

  // Collapse atomic transitions into merged, labelled edges for display.
  const edgeAccum = new Map<string, { from: number; to: number; sets: CharSet[] }>();
  for (let from = 0; from < states.length; from++) {
    for (let a = 0; a < atoms.length; a++) {
      const to = table[from][a];
      if (to < 0) continue;
      const key = `${from}->${to}`;
      const acc = edgeAccum.get(key) ?? { from, to, sets: [] };
      acc.sets.push(atoms[a].set);
      edgeAccum.set(key, acc);
    }
  }
  const transitions: DFATransition[] = [...edgeAccum.values()].map((e) => ({
    from: e.from,
    to: e.to,
    set: CharSet.union(e.sets),
  }));

  return {
    start: startId,
    states,
    transitions,
    atoms,
    table: table.map((row) => Int32Array.from(row)),
  };
}

// Find the atom index for a code point via binary search, or -1 if uncovered.
export function atomIndexFor(atoms: Atom[], code: number): number {
  let lo = 0;
  let hi = atoms.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = atoms[mid];
    if (code < at.lo) hi = mid - 1;
    else if (code > at.hi) lo = mid + 1;
    else return mid;
  }
  return -1;
}
