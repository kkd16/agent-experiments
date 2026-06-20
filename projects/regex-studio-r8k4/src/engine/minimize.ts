// DFA minimization by partition refinement (Moore's algorithm).
//
// The DFA is completed with an implicit dead sink, states are split into
// accepting / non-accepting and then refined by their transition signatures
// until the partition is stable. Each resulting block becomes one state of the
// minimal DFA; the dead block is dropped from the result (transitions into it
// become rejects), matching the partial DFA we display elsewhere.

import { CharSet } from './charset';
import type { DFA, DFAState, DFATransition } from './dfa';

export function minimizeDFA(dfa: DFA): DFA {
  const N = dfa.states.length;
  const atoms = dfa.atoms;
  const A = atoms.length;
  if (N === 0) return dfa;

  const DEAD = N;
  const total = N + 1;
  const next = (s: number, a: number): number => {
    if (s === DEAD) return DEAD;
    const t = dfa.table[s][a];
    return t < 0 ? DEAD : t;
  };

  let block = new Int32Array(total);
  for (let s = 0; s < N; s++) block[s] = dfa.states[s].accept ? 1 : 0;
  block[DEAD] = 0;
  let blockCount = 2;

  for (;;) {
    const sigToId = new Map<string, number>();
    const nextBlock = new Int32Array(total);
    let count = 0;
    for (let s = 0; s < total; s++) {
      let sig = block[s] + '|';
      for (let a = 0; a < A; a++) sig += block[next(s, a)] + ',';
      let id = sigToId.get(sig);
      if (id === undefined) {
        id = count++;
        sigToId.set(sig, id);
      }
      nextBlock[s] = id;
    }
    block = nextBlock;
    if (count === blockCount) break;
    blockCount = count;
  }

  const deadBlock = block[DEAD];
  const startBlock = block[dfa.start];

  // Choose which blocks survive into the minimal DFA, start first.
  const keep: number[] = [];
  const seen = new Set<number>();
  const consider = (b: number) => {
    if (seen.has(b)) return;
    if (b === deadBlock && b !== startBlock) return; // drop the trap
    seen.add(b);
    keep.push(b);
  };
  consider(startBlock);
  for (let s = 0; s < N; s++) consider(block[s]);

  const newIndex = new Map<number, number>();
  keep.forEach((b, i) => newIndex.set(b, i));

  // Representative state and merged NFA-subset for each surviving block.
  const repOf = new Map<number, number>();
  const subsetOf = new Map<number, Set<number>>();
  for (let s = 0; s < N; s++) {
    const b = block[s];
    if (!newIndex.has(b)) continue;
    if (!repOf.has(b)) repOf.set(b, s);
    const set = subsetOf.get(b) ?? new Set<number>();
    for (const n of dfa.states[s].nfaStates) set.add(n);
    subsetOf.set(b, set);
  }

  const states: DFAState[] = keep.map((b, i) => {
    const rep = repOf.get(b);
    return {
      id: i,
      nfaStates: rep !== undefined ? [...(subsetOf.get(b) ?? [])].sort((x, y) => x - y) : [],
      accept: rep !== undefined ? dfa.states[rep].accept : false,
    };
  });

  const table: number[][] = keep.map(() => new Array(A).fill(-1));
  for (let i = 0; i < keep.length; i++) {
    const rep = repOf.get(keep[i]);
    if (rep === undefined) continue;
    for (let a = 0; a < A; a++) {
      const tb = block[next(rep, a)];
      const target = newIndex.get(tb);
      if (target !== undefined && tb !== deadBlock) table[i][a] = target;
    }
  }

  const edgeAccum = new Map<string, { from: number; to: number; sets: CharSet[] }>();
  for (let from = 0; from < keep.length; from++) {
    for (let a = 0; a < A; a++) {
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
    start: newIndex.get(startBlock) ?? 0,
    states,
    transitions,
    atoms,
    table: table.map((row) => Int32Array.from(row)),
  };
}
