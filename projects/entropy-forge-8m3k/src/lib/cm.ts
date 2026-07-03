// cm.ts — a from-scratch **context-mixing** compressor: the PAQ/lpaq family, the
// architecture behind the strongest general-purpose compressors ever measured.
//
// The idea, in one breath: to code the next *bit*, ask a panel of models — one per
// context (the last 0,1,2,3,4,6 bytes; the current word; the longest repeat) —
// each of which reports P(next bit = 1). A **logistic mixer** (online logistic
// regression) blends those opinions in the log-odds domain, weighting each model by
// how useful it has proven so far; two **adaptive probability maps** (SSE) refine
// the blend; a **binary arithmetic coder** codes the bit against the final
// probability. Then every model, the mixer and the SSE stages learn from the bit
// that actually occurred. Nothing is transmitted but the coded bitstream — the
// decoder rebuilds the identical panel and replays the identical updates, so it
// round-trips by construction.
//
// Everything here is integer and deterministic: encode and decode call the very
// same Predictor, so a correct predictor is automatically a correct codec. Zero
// dependencies; ~a few hundred lines.

import { squash, stretch, clampP } from './logistic.ts'

// ---------------------------------------------------------------------------
// Tunables. The lab's inputs are small (bytes → a few KB), so modest hashed
// tables are collision-free in practice while staying fast and light on memory.
// ---------------------------------------------------------------------------
export const ORDERS = [0, 1, 2, 3, 4, 6] // byte-context models, in bytes of history
const HASH_BITS = 16
const SIZE = 1 << HASH_BITS // entries per context model (65536)
const IDX_SHIFT = 32 - HASH_BITS
const NUM_SM = ORDERS.length + 1 // StateMap-backed models: the orders + a word model
const MATCH_SLOT = NUM_SM // mixer index of the match model (not a StateMap)
export const NUM_INPUTS = NUM_SM + 1 // mixer inputs (8): 6 orders + word + match
const SEL_SETS = 512 // mixer weight sets, selected by (match active, partial byte)
const SM_LIMIT = 1023 // count cap in the adaptive probability estimator
const MATCH_MIN = 4 // bytes that must agree before the match model fires
const MATCH_HASH_BITS = 18
const MATCH_HSIZE = 1 << MATCH_HASH_BITS

// FNV-1a-style 32-bit mixing over integers; Math.imul keeps it exact mod 2^32 so
// encoder and decoder hash identically.
function fold(h: number, x: number): number {
  return Math.imul(h ^ (x >>> 0), 16777619) >>> 0
}
function slotIndex(base: number, c0: number): number {
  // Combine a per-byte context hash with the partial byte, take the top HASH_BITS.
  return (Math.imul(base ^ c0, 2654435761) >>> IDX_SHIFT) & (SIZE - 1)
}

// ---------------------------------------------------------------------------
// StateMap — an adaptive P(bit=1) per context. Stored as a 22-bit probability plus
// a saturating count; the count makes the learning rate ∝ 1/n, so a fresh context
// adapts fast and a well-seen one holds steady (a nonstationary running estimate).
// ---------------------------------------------------------------------------
class StateMap {
  prob = new Int32Array(SIZE).fill(1 << 21) // start at 0.5 in 22-bit fixed point
  cnt = new Uint16Array(SIZE)
  /** 12-bit prediction for context idx. */
  p(idx: number): number {
    return this.prob[idx] >> 10
  }
  /** Move context idx toward the observed bit y. */
  update(idx: number, y: number): void {
    const pr = this.prob[idx]
    const n = this.cnt[idx]
    this.prob[idx] = pr + (((y * 4194304 - pr) / (n + 2)) | 0)
    if (n < SM_LIMIT) this.cnt[idx] = n + 1
  }
}

// ---------------------------------------------------------------------------
// APM (Adaptive Probability Map / SSE) — refines a probability using a context, by
// interpolating over 33 quantised stretch buckets and adapting each bucket toward
// the truth. The classic secondary-symbol-estimation stage.
// ---------------------------------------------------------------------------
class APM {
  t: Int32Array
  index = 0
  constructor(n: number) {
    this.t = new Int32Array(n * 33)
    for (let i = 0; i < n; i++)
      for (let j = 0; j < 33; j++) this.t[i * 33 + j] = squash((j - 16) * 128) * 16
  }
  pp(pr: number, cx: number): number {
    const s = stretch(pr)
    const w = s & 127
    this.index = ((s + 2048) >> 7) + cx * 33
    return (this.t[this.index] * (128 - w) + this.t[this.index + 1] * w) >> 11
  }
  update(y: number, rate = 7): void {
    const g = (y << 16) + (y << rate) - y - y
    this.t[this.index] += (g - this.t[this.index]) >> rate
    this.t[this.index + 1] += (g - this.t[this.index + 1]) >> rate
  }
}

// ---------------------------------------------------------------------------
// The Predictor — assembles the panel, the mixer and the SSE chain. `predict()`
// returns the 12-bit probability of the next bit and stashes everything `update(y)`
// needs to learn. Public fields expose the internals for the visualiser.
// ---------------------------------------------------------------------------
export class Predictor {
  // model state
  private sm: StateMap[] = Array.from({ length: NUM_SM }, () => new StateMap())
  private weights = new Int32Array(SEL_SETS * NUM_INPUTS).fill((65536 / NUM_INPUTS) | 0)
  private apm1 = new APM(256)
  private apm2 = new APM(256)
  private history: number[] = []
  private ctxBase = new Int32Array(ORDERS.length)
  private wordBase = 2166136261 | 0
  private wordHash = 2166136261 | 0
  private lastByte = 0

  // match model
  private matchTable = new Int32Array(MATCH_HSIZE).fill(-1)
  private matchPtr = -1
  matchLen = 0

  // per-bit stash (also the visualiser's window into the panel)
  private c0 = 1 // partial byte: a leading 1 followed by the bits seen so far
  private bitsSeen = 0
  private stIdx = new Int32Array(NUM_SM)
  tx = new Int32Array(NUM_INPUTS) // stretched model opinions this bit
  private selSet = 0
  private pMix = 2048 // mixer output (12-bit), before SSE
  pFinal = 2048 // final probability fed to the coder (12-bit)

  constructor() {
    this.recomputeContexts()
  }

  /** P(next bit = 1), 12-bit. Call exactly once before each update(). */
  predict(): number {
    const c0 = this.c0
    const tx = this.tx
    // order + word models
    for (let m = 0; m < NUM_SM; m++) {
      const base = m < ORDERS.length ? this.ctxBase[m] : this.wordBase
      const idx = slotIndex(base, c0)
      this.stIdx[m] = idx
      tx[m] = stretch(this.sm[m].p(idx))
    }
    // match model: predict the bit that followed this context last time
    tx[MATCH_SLOT] = this.matchPrediction()
    // logistic mix
    this.selSet = (this.matchLen > 0 ? 256 : 0) + (c0 & 255)
    const base = this.selSet * NUM_INPUTS
    let dot = 0
    for (let i = 0; i < NUM_INPUTS; i++) dot += this.weights[base + i] * tx[i]
    this.pMix = clampP(squash(Math.floor(dot / 65536)))
    // two SSE stages, then a weighted blend
    const p1 = this.apm1.pp(this.pMix, c0 & 255)
    const p2 = this.apm2.pp(this.pMix, this.lastByte & 255)
    this.pFinal = clampP((p1 + 3 * p2) >> 2)
    return this.pFinal
  }

  /** Learn from the actual bit y, then advance the model state. */
  update(y: number): void {
    // mixer: online logistic-regression step on the mixer's own output
    const err = (y << 12) - this.pMix
    const base = this.selSet * NUM_INPUTS
    for (let i = 0; i < NUM_INPUTS; i++) {
      let w = this.weights[base + i] + ((this.tx[i] * err) >> 10)
      if (w > 1 << 20) w = 1 << 20
      else if (w < -(1 << 20)) w = -(1 << 20)
      this.weights[base + i] = w
    }
    // context models + SSE learn
    for (let m = 0; m < NUM_SM; m++) this.sm[m].update(this.stIdx[m], y)
    this.apm1.update(y)
    this.apm2.update(y)
    // advance the partial byte; on a full byte, roll the context state forward
    this.c0 = (this.c0 << 1) | y
    if (++this.bitsSeen === 8) {
      this.pushByte(this.c0 & 255)
      this.c0 = 1
      this.bitsSeen = 0
    }
  }

  // --- match model -----------------------------------------------------------
  private matchPrediction(): number {
    if (this.matchLen <= 0 || this.matchPtr < 0 || this.matchPtr >= this.history.length) return 0
    const predByte = this.history[this.matchPtr]
    const j = this.bitsSeen // bits already placed in c0 this byte
    // the match is only usable while the bits seen so far still agree with predByte
    if (j > 0 && this.c0 - (1 << j) !== predByte >> (8 - j)) return 0
    const expected = (predByte >> (7 - j)) & 1
    const strength = Math.min(400 + this.matchLen * 64, 2047)
    return expected ? strength : -strength
  }

  private pushByte(b: number): void {
    const h = this.history
    h.push(b)
    const len = h.length
    this.lastByte = b
    // advance / re-seek the match
    if (this.matchLen > 0 && this.matchPtr >= 0 && this.matchPtr < len - 1 && h[this.matchPtr] === b) {
      this.matchPtr++
      this.matchLen++
    } else {
      this.matchLen = 0
      this.matchPtr = -1
    }
    // hash the last MATCH_MIN bytes; on a miss, adopt the stored candidate
    if (len >= MATCH_MIN) {
      let hh = 2166136261 | 0
      for (let k = 0; k < MATCH_MIN; k++) hh = fold(hh, h[len - MATCH_MIN + k])
      const key = (hh >>> (32 - MATCH_HASH_BITS)) & (MATCH_HSIZE - 1)
      if (this.matchLen === 0) {
        const cand = this.matchTable[key]
        if (cand >= 0 && cand < len) {
          this.matchPtr = cand
          this.matchLen = MATCH_MIN
        }
      }
      this.matchTable[key] = len // predict the byte that will land at index `len`
    }
    this.recomputeContexts()
  }

  private recomputeContexts(): void {
    const h = this.history
    const len = h.length
    for (let oi = 0; oi < ORDERS.length; oi++) {
      const o = ORDERS[oi]
      let hash = fold(2166136261 | 0, o + 1)
      for (let k = 0; k < o; k++) hash = fold(hash, k < len ? h[len - 1 - k] : 256)
      this.ctxBase[oi] = hash | 0
    }
    // word model: fold letters into a rolling hash, reset on a non-letter boundary
    const c = this.lastByte
    const isLetter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
    if (isLetter) this.wordHash = fold(this.wordHash, c | 0x20)
    else this.wordHash = 2166136261 | 0
    this.wordBase = this.wordHash | 0
  }

  /** The mixer's current weight vector for the active set (for the visualiser). */
  weightsForActiveSet(): number[] {
    const base = this.selSet * NUM_INPUTS
    return Array.from({ length: NUM_INPUTS }, (_, i) => this.weights[base + i])
  }
}

// ---------------------------------------------------------------------------
// Binary arithmetic coder — a carryless 32-bit range coder driven one bit at a
// time by a 12-bit probability. The fpaq0/lpaq scheme: narrow [x1,x2] by the
// predicted split, shift out settled top bytes. Encoder and decoder are exact
// mirrors, so the same probability stream inverts the same bits.
// ---------------------------------------------------------------------------
class BinEncoder {
  private x1 = 0
  private x2 = 0xffffffff
  private out: number[] = []
  encode(bit: number, p: number): void {
    const range = (this.x2 - this.x1) >>> 0
    const xmid = (this.x1 + Math.floor(range / 4096) * p) >>> 0
    if (bit) this.x2 = xmid
    else this.x1 = (xmid + 1) >>> 0
    while (((this.x1 ^ this.x2) & 0xff000000) === 0) {
      this.out.push((this.x2 >>> 24) & 0xff)
      this.x1 = (this.x1 << 8) >>> 0
      this.x2 = ((this.x2 << 8) | 0xff) >>> 0
    }
  }
  finish(): Uint8Array {
    // flush enough of x1 to pin the final interval; the decoder pads with zeros
    for (let i = 0; i < 4; i++) {
      this.out.push((this.x1 >>> 24) & 0xff)
      this.x1 = (this.x1 << 8) >>> 0
    }
    return Uint8Array.from(this.out)
  }
}

class BinDecoder {
  private x1 = 0
  private x2 = 0xffffffff
  private x = 0
  private pos = 0
  private data: Uint8Array
  constructor(data: Uint8Array) {
    this.data = data
    for (let i = 0; i < 4; i++) this.x = ((this.x << 8) | this.next()) >>> 0
  }
  private next(): number {
    return this.pos < this.data.length ? this.data[this.pos++] : 0
  }
  decode(p: number): number {
    const range = (this.x2 - this.x1) >>> 0
    const xmid = (this.x1 + Math.floor(range / 4096) * p) >>> 0
    let bit: number
    if (this.x <= xmid) {
      bit = 1
      this.x2 = xmid
    } else {
      bit = 0
      this.x1 = (xmid + 1) >>> 0
    }
    while (((this.x1 ^ this.x2) & 0xff000000) === 0) {
      this.x1 = (this.x1 << 8) >>> 0
      this.x2 = ((this.x2 << 8) | 0xff) >>> 0
      this.x = ((this.x << 8) | this.next()) >>> 0
    }
    return bit
  }
}

// ---------------------------------------------------------------------------
// The codec: bytes ↔ a CM-coded bitstream. MSB-first within each byte.
// ---------------------------------------------------------------------------
export interface CmResult {
  encoded: Uint8Array
  bits: number
}

export function cmEncode(data: Uint8Array): CmResult {
  const pr = new Predictor()
  const enc = new BinEncoder()
  for (let n = 0; n < data.length; n++) {
    const byte = data[n]
    for (let j = 7; j >= 0; j--) {
      const bit = (byte >> j) & 1
      enc.encode(bit, pr.predict())
      pr.update(bit)
    }
  }
  return { encoded: enc.finish(), bits: data.length * 8 }
}

export function cmDecode(comp: Uint8Array, length: number): Uint8Array {
  const pr = new Predictor()
  const dec = new BinDecoder(comp)
  const out = new Uint8Array(length)
  for (let n = 0; n < length; n++) {
    let byte = 0
    for (let j = 0; j < 8; j++) {
      const bit = dec.decode(pr.predict())
      pr.update(bit)
      byte = (byte << 1) | bit
    }
    out[n] = byte
  }
  return out
}

// ---------------------------------------------------------------------------
// cmAnalyze — one instrumented pass for the lab page. Reuses the exact Predictor,
// so what it reports is what the coder actually pays.
// ---------------------------------------------------------------------------
export interface CmTrace {
  totalBits: number // ideal coded size in bits (Σ -log2 p of each bit)
  bpc: number // bits per input byte
  perByteBpc: { label: string; value: number }[] // compression curve, sampled
  modelAccuracy: { name: string; acc: number; conf: number }[] // per model
  finalWeights: number[] // mixer weights for the last active set
  matchTrace: { label: string; value: number }[] // match length over position
  ribbon: { p: number; bit: number }[] // first bits: predicted p vs actual
}

const MODEL_NAMES = [...ORDERS.map((o) => (o === 0 ? 'order-0' : `order-${o}`)), 'word', 'match']

export function cmAnalyze(data: Uint8Array, ribbonBits = 256): CmTrace {
  const pr = new Predictor()
  let totalBits = 0
  const acc = new Float64Array(NUM_INPUTS)
  const confSum = new Float64Array(NUM_INPUTS)
  const confN = new Float64Array(NUM_INPUTS)
  const ribbon: { p: number; bit: number }[] = []

  // compression curve: average bpc over ~48 buckets across the file
  const BUCKETS = Math.min(48, Math.max(1, data.length))
  const bucketBits = new Float64Array(BUCKETS)
  const bucketBytes = new Float64Array(BUCKETS)

  // match length sampled over position
  const MSAMPLES = 64
  const matchTrace: { label: string; value: number }[] = []
  const matchEvery = Math.max(1, Math.floor(data.length / MSAMPLES))

  let bitCounter = 0
  for (let n = 0; n < data.length; n++) {
    const byte = data[n]
    let byteBits = 0
    for (let j = 7; j >= 0; j--) {
      const p = pr.predict()
      const bit = (byte >> j) & 1
      const pTrue = bit ? p : 4096 - p
      const cost = -Math.log2(pTrue / 4096)
      totalBits += cost
      byteBits += cost
      // per-model correctness, weighted by how confident that model was
      for (let i = 0; i < NUM_INPUTS; i++) {
        const t = pr.tx[i]
        if (t !== 0) {
          const predicts1 = t > 0
          if (predicts1 === (bit === 1)) acc[i] += 1
          confSum[i] += Math.abs(t)
          confN[i] += 1
        }
      }
      if (bitCounter < ribbonBits) ribbon.push({ p, bit })
      pr.update(bit)
      bitCounter++
    }
    const b = Math.min(BUCKETS - 1, Math.floor((n / data.length) * BUCKETS))
    bucketBits[b] += byteBits
    bucketBytes[b] += 1
    if (n % matchEvery === 0) matchTrace.push({ label: `${n}`, value: pr.matchLen })
  }

  const modelAccuracy = MODEL_NAMES.map((name, i) => ({
    name,
    acc: confN[i] > 0 ? acc[i] / confN[i] : 0,
    conf: confN[i] > 0 ? confSum[i] / confN[i] : 0,
  }))
  const perByteBpc: { label: string; value: number }[] = []
  for (let b = 0; b < BUCKETS; b++) {
    if (bucketBytes[b] > 0) perByteBpc.push({ label: `${b}`, value: bucketBits[b] / bucketBytes[b] })
  }

  return {
    totalBits,
    bpc: data.length > 0 ? totalBits / data.length : 0,
    perByteBpc,
    modelAccuracy,
    finalWeights: pr.weightsForActiveSet(),
    matchTrace,
    ribbon,
  }
}

export { MODEL_NAMES }
