// Linear Hashing (Litwin, 1980) — a dynamic hash index that grows **without a
// directory** and, crucially, splits buckets in a fixed round-robin order that
// is *independent of which bucket overflowed*. That decoupling is the whole
// trick: a single monotone **split pointer** sweeps the buckets, so growth is
// perfectly incremental and the address of a key is computed arithmetically, no
// indirection table required.
//
// State is a level `L`, a split pointer `next`, and `base·2^L + next` buckets.
// The address of a key uses two hash functions:
//
//     a = h mod (base·2^L)                 // the "unsplit this round" address
//     if a < next:  a = h mod (base·2^(L+1))   // already split — use the finer one
//
// A bucket that fills spills into an **overflow chain** (kept correct, never
// lost). Independently, whenever the load factor crosses a threshold we **split
// bucket `next`** — appending a fresh bucket at address `next + base·2^L` and
// rehashing bucket `next`'s keys across the pair with the finer function — then
// advance the pointer. When `next` wraps past `base·2^L` the round ends: `L`
// increments and `next` resets, so every bucket is now addressed at the finer
// granularity. Overflows are thus paid down steadily by later splits rather than
// all at once.
//
// Deletes run the film backwards: when the load factor drops too low we
// **contract**, merging the most-recently-created bucket back into its origin and
// stepping the pointer (and level) down — so a drained index shrinks its bucket
// array back toward `base`.
//
// The write-friendly, directory-free sibling of `extendible.ts`; same
// tuple-`IndexKey`, same row-id sets, same after-every-op `checkInvariants()`.

import { compareKeys, type IndexKey } from '../storage/btree'
import { formatValue } from '../types'
import { hashKey, fmtKey, type HashEntry } from './hash'

export type { HashEntry } from './hash'

export type LhKind = 'insert' | 'update' | 'overflow' | 'split' | 'level-up' | 'remove' | 'merge' | 'level-down' | 'found' | 'not-found'

export interface LhTrace {
  kind: LhKind
  detail: string
  bucketIds: number[]
}

interface Bucket {
  id: number
  entries: HashEntry[] // primary slots + overflow, in one list; overflow = entries beyond capacity
}

export interface LhBucketSnap {
  id: number
  address: number
  keys: string[]
  count: number
  capacity: number
  overflow: number
  isNext: boolean
}

export interface LhSnapshot {
  level: number
  next: number
  base: number
  nBuckets: number
  capacity: number
  buckets: LhBucketSnap[]
}

export interface LhStats {
  level: number
  next: number
  base: number
  buckets: number
  keys: number
  capacity: number
  loadFactor: number
  overflowKeys: number
  splits: number
  merges: number
}

export interface LinearHashOptions {
  base?: number
  capacity?: number
  splitThreshold?: number
  mergeThreshold?: number
}

export class LinearHash {
  level = 0
  next = 0
  readonly base: number
  readonly capacity: number
  readonly splitThreshold: number
  readonly mergeThreshold: number
  buckets: Bucket[] = []
  private nextId = 0
  count = 0 // distinct keys

  splits = 0
  merges = 0

  constructor(opts?: LinearHashOptions) {
    this.base = Math.max(1, opts?.base ?? 2)
    this.capacity = Math.max(1, opts?.capacity ?? 4)
    this.splitThreshold = opts?.splitThreshold ?? 0.8
    this.mergeThreshold = opts?.mergeThreshold ?? 0.35
    for (let i = 0; i < this.base; i++) this.buckets.push({ id: this.nextId++, entries: [] })
  }

  private roundSize(): number {
    return this.base << this.level // base·2^L
  }

  private address(h: number): number {
    let a = h % this.roundSize()
    if (a < this.next) a = h % (this.base << (this.level + 1))
    return a
  }

  loadFactor(): number {
    return this.count / (this.buckets.length * this.capacity)
  }

  private findEntry(b: Bucket, key: IndexKey): HashEntry | undefined {
    for (const e of b.entries) if (compareKeys(e.key, key) === 0) return e
    return undefined
  }

  insert(key: IndexKey, rowid: number, trace?: LhTrace[]): void {
    const a = this.address(hashKey(key))
    const b = this.buckets[a]
    const existing = this.findEntry(b, key)
    if (existing) {
      if (!existing.rowids.includes(rowid)) existing.rowids.push(rowid)
      trace?.push({ kind: 'update', detail: `${fmtKey(key, formatValue)} already in bucket ${a} — added row`, bucketIds: [b.id] })
      return
    }
    b.entries.push({ key, rowids: [rowid] })
    this.count++
    const over = b.entries.length > this.capacity
    trace?.push({
      kind: over ? 'overflow' : 'insert',
      detail: `inserted ${fmtKey(key, formatValue)} into bucket ${a}${over ? ` (overflow chain now +${b.entries.length - this.capacity})` : ''}`,
      bucketIds: [b.id],
    })
    if (this.loadFactor() > this.splitThreshold) this.split(trace)
  }

  private split(trace?: LhTrace[]): void {
    const splitAddr = this.next
    const newAddr = splitAddr + this.roundSize()
    const nb: Bucket = { id: this.nextId++, entries: [] }
    this.buckets.push(nb) // lands exactly at index newAddr
    const old = this.buckets[splitAddr]
    const finer = this.base << (this.level + 1)
    const keep: HashEntry[] = []
    for (const e of old.entries) {
      if (hashKey(e.key) % finer === newAddr) nb.entries.push(e)
      else keep.push(e)
    }
    old.entries = keep
    this.next++
    this.splits++
    let leveled = false
    if (this.next >= this.roundSize()) {
      this.next = 0
      this.level++
      leveled = true
    }
    trace?.push({
      kind: leveled ? 'level-up' : 'split',
      detail: `split bucket ${splitAddr} → new bucket at address ${newAddr}; split pointer → ${this.next}${leveled ? ` (round complete, level ${this.level - 1}→${this.level})` : ''}`,
      bucketIds: [old.id, nb.id],
    })
  }

  lookup(key: IndexKey, trace?: LhTrace[]): number[] {
    const a = this.address(hashKey(key))
    const b = this.buckets[a]
    const e = this.findEntry(b, key)
    trace?.push({
      kind: e ? 'found' : 'not-found',
      detail: e ? `found ${fmtKey(key, formatValue)} in bucket ${a}` : `${fmtKey(key, formatValue)} not present (probed bucket ${a})`,
      bucketIds: [b.id],
    })
    return e ? [...e.rowids].sort((x, y) => x - y) : []
  }

  remove(key: IndexKey, rowid: number, trace?: LhTrace[]): boolean {
    const a = this.address(hashKey(key))
    const b = this.buckets[a]
    const idx = b.entries.findIndex((e) => compareKeys(e.key, key) === 0)
    if (idx < 0) {
      trace?.push({ kind: 'not-found', detail: `${fmtKey(key, formatValue)} not present`, bucketIds: [b.id] })
      return false
    }
    const e = b.entries[idx]
    const ri = e.rowids.indexOf(rowid)
    if (ri >= 0) e.rowids.splice(ri, 1)
    let removedKey = false
    if (e.rowids.length === 0) {
      b.entries.splice(idx, 1)
      this.count--
      removedKey = true
    }
    trace?.push({ kind: 'remove', detail: `removed row from ${fmtKey(key, formatValue)} in bucket ${a}${removedKey ? ' (key now empty)' : ''}`, bucketIds: [b.id] })
    if (removedKey) {
      while (this.buckets.length > this.base && this.loadFactor() < this.mergeThreshold) this.contract(trace)
    }
    return true
  }

  private contract(trace?: LhTrace[]): void {
    let leveled = false
    if (this.next === 0) {
      if (this.level === 0) return
      this.level--
      this.next = this.roundSize() // base·2^(new level)
      leveled = true
    }
    this.next--
    const splitAddr = this.next
    const lastAddr = this.buckets.length - 1
    const last = this.buckets[lastAddr]
    const target = this.buckets[splitAddr]
    for (const e of last.entries) {
      const existing = this.findEntry(target, e.key)
      if (existing) {
        for (const r of e.rowids) if (!existing.rowids.includes(r)) existing.rowids.push(r)
      } else {
        target.entries.push(e)
      }
    }
    this.buckets.pop()
    this.merges++
    trace?.push({
      kind: leveled ? 'level-down' : 'merge',
      detail: `merged bucket ${lastAddr} back into ${splitAddr}; split pointer → ${this.next}${leveled ? ` (level ${this.level + 1}→${this.level})` : ''}`,
      bucketIds: [target.id],
    })
  }

  entries(): HashEntry[] {
    const out: HashEntry[] = []
    for (const b of this.buckets) for (const e of b.entries) out.push({ key: e.key, rowids: [...e.rowids].sort((a, b2) => a - b2) })
    return out.sort((a, b) => compareKeys(a.key, b.key))
  }

  size(): number {
    return this.count
  }

  stats(): LhStats {
    let overflowKeys = 0
    for (const b of this.buckets) overflowKeys += Math.max(0, b.entries.length - this.capacity)
    return {
      level: this.level,
      next: this.next,
      base: this.base,
      buckets: this.buckets.length,
      keys: this.count,
      capacity: this.capacity,
      loadFactor: this.loadFactor(),
      overflowKeys,
      splits: this.splits,
      merges: this.merges,
    }
  }

  snapshot(): LhSnapshot {
    return {
      level: this.level,
      next: this.next,
      base: this.base,
      nBuckets: this.buckets.length,
      capacity: this.capacity,
      buckets: this.buckets.map((b, a) => ({
        id: b.id,
        address: a,
        keys: b.entries.map((e) => fmtKey(e.key, formatValue)),
        count: b.entries.length,
        capacity: this.capacity,
        overflow: Math.max(0, b.entries.length - this.capacity),
        isNext: a === this.next,
      })),
    }
  }

  checkInvariants(): string[] {
    const errs: string[] = []
    if (this.buckets.length !== this.roundSize() + this.next) {
      errs.push(`bucket count ${this.buckets.length} ≠ base·2^L + next = ${this.roundSize() + this.next}`)
    }
    if (this.next < 0 || this.next >= this.roundSize()) errs.push(`split pointer ${this.next} out of [0, ${this.roundSize()})`)
    const keySeen = new Map<string, number>()
    let liveKeys = 0
    for (let a = 0; a < this.buckets.length; a++) {
      const b = this.buckets[a]
      for (const e of b.entries) {
        liveKeys++
        if (this.address(hashKey(e.key)) !== a) errs.push(`bucket ${a}: key ${fmtKey(e.key, formatValue)} addresses to ${this.address(hashKey(e.key))}`)
        if (e.rowids.length === 0) errs.push(`bucket ${a}: key ${fmtKey(e.key, formatValue)} has no rows`)
        const ks = JSON.stringify(e.key)
        keySeen.set(ks, (keySeen.get(ks) ?? 0) + 1)
      }
    }
    if (liveKeys !== this.count) errs.push(`live key count ${liveKeys} ≠ tracked count ${this.count}`)
    for (const [k, n] of keySeen) if (n > 1) errs.push(`key ${k} appears in ${n} buckets`)
    return errs
  }
}
