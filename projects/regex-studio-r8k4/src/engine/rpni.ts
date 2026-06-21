// RPNI — Regular Positive and Negative Inference (Oncina & García, 1992).
//
// L* learns *actively*, asking the teacher questions. RPNI learns *passively*:
// it is handed a fixed bag of labelled examples — strings tagged "in the
// language" or "not" — and must infer a DFA consistent with all of them, with
// no further questions allowed. This is the setting of grammatical inference
// from data, and it is how you'd learn a language you can only *observe*.
//
// The algorithm: build the prefix-tree acceptor (PTA) of the sample — a tree
// DFA that accepts exactly the positive examples — then greedily MERGE states,
// lowest-numbered first, in canonical (shortlex) order. A merge is accepted iff,
// after determinising the fold it forces, no state ends up labelled both
// accepting and rejecting (i.e. no negative example becomes accepted). Merges
// that fail are rolled back; a blue state that can merge with no red state is
// promoted to red. RPNI is guaranteed to return the target's minimal DFA once
// the sample is *characteristic* — and a complete sample of every string up to
// a sufficient length always is.
//
// Like the L* learner, RPNI works over the studio's atom alphabet, so the DFA
// it infers drops straight into the existing graph / language / compare views.

import { CharSet } from './charset';
import type { Atom, DFA, DFAState, DFATransition } from './dfa';
import { compareDFAs } from './equivalence';
import { minimizeDFA } from './minimize';

export type Word = number[];

export interface Sample {
  positive: Word[];
  negative: Word[];
  maxLen: number;
}

export interface RpniResult {
  dfa: DFA | null;
  positives: number;
  negatives: number;
  maxLen: number;
  ptaStates: number; // states in the prefix-tree acceptor (before merging)
  learnedStates: number; // states after RPNI merging (the inferred complete DFA)
  canonicalStates: number; // minimizeDFA(learned) — partial canonical form
  targetStates: number;
  equivalent: boolean; // inferred ≡ target
  exact: boolean; // equivalent AND canonicalStates === targetStates
  witness: string | null; // a string they disagree on, if not equivalent
}

// Walk the target DFA over a word of atom indices.
function runTarget(target: DFA, word: Word): boolean {
  let s = target.start;
  for (const a of word) {
    if (s < 0) return false;
    s = target.table[s][a];
  }
  return s >= 0 && target.states[s].accept;
}

// A complete labelled sample: every string over the atom alphabet up to
// `maxLen`, tagged by the target. Such a sample is characteristic once `maxLen`
// is large enough, so RPNI provably recovers the exact target. Returns null if
// the sample would exceed `cap` strings (alphabet/length too large).
export function completeSample(target: DFA, maxLen: number, cap: number): Sample | null {
  const A = target.atoms.length;
  // Count first so we never build an oversized array.
  let total = 0;
  let pow = 1;
  for (let len = 0; len <= maxLen; len++) {
    total += pow;
    if (total > cap) return null;
    pow *= Math.max(1, A);
    if (A === 0) break; // only ε exists
  }
  const positive: Word[] = [];
  const negative: Word[] = [];
  let frontier: Word[] = [[]];
  for (let len = 0; len <= maxLen && frontier.length; len++) {
    for (const w of frontier) (runTarget(target, w) ? positive : negative).push(w);
    if (A === 0) break;
    const next: Word[] = [];
    for (const w of frontier) for (let a = 0; a < A; a++) next.push([...w, a]);
    frontier = next;
  }
  return { positive, negative, maxLen };
}

function shortlex(a: Word, b: Word): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

interface PTA {
  trans: Int32Array[]; // trans[s][a] = next state or -1
  label: Int8Array; // 1 accept, -1 reject, 0 unknown
  count: number;
}

function buildPTA(sample: Sample, A: number): PTA {
  const trans: number[][] = [[]];
  trans[0] = new Array(A).fill(-1);
  const label: number[] = [0];
  let count = 1;
  const newState = () => {
    trans.push(new Array(A).fill(-1));
    label.push(0);
    return count++;
  };
  // Insert in shortlex order so state ids follow canonical BFS order.
  const tagged: { w: Word; lab: number }[] = [
    ...sample.positive.map((w) => ({ w, lab: 1 })),
    ...sample.negative.map((w) => ({ w, lab: -1 })),
  ].sort((x, y) => shortlex(x.w, y.w));
  for (const { w, lab } of tagged) {
    let s = 0;
    for (const a of w) {
      let t = trans[s][a];
      if (t < 0) {
        t = newState();
        trans[s][a] = t;
      }
      s = t;
    }
    // A consistent sample never tags one string both ways; last write wins
    // harmlessly if it ever does.
    label[s] = lab;
  }
  return { trans: trans.map((r) => Int32Array.from(r)), label: Int8Array.from(label), count };
}

// Union–find over PTA states.
function makeUF(n: number) {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
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
    if (ra === rb) return;
    // Keep the smaller id as the representative (canonical merge target).
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };
  return { parent, find, union };
}

// Attempt to merge classes of qr and qb, then determinise the fold. Returns the
// resulting parent array on success, or null if it forces an accept/reject clash.
function tryMerge(pta: PTA, base: Int32Array, qr: number, qb: number, A: number): Int32Array | null {
  const n = pta.count;
  const parent = base.slice();
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
    if (ra === rb) return;
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };
  union(qr, qb);
  let changed = true;
  while (changed) {
    changed = false;
    const out = new Map<number, number>(); // (classRep * A + a) → target class
    const lab = new Map<number, number>();
    for (let s = 0; s < n; s++) {
      const cs = find(s);
      const l = pta.label[s];
      if (l !== 0) {
        const ex = lab.get(cs);
        if (ex === undefined) lab.set(cs, l);
        else if (ex !== l) return null; // accept/reject clash ⇒ merge invalid
      }
      for (let a = 0; a < A; a++) {
        const t = pta.trans[s][a];
        if (t < 0) continue;
        const ct = find(t);
        const key = cs * A + a;
        const prev = out.get(key);
        if (prev === undefined) out.set(key, ct);
        else if (prev !== ct) {
          union(prev, ct);
          changed = true;
        }
      }
    }
  }
  return parent;
}

// Quotient the PTA by a final partition into a studio DFA over the target atoms.
function quotientToDFA(pta: PTA, parent: Int32Array, atoms: Atom[]): DFA {
  const A = atoms.length;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    return r;
  };
  // Number classes by their smallest PTA id (so class of state 0 is the start).
  const classId = new Map<number, number>();
  const reps: number[] = [];
  for (let s = 0; s < pta.count; s++) {
    const c = find(s);
    if (!classId.has(c)) {
      classId.set(c, reps.length);
      reps.push(c);
    }
  }
  const idOf = (s: number) => classId.get(find(s))!;
  const N = reps.length;
  const accept = new Array<boolean>(N).fill(false);
  for (let s = 0; s < pta.count; s++) if (pta.label[s] === 1) accept[idOf(s)] = true;

  const table: Int32Array[] = reps.map(() => new Int32Array(A).fill(-1));
  for (let s = 0; s < pta.count; s++) {
    const cs = idOf(s);
    for (let a = 0; a < A; a++) {
      const t = pta.trans[s][a];
      if (t >= 0) table[cs][a] = idOf(t);
    }
  }
  const states: DFAState[] = reps.map((_, id) => ({ id, nfaStates: [], accept: accept[id] }));
  const accum = new Map<string, { from: number; to: number; sets: CharSet[] }>();
  for (let from = 0; from < N; from++) {
    for (let a = 0; a < A; a++) {
      const to = table[from][a];
      if (to < 0) continue;
      const tk = `${from}->${to}`;
      const acc = accum.get(tk) ?? { from, to, sets: [] };
      acc.sets.push(atoms[a].set);
      accum.set(tk, acc);
    }
  }
  const transitions: DFATransition[] = [...accum.values()].map((e) => ({
    from: e.from,
    to: e.to,
    set: CharSet.union(e.sets),
  }));
  return { start: idOf(0), states, transitions, atoms, table };
}

// Run RPNI on a labelled sample over the given atom alphabet.
export function rpni(sample: Sample, atoms: Atom[]): { dfa: DFA; ptaStates: number } {
  const A = atoms.length;
  const pta = buildPTA(sample, A);
  const uf = makeUF(pta.count);

  // red = confirmed distinct states; blue = their immediate successors.
  const red: number[] = [0];
  const isRed = new Set<number>([0]);

  const blueOf = (): number[] => {
    const blue = new Set<number>();
    for (const r of red) {
      for (let a = 0; a < A; a++) {
        const t = pta.trans[r][a];
        if (t < 0) continue;
        const ct = uf.find(t);
        if (!isRed.has(ct)) blue.add(ct);
      }
    }
    return [...blue].sort((x, y) => x - y);
  };

  for (;;) {
    const blue = blueOf();
    if (blue.length === 0) break;
    const qb = blue[0];
    let merged = false;
    for (const qr of red) {
      const result = tryMerge(pta, uf.parent, qr, qb, A);
      if (result) {
        uf.parent.set(result);
        merged = true;
        break;
      }
    }
    if (!merged) {
      red.push(qb);
      isRed.add(qb);
    }
  }

  const dfa = quotientToDFA(pta, uf.parent, atoms);
  return { dfa, ptaStates: pta.count };
}

// Learn a DFA from a complete sample of the target up to the smallest length
// that recovers it exactly (or the largest length that fits under `sampleCap`).
export interface RpniFromTargetOptions {
  maxLenCap?: number;
  sampleCap?: number;
}

export function rpniLearnFromTarget(target: DFA, opts: RpniFromTargetOptions = {}): RpniResult {
  const maxLenCap = opts.maxLenCap ?? 7;
  const sampleCap = opts.sampleCap ?? 4000;
  const targetStates = target.states.length;

  let best: RpniResult | null = null;
  for (let L = 0; L <= maxLenCap; L++) {
    const sample = completeSample(target, L, sampleCap);
    if (!sample) break; // would exceed the cap — stop growing
    const { dfa, ptaStates } = rpni(sample, target.atoms);
    const cmp = compareDFAs(dfa, target);
    const equivalent = cmp.relation === 'equal';
    const canonicalStates = minimizeDFA(dfa).states.length;
    const witness = equivalent ? null : (cmp.inAOnly ?? cmp.inBOnly)?.display ?? null;
    const result: RpniResult = {
      dfa,
      positives: sample.positive.length,
      negatives: sample.negative.length,
      maxLen: L,
      ptaStates,
      learnedStates: dfa.states.length,
      canonicalStates,
      targetStates,
      equivalent,
      exact: equivalent && canonicalStates === targetStates,
      witness,
    };
    best = result;
    if (result.exact) return result; // smallest sample that nails it
  }
  return (
    best ?? {
      dfa: null,
      positives: 0,
      negatives: 0,
      maxLen: 0,
      ptaStates: 0,
      learnedStates: 0,
      canonicalStates: 0,
      targetStates,
      equivalent: false,
      exact: false,
      witness: null,
    }
  );
}
