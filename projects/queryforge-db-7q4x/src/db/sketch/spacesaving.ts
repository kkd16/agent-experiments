// Space-Saving — the top-k heavy hitters of a stream in O(k) counters.
//
// Count–Min tells you the frequency of a key you name; Space-Saving (Metwally,
// Agrawal & El Abbadi 2005) tells you WHICH keys are frequent without being
// asked — the top-k problem. It keeps exactly `k` monitored (value, count,
// error) slots. A hit on a monitored value bumps its count. A hit on an
// unmonitored value EVICTS the current minimum slot, takes over its value, and
// inherits its count + 1 — recording that old min count as this new entry's
// error (the most it could be an over-count).
//
// The guarantee: any element with true frequency > N/k is definitely monitored,
// and every slot's true count lies in `[count − error, count]`. So the heavy
// hitters are never missed, and each estimate comes with a certified interval.
// This is exactly what powers a `SELECT APPROX_TOP_K(x, k)` — the hot keys, one
// pass, bounded memory, mergeable across partitions.
//
// Keyed on the engine's canonical `hashKey` so any SQL value (int, text, JSON,
// array, …) can be a stream element, with the original value kept for output.

import { hashKey } from '../types'
import type { SqlValue } from '../types'

interface Slot {
  key: string
  value: SqlValue
  count: number
  error: number
}

export interface HeavyHitter {
  value: SqlValue
  count: number // the (over-)estimated frequency
  error: number // count − error ≤ true frequency ≤ count
}

export class SpaceSaving {
  readonly capacity: number
  private readonly slots = new Map<string, Slot>()
  private total = 0

  constructor(capacity: number) {
    if (capacity < 1) throw new Error('Space-Saving capacity must be ≥ 1')
    this.capacity = capacity
  }

  add(v: SqlValue, n = 1): void {
    this.total += n
    const key = hashKey([v])
    const existing = this.slots.get(key)
    if (existing) {
      existing.count += n
      return
    }
    if (this.slots.size < this.capacity) {
      this.slots.set(key, { key, value: v, count: n, error: 0 })
      return
    }
    // Evict the minimum-count slot; the newcomer inherits its count as its error.
    let min: Slot | null = null
    for (const s of this.slots.values()) {
      if (min === null || s.count < min.count) min = s
    }
    if (min) {
      this.slots.delete(min.key)
      this.slots.set(key, { key, value: v, count: min.count + n, error: min.count })
    }
  }

  /** The top-k monitored values (default: all of them), most frequent first. */
  topK(k = this.capacity): HeavyHitter[] {
    const arr = [...this.slots.values()].sort((a, b) => b.count - a.count || (a.error - b.error))
    return arr.slice(0, k).map((s) => ({ value: s.value, count: s.count, error: s.error }))
  }

  /** A value is a *guaranteed* heavy hitter above threshold φ·N iff count − error > φ·N. */
  guaranteed(phi: number): HeavyHitter[] {
    const cut = phi * this.total
    return this.topK().filter((h) => h.count - h.error > cut)
  }

  count(): number {
    return this.total
  }

  size(): number {
    return this.slots.size
  }

  byteSize(): number {
    // A slot: a count + an error + a value reference ≈ 3 words.
    return this.slots.size * 24
  }

  /** Merge another summary in (Cormode–Hadjieleftheriou combine): sum shared, keep the largest). */
  merge(other: SpaceSaving): void {
    for (const s of other.slots.values()) {
      const mine = this.slots.get(s.key)
      if (mine) {
        mine.count += s.count
        mine.error += s.error
      } else {
        this.slots.set(s.key, { ...s })
      }
    }
    this.total += other.total
    // Trim back to capacity, keeping the largest counts.
    if (this.slots.size > this.capacity) {
      const keep = [...this.slots.values()].sort((a, b) => b.count - a.count).slice(0, this.capacity)
      this.slots.clear()
      for (const s of keep) this.slots.set(s.key, s)
    }
  }
}
