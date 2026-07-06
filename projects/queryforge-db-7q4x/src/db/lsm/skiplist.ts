// The LSM memtable: a probabilistic **skip list** (Pugh, 1990).
//
// Every write in a log-structured merge tree lands first in an in-memory,
// ordered structure — the *memtable* — that must support fast ordered insert,
// point lookup and an in-order scan (so a full memtable flushes to a sorted
// SSTable in one pass). LevelDB / RocksDB use a skip list for exactly this: it
// gives balanced-tree asymptotics (O(log n) search/insert *expected*) with none
// of the rotation bookkeeping, because balance is randomized rather than
// enforced — a node is promoted to the next express lane with probability p on
// each coin flip, so the tower heights are geometric and the top lanes stay
// sparse.
//
// Keys are the engine's own tuple `IndexKey` (compared with `compareKeys`), so
// this memtable orders every SQL type exactly like the B+Tree does. It stores at
// most one entry per key — a later write to the same key overwrites in place,
// carrying the newer sequence number — which is all the read path needs (this
// engine takes no historical snapshots of the memtable). Randomness comes from a
// seeded `Rng`, never `Math.random`, so a whole workload replays byte-for-byte.

import { compareKeys, type IndexKey } from '../storage/btree'
import { Rng } from '../fuzz/rng'

/** A single logical record living in the LSM. `tombstone` marks a deletion —
 *  we cannot use a `null` value for that because SQL NULL is a legal value. The
 *  monotonic `seq` totally orders writes: for one key the highest `seq` wins,
 *  everywhere in the tree. */
export interface Entry {
  key: IndexKey
  seq: number
  value: unknown
  tombstone: boolean
}

interface SkipNode {
  key: IndexKey
  entry: Entry
  // forward[i] is the next node on express lane i (0 = the full base chain).
  forward: (SkipNode | null)[]
}

const MAX_LEVEL = 16
const P = 0.5

export class SkipList {
  private head: SkipNode
  private levelCount = 1
  private count = 0
  private rng: Rng
  /** Live estimate of the serialized byte size of the held entries, so the tree
   *  can decide when the memtable is "full" without walking it. */
  bytes = 0

  constructor(seed = 0x51de) {
    this.rng = new Rng(seed)
    this.head = { key: [], entry: null as unknown as Entry, forward: new Array(MAX_LEVEL).fill(null) }
  }

  get size(): number {
    return this.count
  }

  /** Geometric tower height: level 1 always, promoted one lane per successful
   *  coin flip (p), capped at MAX_LEVEL. */
  private randomLevel(): number {
    let lvl = 1
    while (lvl < MAX_LEVEL && this.rng.chance(P)) lvl++
    return lvl
  }

  /** Insert or overwrite. A repeated key keeps its node (and tower) and just
   *  swaps in the newer entry — the memtable is a map, newest-write-wins. */
  put(entry: Entry): void {
    const update: SkipNode[] = new Array(MAX_LEVEL)
    let x = this.head
    for (let i = this.levelCount - 1; i >= 0; i--) {
      while (x.forward[i] && compareKeys(x.forward[i]!.key, entry.key) < 0) x = x.forward[i]!
      update[i] = x
    }
    const next = x.forward[0]
    if (next && compareKeys(next.key, entry.key) === 0) {
      this.bytes += estimateBytes(entry) - estimateBytes(next.entry)
      next.entry = entry
      return
    }
    const lvl = this.randomLevel()
    if (lvl > this.levelCount) {
      for (let i = this.levelCount; i < lvl; i++) update[i] = this.head
      this.levelCount = lvl
    }
    const node: SkipNode = { key: entry.key, entry, forward: new Array(lvl).fill(null) }
    for (let i = 0; i < lvl; i++) {
      node.forward[i] = update[i].forward[i]
      update[i].forward[i] = node
    }
    this.count++
    this.bytes += estimateBytes(entry)
  }

  /** The current entry for a key, or undefined if the key was never written to
   *  this memtable (a tombstone entry IS returned — deletion is a write). */
  get(key: IndexKey): Entry | undefined {
    let x = this.head
    for (let i = this.levelCount - 1; i >= 0; i--) {
      while (x.forward[i] && compareKeys(x.forward[i]!.key, key) < 0) x = x.forward[i]!
    }
    const next = x.forward[0]
    if (next && compareKeys(next.key, key) === 0) return next.entry
    return undefined
  }

  /** All entries in ascending key order — the base lane walked end to end. This
   *  is what a flush consumes to build a sorted SSTable in one linear pass. */
  entries(): Entry[] {
    const out: Entry[] = []
    let x = this.head.forward[0]
    while (x) {
      out.push(x.entry)
      x = x.forward[0]
    }
    return out
  }

  /** Entries with key in [lo, hi] (either bound optional / null = unbounded),
   *  ascending. Descends the express lanes to the first in-range node, then
   *  walks the base chain — the memtable's contribution to a range read. */
  range(lo: IndexKey | null, hi: IndexKey | null): Entry[] {
    let x = this.head
    if (lo) {
      for (let i = this.levelCount - 1; i >= 0; i--) {
        while (x.forward[i] && compareKeys(x.forward[i]!.key, lo) < 0) x = x.forward[i]!
      }
    }
    const out: Entry[] = []
    let n = x.forward[0]
    while (n) {
      if (hi && compareKeys(n.key, hi) > 0) break
      out.push(n.entry)
      n = n.forward[0]
    }
    return out
  }

  /** A structural snapshot for the Lab: each node with its tower height, in
   *  order, plus the express-lane spans so the visualizer can draw the skips. */
  snapshot(): SkipSnapshot {
    const nodes: SkipNodeView[] = []
    let x = this.head.forward[0]
    while (x) {
      nodes.push({
        key: x.key,
        height: x.forward.length,
        tombstone: x.entry.tombstone,
        seq: x.entry.seq,
      })
      x = x.forward[0]
    }
    return { levelCount: this.levelCount, nodes }
  }
}

export interface SkipNodeView {
  key: IndexKey
  height: number
  tombstone: boolean
  seq: number
}
export interface SkipSnapshot {
  levelCount: number
  nodes: SkipNodeView[]
}

/** A cheap, deterministic byte estimate for an entry — a fixed record header
 *  plus a rough per-value size. Only relative sizes matter (flush threshold,
 *  amplification metrics), so this need not be exact. */
export function estimateBytes(entry: Entry): number {
  let n = 16
  for (const v of entry.key) n += valBytes(v)
  return n + (entry.tombstone ? 0 : valBytes(entry.value))
}

function valBytes(v: unknown): number {
  if (v === null || v === undefined) return 1
  if (typeof v === 'number') return 8
  if (typeof v === 'boolean') return 1
  if (typeof v === 'string') return 2 + v.length
  // tagged values (decimal/temporal/json/array/…) — a rough constant.
  return 24
}
