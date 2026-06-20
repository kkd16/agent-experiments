// ARIES restart recovery — the three-pass algorithm (Mohan et al., "ARIES: A
// Transaction Recovery Method Supporting Fine-Granularity Locking and Partial
// Rollbacks Using Write-Ahead Logging", ACM TODS 1992) that turns the smoking
// wreckage a crash leaves behind — a set of flushed pages plus a forced log —
// back into a transaction-consistent database.
//
//   1. ANALYSIS  — scan forward from the last checkpoint to rebuild the dirty-page
//                  table and transaction table as they stood at the crash, find the
//                  point REDO must start (the oldest recLSN), and label every
//                  in-flight transaction a winner (committed) or a loser.
//   2. REDO      — "repeat history": replay *every* logged change — winners' and
//                  losers' alike — that might not have reached disk, restoring the
//                  database to its exact state at the instant of the crash. The
//                  per-page pageLSN test makes a reapplied change idempotent.
//   3. UNDO      — roll the losers back in reverse-LSN order, writing a Compensation
//                  Log Record (CLR) for each change undone. CLRs are themselves
//                  redo-only and carry an undoNextLSN, so a crash *during* recovery
//                  loses no progress: the restart redoes the CLRs and resumes undo
//                  exactly where it left off.
//
// The pivotal idea is "repeat history before undoing": REDO faithfully reproduces
// the crash state (losers included) so that UNDO — and the CLRs it leaves — operate
// against a known, reconstructable starting point. That is what makes ARIES
// recovery restartable to any depth.

import {
  fmtCell,
  type Cell,
  type DurableState,
  type EndCkptRec,
  type LogRecord,
  type LSN,
  type Page,
  type PageId,
  type TxnStatus,
} from './wal'

// --- view types shared with the runner + UI --------------------------------

export type Phase = 'run' | 'crash' | 'analysis' | 'redo' | 'undo' | 'done'

export interface LogRow {
  rec: LogRecord
  /** durably on the disk log (vs. a volatile tail record during normal operation). */
  durable: boolean
  /** written by recovery itself (a CLR or an end record). */
  generated: boolean
}
export interface PageRow {
  page: PageId
  disk: Page
  /** the buffer-pool copy, when it differs / exists (normal operation only). */
  buffer?: Page
  /** dirty = present in the dirty-page table. */
  dirty: boolean
}
export interface TtRow {
  txn: string
  status: TxnStatus
  lastLsn: LSN
  loser?: boolean
}
export interface DptRow {
  page: PageId
  recLsn: LSN
}
export interface RecWorld {
  phase: Phase
  log: LogRow[]
  pages: PageRow[]
  txnTable: TtRow[]
  dpt: DptRow[]
  redoLsn?: LSN
  losers?: string[]
  /** the log record currently being acted upon. */
  highlightLsn?: LSN
}
export interface RecStep {
  seq: number
  phase: Phase
  title: string
  detail: string
  world: RecWorld
}

export interface RecoveryResult {
  steps: RecStep[]
  /** the durable state after recovery (CLRs + end records appended, pages updated). */
  state: DurableState
  redoLsn: LSN
  losers: string[]
  analysisTt: TtRow[]
  analysisDpt: DptRow[]
  /** true if recovery was cut short by a simulated mid-recovery crash. */
  interrupted: boolean
}

export interface RecoverOpts {
  /** stop after writing this many CLRs, simulating a crash *during* the undo pass. */
  stopAfterUndo?: number
  /** starting sequence number for emitted steps (so a unified timeline keeps counting). */
  seq0?: number
}

/** Run the full ARIES restart algorithm against a durable post-crash state. */
export function recover(state: DurableState, opts: RecoverOpts = {}): RecoveryResult {
  const steps: RecStep[] = []
  let seq = opts.seq0 ?? 0
  let redoLsn = 0 // hoisted: snapshot() reads it from the analysis phase onward

  // A mutable working log (the durable log; recovery appends CLRs + end records).
  const log: LogRecord[] = state.log.map((r) => ({ ...r }))
  const byLsn = new Map<LSN, LogRecord>()
  for (const r of log) byLsn.set(r.lsn, r)
  const generated = new Set<LSN>() // lsns recovery itself wrote
  let nextLsn = state.nextLsn

  // The recovered page images. Recovery writes through to disk, so this is the
  // authoritative copy throughout.
  const pages = new Map<PageId, Page>([...state.pages].map(([k, v]) => [k, { ...v }]))
  const pageOf = (id: PageId): Page => {
    let p = pages.get(id)
    if (!p) {
      p = { value: state.initial.get(id) ?? 0, pageLSN: 0 }
      pages.set(id, p)
    }
    return p
  }

  // Working transaction table + dirty-page table, rebuilt by analysis.
  const tt = new Map<string, { status: TxnStatus; lastLsn: LSN }>()
  const dpt = new Map<PageId, LSN>()
  let loserSet = new Set<string>()

  const append = (rec: LogRecord): LSN => {
    log.push(rec)
    byLsn.set(rec.lsn, rec)
    generated.add(rec.lsn)
    return rec.lsn
  }

  const snapshot = (phase: Phase, highlightLsn?: LSN): RecWorld => ({
    phase,
    log: log
      .slice()
      .sort((a, b) => a.lsn - b.lsn)
      .map((rec) => ({ rec, durable: true, generated: generated.has(rec.lsn) })),
    pages: [...pages.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([page, p]) => ({ page, disk: { ...p }, dirty: dpt.has(page) })),
    txnTable: [...tt.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([txn, e]) => ({ txn, status: e.status, lastLsn: e.lastLsn, loser: loserSet.has(txn) })),
    dpt: [...dpt.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([page, recLsn]) => ({ page, recLsn })),
    redoLsn: redoLsn || undefined,
    losers: [...loserSet],
    highlightLsn,
  })

  const emit = (phase: Phase, title: string, detail: string, highlightLsn?: LSN) => {
    steps.push({ seq: seq++, phase, title, detail, world: snapshot(phase, highlightLsn) })
  }

  // ============================ ANALYSIS ==================================
  // Seed the tables from the last completed checkpoint, then scan forward.
  let startLsn = log.length ? log[0].lsn : 1
  if (state.masterRecord > 0) {
    const endCkpt = log.find(
      (r): r is EndCkptRec => r.type === 'end_checkpoint' && r.lsn > state.masterRecord,
    )
    if (endCkpt) {
      for (const t of endCkpt.txnTable) tt.set(t.txn, { status: t.status, lastLsn: t.lastLsn })
      for (const d of endCkpt.dpt) dpt.set(d.page, d.recLsn)
    }
    startLsn = state.masterRecord
    emit(
      'analysis',
      'start at checkpoint',
      `Begin analysis at the begin_checkpoint (LSN ${state.masterRecord}); install its snapshot of the transaction table and dirty-page table.`,
      state.masterRecord,
    )
  } else {
    emit('analysis', 'start at log head', 'No checkpoint — analysis scans from the first log record.')
  }

  for (const rec of log) {
    if (rec.lsn < startLsn) continue
    switch (rec.type) {
      case 'begin':
        tt.set(rec.txn, { status: 'running', lastLsn: rec.lsn })
        emit('analysis', `begin ${rec.txn}`, `${rec.txn} starts.`, rec.lsn)
        break
      case 'update':
      case 'clr': {
        const e = tt.get(rec.txn) ?? { status: 'running' as TxnStatus, lastLsn: rec.lsn }
        e.lastLsn = rec.lsn
        tt.set(rec.txn, e)
        if (!dpt.has(rec.page)) dpt.set(rec.page, rec.lsn)
        emit(
          'analysis',
          `${rec.type === 'clr' ? 'clr' : 'update'} ${rec.page}`,
          `${rec.txn} ${rec.type === 'clr' ? 'compensates' : 'updates'} ${rec.page}; ${
            dpt.get(rec.page) === rec.lsn ? `${rec.page} enters the DPT with recLSN ${rec.lsn}` : `${rec.page} already dirty`
          }.`,
          rec.lsn,
        )
        break
      }
      case 'commit': {
        const e = tt.get(rec.txn) ?? { status: 'committed' as TxnStatus, lastLsn: rec.lsn }
        e.status = 'committed'
        e.lastLsn = rec.lsn
        tt.set(rec.txn, e)
        emit('analysis', `commit ${rec.txn}`, `${rec.txn} is a winner — its effects must survive.`, rec.lsn)
        break
      }
      case 'abort': {
        const e = tt.get(rec.txn) ?? { status: 'aborting' as TxnStatus, lastLsn: rec.lsn }
        e.status = 'aborting'
        e.lastLsn = rec.lsn
        tt.set(rec.txn, e)
        emit('analysis', `abort ${rec.txn}`, `${rec.txn} was rolling back at the crash.`, rec.lsn)
        break
      }
      case 'end':
        tt.delete(rec.txn)
        emit('analysis', `end ${rec.txn}`, `${rec.txn} finished cleanly; drop it from the table.`, rec.lsn)
        break
      case 'begin_checkpoint':
      case 'end_checkpoint':
        break
    }
  }

  // Losers = still-live transactions that never committed.
  loserSet = new Set([...tt.entries()].filter(([, e]) => e.status !== 'committed').map(([t]) => t))
  // RedoLSN = the oldest recLSN in the dirty-page table (where REDO must begin).
  for (const lsn of dpt.values()) redoLsn = redoLsn === 0 ? lsn : Math.min(redoLsn, lsn)
  const losers = [...loserSet].sort()
  const analysisTt: TtRow[] = [...tt.entries()].map(([txn, e]) => ({
    txn,
    status: e.status,
    lastLsn: e.lastLsn,
    loser: loserSet.has(txn),
  }))
  const analysisDpt: DptRow[] = [...dpt.entries()].map(([page, recLsn]) => ({ page, recLsn }))
  emit(
    'analysis',
    'analysis complete',
    `Losers: ${losers.length ? losers.join(', ') : 'none'}. REDO begins at LSN ${
      redoLsn || '— (nothing dirty)'
    }.`,
  )

  // ============================== REDO ====================================
  // Repeat history: reapply every redoable change at or after RedoLSN whose page
  // may be stale on disk.
  emit('redo', 'redo pass', `Repeating history from LSN ${redoLsn || '—'} — replaying winners *and* losers.`)
  if (redoLsn > 0) {
    for (const rec of log) {
      if (rec.lsn < redoLsn) continue
      if (rec.type !== 'update' && rec.type !== 'clr') continue
      const recLsn = dpt.get(rec.page)
      if (recLsn === undefined || recLsn > rec.lsn) {
        emit('redo', `skip ${rec.page}`, `${rec.page} is not dirty past this LSN — its change already reached disk.`, rec.lsn)
        continue
      }
      const p = pageOf(rec.page)
      if (p.pageLSN >= rec.lsn) {
        emit('redo', `skip ${rec.page}`, `pageLSN ${p.pageLSN} ≥ ${rec.lsn}: the disk page already reflects this change.`, rec.lsn)
        continue
      }
      const after: Cell = rec.after
      p.value = after
      p.pageLSN = rec.lsn
      emit('redo', `redo ${rec.page}`, `Reapply ${rec.page} := ${fmtCell(after)} (pageLSN → ${rec.lsn}).`, rec.lsn)
    }
  }
  emit('redo', 'redo complete', 'The database now matches its exact state at the moment of the crash.')

  // ============================== UNDO ====================================
  // Roll back the losers in reverse-LSN order, logging a CLR per change undone.
  let interrupted = false
  if (loserSet.size === 0) {
    emit('undo', 'undo complete', 'No losers — recovery is done.')
  } else {
    emit('undo', 'undo pass', `Rolling back ${losers.join(', ')} in reverse-LSN order, logging a CLR per undo.`)
    const toUndo = new Map<string, LSN>()
    for (const t of loserSet) toUndo.set(t, tt.get(t)!.lastLsn)
    let clrsWritten = 0

    while (toUndo.size > 0) {
      // Pick the largest outstanding LSN across all losers (reverse order).
      let pick = ''
      let pickLsn = -1
      for (const [t, lsn] of toUndo) {
        if (lsn > pickLsn) {
          pickLsn = lsn
          pick = t
        }
      }
      if (pickLsn <= 0) {
        // Reached the start of this transaction's chain → finish it.
        const endLsn = nextLsn++
        append({ type: 'end', lsn: endLsn, prevLsn: tt.get(pick)!.lastLsn, txn: pick })
        tt.delete(pick)
        toUndo.delete(pick)
        loserSet.delete(pick)
        emit('undo', `end ${pick}`, `${pick} fully rolled back — write its end record.`, endLsn)
        continue
      }
      const rec = byLsn.get(pickLsn)!
      if (rec.type === 'update') {
        if (opts.stopAfterUndo !== undefined && clrsWritten >= opts.stopAfterUndo) {
          interrupted = true
          emit('crash', 'crash during recovery', `Power lost mid-undo after ${clrsWritten} CLR(s). The CLRs already written are durable.`)
          break
        }
        const p = pageOf(rec.page)
        const clrLsn = nextLsn++
        const restored = rec.before
        append({
          type: 'clr',
          lsn: clrLsn,
          prevLsn: tt.get(pick)!.lastLsn,
          txn: pick,
          page: rec.page,
          before: p.value,
          after: restored,
          undoNextLsn: rec.prevLsn,
        })
        p.value = restored
        p.pageLSN = clrLsn
        tt.get(pick)!.lastLsn = clrLsn
        if (!dpt.has(rec.page)) dpt.set(rec.page, clrLsn)
        clrsWritten++
        toUndo.set(pick, rec.prevLsn)
        emit(
          'undo',
          `undo ${rec.page}`,
          `Undo ${pick}'s update at LSN ${pickLsn}: ${rec.page} := ${fmtCell(restored)}. Log CLR ${clrLsn} (undoNext → ${rec.prevLsn || 'done'}).`,
          clrLsn,
        )
      } else if (rec.type === 'clr') {
        // A CLR is redo-only: never undone. Skip straight to its undoNextLSN.
        toUndo.set(pick, rec.undoNextLsn)
        emit('undo', `skip CLR ${pickLsn}`, `LSN ${pickLsn} is a CLR (already-undone work) — jump to undoNext ${rec.undoNextLsn || 'done'}.`, pickLsn)
      } else {
        // begin / abort / commit etc. → follow the prevLSN chain.
        toUndo.set(pick, rec.prevLsn)
      }
    }
    if (!interrupted) emit('undo', 'undo complete', 'Every loser is rolled back — the database is transaction-consistent.')
  }

  if (!interrupted) emit('done', 'recovery complete', 'Recovery finished: winners durable, losers erased.')

  const resultState: DurableState = {
    log: log.slice().sort((a, b) => a.lsn - b.lsn),
    pages,
    masterRecord: state.masterRecord,
    nextLsn,
    initial: new Map(state.initial),
  }

  return { steps, state: resultState, redoLsn, losers, analysisTt, analysisDpt, interrupted }
}
