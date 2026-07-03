// Count–Min sketch — point frequency of a stream in sublinear space.
//
// "How many times did key x appear?" over a stream too big to keep a per-key
// counter for. Count–Min (Cormode & Muthukrishnan 2005) keeps a `d × w` grid of
// counters and `d` independent hash rows. To add x, bump one cell per row
// (`row i` at column `h_i(x)`); to query x, read those same d cells and take
// the MINIMUM. Every cell x touches also absorbs collisions from other keys, so
// each cell is an over-count — and the min is the tightest of the d over-counts.
//
// The guarantee is one-sided and crisp: the estimate NEVER underestimates, and
// with `w = ⌈e/ε⌉`, `d = ⌈ln 1/δ⌉` it overestimates by at most `ε·N` (N = total
// count) with probability ≥ 1 − δ. The conservative-update variant (Estan &
// Varghese) raises only the rows currently at the min, which never loosens the
// bound and empirically tightens it a lot. Element-wise addition merges two
// sketches, so partial counts combine — the monoid again.
//
// Double-hashing (`h_i = h1 + i·h2`, Kirsch–Mitzenmacher) gives the d rows from
// two base hashes without d independent hash functions.

import { hashValue64 } from './hash'
import type { SqlValue } from '../types'

export class CountMin {
  readonly d: number // rows (depth)
  readonly w: number // columns (width)
  readonly counts: Float64Array // d*w counters, row-major
  private total = 0
  readonly conservative: boolean

  constructor(opts: { epsilon?: number; delta?: number; d?: number; w?: number; conservative?: boolean } = {}) {
    if (opts.d !== undefined && opts.w !== undefined) {
      this.d = opts.d
      this.w = opts.w
    } else {
      const epsilon = opts.epsilon ?? 0.01
      const delta = opts.delta ?? 0.01
      this.w = Math.max(2, Math.ceil(Math.E / epsilon))
      this.d = Math.max(1, Math.ceil(Math.log(1 / delta)))
    }
    this.counts = new Float64Array(this.d * this.w)
    this.conservative = opts.conservative ?? false
  }

  /** The d column indices key x maps to, one per row. */
  private cols(v: SqlValue, out: Int32Array): void {
    const h = hashValue64(v)
    const h1 = h.lo >>> 0
    const h2 = (h.hi | 1) >>> 0 // odd, so it's coprime-ish with w and mixes rows
    for (let i = 0; i < this.d; i++) {
      out[i] = ((h1 + Math.imul(i, h2)) >>> 0) % this.w
    }
  }

  private scratch = new Int32Array(0)
  private ensureScratch(): Int32Array {
    if (this.scratch.length !== this.d) this.scratch = new Int32Array(this.d)
    return this.scratch
  }

  /** Add `n` (default 1) occurrences of a value. */
  add(v: SqlValue, n = 1): void {
    const cols = this.ensureScratch()
    this.cols(v, cols)
    this.total += n
    if (this.conservative) {
      // Raise only the rows that are currently the minimum, up to min+n.
      let min = Infinity
      for (let i = 0; i < this.d; i++) {
        const c = this.counts[i * this.w + cols[i]]
        if (c < min) min = c
      }
      const target = min + n
      for (let i = 0; i < this.d; i++) {
        const idx = i * this.w + cols[i]
        if (this.counts[idx] < target) this.counts[idx] = target
      }
    } else {
      for (let i = 0; i < this.d; i++) this.counts[i * this.w + cols[i]] += n
    }
  }

  /** The estimated frequency of a value (never an underestimate). */
  estimate(v: SqlValue): number {
    const cols = this.ensureScratch()
    this.cols(v, cols)
    let min = Infinity
    for (let i = 0; i < this.d; i++) {
      const c = this.counts[i * this.w + cols[i]]
      if (c < min) min = c
    }
    return min === Infinity ? 0 : min
  }

  /** Total count folded in (N). */
  count(): number {
    return this.total
  }

  /** The additive over-estimate bound ε·N at this width. */
  errorBound(): number {
    return (Math.E / this.w) * this.total
  }

  byteSize(): number {
    return this.counts.length * 8
  }

  /** Element-wise add another same-shape sketch. */
  merge(other: CountMin): void {
    if (other.d !== this.d || other.w !== this.w) throw new Error('cannot merge Count–Min of different shape')
    for (let i = 0; i < this.counts.length; i++) this.counts[i] += other.counts[i]
    this.total += other.total
  }

  clone(): CountMin {
    const c = new CountMin({ d: this.d, w: this.w, conservative: this.conservative })
    c.counts.set(this.counts)
    c.total = this.total
    return c
  }
}
