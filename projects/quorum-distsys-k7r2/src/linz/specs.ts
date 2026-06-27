// Sequential specifications — the "ground truth" objects the checker linearizes
// a concurrent history against.
//
// A spec is a deterministic state machine: from a state, applying an operation
// yields a new state and the unique response that operation *must* return on a
// correct sequential object. The checker tries to find an ordering of the
// concurrent history whose every response matches its spec, so the only thing a
// spec has to be is correct and *pure* — `apply` never mutates its input state,
// because the search reuses a state across many backtracking branches.
import type { Rng } from '../sim/prng';
import type { Arg, Value } from './history';

export interface ApplyResult<S> {
  state: S;
  /** The response the spec dictates for this operation in this state. */
  out: Value;
}

/** How a generator can synthesize a random operation of a given call. */
export interface OpSig {
  f: string;
  /** 'mutator' changes state; 'observer' only reads it. */
  kind: 'mutator' | 'observer';
  /** Build a random argument (rng + the small value domain in use). */
  gen: (rng: Rng, domain: readonly string[]) => Arg;
}

export interface Spec<S> {
  id: string;
  name: string;
  blurb: string;
  ops: OpSig[];
  init(): S;
  /** Pure: returns a *new* state plus the mandated response. */
  apply(state: S, f: string, arg: Arg): ApplyResult<S>;
  /** A stable string key for memoizing equal model states. */
  hash(state: S): string;
  /** A short human-readable rendering of the state, for the witness table. */
  show(state: S): string;
}

// Erased view used by the generic checker (each concrete spec is registered as
// this; the checker only feeds back states it itself obtained, so erasure to
// `unknown` is sound).
export type AnySpec = Spec<unknown>;

const arg0 = () => undefined;
const pickDomain = (rng: Rng, domain: readonly string[]): Arg => rng.pick(domain) ?? domain[0];

// ---------------------------------------------------------------------------
// Read/write register (optionally with compare-and-swap).
// ---------------------------------------------------------------------------
const register: Spec<string> = {
  id: 'register',
  name: 'Read/Write/CAS register',
  blurb:
    'A single cell holding a value. write(v) overwrites it; read() returns it; cas(old,new) writes new only if the cell currently holds old, returning whether it succeeded.',
  ops: [
    { f: 'write', kind: 'mutator', gen: pickDomain },
    { f: 'read', kind: 'observer', gen: arg0 },
    {
      f: 'cas',
      kind: 'mutator',
      gen: (rng, domain) => [rng.pick(domain) ?? domain[0], rng.pick(domain) ?? domain[0]],
    },
  ],
  init: () => '',
  apply(state, f, arg) {
    switch (f) {
      case 'write':
        return { state: String(arg ?? ''), out: null };
      case 'read':
        return { state, out: state };
      case 'cas': {
        const [oldV, newV] = (arg as Value[]) ?? ['', ''];
        if (state === String(oldV ?? '')) return { state: String(newV ?? ''), out: true };
        return { state, out: false };
      }
      default:
        throw new Error(`register: unknown op ${f}`);
    }
  },
  hash: (s) => s,
  show: (s) => (s === '' ? '∅' : s),
};

// ---------------------------------------------------------------------------
// Integer counter.
// ---------------------------------------------------------------------------
const counter: Spec<number> = {
  id: 'counter',
  name: 'Counter',
  blurb: 'An integer with inc(), dec(), add(k) and read()→n. Famously NOT a CRDT here — a single linearizable counter, so read() must return the exact net of all increments ordered before it.',
  ops: [
    { f: 'inc', kind: 'mutator', gen: arg0 },
    { f: 'dec', kind: 'mutator', gen: arg0 },
    { f: 'read', kind: 'observer', gen: arg0 },
  ],
  init: () => 0,
  apply(state, f, arg) {
    switch (f) {
      case 'inc':
        return { state: state + 1, out: null };
      case 'dec':
        return { state: state - 1, out: null };
      case 'add':
        return { state: state + Number(arg ?? 0), out: null };
      case 'read':
        return { state, out: state };
      default:
        throw new Error(`counter: unknown op ${f}`);
    }
  },
  hash: (s) => String(s),
  show: (s) => String(s),
};

// ---------------------------------------------------------------------------
// Set of strings.
// ---------------------------------------------------------------------------
const setSpec: Spec<string[]> = {
  id: 'set',
  name: 'Set',
  blurb: 'A set of elements: add(x), remove(x), contains(x)→bool, read()→the sorted members. A linearizable set (not a CRDT) — contains() must reflect exactly the adds/removes ordered before it.',
  ops: [
    { f: 'add', kind: 'mutator', gen: pickDomain },
    { f: 'remove', kind: 'mutator', gen: pickDomain },
    { f: 'contains', kind: 'observer', gen: pickDomain },
  ],
  init: () => [],
  apply(state, f, arg) {
    const x = String(arg ?? '');
    switch (f) {
      case 'add':
        return state.includes(x) ? { state, out: null } : { state: [...state, x].sort(), out: null };
      case 'remove':
        return { state: state.filter((e) => e !== x), out: null };
      case 'contains':
        return { state, out: state.includes(x) };
      case 'read':
        return { state, out: state.join(',') };
      default:
        throw new Error(`set: unknown op ${f}`);
    }
  },
  hash: (s) => s.join(','),
  show: (s) => (s.length ? `{${s.join(',')}}` : '∅'),
};

// ---------------------------------------------------------------------------
// FIFO queue.
// ---------------------------------------------------------------------------
const queue: Spec<string[]> = {
  id: 'queue',
  name: 'FIFO queue',
  blurb: 'enq(x) appends; deq() removes and returns the oldest element, or ∅ if empty. The canonical example of an object that can be sequentially consistent yet NOT linearizable.',
  ops: [
    { f: 'enq', kind: 'mutator', gen: pickDomain },
    { f: 'deq', kind: 'observer', gen: arg0 },
  ],
  init: () => [],
  apply(state, f, arg) {
    switch (f) {
      case 'enq':
        return { state: [...state, String(arg ?? '')], out: null };
      case 'deq':
        if (state.length === 0) return { state, out: null };
        return { state: state.slice(1), out: state[0] };
      default:
        throw new Error(`queue: unknown op ${f}`);
    }
  },
  hash: (s) => s.join(','),
  show: (s) => (s.length ? `[${s.join(' ')}⟩` : '[]'),
};

// ---------------------------------------------------------------------------
// LIFO stack.
// ---------------------------------------------------------------------------
const stack: Spec<string[]> = {
  id: 'stack',
  name: 'LIFO stack',
  blurb: 'push(x) adds to the top; pop() removes and returns the most recent element, or ∅ if empty.',
  ops: [
    { f: 'push', kind: 'mutator', gen: pickDomain },
    { f: 'pop', kind: 'observer', gen: arg0 },
  ],
  init: () => [],
  apply(state, f, arg) {
    switch (f) {
      case 'push':
        return { state: [...state, String(arg ?? '')], out: null };
      case 'pop':
        if (state.length === 0) return { state, out: null };
        return { state: state.slice(0, -1), out: state[state.length - 1] };
      default:
        throw new Error(`stack: unknown op ${f}`);
    }
  },
  hash: (s) => s.join(','),
  show: (s) => (s.length ? `⟨${s.join(' ')}]` : '[]'),
};

// ---------------------------------------------------------------------------
// Try-lock (mutual exclusion).
// ---------------------------------------------------------------------------
const lock: Spec<boolean> = {
  id: 'lock',
  name: 'Try-lock',
  blurb: 'lock()→true if it acquired a free lock, false if it was already held; unlock() releases it. Linearizability forbids two successful lock()s without an unlock() between them.',
  ops: [
    { f: 'lock', kind: 'mutator', gen: arg0 },
    { f: 'unlock', kind: 'mutator', gen: arg0 },
  ],
  init: () => false,
  apply(state, f) {
    switch (f) {
      case 'lock':
        return state ? { state: true, out: false } : { state: true, out: true };
      case 'unlock':
        return { state: false, out: null };
      default:
        throw new Error(`lock: unknown op ${f}`);
    }
  },
  hash: (s) => (s ? '1' : '0'),
  show: (s) => (s ? 'held' : 'free'),
};

export const SPECS: Spec<unknown>[] = [
  register as Spec<unknown>,
  counter as Spec<unknown>,
  setSpec as Spec<unknown>,
  queue as Spec<unknown>,
  stack as Spec<unknown>,
  lock as Spec<unknown>,
];

export function specById(id: string): Spec<unknown> {
  const s = SPECS.find((x) => x.id === id);
  if (!s) throw new Error(`no spec '${id}'`);
  return s;
}
