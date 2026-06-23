// Lowering the product-alphabet bit-automaton into the studio's own structures.
//
// A *sentence* (no free variables) leaves a bit-automaton over just Σ — the
// language the formula defines. We map each letter to a code point and emit the
// studio's `DFA`, so the Logic tab's result flows unchanged into Min-DFA,
// Language, Census and the Algebra (syntactic-monoid) views — which is exactly
// how the variety bridge (FO ⇒ star-free) gets checked by existing machinery.
//
// For formulas with free variables we instead render the bit-automaton directly,
// labelling each edge with its letter and the per-track bit pattern.

import { CharSet } from '../charset';
import type { DFA, DFAState, DFATransition, Atom } from '../dfa';
import type { GraphInput } from '../layout';
import { type BitDFA, symLetter, symBits, getBit, bitIndex } from './bitaut';

// Sentence bit-automaton (tracks = []) → studio DFA over Σ.
export function lowerSentenceToDFA(bit: BitDFA, alphabet: string[]): DFA {
  if (bit.tracks.length !== 0) throw new Error('lowerSentenceToDFA: not a sentence automaton');
  const codes = alphabet.map((c) => c.codePointAt(0) ?? 0);
  // atom order = letters sorted by code point
  const order = codes.map((_, i) => i).sort((p, q) => codes[p] - codes[q]);
  const atomOfLetter = new Array<number>(alphabet.length);
  order.forEach((letterIdx, atomIdx) => (atomOfLetter[letterIdx] = atomIdx));
  const atoms: Atom[] = order.map((letterIdx) => ({
    set: CharSet.fromChar(codes[letterIdx]),
    lo: codes[letterIdx],
    hi: codes[letterIdx],
  }));

  const states: DFAState[] = bit.accept.map((acc, id) => ({ id, nfaStates: [id], accept: acc }));
  const table: number[][] = [];
  for (let s = 0; s < bit.n; s++) {
    const row = new Array<number>(atoms.length).fill(-1);
    for (let l = 0; l < bit.sigma; l++) {
      const t = bit.trans[s][l]; // tracks empty ⇒ symbol == letter index
      if (t >= 0) row[atomOfLetter[l]] = t;
    }
    table.push(row);
  }

  const edgeAccum = new Map<string, { from: number; to: number; sets: CharSet[] }>();
  for (let from = 0; from < bit.n; from++) {
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

  return { start: bit.start, states, transitions, atoms, table: table.map((r) => Int32Array.from(r)) };
}

// A compact label for one product-alphabet symbol: the letter plus, for each
// track, whether its bit is set — e.g. "a · x,X̄" (x in, X out).
export function symbolLabel(bit: BitDFA, alphabet: string[], sym: number): string {
  const l = symLetter(bit.tracks, sym);
  const bits = symBits(bit.tracks, sym);
  const letter = alphabet[l] ?? `?${l}`;
  if (bit.tracks.length === 0) return letter;
  const marks = bit.tracks.map((t) => (getBit(bits, bitIndex(bit.tracks, t.name)) ? t.name : `${t.name}̄`)).join(' ');
  return `${letter} · ${marks}`;
}

// Render any bit-automaton as a graph, merging the symbols on each edge.
export function bitDfaToGraph(bit: BitDFA, alphabet: string[]): GraphInput {
  const nodes = Array.from({ length: bit.n }, (_, id) => ({ id, label: String(id) }));
  const edgeAccum = new Map<string, { from: number; to: number; labels: string[] }>();
  for (let from = 0; from < bit.n; from++) {
    const row = bit.trans[from];
    for (let sym = 0; sym < row.length; sym++) {
      const to = row[sym];
      if (to < 0) continue;
      const key = `${from}->${to}`;
      const acc = edgeAccum.get(key) ?? { from, to, labels: [] };
      acc.labels.push(symbolLabel(bit, alphabet, sym));
      edgeAccum.set(key, acc);
    }
  }
  const edges = [...edgeAccum.values()].map((e) => {
    let label = e.labels.join(', ');
    if (label.length > 40) label = e.labels.slice(0, 3).join(', ') + ` …(${e.labels.length})`;
    return { from: e.from, to: e.to, label, epsilon: false };
  });
  return { nodes, edges, start: bit.start, accepts: new Set(bit.accept.map((a, i) => (a ? i : -1)).filter((i) => i >= 0)) };
}
