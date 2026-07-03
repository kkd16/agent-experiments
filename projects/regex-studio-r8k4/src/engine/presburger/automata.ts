// The digit-automata the Presburger decision procedure runs on. Everything is a
// `BitDFA` over the alphabet {0,1}^k (one *track* per variable) — reusing the
// studio's own bit-automaton algebra (product / union / complement / projection
// / determinisation / minimisation) with the letter alphabet degenerated to a
// single symbol (`sigma = 1`), so a symbol is a pure **digit column**: bit i is
// the current binary digit of variable i. Words are read **least-significant
// digit first** and encode a tuple of naturals.
//
// The key invariant every automaton here maintains is *all-or-none*: for each
// tuple of naturals, either **every** encoding (any amount of leading-zero
// padding) is accepted, or none is. That is exactly what makes ∧/∨/¬ and
// projection sound — the acceptance of a word depends only on the tuple it
// decodes to. Atoms are all-or-none by construction; ∩/∪/¬ preserve it; and a
// projection is closed back up by **0-saturation** (a state is accepting if a
// run of zero-columns from it reaches an accepting state — the padding closure).
//
// ── atomic constructions ──
//  Σ aᵢxᵢ = c   the carry automaton: state = the residual target, halved each
//               digit (start c; on column d, next = (state−d)/2 when even, else
//               reject; accept at 0). Finitely many reachable states because the
//               target stays within ±Σ|aᵢ|.
//  Σ aᵢxᵢ ≤ c   the same halving with a floor and accept at state ≥ 0.
//  Σ aᵢxᵢ ≡ r   state = (running value mod m, 2ʲ mod m): acc' = acc + d·2ʲ,
//     (mod m)   accept when acc ≡ r; ≤ m² states, works for every modulus.

import {
  type BitDFA,
  type Track,
  LogicError,
  MAX_STATES,
  complementDFA,
} from '../logic/bitaut';
import type { GraphInput } from '../layout';
import { CharSet } from '../charset';
import type { DFA, DFAState, DFATransition, Atom } from '../dfa';
import { pruneCoef } from './ast';

const MAX_TRACKS = 14;

function digitTracks(names: string[]): Track[] {
  return names.map((name) => ({ name, so: false }));
}

// A constant automaton over zero tracks (⊤ / ⊥) — the value of a variable-free
// atom like `3 = 3` or `0 ≡ 1 (mod 2)`.
export function atomConst(value: boolean): BitDFA {
  return { sigma: 1, tracks: [], n: 1, start: 0, accept: [value], trans: [[0]] };
}

interface AtomSpec {
  names: string[]; // sorted variable names → tracks
  coef: number[]; // coefficient per track (aligned to `names`)
  start: number; // initial integer state
  step: (state: number, d: number) => number | null; // null = reject sink
  accept: (state: number) => boolean;
}

// BFS the (integer) state space of an atom into a partial BitDFA.
function buildAtom(spec: AtomSpec): BitDFA {
  const names = spec.names;
  const k = names.length;
  if (k > MAX_TRACKS) throw new LogicError(`too many variables (${k})`);
  const tracks = digitTracks(names);
  const symCount = 1 << k;
  const dOf = new Array<number>(symCount);
  for (let bits = 0; bits < symCount; bits++) {
    let d = 0;
    for (let i = 0; i < k; i++) if ((bits >> i) & 1) d += spec.coef[i];
    dOf[bits] = d;
  }
  const index = new Map<number, number>();
  const order: number[] = [];
  const intern = (v: number): number => {
    let id = index.get(v);
    if (id === undefined) {
      id = order.length;
      index.set(v, id);
      order.push(v);
      if (order.length > MAX_STATES) throw new LogicError(`atom blew up past ${MAX_STATES} states`);
    }
    return id;
  };
  const startId = intern(spec.start);
  const trans: number[][] = [];
  const accept: boolean[] = [];
  for (let s = 0; s < order.length; s++) {
    const state = order[s];
    const row = new Array<number>(symCount);
    for (let bits = 0; bits < symCount; bits++) {
      const nx = spec.step(state, dOf[bits]);
      row[bits] = nx === null ? -1 : intern(nx);
    }
    trans.push(row);
    accept.push(spec.accept(state));
  }
  return { sigma: 1, tracks, n: order.length, start: startId, accept, trans };
}

function sortedCoef(coefMap: Record<string, number>): { names: string[]; coef: number[] } {
  const pruned = pruneCoef(coefMap);
  const names = Object.keys(pruned).sort();
  return { names, coef: names.map((n) => pruned[n]) };
}

// Σ aᵢxᵢ = c  or  Σ aᵢxᵢ ≤ c.
export function linAtom(coefMap: Record<string, number>, c: number, mode: 'eq' | 'le'): BitDFA {
  const { names, coef } = sortedCoef(coefMap);
  if (names.length === 0) return atomConst(mode === 'eq' ? c === 0 : c >= 0);
  if (mode === 'eq') {
    return buildAtom({
      names,
      coef,
      start: c,
      step: (state, d) => (((state - d) & 1) === 0 ? (state - d) >> 1 : null),
      accept: (state) => state === 0,
    });
  }
  return buildAtom({
    names,
    coef,
    start: c,
    step: (state, d) => (state - d) >> 1, // arithmetic shift = floor(÷2), correct for negatives
    accept: (state) => state >= 0,
  });
}

// Σ aᵢxᵢ ≡ r (mod m).
export function modAtom(coefMap: Record<string, number>, r: number, m: number): BitDFA {
  if (m <= 1) return atomConst(true);
  const { names, coef } = sortedCoef(coefMap);
  const rmod = ((r % m) + m) % m;
  if (names.length === 0) return atomConst(rmod === 0);
  return buildAtom({
    names,
    coef,
    start: 1, // acc = 0, p = 2⁰ mod m = 1  ⇒  state = acc·m + p = 1
    step: (state, d) => {
      const acc = Math.floor(state / m);
      const p = state - acc * m;
      const dm = ((d % m) + m) % m;
      const acc2 = (acc + dm * p) % m;
      const p2 = (2 * p) % m;
      return acc2 * m + p2;
    },
    accept: (state) => Math.floor(state / m) === rmod,
  });
}

function negateCoef(coefMap: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [v, k] of Object.entries(coefMap)) out[v] = -k;
  return out;
}

// Σ aᵢxᵢ  OP  c, for every comparison operator.
export function cmpAtom(op: string, coefMap: Record<string, number>, c: number): BitDFA {
  switch (op) {
    case '=':
      return linAtom(coefMap, c, 'eq');
    case '<=':
      return linAtom(coefMap, c, 'le');
    case '<':
      return linAtom(coefMap, c - 1, 'le');
    case '>=':
      return linAtom(negateCoef(coefMap), -c, 'le'); // Σ ≥ c ⟺ −Σ ≤ −c
    case '>':
      return linAtom(negateCoef(coefMap), -c - 1, 'le'); // Σ ≥ c+1
    case '!=':
      return complementDFA(linAtom(coefMap, c, 'eq')); // every string is a valid encoding
    default:
      throw new LogicError(`unknown comparison operator ${op}`);
  }
}

// The padding closure: a state becomes accepting if a run of zero-columns from
// it reaches an accepting state. Applied after projection+determinisation to
// restore the all-or-none invariant (leading-zero padding of the shorter tracks).
export function zeroSaturate(a: BitDFA): BitDFA {
  const zeroPred: number[][] = Array.from({ length: a.n }, () => []);
  for (let s = 0; s < a.n; s++) {
    const t = a.trans[s][0]; // symbol 0 = the all-zero digit column
    if (t >= 0) zeroPred[t].push(s);
  }
  const accept = a.accept.slice();
  const queue: number[] = [];
  for (let s = 0; s < a.n; s++) if (accept[s]) queue.push(s);
  while (queue.length) {
    const s = queue.shift()!;
    for (const p of zeroPred[s]) {
      if (!accept[p]) {
        accept[p] = true;
        queue.push(p);
      }
    }
  }
  return { ...a, accept };
}

// ── running the automaton on a concrete tuple ─────────────────────────────────
function bitLength(v: number): number {
  let L = 0;
  while (1 << L <= v && L < 31) L++;
  return L;
}

// Does the automaton accept the tuple? Values are read off `dfa.tracks` (a var
// not among the tracks is a don't-care — the automaton doesn't constrain it).
export function acceptsTuple(dfa: BitDFA, valueByName: Record<string, number>): boolean {
  const tracks = dfa.tracks;
  const k = tracks.length;
  if (k === 0) return dfa.accept[dfa.start];
  const vals = tracks.map((t) => Math.max(0, Math.floor(valueByName[t.name] ?? 0)));
  let L = 0;
  for (const v of vals) L = Math.max(L, bitLength(v));
  let state = dfa.start;
  for (let j = 0; j < L; j++) {
    let bits = 0;
    for (let i = 0; i < k; i++) if ((vals[i] >> j) & 1) bits |= 1 << i;
    const t = dfa.trans[state][bits];
    if (t < 0) return false;
    state = t;
  }
  return dfa.accept[state];
}

export interface SolutionRow {
  tuple: number[]; // aligned to dfa.tracks
}

// Enumerate satisfying tuples with every coordinate in [0, maxValue], up to a
// limit. The automaton itself is the ground truth — this is decoding, not search.
export function enumerateSolutions(
  dfa: BitDFA,
  opts: { maxValue: number; limit: number },
): { rows: SolutionRow[]; tracks: string[]; truncated: boolean; scanned: number } {
  const trackNames = dfa.tracks.map((t) => t.name);
  const k = trackNames.length;
  if (k === 0) return { rows: [], tracks: trackNames, truncated: false, scanned: 0 };
  const span = opts.maxValue + 1;
  const rows: SolutionRow[] = [];
  const odometer = new Array<number>(k).fill(0);
  let scanned = 0;
  const cap = 60000;
  let truncated = false;
  for (;;) {
    scanned++;
    const valueByName: Record<string, number> = {};
    for (let i = 0; i < k; i++) valueByName[trackNames[i]] = odometer[i];
    if (acceptsTuple(dfa, valueByName)) {
      rows.push({ tuple: odometer.slice() });
      if (rows.length >= opts.limit) {
        truncated = true;
        break;
      }
    }
    if (scanned >= cap) {
      truncated = true;
      break;
    }
    // advance the odometer
    let i = 0;
    for (; i < k; i++) {
      odometer[i]++;
      if (odometer[i] < span) break;
      odometer[i] = 0;
    }
    if (i === k) break; // wrapped fully around
  }
  return { rows, tracks: trackNames, truncated, scanned };
}

// ── graph rendering (over the digit alphabet) ─────────────────────────────────
export function columnLabel(tracks: Track[], bits: number): string {
  if (tracks.length === 0) return '·';
  return tracks.map((t, i) => `${t.name}${(bits >> i) & 1}`).join(' ');
}

// Lower a **single-track** digit automaton into the studio's own `DFA` over the
// two-letter alphabet {'0','1'} — so the set of least-significant-digit-first
// binary encodings of {x : φ(x)} flows into the studio's DFA→regex synthesiser,
// census and syntactic-monoid machinery. (The digit column carries one bit, so
// the two symbols map straight to the characters '0' and '1'.)
export function lowerSingleTrackToDFA(bit: BitDFA): DFA {
  if (bit.tracks.length !== 1) throw new LogicError('lowerSingleTrackToDFA: not a single-variable automaton');
  const codes = [48, 49]; // '0', '1' — bit value == symbol index (sigma = 1)
  const atoms: Atom[] = codes.map((code) => ({ set: CharSet.fromChar(code), lo: code, hi: code }));
  const states: DFAState[] = bit.accept.map((acc, id) => ({ id, nfaStates: [id], accept: acc }));
  const table: number[][] = [];
  for (let s = 0; s < bit.n; s++) {
    const row = new Array<number>(atoms.length).fill(-1);
    for (let digit = 0; digit < 2; digit++) {
      const t = bit.trans[s][digit];
      if (t >= 0) row[digit] = t;
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

export function presburgerDfaToGraph(bit: BitDFA): GraphInput {
  const nodes = Array.from({ length: bit.n }, (_, id) => ({ id, label: String(id) }));
  const edgeAccum = new Map<string, { from: number; to: number; labels: string[] }>();
  for (let from = 0; from < bit.n; from++) {
    const row = bit.trans[from];
    for (let sym = 0; sym < row.length; sym++) {
      const to = row[sym];
      if (to < 0) continue;
      const key = `${from}->${to}`;
      const acc = edgeAccum.get(key) ?? { from, to, labels: [] };
      acc.labels.push(columnLabel(bit.tracks, sym));
      edgeAccum.set(key, acc);
    }
  }
  const edges = [...edgeAccum.values()].map((e) => {
    let label = e.labels.join(', ');
    if (label.length > 40) label = e.labels.slice(0, 3).join(', ') + ` …(${e.labels.length})`;
    return { from: e.from, to: e.to, label, epsilon: false };
  });
  return {
    nodes,
    edges,
    start: bit.start,
    accepts: new Set(bit.accept.map((a, i) => (a ? i : -1)).filter((i) => i >= 0)),
  };
}
