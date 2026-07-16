// **Basic Timestamp Ordering** (Bernstein & Goodman) — the *timestamp* protocol.
//
// Every transaction is stamped with a unique timestamp at BEGIN, and the system
// forces every pair of conflicting operations to execute *as if* in timestamp
// order. Each item carries a read-timestamp `rts` (the newest reader) and a
// write-timestamp `wts` (the newest writer):
//
//   • read(Ti, x):  if ts(Ti) < wts(x) — a *younger* transaction already wrote x,
//                   so reading now would be out of order — **abort Ti**; else read
//                   and bump rts(x).
//   • write(Ti, x): if ts(Ti) < rts(x) — someone younger already read x — **abort
//                   Ti**; else if ts(Ti) < wts(x) — a younger write already
//                   supersedes ours — **ignore** it (the **Thomas write rule**);
//                   else write and bump wts(x).
//
// It never blocks, so it can never deadlock — conflicts are resolved by aborting.
// Crucially, basic T/O writes are visible immediately, so it permits **dirty
// reads** and is therefore *not* recoverable: when a transaction aborts, everyone
// who read its uncommitted writes must **cascade-abort** too. That is the whole
// point of including it here — it is serializable yet, unlike 2PL and OCC, not
// recoverable, which the lab and self-tests make visible.

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

export const TO_META: ProtocolMeta = {
  id: 'to',
  name: 'Basic Timestamp Ordering',
  short: 'T/O',
  family: 'timestamp',
  tagline: 'stamp on BEGIN, force conflicts into timestamp order',
  blurb:
    'Each transaction gets a timestamp at BEGIN; per-item read/write timestamps force conflicting operations into that order, aborting whichever operation arrives out of order (with the Thomas write rule ignoring obsolete writes). It never blocks, so it never deadlocks — but writes are visible immediately, so it permits dirty reads and must cascade-abort, making it serializable yet not recoverable.',
  conflictReaction: 'abort',
  guarantees: { serializable: true, recoverable: false, cascadeless: false, deadlockFree: true },
}

interface Item {
  value: Val
  exists: boolean
  rts: number
  wts: number
  /** the uncommitted transaction that last wrote this item (null once committed) */
  writer: string | null
}

interface Txn {
  ts: number
  status: TxnStatus
  written: Set<string>
  undo: { key: string; had: boolean; prev: Val }[]
  /** uncommitted transactions whose writes this one has read (cascade sources) */
  readFrom: Set<string>
}

export class TimestampEngine implements ProtocolEngine {
  readonly meta = TO_META
  private readonly items = new Map<string, Item>()
  private readonly txns = new Map<string, Txn>()
  private tsSeq = 0

  private item(key: string): Item {
    let it = this.items.get(key)
    if (!it) {
      it = { value: null, exists: false, rts: 0, wts: 0, writer: null }
      this.items.set(key, it)
    }
    return it
  }

  seed(key: string, value: Val): void {
    this.items.set(key, { value, exists: true, rts: 0, wts: 0, writer: null })
  }

  begin(label: string): void {
    this.txns.set(label, {
      ts: ++this.tsSeq,
      status: 'active',
      written: new Set(),
      undo: [],
      readFrom: new Set(),
    })
  }

  status(label: string): TxnStatus {
    return this.txns.get(label)?.status ?? 'active'
  }

  read(label: string, key: string): EngineStep {
    const t = this.txns.get(label)!
    const it = this.item(key)
    if (t.ts < it.wts) {
      t.status = 'aborted'
      return { status: 'abort', reason: `read too late — ${key} was written by a newer transaction` }
    }
    it.rts = Math.max(it.rts, t.ts)
    if (it.writer && it.writer !== label) t.readFrom.add(it.writer)
    return {
      status: 'ok',
      touched: [{ kind: 'r', item: key }],
      read: { found: it.exists, value: it.exists ? it.value : null },
    }
  }

  readWhere(label: string, pred: Predicate): EngineStep {
    const t = this.txns.get(label)!
    const guard = this.item(INDEX_GUARD)
    if (t.ts < guard.wts) {
      t.status = 'aborted'
      return { status: 'abort', reason: 'predicate read too late — the range changed under a newer transaction' }
    }
    guard.rts = Math.max(guard.rts, t.ts)
    if (guard.writer && guard.writer !== label) t.readFrom.add(guard.writer)
    const rows: { key: string; value: Val }[] = []
    const touched: Touch[] = [{ kind: 'r', item: INDEX_GUARD }]
    for (const [key, it] of [...this.items.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (key === INDEX_GUARD || !it.exists) continue
      // reading a matching row also stamps/records that row, so a later update of
      // it is ordered against this predicate read.
      if (t.ts >= it.wts) {
        it.rts = Math.max(it.rts, t.ts)
        touched.push({ kind: 'r', item: key })
        if (it.writer && it.writer !== label) t.readFrom.add(it.writer)
        if (pred.test(it.value)) rows.push({ key, value: it.value })
      }
    }
    return { status: 'ok', touched, rows }
  }

  write(label: string, key: string, value: Val): EngineStep {
    return this.mutate(label, key, value, false)
  }

  del(label: string, key: string): EngineStep {
    return this.mutate(label, key, null, true)
  }

  private mutate(label: string, key: string, value: Val, deleted: boolean): EngineStep {
    const t = this.txns.get(label)!
    const it = this.item(key)
    if (t.ts < it.rts) {
      t.status = 'aborted'
      return { status: 'abort', reason: `write too late — a newer transaction already read ${key}` }
    }
    const structural = deleted ? it.exists : !it.exists
    if (t.ts < it.wts) {
      // Thomas write rule: a newer write already supersedes ours — safely skip it.
      return { status: 'ok', touched: [], note: `obsolete write to ${key} ignored (Thomas rule)` }
    }
    if (!t.written.has(key)) {
      t.undo.push({ key, had: it.exists, prev: it.exists ? it.value : null })
      t.written.add(key)
    }
    it.value = deleted ? null : value
    it.exists = !deleted
    it.wts = t.ts
    it.writer = label
    const touched: Touch[] = [{ kind: 'w', item: key }]
    if (structural) {
      const guard = this.item(INDEX_GUARD)
      if (t.ts >= guard.rts) {
        guard.wts = Math.max(guard.wts, t.ts)
        guard.writer = label
        touched.push({ kind: 'w', item: INDEX_GUARD })
      }
    }
    return { status: 'ok', touched }
  }

  commit(label: string): EngineStep {
    const t = this.txns.get(label)
    if (!t || t.status !== 'active') return { status: 'ok', touched: [] }
    t.status = 'committed'
    // Our writes are now durable: clear our uncommitted-writer stamps, and drop
    // the read-from edges that pointed at us everywhere (reading a committed
    // value is safe and no longer a cascade source).
    for (const it of this.items.values()) if (it.writer === label) it.writer = null
    for (const other of this.txns.values()) other.readFrom.delete(label)
    return { status: 'ok', touched: [] }
  }

  abort(label: string): string[] {
    const t = this.txns.get(label)
    if (!t || t.status === 'aborted') return []
    // Undo our writes where we are still the current writer.
    for (let i = t.undo.length - 1; i >= 0; i--) {
      const u = t.undo[i]
      const it = this.items.get(u.key)
      if (!it || it.writer !== label) continue
      it.value = u.had ? u.prev : null
      it.exists = u.had
      it.writer = null
    }
    for (const it of this.items.values()) if (it.writer === label) it.writer = null
    t.status = 'aborted'
    // Cascade: anyone who read one of our uncommitted writes must abort too.
    const cascaded: string[] = []
    for (const [other, ot] of this.txns) {
      if (other === label || ot.status !== 'active') continue
      if (ot.readFrom.has(label)) {
        cascaded.push(other, ...this.abort(other))
      }
    }
    return cascaded
  }

  committedRows(): { key: string; value: Val }[] {
    // Roll back still-active transactions for a clean committed-state view.
    const view = new Map<string, Val>()
    for (const [key, it] of this.items) if (key !== INDEX_GUARD && it.exists) view.set(key, it.value)
    for (const [, t] of this.txns) {
      if (t.status !== 'active') continue
      for (let i = t.undo.length - 1; i >= 0; i--) {
        const u = t.undo[i]
        const it = this.items.get(u.key)
        if (!it || it.writer !== null) continue
        if (u.had) view.set(u.key, u.prev)
        else view.delete(u.key)
      }
    }
    return [...view.entries()]
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  }
}
