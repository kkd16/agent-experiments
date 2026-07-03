// Reservoir sampling — a bounded uniform sample of an unbounded stream.
//
// `TABLESAMPLE` and any "give me k representative rows" need a fixed-size sample
// drawn UNIFORMLY from a stream whose length you don't know in advance (and may
// never fully see). Algorithm R (Vitter 1985) does it in one pass, O(k) memory:
// keep the first k items; for item i > k, replace a uniformly random reservoir
// slot with probability k/i. A short induction shows every one of the n items
// ends with the same k/n inclusion probability — a genuinely uniform sample.
//
// The weighted variant A-Res (Efraimidis & Spirakis 2006) draws a key
// u^(1/wᵢ) for each item and keeps the k largest keys — a stream-friendly
// weighted-without-replacement sample (heavier rows more likely). Both are
// mergeable (union the candidate keys, keep the top k), so samples combine
// across partitions.
//
// Every draw comes from the studio's deterministic `Rng`, so a sample — like a
// fuzz run — is replayable byte-for-byte from its seed.

import { Rng } from '../fuzz/rng'

export class Reservoir<T> {
  readonly k: number
  private readonly rng: Rng
  private readonly buf: T[] = []
  private seen = 0

  constructor(k: number, seed = 1) {
    if (k < 1) throw new Error('reservoir size k must be ≥ 1')
    this.k = k
    this.rng = new Rng(seed)
  }

  add(item: T): void {
    this.seen++
    if (this.buf.length < this.k) {
      this.buf.push(item)
      return
    }
    // Replace a random slot with probability k/seen.
    const j = this.rng.int(0, this.seen - 1)
    if (j < this.k) this.buf[j] = item
  }

  /** The current sample (≤ k items). */
  sample(): T[] {
    return this.buf.slice()
  }

  /** The number of items seen so far (the true stream length). */
  count(): number {
    return this.seen
  }

  byteSize(): number {
    return this.buf.length * 8
  }
}

interface WeightedKey<T> {
  key: number // the A-Res priority u^(1/w)
  item: T
}

/** Weighted reservoir (A-Res): keep the k items with the largest u^(1/wᵢ) keys. */
export class WeightedReservoir<T> {
  readonly k: number
  private readonly rng: Rng
  private heap: WeightedKey<T>[] = [] // a min-heap on key, so the smallest is evictable
  private seen = 0

  constructor(k: number, seed = 1) {
    if (k < 1) throw new Error('reservoir size k must be ≥ 1')
    this.k = k
    this.rng = new Rng(seed)
  }

  add(item: T, weight: number): void {
    if (weight <= 0) return
    this.seen++
    const u = Math.max(this.rng.next(), 1e-12)
    const key = Math.pow(u, 1 / weight)
    if (this.heap.length < this.k) {
      this.heap.push({ key, item })
      this.siftUp(this.heap.length - 1)
    } else if (key > this.heap[0].key) {
      this.heap[0] = { key, item }
      this.siftDown(0)
    }
  }

  sample(): T[] {
    return this.heap.map((h) => h.item)
  }

  count(): number {
    return this.seen
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.heap[parent].key <= this.heap[i].key) break
      ;[this.heap[parent], this.heap[i]] = [this.heap[i], this.heap[parent]]
      i = parent
    }
  }

  private siftDown(i: number): void {
    const n = this.heap.length
    for (;;) {
      let smallest = i
      const l = 2 * i + 1
      const r = 2 * i + 2
      if (l < n && this.heap[l].key < this.heap[smallest].key) smallest = l
      if (r < n && this.heap[r].key < this.heap[smallest].key) smallest = r
      if (smallest === i) break
      ;[this.heap[smallest], this.heap[i]] = [this.heap[i], this.heap[smallest]]
      i = smallest
    }
  }
}
