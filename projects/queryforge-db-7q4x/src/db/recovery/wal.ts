// A from-scratch ARIES write-ahead logging (WAL) engine — the durability and
// crash-recovery machinery a real disk-backed database (DB2, SQL Server, and the
// lineage PostgreSQL descends from) uses to survive a power failure without
// losing a committed transaction or leaking an uncommitted one.
//
// The model, in one paragraph: the database is a set of fixed pages, each holding
// one cell value plus a `pageLSN` (the log sequence number of the last change
// applied to it). Every change is described by a LOG RECORD *before* the page it
// touches is allowed to reach disk — that is the write-ahead rule. The log lives
// partly in volatile memory (a tail) and partly on durable disk; a commit FORCES
// the tail out so the commit decision can never be lost. The buffer pool follows
// the two policies that make ARIES interesting: STEAL (a dirty, uncommitted page
// may be written to disk to reclaim a frame) and NO-FORCE (a committed page need
// not be flushed at commit). STEAL is why crash recovery must be able to UNDO,
// and NO-FORCE is why it must be able to REDO. A periodic fuzzy CHECKPOINT
// snapshots the live transaction table and the dirty-page table so recovery need
// not scan the whole log. When the machine crashes, everything volatile vanishes
// — only the disk pages and the durably-flushed log survive — and `recovery.ts`
// reconstructs a transaction-consistent database from exactly those two things.
//
// This module is intentionally standalone (no dependency on the SQL engine) so it
// can be reasoned about — and exhaustively tested — in isolation.

/** A log sequence number. Monotonically increasing; 0 is the sentinel "none". */
export type LSN = number
export type PageId = string
/** A page holds a single cell so before/after images are trivial to reason about. */
export type Cell = number | string

/** The kinds of log record ARIES writes. */
export type LogType =
  | 'begin' // a transaction starts
  | 'update' // a redoable + undoable data change (carries before & after images)
  | 'commit' // the durable decision: this transaction's effects must survive
  | 'abort' // a transaction asked to roll back; its updates are about to be undone
  | 'clr' // a Compensation Log Record — describes (and is) the undo of one update
  | 'end' // a transaction is fully finished (its log is complete)
  | 'begin_checkpoint' // a fuzzy checkpoint opens
  | 'end_checkpoint' // … and closes, carrying the live TT + DPT snapshots

/** The transaction-table entry a checkpoint records for each live transaction. */
export interface CkptTxn {
  txn: string
  status: TxnStatus
  lastLsn: LSN
}
/** The dirty-page-table entry a checkpoint records for each dirty page. */
export interface CkptDpt {
  page: PageId
  recLsn: LSN
}

interface BaseRec {
  lsn: LSN
  /** previous log record of the *same* transaction (the backward undo chain). 0 = none. */
  prevLsn: LSN
  /** owning transaction; '' for the txn-agnostic checkpoint records. */
  txn: string
}
export interface BeginRec extends BaseRec {
  type: 'begin'
}
export interface UpdateRec extends BaseRec {
  type: 'update'
  page: PageId
  before: Cell
  after: Cell
}
export interface ClrRec extends BaseRec {
  type: 'clr'
  page: PageId
  /** the value being overwritten by this compensation (the loser's value). */
  before: Cell
  /** the value restored by undoing — i.e. the compensated update's before image. */
  after: Cell
  /** where undo continues after this CLR: the compensated update's prevLsn. 0 = done. */
  undoNextLsn: LSN
}
export interface CommitRec extends BaseRec {
  type: 'commit'
}
export interface AbortRec extends BaseRec {
  type: 'abort'
}
export interface EndRec extends BaseRec {
  type: 'end'
}
export interface BeginCkptRec extends BaseRec {
  type: 'begin_checkpoint'
}
export interface EndCkptRec extends BaseRec {
  type: 'end_checkpoint'
  txnTable: CkptTxn[]
  dpt: CkptDpt[]
}

export type LogRecord =
  | BeginRec
  | UpdateRec
  | ClrRec
  | CommitRec
  | AbortRec
  | EndRec
  | BeginCkptRec
  | EndCkptRec

export type TxnStatus = 'running' | 'committed' | 'aborting'

/** A page image: a value plus the LSN of the last log record applied to it. */
export interface Page {
  value: Cell
  pageLSN: LSN
}

/** Everything that survives a crash: the forced log + the flushed pages. */
export interface DurableState {
  /** the durably-written log, in LSN order. */
  log: LogRecord[]
  /** the page images that reached disk. */
  pages: Map<PageId, Page>
  /** LSN of the most recent *completed* begin_checkpoint, or 0 if none. */
  masterRecord: LSN
  /** the next LSN to hand out (so recovery's CLRs continue the numbering). */
  nextLsn: LSN
  /** the initial value of every page, so undo of a never-before-written page is well-defined. */
  initial: Map<PageId, Cell>
}

interface TxnEntry {
  status: TxnStatus
  lastLsn: LSN
}

/** Render a cell for narration / the UI. */
export function fmtCell(v: Cell): string {
  return typeof v === 'string' ? `'${v}'` : String(v)
}

/**
 * The running database during *normal operation*. It maintains a volatile buffer
 * pool, a volatile log tail, a transaction table and a dirty-page table, and a
 * durable disk (pages + forced log). The methods mirror what a storage engine
 * does under the covers; `recovery.ts` later consumes only what `crash()` leaves
 * behind.
 */
export class AriesDb {
  nextLsn = 1
  /** volatile: log records not yet flushed to disk. */
  logTail: LogRecord[] = []
  /** durable: the on-disk log (LSN order). */
  diskLog: LogRecord[] = []
  /** highest LSN that is durably on disk. */
  flushedUpTo: LSN = 0
  /** volatile buffer pool: the working copy of pages touched since start. */
  buffer = new Map<PageId, Page>()
  /** durable on-disk page images. */
  disk = new Map<PageId, Page>()
  /** volatile transaction table. */
  txnTable = new Map<string, TxnEntry>()
  /** volatile dirty-page table: page -> recLSN (first update since it was last clean). */
  dpt = new Map<PageId, LSN>()
  /** LSN of the latest completed begin_checkpoint. */
  masterRecord: LSN = 0
  /** the pristine initial value of every page. */
  readonly initial = new Map<PageId, Cell>()

  constructor(initial: { page: PageId; value: Cell }[]) {
    for (const p of initial) {
      this.disk.set(p.page, { value: p.value, pageLSN: 0 })
      this.initial.set(p.page, p.value)
    }
  }

  private push(rec: LogRecord): LSN {
    this.logTail.push(rec)
    if (rec.txn) {
      const t = this.txnTable.get(rec.txn)
      if (t) t.lastLsn = rec.lsn
    }
    return rec.lsn
  }

  private prevOf(txn: string): LSN {
    return this.txnTable.get(txn)?.lastLsn ?? 0
  }

  /** Bring a page into the buffer pool (copying its disk image on first touch). */
  private fetch(page: PageId): Page {
    let p = this.buffer.get(page)
    if (!p) {
      const d = this.disk.get(page)
      p = d ? { ...d } : { value: this.initial.get(page) ?? 0, pageLSN: 0 }
      this.buffer.set(page, p)
    }
    return p
  }

  /** Begin a transaction. */
  begin(txn: string): LSN {
    this.txnTable.set(txn, { status: 'running', lastLsn: 0 })
    return this.push({ type: 'begin', lsn: this.nextLsn++, prevLsn: 0, txn })
  }

  /** Update a page's cell, logging the before/after images first (write-ahead). */
  update(txn: string, page: PageId, after: Cell): LSN {
    const p = this.fetch(page)
    const before = p.value
    const lsn = this.push({
      type: 'update',
      lsn: this.nextLsn++,
      prevLsn: this.prevOf(txn),
      txn,
      page,
      before,
      after,
    })
    p.value = after
    p.pageLSN = lsn
    if (!this.dpt.has(page)) this.dpt.set(page, lsn) // recLSN = first dirtying since clean
    return lsn
  }

  /** Commit: write the commit record and FORCE the log so the decision is durable. */
  commit(txn: string): LSN {
    const lsn = this.push({ type: 'commit', lsn: this.nextLsn++, prevLsn: this.prevOf(txn), txn })
    const t = this.txnTable.get(txn)
    if (t) t.status = 'committed'
    this.flushLogUpTo(lsn) // WAL: a commit is not acknowledged until it is on disk
    // Logging the end record completes the transaction; it need not be forced.
    this.push({ type: 'end', lsn: this.nextLsn++, prevLsn: this.prevOf(txn), txn })
    this.txnTable.delete(txn)
    return lsn
  }

  /**
   * Roll back a transaction during normal operation, using the very same CLR
   * machinery recovery uses — proof that "abort" is just an undo that happens not
   * to be triggered by a crash.
   */
  rollback(txn: string): void {
    this.push({ type: 'abort', lsn: this.nextLsn++, prevLsn: this.prevOf(txn), txn })
    const t = this.txnTable.get(txn)
    if (t) t.status = 'aborting'
    let toUndo = this.prevOf(txn)
    while (toUndo > 0) {
      const rec = this.findRecord(toUndo)
      if (!rec) break
      if (rec.type === 'update') {
        const p = this.fetch(rec.page)
        const clrLsn = this.nextLsn++
        this.push({
          type: 'clr',
          lsn: clrLsn,
          prevLsn: this.prevOf(txn),
          txn,
          page: rec.page,
          before: p.value,
          after: rec.before,
          undoNextLsn: rec.prevLsn,
        })
        p.value = rec.before
        p.pageLSN = clrLsn
        if (!this.dpt.has(rec.page)) this.dpt.set(rec.page, clrLsn)
        toUndo = rec.prevLsn
      } else if (rec.type === 'clr') {
        toUndo = rec.undoNextLsn
      } else {
        toUndo = rec.prevLsn
      }
    }
    this.push({ type: 'end', lsn: this.nextLsn++, prevLsn: this.prevOf(txn), txn })
    this.txnTable.delete(txn)
  }

  /** Look a record up by LSN across both the tail and the disk log. */
  private findRecord(lsn: LSN): LogRecord | undefined {
    return (
      this.logTail.find((r) => r.lsn === lsn) ?? this.diskLog.find((r) => r.lsn === lsn)
    )
  }

  /** Move every tail record with lsn <= target onto the durable disk log. */
  flushLogUpTo(target: LSN): void {
    if (target <= this.flushedUpTo) return
    const keep: LogRecord[] = []
    for (const rec of this.logTail) {
      if (rec.lsn <= target) this.diskLog.push(rec)
      else keep.push(rec)
    }
    this.logTail = keep
    this.flushedUpTo = Math.max(this.flushedUpTo, target)
  }

  /** Force the entire log tail to disk. */
  flushLog(): void {
    this.flushLogUpTo(this.nextLsn - 1)
  }

  /**
   * Flush one dirty page to disk (a STEAL if the owning txn hasn't committed). The
   * write-ahead rule is honoured: the log is forced up to the page's pageLSN first,
   * so the change is recoverable even if this very page is the uncommitted one.
   */
  flushPage(page: PageId): void {
    const p = this.buffer.get(page)
    if (!p) return
    this.flushLogUpTo(p.pageLSN) // write-ahead logging
    this.disk.set(page, { value: p.value, pageLSN: p.pageLSN })
    this.dpt.delete(page) // the on-disk copy is now current → no longer dirty
  }

  /**
   * Take a fuzzy checkpoint: bracket a snapshot of the transaction table and
   * dirty-page table between a begin/end checkpoint pair and force it. Recovery
   * can then start its analysis here instead of at the dawn of the log.
   */
  checkpoint(): LSN {
    const begin = this.push({
      type: 'begin_checkpoint',
      lsn: this.nextLsn++,
      prevLsn: 0,
      txn: '',
    })
    const txnTable: CkptTxn[] = [...this.txnTable.entries()].map(([txn, e]) => ({
      txn,
      status: e.status,
      lastLsn: e.lastLsn,
    }))
    const dpt: CkptDpt[] = [...this.dpt.entries()].map(([page, recLsn]) => ({ page, recLsn }))
    this.push({
      type: 'end_checkpoint',
      lsn: this.nextLsn++,
      prevLsn: 0,
      txn: '',
      txnTable,
      dpt,
    })
    this.flushLog() // checkpoint records must be durable to be useful
    this.masterRecord = begin
    return begin
  }

  /**
   * Pull the plug. Everything volatile (the buffer pool, the log tail, the TT and
   * DPT) evaporates; only the flushed pages and the forced log remain. Returns the
   * durable state recovery will rebuild from.
   */
  crash(): DurableState {
    return {
      log: this.diskLog.map((r) => ({ ...r })),
      pages: new Map([...this.disk].map(([k, v]) => [k, { ...v }])),
      masterRecord: this.masterRecord,
      nextLsn: this.nextLsn,
      initial: new Map(this.initial),
    }
  }
}
