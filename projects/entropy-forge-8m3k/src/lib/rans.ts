// rans.ts — a from-scratch static **range Asymmetric Numeral System** (rANS).
//
// ANS (Duda, 2009) is the entropy backend that displaced arithmetic coding in
// modern compressors — it is what makes Zstandard, LZ4-HC and Apple's LZFSE fast.
// The trick: encode the whole message into a single large integer `x` (the
// "state"), where each symbol both *scales* the state up by ~1/p(sym) and folds
// its own identity into the low bits. Decoding peels symbols off the state in the
// exact reverse order — so, famously, **rANS encodes back-to-front and decodes
// front-to-back**. The arithmetic is all integer and, unlike a bit-at-a-time
// range coder, it renormalises a whole byte at a time, which is why it is quick.
//
// This is static (two-pass) rANS: we count symbol frequencies, quantise them to a
// power-of-two total M, transmit that table, then code the stream. It reaches the
// order-0 entropy of the *quantised* model (a controllable fraction of a bit off
// the true entropy, set by the table precision). It slots in beside the WNC
// arithmetic coder as a second, independent proof that the entropy floor is real.

// ---- model precision ----
// The frequency table is normalised so Σ freq = M = 2^SCALE_BITS. Larger M ⇒ the
// quantised probabilities hug the true ones more tightly (less overhead) at the
// cost of a bigger table. 12 bits (M = 4096) is the sweet spot real coders use.
export const RANS_SCALE_BITS = 12
export const RANS_M = 1 << RANS_SCALE_BITS

// State is kept in [L, L*256) with L = 2^23; renormalisation emits/consumes whole
// bytes to hold the state inside that window. 2^23 keeps 32-bit-safe headroom
// (state < 2^31) while leaving ≥ 11 bits above the 12-bit model, which bounds the
// coding loss to a negligible fraction of a bit per symbol.
const RANS_L = 1 << 23

export interface RansTable {
  freq: number[] // quantised frequency per symbol (Σ = M), 0 for unused
  cum: number[] // cum[s] = Σ_{i<s} freq[i]; length alphabet+1
  alphabet: number
  symbols: number[] // symbols actually present, in ascending order
  /** slot → symbol lookup for the whole [0,M) ring (decode fast-path). */
  slot2sym: Uint16Array
}

/**
 * Quantise raw counts to sum exactly to M, never zeroing a symbol that occurred.
 * We scale proportionally, floor, guarantee every used symbol keeps ≥ 1, then
 * fix the rounding residual by adjusting the richest symbol. This mirrors the
 * normalisation step in FSE/zstd and is what the decoder rebuilds from the table.
 */
export function normaliseFreqs(counts: number[], alphabet = 256): RansTable {
  const used: number[] = []
  let totalRaw = 0
  for (let s = 0; s < alphabet; s++) {
    if (counts[s] > 0) {
      used.push(s)
      totalRaw += counts[s]
    }
  }
  const freq = new Array<number>(alphabet).fill(0)

  if (used.length === 0) {
    // Empty input: leave a degenerate but valid table (nothing will be coded).
    const cum = new Array<number>(alphabet + 1).fill(0)
    return { freq, cum, alphabet, symbols: [], slot2sym: new Uint16Array(RANS_M) }
  }
  if (used.length === 1) {
    // A single symbol takes the whole ring; the coder still works (it just never
    // narrows the alphabet). freq = M for that symbol.
    freq[used[0]] = RANS_M
  } else {
    let allotted = 0
    for (const s of used) {
      let f = Math.floor((counts[s] / totalRaw) * RANS_M)
      if (f < 1) f = 1
      freq[s] = f
      allotted += f
    }
    // Reconcile Σ freq to exactly M by nudging symbols, largest-first, so we never
    // drive one below 1. Positive residual ⇒ hand extra slots to the biggest;
    // negative ⇒ reclaim from the biggest that can spare them.
    let residual = RANS_M - allotted
    const byFreqDesc = [...used].sort((a, b) => freq[b] - freq[a])
    let i = 0
    while (residual !== 0) {
      const s = byFreqDesc[i % byFreqDesc.length]
      if (residual > 0) {
        freq[s]++
        residual--
      } else if (freq[s] > 1) {
        freq[s]--
        residual++
      }
      i++
    }
  }

  const cum = new Array<number>(alphabet + 1).fill(0)
  let acc = 0
  const slot2sym = new Uint16Array(RANS_M)
  for (let s = 0; s < alphabet; s++) {
    cum[s] = acc
    if (freq[s] > 0) {
      slot2sym.fill(s, acc, acc + freq[s])
      acc += freq[s]
    }
  }
  cum[alphabet] = acc
  return { freq, cum, alphabet, symbols: used, slot2sym }
}

/** Build a table straight from a byte buffer (counting pass). */
export function tableFromData(data: Uint8Array, alphabet = 256): RansTable {
  const counts = new Array<number>(alphabet).fill(0)
  for (const b of data) counts[b]++
  return normaliseFreqs(counts, alphabet)
}

export interface RansResult {
  encoded: Uint8Array // the rANS byte stream (state-normalisation output)
  table: RansTable
  finalState: number
  bytesOut: number
}

/**
 * Encode `data` with the given (or derived) table. rANS is LIFO: we walk the
 * input **in reverse**, and the decoder walks the stream forward. The output
 * bytes are the little-endian renormalisation spill plus the 4-byte final state.
 */
export function ransEncode(data: Uint8Array, table?: RansTable): RansResult {
  const tbl = table ?? tableFromData(data)
  const { freq, cum } = tbl
  const out: number[] = [] // renormalisation bytes, in emit order (reversed later)
  let x = RANS_L

  // Encode symbols back-to-front.
  for (let i = data.length - 1; i >= 0; i--) {
    const s = data[i]
    const f = freq[s]
    // Renormalise: while x would overflow the symbol's slice, spill a byte.
    // x_max for this symbol = ((RANS_L >> SCALE_BITS) << 8) * f.
    const xMax = ((RANS_L >>> RANS_SCALE_BITS) << 8) * f
    while (x >= xMax) {
      out.push(x & 0xff)
      x = Math.floor(x / 256)
    }
    // The forward ANS step: x' = (x/f)*M + (x mod f) + cum[s].
    x = Math.floor(x / f) * RANS_M + (x % f) + cum[s]
  }

  // Flush the 4-byte state (little end first) so decode can seed x.
  const stream = new Uint8Array(out.length + 4)
  // out was built in encode order (last-emitted at the end); the decoder must
  // read them in the *reverse* order it will consume symbols, i.e. we lay the
  // final state first, then the spill bytes newest-first.
  stream[0] = x & 0xff
  stream[1] = (x >>> 8) & 0xff
  stream[2] = (x >>> 16) & 0xff
  stream[3] = (x >>> 24) & 0xff
  for (let i = 0; i < out.length; i++) stream[4 + i] = out[out.length - 1 - i]

  return { encoded: stream, table: tbl, finalState: x, bytesOut: stream.length }
}

/** Inverse of ransEncode. Rebuilds the exact `length` symbols, front-to-back. */
export function ransDecode(encoded: Uint8Array, length: number, table: RansTable): Uint8Array {
  const { freq, cum, slot2sym } = table
  const out = new Uint8Array(length)
  // Seed the state from the 4-byte header.
  let x = (encoded[0] | (encoded[1] << 8) | (encoded[2] << 16) | (encoded[3] << 24)) >>> 0
  let pos = 4

  for (let i = 0; i < length; i++) {
    const slot = x & (RANS_M - 1) // x mod M
    const s = slot2sym[slot]
    out[i] = s
    // Reverse ANS step: x = f*(x >> SCALE) + slot - cum[s].
    x = freq[s] * (x >>> RANS_SCALE_BITS) + slot - cum[s]
    // Renormalise by pulling bytes back in until x re-enters [L, L*256).
    while (x < RANS_L && pos < encoded.length) {
      x = (x * 256 + encoded[pos++]) >>> 0
    }
  }
  return out
}

// ---- table (de)serialisation for the self-contained Codec ----
// We transmit only the non-zero (symbol, freq) pairs. freq ∈ [1, M] needs up to
// 13 bits; we store it as two bytes. Compact enough for the lab, and the decoder
// rebuilds cum + slot2sym from it deterministically.
export function serialiseTable(table: RansTable): number[] {
  const bytes: number[] = []
  bytes.push(table.symbols.length & 0xff, (table.symbols.length >>> 8) & 0xff)
  for (const s of table.symbols) {
    const f = table.freq[s]
    bytes.push(s & 0xff, f & 0xff, (f >>> 8) & 0xff)
  }
  return bytes
}

export function deserialiseTable(data: Uint8Array, off: number, alphabet = 256): { table: RansTable; next: number } {
  const n = data[off] | (data[off + 1] << 8)
  let p = off + 2
  const freq = new Array<number>(alphabet).fill(0)
  const symbols: number[] = []
  for (let i = 0; i < n; i++) {
    const s = data[p]
    const f = data[p + 1] | (data[p + 2] << 8)
    freq[s] = f
    symbols.push(s)
    p += 3
  }
  symbols.sort((a, b) => a - b)
  const cum = new Array<number>(alphabet + 1).fill(0)
  let acc = 0
  const slot2sym = new Uint16Array(RANS_M)
  for (let s = 0; s < alphabet; s++) {
    cum[s] = acc
    if (freq[s] > 0) {
      slot2sym.fill(s, acc, acc + freq[s])
      acc += freq[s]
    }
  }
  cum[alphabet] = acc
  return { table: { freq, cum, alphabet, symbols, slot2sym }, next: p }
}

/** Ideal bits/symbol under the *quantised* table — the floor rANS actually hits. */
export function quantisedEntropy(table: RansTable, counts: number[]): number {
  let total = 0
  for (const s of table.symbols) total += counts[s]
  if (total === 0) return 0
  let bits = 0
  const LOG2 = Math.log(2)
  for (const s of table.symbols) {
    const p = table.freq[s] / RANS_M // model probability
    bits += counts[s] * (-Math.log(p) / LOG2)
  }
  return bits / total
}
