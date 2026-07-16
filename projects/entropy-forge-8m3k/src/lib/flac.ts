// flac.ts — a from-scratch, spec-faithful FLAC lossless AUDIO codec.
//
// This is the lab's first codec for a new modality. Text and images are spatial;
// audio is a *time series*, and the idea that makes it compressible is the one
// PNG's scanline filters hinted at, pushed all the way: LINEAR PREDICTION. A
// sound sample is very nearly a linear combination of the ones just before it,
// so if you subtract off that prediction you're left with a small, white-ish
// RESIDUAL whose entropy is a fraction of the original — and residuals shaped
// like a two-sided geometric are exactly what a Rice code (intcodes.ts) spends
// the fewest bits on. That is FLAC in one sentence, and it is why FLAC (and ALAC,
// Shorten, TAK, WavPack) beat gzip on audio by a wide margin: gzip has no model
// of "the next sample is a smooth continuation of the last few".
//
// The pipeline, all integer and all exactly invertible:
//   • inter-channel decorrelation — stereo as mid/side or left/side, whichever
//     is smaller for this frame (the two channels of music are highly correlated);
//   • per-subframe predictor selection — CONSTANT / VERBATIM / one of the five
//     fixed polynomial predictors / a quantised-coefficient LPC predictor whose
//     coefficients come from Levinson–Durbin on the windowed autocorrelation;
//   • partitioned Rice coding of the residual — the block is split into 2^p
//     partitions, each with its OWN optimal Rice parameter, because a transient
//     and the silence after it want different k's;
//   • a real FLAC bitstream — the "fLaC" marker, a STREAMINFO metadata block, and
//     frames with the 14-bit sync code, UTF-8-coded frame numbers, per-frame
//     CRC-8 header + CRC-16 footer.
//
// Because every predictor is integer and its coefficients are STORED, the decoder
// replays the identical arithmetic and reconstructs the samples bit-for-bit — the
// same "a correct model is automatically a correct codec" invariant the PPM and
// context-mixing coders rely on. Round-tripped exhaustively on the Self-test page.

import { BitWriter, BitReader } from './bits.ts'
import { riceEncode, riceDecode, zigzag, unzigzag, bestRiceK } from './intcodes.ts'

// ---------------------------------------------------------------------------
// The PCM model. Samples are held per-channel as signed integers in
// [-2^(bps-1), 2^(bps-1)). `channels` is 1 (mono) or 2 (stereo).
// ---------------------------------------------------------------------------

export interface Pcm {
  sampleRate: number
  bitsPerSample: number
  channels: number
  /** samples[c][i] — one signed-integer array per channel, all the same length. */
  samples: Int32Array[]
}

export interface FlacOptions {
  blockSize?: number // samples per frame (default 4096)
  maxLpcOrder?: number // 0 disables LPC (default 8)
  lpcPrecision?: number // coefficient bit width (default 15)
}

// Subframe method identifiers used in the analysis output.
export type SubframeKind = 'constant' | 'verbatim' | 'fixed' | 'lpc'

export interface SubframeInfo {
  channel: number
  kind: SubframeKind
  order: number
  bits: number // coded bits this subframe took
  riceParams: number[] // per-partition Rice parameter (empty for constant/verbatim)
  partitionOrder: number
  shift?: number // LPC quantisation shift
  coefs?: number[] // LPC quantised coefficients
  /** For the first frame only, the residual signal, for the "prediction shrinks
   *  entropy" visual. Undefined otherwise to keep analysis light. */
  residual?: Int32Array
  warmup?: Int32Array
}

export interface FrameInfo {
  index: number
  blockSize: number
  stereo: StereoMode
  bytes: number
  subframes: SubframeInfo[]
}

export type StereoMode = 'mono' | 'independent' | 'left-side' | 'right-side' | 'mid-side'

export interface FlacAnalysis {
  bytes: Uint8Array
  frames: FrameInfo[]
  totalSamples: number
  headerBytes: number // bytes before the first frame (marker + STREAMINFO)
}

// ---------------------------------------------------------------------------
// CRC-8 (poly x⁸+x²+x+1 = 0x07) over the frame header, CRC-16 (x¹⁶+x¹⁵+x²+1 =
// 0x8005) over the whole frame. Both are the exact polynomials FLAC uses.
// ---------------------------------------------------------------------------

const CRC8_TABLE = (() => {
  const t = new Uint8Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff
    t[i] = c
  }
  return t
})()

const CRC16_TABLE = (() => {
  const t = new Uint16Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i << 8
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff
    t[i] = c
  }
  return t
})()

function crc8(data: Uint8Array): number {
  let c = 0
  for (let i = 0; i < data.length; i++) c = CRC8_TABLE[c ^ data[i]]
  return c
}

function crc16(data: Uint8Array): number {
  let c = 0
  for (let i = 0; i < data.length; i++) c = ((c << 8) ^ CRC16_TABLE[((c >> 8) ^ data[i]) & 0xff]) & 0xffff
  return c
}

// ---------------------------------------------------------------------------
// Signed bit I/O (two's complement, MSB-first, ≤ 32 bits).
// ---------------------------------------------------------------------------

function writeSigned(bw: BitWriter, v: number, bits: number): void {
  bw.writeBits(v, bits) // writeBits masks to low `bits` bits of the uint32 rep
}

function readSigned(br: BitReader, bits: number): number {
  const v = br.readBits(bits)
  return (v << (32 - bits)) >> (32 - bits) // sign-extend
}

// ---------------------------------------------------------------------------
// UTF-8-style coding of the frame number (as FLAC codes it). Byte-aligned.
// ---------------------------------------------------------------------------

function writeUtf8(bw: BitWriter, val: number): void {
  if (val < 0x80) {
    bw.writeBits(val, 8)
  } else if (val < 0x800) {
    bw.writeBits(0xc0 | (val >> 6), 8)
    bw.writeBits(0x80 | (val & 0x3f), 8)
  } else if (val < 0x10000) {
    bw.writeBits(0xe0 | (val >> 12), 8)
    bw.writeBits(0x80 | ((val >> 6) & 0x3f), 8)
    bw.writeBits(0x80 | (val & 0x3f), 8)
  } else if (val < 0x200000) {
    bw.writeBits(0xf0 | (val >> 18), 8)
    bw.writeBits(0x80 | ((val >> 12) & 0x3f), 8)
    bw.writeBits(0x80 | ((val >> 6) & 0x3f), 8)
    bw.writeBits(0x80 | (val & 0x3f), 8)
  } else if (val < 0x4000000) {
    bw.writeBits(0xf8 | (val >> 24), 8)
    for (let s = 18; s >= 0; s -= 6) bw.writeBits(0x80 | ((val >> s) & 0x3f), 8)
  } else {
    bw.writeBits(0xfc | Math.floor(val / 0x40000000), 8) // > 2^30 uses division to stay exact
    for (let s = 24; s >= 0; s -= 6) bw.writeBits(0x80 | ((val >> s) & 0x3f), 8)
  }
}

function readUtf8(br: BitReader): number {
  const b0 = br.readBits(8)
  if ((b0 & 0x80) === 0) return b0
  let n = 0
  let mask = 0x40
  while (b0 & mask) {
    n++
    mask >>= 1
  }
  let val = b0 & (mask - 1)
  for (let i = 0; i < n; i++) val = (val << 6) | (br.readBits(8) & 0x3f)
  return val >>> 0
}

// ---------------------------------------------------------------------------
// Residual coding — partitioned Rice.  Chooses the partition order and, within
// each partition, the Rice parameter (or an escape to raw n-bit samples) that
// minimises total bits. Method 0 uses 4-bit parameters (escape 15), method 1
// uses 5-bit parameters (escape 31); we pick method 1 only if some partition
// needs k ≥ 15.
// ---------------------------------------------------------------------------

interface ResidualPlan {
  method: number // 0 or 1
  partitionOrder: number
  params: number[] // per-partition: the Rice k, or ESCAPE
  rawBits: number[] // per-partition raw bit width when escaped, else 0
  bits: number // total coded bits (params + payload), excluding the 2+4 header
}

function escapeVal(method: number): number {
  return method === 0 ? 15 : 31
}

/** Bits to Rice-code one partition's residuals at parameter k. */
function partitionRiceBits(res: Int32Array, from: number, to: number, k: number): number {
  let bits = 0
  for (let i = from; i < to; i++) bits += (zigzag(res[i]) >>> k) + 1 + k
  return bits
}

/** The raw bit width that holds every residual in [from,to) as signed. */
function partitionRawBits(res: Int32Array, from: number, to: number): number {
  let maxMag = 0
  for (let i = from; i < to; i++) {
    const u = zigzag(res[i])
    if (u > maxMag) maxMag = u
  }
  if (maxMag === 0) return 0
  // signed width: need one sign bit + magnitude; from zigzag, actual value range.
  let minV = 0
  let maxV = 0
  for (let i = from; i < to; i++) {
    if (res[i] < minV) minV = res[i]
    if (res[i] > maxV) maxV = res[i]
  }
  let bits = 1
  while (maxV >= 1 << (bits - 1) || minV < -(1 << (bits - 1))) bits++
  return bits
}

function planResidual(res: Int32Array, blockSize: number, predOrder: number): ResidualPlan {
  // Largest partition order such that blockSize is divisible by 2^po and the
  // first (short) partition still has ≥ 1 residual.
  let maxPo = 0
  while (
    maxPo < 15 &&
    blockSize % (1 << (maxPo + 1)) === 0 &&
    blockSize >> (maxPo + 1) > predOrder
  ) {
    maxPo++
  }

  let best: ResidualPlan | null = null
  for (let po = 0; po <= maxPo; po++) {
    const parts = 1 << po
    const partSize = blockSize >> po
    const params: number[] = []
    const rawBits: number[] = []
    let total = 0
    let needMethod1 = false
    for (let p = 0; p < parts; p++) {
      const from = p === 0 ? predOrder : p * partSize
      const to = (p + 1) * partSize
      // best Rice k over the partition
      const zz: number[] = []
      for (let i = from; i < to; i++) zz.push(zigzag(res[i]))
      const { k } = bestRiceK(zz)
      const riceBits = partitionRiceBits(res, from, to, k)
      const raw = partitionRawBits(res, from, to)
      const rawTotal = 5 + raw * (to - from) // 5-bit width field + payload
      if (rawTotal < riceBits && raw < 32) {
        // escape is cheaper (e.g. noise) — but escape needs k=15/31 which forces
        // its own parameter field width; account below by marking method.
        params.push(-1) // sentinel: escaped
        rawBits.push(raw)
        total += rawTotal
      } else {
        params.push(k)
        rawBits.push(0)
        total += riceBits
        if (k >= 15) needMethod1 = true
      }
    }
    const method = needMethod1 ? 1 : 0
    const paramFieldBits = (method === 0 ? 4 : 5) * parts
    const bits = total + paramFieldBits
    if (!best || bits < best.bits) {
      best = { method, partitionOrder: po, params, rawBits, bits }
    }
  }
  return best!
}

function writeResidual(bw: BitWriter, res: Int32Array, blockSize: number, predOrder: number, plan: ResidualPlan): number[] {
  const usedParams: number[] = []
  bw.writeBits(plan.method, 2)
  bw.writeBits(plan.partitionOrder, 4)
  const parts = 1 << plan.partitionOrder
  const partSize = blockSize >> plan.partitionOrder
  const pbits = plan.method === 0 ? 4 : 5
  const esc = escapeVal(plan.method)
  for (let p = 0; p < parts; p++) {
    const from = p === 0 ? predOrder : p * partSize
    const to = (p + 1) * partSize
    if (plan.params[p] === -1) {
      bw.writeBits(esc, pbits)
      const raw = plan.rawBits[p]
      bw.writeBits(raw, 5)
      usedParams.push(esc)
      for (let i = from; i < to; i++) if (raw > 0) writeSigned(bw, res[i], raw)
    } else {
      const k = plan.params[p]
      bw.writeBits(k, pbits)
      usedParams.push(k)
      for (let i = from; i < to; i++) riceEncode(bw, zigzag(res[i]), k)
    }
  }
  return usedParams
}

function readResidual(br: BitReader, res: Int32Array, blockSize: number, predOrder: number): void {
  const method = br.readBits(2)
  const po = br.readBits(4)
  const parts = 1 << po
  const partSize = blockSize >> po
  const pbits = method === 0 ? 4 : 5
  const esc = escapeVal(method)
  for (let p = 0; p < parts; p++) {
    const from = p === 0 ? predOrder : p * partSize
    const to = (p + 1) * partSize
    const param = br.readBits(pbits)
    if (param === esc) {
      const raw = br.readBits(5)
      for (let i = from; i < to; i++) res[i] = raw > 0 ? readSigned(br, raw) : 0
    } else {
      for (let i = from; i < to; i++) res[i] = unzigzag(riceDecode(br, param))
    }
  }
}

// ---------------------------------------------------------------------------
// Fixed polynomial predictors (orders 0..4) — the closed-form finite differences.
// ---------------------------------------------------------------------------

function fixedResidual(x: Int32Array, order: number, blockSize: number): Int32Array {
  const res = new Int32Array(blockSize)
  for (let i = order; i < blockSize; i++) {
    let pred = 0
    switch (order) {
      case 0: pred = 0; break
      case 1: pred = x[i - 1]; break
      case 2: pred = 2 * x[i - 1] - x[i - 2]; break
      case 3: pred = 3 * x[i - 1] - 3 * x[i - 2] + x[i - 3]; break
      case 4: pred = 4 * x[i - 1] - 6 * x[i - 2] + 4 * x[i - 3] - x[i - 4]; break
    }
    res[i] = x[i] - pred
  }
  return res
}

function fixedRestore(x: Int32Array, res: Int32Array, order: number, blockSize: number): void {
  for (let i = order; i < blockSize; i++) {
    let pred = 0
    switch (order) {
      case 0: pred = 0; break
      case 1: pred = x[i - 1]; break
      case 2: pred = 2 * x[i - 1] - x[i - 2]; break
      case 3: pred = 3 * x[i - 1] - 3 * x[i - 2] + x[i - 3]; break
      case 4: pred = 4 * x[i - 1] - 6 * x[i - 2] + 4 * x[i - 3] - x[i - 4]; break
    }
    x[i] = res[i] + pred
  }
}

// ---------------------------------------------------------------------------
// LPC — Levinson–Durbin on the windowed autocorrelation, then coefficient
// quantisation (FLAC's error-feedback scheme).
// ---------------------------------------------------------------------------

/** Autocorrelation of a Welch-windowed block, lags 0..maxLag. */
function autocorrelation(x: Int32Array, blockSize: number, maxLag: number): Float64Array {
  const w = new Float64Array(blockSize)
  const N1 = blockSize - 1
  for (let i = 0; i < blockSize; i++) {
    const t = N1 > 0 ? (i - N1 / 2) / (N1 / 2) : 0 // Welch (parabolic) window
    w[i] = x[i] * (1 - t * t)
  }
  const ac = new Float64Array(maxLag + 1)
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0
    for (let i = lag; i < blockSize; i++) s += w[i] * w[i - lag]
    ac[lag] = s
  }
  return ac
}

/** Levinson–Durbin. Returns LPC coefficients for every order 1..maxOrder plus
 *  the modelling error at each order (for order selection). */
function levinson(ac: Float64Array, maxOrder: number): { coefs: number[][]; err: number[] } {
  const coefsByOrder: number[][] = []
  const errByOrder: number[] = []
  let err = ac[0]
  const lpc = new Float64Array(maxOrder)
  for (let i = 0; i < maxOrder; i++) {
    let r = -ac[i + 1]
    for (let j = 0; j < i; j++) r -= lpc[j] * ac[i - j]
    r = err !== 0 ? r / err : 0
    lpc[i] = r
    for (let j = 0; j < i >> 1; j++) {
      const tmp = lpc[j]
      lpc[j] += r * lpc[i - 1 - j]
      lpc[i - 1 - j] += r * tmp
    }
    if (i & 1) lpc[i >> 1] += lpc[i >> 1] * r
    err *= 1 - r * r
    // FLAC stores predictor coefficients as -lpc.
    const c: number[] = []
    for (let j = 0; j <= i; j++) c.push(-lpc[j])
    coefsByOrder.push(c)
    errByOrder.push(err)
  }
  return { coefs: coefsByOrder, err: errByOrder }
}

interface QuantisedLpc {
  coefs: number[]
  shift: number
  precision: number
}

/** Quantise real LPC coefficients to `precision`-bit integers with a shift,
 *  using error feedback (FLAC's method). Returns null if degenerate. */
function quantiseLpc(lp: number[], precision: number): QuantisedLpc | null {
  let cmax = 0
  for (const c of lp) cmax = Math.max(cmax, Math.abs(c))
  if (cmax <= 0 || !isFinite(cmax)) return null
  const maxShift = 15
  let shift = precision - 1 - (Math.floor(Math.log2(cmax)) + 1)
  if (shift > maxShift) shift = maxShift
  if (shift < 0) shift = 0
  const qmax = (1 << (precision - 1)) - 1
  const qmin = -(1 << (precision - 1))
  const scale = 2 ** shift
  const q: number[] = []
  let error = 0
  for (const c of lp) {
    error += c * scale
    let qi = Math.round(error)
    if (qi > qmax) qi = qmax
    else if (qi < qmin) qi = qmin
    error -= qi
    q.push(qi)
  }
  return { coefs: q, shift, precision }
}

/** Residual under a quantised LPC predictor (exact integer arithmetic). */
function lpcResidual(x: Int32Array, ql: QuantisedLpc, blockSize: number): Int32Array {
  const { coefs, shift } = ql
  const order = coefs.length
  const res = new Int32Array(blockSize)
  const div = 2 ** shift
  for (let i = order; i < blockSize; i++) {
    let sum = 0
    for (let j = 0; j < order; j++) sum += coefs[j] * x[i - 1 - j]
    res[i] = x[i] - Math.floor(sum / div)
  }
  return res
}

function lpcRestore(x: Int32Array, res: Int32Array, ql: QuantisedLpc, blockSize: number): void {
  const { coefs, shift } = ql
  const order = coefs.length
  const div = 2 ** shift
  for (let i = order; i < blockSize; i++) {
    let sum = 0
    for (let j = 0; j < order; j++) sum += coefs[j] * x[i - 1 - j]
    x[i] = res[i] + Math.floor(sum / div)
  }
}

// ---------------------------------------------------------------------------
// Subframe encoding — try every method, keep the smallest, and emit it.
// ---------------------------------------------------------------------------

interface SubframeChoice {
  kind: SubframeKind
  order: number
  bits: number
  emit: (bw: BitWriter) => number[] // returns the Rice params it used (for viz)
  res?: Int32Array
  ql?: QuantisedLpc
  warmup?: Int32Array
  partitionOrder: number
}

const SUBFRAME_HEADER_BITS = 8 // 1 (zero) + 6 (type) + 1 (wasted flag = 0)

function chooseSubframe(x: Int32Array, blockSize: number, bps: number, opts: Required<FlacOptions>): SubframeChoice {
  // CONSTANT — every sample identical.
  let allEqual = true
  for (let i = 1; i < blockSize; i++) if (x[i] !== x[0]) { allEqual = false; break }
  if (allEqual) {
    return {
      kind: 'constant', order: 0, partitionOrder: 0,
      bits: SUBFRAME_HEADER_BITS + bps,
      emit: (bw) => { writeSigned(bw, x[0], bps); return [] },
    }
  }

  const candidates: SubframeChoice[] = []

  // VERBATIM — the escape hatch, always valid.
  candidates.push({
    kind: 'verbatim', order: 0, partitionOrder: 0,
    bits: SUBFRAME_HEADER_BITS + bps * blockSize,
    emit: (bw) => { for (let i = 0; i < blockSize; i++) writeSigned(bw, x[i], bps); return [] },
  })

  // FIXED orders 0..min(4, blockSize-1).
  const maxFixed = Math.min(4, blockSize - 1)
  for (let order = 0; order <= maxFixed; order++) {
    const res = fixedResidual(x, order, blockSize)
    const plan = planResidual(res, blockSize, order)
    const bits = SUBFRAME_HEADER_BITS + order * bps + 2 + 4 + plan.bits
    candidates.push({
      kind: 'fixed', order, partitionOrder: plan.partitionOrder, res,
      bits,
      emit: (bw) => {
        for (let i = 0; i < order; i++) writeSigned(bw, x[i], bps)
        return writeResidual(bw, res, blockSize, order, plan)
      },
    })
  }

  // LPC — one candidate per order in a small ladder (compression-only choices;
  // decode replays exactly whatever we pick).
  if (opts.maxLpcOrder > 0 && blockSize > opts.maxLpcOrder + 1) {
    const maxOrder = Math.min(opts.maxLpcOrder, blockSize - 1, 32)
    const ac = autocorrelation(x, blockSize, maxOrder)
    if (ac[0] > 0) {
      const { coefs } = levinson(ac, maxOrder)
      const ladder = new Set<number>()
      for (const o of [1, 2, 4, 6, 8, 12, 16, 24, 32]) if (o <= maxOrder) ladder.add(o)
      ladder.add(maxOrder)
      for (const order of ladder) {
        const ql = quantiseLpc(coefs[order - 1], opts.lpcPrecision)
        if (!ql) continue
        const res = lpcResidual(x, ql, blockSize)
        const plan = planResidual(res, blockSize, order)
        const headerBits =
          SUBFRAME_HEADER_BITS + order * bps + 4 /*precision-1*/ + 5 /*shift*/ +
          order * ql.precision + 2 + 4
        const bits = headerBits + plan.bits
        candidates.push({
          kind: 'lpc', order, partitionOrder: plan.partitionOrder, res, ql,
          bits,
          emit: (bw) => {
            for (let i = 0; i < order; i++) writeSigned(bw, x[i], bps)
            bw.writeBits(ql.precision - 1, 4)
            bw.writeBits(ql.shift, 5)
            for (let j = 0; j < order; j++) writeSigned(bw, ql.coefs[j], ql.precision)
            return writeResidual(bw, res, blockSize, order, plan)
          },
        })
      }
    }
  }

  let best = candidates[0]
  for (const c of candidates) if (c.bits < best.bits) best = c
  best.warmup = best.order > 0 ? x.slice(0, best.order) : undefined
  return best
}

// ---------------------------------------------------------------------------
// Subframe type byte encoding (the 6-bit type field).
// ---------------------------------------------------------------------------

function subframeTypeBits(kind: SubframeKind, order: number): number {
  switch (kind) {
    case 'constant': return 0b000000
    case 'verbatim': return 0b000001
    case 'fixed': return 0b001000 | order
    case 'lpc': return 0b100000 | (order - 1)
  }
}

// ---------------------------------------------------------------------------
// Stereo decorrelation. Produces the two subframe channels for a given mode.
// ---------------------------------------------------------------------------

function decorrelate(l: Int32Array, r: Int32Array, mode: StereoMode, n: number): [Int32Array, Int32Array] {
  const a = new Int32Array(n)
  const b = new Int32Array(n)
  switch (mode) {
    case 'independent':
      a.set(l.subarray(0, n)); b.set(r.subarray(0, n)); break
    case 'left-side':
      for (let i = 0; i < n; i++) { a[i] = l[i]; b[i] = l[i] - r[i] } break
    case 'right-side':
      for (let i = 0; i < n; i++) { a[i] = l[i] - r[i]; b[i] = r[i] } break
    case 'mid-side':
      for (let i = 0; i < n; i++) { a[i] = (l[i] + r[i]) >> 1; b[i] = l[i] - r[i] } break
    default:
      a.set(l.subarray(0, n)); b.set(r.subarray(0, n))
  }
  return [a, b]
}

function recorrelate(a: Int32Array, b: Int32Array, mode: StereoMode, n: number): [Int32Array, Int32Array] {
  const l = new Int32Array(n)
  const r = new Int32Array(n)
  switch (mode) {
    case 'independent':
      l.set(a.subarray(0, n)); r.set(b.subarray(0, n)); break
    case 'left-side':
      for (let i = 0; i < n; i++) { l[i] = a[i]; r[i] = a[i] - b[i] } break
    case 'right-side':
      for (let i = 0; i < n; i++) { r[i] = b[i]; l[i] = a[i] + b[i] } break
    case 'mid-side':
      for (let i = 0; i < n; i++) {
        const side = b[i]
        const mid = (a[i] << 1) | (side & 1) // undo the >>1, recovering the lost LSB
        l[i] = (mid + side) >> 1
        r[i] = (mid - side) >> 1
      }
      break
  }
  return [l, r]
}

const CHANNEL_ASSIGN: Record<StereoMode, number> = {
  mono: 0b0000,
  independent: 0b0001,
  'left-side': 0b1000,
  'right-side': 0b1001,
  'mid-side': 0b1010,
}

// ---------------------------------------------------------------------------
// The encoder.
// ---------------------------------------------------------------------------

export function flacEncodeAnalyzed(pcm: Pcm, options: FlacOptions = {}): FlacAnalysis {
  const opts: Required<FlacOptions> = {
    blockSize: options.blockSize ?? 4096,
    maxLpcOrder: options.maxLpcOrder ?? 8,
    lpcPrecision: options.lpcPrecision ?? 15,
  }
  const bps = pcm.bitsPerSample
  const total = pcm.samples[0]?.length ?? 0
  const parts: Uint8Array[] = []

  // "fLaC" marker + STREAMINFO metadata block.
  parts.push(streamInfoBlock(pcm, total, opts.blockSize))
  const headerBytes = parts[0].length

  const frames: FrameInfo[] = []
  let frameIndex = 0
  for (let start = 0; start < Math.max(total, 1); start += opts.blockSize) {
    const n = Math.min(opts.blockSize, total - start)
    if (n <= 0) break
    const { bytes, info } = encodeFrame(pcm, start, n, frameIndex, bps, opts)
    parts.push(bytes)
    frames.push(info)
    frameIndex++
  }
  // Zero-sample edge case: still emit STREAMINFO only.

  let len = 0
  for (const p of parts) len += p.length
  const out = new Uint8Array(len)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return { bytes: out, frames, totalSamples: total, headerBytes }
}

export function flacEncode(pcm: Pcm, options: FlacOptions = {}): Uint8Array {
  return flacEncodeAnalyzed(pcm, options).bytes
}

function streamInfoBlock(pcm: Pcm, total: number, blockSize: number): Uint8Array {
  const bw = new BitWriter()
  // "fLaC"
  for (const ch of 'fLaC') bw.writeBits(ch.charCodeAt(0), 8)
  // metadata block header: last-block flag (1) + type (7 = 0 STREAMINFO) + length (24 = 34)
  bw.writeBit(1)
  bw.writeBits(0, 7)
  bw.writeBits(34, 24)
  // STREAMINFO body
  bw.writeBits(blockSize, 16) // min block size (approx; explicit block size in frames anyway)
  bw.writeBits(blockSize, 16) // max block size
  bw.writeBits(0, 24) // min frame size (unknown)
  bw.writeBits(0, 24) // max frame size (unknown)
  bw.writeBits(pcm.sampleRate, 20)
  bw.writeBits(pcm.channels - 1, 3)
  bw.writeBits(pcm.bitsPerSample - 1, 5)
  // total samples (36 bits) — split into 4 + 32 to stay within 32-bit writes.
  bw.writeBits(Math.floor(total / 0x100000000), 4)
  bw.writeBits(total >>> 0, 32)
  // MD5 (128 bits) — zeros = "not computed" (spec-valid).
  for (let i = 0; i < 16; i++) bw.writeBits(0, 8)
  return bw.finish()
}

function encodeFrame(
  pcm: Pcm, start: number, n: number, frameIndex: number, bps: number, opts: Required<FlacOptions>,
): { bytes: Uint8Array; info: FrameInfo } {
  // Pick the stereo mode (mono is forced for 1 channel).
  let mode: StereoMode = 'mono'
  let chA: Int32Array
  let chB: Int32Array | null = null
  let bpsA = bps
  let bpsB = bps

  if (pcm.channels === 1) {
    chA = pcm.samples[0].subarray(start, start + n) as Int32Array
    chA = Int32Array.from(chA)
  } else {
    const l = Int32Array.from(pcm.samples[0].subarray(start, start + n))
    const r = Int32Array.from(pcm.samples[1].subarray(start, start + n))
    // Estimate each mode's cost cheaply (sum of |2nd difference|) and pick min.
    const cost = (a: Int32Array) => {
      let s = 0
      for (let i = 2; i < n; i++) s += Math.abs(a[i] - 2 * a[i - 1] + a[i - 2])
      return Math.log2(1 + s / Math.max(1, n))
    }
    const cl = cost(l), cr = cost(r)
    const side = new Int32Array(n), mid = new Int32Array(n)
    for (let i = 0; i < n; i++) { side[i] = l[i] - r[i]; mid[i] = (l[i] + r[i]) >> 1 }
    const cs = cost(side), cm = cost(mid)
    const modes: { m: StereoMode; c: number }[] = [
      { m: 'independent', c: cl + cr },
      { m: 'left-side', c: cl + cs },
      { m: 'right-side', c: cr + cs },
      { m: 'mid-side', c: cm + cs },
    ]
    modes.sort((x, y) => x.c - y.c)
    mode = modes[0].m
    const [a, b] = decorrelate(l, r, mode, n)
    chA = a; chB = b
    // side channel carries one extra bit of range.
    if (mode === 'left-side' || mode === 'mid-side') bpsB = bps + 1
    if (mode === 'right-side') bpsA = bps + 1
  }

  // ---- frame header (byte-aligned) ----
  const hbw = new BitWriter()
  hbw.writeBits(0x3ffe, 14) // sync
  hbw.writeBit(0) // reserved
  hbw.writeBit(0) // blocking strategy = fixed block size
  hbw.writeBits(0b0111, 4) // block size: 16-bit (n-1) at end of header
  hbw.writeBits(0b0000, 4) // sample rate: get from STREAMINFO
  hbw.writeBits(CHANNEL_ASSIGN[mode], 4)
  hbw.writeBits(0b000, 3) // sample size: get from STREAMINFO
  hbw.writeBit(0) // reserved
  writeUtf8(hbw, frameIndex)
  hbw.writeBits(n - 1, 16) // explicit block size
  const headerBytes = hbw.finish()
  const c8 = crc8(headerBytes)

  // ---- subframes ----
  const sbw = new BitWriter()
  const subInfos: SubframeInfo[] = []
  const emitSub = (x: Int32Array, chBps: number, channel: number) => {
    const choice = chooseSubframe(x, n, chBps, opts)
    sbw.writeBit(0) // leading zero
    sbw.writeBits(subframeTypeBits(choice.kind, choice.order), 6)
    sbw.writeBit(0) // wasted-bits flag = 0
    const before = sbw.bitLength
    const params = choice.emit(sbw)
    const after = sbw.bitLength
    subInfos.push({
      channel, kind: choice.kind, order: choice.order,
      bits: after - before + SUBFRAME_HEADER_BITS,
      riceParams: params, partitionOrder: choice.partitionOrder,
      shift: choice.ql?.shift, coefs: choice.ql?.coefs,
      residual: frameIndex === 0 ? choice.res : undefined,
      warmup: frameIndex === 0 ? choice.warmup : undefined,
    })
  }
  emitSub(chA, bpsA, 0)
  if (chB) emitSub(chB, bpsB, 1)
  const subBytes = sbw.finish()

  // ---- assemble + CRC-16 ----
  const body = new Uint8Array(headerBytes.length + 1 + subBytes.length)
  body.set(headerBytes, 0)
  body[headerBytes.length] = c8
  body.set(subBytes, headerBytes.length + 1)
  const c16 = crc16(body)
  const frame = new Uint8Array(body.length + 2)
  frame.set(body, 0)
  frame[body.length] = (c16 >> 8) & 0xff
  frame[body.length + 1] = c16 & 0xff

  return {
    bytes: frame,
    info: { index: frameIndex, blockSize: n, stereo: mode, bytes: frame.length, subframes: subInfos },
  }
}

// ---------------------------------------------------------------------------
// The decoder — parse the metadata, then replay every frame's predictors.
// ---------------------------------------------------------------------------

export function flacDecode(data: Uint8Array): Pcm {
  if (data.length < 4 || String.fromCharCode(data[0], data[1], data[2], data[3]) !== 'fLaC') {
    throw new Error('not a FLAC stream (missing fLaC marker)')
  }
  // ---- metadata blocks ----
  let off = 4
  let sampleRate = 0, channels = 0, bitsPerSample = 0, totalSamples = 0
  for (;;) {
    const isLast = (data[off] & 0x80) !== 0
    const type = data[off] & 0x7f
    const len = (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3]
    const body = off + 4
    if (type === 0) {
      // STREAMINFO
      const br = new BitReader(data.subarray(body, body + len))
      br.readBits(16); br.readBits(16) // min/max block size
      br.readBits(24); br.readBits(24) // min/max frame size
      sampleRate = br.readBits(20)
      channels = br.readBits(3) + 1
      bitsPerSample = br.readBits(5) + 1
      const hi = br.readBits(4)
      const lo = br.readBits(32)
      totalSamples = hi * 0x100000000 + lo
    }
    off = body + len
    if (isLast) break
  }

  const channelsOut: Int32Array[] = []
  for (let c = 0; c < channels; c++) channelsOut.push(new Int32Array(totalSamples))

  const br = new BitReader(data.subarray(off))
  let decoded = 0
  while (decoded < totalSamples) {
    const n = decodeFrame(br, channels, bitsPerSample, channelsOut, decoded)
    decoded += n
  }

  return { sampleRate, bitsPerSample, channels, samples: channelsOut }
}

function align(br: BitReader): void {
  while (br.bitPos & 7) br.readBit()
}

function decodeFrame(br: BitReader, channels: number, bps: number, out: Int32Array[], outStart: number): number {
  align(br)
  const sync = br.readBits(14)
  if (sync !== 0x3ffe) throw new Error(`bad frame sync 0x${sync.toString(16)} at bit ${br.bitPos}`)
  br.readBit() // reserved
  br.readBit() // blocking strategy
  const bsBits = br.readBits(4)
  br.readBits(4) // sample rate bits (0 = from STREAMINFO)
  const chAssign = br.readBits(4)
  br.readBits(3) // sample size bits (0 = from STREAMINFO)
  br.readBit() // reserved
  readUtf8(br) // frame number (ignored — we decode sequentially)
  let n: number
  if (bsBits === 0b0110) n = br.readBits(8) + 1
  else if (bsBits === 0b0111) n = br.readBits(16) + 1
  else if (bsBits === 0b0001) n = 192
  else if (bsBits >= 0b0010 && bsBits <= 0b0101) n = 576 << (bsBits - 2)
  else if (bsBits >= 0b1000) n = 256 << (bsBits - 8)
  else throw new Error('reserved block size code')
  align(br) // skip CRC-8 byte
  br.readBits(8)

  // stereo mode from channel assignment
  let mode: StereoMode
  let bpsA = bps, bpsB = bps
  if (chAssign === 0b1000) { mode = 'left-side'; bpsB = bps + 1 }
  else if (chAssign === 0b1001) { mode = 'right-side'; bpsA = bps + 1 }
  else if (chAssign === 0b1010) { mode = 'mid-side'; bpsB = bps + 1 }
  else if (chAssign === 0b0000) mode = 'mono'
  else mode = 'independent'

  const decoded: Int32Array[] = []
  const nSub = channels
  for (let c = 0; c < nSub; c++) {
    const chBps = c === 0 ? bpsA : bpsB
    decoded.push(decodeSubframe(br, n, chBps))
  }

  // undo stereo decorrelation
  if (channels === 2) {
    const [l, r] = recorrelate(decoded[0], decoded[1], mode, n)
    for (let i = 0; i < n; i++) { out[0][outStart + i] = l[i]; out[1][outStart + i] = r[i] }
  } else {
    for (let i = 0; i < n; i++) out[0][outStart + i] = decoded[0][i]
  }

  align(br)
  br.readBits(16) // CRC-16 (not verified here; the round-trip test is the proof)
  return n
}

function decodeSubframe(br: BitReader, n: number, bps: number): Int32Array {
  br.readBit() // leading zero
  const type = br.readBits(6)
  const wastedFlag = br.readBit()
  let wasted = 0
  if (wastedFlag) { while (br.readBit() === 0) wasted++; wasted++ }

  const x = new Int32Array(n)
  if (type === 0b000000) {
    // CONSTANT
    const v = readSigned(br, bps)
    for (let i = 0; i < n; i++) x[i] = v
  } else if (type === 0b000001) {
    // VERBATIM
    for (let i = 0; i < n; i++) x[i] = readSigned(br, bps)
  } else if ((type & 0b111000) === 0b001000) {
    // FIXED
    const order = type & 0b000111
    for (let i = 0; i < order; i++) x[i] = readSigned(br, bps)
    const res = new Int32Array(n)
    readResidual(br, res, n, order)
    fixedRestore(x, res, order, n)
  } else if ((type & 0b100000) === 0b100000) {
    // LPC
    const order = (type & 0b011111) + 1
    for (let i = 0; i < order; i++) x[i] = readSigned(br, bps)
    const precision = br.readBits(4) + 1
    const shift = readSigned(br, 5)
    const coefs: number[] = []
    for (let j = 0; j < order; j++) coefs.push(readSigned(br, precision))
    const res = new Int32Array(n)
    readResidual(br, res, n, order)
    lpcRestore(x, res, { coefs, shift, precision }, n)
  } else {
    throw new Error(`reserved subframe type 0b${type.toString(2)}`)
  }

  if (wasted) for (let i = 0; i < n; i++) x[i] <<= wasted
  return x
}
