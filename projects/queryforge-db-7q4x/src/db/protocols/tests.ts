// Self-tests for the pluggable concurrency-control protocol layer. These prove
// the *exact* behaviour of each protocol and — the headline — that the
// serializability oracle certifies every protocol's committed history, on both
// the curated scenarios and thousands of seeded random schedules. Surfaced in
// the Self-tests tab (a `protocols` group) and run head-less in CI.

import { SCENARIOS, scenarioById, type ScheduleOp } from '../concurrency/scenarios'
import type { Val } from '../concurrency/mvcc'
import { runOne, generateSchedule } from './compare'
import { analyzeHistory, replaySerial } from './history'
import { LockManager } from './lock2pl'
import type { Access } from './types'
import type { ProtocolId } from './types'
import type { ProtocolRunResult } from './result'

export interface ProtocolCase {
  group: string
  name: string
  run: () => void
}

const cases: ProtocolCase[] = []
function test(name: string, run: () => void) {
  cases.push({ group: 'protocols', name, run })
}
function assert(cond: boolean, detail: string) {
  if (!cond) throw new Error(detail)
}

const NEW_PROTOCOLS: Exclude<ProtocolId, 'mvcc'>[] = ['s2pl', 'occ', 'to']

const committedOf = (r: ProtocolRunResult): Set<string> =>
  new Set(r.outcomes.filter((o) => o.status === 'committed').map((o) => o.label))
const reads = (r: ProtocolRunResult, label: string): (Val | undefined)[] =>
  r.steps.filter((s) => s.t === label && s.op.startsWith('read(')).map((s) => s.readValue)
const finalVal = (r: ProtocolRunResult, key: string): Val | undefined =>
  r.committedRows.find((row) => row.key === key)?.value

/** The intended (program-order) writes of each transaction, from the schedule. */
function writesByTxn(ops: ScheduleOp[]) {
  const m = new Map<string, { key: string; value: Val; deleted: boolean }[]>()
  const push = (t: string, w: { key: string; value: Val; deleted: boolean }) => {
    const list = m.get(t) ?? []
    list.push(w)
    m.set(t, list)
  }
  for (const op of ops) {
    if (op.kind === 'write') push(op.t, { key: op.key!, value: op.value!, deleted: false })
    else if (op.kind === 'delete') push(op.t, { key: op.key!, value: null, deleted: true })
  }
  return m
}

// --- the serializability oracle ---------------------------------------------

test('oracle: a cyclic history (T1 w x, T2 w x, T2 w y, T1 w y) is not serializable', () => {
  const log: Access[] = [
    { txn: 'T1', kind: 'w', item: 'x', seq: 0 },
    { txn: 'T2', kind: 'w', item: 'x', seq: 1 },
    { txn: 'T2', kind: 'w', item: 'y', seq: 2 },
    { txn: 'T1', kind: 'w', item: 'y', seq: 3 },
  ]
  const res = analyzeHistory(log, new Set(['T1', 'T2']))
  assert(!res.serializable, 'the interleaved ww/ww conflict should form a cycle')
  assert(res.cycle !== null && res.cycle.length === 2, 'the witnessing cycle names both txns')
})

test('oracle: a serial history is serializable and yields a valid order', () => {
  const log: Access[] = [
    { txn: 'T1', kind: 'w', item: 'x', seq: 0 },
    { txn: 'T2', kind: 'r', item: 'x', seq: 1 },
    { txn: 'T2', kind: 'w', item: 'y', seq: 2 },
  ]
  const res = analyzeHistory(log, new Set(['T1', 'T2']))
  assert(res.serializable, 'T1 fully before T2 is serializable')
  assert(JSON.stringify(res.order) === JSON.stringify(['T1', 'T2']), `order should be T1,T2 (got ${res.order})`)
})

test('oracle: two reads of the same item never conflict', () => {
  const log: Access[] = [
    { txn: 'T1', kind: 'r', item: 'x', seq: 0 },
    { txn: 'T2', kind: 'r', item: 'x', seq: 1 },
  ]
  const res = analyzeHistory(log, new Set(['T1', 'T2']))
  assert(res.serializable, 'read-read is not a conflict')
})

// --- the lock manager (Strict 2PL substrate) --------------------------------

test('lock manager: shared locks are compatible, an exclusive lock is not', () => {
  const lm = new LockManager()
  assert(lm.acquireAll('T1', [{ item: 'x', mode: 'S' }]).ok, 'T1 gets S(x)')
  assert(lm.acquireAll('T2', [{ item: 'x', mode: 'S' }]).ok, 'T2 shares S(x)')
  const x = lm.acquireAll('T3', [{ item: 'x', mode: 'X' }])
  assert(!x.ok, 'T3 cannot take X(x) while others hold S')
  if (!x.ok) assert(x.blockers.includes('T1') && x.blockers.includes('T2'), 'blockers are the S holders')
})

test('lock manager: a holder upgrades S→X only when it is the sole holder', () => {
  const lm = new LockManager()
  lm.acquireAll('T1', [{ item: 'x', mode: 'S' }])
  lm.acquireAll('T2', [{ item: 'x', mode: 'S' }])
  assert(!lm.acquireAll('T1', [{ item: 'x', mode: 'X' }]).ok, 'T1 cannot upgrade while T2 holds S')
  lm.release('T2')
  assert(lm.acquireAll('T1', [{ item: 'x', mode: 'X' }]).ok, 'once T2 releases, T1 upgrades to X')
  assert(!lm.acquireAll('T2', [{ item: 'x', mode: 'S' }]).ok, 'now T2 cannot read the X-locked item')
})

// --- Strict 2PL behaviour ----------------------------------------------------

test('S2PL: a reader blocks on an uncommitted write — no dirty read', () => {
  const r = runOne('s2pl', scenarioById('dirty-read'))
  // T2 wrote then aborted; T1's read must see the committed 100, never 500.
  assert(!reads(r, 'T1').includes(500), 'T1 must not read the uncommitted/aborted 500')
  assert(r.serializable, 'strict 2PL is always serializable')
})

test('S2PL: lost update is prevented by a deadlock abort (first-updater blocks)', () => {
  const r = runOne('s2pl', scenarioById('lost-update'))
  assert(r.metrics.committed === 1 && r.metrics.aborts === 1, 'exactly one of the two writers survives')
  assert(finalVal(r, 'counter') === 120, 'the surviving write lands; the app retries the other')
  assert(r.serializable, 'serializable')
})

test('S2PL: the deadlock scenario aborts a victim and stays serializable', () => {
  const r = runOne('s2pl', scenarioById('deadlock'))
  assert(r.metrics.deadlocks >= 1, 'a deadlock is detected and broken')
  assert(r.serializable, 'serializable after the victim is aborted')
})

test('S2PL: write skew is prevented (read locks block the cross-write)', () => {
  const r = runOne('s2pl', scenarioById('write-skew'))
  const a = finalVal(r, 'doctor:A')
  const b = finalVal(r, 'doctor:B')
  assert(!(a === 0 && b === 0), 'the on-call invariant is preserved — not both off')
  assert(r.serializable, 'serializable')
})

// --- OCC behaviour -----------------------------------------------------------

test('OCC: the second committer fails validation and aborts (lost update prevented)', () => {
  const r = runOne('occ', scenarioById('lost-update'))
  assert(r.metrics.validationFails >= 1, 'backward validation aborts the loser')
  assert(r.metrics.committed === 1, 'only one increment commits')
  assert(r.metrics.deadlocks === 0, 'OCC never deadlocks')
  assert(r.serializable, 'serializable')
})

test('OCC: reads never see uncommitted data (no dirty read on dirty-read scenario)', () => {
  const r = runOne('occ', scenarioById('dirty-read'))
  assert(!reads(r, 'T1').includes(500), 'OCC reads committed data only')
  assert(r.serializable, 'serializable')
})

// --- Basic T/O behaviour -----------------------------------------------------

test('T/O: it never blocks or deadlocks (conflicts abort instead)', () => {
  for (const id of ['deadlock', 'lost-update', 'write-skew'] as const) {
    const r = runOne('to', scenarioById(id))
    assert(r.metrics.blocks === 0, `${id}: T/O has no blocking`)
    assert(r.metrics.deadlocks === 0, `${id}: T/O has no deadlocks`)
    assert(r.serializable, `${id}: T/O committed history is serializable`)
  }
})

// --- MVCC comparison column --------------------------------------------------

test('MVCC: write skew is an anomaly at REPEATABLE READ but serializable at SERIALIZABLE', () => {
  const rr = runOne('mvcc', scenarioById('write-skew'), 'REPEATABLE READ')
  assert(!rr.serializable, 'snapshot isolation admits write skew')
  const ser = runOne('mvcc', scenarioById('write-skew'), 'SERIALIZABLE')
  assert(ser.serializable, 'SSI catches the dangerous structure')
  assert(ser.metrics.aborts >= 1, 'SSI aborts a transaction to enforce it')
})

// --- the headline guarantees -------------------------------------------------

test('guarantee: every protocol is serializable on all 7 classic scenarios', () => {
  for (const sc of SCENARIOS) {
    for (const id of NEW_PROTOCOLS) {
      const r = runOne(id, sc)
      assert(r.serializable, `${id} on ${sc.id} produced a non-serializable history: ${r.cycle}`)
    }
    const mvcc = runOne('mvcc', sc, 'SERIALIZABLE')
    assert(mvcc.serializable, `mvcc(SER) on ${sc.id} not serializable`)
  }
})

test('fuzz: 600 random schedules — S2PL, OCC and T/O are all serializable', () => {
  for (let seed = 1; seed <= 600; seed++) {
    const sc = generateSchedule(seed, { txns: 3, keys: 3, opsPerTxn: 5, abortRate: 0.2 })
    for (const id of NEW_PROTOCOLS) {
      const r = runOne(id, sc)
      assert(r.serializable, `seed ${seed}/${id}: committed history not serializable (cycle ${r.cycle})`)
    }
  }
})

test('fuzz: strict protocols (S2PL, OCC) match a serial replay of the committed txns', () => {
  for (let seed = 1; seed <= 600; seed++) {
    const sc = generateSchedule(seed, { txns: 3, keys: 3, opsPerTxn: 5, abortRate: 0.2 })
    for (const id of ['s2pl', 'occ'] as const) {
      const r = runOne(id, sc)
      assert(r.order !== null, 'a serializable run has a serial order')
      const committed = committedOf(r)
      const wbt = writesByTxn(sc.ops)
      for (const t of [...wbt.keys()]) if (!committed.has(t)) wbt.delete(t)
      const serial = replaySerial(r.order!, sc.initial, wbt)
      assert(
        JSON.stringify(r.committedRows) === JSON.stringify(serial),
        `seed ${seed}/${id}: final state ${JSON.stringify(r.committedRows)} != serial replay ${JSON.stringify(serial)}`,
      )
    }
  }
})

test('recoverability: S2PL and OCC never cascade-abort; basic T/O sometimes must', () => {
  let toCascades = 0
  for (let seed = 1; seed <= 1500; seed++) {
    const sc = generateSchedule(seed, { txns: 4, keys: 4, opsPerTxn: 6, abortRate: 0.3 })
    for (const id of ['s2pl', 'occ'] as const) {
      const r = runOne(id, sc)
      const cascaded = r.outcomes.some((o) => o.reason === 'cascade abort')
      assert(!cascaded, `${id} is cascadeless but seed ${seed} cascaded`)
    }
    const to = runOne('to', sc)
    if (to.outcomes.some((o) => o.reason === 'cascade abort')) toCascades++
  }
  assert(toCascades > 0, 'basic T/O should exhibit cascading rollback on some schedule (it is not recoverable)')
})

export const protocolsCases = cases
