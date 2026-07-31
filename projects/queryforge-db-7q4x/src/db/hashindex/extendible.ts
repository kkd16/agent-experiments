// Extendible Hashing (Fagin, Nievergelt, Pippenger & Strong, 1979) — a dynamic
// hash index that grows and shrinks one bucket at a time, with **no** global
// rehash, giving worst-case *two* memory touches for a point lookup (the
// directory slot, then one bucket).
//
// The structure is a **directory** of 2^G pointers (G = the global depth) into a
// set of **buckets**. A bucket has a **local depth** d ≤ G and holds every key
// whose low d bits equal a fixed signature; it is shared by all 2^(G−d)
// directory slots that agree on those low d bits. A point operation reads the
// low G bits of the key's hash to index the directory, follows the pointer, and
// scans that one bucket.
//
// Growth: when a bucket overflows we **split** it — partition its keys by their
// next hash bit into two buckets of local depth d+1. If the bucket was already
// as deep as the directory (d == G) we first **double** the directory
// (G → G+1), which is a pointer copy, never a rehash of the data. Because only
// the overflowing bucket splits, the directory doubles rarely (≈ log₂(n/cap)
// times over a whole load), and most splits touch a single bucket.
//
// Shrinkage (the dual, so a drained index reclaims its directory): a delete that
// leaves a bucket and its **buddy** (its split image — the bucket reached by
// flipping bit d−1) both small enough to recombine **merges** them back to local
// depth d−1, and once *every* bucket is shallower than the directory the
// directory **halves** (G → G−1). An index that ballooned under load returns to
// a single bucket and a one-slot directory when emptied.
//
// This is QueryForge's hash-based access method — the O(1)-expected point-lookup
// counterpart to the ordered B+Tree (`storage/btree.ts`) and the write-optimized
// LSM tree (`lsm/`). Keys are the engine's own tuple `IndexKey` (so it backs both
// single-column and composite indexes) and each key carries a *set* of row ids,
// exactly like the B+Tree, so it serves unique and non-unique indexes alike.
// `checkInvariants()` proves the directory/bucket coupling after every mutation,
// and every op can record a structural `trace` the Hash Index Lab animates.

import { compareKeys, type IndexKey } from '../storage/btree'
import { formatValue } from '../types'
import { hashKey, lowBits, fmtKey, type HashEntry } from './hash'

export type { HashEntry } from './hash'

export type EhKind =
  | 'insert'
  | 'update'
  | 'overflow'
  | 'split'
  | 'double'
  | 'remove'
  | 'merge'
  | 'halve'
  | 'found'
  | 'not-found'
  | 'probe'

export interface EhTrace {
  kind: EhKind
  detail: string
  /** Bucket ids the step touched, for the Lab to highlight. */
  bucketIds: number[]
}

interface Bucket {
  id: number
  localDepth: number
  entries: HashEntry[] // distinct keys only
}

export interface EhBucketSnap {
  id: number
  localDepth: number
  keys: string[]
  count: number
  capacity: number
  overfull: boolean
}

export interface EhSnapshot {
  globalDepth: number
  capacity: number
  /** One entry per directory slot: `{ index, bits, bucketId }`. */
  directory: { index: number; bits: string; bucketId: number }[]
  buckets: EhBucketSnap[]
}

export interface EhStats {
  globalDepth: number
  dirSlots: number
  buckets: number
  keys: number
  capacity: number
  fill: number
  splits: number
  doublings: number
  merges: number
  halvings: number
}

// A defensive ceiling on the directory depth. With a well-mixed 32-bit hash this
// is never approached (G grows only as ⌈log₂(n/cap)⌉), but if an adversarial key
// set collided in every low bit, splitting would loop forever; instead, at the
// ceiling we let a bucket keep an overflow list. Correctness is unaffected either
// way — routing + exact comparison still find every key.
const MAX_DEPTH = 30

export class ExtendibleHash {
  globalDepth = 0
  directory: Bucket[]
  readonly capacity: number
  private nextId = 0

  splits = 0
  doublings = 0
  merges = 0
  halvings = 0

  constructor(capacity = 4) {
    this.capacity = Math.max(1, capacity)
    const b: Bucket = { id: this.nextId++, localDepth: 0, entries: [] }
    this.directory = [b] // 2^0 = 1 slot
  }

  private dirIndex(h: number): number {
    return lowBits(h, this.globalDepth)
  }

  private findEntry(b: Bucket, key: IndexKey): HashEntry | undefined {
    for (const e of b.entries) if (compareKeys(e.key, key) === 0) return e
    return undefined
  }

  /** Insert `rowid` under `key`, splitting / doubling as needed. */
  insert(key: IndexKey, rowid: number, trace?: EhTrace[]): void {
    // Retry after each split: the new key may still not fit if the bucket's keys
    // all fell to the same side, which just triggers another split.
    for (let guard = 0; guard < 64; guard++) {
      const b = this.directory[this.dirIndex(hashKey(key))]
      const existing = this.findEntry(b, key)
      if (existing) {
        if (!existing.rowids.includes(rowid)) existing.rowids.push(rowid)
        trace?.push({ kind: 'update', detail: `${fmtKey(key, formatValue)} already in bucket ${b.id} — added row`, bucketIds: [b.id] })
        return
      }
      if (b.entries.length < this.capacity || b.localDepth >= MAX_DEPTH) {
        b.entries.push({ key, rowids: [rowid] })
        const over = b.entries.length > this.capacity
        trace?.push({
          kind: over ? 'overflow' : 'insert',
          detail: `inserted ${fmtKey(key, formatValue)} into bucket ${b.id}${over ? ' (at depth ceiling — overflow)' : ''}`,
          bucketIds: [b.id],
        })
        return
      }
      this.splitBucket(b, trace)
    }
    throw new Error('extendible hash: split did not converge')
  }

  private doubleDirectory(trace?: EhTrace[]): void {
    const oldSize = this.directory.length
    const nd = new Array<Bucket>(oldSize * 2)
    for (let i = 0; i < oldSize; i++) {
      nd[i] = this.directory[i]
      nd[i + oldSize] = this.directory[i]
    }
    this.directory = nd
    this.globalDepth++
    this.doublings++
    trace?.push({
      kind: 'double',
      detail: `directory doubled — global depth ${this.globalDepth - 1}→${this.globalDepth} (${oldSize}→${oldSize * 2} slots)`,
      bucketIds: [],
    })
  }

  private splitBucket(b: Bucket, trace?: EhTrace[]): void {
    if (b.localDepth === this.globalDepth) this.doubleDirectory(trace)
    const d = b.localDepth
    const bit = 1 << d
    const nb: Bucket = { id: this.nextId++, localDepth: d + 1, entries: [] }
    b.localDepth = d + 1
    this.splits++
    // Redistribute by the (d)-th hash bit: 1 → new bucket, 0 → stays.
    const keep: HashEntry[] = []
    for (const e of b.entries) {
      if (hashKey(e.key) & bit) nb.entries.push(e)
      else keep.push(e)
    }
    b.entries = keep
    // Every directory slot that pointed at `b` and has bit d set now points at nb.
    for (let i = 0; i < this.directory.length; i++) {
      if (this.directory[i] === b && (i & bit) !== 0) this.directory[i] = nb
    }
    trace?.push({
      kind: 'split',
      detail: `split bucket ${b.id} → {${b.id}, ${nb.id}} on bit ${d} (local depth ${d}→${d + 1})`,
      bucketIds: [b.id, nb.id],
    })
  }

  /** All row ids under `key`, sorted; `[]` if absent. */
  lookup(key: IndexKey, trace?: EhTrace[]): number[] {
    const b = this.directory[this.dirIndex(hashKey(key))]
    const e = this.findEntry(b, key)
    trace?.push({
      kind: e ? 'found' : 'not-found',
      detail: e ? `found ${fmtKey(key, formatValue)} in bucket ${b.id}` : `${fmtKey(key, formatValue)} not present (probed bucket ${b.id})`,
      bucketIds: [b.id],
    })
    return e ? [...e.rowids].sort((a, b2) => a - b2) : []
  }

  /** Remove `rowid` from `key`; merges/halves as the index drains. */
  remove(key: IndexKey, rowid: number, trace?: EhTrace[]): boolean {
    const b = this.directory[this.dirIndex(hashKey(key))]
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
      removedKey = true
    }
    trace?.push({
      kind: 'remove',
      detail: `removed row from ${fmtKey(key, formatValue)} in bucket ${b.id}${removedKey ? ' (key now empty)' : ''}`,
      bucketIds: [b.id],
    })
    if (removedKey) this.tryMerge(b, trace)
    return true
  }

  private buddyOf(di: number, localDepth: number): number {
    return di ^ (1 << (localDepth - 1))
  }

  private maxLocalDepth(): number {
    let m = 0
    for (const b of this.distinctBuckets()) if (b.localDepth > m) m = b.localDepth
    return m
  }

  private tryMerge(b: Bucket, trace?: EhTrace[]): void {
    for (let guard = 0; guard < 64; guard++) {
      if (b.localDepth === 0) return
      const di = this.directory.indexOf(b)
      if (di < 0) return
      const buddy = this.directory[this.buddyOf(di, b.localDepth)]
      // Merge only when the split image is a *distinct* bucket at the same depth
      // and the two together fit in one bucket.
      if (buddy === b || buddy.localDepth !== b.localDepth) return
      if (b.entries.length + buddy.entries.length > this.capacity) return
      b.entries.push(...buddy.entries)
      b.localDepth--
      for (let i = 0; i < this.directory.length; i++) if (this.directory[i] === buddy) this.directory[i] = b
      this.merges++
      trace?.push({
        kind: 'merge',
        detail: `merged buckets ${b.id}+${buddy.id} (local depth ${b.localDepth + 1}→${b.localDepth})`,
        bucketIds: [b.id],
      })
      this.tryHalve(trace)
    }
  }

  private tryHalve(trace?: EhTrace[]): void {
    // Safe exactly when no bucket needs the top directory bit to be addressed —
    // i.e. every local depth is below the global depth — because then the two
    // halves of the directory are pointer-identical.
    while (this.globalDepth > 0 && this.maxLocalDepth() < this.globalDepth) {
      const half = this.directory.length / 2
      this.directory = this.directory.slice(0, half)
      this.globalDepth--
      this.halvings++
      trace?.push({ kind: 'halve', detail: `directory halved — global depth ${this.globalDepth + 1}→${this.globalDepth}`, bucketIds: [] })
    }
  }

  private distinctBuckets(): Bucket[] {
    const seen = new Set<Bucket>()
    for (const b of this.directory) seen.add(b)
    return [...seen]
  }

  /** Every entry across all buckets, key-sorted (for differential testing). */
  entries(): HashEntry[] {
    const out: HashEntry[] = []
    for (const b of this.distinctBuckets()) for (const e of b.entries) out.push({ key: e.key, rowids: [...e.rowids].sort((a, b2) => a - b2) })
    return out.sort((a, b) => compareKeys(a.key, b.key))
  }

  size(): number {
    let n = 0
    for (const b of this.distinctBuckets()) n += b.entries.length
    return n
  }

  stats(): EhStats {
    const bs = this.distinctBuckets()
    const keys = bs.reduce((n, b) => n + b.entries.length, 0)
    return {
      globalDepth: this.globalDepth,
      dirSlots: this.directory.length,
      buckets: bs.length,
      keys,
      capacity: this.capacity,
      fill: bs.length ? keys / (bs.length * this.capacity) : 0,
      splits: this.splits,
      doublings: this.doublings,
      merges: this.merges,
      halvings: this.halvings,
    }
  }

  snapshot(): EhSnapshot {
    const idOf = new Map<Bucket, number>()
    for (const b of this.distinctBuckets()) idOf.set(b, b.id)
    const width = this.globalDepth
    const directory = this.directory.map((b, i) => ({
      index: i,
      bits: width === 0 ? '·' : i.toString(2).padStart(width, '0'),
      bucketId: b.id,
    }))
    const buckets = this.distinctBuckets()
      .sort((a, b) => a.id - b.id)
      .map((b) => ({
        id: b.id,
        localDepth: b.localDepth,
        keys: b.entries.map((e) => fmtKey(e.key, formatValue)),
        count: b.entries.length,
        capacity: this.capacity,
        overfull: b.entries.length > this.capacity,
      }))
    return { globalDepth: this.globalDepth, capacity: this.capacity, directory, buckets }
  }

  /** Structural oracle: every violation of the extendible-hash invariant. */
  checkInvariants(): string[] {
    const errs: string[] = []
    if (this.directory.length !== 1 << this.globalDepth) {
      errs.push(`directory has ${this.directory.length} slots, expected ${1 << this.globalDepth}`)
    }
    const buckets = this.distinctBuckets()
    const keySeen = new Map<string, number>()
    for (const b of buckets) {
      if (b.localDepth > this.globalDepth) errs.push(`bucket ${b.id}: local depth ${b.localDepth} > global ${this.globalDepth}`)
      const slots: number[] = []
      for (let i = 0; i < this.directory.length; i++) if (this.directory[i] === b) slots.push(i)
      const expected = 1 << (this.globalDepth - b.localDepth)
      if (slots.length !== expected) errs.push(`bucket ${b.id}: pointed by ${slots.length} slots, expected ${expected}`)
      const mask = (1 << b.localDepth) - 1
      const sig = (slots[0] ?? 0) & mask
      for (const s of slots) if ((s & mask) !== sig) errs.push(`bucket ${b.id}: slot ${s} disagrees on low ${b.localDepth} bits`)
      for (const e of b.entries) {
        const h = hashKey(e.key)
        if ((h & mask) !== sig) errs.push(`bucket ${b.id}: key ${fmtKey(e.key, formatValue)} in wrong bucket by signature`)
        if (this.directory[this.dirIndex(h)] !== b) errs.push(`bucket ${b.id}: key ${fmtKey(e.key, formatValue)} routes to another bucket`)
        if (e.rowids.length === 0) errs.push(`bucket ${b.id}: key ${fmtKey(e.key, formatValue)} has no rows`)
        const ks = JSON.stringify(e.key)
        keySeen.set(ks, (keySeen.get(ks) ?? 0) + 1)
      }
      if (b.entries.length > this.capacity && b.localDepth < MAX_DEPTH) errs.push(`bucket ${b.id}: overfull (${b.entries.length} > ${this.capacity})`)
    }
    for (const [k, n] of keySeen) if (n > 1) errs.push(`key ${k} appears in ${n} buckets`)
    return errs
  }
}
