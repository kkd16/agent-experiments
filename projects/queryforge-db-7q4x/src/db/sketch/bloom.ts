// Bloom filter — approximate set membership, and a Bloom semijoin.
//
// "Might x be in this set?" answered in a bit array a fraction of the set's size.
// A Bloom filter (Bloom 1970) is `m` bits and `k` hash functions; adding x sets
// the k bits it hashes to, and a membership test checks those k bits. If any is
// 0, x is DEFINITELY absent (no false negatives, ever); if all are 1, x is
// *probably* present, with a false-positive rate ≈ (1 − e^(−kn/m))^k that we
// size to a target. The optimal k for a given m and expected n is (m/n)·ln2.
//
// The database payoff is the **Bloom semijoin** (a.k.a. a join filter): build a
// tiny filter over one relation's join keys, then drop the other relation's rows
// whose key isn't in it before the real join — a probabilistic pre-filter that
// can never drop a true match, only cheaply skip guaranteed non-matches. It is
// how real engines (Spark, Impala, Oracle) prune the probe side of a big join.
//
// The counting variant keeps 4-bit counters instead of bits so it supports
// deletes (a bit filter can't un-set a bit shared with another element).

import { hashValue64 } from './hash'
import type { SqlValue } from '../types'

/** The bit-optimal size (m bits, k hashes) for n items at false-positive rate p. */
export function bloomParams(n: number, p: number): { m: number; k: number } {
  const m = Math.max(8, Math.ceil((-n * Math.log(p)) / (Math.LN2 * Math.LN2)))
  const k = Math.max(1, Math.round((m / n) * Math.LN2))
  return { m, k }
}

export class BloomFilter {
  readonly m: number // bits
  readonly k: number // hash functions
  private readonly bits: Uint8Array
  private added = 0

  constructor(opts: { m?: number; k?: number; n?: number; p?: number } = {}) {
    if (opts.m !== undefined && opts.k !== undefined) {
      this.m = opts.m
      this.k = opts.k
    } else {
      const { m, k } = bloomParams(opts.n ?? 1000, opts.p ?? 0.01)
      this.m = m
      this.k = k
    }
    this.bits = new Uint8Array(Math.ceil(this.m / 8))
  }

  private idx(v: SqlValue, i: number): number {
    const h = hashValue64(v)
    // Double-hashing: h1 + i·h2, folded into [0, m).
    return (((h.lo >>> 0) + Math.imul(i, (h.hi | 1) >>> 0)) >>> 0) % this.m
  }

  add(v: SqlValue): void {
    for (let i = 0; i < this.k; i++) {
      const bit = this.idx(v, i)
      this.bits[bit >> 3] |= 1 << (bit & 7)
    }
    this.added++
  }

  /** False when x is definitely absent; true when x is probably present. */
  mayContain(v: SqlValue): boolean {
    for (let i = 0; i < this.k; i++) {
      const bit = this.idx(v, i)
      if ((this.bits[bit >> 3] & (1 << (bit & 7))) === 0) return false
    }
    return true
  }

  /** The predicted false-positive rate at the current fill. */
  falsePositiveRate(): number {
    return Math.pow(1 - Math.exp((-this.k * this.added) / this.m), this.k)
  }

  /** The fraction of bits set — a rough saturation gauge. */
  fillRatio(): number {
    let set = 0
    for (let i = 0; i < this.bits.length; i++) {
      let b = this.bits[i]
      while (b) {
        set += b & 1
        b >>= 1
      }
    }
    return set / this.m
  }

  byteSize(): number {
    return this.bits.length
  }

  count(): number {
    return this.added
  }

  /** Bitwise-OR another same-shape filter (the union — the monoid). */
  merge(other: BloomFilter): void {
    if (other.m !== this.m || other.k !== this.k) throw new Error('cannot merge Bloom filters of different shape')
    for (let i = 0; i < this.bits.length; i++) this.bits[i] |= other.bits[i]
    this.added += other.added
  }
}

/**
 * A Bloom semijoin: build a filter over `buildKeys`, return a predicate that
 * keeps only probe keys that MIGHT match — never dropping a true match, so the
 * downstream join stays exact while skipping guaranteed non-matches.
 */
export function bloomSemiJoin(buildKeys: SqlValue[], p = 0.01): (probeKey: SqlValue) => boolean {
  const bf = new BloomFilter({ n: Math.max(1, buildKeys.length), p })
  for (const kkey of buildKeys) bf.add(kkey)
  return (probeKey: SqlValue) => bf.mayContain(probeKey)
}

/** Counting Bloom filter — 4-bit counters, so it supports deletes. */
export class CountingBloomFilter {
  readonly m: number
  readonly k: number
  private readonly counters: Uint8Array // one counter per cell (capped at 255)

  constructor(opts: { m?: number; k?: number; n?: number; p?: number } = {}) {
    if (opts.m !== undefined && opts.k !== undefined) {
      this.m = opts.m
      this.k = opts.k
    } else {
      const { m, k } = bloomParams(opts.n ?? 1000, opts.p ?? 0.01)
      this.m = m
      this.k = k
    }
    this.counters = new Uint8Array(this.m)
  }

  private idx(v: SqlValue, i: number): number {
    const h = hashValue64(v)
    return (((h.lo >>> 0) + Math.imul(i, (h.hi | 1) >>> 0)) >>> 0) % this.m
  }

  add(v: SqlValue): void {
    for (let i = 0; i < this.k; i++) {
      const c = this.idx(v, i)
      if (this.counters[c] < 255) this.counters[c]++
    }
  }

  remove(v: SqlValue): void {
    // Only decrement if present (all counters nonzero) — never underflow.
    if (!this.mayContain(v)) return
    for (let i = 0; i < this.k; i++) {
      const c = this.idx(v, i)
      if (this.counters[c] > 0) this.counters[c]--
    }
  }

  mayContain(v: SqlValue): boolean {
    for (let i = 0; i < this.k; i++) {
      if (this.counters[this.idx(v, i)] === 0) return false
    }
    return true
  }

  byteSize(): number {
    return this.counters.length
  }
}
