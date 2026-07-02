// arithmetic.ts — a real integer arithmetic coder (Witten–Neal–Cleary, 1987).
//
// Huffman is optimal only among *integer-length* codes, so it wastes up to ~1
// bit per symbol. Arithmetic coding sidesteps that: it represents the whole
// message as a single number inside a shrinking interval [low, high), spending a
// *fractional* number of bits per symbol and reaching the entropy bound. This is
// the genuine article — 32-bit integer registers with E1/E2/E3 renormalisation
// and underflow (pending-bit) handling, not a floating-point toy. Paired with an
// adaptive model it needs no probability table transmitted, so it is the fair
// entropy coder in the benchmark.
//
// We use plain JS numbers (exact integers up to 2^53) rather than 32-bit bitwise
// ops, so the 32-bit registers never overflow into the sign bit.

import { BitReader, BitWriter } from './bits.ts'

const PRECISION = 32
const WHOLE = 2 ** PRECISION // 2^32
const HALF = WHOLE / 2
const QUARTER = WHOLE / 4
const THREE_Q = 3 * QUARTER
const MASK = WHOLE - 1

// A frequency model exposes cumulative counts. The coder never looks at symbols
// directly — only at [cumLow, cumHigh) out of `total()`. Adaptive models mutate
// on update(); the decoder runs the identical mutation so both stay in lock-step.
export interface Model {
  total(): number
  /** Cumulative range [low, high) for `symbol`, out of total(). */
  encodeRange(symbol: number): [number, number]
  /** Given a scaled value in [0, total()), return its symbol and range. */
  decodeSymbol(scaled: number): { symbol: number; low: number; high: number }
  /** Advance the adaptive state after (en/de)coding `symbol`. */
  update(symbol: number): void
}

// ---- Adaptive order-0 model: one running histogram over the whole alphabet. ----
export class Order0Adaptive implements Model {
  private freq: Int32Array
  private cum: Int32Array // cum[i] = sum of freq[0..i-1]; length alphabet+1
  private totalCount: number
  private readonly maxTotal = 1 << 22 // rescale before the coder's total limit
  private alphabet: number

  constructor(alphabet = 256) {
    this.alphabet = alphabet
    this.freq = new Int32Array(alphabet).fill(1)
    this.cum = new Int32Array(alphabet + 1)
    this.totalCount = alphabet
    this.rebuildCum()
  }
  private rebuildCum() {
    let s = 0
    for (let i = 0; i < this.alphabet; i++) {
      this.cum[i] = s
      s += this.freq[i]
    }
    this.cum[this.alphabet] = s
    this.totalCount = s
  }
  total() {
    return this.totalCount
  }
  encodeRange(symbol: number): [number, number] {
    return [this.cum[symbol], this.cum[symbol + 1]]
  }
  decodeSymbol(scaled: number) {
    // Linear scan is fine for the lab's inputs; a Fenwick tree would scale better.
    let symbol = 0
    while (this.cum[symbol + 1] <= scaled) symbol++
    return { symbol, low: this.cum[symbol], high: this.cum[symbol + 1] }
  }
  update(symbol: number) {
    this.freq[symbol] += 16 // faster adaptation than +1
    this.totalCount += 16
    for (let i = symbol + 1; i <= this.alphabet; i++) this.cum[i] += 16
    if (this.totalCount >= this.maxTotal) this.rescale()
  }
  private rescale() {
    for (let i = 0; i < this.alphabet; i++) this.freq[i] = (this.freq[i] >> 1) || 1
    this.rebuildCum()
  }
}

// ---- Adaptive order-1 model: a separate histogram per previous byte. ----
// This is where context modelling pays off: English text is far more predictable
// once you know the preceding character, so this routinely beats order-0.
export class Order1Adaptive implements Model {
  private freq: Int32Array // [ctx*alphabet + sym]
  private ctxTotal: Int32Array
  private ctx = 0
  private readonly maxTotal = 1 << 22
  private alphabet: number
  constructor(alphabet = 256) {
    this.alphabet = alphabet
    this.freq = new Int32Array(alphabet * alphabet).fill(1)
    this.ctxTotal = new Int32Array(alphabet).fill(alphabet)
  }
  private base() {
    return this.ctx * this.alphabet
  }
  total() {
    return this.ctxTotal[this.ctx]
  }
  encodeRange(symbol: number): [number, number] {
    const b = this.base()
    let low = 0
    for (let i = 0; i < symbol; i++) low += this.freq[b + i]
    return [low, low + this.freq[b + symbol]]
  }
  decodeSymbol(scaled: number) {
    const b = this.base()
    let symbol = 0
    let low = 0
    for (;;) {
      const f = this.freq[b + symbol]
      if (low + f > scaled) return { symbol, low, high: low + f }
      low += f
      symbol++
    }
  }
  update(symbol: number) {
    const b = this.base()
    this.freq[b + symbol] += 16
    this.ctxTotal[this.ctx] += 16
    if (this.ctxTotal[this.ctx] >= this.maxTotal) {
      let t = 0
      for (let i = 0; i < this.alphabet; i++) {
        this.freq[b + i] = (this.freq[b + i] >> 1) || 1
        t += this.freq[b + i]
      }
      this.ctxTotal[this.ctx] = t
    }
    this.ctx = symbol // previous byte becomes the next context
  }
}

export type ModelFactory = () => Model

export interface ArithResult {
  encoded: Uint8Array
  encodedBits: number
  length: number
}

/** Arithmetic-encode `data`; the model is produced fresh so decode can mirror it. */
export function arithEncode(data: Uint8Array, makeModel: ModelFactory): ArithResult {
  const model = makeModel()
  const w = new BitWriter()
  let low = 0
  let high = MASK
  let pending = 0

  const emit = (bit: number) => {
    w.writeBit(bit)
    while (pending > 0) {
      w.writeBit(bit ^ 1)
      pending--
    }
  }

  for (const sym of data) {
    const total = model.total()
    const [cLow, cHigh] = model.encodeRange(sym)
    const range = high - low + 1
    high = low + Math.floor((range * cHigh) / total) - 1
    low = low + Math.floor((range * cLow) / total)
    // Renormalise: shift out settled high bits and resolve E3 underflow.
    for (;;) {
      if (high < HALF) {
        emit(0)
      } else if (low >= HALF) {
        emit(1)
        low -= HALF
        high -= HALF
      } else if (low >= QUARTER && high < THREE_Q) {
        pending++
        low -= QUARTER
        high -= QUARTER
      } else break
      low = low * 2
      high = high * 2 + 1
    }
    model.update(sym)
  }
  // Flush: two bits disambiguate the final interval.
  pending++
  if (low < QUARTER) emit(0)
  else emit(1)

  const encodedBits = w.bitLength
  return { encoded: w.finish(), encodedBits, length: data.length }
}

/** Inverse of arithEncode. Runs the same model updates to stay synchronised. */
export function arithDecode(encoded: Uint8Array, length: number, makeModel: ModelFactory): Uint8Array {
  const model = makeModel()
  const r = new BitReader(encoded)
  const out = new Uint8Array(length)
  let low = 0
  let high = MASK
  let code = 0
  for (let i = 0; i < PRECISION; i++) code = code * 2 + r.readBit()

  for (let n = 0; n < length; n++) {
    const total = model.total()
    const range = high - low + 1
    const scaled = Math.floor(((code - low + 1) * total - 1) / range)
    const { symbol, low: cLow, high: cHigh } = model.decodeSymbol(scaled)
    out[n] = symbol
    high = low + Math.floor((range * cHigh) / total) - 1
    low = low + Math.floor((range * cLow) / total)
    for (;;) {
      if (high < HALF) {
        // nothing
      } else if (low >= HALF) {
        low -= HALF
        high -= HALF
        code -= HALF
      } else if (low >= QUARTER && high < THREE_Q) {
        low -= QUARTER
        high -= QUARTER
        code -= QUARTER
      } else break
      low = low * 2
      high = high * 2 + 1
      code = code * 2 + r.readBit()
    }
    model.update(symbol)
  }
  return out
}

// ---- Visualisation helper (decoupled from the integer coder) ----
// For a short input and a static probability table, compute the sequence of
// [low, high) sub-intervals of [0,1) the message carves out. This is the mental
// model of arithmetic coding, rendered exactly with floating point (fine for the
// handful of symbols the visualiser animates).
export interface IntervalStep {
  symbol: number
  low: number
  high: number
  width: number
}
export function intervalTrace(
  data: Uint8Array,
  probs: Map<number, number>,
  cumOrder: number[],
): IntervalStep[] {
  // Build cumulative bounds in the given symbol order.
  const cum = new Map<number, [number, number]>()
  let acc = 0
  for (const s of cumOrder) {
    const p = probs.get(s) ?? 0
    cum.set(s, [acc, acc + p])
    acc += p
  }
  const steps: IntervalStep[] = []
  let low = 0
  let high = 1
  for (const sym of data) {
    const [cl, ch] = cum.get(sym) ?? [0, 1]
    const w = high - low
    high = low + w * ch
    low = low + w * cl
    steps.push({ symbol: sym, low, high, width: high - low })
  }
  return steps
}
