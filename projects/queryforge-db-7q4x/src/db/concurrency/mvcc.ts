// A from-scratch multi-version concurrency control (MVCC) engine — the same
// machinery a real heap-storage database (PostgreSQL in particular) uses to let
// many transactions run at once without trampling each other.
//
// The model, in one paragraph: every logical row (keyed by a string) is a
// CHAIN of versions. A version carries `xmin` (the id of the transaction that
// created it) and `xmax` (the id of the transaction that superseded/deleted it,
// or 0 if it is still live). A transaction reads through a SNAPSHOT — the set of
// transactions whose commits it is allowed to see — and a version is visible iff
// its creator is visible and its deleter is not. Writers append a new version
// and stamp the old one's `xmax`; an uncommitted writer holds a row LOCK so a
// second writer must wait (and may deadlock). Four isolation levels fall out of
// *when* a snapshot is taken and *how* write conflicts are resolved, and
// SERIALIZABLE adds Cahill's Serializable Snapshot Isolation (SSI): it watches
// for read/write "antidependency" edges and aborts a transaction when a
// dangerous structure forms, so the only schedules that commit are serializable.
//
// This module is intentionally standalone (no dependency on the SQL engine) so
// it can be reasoned about — and tested — in isolation.

export type IsolationLevel =
  | 'READ UNCOMMITTED'
  | 'READ COMMITTED'
  | 'REPEATABLE READ'
  | 'SERIALIZABLE'

export const ISOLATION_LEVELS: IsolationLevel[] = [
  'READ UNCOMMITTED',
  'READ COMMITTED',
  'REPEATABLE READ',
  'SERIALIZABLE',
]

/** Short codes used in the UI / narration. */
export const LEVEL_ABBR: Record<IsolationLevel, string> = {
  'READ UNCOMMITTED': 'RU',
  'READ COMMITTED': 'RC',
  'REPEATABLE READ': 'RR',
  'SERIALIZABLE': 'SER',
}

/** The payload a row carries. Kept deliberately simple so the lab can focus on
 *  the *interleaving* rather than the SQL. */
export type Val = number | string | boolean | null

/** One entry in a row's version chain. */
export interface Version {
  /** transaction that created this version */
  xmin: number
  /** transaction that deleted/superseded it (0 = still live) */
  xmax: number
  /** the value (ignored when `deleted`) */
  value: Val
  /** true for a tombstone produced by DELETE */
  deleted: boolean
  /** monotonically increasing id, for stable rendering */
  seq: number
}

export type TxnStatus = 'active' | 'committed' | 'aborted'

export interface Txn {
  id: number
  label: string
  level: IsolationLevel
  status: TxnStatus
  /** logical start time (assigned at BEGIN) */
  startTs: number
  /** logical commit time (0 until committed) */
  commitTs: number
  /** snapshot frozen at BEGIN — used by RR/SER (and as a base for RC reads) */
  snapshot: Set<number>
  /** keys this txn point-read */
  reads: Set<string>
  /** keys this txn wrote */
  writes: Set<string>
  /** predicate (range) reads, for phantom / write-skew antidependency tracking */
  predReads: { label: string; test: (v: Val) => boolean }[]
  /** reason recorded if the txn was aborted by the system */
  abortReason?: string
}

/** A read/write antidependency: `from` read a version that `to` overwrote. */
export interface RwEdge {
  from: number
  to: number
}

/** Result of attempting a write/delete: it may succeed, block on a lock, or
 *  abort the caller (serialization failure / deadlock). */
export type WriteOutcome =
  | { status: 'ok' }
  | { status: 'blocked'; waitsFor: number }
  | { status: 'abort'; reason: string }

export interface ReadOutcome {
  found: boolean
  value: Val
}

export interface PredReadOutcome {
  rows: { key: string; value: Val }[]
}

/**
 * The MVCC store + transaction manager. Methods are *non-throwing*: they return
 * outcome objects so a scheduler can react to blocks and aborts. The store knows
 * nothing about scheduling; the {@link runScenario} runner drives it.
 */
export class MvccStore {
  private txnSeq = 0
  private tsSeq = 0
  private versionSeq = 0
  /** key -> version chain (oldest first) */
  readonly table = new Map<string, Version[]>()
  readonly txns = new Map<number, Txn>()
  /** key -> id of the active transaction currently holding the write lock */
  readonly writeLocks = new Map<string, number>()
  /** rw-antidependency edges (deduped) */
  private readonly rwEdges = new Set<string>()
  /** write-precedence + read-from edges, for the serializability cycle check */
  private readonly precedence = new Set<string>()

  /** Seed an initial committed row (created by the system "txn 0"). */
  seed(key: string, value: Val): void {
    this.table.set(key, [
      { xmin: 0, xmax: 0, value, deleted: false, seq: this.versionSeq++ },
    ])
  }

  begin(label: string, level: IsolationLevel): Txn {
    const id = ++this.txnSeq
    const txn: Txn = {
      id,
      label,
      level,
      status: 'active',
      startTs: ++this.tsSeq,
      commitTs: 0,
      snapshot: this.committedSet(),
      reads: new Set(),
      writes: new Set(),
      predReads: [],
    }
    this.txns.set(id, txn)
    return txn
  }

  /** The set of transaction ids that have committed so far. */
  private committedSet(): Set<number> {
    const s = new Set<number>()
    s.add(0) // the system seed txn is always committed
    for (const t of this.txns.values()) if (t.status === 'committed') s.add(t.id)
    return s
  }

  /** The snapshot a txn should use for a read, given its level. RC re-reads the
   *  current committed set on every statement; RR/SER reuse the frozen one. */
  private snapshotFor(txn: Txn): Set<number> {
    if (txn.level === 'READ COMMITTED') return this.committedSet()
    return txn.snapshot
  }

  private isCommitted(id: number): boolean {
    if (id === 0) return true
    const t = this.txns.get(id)
    return !!t && t.status === 'committed'
  }

  /** Do transactions a and b overlap in time (neither could see the other's
   *  commit at BEGIN)? Used to scope SSI antidependencies to *concurrent* txns. */
  private overlap(a: Txn, b: Txn): boolean {
    const aEnd = a.commitTs || Infinity
    const bEnd = b.commitTs || Infinity
    return a.startTs < bEnd && b.startTs < aEnd
  }

  /**
   * The version of `key` visible to `txn`. Iterating newest→oldest, the first
   * version whose *creation* is visible is the current one for this snapshot; if
   * that version is a tombstone the row is (visibly) gone.
   */
  visibleVersion(key: string, txn: Txn): Version | null {
    const chain = this.table.get(key)
    if (!chain) return null
    // READ UNCOMMITTED reads the raw tip — including another txn's uncommitted work.
    if (txn.level === 'READ UNCOMMITTED') {
      const tip = chain[chain.length - 1]
      return tip.deleted ? null : tip
    }
    const vis = this.snapshotFor(txn)
    for (let i = chain.length - 1; i >= 0; i--) {
      const v = chain[i]
      const createdVisible = v.xmin === txn.id || vis.has(v.xmin)
      if (!createdVisible) continue
      return v.deleted ? null : v
    }
    return null
  }

  read(txn: Txn, key: string): ReadOutcome {
    const v = this.visibleVersion(key, txn)
    txn.reads.add(key)
    this.detectReadAntideps(txn, key)
    return v ? { found: true, value: v.value } : { found: false, value: null }
  }

  /** A predicate (range) read: returns every visible row satisfying `test`. */
  readWhere(txn: Txn, label: string, test: (v: Val) => boolean): PredReadOutcome {
    txn.predReads.push({ label, test })
    const rows: { key: string; value: Val }[] = []
    for (const key of this.table.keys()) {
      const v = this.visibleVersion(key, txn)
      if (v && test(v.value)) rows.push({ key, value: v.value })
      // record antidependencies against concurrent writers of matching rows
      this.detectPredAntideps(txn, key, test)
    }
    rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    return { rows }
  }

  write(txn: Txn, key: string, value: Val): WriteOutcome {
    return this.mutate(txn, key, value, false)
  }

  del(txn: Txn, key: string): WriteOutcome {
    return this.mutate(txn, key, null, true)
  }

  private mutate(txn: Txn, key: string, value: Val, deleted: boolean): WriteOutcome {
    // (1) Is the row write-locked by another *active* transaction? Then block.
    const holder = this.writeLocks.get(key)
    if (holder !== undefined && holder !== txn.id) {
      const h = this.txns.get(holder)
      if (h && h.status === 'active') return { status: 'blocked', waitsFor: holder }
    }

    const chain = this.table.get(key) ?? []
    const tip = chain.length ? chain[chain.length - 1] : null

    // (2) Write-write conflict against a *concurrent committed* writer.
    // RC/RU use a fresh committed set (so a now-committed concurrent writer is
    // "visible" → no conflict, they just overwrite); RR/SER use the frozen
    // snapshot (so that writer is invisible → first-updater-wins serialization
    // failure).
    if (tip && tip.xmin !== txn.id && this.isCommitted(tip.xmin)) {
      const vis = this.snapshotFor(txn)
      if (!vis.has(tip.xmin)) {
        if (txn.level === 'REPEATABLE READ' || txn.level === 'SERIALIZABLE') {
          return {
            status: 'abort',
            reason: 'could not serialize access due to concurrent update',
          }
        }
      }
    }

    // (3) Record antidependencies: anyone who read this row (point or predicate)
    // concurrently now has an rw-edge to us, because we are about to overwrite
    // what they read.
    this.detectWriteAntideps(txn, key, value, tip)

    // (4) Apply the write: stamp the old tip's xmax, append a new version. If we
    // already wrote this key in this txn, update our own version in place.
    if (tip && tip.xmin === txn.id && tip.xmax === 0) {
      tip.value = value
      tip.deleted = deleted
    } else {
      if (tip && tip.xmax === 0) tip.xmax = txn.id
      chain.push({ xmin: txn.id, xmax: 0, value, deleted, seq: this.versionSeq++ })
      this.table.set(key, chain)
    }
    this.writeLocks.set(key, txn.id)
    txn.writes.add(key)

    // (5) Write-precedence edge: the previous committed writer happens-before us.
    if (tip && tip.xmin !== txn.id && this.isCommitted(tip.xmin)) {
      this.addPrecedence(tip.xmin, txn.id)
    }
    return { status: 'ok' }
  }

  /** At read time, if a concurrent txn has a newer (to us invisible) write of
   *  this key, we read-before-they-wrote → edge us → them. */
  private detectReadAntideps(txn: Txn, key: string): void {
    const chain = this.table.get(key)
    if (!chain) return
    const vis = this.snapshotFor(txn)
    for (const v of chain) {
      const w = this.txns.get(v.xmin)
      if (!w || w.id === txn.id || w.status === 'aborted') continue
      const createdVisible = v.xmin === txn.id || vis.has(v.xmin)
      if (!createdVisible && this.overlap(txn, w)) this.addRw(txn.id, w.id)
    }
    // read-from precedence: we read a value some committed txn produced.
    const seen = this.visibleVersion(key, txn)
    if (seen && seen.xmin !== txn.id && this.isCommitted(seen.xmin)) {
      this.addPrecedence(seen.xmin, txn.id)
    }
  }

  /** At write time, every concurrent reader of this key (or a predicate that the
   *  old/new value matches) gets an rw-edge to us. */
  private detectWriteAntideps(txn: Txn, key: string, newValue: Val, tip: Version | null): void {
    const oldValue = tip && !tip.deleted ? tip.value : null
    for (const r of this.txns.values()) {
      if (r.id === txn.id || r.status === 'aborted') continue
      if (!this.overlap(txn, r)) continue
      if (r.reads.has(key)) {
        this.addRw(r.id, txn.id)
        continue
      }
      for (const p of r.predReads) {
        if (p.test(newValue) || (tip && !tip.deleted && p.test(oldValue))) {
          this.addRw(r.id, txn.id)
          break
        }
      }
    }
  }

  /** At predicate-read time, if a concurrent txn has an invisible write touching
   *  a row that matches the predicate, we depend on them. */
  private detectPredAntideps(txn: Txn, key: string, test: (v: Val) => boolean): void {
    const chain = this.table.get(key)
    if (!chain) return
    const vis = this.snapshotFor(txn)
    for (const v of chain) {
      const w = this.txns.get(v.xmin)
      if (!w || w.id === txn.id || w.status === 'aborted') continue
      const createdVisible = v.xmin === txn.id || vis.has(v.xmin)
      if (createdVisible) continue
      if (!this.overlap(txn, w)) continue
      if (!v.deleted && test(v.value)) this.addRw(txn.id, w.id)
    }
  }

  private addRw(from: number, to: number): void {
    if (from === to) return
    this.rwEdges.add(`${from}->${to}`)
  }

  private addPrecedence(from: number, to: number): void {
    if (from === to) return
    this.precedence.add(`${from}->${to}`)
  }

  /** All live rw edges (both endpoints not aborted), as structured pairs. */
  liveRwEdges(): RwEdge[] {
    const out: RwEdge[] = []
    for (const e of this.rwEdges) {
      const [f, t] = e.split('->').map(Number)
      const ft = this.txns.get(f)
      const tt = this.txns.get(t)
      if (ft && ft.status === 'aborted') continue
      if (tt && tt.status === 'aborted') continue
      out.push({ from: f, to: t })
    }
    return out
  }

  /**
   * SSI commit check. A transaction is a *pivot* of a dangerous structure when
   * it has both an inbound and an outbound rw-antidependency to concurrent,
   * non-aborted transactions. Following PostgreSQL, we only abort the pivot once
   * the transaction on its outbound edge has committed (commits "first"), which
   * makes the second committer of a write-skew pair the victim and avoids
   * aborting safe read-only or non-conflicting transactions.
   */
  private ssiWouldAbort(txn: Txn): boolean {
    const edges = this.liveRwEdges()
    const hasIn = edges.some((e) => e.to === txn.id && this.concurrentNonAborted(e.from, txn))
    if (!hasIn) return false
    for (const e of edges) {
      if (e.from !== txn.id) continue
      const out = this.txns.get(e.to)
      if (!out || out.status === 'aborted') continue
      if (!this.overlap(txn, out)) continue
      if (out.status === 'committed') return true
    }
    return false
  }

  private concurrentNonAborted(id: number, txn: Txn): boolean {
    const t = this.txns.get(id)
    if (!t || t.status === 'aborted') return false
    return this.overlap(txn, t)
  }

  /** Attempt to commit. Returns ok, or an abort if SSI says so. */
  commit(txn: Txn): { status: 'ok' } | { status: 'abort'; reason: string } {
    if (txn.level === 'SERIALIZABLE' && this.ssiWouldAbort(txn)) {
      this.abort(txn, 'could not serialize access due to read/write dependencies among transactions')
      return {
        status: 'abort',
        reason: 'could not serialize access due to read/write dependencies among transactions',
      }
    }
    txn.status = 'committed'
    txn.commitTs = ++this.tsSeq
    this.releaseLocks(txn)
    return { status: 'ok' }
  }

  abort(txn: Txn, reason: string): void {
    txn.status = 'aborted'
    txn.abortReason = reason
    // Roll back this txn's versions: drop ones it created, clear xmax stamps it set.
    for (const [, chain] of this.table) {
      for (let i = chain.length - 1; i >= 0; i--) {
        if (chain[i].xmin === txn.id) chain.splice(i, 1)
      }
      for (const v of chain) if (v.xmax === txn.id) v.xmax = 0
    }
    this.releaseLocks(txn)
  }

  private releaseLocks(txn: Txn): void {
    for (const [key, holder] of this.writeLocks) {
      if (holder === txn.id) this.writeLocks.delete(key)
    }
  }

  /** Snapshot of every row's current committed value (for a "final state" view).
   *  Uses an omniscient reader that sees all commits. */
  committedRows(): { key: string; value: Val }[] {
    const committed = this.committedSet()
    const out: { key: string; value: Val }[] = []
    for (const [key, chain] of this.table) {
      let found: Version | null = null
      for (let i = chain.length - 1; i >= 0; i--) {
        if (committed.has(chain[i].xmin)) {
          found = chain[i]
          break
        }
      }
      if (found && !found.deleted) out.push({ key, value: found.value })
    }
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    return out
  }

  /** Is the committed schedule serializable? Runs a cycle check over the union
   *  of rw-antidependency and precedence (ww + wr) edges, restricted to
   *  committed transactions. A cycle ⇒ the outcome is not serializable. */
  serializabilityCycle(): number[] | null {
    const nodes = [...this.txns.values()].filter((t) => t.status === 'committed').map((t) => t.id)
    const adj = new Map<number, Set<number>>()
    for (const n of nodes) adj.set(n, new Set())
    const consider = (from: number, to: number) => {
      if (adj.has(from) && adj.has(to)) adj.get(from)!.add(to)
    }
    for (const e of this.rwEdges) {
      const [f, t] = e.split('->').map(Number)
      consider(f, t)
    }
    for (const e of this.precedence) {
      const [f, t] = e.split('->').map(Number)
      consider(f, t)
    }
    // Tarjan-free cycle find: DFS with colors, return the first cycle path.
    const WHITE = 0, GRAY = 1, BLACK = 2
    const color = new Map<number, number>()
    for (const n of nodes) color.set(n, WHITE)
    const stack: number[] = []
    let cycle: number[] | null = null
    const dfs = (u: number): boolean => {
      color.set(u, GRAY)
      stack.push(u)
      for (const v of adj.get(u) ?? []) {
        if (color.get(v) === GRAY) {
          const idx = stack.indexOf(v)
          cycle = stack.slice(idx)
          return true
        }
        if (color.get(v) === WHITE && dfs(v)) return true
      }
      stack.pop()
      color.set(u, BLACK)
      return false
    }
    for (const n of nodes) {
      if (color.get(n) === WHITE && dfs(n)) break
    }
    return cycle
  }
}
