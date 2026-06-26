// Two-way deterministic finite automata (2DFA) — a SEVENTH road to the regular
// languages, and the studio's first machine whose head moves BOTH ways.
//
// A one-way DFA scans the tape left→right and never looks back. A *two-way* DFA
// may move its head left or right over a tape framed by end-markers `⊢ w ⊣`, so
// it can re-scan the input as many times as it likes. The Rabin–Scott /
// Shepherdson theorem (1959) says this buys it *nothing in power* — every 2DFA
// recognises a regular language — yet it can be exponentially more *succinct*.
//
// The witness of that theorem is a construction, and it is the heart of this
// file: `construct` turns a 2DFA into an equivalent one-way DFA by Shepherdson's
// **transition-profile** (a.k.a. crossing-sequence) method. The one-way machine
// scans `w` once; its state after a prefix `u` is the *behaviour table* of `⊢u`
// — a finite summary of everything the two-way head could do while confined to
// that prefix. Two prefixes inducing the same table are Myhill–Nerode
// indistinguishable, so the table set is finite and the construction terminates.
//
// Everything here is cross-checked, the house way, against a trivially-correct
// oracle: `simulate` runs the real two-way head step by step (with exact loop
// detection), and the fuzzer in `twoway-verify.ts` confronts it with `construct`
// on thousands of random machines × words. `liftDFA` embeds any one-way DFA as a
// right-only 2DFA, so `construct(liftDFA(D))` round-trips back to `D`.

import { CharSet } from './charset';
import type { Atom, DFA, DFAState, DFATransition } from './dfa';
import type { GraphInput } from './layout';

export type Dir = 'L' | 'R';

/** The left and right tape end-markers. A well-formed machine moves Right on ⊢
 *  and never Right off ⊣; `simulate`/`construct` treat violations as a reject,
 *  so a malformed machine still has a well-defined (if dull) language. */
export const LEND = '⊢';
export const REND = '⊣';

export interface Move {
  to: number; // destination state id
  dir: Dir;
}

/** A two-way DFA over a small concrete alphabet. `accept`/`reject` are halting
 *  states (no outgoing moves). The transition function is total on every other
 *  state for every tape symbol in `alphabet ∪ {⊢, ⊣}`; a missing entry is read
 *  as an immediate reject. */
export interface TwoWayDFA {
  name: string;
  note?: string;
  states: string[]; // state names; index = id
  start: number;
  accept: number;
  reject: number;
  alphabet: string[]; // input symbols, each a single code point (no markers)
  delta: Map<string, Move>[]; // delta[stateId]: tape symbol → move
}

// ── Building helpers ────────────────────────────────────────────────────────

/** A compact authoring row: `[fromName, symbol, toName, dir]`. */
export type Rule = [string, string, string, Dir];

export interface MachineSpec {
  name: string;
  note?: string;
  states: string[]; // must include the accept/reject names
  start: string;
  accept: string;
  reject: string;
  alphabet: string[];
  rules: Rule[];
}

export function buildMachine(spec: MachineSpec): TwoWayDFA {
  const idOf = new Map<string, number>();
  spec.states.forEach((s, i) => idOf.set(s, i));
  const need = (n: string): number => {
    const id = idOf.get(n);
    if (id === undefined) throw new Error(`unknown state ${n} in machine ${spec.name}`);
    return id;
  };
  const delta: Map<string, Move>[] = spec.states.map(() => new Map());
  for (const [from, sym, to, dir] of spec.rules) {
    delta[need(from)].set(sym, { to: need(to), dir });
  }
  return {
    name: spec.name,
    note: spec.note,
    states: spec.states.slice(),
    start: need(spec.start),
    accept: need(spec.accept),
    reject: need(spec.reject),
    alphabet: spec.alphabet.slice(),
    delta,
  };
}

// ── Direct simulation: the trivially-correct oracle ─────────────────────────

export interface Config {
  pos: number; // 0 = ⊢, n+1 = ⊣, 1..n = w[pos-1]
  state: number;
}

export type SimReason = 'accept' | 'reject' | 'loop';

export interface SimResult {
  accept: boolean;
  halted: boolean; // false ⇒ the run looped (and so rejects)
  reason: SimReason;
  steps: number;
  trace: Config[]; // the full configuration sequence (bounded by #configs)
}

/** Run the two-way head over `⊢ w ⊣` to a verdict. A deterministic machine
 *  either halts or repeats a configuration; we detect the repeat exactly with a
 *  visited set, so a looping machine is decided (it rejects) rather than hung. */
export function simulate(M: TwoWayDFA, word: string): SimResult {
  const n = word.length;
  const NS = M.states.length;
  const symAt = (pos: number): string => (pos === 0 ? LEND : pos === n + 1 ? REND : word[pos - 1]);

  let pos = 0;
  let state = M.start;
  let steps = 0;
  const trace: Config[] = [];
  const visited = new Uint8Array((n + 2) * NS);

  for (;;) {
    trace.push({ pos, state });
    if (state === M.accept) return { accept: true, halted: true, reason: 'accept', steps, trace };
    if (state === M.reject) return { accept: false, halted: true, reason: 'reject', steps, trace };

    const key = pos * NS + state;
    if (visited[key]) return { accept: false, halted: false, reason: 'loop', steps, trace };
    visited[key] = 1;

    const mv = M.delta[state].get(symAt(pos));
    if (!mv) return { accept: false, halted: true, reason: 'reject', steps, trace };

    let npos = pos + (mv.dir === 'R' ? 1 : -1);
    if (npos < 0) npos = 0; // clamp at ⊢ — the head cannot fall off the left
    if (npos > n + 1) {
      // fell off the right end of ⊣ — treat as a reject halt
      trace.push({ pos: n + 1, state: mv.to });
      return { accept: false, halted: true, reason: 'reject', steps, trace };
    }
    pos = npos;
    state = mv.to;
    steps++;
  }
}

export function accepts(M: TwoWayDFA, word: string): boolean {
  return simulate(M, word).accept;
}

// ── Crossing sequences ──────────────────────────────────────────────────────

export interface Crossing {
  state: number;
  dir: Dir; // the direction the head moved across this boundary
}

export interface BoundaryCrossings {
  boundary: number; // the gap between tape cell `boundary` and `boundary+1`
  crossings: Crossing[];
}

/** The crossing sequence at each tape boundary: the ordered list of states in
 *  which the head steps across that vertical line. By a classic argument two
 *  inputs with the same crossing sequence at a cut are interchangeable there —
 *  this is exactly the information `construct`'s behaviour table distils. */
export function crossingSequences(M: TwoWayDFA, word: string): BoundaryCrossings[] {
  const { trace } = simulate(M, word);
  const n = word.length;
  const out: BoundaryCrossings[] = [];
  for (let b = 0; b <= n; b++) out.push({ boundary: b, crossings: [] });
  for (let i = 0; i + 1 < trace.length; i++) {
    const a = trace[i].pos;
    const c = trace[i + 1].pos;
    if (c === a + 1) out[a].crossings.push({ state: trace[i + 1].state, dir: 'R' });
    else if (c === a - 1) out[c].crossings.push({ state: trace[i + 1].state, dir: 'L' });
    // c === a happens only on the left clamp — no boundary crossed.
  }
  return out;
}

// ── Shepherdson's transition-profile construction: 2DFA → DFA ───────────────
//
// A behaviour cell is either a real destination state (≥ 0) or one of three
// outcomes the head can reach inside a prefix: it accepts, rejects, or loops.

const ACC = -1;
const REJ = -2;
const LOOP = -3;
type Cell = number; // ≥0 state id, or ACC / REJ / LOOP

/**
 * The behaviour of one *fresh cell* holding `sym`, sitting just to the right of
 * a prefix whose behaviour table is `T`. Started reading that cell in state
 * `sState`, the head may move R (exiting right of the cell → return that state),
 * move L into the prefix (consult `T`, re-emerge, re-read the cell), or halt.
 * `T[q]` answers "enter the prefix from the right in state q — where do you come
 * back out?". Re-reading the same state at this cell twice ⇒ an infinite loop.
 */
function crossCell(M: TwoWayDFA, sym: string, T: Int32Array, sState: Cell): Cell {
  if (sState < 0) return sState; // already absorbed (ACC/REJ/LOOP)
  const NS = M.states.length;
  const seen = new Uint8Array(NS);
  let cur = sState;
  for (;;) {
    if (cur < 0) return cur;
    if (cur === M.accept) return ACC;
    if (cur === M.reject) return REJ;
    if (seen[cur]) return LOOP;
    seen[cur] = 1;
    const mv = M.delta[cur].get(sym);
    if (!mv) return REJ;
    if (mv.to === M.accept) return ACC;
    if (mv.to === M.reject) return REJ;
    if (mv.dir === 'R') return mv.to; // exits right of this cell
    cur = T[mv.to]; // dip left into the prefix, re-emerge in T[mv.to]
  }
}

/** The behaviour of the empty prefix `⊢` for one entry state (no cells to its
 *  left, so a Left move clamps and re-reads ⊢). */
function baseCell(M: TwoWayDFA, q: number): Cell {
  const NS = M.states.length;
  const seen = new Uint8Array(NS);
  let cur: Cell = q;
  for (;;) {
    if (cur === M.accept) return ACC;
    if (cur === M.reject) return REJ;
    if (cur < 0) return cur;
    if (seen[cur]) return LOOP;
    seen[cur] = 1;
    const mv = M.delta[cur].get(LEND);
    if (!mv) return REJ;
    if (mv.to === M.accept) return ACC;
    if (mv.to === M.reject) return REJ;
    if (mv.dir === 'R') return mv.to; // exits right of ⊢
    cur = mv.to; // Left on ⊢ clamps: stay, re-read ⊢ in mv.to
  }
}

/** The behaviour table of the empty prefix `⊢`. */
function baseTable(M: TwoWayDFA): Int32Array {
  const NS = M.states.length;
  const T = new Int32Array(NS);
  for (let q = 0; q < NS; q++) T[q] = baseCell(M, q);
  return T;
}

/** Does the machine accept once the tape ends — i.e. the head reaches the right
 *  of the full word in state `s`, then reads `⊣` (dipping back into `w` via the
 *  word's table `T` as needed)? This is a pure function of the DFA state. */
function finalRun(M: TwoWayDFA, s: Cell, T: Int32Array): Cell {
  if (s === ACC) return ACC;
  if (s < 0) return REJ; // REJ or LOOP
  const NS = M.states.length;
  const seen = new Uint8Array(NS);
  let cur: Cell = s;
  for (;;) {
    if (cur === ACC) return ACC;
    if (cur < 0) return REJ;
    if (cur === M.accept) return ACC;
    if (cur === M.reject) return REJ;
    if (seen[cur]) return REJ; // a loop at the end rejects
    seen[cur] = 1;
    const mv = M.delta[cur].get(REND);
    if (!mv) return REJ;
    if (mv.to === M.accept) return ACC;
    if (mv.to === M.reject) return REJ;
    if (mv.dir === 'R') return REJ; // ran off the right end without accepting
    cur = T[mv.to]; // dip back into the word
  }
}

export interface ConstructResult {
  dfa: DFA;
  /** True if the construction was capped before completing (machine too big). */
  truncated: boolean;
  /** Number of two-way states (incl. accept/reject). */
  machineStates: number;
  /** Human-readable label for each constructed DFA state. */
  stateLabels: string[];
}

const DEFAULT_MAX_DFA_STATES = 4096;

/**
 * Shepherdson's construction: the equivalent one-way DFA. A DFA state is a
 * `(behaviour table T, crossing state s)` pair, where `T` summarises the prefix
 * read so far and `s` is the state in which the *real* run (started at ⊢ in q0)
 * first crosses the right edge of that prefix. Reading a symbol `a` advances
 * both with the same primitive `crossCell(·, a, T)`. Acceptance of a state is
 * decided by `finalRun` (what happens if ⊣ comes now). Absorbing outcomes
 * collapse to a shared accepting sink or the implicit dead sink (table −1).
 */
export function construct(M: TwoWayDFA, maxStates = DEFAULT_MAX_DFA_STATES): ConstructResult {
  const NS = M.states.length;
  const atoms: Atom[] = M.alphabet.map((ch) => {
    const code = ch.codePointAt(0)!;
    return { set: CharSet.fromChar(code), lo: code, hi: code };
  });
  const nAtoms = atoms.length;

  const states: DFAState[] = [];
  const table: Int32Array[] = [];
  const transitions: DFATransition[] = [];
  const stateLabels: string[] = [];
  const idOf = new Map<string, number>();

  // Lazily-created shared sinks.
  let acceptSink = -1;
  let deadId = -1; // an explicit non-accepting dead state, only if needed as start
  const ensureAcceptSink = (): number => {
    if (acceptSink >= 0) return acceptSink;
    acceptSink = states.length;
    states.push({ id: acceptSink, nfaStates: [], accept: true });
    table.push(new Int32Array(nAtoms).fill(acceptSink));
    stateLabels.push('⊤ (accepted)');
    for (let a = 0; a < nAtoms; a++) transitions.push({ from: acceptSink, to: acceptSink, set: atoms[a].set });
    return acceptSink;
  };
  const ensureDead = (): number => {
    if (deadId >= 0) return deadId;
    deadId = states.length;
    states.push({ id: deadId, nfaStates: [], accept: false });
    table.push(new Int32Array(nAtoms).fill(-1));
    stateLabels.push('⊥ (rejected)');
    return deadId;
  };

  const labelFor = (T: Int32Array, s: number): string => {
    const cell = (c: Cell): string => (c === ACC ? '⊤' : c === REJ ? '⊥' : c === LOOP ? '∞' : M.states[c]);
    return `s=${cell(s)} · [${Array.from(T, cell).join(',')}]`;
  };

  type Pending = { id: number; T: Int32Array; s: number };
  const queue: Pending[] = [];
  let truncated = false;

  const liveId = (T: Int32Array, s: number): number => {
    const key = `${s}|${T.join(',')}`;
    const got = idOf.get(key);
    if (got !== undefined) return got;
    if (states.length >= maxStates) {
      truncated = true;
      return ensureDead();
    }
    const id = states.length;
    states.push({ id, nfaStates: [], accept: finalRun(M, s, T) === ACC });
    table.push(new Int32Array(nAtoms).fill(-1));
    stateLabels.push(labelFor(T, s));
    idOf.set(key, id);
    queue.push({ id, T, s });
    return id;
  };

  // The start state from the empty prefix `⊢`.
  const Teps = baseTable(M);
  const sEps = Teps[M.start];
  let start: number;
  if (sEps === ACC) start = ensureAcceptSink();
  else if (sEps < 0) start = ensureDead(); // rejects/loops before reading anything
  else start = liveId(Teps, sEps);

  while (queue.length) {
    const { id, T, s } = queue.shift()!;
    if (truncated) break;
    // Merge equal targets into one labelled edge for a cleaner graph.
    const byTarget = new Map<number, number[]>();
    for (let a = 0; a < nAtoms; a++) {
      const sym = M.alphabet[a];
      const news = crossCell(M, sym, T, s);
      let target: number;
      if (news === ACC) target = ensureAcceptSink();
      else if (news < 0) target = -1; // dead — leave the table at −1
      else {
        const newT = new Int32Array(NS);
        for (let q = 0; q < NS; q++) newT[q] = crossCell(M, sym, T, q);
        target = liveId(newT, news);
      }
      table[id][a] = target;
      if (target >= 0) {
        const list = byTarget.get(target);
        if (list) list.push(a);
        else byTarget.set(target, [a]);
      }
    }
    for (const [to, atomIdxs] of byTarget) {
      transitions.push({ from: id, to, set: CharSet.union(atomIdxs.map((a) => atoms[a].set)) });
    }
  }

  return {
    dfa: { start, states, transitions, atoms, table },
    truncated,
    machineStates: NS,
    stateLabels,
  };
}

// ── DFA → 2DFA: the trivial right-only embedding ────────────────────────────

/** Whether a DFA's alphabet is a set of single code points (so it can be lifted
 *  into a 2DFA over a concrete character alphabet without losing range info). */
export function isSingletonAlphabet(dfa: DFA): boolean {
  return dfa.atoms.every((a) => a.lo === a.hi);
}

/**
 * Embed a one-way DFA as a right-only 2DFA: it only ever moves Right, reads each
 * symbol once, and decides at `⊣`. `construct(liftDFA(D)) ≡ D`, which the
 * Compare road verifies — the round trip that proves both directions of
 * Shepherdson's theorem on a single machine.
 */
export function liftDFA(dfa: DFA, name = 'lifted DFA'): TwoWayDFA {
  if (!isSingletonAlphabet(dfa))
    throw new Error('liftDFA needs a single-character alphabet');
  const alphabet = dfa.atoms.map((a) => String.fromCodePoint(a.lo));
  const names = dfa.states.map((s) => `d${s.id}`);
  const ACC_NAME = 'acc';
  const REJ_NAME = 'rej';
  const states = [...names, ACC_NAME, REJ_NAME];
  const acc = states.length - 2;
  const rej = states.length - 1;
  const delta: Map<string, Move>[] = states.map(() => new Map());
  // The head starts on ⊢ in dfa.start. Reading ⊢ just advances Right (staying in
  // the same state), so the first real symbol is read in dfa.start. Each symbol
  // takes the DFA transition (moving Right, one pass). At ⊣ we accept iff the
  // reached DFA state is accepting.
  for (let q = 0; q < dfa.states.length; q++) {
    delta[q].set(LEND, { to: q, dir: 'R' });
    for (let a = 0; a < dfa.atoms.length; a++) {
      const t = dfa.table[q][a];
      delta[q].set(alphabet[a], { to: t < 0 ? rej : t, dir: 'R' });
    }
    delta[q].set(REND, { to: dfa.states[q].accept ? acc : rej, dir: 'L' });
  }
  return { name, states, start: dfa.start, accept: acc, reject: rej, alphabet, delta };
}

// ── A gallery of hand-built two-way machines ────────────────────────────────

export interface GalleryEntry {
  machine: TwoWayDFA;
  /** Inputs to seed the animation with. */
  samples: string[];
}

// 1. "first character equals last character" over {a,b}. The head reads the
//    first letter, sweeps Right to ⊣, steps Left, and checks the last letter —
//    a genuinely two-way scan (out and back).
const firstEqLast = buildMachine({
  name: 'first = last',
  note: 'Reads w[0], runs to the right end, steps back one cell and checks the last letter matches. Empty and length-1 words accept vacuously. A clean there-and-back two-way scan.',
  states: ['start', 'sawA', 'sawB', 'chkA', 'chkB', 'acc', 'rej'],
  start: 'start',
  accept: 'acc',
  reject: 'rej',
  alphabet: ['a', 'b'],
  rules: [
    ['start', LEND, 'start', 'R'],
    ['start', 'a', 'sawA', 'R'],
    ['start', 'b', 'sawB', 'R'],
    ['start', REND, 'acc', 'L'], // empty word: vacuously true
    // remember the first letter, sweep to ⊣
    ['sawA', 'a', 'sawA', 'R'],
    ['sawA', 'b', 'sawA', 'R'],
    ['sawA', REND, 'chkA', 'L'],
    ['sawB', 'a', 'sawB', 'R'],
    ['sawB', 'b', 'sawB', 'R'],
    ['sawB', REND, 'chkB', 'L'],
    // now reading the last letter
    ['chkA', 'a', 'acc', 'L'],
    ['chkA', 'b', 'rej', 'L'],
    ['chkA', LEND, 'acc', 'R'], // length 1: first == last
    ['chkB', 'b', 'acc', 'L'],
    ['chkB', 'a', 'rej', 'L'],
    ['chkB', LEND, 'acc', 'R'],
  ],
});

// 2. "even number of a's AND even number of b's" by TWO passes. Pass one counts
//    a-parity left→right; a full Right-to-Left rewind to ⊢ carries that parity;
//    pass two counts b-parity. The rewind sweep is the two-way move.
const evenAevenB = buildMachine({
  name: 'even a, even b (two passes)',
  note: 'Pass 1 counts a-parity left→right; a full leftward rewind to ⊢ carries it; pass 2 counts b-parity, accepting iff both are even. A re-scan that a one-way DFA folds into one pass — here split in two to show the head sweep back.',
  states: ['a0', 'a1', 'rw0', 'rw1', 'b00', 'b10', 'b01', 'b11', 'acc', 'rej'],
  start: 'a0',
  accept: 'acc',
  reject: 'rej',
  alphabet: ['a', 'b'],
  rules: [
    ['a0', LEND, 'a0', 'R'],
    // pass 1: a-parity
    ['a0', 'a', 'a1', 'R'],
    ['a0', 'b', 'a0', 'R'],
    ['a1', 'a', 'a0', 'R'],
    ['a1', 'b', 'a1', 'R'],
    ['a0', REND, 'rw0', 'L'], // a-parity even → rewind carrying 0
    ['a1', REND, 'rw1', 'L'], // a-parity odd  → rewind carrying 1
    // rewind to ⊢ carrying a-parity in the state
    ['rw0', 'a', 'rw0', 'L'],
    ['rw0', 'b', 'rw0', 'L'],
    ['rw1', 'a', 'rw1', 'L'],
    ['rw1', 'b', 'rw1', 'L'],
    ['rw0', LEND, 'b00', 'R'], // start pass 2: (aPar=0, bPar=0)
    ['rw1', LEND, 'b10', 'R'], // (aPar=1, bPar=0)
    // pass 2: b-parity, remembering a-parity in the high bit
    ['b00', 'a', 'b00', 'R'],
    ['b00', 'b', 'b01', 'R'],
    ['b01', 'a', 'b01', 'R'],
    ['b01', 'b', 'b00', 'R'],
    ['b10', 'a', 'b10', 'R'],
    ['b10', 'b', 'b11', 'R'],
    ['b11', 'a', 'b11', 'R'],
    ['b11', 'b', 'b10', 'R'],
    // decide: accept iff aPar even (b0x) and bPar even (bx0)
    ['b00', REND, 'acc', 'L'],
    ['b01', REND, 'rej', 'L'],
    ['b10', REND, 'rej', 'L'],
    ['b11', REND, 'rej', 'L'],
  ],
});

// 3. "the letter just before the LAST b is a" — there is a b, and the cell
//    immediately to its left holds a. The head runs to ⊣, walks Left to the
//    first b it meets (= the last b), then steps Left once more to inspect its
//    predecessor. Two reversals of direction.
const beforeLastB = buildMachine({
  name: 'cell left of last b is a',
  note: 'Sweeps to the right end, walks left to the first b it meets (the LAST b of w), then steps left once more and checks that neighbour is a. Rejects if there is no b, or the last b is at position 0. A scan with two turns.',
  states: ['scan', 'back', 'chk', 'acc', 'rej'],
  start: 'scan',
  accept: 'acc',
  reject: 'rej',
  alphabet: ['a', 'b'],
  rules: [
    ['scan', LEND, 'scan', 'R'],
    ['scan', 'a', 'scan', 'R'],
    ['scan', 'b', 'scan', 'R'],
    ['scan', REND, 'back', 'L'], // reached the right end, turn around
    // walk left looking for the last b
    ['back', 'a', 'back', 'L'],
    ['back', 'b', 'chk', 'L'], // found the last b; step left to its neighbour
    ['back', LEND, 'rej', 'R'], // no b at all
    // inspect the cell left of the last b
    ['chk', 'a', 'acc', 'L'],
    ['chk', 'b', 'rej', 'L'],
    ['chk', LEND, 'rej', 'R'], // last b was at position 0 — nothing to its left
  ],
});

/** Adapt a 2DFA into the generic graph the layout engine consumes. Edges with
 *  the same endpoints merge, each labelled by its `symbol→direction` moves. */
export function twoWayToGraph(M: TwoWayDFA): GraphInput {
  const nodes = M.states.map((label, id) => ({ id, label }));
  const byPair = new Map<string, { from: number; to: number; labels: string[] }>();
  for (let q = 0; q < M.states.length; q++) {
    for (const [sym, mv] of M.delta[q]) {
      const key = `${q}->${mv.to}`;
      const e = byPair.get(key) ?? { from: q, to: mv.to, labels: [] };
      e.labels.push(`${sym}→${mv.dir}`);
      byPair.set(key, e);
    }
  }
  const edges = [...byPair.values()].map((e) => ({
    from: e.from,
    to: e.to,
    label: e.labels.join(', '),
    epsilon: false,
  }));
  return { nodes, edges, start: M.start, accepts: new Set([M.accept]) };
}

// 4. The textbook SUCCINCTNESS witness: "the n-th symbol from the RIGHT is a".
//    A two-way machine sweeps to ⊣ and walks back exactly n cells — O(n) states.
//    Any one-way DFA must remember the last n symbols to know which one will turn
//    out to be n-th from the end, so its minimal form has **2ⁿ** states. The gap
//    between `construct`'s output and a hand-count is the whole Sakoda–Sipser
//    point: two-way DFAs can be exponentially more succinct than one-way ones.
export function nthFromLast(n: number): TwoWayDFA {
  if (n < 1) throw new Error('n must be ≥ 1');
  const states = ['scan'];
  for (let k = 1; k <= n; k++) states.push(`look${k}`);
  states.push('acc', 'rej');
  const rules: Rule[] = [
    ['scan', LEND, 'scan', 'R'],
    ['scan', 'a', 'scan', 'R'],
    ['scan', 'b', 'scan', 'R'],
    ['scan', REND, 'look1', 'L'], // turn around onto the last (1st-from-right) cell
  ];
  for (let k = 1; k < n; k++) {
    // not yet the target cell — keep stepping left, counting
    rules.push([`look${k}`, 'a', `look${k + 1}`, 'L']);
    rules.push([`look${k}`, 'b', `look${k + 1}`, 'L']);
    rules.push([`look${k}`, LEND, 'rej', 'R']); // word shorter than n
  }
  // the n-th cell from the right — check it
  rules.push([`look${n}`, 'a', 'acc', 'L']);
  rules.push([`look${n}`, 'b', 'rej', 'L']);
  rules.push([`look${n}`, LEND, 'rej', 'R']); // word shorter than n
  return buildMachine({
    name: `n-th from right is a (n=${n})`,
    note: `Accepts iff the symbol n=${n} places from the right end is 'a'. The head sweeps to ⊣ and walks back ${n} cells — ${n + 3} states — while the minimal one-way DFA needs 2^${n} = ${2 ** n} states to remember the last ${n} symbols.`,
    states,
    start: 'scan',
    accept: 'acc',
    reject: 'rej',
    alphabet: ['a', 'b'],
    rules,
  });
}

export const GALLERY: GalleryEntry[] = [
  { machine: firstEqLast, samples: ['abba', 'abab', 'a', '', 'baab', 'abb'] },
  { machine: evenAevenB, samples: ['aabb', 'aab', 'abab', 'ab', '', 'aabbab'] },
  { machine: beforeLastB, samples: ['abba', 'aba', 'bba', 'aab', 'ab', 'ba'] },
  { machine: nthFromLast(2), samples: ['ab', 'ba', 'aa', 'bb', 'abab', 'bbab'] },
];
