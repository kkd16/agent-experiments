// **Optimistic Concurrency Control** (Kung & Robinson, 1981) with **backward
// validation**.
//
// A transaction runs in three phases. In the **read phase** it never touches
// shared data: reads come from the committed store (or its own private writes)
// and writes go to a private workspace, so nothing it does is visible and it
// never blocks. At commit it enters the **validation phase**: it checks its read
// set against the write sets of every transaction that committed *after it
// started*. If any of those overwrote something it read, the optimistic bet lost
// and it **aborts** (discard the workspace — no undo, nothing was public).
// Otherwise it enters the **write phase**, atomically publishing its workspace.
//
// Because writes only become visible atomically at commit, OCC is serializable
// (in commit order), recoverable, and cascadeless — and, being lock-free, it can
// never deadlock. Its weakness is the mirror image of 2PL's: under contention it
// *wastes* work, aborting late instead of blocking early.

import type { Val } from '../concurrency/mvcc'
import {
  INDEX_GUARD,
  type EngineStep,
  type Predicate,
  type ProtocolEngine,
  type ProtocolMeta,
  type Touch,
  type TxnStatus,
} from './types'

export const OCC_META: ProtocolMeta = {
  id: 'occ',
  name: 'Optimistic Concurrency Control',
  short: 'OCC',
  family: 'optimistic',
  tagline: 'run freely, validate at commit, abort if you lost the bet',
  blurb:
    'Transactions read committed data and buffer writes privately, never blocking. At commit, backward validation checks the read set against everything committed since the transaction began; a conflict aborts it, otherwise the workspace is published atomically. Lock-free and cascadeless, so it never deadlocks — but it can waste work under contention.',
  conflictReaction: 'abort',
  guarantees: { serializable: true, recoverable: true, cascadeless: true, deadlockFree: true },
}

interface WriteRec {
  value: Val
  deleted: boolean
  structural: boolean
}

interface Txn {
  status: TxnStatus
  /** the global commit counter value observed at BEGIN (backward-validation base) */
  startSeq: number
  readSet: Set<string>
  /** private workspace: key → buffered write */
  writeSet: Map<string, WriteRec>
}

export class OptimisticEngine implements ProtocolEngine {
  readonly meta = OCC_META
  private readonly committed = new Map<string, Val>()
  private readonly txns = new Map<string, Txn>()
  /** log of committed transactions in commit order, with their write sets */
  private readonly history: { label: string; seq: number; writes: Set<string> }[] = []
  private commitSeq = 0

  seed(key: string, value: Val): void {
    this.committed.set(key, value)
  }

  begin(label: string): void {
    this.txns.set(label, {
      status: 'active',
      startSeq: this.commitSeq,
      readSet: new Set(),
      writeSet: new Map(),
    })
  }

  status(label: string): TxnStatus {
    return this.txns.get(label)?.status ?? 'active'
  }

  /** The value a transaction sees: its own buffered write, else committed data. */
  private visible(t: Txn, key: string): { found: boolean; value: Val } {
    const w = t.writeSet.get(key)
    if (w) return w.deleted ? { found: false, value: null } : { found: true, value: w.value }
    return this.committed.has(key)
      ? { found: true, value: this.committed.get(key)! }
      : { found: false, value: null }
  }

  read(label: string, key: string): EngineStep {
    const t = this.txns.get(label)!
    t.readSet.add(key)
    const v = this.visible(t, key)
    return { status: 'ok', touched: [{ kind: 'r', item: key }], read: v }
  }

  readWhere(label: string, pred: Predicate): EngineStep {
    const t = this.txns.get(label)!
    t.readSet.add(INDEX_GUARD)
    const keys = new Set<string>([...this.committed.keys(), ...t.writeSet.keys()])
    const rows: { key: string; value: Val }[] = []
    const touched: Touch[] = [{ kind: 'r', item: INDEX_GUARD }]
    for (const key of [...keys].sort()) {
      const v = this.visible(t, key)
      t.readSet.add(key)
      touched.push({ kind: 'r', item: key })
      if (v.found && pred.test(v.value)) rows.push({ key, value: v.value })
    }
    return { status: 'ok', touched, rows }
  }

  write(label: string, key: string, value: Val): EngineStep {
    return this.buffer(label, key, value, false)
  }

  del(label: string, key: string): EngineStep {
    return this.buffer(label, key, null, true)
  }

  private buffer(label: string, key: string, value: Val, deleted: boolean): EngineStep {
    const t = this.txns.get(label)!
    const exists = this.visible(t, key).found
    const structural = deleted ? exists : !exists
    t.writeSet.set(key, { value, deleted, structural })
    // The write is private for now; its access is recorded (and reported to the
    // oracle) only when the workspace is published at commit.
    return { status: 'ok', touched: [] }
  }

  commit(label: string): EngineStep {
    const t = this.txns.get(label)
    if (!t || t.status !== 'active') return { status: 'ok', touched: [] }

    // Backward validation: any transaction that committed after we began must not
    // have written anything we read.
    for (const h of this.history) {
      if (h.seq <= t.startSeq) continue
      for (const r of t.readSet) {
        if (h.writes.has(r)) {
          t.status = 'aborted'
          return {
            status: 'abort',
            reason: `validation failed — ${h.label} overwrote ${r} after ${label} began`,
          }
        }
      }
    }

    // Write phase: publish the workspace atomically and record the accesses.
    const touched: Touch[] = []
    const writes = new Set<string>()
    for (const [key, w] of t.writeSet) {
      if (w.deleted) this.committed.delete(key)
      else this.committed.set(key, w.value)
      touched.push({ kind: 'w', item: key })
      writes.add(key)
      if (w.structural) {
        touched.push({ kind: 'w', item: INDEX_GUARD })
        writes.add(INDEX_GUARD)
      }
    }
    t.status = 'committed'
    this.history.push({ label, seq: ++this.commitSeq, writes })
    return { status: 'ok', touched }
  }

  abort(label: string): string[] {
    const t = this.txns.get(label)
    if (t && t.status === 'active') t.status = 'aborted'
    return [] // nothing was ever published, so no undo and no cascade
  }

  committedRows(): { key: string; value: Val }[] {
    return [...this.committed.entries()]
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  }
}
