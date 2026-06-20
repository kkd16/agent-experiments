// Comparing two regular languages by their DFAs.
//
// Two DFAs may partition the alphabet differently, so we first build a *common
// refinement*: the set of maximal character ranges over which both DFAs behave
// uniformly. We then walk the product automaton A×B breadth-first. The first
// product state whose two components disagree on acceptance yields the shortest
// distinguishing string — the textbook witness that the languages differ. From
// the reachable acceptance combinations we read off the full set relationship:
// equal, subset, superset, disjoint or merely overlapping.

import { atomIndexFor, type DFA } from './dfa';

export type Relation = 'equal' | 'subset' | 'superset' | 'disjoint' | 'overlap';

export interface Witness {
  codes: number[];
  text: string; // raw string (may contain control chars)
  display: string; // escaped, human-readable
}

export interface CompareResult {
  relation: Relation;
  // Each witness is the shortest string proving the corresponding fact, if any.
  inAOnly: Witness | null; // ∈ A, ∉ B
  inBOnly: Witness | null; // ∈ B, ∉ A
  inBoth: Witness | null; // ∈ A ∩ B
  aEmpty: boolean;
  bEmpty: boolean;
}

interface Refined {
  lo: number;
  rep: number; // representative code point used for stepping + witnesses
}

// Pick a readable representative code point inside [lo, hi].
function representative(lo: number, hi: number): number {
  const prefer = [97, 98, 99, 48, 49, 32, 65]; // a b c 0 1 space A
  for (const c of prefer) if (c >= lo && c <= hi) return c;
  for (let c = Math.max(lo, 33); c <= Math.min(hi, 126); c++) return c; // any printable ASCII
  return lo;
}

// Maximal ranges over which both DFAs behave uniformly, covering every symbol
// either DFA mentions. Symbols neither DFA references send both to a reject
// sink identically, so they can never distinguish the languages — we skip them.
function commonRefinement(a: DFA, b: DFA): Refined[] {
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
  const out: Refined[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const lo = points[i];
    const hi = points[i + 1] - 1;
    if (lo > hi) continue;
    const inA = atomIndexFor(a.atoms, lo) >= 0;
    const inB = atomIndexFor(b.atoms, lo) >= 0;
    if (inA || inB) out.push({ lo, rep: representative(lo, hi) });
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

function makeWitness(codes: number[]): Witness {
  const text = codes.map((c) => String.fromCodePoint(c)).join('');
  const display = codes
    .map((c) => {
      if (c === 32) return '␣';
      if (c === 10) return '\\n';
      if (c === 9) return '\\t';
      if (c < 32 || c === 127) return `\\x${c.toString(16).padStart(2, '0')}`;
      return String.fromCodePoint(c);
    })
    .join('');
  return { codes, text, display: display.length ? display : 'ε (empty string)' };
}

function languageEmpty(dfa: DFA): boolean {
  // BFS reachability to any accepting state.
  const seen = new Uint8Array(dfa.states.length);
  const queue = [dfa.start];
  seen[dfa.start] = 1;
  while (queue.length) {
    const s = queue.shift()!;
    if (dfa.states[s].accept) return false;
    for (let a = 0; a < dfa.atoms.length; a++) {
      const t = dfa.table[s][a];
      if (t >= 0 && !seen[t]) {
        seen[t] = 1;
        queue.push(t);
      }
    }
  }
  return true;
}

export function compareDFAs(a: DFA, b: DFA): CompareResult {
  const refined = commonRefinement(a, b);

  const key = (sa: number, sb: number) => `${sa},${sb}`;
  const startKey = key(a.start, b.start);
  const parent = new Map<string, { prev: string | null; code: number }>();
  parent.set(startKey, { prev: null, code: -1 });

  const pathTo = (target: string): number[] => {
    const codes: number[] = [];
    let cur: string | null = target;
    for (;;) {
      const info: { prev: string | null; code: number } | undefined = cur ? parent.get(cur) : undefined;
      if (!info || info.prev === null) break;
      codes.push(info.code);
      cur = info.prev;
    }
    codes.reverse();
    return codes;
  };

  let inAOnly: Witness | null = null;
  let inBOnly: Witness | null = null;
  let inBoth: Witness | null = null;

  const queue: { sa: number; sb: number }[] = [{ sa: a.start, sb: b.start }];
  while (queue.length) {
    const { sa, sb } = queue.shift()!;
    const k = key(sa, sb);
    const accA = accepts(a, sa);
    const accB = accepts(b, sb);
    if (accA && !accB && !inAOnly) inAOnly = makeWitness(pathTo(k));
    if (!accA && accB && !inBOnly) inBOnly = makeWitness(pathTo(k));
    if (accA && accB && !inBoth) inBoth = makeWitness(pathTo(k));
    for (const r of refined) {
      const na = step(a, sa, r.rep);
      const nb = step(b, sb, r.rep);
      if (na < 0 && nb < 0) continue; // both dead — absorbing, nothing new
      const nk = key(na, nb);
      if (!parent.has(nk)) {
        parent.set(nk, { prev: k, code: r.rep });
        queue.push({ sa: na, sb: nb });
      }
    }
  }

  const aMinusB = inAOnly !== null;
  const bMinusA = inBOnly !== null;
  const intersect = inBoth !== null;

  let relation: Relation;
  if (!aMinusB && !bMinusA) relation = 'equal';
  else if (!aMinusB) relation = 'subset'; // A ⊆ B (proper, since bMinusA)
  else if (!bMinusA) relation = 'superset'; // A ⊇ B
  else if (!intersect) relation = 'disjoint';
  else relation = 'overlap';

  return {
    relation,
    inAOnly,
    inBOnly,
    inBoth,
    aEmpty: languageEmpty(a),
    bEmpty: languageEmpty(b),
  };
}
