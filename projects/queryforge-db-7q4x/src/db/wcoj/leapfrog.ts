// The **Leapfrog unary join**: intersect `k` sorted trie iterators positioned at
// the *same* variable, streaming their common keys in sorted order. This is the
// heart of a worst-case-optimal join — a single-variable k-way sorted
// intersection whose cost is `O(k · min_i |R_i| · log(max/min))`, dominated by
// the *smallest* relation.
//
// The algorithm (Veldhuizen): keep the iterators sorted by their current key,
// round-robin. The leader is the largest key, the tail the smallest; `seek` the
// tail up to the leader. If they meet, that key is in every relation — emit it.
// Otherwise the tail becomes the new leader and we go again. Always advancing
// the trailing cursor is what makes it output-optimal.

import { orderValues, type SqlValue } from '../types'
import type { TrieIterator } from './trie'

export class LeapfrogJoin {
  private readonly iters: TrieIterator[]
  private readonly k: number
  private p = 0
  private ended = false

  /** `iters` are consumed/reordered internally — pass a private copy. */
  constructor(iters: TrieIterator[]) {
    this.iters = iters
    this.k = iters.length
  }

  init(): void {
    if (this.k === 0) {
      this.ended = true
      return
    }
    for (const it of this.iters) {
      it.rewind()
      if (it.atEnd()) {
        this.ended = true
        return
      }
    }
    this.iters.sort((a, b) => orderValues(a.key(), b.key()))
    this.p = 0
    this.search()
  }

  atEnd(): boolean {
    return this.ended
  }
  key(): SqlValue {
    return this.iters[this.p].key()
  }

  private search(): void {
    const it = this.iters
    const k = this.k
    for (;;) {
      const max = it[(this.p + k - 1) % k].key()
      const min = it[this.p].key()
      if (orderValues(min, max) === 0) return // all k agree — a common key
      it[this.p].seek(max)
      if (it[this.p].atEnd()) {
        this.ended = true
        return
      }
      this.p = (this.p + 1) % k
    }
  }

  next(): void {
    this.iters[this.p].next()
    if (this.iters[this.p].atEnd()) {
      this.ended = true
      return
    }
    this.p = (this.p + 1) % this.k
    this.search()
  }

  /** Materialise the whole intersection (used by tests / small levels). */
  collect(): SqlValue[] {
    const out: SqlValue[] = []
    this.init()
    while (!this.atEnd()) {
      out.push(this.key())
      this.next()
    }
    return out
  }
}
