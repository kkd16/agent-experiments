// The bit-automaton — the machine the Büchi–Elgot–Trakhtenbrot construction runs on.
//
// An MSO formula with free variables V is compiled into an automaton that reads
// words over the *product alphabet* Σ × {0,1}^V: at each position you read the
// letter, plus one bit per free variable saying "is this the position equal to
// the first-order variable x" / "does this position lie in the second-order set
// X". A satisfying assignment of the variables to a concrete word is exactly an
// accepting run of this automaton. Quantifying a variable away is *projection*
// (drop that bit-track and re-determinise); the boolean connectives are
// product / union / complement. Everything here is over that product alphabet.
//
// A *track* is one free variable in scope. A symbol over a track list of length
// k is an integer  sym = letter·2^k + bits,  letter ∈ [0,σ), bits ∈ [0,2^k).
//
// DFAs are kept *partial* (a -1 entry is the implicit reject/dead sink) to match
// the rest of the studio; operations that need a total transition function
// complete on the fly.

export interface Track {
  name: string;
  so: boolean; // second-order (set) variable? else first-order (position) variable
}

export class LogicError extends Error {}

export const MAX_STATES = 6000;
const MAX_TRACKS = 14;

// Canonical track order: by name. FO names are lowercase, SO uppercase, so a
// formula's `x` and `X` are distinct tracks that sort apart deterministically.
export function sortTracks(tracks: Track[]): Track[] {
  const seen = new Map<string, Track>();
  for (const t of tracks) if (!seen.has(t.name)) seen.set(t.name, t);
  return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function tracksEqual(a: Track[], b: Track[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].name !== b[i].name || a[i].so !== b[i].so) return false;
  return true;
}

export function unionTracks(a: Track[], b: Track[]): Track[] {
  return sortTracks([...a, ...b]);
}

export interface BitDFA {
  sigma: number;
  tracks: Track[];
  n: number;
  start: number;
  accept: boolean[];
  // trans[state][symbol] = next state, or -1 for the implicit dead sink.
  trans: number[][];
}

export interface BitNFA {
  sigma: number;
  tracks: Track[];
  n: number;
  starts: number[];
  accept: boolean[];
  edges: Map<number, number[]>[]; // edges[state]: symbol → list of next states
}

export function numSymbols(sigma: number, tracks: Track[]): number {
  if (tracks.length > MAX_TRACKS) throw new LogicError(`too many free variables (${tracks.length})`);
  return sigma * (1 << tracks.length);
}

export function bitIndex(tracks: Track[], name: string): number {
  return tracks.findIndex((t) => t.name === name);
}

// sym = letter·2^k + bits
export function encodeSym(tracks: Track[], letter: number, bits: number): number {
  return letter * (1 << tracks.length) + bits;
}
export function symLetter(tracks: Track[], sym: number): number {
  return sym >> tracks.length;
}
export function symBits(tracks: Track[], sym: number): number {
  return sym & ((1 << tracks.length) - 1);
}
export function getBit(bits: number, idx: number): number {
  return idx < 0 ? 0 : (bits >> idx) & 1;
}

// Build a DFA from a transition function over (state, letter, bits).
export function buildDFA(
  sigma: number,
  tracks: Track[],
  n: number,
  start: number,
  acceptSet: Set<number> | ((s: number) => boolean),
  delta: (state: number, letter: number, bits: number) => number,
): BitDFA {
  const ts = sortTracks(tracks);
  const k = ts.length;
  const sym = numSymbols(sigma, ts);
  const accFn = typeof acceptSet === 'function' ? acceptSet : (s: number) => acceptSet.has(s);
  const accept: boolean[] = [];
  const trans: number[][] = [];
  for (let s = 0; s < n; s++) {
    accept.push(accFn(s));
    const row = new Array<number>(sym);
    for (let l = 0; l < sigma; l++) {
      for (let b = 0; b < 1 << k; b++) {
        row[encodeSym(ts, l, b)] = delta(s, l, b);
      }
    }
    trans.push(row);
  }
  return { sigma, tracks: ts, n, start, accept, trans };
}

// Total transition: -1 maps to a fresh sink index n. Returns rows of length
// numSymbols over n+1 states with accept[n] = false.
function totalize(a: BitDFA): { trans: number[][]; accept: boolean[]; sink: number } {
  const sym = a.trans[0]?.length ?? numSymbols(a.sigma, a.tracks);
  const sink = a.n;
  const trans: number[][] = a.trans.map((row) => row.map((t) => (t < 0 ? sink : t)));
  trans.push(new Array<number>(sym).fill(sink));
  const accept = [...a.accept, false];
  return { trans, accept, sink };
}

// Keep only states reachable from start; -1 stays -1.
export function reachableTrim(a: BitDFA): BitDFA {
  const seen = new Map<number, number>();
  const order: number[] = [];
  const queue = [a.start];
  seen.set(a.start, 0);
  order.push(a.start);
  while (queue.length) {
    const s = queue.shift()!;
    for (const t of a.trans[s]) {
      if (t >= 0 && !seen.has(t)) {
        seen.set(t, order.length);
        order.push(t);
        queue.push(t);
      }
    }
  }
  const accept = order.map((s) => a.accept[s]);
  const trans = order.map((s) => a.trans[s].map((t) => (t < 0 ? -1 : seen.get(t)!)));
  return { sigma: a.sigma, tracks: a.tracks, n: order.length, start: 0, accept, trans };
}

// Moore minimisation over the symbol alphabet. Drops the dead trap (its
// transitions become -1), matching the partial DFAs the studio displays.
export function minimizeBitDFA(input: BitDFA): BitDFA {
  const a = reachableTrim(input);
  const { trans, accept, sink } = totalize(a);
  const total = a.n + 1;
  const symCount = trans[0].length;

  let block = new Int32Array(total);
  for (let s = 0; s < total; s++) block[s] = accept[s] ? 1 : 0;
  let blockCount = 2;
  for (;;) {
    const sigToId = new Map<string, number>();
    const nextBlock = new Int32Array(total);
    let count = 0;
    for (let s = 0; s < total; s++) {
      let sig = block[s] + '|';
      for (let c = 0; c < symCount; c++) sig += block[trans[s][c]] + ',';
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

  const deadBlock = block[sink];
  const startBlock = block[a.start];
  const keep: number[] = [];
  const seen = new Set<number>();
  const consider = (b: number) => {
    if (seen.has(b)) return;
    if (b === deadBlock && b !== startBlock) return;
    seen.add(b);
    keep.push(b);
  };
  consider(startBlock);
  for (let s = 0; s < total; s++) consider(block[s]);
  const newIndex = new Map<number, number>();
  keep.forEach((b, i) => newIndex.set(b, i));

  const repOf = new Map<number, number>();
  for (let s = 0; s < total; s++) if (!repOf.has(block[s])) repOf.set(block[s], s);

  const acceptOut = keep.map((b) => accept[repOf.get(b)!]);
  const transOut = keep.map((b) => {
    const rep = repOf.get(b)!;
    return trans[rep].map((t) => {
      const tb = block[t];
      if (tb === deadBlock || !newIndex.has(tb)) return -1;
      return newIndex.get(tb)!;
    });
  });
  return {
    sigma: a.sigma,
    tracks: a.tracks,
    n: keep.length,
    start: newIndex.get(startBlock) ?? 0,
    accept: acceptOut,
    trans: transOut,
  };
}

// Product over a shared alphabet (caller lifts to a common track set first).
// op: how to combine the two accept flags.
export function productDFA(a: BitDFA, b: BitDFA, op: (x: boolean, y: boolean) => boolean): BitDFA {
  if (!tracksEqual(a.tracks, b.tracks) || a.sigma !== b.sigma) {
    throw new LogicError('productDFA: operands must share an alphabet');
  }
  const ta = totalize(a);
  const tb = totalize(b);
  const symCount = ta.trans[0].length;
  const index = new Map<number, number>();
  const states: [number, number][] = [];
  const key = (x: number, y: number) => x * (b.n + 1) + y;
  const intern = (x: number, y: number): number => {
    const kk = key(x, y);
    let id = index.get(kk);
    if (id === undefined) {
      id = states.length;
      index.set(kk, id);
      states.push([x, y]);
      if (states.length > MAX_STATES) throw new LogicError(`product blew up past ${MAX_STATES} states`);
    }
    return id;
  };
  const start = intern(a.start, b.start);
  const trans: number[][] = [];
  for (let i = 0; i < states.length; i++) {
    const [x, y] = states[i];
    const row = new Array<number>(symCount);
    for (let c = 0; c < symCount; c++) row[c] = intern(ta.trans[x][c], tb.trans[y][c]);
    trans.push(row);
  }
  const accept = states.map(([x, y]) => op(ta.accept[x], tb.accept[y]));
  return reachableTrim({ sigma: a.sigma, tracks: a.tracks, n: states.length, start, accept, trans });
}

export function intersectDFA(a: BitDFA, b: BitDFA): BitDFA {
  return productDFA(a, b, (x, y) => x && y);
}
export function unionDFA(a: BitDFA, b: BitDFA): BitDFA {
  return productDFA(a, b, (x, y) => x || y);
}

// Raw complement over the full product alphabet (Σ×{0,1}^tracks)*: complete with
// a sink, flip every accept flag. To complement *within the valid encodings*
// (every FO track a singleton) the caller intersects this with the validity DFA.
export function complementDFA(a: BitDFA): BitDFA {
  const { trans, accept } = totalize(a);
  return reachableTrim({
    sigma: a.sigma,
    tracks: a.tracks,
    n: trans.length,
    start: a.start,
    accept: accept.map((x) => !x),
    trans,
  });
}

// Cylindrify a DFA onto a *larger* (superset) track list — the new tracks are
// free (don't-care). States and accept are unchanged; only the alphabet grows.
export function liftDFA(a: BitDFA, target: Track[]): BitDFA {
  const tgt = sortTracks(target);
  if (tracksEqual(a.tracks, tgt)) return a;
  // position of each of a's tracks within the target bit layout
  const pos = a.tracks.map((t) => {
    const idx = bitIndex(tgt, t.name);
    if (idx < 0) throw new LogicError(`liftDFA: target missing track ${t.name}`);
    return idx;
  });
  const k = tgt.length;
  const sym = numSymbols(a.sigma, tgt);
  const trans: number[][] = [];
  for (let s = 0; s < a.n; s++) {
    const row = new Array<number>(sym);
    for (let l = 0; l < a.sigma; l++) {
      for (let b = 0; b < 1 << k; b++) {
        let aBits = 0;
        for (let i = 0; i < pos.length; i++) aBits |= ((b >> pos[i]) & 1) << i;
        row[encodeSym(tgt, l, b)] = a.trans[s][encodeSym(a.tracks, l, aBits)];
      }
    }
    trans.push(row);
  }
  return { sigma: a.sigma, tracks: tgt, n: a.n, start: a.start, accept: a.accept.slice(), trans };
}

// Project a track away: drop its bit, yielding a (generally) non-deterministic
// automaton (two symbols that differed only in the dropped bit now coincide).
export function projectToNFA(a: BitDFA, name: string): BitNFA {
  const idx = bitIndex(a.tracks, name);
  if (idx < 0) throw new LogicError(`projectToNFA: no track ${name}`);
  const newTracks = a.tracks.filter((t) => t.name !== name);
  const k = a.tracks.length;
  const edges: Map<number, number[]>[] = [];
  for (let s = 0; s < a.n; s++) {
    const m = new Map<number, number[]>();
    for (let l = 0; l < a.sigma; l++) {
      for (let b = 0; b < 1 << k; b++) {
        const t = a.trans[s][encodeSym(a.tracks, l, b)];
        if (t < 0) continue;
        // bits with `idx` removed, lower bits kept, higher bits shifted down
        const low = b & ((1 << idx) - 1);
        const high = (b >> (idx + 1)) << idx;
        const nb = low | high;
        const nsym = encodeSym(newTracks, l, nb);
        const arr = m.get(nsym);
        if (arr) {
          if (!arr.includes(t)) arr.push(t);
        } else m.set(nsym, [t]);
      }
    }
    edges.push(m);
  }
  return { sigma: a.sigma, tracks: newTracks, n: a.n, starts: [a.start], accept: a.accept.slice(), edges };
}

// Subset construction: BitNFA → BitDFA.
export function determinize(nfa: BitNFA): BitDFA {
  const symCount = numSymbols(nfa.sigma, nfa.tracks);
  const index = new Map<string, number>();
  const subsets: number[][] = [];
  const key = (set: number[]) => set.join(',');
  const intern = (raw: number[]): number => {
    const set = [...new Set(raw)].sort((x, y) => x - y);
    const kk = key(set);
    let id = index.get(kk);
    if (id === undefined) {
      id = subsets.length;
      index.set(kk, id);
      subsets.push(set);
      if (subsets.length > MAX_STATES) throw new LogicError(`determinisation blew up past ${MAX_STATES} states`);
    }
    return id;
  };
  const start = intern(nfa.starts);
  const trans: number[][] = [];
  for (let i = 0; i < subsets.length; i++) {
    const set = subsets[i];
    const row = new Array<number>(symCount);
    for (let c = 0; c < symCount; c++) {
      const next: number[] = [];
      for (const s of set) {
        const arr = nfa.edges[s].get(c);
        if (arr) for (const t of arr) next.push(t);
      }
      row[c] = next.length ? intern(next) : -1;
    }
    trans.push(row);
  }
  const accept = subsets.map((set) => set.some((s) => nfa.accept[s]));
  return { sigma: nfa.sigma, tracks: nfa.tracks, n: subsets.length, start, accept, trans };
}

// A shortest accepted *encoding* (list of symbols), or null if the language is
// empty. Used both for emptiness and to surface witnesses in the UI.
export function witness(a: BitDFA): number[] | null {
  const prev = new Map<number, { from: number; sym: number }>();
  const queue = [a.start];
  const seen = new Set<number>([a.start]);
  if (a.accept[a.start]) return [];
  while (queue.length) {
    const s = queue.shift()!;
    const row = a.trans[s];
    for (let c = 0; c < row.length; c++) {
      const t = row[c];
      if (t < 0 || seen.has(t)) continue;
      seen.add(t);
      prev.set(t, { from: s, sym: c });
      if (a.accept[t]) {
        const out: number[] = [];
        let cur = t;
        while (cur !== a.start) {
          const p = prev.get(cur)!;
          out.push(p.sym);
          cur = p.from;
        }
        return out.reverse();
      }
      queue.push(t);
    }
  }
  return null;
}

export function isEmpty(a: BitDFA): boolean {
  return witness(a) === null;
}

// Language equality (operands lifted to a common alphabet by the caller): no
// reachable product pair may disagree on acceptance.
export function languageEqual(a: BitDFA, b: BitDFA): boolean {
  if (!tracksEqual(a.tracks, b.tracks)) {
    const u = unionTracks(a.tracks, b.tracks);
    return languageEqual(liftDFA(a, u), liftDFA(b, u));
  }
  const diff = productDFA(a, b, (x, y) => x !== y);
  return isEmpty(diff);
}

export function dfaSize(a: BitDFA): number {
  return a.n;
}
