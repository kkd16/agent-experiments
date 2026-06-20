// Self-tests for the ARIES recovery engine. They assert the *exact* behaviour of
// each pass — redo restores committed data that never reached disk, undo erases
// stolen uncommitted data, fuzzy checkpoints bound the redo scan, and recovery is
// restartable across a second crash — plus the cross-cutting invariant that every
// scenario, recovered, matches an independently computed correct state. Surfaced in
// the Self-tests tab as a `recovery` group and run head-less in CI.

import { AriesDb, type Cell, type PageId } from './wal'
import { recover } from './recovery'
import { runScenario } from './runner'
import { REC_SCENARIOS, recScenarioById } from './scenarios'

export interface RecoveryCase {
  group: string
  name: string
  run: () => void
}

const cases: RecoveryCase[] = []
function test(name: string, run: () => void) {
  cases.push({ group: 'recovery', name, run })
}
function assert(cond: boolean, detail: string) {
  if (!cond) throw new Error(detail)
}

const recovered = (id: string) => {
  const res = runScenario(recScenarioById(id))
  const m = new Map<PageId, Cell>(res.recovered.map((r) => [r.page, r.value]))
  return { res, val: (p: PageId) => m.get(p) }
}

// --- the master invariant: every scenario recovers to its truth --------------
for (const s of REC_SCENARIOS) {
  test(`scenario "${s.id}" recovers to the only correct state`, () => {
    const res = runScenario(s)
    assert(res.consistent, `${s.id}: recovered ${JSON.stringify(res.recovered)} ≠ truth ${JSON.stringify(res.truth)}`)
  })
}

// --- NO-FORCE ⟹ REDO ---------------------------------------------------------
test('redo restores committed data that never reached disk', () => {
  const { res, val } = recovered('redo-after-commit')
  assert(val('A') === 200 && val('B') === 75, `expected A=200,B=75 got A=${val('A')},B=${val('B')}`)
  assert(res.losers.length === 0, 'a committed transaction is no loser')
  assert(res.redoLsn > 0, 'redo must have a starting LSN (pages were dirty)')
  // The redo pass must actually reapply at least one change here.
  assert(res.steps.some((st) => st.phase === 'redo' && st.title.startsWith('redo ')), 'redo should reapply a page')
})

// --- STEAL ⟹ UNDO ------------------------------------------------------------
test('undo rolls back an uncommitted change that was stolen to disk', () => {
  const { res, val } = recovered('undo-uncommitted')
  assert(val('A') === 10, `A must be restored to 10, got ${val('A')}`)
  assert(res.losers.includes('T1'), 'T1 is a loser')
  // A CLR must have been written for the undo.
  assert(res.steps.some((st) => st.phase === 'undo' && st.title.startsWith('undo ')), 'undo should log a CLR')
})

// --- repeat history, then undo ----------------------------------------------
test('winners and losers: history is repeated, then only the loser is undone', () => {
  const { res, val } = recovered('winners-and-losers')
  assert(val('A') === 10, 'T1 (winner) update to A is durable')
  assert(val('C') === 30, 'T1 (winner) update to C is durable')
  assert(val('B') === 2, 'T2 (loser) update to B is undone')
  assert(res.winners.includes('T1') && res.losers.includes('T2'), 'T1 winner, T2 loser')
})

// --- fuzzy checkpoint --------------------------------------------------------
test('a checkpoint makes redo start after the checkpoint, not at the log head', () => {
  const { res, val } = recovered('checkpoint')
  assert(val('A') === 5 && val('B') === 7, `expected A=5,B=7 got A=${val('A')},B=${val('B')}`)
  // Analysis must announce it starts at the checkpoint.
  assert(res.steps.some((st) => st.title === 'start at checkpoint'), 'analysis should start at the checkpoint')
  // RedoLSN must be a real, late LSN (B's update), not 1 — A is excluded.
  assert(res.redoLsn > 3, `redo should start past the checkpoint, got LSN ${res.redoLsn}`)
})

// --- restartable recovery (CLR idempotence) ----------------------------------
test('recovery survives a crash during its own undo pass (no double rollback)', () => {
  const { res, val } = recovered('crash-during-recovery')
  assert(val('A') === 1 && val('B') === 1, `both pages must be back to 1, got A=${val('A')},B=${val('B')}`)
  // There must be a "crash during recovery" step, then recovery must resume.
  const crashes = res.steps.filter((st) => st.phase === 'crash')
  assert(crashes.length >= 2, `expected an initial crash + a mid-recovery crash, got ${crashes.length}`)
  // After the mid-recovery crash, a later step must skip an already-written CLR.
  assert(res.steps.some((st) => st.title.startsWith('skip CLR')), 'restart should skip a CLR it already wrote')
})

// --- normal rollback uses the same CLR machinery -----------------------------
test('an explicit rollback is replayed (with its CLRs) by redo', () => {
  const { val } = recovered('normal-rollback')
  assert(val('X') === 9, 'only T2 (committed) survives on X')
  assert(val('Y') === 0, 'T1’s rolled-back Y is gone')
})

// --- low-level AriesDb / recover() unit checks -------------------------------
test('WAL: flushing a page forces the log up to its pageLSN first', () => {
  const db = new AriesDb([{ page: 'A', value: 0 }])
  db.begin('T1')
  const lsn = db.update('T1', 'A', 5)
  assert(db.flushedUpTo < lsn, 'log not yet forced before the page flush')
  db.flushPage('A')
  assert(db.flushedUpTo >= lsn, 'flushPage must force the log up to the page pageLSN (write-ahead)')
  assert(db.disk.get('A')!.value === 5, 'the stolen page is on disk')
  assert(!db.dpt.has('A'), 'a flushed page leaves the dirty-page table')
})

test('commit forces the log so the decision is durable across a crash', () => {
  const db = new AriesDb([{ page: 'A', value: 0 }])
  db.begin('T1')
  const lsn = db.update('T1', 'A', 7)
  db.commit('T1')
  const durable = db.crash()
  assert(durable.log.some((r) => r.type === 'commit' && r.txn === 'T1'), 'commit record survived the crash')
  assert(durable.log.some((r) => r.lsn === lsn), 'the update record survived the crash')
  // The dirty page itself need not be on disk (NO-FORCE).
  assert((durable.pages.get('A')?.pageLSN ?? 0) < lsn || !durable.pages.has('A'), 'page need not be flushed at commit')
})

test('recover() is idempotent: a second run changes nothing', () => {
  const db = new AriesDb([
    { page: 'A', value: 1 },
    { page: 'B', value: 1 },
  ])
  db.begin('T1')
  db.update('T1', 'A', 9)
  db.begin('T2')
  db.update('T2', 'B', 8) // T2 never commits → loser
  db.commit('T1')
  const durable = db.crash()
  const first = recover(durable)
  const a1 = first.state.pages.get('A')!.value
  const b1 = first.state.pages.get('B')!.value
  assert(a1 === 9 && b1 === 1, `first recovery: expected A=9,B=1 got A=${a1},B=${b1}`)
  const second = recover(first.state)
  const a2 = second.state.pages.get('A')!.value
  const b2 = second.state.pages.get('B')!.value
  assert(a2 === 9 && b2 === 1, `second recovery must be a no-op, got A=${a2},B=${b2}`)
  assert(second.losers.length === 0, 'no losers remain after a completed recovery')
})

test('repeat history reconstructs the exact crash state before any undo', () => {
  // T1 (loser) dirties A but the page is never flushed; redo must still recreate
  // A=42 (repeat history) before undo restores it.
  const db = new AriesDb([{ page: 'A', value: 0 }])
  db.begin('T1')
  db.update('T1', 'A', 42)
  const durable = db.crash()
  const res = recover(durable)
  // After full recovery A is back to 0, but the redo pass must have set it to 42.
  const redidValue = res.steps.find((st) => st.phase === 'redo' && st.title.startsWith('redo '))
  assert(redidValue !== undefined, 'redo must reapply the loser’s change (repeat history)')
  assert(res.state.pages.get('A')!.value === 0, 'undo then restores A to 0')
})

export const recoveryCases = cases
