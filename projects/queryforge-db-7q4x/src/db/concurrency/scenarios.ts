// A library of canonical concurrency scenarios. Each one is an *interleaved
// schedule* of operations over a tiny key/value store, chosen to demonstrate one
// classic anomaly — and how raising the isolation level makes it disappear.

import type { IsolationLevel, Val } from './mvcc'

export type OpKind = 'begin' | 'read' | 'readWhere' | 'write' | 'delete' | 'commit' | 'abort'

export interface ScheduleOp {
  /** transaction label, e.g. "T1" */
  t: string
  kind: OpKind
  key?: string
  value?: Val
  pred?: { label: string; test: (v: Val) => boolean }
}

export interface Scenario {
  id: string
  title: string
  tagline: string
  blurb: string
  /** the consistency invariant the schedule threatens, if any */
  invariant?: string
  initial: { key: string; value: Val }[]
  ops: ScheduleOp[]
  /** what the user should take away */
  lesson: string
  /** levels at which the anomaly is *expected* to still appear (UI hint) */
  anomalyAt: IsolationLevel[]
}

// --- tiny op builders -------------------------------------------------------
const b = (t: string): ScheduleOp => ({ t, kind: 'begin' })
const r = (t: string, key: string): ScheduleOp => ({ t, kind: 'read', key })
const w = (t: string, key: string, value: Val): ScheduleOp => ({ t, kind: 'write', key, value })
const c = (t: string): ScheduleOp => ({ t, kind: 'commit' })
const a = (t: string): ScheduleOp => ({ t, kind: 'abort' })
const rp = (t: string, label: string, test: (v: Val) => boolean): ScheduleOp => ({
  t,
  kind: 'readWhere',
  pred: { label, test },
})

const num = (v: Val): number => (typeof v === 'number' ? v : 0)

export const SCENARIOS: Scenario[] = [
  {
    id: 'dirty-read',
    title: 'Dirty read',
    tagline: 'reading another transaction’s uncommitted write',
    blurb:
      'T2 writes a new balance but has not committed. T1 reads it, acts on it — and then T2 rolls back. T1 saw a value that, in the end, never existed.',
    invariant: 'A committed read should only reflect committed data.',
    initial: [{ key: 'balance', value: 100 }],
    ops: [
      b('T1'),
      b('T2'),
      w('T2', 'balance', 500),
      r('T1', 'balance'),
      a('T2'),
      c('T1'),
    ],
    lesson:
      'Under READ UNCOMMITTED, T1 reads 500 — a value T2 later abandons. Every other level makes T1 read the committed 100, so the dirty read vanishes.',
    anomalyAt: ['READ UNCOMMITTED'],
  },
  {
    id: 'non-repeatable-read',
    title: 'Non-repeatable read',
    tagline: 'the same row, read twice, gives two answers',
    blurb:
      'T1 reads a row, T2 updates and commits it, then T1 reads the same row again. Did the value change underneath T1?',
    invariant: 'Two reads of one row inside one transaction should agree.',
    initial: [{ key: 'price', value: 10 }],
    ops: [
      b('T1'),
      r('T1', 'price'),
      b('T2'),
      w('T2', 'price', 20),
      c('T2'),
      r('T1', 'price'),
      c('T1'),
    ],
    lesson:
      'READ COMMITTED takes a fresh snapshot per statement, so T1’s second read jumps from 10 to 20. REPEATABLE READ pins one snapshot at BEGIN, so both reads return 10.',
    anomalyAt: ['READ UNCOMMITTED', 'READ COMMITTED'],
  },
  {
    id: 'phantom',
    title: 'Phantom read',
    tagline: 'a predicate query gains a row mid-transaction',
    blurb:
      'T1 counts the rows matching a predicate, T2 inserts a new matching row and commits, then T1 re-runs the same predicate. A phantom appears.',
    invariant: 'A range query repeated in one transaction should return the same set.',
    initial: [
      { key: 'order:1', value: 50 },
      { key: 'order:2', value: 150 },
    ],
    ops: [
      b('T1'),
      rp('T1', 'amount > 100', (v) => num(v) > 100),
      b('T2'),
      w('T2', 'order:3', 250),
      c('T2'),
      rp('T1', 'amount > 100', (v) => num(v) > 100),
      c('T1'),
    ],
    lesson:
      'READ COMMITTED lets T1’s second scan see the new order:3 — a phantom. The snapshot at REPEATABLE READ hides anything committed after T1 began, so the phantom never materializes.',
    anomalyAt: ['READ UNCOMMITTED', 'READ COMMITTED'],
  },
  {
    id: 'lost-update',
    title: 'Lost update',
    tagline: 'two read-modify-writes, one increment vanishes',
    blurb:
      'Both transactions read a counter of 100, each means to add 20. They write 120 back. One of the two +20s is silently lost.',
    invariant: 'Concurrent increments should accumulate (final should be 140).',
    initial: [{ key: 'counter', value: 100 }],
    ops: [
      b('T1'),
      b('T2'),
      r('T1', 'counter'),
      r('T2', 'counter'),
      w('T1', 'counter', 120),
      w('T2', 'counter', 120),
      c('T1'),
      c('T2'),
    ],
    lesson:
      'READ COMMITTED lets both writes land — final 120, an update lost. REPEATABLE READ / SERIALIZABLE give the second writer a “could not serialize” abort (first-updater-wins), so the app must retry and no update is lost.',
    anomalyAt: ['READ UNCOMMITTED', 'READ COMMITTED'],
  },
  {
    id: 'write-skew',
    title: 'Write skew',
    tagline: 'the anomaly snapshot isolation can’t catch',
    blurb:
      'Two on-call doctors. The rule: at least one must stay on call. Each reads that both are on (sum = 2), each decides it is safe to go off — and both leave.',
    invariant: 'on_call(A) + on_call(B) ≥ 1 must always hold.',
    initial: [
      { key: 'doctor:A', value: 1 },
      { key: 'doctor:B', value: 1 },
    ],
    ops: [
      b('T1'),
      b('T2'),
      r('T1', 'doctor:A'),
      r('T1', 'doctor:B'),
      r('T2', 'doctor:A'),
      r('T2', 'doctor:B'),
      w('T1', 'doctor:A', 0),
      w('T2', 'doctor:B', 0),
      c('T1'),
      c('T2'),
    ],
    lesson:
      'Even REPEATABLE READ (snapshot isolation) commits both writes — the invariant breaks (0 + 0). SERIALIZABLE’s SSI spots the rw-antidependency cycle and aborts the second committer, preserving the rule.',
    anomalyAt: ['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ'],
  },
  {
    id: 'deadlock',
    title: 'Deadlock',
    tagline: 'two transactions, locks taken in opposite order',
    blurb:
      'T1 locks row X then reaches for Y; T2 locks Y then reaches for X. Each waits for a lock the other holds — a cycle the engine must break.',
    invariant: 'No set of transactions should wait on each other forever.',
    initial: [
      { key: 'X', value: 1 },
      { key: 'Y', value: 1 },
    ],
    ops: [
      b('T1'),
      b('T2'),
      w('T1', 'X', 10),
      w('T2', 'Y', 20),
      w('T1', 'Y', 11),
      w('T2', 'X', 21),
      c('T1'),
      c('T2'),
    ],
    lesson:
      'T1 blocks on Y (held by T2) and T2 blocks on X (held by T1). The waits-for graph has a cycle, so the engine aborts a victim to let the other finish — independent of isolation level.',
    anomalyAt: [],
  },
  {
    id: 'read-only-anomaly',
    title: 'Read-only anomaly',
    tagline: 'even a read-only transaction can see an impossible state',
    blurb:
      'The famous Fekete batch/receipts example: two read-write transactions are individually fine, but a third, read-only transaction observes a state no serial order can produce.',
    invariant: 'There must exist a serial order consistent with every transaction’s view.',
    initial: [
      { key: 'x', value: 0 },
      { key: 'y', value: 0 },
    ],
    ops: [
      b('T1'),
      b('T2'),
      r('T2', 'x'),
      r('T2', 'y'),
      r('T1', 'y'),
      w('T1', 'y', 20),
      c('T1'),
      b('T3'),
      r('T3', 'x'),
      r('T3', 'y'),
      c('T3'),
      w('T2', 'x', -11),
      c('T2'),
    ],
    lesson:
      'Under snapshot isolation T3 reads x = 0, y = 20 — a state inconsistent with both serial orders. SERIALIZABLE’s SSI detects the dangerous structure and aborts a transaction so the read-only observer can never be fooled.',
    anomalyAt: ['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ'],
  },
]

export function scenarioById(id: string): Scenario {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0]
}
