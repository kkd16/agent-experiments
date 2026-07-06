// An immutable Sorted String Table (SSTable) — the on-disk unit of an LSM.
//
// When a memtable fills it is flushed, once, to an SSTable: a **sorted, immutable**
// run of entries. Immutability is the whole trick — an SSTable is written once and
// never updated in place, so it needs no locking, no rebalancing and no free-space
// management; a "delete" or "overwrite" is simply a newer entry in a newer table
// that shadows this one, reconciled at read time. Files only ever appear (flush)
// or disappear wholesale (compaction).
//
// The physical layout mirrors LevelDB's:
//   • entries are grouped into fixed-size **blocks** (the I/O unit);
//   • a **sparse index** holds the first key of each block, so a point lookup is
//     a binary search over blocks + a linear scan of one block — never the whole
//     file;
//   • **fence pointers** (min/max key) let a level skip an SSTable whose range
//     can't contain the target before even consulting the filter;
//   • a **Bloom filter** over every key turns a probable miss into an O(1) "no".
//
// One entry per key: the builder is fed an already-reconciled, key-sorted run
// (from a memtable flush or a compaction merge), newest-seq-wins already applied.

import { compareKeys, type IndexKey } from '../storage/btree'
import { hashKey } from '../types'
import { BloomFilter } from './bloom'
import { estimateBytes, type Entry } from './skiplist'

interface Block {
  firstKey: IndexKey
  entries: Entry[]
}

let SSTABLE_ID = 1
/** Reset the SSTable id counter — used by the deterministic self-tests so table
 *  ids (which show up in traces/snapshots) replay identically. */
export function resetSSTableIds(): void {
  SSTABLE_ID = 1
}

export class SSTable {
  readonly id: number
  readonly blocks: Block[] = []
  readonly index: { firstKey: IndexKey; block: number }[] = []
  readonly bloom: BloomFilter
  readonly minKey: IndexKey
  readonly maxKey: IndexKey
  readonly count: number
  readonly bytes: number
  /** True once this run has reached the bottom level, where a tombstone has no
   *  older data left to shadow and may be dropped. Set by the tree. */
  readonly hasTombstones: boolean

  /** Build from a key-sorted, reconciled run (one entry per key, ascending). */
  constructor(run: Entry[], blockSize = 16, fpr = 0.01) {
    this.id = SSTABLE_ID++
    this.count = run.length
    this.bloom = new BloomFilter(run.length, fpr)
    let bytes = 0
    let anyTomb = false
    for (let i = 0; i < run.length; i += blockSize) {
      const slice = run.slice(i, i + blockSize)
      const block: Block = { firstKey: slice[0].key, entries: slice }
      this.index.push({ firstKey: slice[0].key, block: this.blocks.length })
      this.blocks.push(block)
      for (const e of slice) {
        this.bloom.add(hashKey(e.key))
        bytes += estimateBytes(e)
        if (e.tombstone) anyTomb = true
      }
    }
    this.bytes = bytes
    this.hasTombstones = anyTomb
    this.minKey = run.length ? run[0].key : []
    this.maxKey = run.length ? run[run.length - 1].key : []
  }

  /** Could this table hold `key` at all? Cheap fence-pointer test before the
   *  filter — a level uses it to binary-search its non-overlapping runs. */
  mayContain(key: IndexKey): boolean {
    if (this.count === 0) return false
    return compareKeys(key, this.minKey) >= 0 && compareKeys(key, this.maxKey) <= 0
  }

  /** Point lookup. Returns the entry (possibly a tombstone) for `key`, or
   *  undefined. Bloom-gated: a filter miss returns immediately with no block
   *  read (`filtered` reports that for the read-amplification metrics). */
  get(key: IndexKey): { entry?: Entry; filtered: boolean; scanned: number } {
    if (!this.mayContain(key)) return { filtered: false, scanned: 0 }
    if (!this.bloom.mightContain(hashKey(key))) return { filtered: true, scanned: 0 }
    // Binary search the sparse index for the last block whose firstKey <= key.
    let lo = 0
    let hi = this.index.length - 1
    let bi = 0
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      if (compareKeys(this.index[mid].firstKey, key) <= 0) {
        bi = this.index[mid].block
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    const block = this.blocks[bi]
    let scanned = 0
    for (const e of block.entries) {
      scanned++
      const c = compareKeys(e.key, key)
      if (c === 0) return { entry: e, filtered: false, scanned }
      if (c > 0) break
    }
    return { filtered: false, scanned }
  }

  /** All entries in [lo, hi] (bounds optional), ascending — the table's slice
   *  of a range read, fed to the tree's k-way merge. */
  range(lo: IndexKey | null, hi: IndexKey | null): Entry[] {
    const out: Entry[] = []
    // Find the first block that could contain lo.
    let startBlock = 0
    if (lo) {
      let a = 0
      let b = this.index.length - 1
      while (a <= b) {
        const mid = (a + b) >>> 1
        if (compareKeys(this.index[mid].firstKey, lo) <= 0) {
          startBlock = this.index[mid].block
          a = mid + 1
        } else {
          b = mid - 1
        }
      }
    }
    for (let bi = startBlock; bi < this.blocks.length; bi++) {
      const block = this.blocks[bi]
      // Whole block past hi? stop.
      if (hi && compareKeys(block.firstKey, hi) > 0) break
      for (const e of block.entries) {
        if (lo && compareKeys(e.key, lo) < 0) continue
        if (hi && compareKeys(e.key, hi) > 0) return out
        out.push(e)
      }
    }
    return out
  }

  /** Every entry, ascending — used by compaction merges. */
  all(): Entry[] {
    const out: Entry[] = []
    for (const b of this.blocks) for (const e of b.entries) out.push(e)
    return out
  }

  /** Whether this table's key range overlaps [min, max] of another — the
   *  predicate leveled compaction uses to pick the next level's inputs. */
  overlaps(min: IndexKey, max: IndexKey): boolean {
    if (this.count === 0) return false
    return compareKeys(this.minKey, max) <= 0 && compareKeys(this.maxKey, min) >= 0
  }
}
