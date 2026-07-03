// A sorted-array **trie** and the linear **trie iterator** of Veldhuizen's
// "Leapfrog Triejoin" (ICDT 2014). The trie for a relation is just its tuples
// sorted lexicographically by a chosen variable order; the *levels* of the trie
// are the columns, and a node at level d is a maximal block of tuples that agree
// on columns 0..d-1. The iterator exposes exactly the six-method interface the
// join needs — `key / next / seek / atEnd / open / up` — every move `O(log n)`
// via binary search over the current block.

import { orderValues, type SqlValue } from '../types'
import type { Relation, Tuple } from './relation'

/**
 * A relation re-projected onto the subsequence of a global variable order that
 * it participates in, its tuples sorted lexicographically by that order. This is
 * the concrete trie the iterator walks.
 */
export class SortedTrie {
  /** This relation's variables, in *global* order (a subsequence of it). */
  readonly vars: string[]
  /** Tuples, columns permuted to `vars` order and sorted lexicographically. */
  readonly rows: Tuple[]

  constructor(rel: Relation, globalOrder: string[]) {
    // The relation's variables, ordered by their position in the global order.
    const vars = rel.vars.slice().sort((a, b) => globalOrder.indexOf(a) - globalOrder.indexOf(b))
    const perm = vars.map((v) => rel.indexOf(v))
    this.vars = vars
    const rows = rel.tuples.map((t) => perm.map((i) => t[i]))
    rows.sort((a, b) => {
      for (let i = 0; i < a.length; i++) {
        const c = orderValues(a[i], b[i])
        if (c !== 0) return c
      }
      return 0
    })
    // Rows are already deduped upstream, but permutation can't introduce dups.
    this.rows = rows
  }

  iterator(): TrieIterator {
    return new TrieIterator(this)
  }
}

/**
 * The linear trie iterator. `depth` is the level (column) currently being
 * iterated; `lohi[d]` is the `[lo, hi)` block of rows sharing the bound prefix
 * of length d; `pos[d]` is the cursor within that block, always pointing at the
 * first row of the *current key group*.
 */
export class TrieIterator {
  private readonly trie: SortedTrie
  private readonly rows: Tuple[]
  private depth = 0
  private readonly lohi: Array<{ lo: number; hi: number }>
  private readonly pos: number[]

  constructor(trie: SortedTrie) {
    this.trie = trie
    this.rows = trie.rows
    this.lohi = [{ lo: 0, hi: this.rows.length }]
    this.pos = [0]
  }

  get atDepth(): number {
    return this.depth
  }
  get vars(): string[] {
    return this.trie.vars
  }

  /** The key at the current level (undefined behaviour if `atEnd()`). */
  key(): SqlValue {
    return this.rows[this.pos[this.depth]][this.depth]
  }
  atEnd(): boolean {
    return this.pos[this.depth] >= this.lohi[this.depth].hi
  }

  /** Advance to the next distinct key at this level (skip the current block). */
  next(): void {
    const d = this.depth
    const hi = this.lohi[d].hi
    let p = this.pos[d]
    const k = this.rows[p][d]
    p++
    while (p < hi && orderValues(this.rows[p][d], k) === 0) p++
    this.pos[d] = p
  }

  /** Advance to the least key `>= v` at this level (binary search, forward). */
  seek(v: SqlValue): void {
    const d = this.depth
    let lo = this.pos[d]
    let hi = this.lohi[d].hi
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (orderValues(this.rows[mid][d], v) < 0) lo = mid + 1
      else hi = mid
    }
    this.pos[d] = lo
  }

  /** Reset the cursor to the first key of the current level's block. */
  rewind(): void {
    this.pos[this.depth] = this.lohi[this.depth].lo
  }

  /** Descend into the current key's sub-trie (level d → d+1). */
  open(): void {
    const d = this.depth
    const p = this.pos[d]
    const k = this.rows[p][d]
    // Upper bound of the current key's block (first row with a strictly greater key).
    let lo = p
    let hi = this.lohi[d].hi
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (orderValues(this.rows[mid][d], k) <= 0) lo = mid + 1
      else hi = mid
    }
    this.depth = d + 1
    this.lohi[this.depth] = { lo: p, hi: lo }
    this.pos[this.depth] = p
  }

  /** Ascend one level (d → d-1). */
  up(): void {
    this.depth -= 1
  }

  /**
   * A structural oracle: the block ranges must nest (each level's range inside
   * its parent's), the cursor must sit inside its range, and the rows must be
   * sorted with the current prefix constant across the level's block. Used by
   * the self-tests, not the hot path.
   */
  checkInvariants(): void {
    for (let d = 1; d <= this.depth; d++) {
      const p = this.lohi[d - 1]
      const c = this.lohi[d]
      if (c.lo < p.lo || c.hi > p.hi) throw new Error(`level ${d} range escapes its parent`)
    }
    const r = this.lohi[this.depth]
    if (this.pos[this.depth] < r.lo || this.pos[this.depth] > r.hi) {
      throw new Error('cursor outside its level range')
    }
  }
}
