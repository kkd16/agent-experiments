// **Strict Two-Phase Locking** — the classic *pessimistic* protocol.
//
// Every read takes a **shared** (S) lock, every write an **exclusive** (X) lock,
// and — the "strict" part — *all* locks are held until the transaction commits or
// aborts. Two-phase (grow-then-shrink) locking is what makes the schedule
// serializable; holding to end-of-transaction (strict 2PL) additionally makes it
// **recoverable and cascadeless** (nobody reads or overwrites an uncommitted
// value). The price is *blocking*: a lock request that conflicts waits, and
// waits can form a cycle — a **deadlock** the scheduler breaks by aborting a
// victim.
//
// Phantoms are handled the way a real lock manager does it, with a coarse
// **predicate lock**: a predicate read S-locks the synthetic `#index` guard (and
// every row it currently matches), while a structural insert/delete X-locks
// `#index` — so an insert into a range someone is scanning must wait.

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

export const S2PL_META: ProtocolMeta = {
  id: 's2pl',
  name: 'Strict Two-Phase Locking',
  short: 'S2PL',
  family: 'pessimistic',
  tagline: 'lock to read, lock to write, hold until commit',
  blurb:
    'Reads take shared locks, writes take exclusive locks, and every lock is held to end-of-transaction. Conflicts block rather than abort, so it is recoverable and cascadeless — at the cost of deadlocks, which are detected on the waits-for graph and broken by aborting a victim.',
  conflictReaction: 'block',
  guarantees: { serializable: true, recoverable: true, cascadeless: true, deadlockFree: false },
}

type Mode = 'S' | 'X'
interface LockEntry {
  mode: Mode
  holders: Set<string>
}

/** A minimal shared/exclusive lock manager with in-place upgrades. */
export class LockManager {
  private readonly locks = new Map<string, LockEntry>()

  /** Which *other* holders currently block `label` from taking `item` in `mode`
   *  (empty ⇒ the request is grantable right now). */
  private blockers(label: string, item: string, mode: Mode): string[] {
    const e = this.locks.get(item)
    if (!e || e.holders.size === 0) return []
    const others = [...e.holders].filter((h) => h !== label)
    if (mode === 'S') {
      // A shared lock is refused only by someone else's exclusive lock.
      return e.mode === 'X' && others.length > 0 ? others : []
    }
    // An exclusive lock (fresh or an S→X upgrade) is refused by any other holder.
    return others
  }

  private grant(label: string, item: string, mode: Mode): void {
    let e = this.locks.get(item)
    if (!e) {
      e = { mode, holders: new Set() }
      this.locks.set(item, e)
    }
    e.holders.add(label)
    // Locks only ever strengthen: an X→S request by the same holder (reading an
    // item it already wrote) must keep the X lock, never downgrade it.
    if (mode === 'X') e.mode = 'X'
  }

  /** All-or-nothing acquisition of a bundle of lock requests: if any request
   *  would block, none are taken and the union of blockers is returned. Because
   *  strict 2PL only releases at end-of-transaction, retrying the whole bundle on
   *  resume is safe (a lock already held is a no-op). */
  acquireAll(
    label: string,
    reqs: { item: string; mode: Mode }[],
  ): { ok: true } | { ok: false; blockers: string[] } {
    const blockers = new Set<string>()
    for (const r of reqs) for (const b of this.blockers(label, r.item, r.mode)) blockers.add(b)
    if (blockers.size) return { ok: false, blockers: [...blockers] }
    for (const r of reqs) this.grant(label, r.item, r.mode)
    return { ok: true }
  }

  release(label: string): void {
    for (const [item, e] of [...this.locks]) {
      if (!e.holders.delete(label)) continue
      if (e.holders.size === 0) this.locks.delete(item)
      else e.mode = 'S' // an X lock has a single holder; survivors can only be S
    }
  }

  /** Render-ready snapshot of the lock table. */
  view(): { item: string; mode: Mode; holders: string[] }[] {
    return [...this.locks.entries()]
      .map(([item, e]) => ({ item, mode: e.mode, holders: [...e.holders] }))
      .sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0))
  }
}

interface Txn {
  status: TxnStatus
  written: Set<string>
  undo: { key: string; had: boolean; prev: Val }[]
}

export class TwoPhaseLockEngine implements ProtocolEngine {
  readonly meta = S2PL_META
  private readonly lm = new LockManager()
  private readonly data = new Map<string, Val>()
  private readonly txns = new Map<string, Txn>()

  seed(key: string, value: Val): void {
    this.data.set(key, value)
  }

  begin(label: string): void {
    this.txns.set(label, { status: 'active', written: new Set(), undo: [] })
  }

  status(label: string): TxnStatus {
    return this.txns.get(label)?.status ?? 'active'
  }

  read(label: string, key: string): EngineStep {
    const acq = this.lm.acquireAll(label, [{ item: key, mode: 'S' }])
    if (!acq.ok) return { status: 'blocked', waitsFor: acq.blockers }
    const found = this.data.has(key)
    return {
      status: 'ok',
      touched: [{ kind: 'r', item: key }],
      read: { found, value: found ? this.data.get(key)! : null },
    }
  }

  readWhere(label: string, pred: Predicate): EngineStep {
    const matching = [...this.data.entries()].filter(([, v]) => pred.test(v))
    const reqs: { item: string; mode: Mode }[] = [{ item: INDEX_GUARD, mode: 'S' }]
    for (const [k] of matching) reqs.push({ item: k, mode: 'S' })
    const acq = this.lm.acquireAll(label, reqs)
    if (!acq.ok) return { status: 'blocked', waitsFor: acq.blockers }
    const rows = matching
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const touched: Touch[] = [{ kind: 'r', item: INDEX_GUARD }]
    for (const [k] of matching) touched.push({ kind: 'r', item: k })
    return { status: 'ok', touched, rows }
  }

  write(label: string, key: string, value: Val): EngineStep {
    return this.mutate(label, key, value, false)
  }

  del(label: string, key: string): EngineStep {
    return this.mutate(label, key, null, true)
  }

  private mutate(label: string, key: string, value: Val, deleted: boolean): EngineStep {
    const exists = this.data.has(key)
    const structural = deleted ? exists : !exists
    const reqs: { item: string; mode: Mode }[] = [{ item: key, mode: 'X' }]
    if (structural) reqs.push({ item: INDEX_GUARD, mode: 'X' })
    const acq = this.lm.acquireAll(label, reqs)
    if (!acq.ok) return { status: 'blocked', waitsFor: acq.blockers }
    const t = this.txns.get(label)!
    if (!t.written.has(key)) {
      t.undo.push({ key, had: exists, prev: exists ? this.data.get(key)! : null })
      t.written.add(key)
    }
    if (deleted) this.data.delete(key)
    else this.data.set(key, value)
    const touched: Touch[] = [{ kind: 'w', item: key }]
    if (structural) touched.push({ kind: 'w', item: INDEX_GUARD })
    return { status: 'ok', touched }
  }

  commit(label: string): EngineStep {
    const t = this.txns.get(label)
    if (!t || t.status !== 'active') return { status: 'ok', touched: [] }
    t.status = 'committed'
    this.lm.release(label)
    return { status: 'ok', touched: [] }
  }

  abort(label: string): string[] {
    const t = this.txns.get(label)
    if (!t || t.status !== 'active') return []
    for (let i = t.undo.length - 1; i >= 0; i--) {
      const u = t.undo[i]
      if (u.had) this.data.set(u.key, u.prev)
      else this.data.delete(u.key)
    }
    t.status = 'aborted'
    this.lm.release(label)
    return [] // strict 2PL never cascades
  }

  committedRows(): { key: string; value: Val }[] {
    // Roll back any still-active transaction for a clean committed-state view.
    const view = new Map(this.data)
    for (const [, t] of this.txns) {
      if (t.status !== 'active') continue
      for (let i = t.undo.length - 1; i >= 0; i--) {
        const u = t.undo[i]
        if (u.had) view.set(u.key, u.prev)
        else view.delete(u.key)
      }
    }
    return [...view.entries()]
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  }

  lockView(): { item: string; mode: Mode; holders: string[] }[] {
    return this.lm.view()
  }
}
