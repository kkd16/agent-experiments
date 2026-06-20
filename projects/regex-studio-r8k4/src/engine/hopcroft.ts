// DFA minimisation by Hopcroft's algorithm — a second, independent road to the
// *minimal* DFA, complementing the Moore partition-refinement pass.
//
// Moore (`minimize.ts`) refines the whole partition on every round: O(n²·|Σ|).
// Hopcroft (1971) is the classic O(n·log n·|Σ|) improvement. It keeps a worklist
// of "distinguisher" blocks and, on each step, splits every block by which of
// its states step *into* the distinguisher on some symbol — always re-queuing
// the **smaller** half, which is what buys the log factor. Both algorithms
// compute the Myhill–Nerode equivalence, so they must land on the very same
// minimal machine (up to state numbering) — the app verifies that equality live.
//
// We reuse the studio's `DFA` shape and the same "complete with a dead sink,
// then drop it from the result" convention the Moore pass uses, so the two
// minimal DFAs are directly comparable.

import { CharSet } from './charset';
import type { DFA, DFAState, DFATransition } from './dfa';

export function minimizeHopcroft(dfa: DFA): DFA {
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

  // Inverse transition relation: inv[a][target] = list of sources stepping there.
  const inv: number[][][] = Array.from({ length: A }, () => Array.from({ length: total }, () => [] as number[]));
  for (let s = 0; s < total; s++) {
    for (let a = 0; a < A; a++) inv[a][next(s, a)].push(s);
  }

  // Blocks are mutable sets; every state knows its current block.
  type Block = { elems: Set<number> };
  const blockOf = new Map<number, Block>();
  const accepting = new Set<number>();
  const rest = new Set<number>();
  for (let s = 0; s < N; s++) (dfa.states[s].accept ? accepting : rest).add(s);
  rest.add(DEAD); // the dead sink is non-accepting

  const P = new Set<Block>();
  const W = new Set<Block>();
  const addBlock = (elems: Set<number>): Block | null => {
    if (elems.size === 0) return null;
    const b: Block = { elems };
    P.add(b);
    for (const s of elems) blockOf.set(s, b);
    return b;
  };
  const fBlock = addBlock(accepting);
  const cBlock = addBlock(rest);
  // Seed the worklist with both initial classes (correct; the smaller-half rule
  // below keeps the asymptotics).
  if (fBlock) W.add(fBlock);
  if (cBlock) W.add(cBlock);

  while (W.size > 0) {
    const Ablk = W.values().next().value as Block;
    W.delete(Ablk);
    const Asnapshot = new Set(Ablk.elems); // A may be split later; freeze it now

    for (let a = 0; a < A; a++) {
      // X = states that step into A on symbol a.
      const affected = new Map<Block, number[]>();
      for (const t of Asnapshot) {
        for (const p of inv[a][t]) {
          const Yb = blockOf.get(p)!;
          const list = affected.get(Yb);
          if (list) list.push(p);
          else affected.set(Yb, [p]);
        }
      }

      for (const [Yb, interArr] of affected) {
        const inter = new Set(interArr);
        if (inter.size === Yb.elems.size) continue; // X ⊇ Y — no split

        // Split Y into Y∩X (new block) and Y\X (Yb shrinks to the remainder).
        for (const s of inter) Yb.elems.delete(s);
        const newBlk: Block = { elems: inter };
        P.add(newBlk);
        for (const s of inter) blockOf.set(s, newBlk);

        if (W.has(Yb)) {
          W.add(newBlk); // Y already a distinguisher → both halves are
        } else {
          // Re-queue only the smaller half — Hopcroft's key optimisation.
          W.add(inter.size <= Yb.elems.size ? newBlk : Yb);
        }
      }
    }
  }

  return rebuild(dfa, blockOf, DEAD, atoms, A);
}

// Final partition → minimal DFA, mirroring the Moore pass's reconstruction so
// the two results are structurally comparable (start first; drop the dead trap).
function rebuild(
  dfa: DFA,
  blockOf: Map<number, { elems: Set<number> }>,
  DEAD: number,
  atoms: { set: CharSet; lo: number; hi: number }[],
  A: number,
): DFA {
  const N = dfa.states.length;
  const next = (s: number, a: number): number => {
    if (s === DEAD) return DEAD;
    const t = dfa.table[s][a];
    return t < 0 ? DEAD : t;
  };

  const deadBlock = blockOf.get(DEAD)!;
  const startBlock = blockOf.get(dfa.start)!;

  const keep: { elems: Set<number> }[] = [];
  const seen = new Set<object>();
  const consider = (b: { elems: Set<number> }) => {
    if (seen.has(b)) return;
    if (b === deadBlock && b !== startBlock) return;
    seen.add(b);
    keep.push(b);
  };
  consider(startBlock);
  for (let s = 0; s < N; s++) consider(blockOf.get(s)!);

  const indexOf = new Map<object, number>();
  keep.forEach((b, i) => indexOf.set(b, i));

  const repOf = new Map<object, number>();
  const subsetOf = new Map<object, Set<number>>();
  for (let s = 0; s < N; s++) {
    const b = blockOf.get(s)!;
    if (!indexOf.has(b)) continue;
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
      const tb = blockOf.get(next(rep, a))!;
      const target = indexOf.get(tb);
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
    start: indexOf.get(startBlock) ?? 0,
    states,
    transitions,
    atoms,
    table: table.map((row) => Int32Array.from(row)),
  };
}
