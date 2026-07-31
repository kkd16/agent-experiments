// Cuckoo Hashing (Pagh & Rodler, 2001) — the **open-addressed** dynamic hash
// index, and the one with the strongest read guarantee of the three: a key lives
// in exactly one of **two** candidate slots, so a lookup is a *worst-case* — not
// just expected — **two** probes, and never a chain walk. That guarantee is
// bought on the write side: an insert places the key in its first slot and, if
// that slot is taken, **evicts** the incumbent to *its* alternate slot, which may
// evict the next, and so on — the "cuckoo" kicking eggs from the nest. The kicks
// almost always settle in a few hops; if they loop past a bound the tables have
// grown too dense, so we **rehash** into larger tables and start the round again.
//
// Two independent addresses come from double-hashing the single 32-bit tuple hash
// (`h0` from the base hash, `h1` from a second avalanche of it). The invariant is
// simple and total: every stored key sits at `T0[h0]` **or** `T1[h1]`, so
// `checkInvariants()` can re-derive both candidate slots for every key and prove
// it is in one of them, with no slot holding two keys. Deletes clear a slot and,
// as the tables drain, **shrink** them back down — the open-addressed counterpart
// to the extendible directory halving and the linear-hash contraction.
//
// The third dynamic-hashing access method, beside extendible (`extendible.ts`,
// chained under a directory) and linear (`linear.ts`, directory-free); same
// tuple-`IndexKey`, same row-id sets, same after-every-op structural oracle.

import { compareKeys, type IndexKey } from '../storage/btree'
import { formatValue } from '../types'
import { hashKey, fmtKey, type HashEntry } from './hash'

export type CkKind = 'insert' | 'update' | 'place' | 'evict' | 'rehash' | 'grow' | 'shrink' | 'remove' | 'found' | 'not-found'

export interface CkTrace {
  kind: CkKind
  detail: string
  /** `[table, slot]` cells the step touched, for the Lab to highlight. */
  cells: [number, number][]
}

type Slot = HashEntry | null

export interface CkCellSnap {
  table: number
  slot: number
  key: string | null
  count: number
}

export interface CkSnapshot {
  size: number // slots per table
  cells: CkCellSnap[]
}

export interface CkStats {
  size: number
  keys: number
  slots: number // 2 * size
  loadFactor: number
  evictions: number
  rehashes: number
  grows: number
  shrinks: number
  maxKick: number
}

export interface CuckooOptions {
  /** Initial slots per table (each of the two tables has this many). */
  size?: number
  /** Grow / rehash trigger: keys / (2·size) above this forces a bigger table. */
  maxLoadFactor?: number
  /** Shrink trigger: below this (and above the floor) the tables halve. */
  minLoadFactor?: number
}

const MIN_SIZE = 2

export class CuckooHash {
  private t0: Slot[]
  private t1: Slot[]
  size: number
  count = 0
  readonly maxLoadFactor: number
  readonly minLoadFactor: number

  evictions = 0
  rehashes = 0
  grows = 0
  shrinks = 0
  maxKick = 0

  constructor(opts?: CuckooOptions) {
    this.size = Math.max(MIN_SIZE, opts?.size ?? 4)
    this.maxLoadFactor = opts?.maxLoadFactor ?? 0.45
    this.minLoadFactor = opts?.minLoadFactor ?? 0.12
    this.t0 = new Array<Slot>(this.size).fill(null)
    this.t1 = new Array<Slot>(this.size).fill(null)
  }

  private h0(key: IndexKey): number {
    return hashKey(key) % this.size
  }
  // A second, independent address: avalanche the base hash again with a salt so
  // h1 is decorrelated from h0 (double hashing).
  private h1(key: IndexKey): number {
    let h = (hashKey(key) ^ 0x9e3779b9) >>> 0
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d)
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b)
    h = (h ^ (h >>> 16)) >>> 0
    return h % this.size
  }

  private findSlot(key: IndexKey): { table: 0 | 1; slot: number; entry: HashEntry } | null {
    const i0 = this.h0(key)
    const e0 = this.t0[i0]
    if (e0 && compareKeys(e0.key, key) === 0) return { table: 0, slot: i0, entry: e0 }
    const i1 = this.h1(key)
    const e1 = this.t1[i1]
    if (e1 && compareKeys(e1.key, key) === 0) return { table: 1, slot: i1, entry: e1 }
    return null
  }

  lookup(key: IndexKey, trace?: CkTrace[]): number[] {
    const found = this.findSlot(key)
    trace?.push({
      kind: found ? 'found' : 'not-found',
      detail: found ? `found ${fmtKey(key, formatValue)} at T${found.table}[${found.slot}]` : `${fmtKey(key, formatValue)} not present (checked both candidate slots)`,
      cells: found ? [[found.table, found.slot]] : [[0, this.h0(key)], [1, this.h1(key)]],
    })
    return found ? [...found.entry.rowids].sort((a, b) => a - b) : []
  }

  insert(key: IndexKey, rowid: number, trace?: CkTrace[]): void {
    const found = this.findSlot(key)
    if (found) {
      if (!found.entry.rowids.includes(rowid)) found.entry.rowids.push(rowid)
      trace?.push({ kind: 'update', detail: `${fmtKey(key, formatValue)} already at T${found.table}[${found.slot}] — added row`, cells: [[found.table, found.slot]] })
      return
    }
    this.count++
    // Grow eagerly if this insert would push past the load ceiling — keeps the
    // kick chains short and the two-slot guarantee cheap.
    if (this.count / (2 * this.size) > this.maxLoadFactor) this.resize(this.size * 2, 'grow', trace)
    this.place({ key, rowids: [rowid] }, trace)
  }

  private maxKicks(): number {
    return 8 + 4 * Math.ceil(Math.log2(this.size + 2))
  }

  // Place a homeless entry, cuckoo-kicking incumbents along the way; on a loop
  // past the bound, rehash into fresh tables (doubling if still too dense).
  private place(entry: HashEntry, trace?: CkTrace[]): void {
    let cur = entry
    let table: 0 | 1 = 0
    const limit = this.maxKicks()
    for (let kick = 0; kick <= limit; kick++) {
      const slot = table === 0 ? this.h0(cur.key) : this.h1(cur.key)
      const arr = table === 0 ? this.t0 : this.t1
      const incumbent = arr[slot]
      if (!incumbent) {
        arr[slot] = cur
        if (kick > this.maxKick) this.maxKick = kick
        trace?.push({ kind: 'place', detail: `placed ${fmtKey(cur.key, formatValue)} at T${table}[${slot}]${kick > 0 ? ` after ${kick} eviction(s)` : ''}`, cells: [[table, slot]] })
        return
      }
      // Evict the incumbent; it will seek its *other* table next.
      arr[slot] = cur
      this.evictions++
      trace?.push({ kind: 'evict', detail: `evicted ${fmtKey(incumbent.key, formatValue)} from T${table}[${slot}] for ${fmtKey(cur.key, formatValue)}`, cells: [[table, slot]] })
      cur = incumbent
      table = table === 0 ? 1 : 0
    }
    // Kick chain looped: the tables are too dense — rehash (grow) and retry.
    this.resize(this.size * 2, 'rehash', trace)
    this.place(cur, trace)
  }

  // Rebuild both tables at `newSize`, reinserting every live entry (plus, via
  // the caller, whatever entry provoked the resize).
  private resize(newSize: number, why: 'grow' | 'rehash' | 'shrink', trace?: CkTrace[]): void {
    const entries: HashEntry[] = []
    for (const e of this.t0) if (e) entries.push(e)
    for (const e of this.t1) if (e) entries.push(e)
    const oldSize = this.size
    this.size = Math.max(MIN_SIZE, newSize)
    this.t0 = new Array<Slot>(this.size).fill(null)
    this.t1 = new Array<Slot>(this.size).fill(null)
    if (why === 'grow') this.grows++
    else if (why === 'shrink') this.shrinks++
    else this.rehashes++
    trace?.push({ kind: why, detail: `${why} tables ${oldSize}→${this.size} slots each; reinserting ${entries.length} keys`, cells: [] })
    for (const e of entries) this.place(e, trace)
  }

  remove(key: IndexKey, rowid: number, trace?: CkTrace[]): boolean {
    const found = this.findSlot(key)
    if (!found) {
      trace?.push({ kind: 'not-found', detail: `${fmtKey(key, formatValue)} not present`, cells: [] })
      return false
    }
    const ri = found.entry.rowids.indexOf(rowid)
    if (ri >= 0) found.entry.rowids.splice(ri, 1)
    let removedKey = false
    if (found.entry.rowids.length === 0) {
      if (found.table === 0) this.t0[found.slot] = null
      else this.t1[found.slot] = null
      this.count--
      removedKey = true
    }
    trace?.push({ kind: 'remove', detail: `removed row from ${fmtKey(key, formatValue)} at T${found.table}[${found.slot}]${removedKey ? ' (slot cleared)' : ''}`, cells: [[found.table, found.slot]] })
    if (removedKey && this.size > MIN_SIZE && this.count / (2 * this.size) < this.minLoadFactor) {
      this.resize(this.size / 2, 'shrink', trace)
    }
    return true
  }

  entries(): HashEntry[] {
    const out: HashEntry[] = []
    for (const e of this.t0) if (e) out.push({ key: e.key, rowids: [...e.rowids].sort((a, b) => a - b) })
    for (const e of this.t1) if (e) out.push({ key: e.key, rowids: [...e.rowids].sort((a, b) => a - b) })
    return out.sort((a, b) => compareKeys(a.key, b.key))
  }

  sizeKeys(): number {
    return this.count
  }

  stats(): CkStats {
    return {
      size: this.size,
      keys: this.count,
      slots: 2 * this.size,
      loadFactor: this.count / (2 * this.size),
      evictions: this.evictions,
      rehashes: this.rehashes,
      grows: this.grows,
      shrinks: this.shrinks,
      maxKick: this.maxKick,
    }
  }

  snapshot(): CkSnapshot {
    const cells: CkCellSnap[] = []
    for (let s = 0; s < this.size; s++) {
      const e0 = this.t0[s]
      cells.push({ table: 0, slot: s, key: e0 ? fmtKey(e0.key, formatValue) : null, count: e0 ? e0.rowids.length : 0 })
    }
    for (let s = 0; s < this.size; s++) {
      const e1 = this.t1[s]
      cells.push({ table: 1, slot: s, key: e1 ? fmtKey(e1.key, formatValue) : null, count: e1 ? e1.rowids.length : 0 })
    }
    return { size: this.size, cells }
  }

  checkInvariants(): string[] {
    const errs: string[] = []
    if (this.t0.length !== this.size || this.t1.length !== this.size) errs.push(`table lengths (${this.t0.length}, ${this.t1.length}) ≠ size ${this.size}`)
    const keySeen = new Map<string, number>()
    let live = 0
    for (let s = 0; s < this.size; s++) {
      const e0 = this.t0[s]
      if (e0) {
        live++
        if (this.h0(e0.key) !== s) errs.push(`T0[${s}]: key ${fmtKey(e0.key, formatValue)} has h0=${this.h0(e0.key)}`)
        if (e0.rowids.length === 0) errs.push(`T0[${s}]: key ${fmtKey(e0.key, formatValue)} has no rows`)
        keySeen.set(JSON.stringify(e0.key), (keySeen.get(JSON.stringify(e0.key)) ?? 0) + 1)
      }
      const e1 = this.t1[s]
      if (e1) {
        live++
        if (this.h1(e1.key) !== s) errs.push(`T1[${s}]: key ${fmtKey(e1.key, formatValue)} has h1=${this.h1(e1.key)}`)
        if (e1.rowids.length === 0) errs.push(`T1[${s}]: key ${fmtKey(e1.key, formatValue)} has no rows`)
        keySeen.set(JSON.stringify(e1.key), (keySeen.get(JSON.stringify(e1.key)) ?? 0) + 1)
      }
    }
    if (live !== this.count) errs.push(`live slot count ${live} ≠ tracked count ${this.count}`)
    for (const [k, n] of keySeen) if (n > 1) errs.push(`key ${k} occupies ${n} slots`)
    return errs
  }
}
