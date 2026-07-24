// The concatenated deep-space chain — Reed–Solomon *outer* code over the app's own
// convolutional *inner* code (fec.ts), the exact structure of the CCSDS telemetry
// standard that carried Voyager, Galileo, Cassini and the Mars orbiters home.
//
// Why concatenate. A soft-decision Viterbi decoder is superb on average but fails
// in BURSTS: when it takes a wrong turn in the trellis it emits a clump of adjacent
// wrong bits before recovering. Those clumps are exactly what a Reed–Solomon code
// eats for breakfast — a whole wrong byte costs it only ONE of its 2t symbols. Put
// an RS(255,223) code (t = 16) outside the K=7 (171,133) convolutional code, spread
// its symbols across several codewords with a depth-I interleaver so no single
// Viterbi burst can overwhelm one codeword, and the pair reaches a bit-error rate
// the convolutional code alone would need several more dB to touch.
//
// This module is pure (a function of a seed) and leans on both rs.ts and fec.ts.

import { type RSCode, rsEncode, rsDecode, rsRng, randomMessage } from './rs'
import { CONV_CODES, buildTrellis, convEncode, viterbiSoft, type Trellis } from './fec'
import { qfunc } from './comms'
import { gaussian } from './fec'

export const INNER_CODE = CONV_CODES.find((c) => c.id === 'k7_r12')! // (171,133), the Voyager code
export const INNER_RATE = 0.5

// ---------------------------------------------------------------------------
// Byte / bit plumbing and the block interleaver.
// ---------------------------------------------------------------------------

/** A byte (or symbol) to its m bits, most-significant first. */
export function symToBits(sym: number, m: number): number[] {
  const out = new Array(m)
  for (let i = 0; i < m; i++) out[i] = (sym >> (m - 1 - i)) & 1
  return out
}

export function bitsToSym(bits: ArrayLike<number>, off: number, m: number): number {
  let v = 0
  for (let i = 0; i < m; i++) v = (v << 1) | (bits[off + i] & 1)
  return v
}

/**
 * Depth-I symbol interleaver. Given I codewords each of length n, the transmit
 * order reads column-by-column: symbol 0 of every codeword, then symbol 1 of every
 * codeword, … so a contiguous burst of length b in the channel touches at most
 * ⌈b / I⌉ symbols of any single codeword. `deinterleave` is the exact inverse.
 */
export function interleave(codewords: number[][], I: number, n: number): number[] {
  const out: number[] = []
  for (let col = 0; col < n; col++) for (let row = 0; row < I; row++) out.push(codewords[row][col])
  return out
}

export function deinterleave(stream: number[], I: number, n: number): number[][] {
  const cw: number[][] = Array.from({ length: I }, () => new Array(n).fill(0))
  let p = 0
  for (let col = 0; col < n; col++) for (let row = 0; row < I; row++) cw[row][col] = stream[p++]
  return cw
}

// ---------------------------------------------------------------------------
// A single concatenated frame through the full chain.
// ---------------------------------------------------------------------------

export interface ConcatFrame {
  /** the number of interleaved RS codewords in the frame. */
  I: number
  /** symbols per codeword (= code.n). */
  n: number
  /** byte-error positions the Viterbi decoder left, per codeword (row-major flags). */
  innerByteErrors: boolean[][]
  /** how many symbol errors landed in each codeword after de-interleaving. */
  errorsPerCodeword: number[]
  /** whether each RS codeword decoded successfully. */
  rsRecovered: boolean[]
  /** total inner (post-Viterbi) byte errors before RS. */
  innerByteErrorCount: number
  /** residual byte errors after RS decoding (0 ⇒ a perfect frame). */
  residualByteErrors: number
  /** true if every codeword recovered. */
  frameRecovered: boolean
  /** whether interleaving was applied. */
  interleaved: boolean
}

/**
 * Run one frame of I RS codewords through: RS encode → (optional) depth-I symbol
 * interleave → convolutional encode → BPSK over AWGN → soft Viterbi → de-interleave
 * → RS decode. `ebn0Db` is measured per bit entering the inner (convolutional) code.
 */
export function runConcatFrame(
  code: RSCode,
  ebn0Db: number,
  I: number,
  interleaved: boolean,
  seed: number,
  tr?: Trellis,
): ConcatFrame {
  const trellis = tr ?? buildTrellis(INNER_CODE)
  const rng = rsRng(seed)
  const m = code.field.m
  const n = code.n

  // 1. I RS codewords.
  const codewords: number[][] = []
  for (let i = 0; i < I; i++) codewords.push(rsEncode(code, randomMessage(code, rng)))

  // 2. Symbol order onto the wire.
  const txSymbols = interleaved ? interleave(codewords, I, n) : codewords.flat()

  // 3. Symbols → bits → convolutional code.
  const bits: number[] = []
  for (const s of txSymbols) bits.push(...symToBits(s, m))
  const coded = convEncode(bits, trellis) // Uint8Array of coded bits (+ tail)

  // 4. BPSK over AWGN. σ set from the info-bit Eb/N0 and the inner rate.
  const gamma = Math.pow(10, ebn0Db / 10)
  const sigma = Math.sqrt(1 / (2 * INNER_RATE * gamma))
  const rxSoft = new Float64Array(coded.length)
  for (let i = 0; i < coded.length; i++) rxSoft[i] = 1 - 2 * coded[i] + sigma * gaussian(rng)

  // 5. Soft Viterbi → recovered info bits (the K−1 flush bits are already removed).
  const vit = viterbiSoft(rxSoft, trellis)
  const decodedBits = vit.decoded // length = bits.length
  const nInfo = bits.length

  // 6. Bits → received symbols (with the Viterbi's burst errors baked in).
  const rxSymbols: number[] = []
  for (let off = 0; off + m <= nInfo; off += m) rxSymbols.push(bitsToSym(decodedBits, off, m))

  // 7. De-interleave back to codewords and mark which symbols the inner code got wrong.
  const rxCodewords = interleaved ? deinterleave(rxSymbols, I, n) : chunk(rxSymbols, n, I)
  const innerByteErrors: boolean[][] = []
  const errorsPerCodeword: number[] = []
  for (let i = 0; i < I; i++) {
    const flags = rxCodewords[i].map((v, j) => v !== codewords[i][j])
    innerByteErrors.push(flags)
    errorsPerCodeword.push(flags.filter(Boolean).length)
  }
  const innerByteErrorCount = errorsPerCodeword.reduce((a, b) => a + b, 0)

  // 8. RS decode each codeword.
  const rsRecovered: boolean[] = []
  let residual = 0
  for (let i = 0; i < I; i++) {
    const dec = rsDecode(code, rxCodewords[i])
    const good = dec.ok && !dec.corrected.some((v, j) => v !== codewords[i][j])
    rsRecovered.push(good)
    if (!good) residual += rxCodewords[i].filter((v, j) => v !== codewords[i][j]).length
  }

  return {
    I,
    n,
    innerByteErrors,
    errorsPerCodeword,
    rsRecovered,
    innerByteErrorCount,
    residualByteErrors: residual,
    frameRecovered: rsRecovered.every(Boolean),
    interleaved,
  }
}

function chunk(arr: number[], size: number, count: number): number[][] {
  const out: number[][] = []
  for (let i = 0; i < count; i++) out.push(arr.slice(i * size, (i + 1) * size))
  return out
}

// ---------------------------------------------------------------------------
// A waterfall across the chain: uncoded vs convolutional-only vs concatenated.
// ---------------------------------------------------------------------------

export interface ConcatPoint {
  ebn0Db: number
  /** uncoded BPSK bit-error rate (closed form) at this Eb/N0. */
  uncoded: number
  /** post-Viterbi byte-error rate of the RS-coded stream (the inner code alone). */
  innerByteError: number
  /** post-RS frame-error rate (fraction of frames with any unrecovered codeword). */
  concatFrameError: number
  /** post-RS residual byte-error rate (0 across a run ⇒ perfect). */
  concatByteError: number
  frames: number
}

/** Sweep a set of Eb/N0 points, running `framesPerPoint` frames at each. */
export function concatWaterfall(
  code: RSCode,
  ebn0List: number[],
  I: number,
  framesPerPoint: number,
  seed: number,
): ConcatPoint[] {
  const tr = buildTrellis(INNER_CODE)
  const out: ConcatPoint[] = []
  for (let pi = 0; pi < ebn0List.length; pi++) {
    const db = ebn0List[pi]
    let innerBadBytes = 0
    let totalBytes = 0
    let frameErrors = 0
    let residualBytes = 0
    for (let fr = 0; fr < framesPerPoint; fr++) {
      const frame = runConcatFrame(code, db, I, true, seed + pi * 1013 + fr * 7919, tr)
      innerBadBytes += frame.innerByteErrorCount
      totalBytes += I * code.n
      if (!frame.frameRecovered) frameErrors++
      residualBytes += frame.residualByteErrors
    }
    out.push({
      ebn0Db: db,
      uncoded: qfunc(Math.sqrt(2 * Math.pow(10, db / 10))),
      innerByteError: innerBadBytes / totalBytes,
      concatFrameError: frameErrors / framesPerPoint,
      concatByteError: residualBytes / totalBytes,
      frames: framesPerPoint,
    })
  }
  return out
}
