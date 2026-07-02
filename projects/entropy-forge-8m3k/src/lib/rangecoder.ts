// rangecoder.ts — the Witten–Neal–Cleary integer coder, *decoupled* from any
// probability model. arithmetic.ts drives its coder from a fixed `Model`
// interface; PPM cannot, because at every symbol it chooses a different context
// (and may emit escape symbols), so it needs to hand the coder an explicit
// [cumLow, cumHigh) out of `total` per step. These two classes expose exactly
// that primitive — `encode(cumLow, cumHigh, total)` on the way out and
// `decodeFreq(total)` / `decodeUpdate(...)` on the way back — over the same
// 32-bit registers with E1/E2/E3 renormalisation. Encoder and decoder stay in
// lock-step as long as the caller feeds them identical ranges, which is the whole
// contract PPM (and any adaptive model) relies on.

import { BitReader, BitWriter } from './bits.ts'

const PRECISION = 32
const WHOLE = 2 ** PRECISION
const HALF = WHOLE / 2
const QUARTER = WHOLE / 4
const THREE_Q = 3 * QUARTER
const MASK = WHOLE - 1

export class RangeEncoder {
  private w = new BitWriter()
  private low = 0
  private high = MASK
  private pending = 0

  private emit(bit: number) {
    this.w.writeBit(bit)
    while (this.pending > 0) {
      this.w.writeBit(bit ^ 1)
      this.pending--
    }
  }

  /** Narrow to the sub-interval [cumLow, cumHigh) of `total`, then renormalise. */
  encode(cumLow: number, cumHigh: number, total: number) {
    const range = this.high - this.low + 1
    this.high = this.low + Math.floor((range * cumHigh) / total) - 1
    this.low = this.low + Math.floor((range * cumLow) / total)
    for (;;) {
      if (this.high < HALF) {
        this.emit(0)
      } else if (this.low >= HALF) {
        this.emit(1)
        this.low -= HALF
        this.high -= HALF
      } else if (this.low >= QUARTER && this.high < THREE_Q) {
        this.pending++
        this.low -= QUARTER
        this.high -= QUARTER
      } else break
      this.low = this.low * 2
      this.high = this.high * 2 + 1
    }
  }

  finish(): Uint8Array {
    this.pending++
    this.emit(this.low < QUARTER ? 0 : 1)
    return this.w.finish()
  }

  get bitLength(): number {
    return this.w.bitLength
  }
}

export class RangeDecoder {
  private r: BitReader
  private low = 0
  private high = MASK
  private code = 0

  constructor(data: Uint8Array) {
    this.r = new BitReader(data)
    for (let i = 0; i < PRECISION; i++) this.code = this.code * 2 + this.r.readBit()
  }

  /** The scaled cumulative value in [0, total) the current code points at. */
  decodeFreq(total: number): number {
    const range = this.high - this.low + 1
    return Math.floor(((this.code - this.low + 1) * total - 1) / range)
  }

  /** Commit the symbol whose range is [cumLow, cumHigh); mirror encoder renorm. */
  decodeUpdate(cumLow: number, cumHigh: number, total: number) {
    const range = this.high - this.low + 1
    this.high = this.low + Math.floor((range * cumHigh) / total) - 1
    this.low = this.low + Math.floor((range * cumLow) / total)
    for (;;) {
      if (this.high < HALF) {
        // nothing
      } else if (this.low >= HALF) {
        this.low -= HALF
        this.high -= HALF
        this.code -= HALF
      } else if (this.low >= QUARTER && this.high < THREE_Q) {
        this.low -= QUARTER
        this.high -= QUARTER
        this.code -= QUARTER
      } else break
      this.low = this.low * 2
      this.high = this.high * 2 + 1
      this.code = this.code * 2 + this.r.readBit()
    }
  }
}
