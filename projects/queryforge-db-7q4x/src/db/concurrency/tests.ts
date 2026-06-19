// Self-tests for the MVCC concurrency engine. These assert the *exact* anomaly
// behaviour at each isolation level — the backbone that proves the engine is
// correct, not just plausible. They are surfaced in the Self-tests tab (a
// `concurrency` group) and run head-less in CI alongside the SQL engine tests.

import { MvccStore, type IsolationLevel, type Val } from './mvcc'
import { runScenario, type RunResult } from './runner'
import { scenarioById } from './scenarios'

export interface MvccCase {
  group: string
  name: string
  run: () => void
}

const cases: MvccCase[] = []
function test(name: string, run: () => void) {
  cases.push({ group: 'concurrency', name, run })
}
function assert(cond: boolean, detail: string) {
  if (!cond) throw new Error(detail)
}

const run = (id: string, level: IsolationLevel): RunResult => runScenario(scenarioById(id), level)
const finalVal = (res: RunResult, key: string): Val | undefined =>
  res.finalRows.find((r) => r.key === key)?.value
const aborted = (res: RunResult, label: string): boolean => res.aborts.some((a) => a.t === label)
const reads = (res: RunResult, label: string): (Val | undefined)[] =>
  res.steps.filter((s) => s.t === label && s.op.startsWith('read(')).map((s) => s.readValue)
const predCounts = (res: RunResult, label: string): number[] =>
  res.steps.filter((s) => s.t === label && s.op.startsWith('read*(')).map((s) => s.rows?.length ?? 0)

// --- low-level MVCC store ---------------------------------------------------
test('version chain: an update appends a version and stamps xmax', () => {
  const s = new MvccStore()
  s.seed('k', 1)
  const t1 = s.begin('T1', 'READ COMMITTED')
  s.write(t1, 'k', 2)
  s.commit(t1)
  const chain = s.table.get('k')!
  assert(chain.length === 2, `expected 2 versions, got ${chain.length}`)
  assert(chain[0].xmax === t1.id, 'old version xmax should point at the updater')
  assert(chain[1].xmin === t1.id && chain[1].xmax === 0, 'new version is live, created by T1')
})

test('snapshot visibility: REPEATABLE READ does not see a concurrent commit', () => {
  const s = new MvccStore()
  s.seed('k', 1)
  const t1 = s.begin('T1', 'REPEATABLE READ')
  const t2 = s.begin('T2', 'REPEATABLE READ')
  s.write(t2, 'k', 9)
  s.commit(t2)
  assert(s.read(t1, 'k').value === 1, 'T1 keeps its snapshot value of 1')
})

test('READ COMMITTED sees a concurrent commit on the next read', () => {
  const s = new MvccStore()
  s.seed('k', 1)
  const t1 = s.begin('T1', 'READ COMMITTED')
  assert(s.read(t1, 'k').value === 1, 'first read is 1')
  const t2 = s.begin('T2', 'READ COMMITTED')
  s.write(t2, 'k', 7)
  s.commit(t2)
  assert(s.read(t1, 'k').value === 7, 'second read sees the committed 7')
})

test('delete is a visible tombstone to later snapshots only', () => {
  const s = new MvccStore()
  s.seed('k', 5)
  const t1 = s.begin('T1', 'REPEATABLE READ') // snapshot before the delete
  const t2 = s.begin('T2', 'READ COMMITTED')
  s.del(t2, 'k')
  s.commit(t2)
  assert(s.read(t1, 'k').found === true, 'T1 still sees the row (its snapshot predates the delete)')
  const t3 = s.begin('T3', 'READ COMMITTED')
  assert(s.read(t3, 'k').found === false, 'a fresh reader sees the row gone')
})

// --- dirty read -------------------------------------------------------------
test('dirty read appears only under READ UNCOMMITTED', () => {
  assert(reads(run('dirty-read', 'READ UNCOMMITTED'), 'T1')[0] === 500, 'RU reads uncommitted 500')
  assert(reads(run('dirty-read', 'READ COMMITTED'), 'T1')[0] === 100, 'RC reads committed 100')
  assert(reads(run('dirty-read', 'REPEATABLE READ'), 'T1')[0] === 100, 'RR reads committed 100')
  // T2 rolled back, so the final committed value is the original 100.
  assert(finalVal(run('dirty-read', 'READ UNCOMMITTED'), 'balance') === 100, 'rollback restores 100')
})

// --- non-repeatable read ----------------------------------------------------
test('non-repeatable read: RC changes mid-txn, RR is stable', () => {
  const rc = reads(run('non-repeatable-read', 'READ COMMITTED'), 'T1')
  assert(rc[0] === 10 && rc[1] === 20, `RC should read 10 then 20, got ${rc.join(',')}`)
  const rr = reads(run('non-repeatable-read', 'REPEATABLE READ'), 'T1')
  assert(rr[0] === 10 && rr[1] === 10, `RR should read 10 twice, got ${rr.join(',')}`)
  const ser = run('non-repeatable-read', 'SERIALIZABLE')
  assert(reads(ser, 'T1')[1] === 10, 'SER also reads 10 twice')
  assert(!aborted(ser, 'T1'), 'SER must not falsely abort this benign read')
})

// --- phantom ----------------------------------------------------------------
test('phantom: RC gains a row, RR does not', () => {
  const rc = predCounts(run('phantom', 'READ COMMITTED'), 'T1')
  assert(rc[0] === 1 && rc[1] === 2, `RC predicate read 1 then 2, got ${rc.join(',')}`)
  const rr = predCounts(run('phantom', 'REPEATABLE READ'), 'T1')
  assert(rr[0] === 1 && rr[1] === 1, `RR predicate read 1 twice, got ${rr.join(',')}`)
})

// --- lost update ------------------------------------------------------------
test('lost update lost under RC, prevented (abort) under RR/SER', () => {
  const rc = run('lost-update', 'READ COMMITTED')
  assert(finalVal(rc, 'counter') === 120, 'RC loses an update: final 120, not 140')
  assert(rc.aborts.length === 0, 'RC commits both writers')
  const rr = run('lost-update', 'REPEATABLE READ')
  assert(aborted(rr, 'T2'), 'RR aborts the second writer (first-updater-wins)')
  assert(/serialize/i.test(rr.aborts.find((a) => a.t === 'T2')!.reason), 'RR abort is a serialization failure')
  const ser = run('lost-update', 'SERIALIZABLE')
  assert(aborted(ser, 'T2'), 'SER aborts the second writer too')
})

// --- write skew -------------------------------------------------------------
test('write skew: SI commits both, SSI aborts one', () => {
  const rr = run('write-skew', 'REPEATABLE READ')
  assert(finalVal(rr, 'doctor:A') === 0 && finalVal(rr, 'doctor:B') === 0, 'RR breaks the invariant (0 + 0)')
  assert(rr.aborts.length === 0, 'RR (snapshot isolation) commits both')
  assert(!rr.serializable, 'RR outcome is not serializable')
  const ser = run('write-skew', 'SERIALIZABLE')
  assert(aborted(ser, 'T2'), 'SSI aborts the second committer (T2)')
  assert(finalVal(ser, 'doctor:B') === 1, 'B stays on call — the invariant holds')
  assert(finalVal(ser, 'doctor:A') === 0, 'A successfully went off call')
  assert(ser.serializable, 'SER outcome is serializable')
})

// --- deadlock ---------------------------------------------------------------
test('deadlock: the engine aborts a victim and the other commits', () => {
  const res = run('deadlock', 'READ COMMITTED')
  assert(aborted(res, 'T2'), 'T2 (the cycle-closer) is the deadlock victim')
  assert(/deadlock/i.test(res.aborts.find((a) => a.t === 'T2')!.reason), 'victim aborted for deadlock')
  assert(!aborted(res, 'T1'), 'T1 survives')
  assert(finalVal(res, 'X') === 10 && finalVal(res, 'Y') === 11, 'survivor T1’s writes are durable')
})

// --- read-only anomaly ------------------------------------------------------
test('read-only anomaly: SERIALIZABLE keeps the schedule serializable', () => {
  const ser = run('read-only-anomaly', 'SERIALIZABLE')
  assert(ser.serializable, 'SSI prevents the read-only anomaly (serializable outcome)')
  const rr = run('read-only-anomaly', 'REPEATABLE READ')
  assert(rr.aborts.length === 0, 'snapshot isolation does not abort anyone here')
})

export const mvccCases = cases
