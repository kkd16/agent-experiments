// The recovery runner: it plays a scenario's workload against a live AriesDb
// (emitting a per-op snapshot of the log, buffer pool, disk, transaction table and
// dirty-page table), pulls the plug at the CRASH op, then hands the durable
// wreckage to `recover()` and appends its analysis/redo/undo trace — producing one
// continuous, scrubbable timeline from "normal operation" all the way to "database
// restored". An independent oracle computes what the post-recovery state *must* be,
// so every run carries its own correctness verdict.

import {
  AriesDb,
  type Cell,
  type DurableState,
  type LogRecord,
  type LSN,
  type PageId,
} from './wal'
import {
  recover,
  type LogRow,
  type Phase,
  type RecStep,
  type RecWorld,
  type TtRow,
} from './recovery'
import type { RecScenario, WlOp } from './scenarios'

export type { RecStep, RecWorld, Phase } from './recovery'

export interface CellRow {
  page: PageId
  value: Cell
}

export interface RunResult {
  steps: RecStep[]
  /** the independently-computed correct state after recovery. */
  truth: CellRow[]
  /** the state ARIES actually recovered. */
  recovered: CellRow[]
  consistent: boolean
  winners: string[]
  losers: string[]
  redoLsn: LSN
  /** index into `steps` of the (first) crash step. */
  crashIndex: number
  verdict: string
  verdictKind: 'consistent' | 'corrupt'
}

/** Snapshot a live AriesDb (during the normal-operation phase) into a RecWorld. */
function snapshotDb(db: AriesDb, phase: Phase, highlightLsn?: LSN): RecWorld {
  const all: LogRecord[] = [...db.diskLog, ...db.logTail].slice().sort((a, b) => a.lsn - b.lsn)
  const durableLsns = new Set(db.diskLog.map((r) => r.lsn))
  const log: LogRow[] = all.map((rec) => ({
    rec,
    durable: durableLsns.has(rec.lsn),
    generated: false,
  }))
  const pageIds = new Set<PageId>([...db.disk.keys(), ...db.buffer.keys()])
  const pages = [...pageIds]
    .sort((a, b) => (a < b ? -1 : 1))
    .map((page) => {
      const disk = db.disk.get(page) ?? { value: db.initial.get(page) ?? 0, pageLSN: 0 }
      const buffer = db.buffer.get(page)
      return { page, disk: { ...disk }, buffer: buffer ? { ...buffer } : undefined, dirty: db.dpt.has(page) }
    })
  const txnTable: TtRow[] = [...db.txnTable.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([txn, e]) => ({ txn, status: e.status, lastLsn: e.lastLsn }))
  const dpt = [...db.dpt.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([page, recLsn]) => ({ page, recLsn }))
  return { phase, log, pages, txnTable, dpt, highlightLsn }
}

const opTitle = (op: WlOp): string => {
  switch (op.kind) {
    case 'begin':
      return `begin ${op.t}`
    case 'update':
      return `${op.t}: ${op.page} := ${fmt(op.value)}`
    case 'commit':
      return `commit ${op.t}`
    case 'abort':
      return `rollback ${op.t}`
    case 'flushPage':
      return `flush page ${op.page}`
    case 'flushLog':
      return `flush log`
    case 'checkpoint':
      return `checkpoint`
    case 'crash':
      return `✸ CRASH`
  }
}

function fmt(v: Cell): string {
  return typeof v === 'string' ? `'${v}'` : String(v)
}

/** Independently compute the state recovery is obliged to produce. */
function computeTruth(scenario: RecScenario): CellRow[] {
  const committed = new Set<string>()
  for (const op of scenario.ops) {
    if (op.kind === 'crash') break
    if (op.kind === 'commit') committed.add(op.t)
  }
  const value = new Map<PageId, Cell>()
  for (const p of scenario.initial) value.set(p.page, p.value)
  for (const op of scenario.ops) {
    if (op.kind === 'crash') break
    if (op.kind === 'update' && committed.has(op.t)) value.set(op.page, op.value)
  }
  return [...value.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([page, v]) => ({ page, value: v }))
}

function pagesToRows(state: DurableState): CellRow[] {
  const rows: CellRow[] = []
  const ids = new Set<PageId>([...state.pages.keys(), ...state.initial.keys()])
  for (const id of [...ids].sort((a, b) => (a < b ? -1 : 1))) {
    const p = state.pages.get(id)
    rows.push({ page: id, value: p ? p.value : (state.initial.get(id) ?? 0) })
  }
  return rows
}

export function runScenario(scenario: RecScenario): RunResult {
  const db = new AriesDb(scenario.initial)
  const steps: RecStep[] = []
  let seq = 0
  let crashIndex = -1

  const detailFor = (op: WlOp): string => {
    switch (op.kind) {
      case 'begin':
        return `${op.t} starts and is entered in the transaction table.`
      case 'update':
        return `Log the before/after image, then change ${op.page} in the buffer (write-ahead). ${op.page} becomes dirty.`
      case 'commit':
        return `Write the commit record and FORCE the log to disk — the durable point of no return.`
      case 'abort':
        return `Roll ${op.t} back during normal operation, logging a CLR for each change undone.`
      case 'flushPage':
        return `Write page ${op.page} to disk (a STEAL if its writer is uncommitted); the log is forced up to its pageLSN first.`
      case 'flushLog':
        return `Force the volatile log tail out to the durable log.`
      case 'checkpoint':
        return `Take a fuzzy checkpoint: snapshot the transaction table + dirty-page table between a begin/end_checkpoint pair.`
      case 'crash':
        return `The buffer pool, the log tail and both in-memory tables vanish. Only the flushed pages and the forced log survive.`
    }
  }

  // ---- normal operation -----------------------------------------------------
  for (const op of scenario.ops) {
    if (op.kind === 'crash') {
      crashIndex = seq
      steps.push({ seq: seq++, phase: 'crash', title: opTitle(op), detail: detailFor(op), world: snapshotDb(db, 'crash') })
      break
    }
    switch (op.kind) {
      case 'begin':
        db.begin(op.t)
        break
      case 'update':
        db.update(op.t, op.page, op.value)
        break
      case 'commit':
        db.commit(op.t)
        break
      case 'abort':
        db.rollback(op.t)
        break
      case 'flushPage':
        db.flushPage(op.page)
        break
      case 'flushLog':
        db.flushLog()
        break
      case 'checkpoint':
        db.checkpoint()
        break
    }
    steps.push({ seq: seq++, phase: 'run', title: opTitle(op), detail: detailFor(op), world: snapshotDb(db, 'run') })
  }

  // ---- crash recovery -------------------------------------------------------
  const durable = db.crash()
  let finalState: DurableState
  let redoLsn: LSN
  let losers: string[]

  if (scenario.recoveryCrash !== undefined) {
    const first = recover(durable, { stopAfterUndo: scenario.recoveryCrash, seq0: seq })
    for (const s of first.steps) steps.push(s)
    seq = first.steps.length ? first.steps[first.steps.length - 1].seq + 1 : seq
    // Restart: recovery runs again against the (durable) partial-recovery state.
    const second = recover(first.state, { seq0: seq })
    for (const s of second.steps) steps.push(s)
    finalState = second.state
    redoLsn = second.redoLsn
    losers = first.losers
  } else {
    const res = recover(durable, { seq0: seq })
    for (const s of res.steps) steps.push(s)
    finalState = res.state
    redoLsn = res.redoLsn
    losers = res.losers
  }

  // ---- verdict --------------------------------------------------------------
  const truth = computeTruth(scenario)
  const recovered = pagesToRows(finalState).filter((r) => truth.some((t) => t.page === r.page))
  const truthMap = new Map(truth.map((t) => [t.page, t.value]))
  const consistent = recovered.every((r) => truthMap.get(r.page) === r.value) && recovered.length === truth.length

  const committed = new Set<string>()
  for (const op of scenario.ops) {
    if (op.kind === 'crash') break
    if (op.kind === 'commit') committed.add(op.t)
  }
  const winners = [...committed].sort()

  const verdict = consistent
    ? `Recovered consistently — every page matches the only correct outcome. Winners (${
        winners.length ? winners.join(', ') : 'none'
      }) durable; losers (${losers.length ? losers.join(', ') : 'none'}) erased.`
    : `Recovery diverged from the correct state — durability or atomicity was violated.`

  return {
    steps,
    truth,
    recovered,
    consistent,
    winners,
    losers,
    redoLsn,
    crashIndex,
    verdict,
    verdictKind: consistent ? 'consistent' : 'corrupt',
  }
}
