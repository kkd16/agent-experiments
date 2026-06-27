// Curated textbook histories + seeded random generators.
//
// The curated set is the canon you'd draw on a whiteboard: the stale read that
// goes back in time, the Herlihy–Wing register, the FIFO queue that is
// sequentially consistent yet not linearizable, the lost CAS race. Each carries
// the verdict it *should* get, so the self-tests can assert the checker agrees.
//
// The generators synthesize histories at scale: `genLinearizable` builds a real
// concurrent history that is linearizable by construction (it is generated from a
// legal sequential schedule, then given overlapping real-time intervals that keep
// that schedule a valid witness), and `genAdversarial` corrupts one observed
// result so the history is provably *not* linearizable — both used to test the
// checker against the brute-force oracle by the thousand.
import { Rng } from '../sim/prng';
import type { History, Op, Value } from './history';
import { isLinearizable } from './checker';
import { specById, type Spec } from './specs';

let nextId = 0;
function mk(
  proc: string,
  f: string,
  arg: Value | Value[] | undefined,
  res: Value | undefined,
  call: number,
  ret: number,
): Op {
  return { id: nextId++, proc, f, arg, res, call, ret };
}

export interface Curated {
  id: string;
  spec: string;
  label: string;
  note: string;
  expected: boolean;
  history: History;
}

function hist(label: string, ops: Op[]): History {
  return { label, ops };
}

/** The hand-built gallery. Times are chosen so each precedence is deliberate. */
export function curatedHistories(): Curated[] {
  nextId = 0;
  return [
    // ---- register ----
    {
      id: 'reg-lz',
      spec: 'register',
      label: 'Register · concurrent read & write',
      note: 'The read overlaps the write, so it may legally be ordered before it and return the empty initial value. Linearizable.',
      expected: true,
      history: hist('Register · overlap', [
        mk('P', 'write', 'a', null, 0, 20),
        mk('Q', 'read', undefined, '', 5, 15),
      ]),
    },
    {
      id: 'reg-stale',
      spec: 'register',
      label: 'Register · stale read (time travel)',
      note: 'The write completes at t=20, the read starts at t=30 — yet the read returns the old value. No ordering respecting real time allows that. NOT linearizable.',
      expected: false,
      history: hist('Register · stale read', [
        mk('P', 'write', 'a', null, 0, 20),
        mk('Q', 'read', undefined, '', 30, 45),
      ]),
    },
    {
      id: 'reg-hw-ok',
      spec: 'register',
      label: 'Register · Herlihy–Wing (linearizable)',
      note: "Both reads overlap a long write. They don't overlap each other, but the earlier-returning read sees ∅ and the later sees 'a' — consistent with linearizing the write between them.",
      expected: true,
      history: hist('Register · HW ok', [
        mk('P', 'write', 'a', null, 0, 60),
        mk('Q', 'read', undefined, '', 10, 20),
        mk('R', 'read', undefined, 'a', 30, 40),
      ]),
    },
    {
      id: 'reg-hw-bad',
      spec: 'register',
      label: 'Register · Herlihy–Wing (not linearizable)',
      note: "The read that returns 'a' finishes before the read that returns ∅ begins. Once 'a' has been read, the value can never go back to ∅. NOT linearizable.",
      expected: false,
      history: hist('Register · HW bad', [
        mk('P', 'write', 'a', null, 0, 60),
        mk('Q', 'read', undefined, 'a', 10, 20),
        mk('R', 'read', undefined, '', 30, 40),
      ]),
    },
    {
      id: 'cas-race-ok',
      spec: 'register',
      label: 'CAS · one winner of a race',
      note: 'Two compare-and-swaps from ∅→a overlap; exactly one can succeed and the other must observe the change and fail. Linearizable.',
      expected: true,
      history: hist('CAS · race ok', [
        mk('P', 'cas', ['', 'a'], true, 0, 20),
        mk('Q', 'cas', ['', 'a'], false, 5, 25),
      ]),
    },
    {
      id: 'cas-race-bad',
      spec: 'register',
      label: 'CAS · two winners (impossible)',
      note: 'Both compare-and-swaps from ∅ claim success. Whichever is linearized first leaves the cell at a, so the other must fail. NOT linearizable.',
      expected: false,
      history: hist('CAS · race bad', [
        mk('P', 'cas', ['', 'a'], true, 0, 20),
        mk('Q', 'cas', ['', 'b'], true, 5, 25),
      ]),
    },

    // ---- counter ----
    {
      id: 'ctr-ok',
      spec: 'counter',
      label: 'Counter · two increments then read',
      note: 'Both increments finish before the read; the read returns 2. Linearizable.',
      expected: true,
      history: hist('Counter · ok', [
        mk('P', 'inc', undefined, null, 0, 10),
        mk('Q', 'inc', undefined, null, 5, 15),
        mk('R', 'read', undefined, 2, 20, 30),
      ]),
    },
    {
      id: 'ctr-bad',
      spec: 'counter',
      label: 'Counter · lost increment',
      note: 'Two increments complete before the read, but the read returns 1. A linearizable counter must count both. NOT linearizable.',
      expected: false,
      history: hist('Counter · bad', [
        mk('P', 'inc', undefined, null, 0, 10),
        mk('Q', 'inc', undefined, null, 20, 30),
        mk('R', 'read', undefined, 1, 40, 50),
      ]),
    },

    // ---- set ----
    {
      id: 'set-ok',
      spec: 'set',
      label: 'Set · add then contains',
      note: 'x is added (completing at t=10); a later contains(x) returns true. Linearizable.',
      expected: true,
      history: hist('Set · ok', [
        mk('P', 'add', 'x', null, 0, 10),
        mk('Q', 'contains', 'x', true, 20, 30),
      ]),
    },
    {
      id: 'set-bad',
      spec: 'set',
      label: 'Set · phantom miss',
      note: 'x was added and the add completed, yet a strictly-later contains(x) returns false. NOT linearizable.',
      expected: false,
      history: hist('Set · bad', [
        mk('P', 'add', 'x', null, 0, 10),
        mk('Q', 'contains', 'x', false, 20, 30),
      ]),
    },

    // ---- FIFO queue ----
    {
      id: 'queue-ok',
      spec: 'queue',
      label: 'Queue · FIFO order honoured',
      note: 'enq(x), deq()→x, enq(y), deq()→y — overlaps allow exactly this. Linearizable.',
      expected: true,
      history: hist('Queue · ok', [
        mk('P', 'enq', 'x', null, 0, 10),
        mk('Q', 'deq', undefined, 'x', 5, 20),
        mk('P', 'enq', 'y', null, 25, 35),
        mk('Q', 'deq', undefined, 'y', 40, 50),
      ]),
    },
    {
      id: 'queue-sc-not-lz',
      spec: 'queue',
      label: 'Queue · sequentially consistent, not linearizable',
      note: 'enq(x) finishes before enq(y) starts, so x is enqueued first. A dequeue after both must return x, but it returns y. The textbook history that is SC yet NOT linearizable.',
      expected: false,
      history: hist('Queue · SC not LZ', [
        mk('P', 'enq', 'x', null, 0, 10),
        mk('Q', 'enq', 'y', null, 20, 30),
        mk('P', 'deq', undefined, 'y', 40, 50),
      ]),
    },

    // ---- stack ----
    {
      id: 'stack-ok',
      spec: 'stack',
      label: 'Stack · LIFO order honoured',
      note: 'push(x), pop()→x, push(y), pop()→y under overlap. Linearizable.',
      expected: true,
      history: hist('Stack · ok', [
        mk('P', 'push', 'x', null, 0, 10),
        mk('Q', 'pop', undefined, 'x', 5, 20),
        mk('P', 'push', 'y', null, 25, 35),
        mk('Q', 'pop', undefined, 'y', 40, 50),
      ]),
    },
    {
      id: 'stack-bad',
      spec: 'stack',
      label: 'Stack · wrong element popped',
      note: 'x is pushed, then y is pushed (both complete), then a pop returns x. A LIFO stack must return the top, y. NOT linearizable.',
      expected: false,
      history: hist('Stack · bad', [
        mk('P', 'push', 'x', null, 0, 10),
        mk('Q', 'push', 'y', null, 20, 30),
        mk('P', 'pop', undefined, 'x', 40, 50),
      ]),
    },

    // ---- lock ----
    {
      id: 'lock-ok',
      spec: 'lock',
      label: 'Lock · acquire, release, acquire',
      note: 'P locks, P unlocks, then Q locks. Both acquisitions succeed because the lock was released in between. Linearizable.',
      expected: true,
      history: hist('Lock · ok', [
        mk('P', 'lock', undefined, true, 0, 10),
        mk('P', 'unlock', undefined, null, 12, 18),
        mk('Q', 'lock', undefined, true, 20, 30),
      ]),
    },
    {
      id: 'lock-bad',
      spec: 'lock',
      label: 'Lock · double acquire (mutual-exclusion break)',
      note: 'P acquires the lock and never releases it, yet Q also acquires it. Two holders at once — NOT linearizable.',
      expected: false,
      history: hist('Lock · bad', [
        mk('P', 'lock', undefined, true, 0, 10),
        mk('Q', 'lock', undefined, true, 20, 30),
      ]),
    },
  ];
}

// ---------------------------------------------------------------------------
// Random generators.
// ---------------------------------------------------------------------------

const DOMAIN = ['a', 'b', 'c', 'd', 'e'];

/**
 * A concurrent history that is linearizable by construction: generated from a
 * legal sequential schedule, then given overlapping real-time intervals whose
 * call-times increase in schedule order — so the schedule is always a valid,
 * real-time-respecting witness.
 */
export function genLinearizable(
  specId: string,
  seed: number,
  nOps: number,
  nProcs = 3,
  domainSize = 3,
): History {
  const spec = specById(specId);
  const rng = new Rng(seed * 2654435761);
  const domain = DOMAIN.slice(0, Math.max(1, domainSize));
  let state = spec.init();
  const ops: Op[] = [];
  let t = 0;
  for (let k = 0; k < nOps; k++) {
    const sig = rng.pick(spec.ops) ?? spec.ops[0];
    const arg = sig.gen(rng, domain);
    const r = spec.apply(state, sig.f, arg);
    const call = t;
    const ret = call + rng.int(8, 26);
    t += rng.int(2, 12); // the next op starts soon, creating overlaps
    ops.push({ id: k, proc: 'P' + rng.int(0, nProcs - 1), f: sig.f, arg, res: r.out, call, ret });
    state = r.state;
  }
  return { label: `random ${spec.name} · LZ · seed ${seed}`, ops };
}

function differentValue(res: Value, rng: Rng): Value {
  if (typeof res === 'boolean') return !res;
  if (typeof res === 'number') return res + (rng.chance(0.5) ? 1 : -1) * rng.int(1, 3);
  const choices = ['', ...DOMAIN, '∄'].filter((v) => v !== res);
  return rng.pick(choices) ?? res + '!';
}

/** Corrupt a random observed result, perturbing the history toward illegality. */
export function corrupt(history: History, seed: number): History {
  const rng = new Rng(seed * 40503 + 7);
  const observers = history.ops.filter((o) => o.res !== null && o.res !== undefined);
  if (observers.length === 0) return history;
  const victim = rng.pick(observers) ?? observers[0];
  const ops = history.ops.map((o) =>
    o.id === victim.id ? { ...o, res: differentValue(o.res as Value, rng) } : o,
  );
  return { label: history.label + ' (perturbed)', ops };
}

/**
 * A history that is provably NOT linearizable: a linearizable one with one result
 * corrupted, re-rolled until the corruption actually breaks linearizability.
 * Returns null if no breaking corruption was found within the attempts.
 */
export function genAdversarial(
  specId: string,
  seed: number,
  nOps: number,
  nProcs = 3,
): { history: History; victim: number } | null {
  const spec: Spec<unknown> = specById(specId);
  for (let attempt = 0; attempt < 24; attempt++) {
    const base = genLinearizable(specId, seed + attempt * 101, nOps, nProcs);
    const rng = new Rng((seed + attempt) * 7919 + 3);
    const observers = base.ops.filter((o) => o.res !== null && o.res !== undefined);
    if (observers.length === 0) continue;
    const victim = rng.pick(observers) ?? observers[0];
    const ops = base.ops.map((o) =>
      o.id === victim.id ? { ...o, res: differentValue(o.res as Value, rng) } : o,
    );
    const h: History = { label: `random ${spec.name} · NOT LZ · seed ${seed}`, ops };
    if (!isLinearizable(h, spec, { blame: false })) return { history: h, victim: victim.id };
  }
  return null;
}
