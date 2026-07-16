// intcodes.ts — codes for the integers.
//
// Everything else in this lab codes a *symbol from a known alphabet*. This file
// codes the integers themselves — the substrate that appears the moment a codec
// has to emit a number whose range it can't bound in advance: a match length, a
// run of zeros, a linear-prediction residual. There are two families here.
//
//   • UNIVERSAL codes (Elias γ/δ/ω, Fibonacci) assume nothing about the
//     distribution beyond "smaller is more likely", and pay a length that grows
//     like log n (Elias) — asymptotically within a constant factor of optimal for
//     ANY distribution whose entropy is finite. They need no parameter and no
//     table, so the decoder is self-synchronising.
//
//   • PARAMETRIC codes (Golomb, Rice, exp-Golomb) are OPTIMAL prefix codes for a
//     specific shape — the two-sided/one-sided GEOMETRIC distribution — once you
//     tell them its decay via one integer parameter. Golomb(m) is the exact
//     optimal code for P(n) = (1−θ)θⁿ with m = ⌈−1/log₂θ⌉; Rice(k)=Golomb(2^k) is
//     the multiply-free special case (a shift, not a divide) used inside FLAC,
//     Apple Lossless, JPEG-LS, Shorten and the H.26x/H.264 CAVLC layer.
//
// All codes here are MSB-first over the shared BitWriter/BitReader, all round-trip
// exactly, and all are individually exercised on the Self-test page. Signed values
// go through `zigzag` first (0,−1,+1,−2,+2 → 0,1,2,3,4) so the sign costs nothing
// for values near zero — the mapping FLAC's residual coder relies on.

import { BitWriter, BitReader } from './bits.ts'

// ---------------------------------------------------------------------------
// Signed ⇄ unsigned folding (zig-zag). Maps small-magnitude signed ints to
// small unsigned ones so a code tuned for "small = likely" spends few bits on
// them regardless of sign.
// ---------------------------------------------------------------------------

/** Fold a signed integer to a non-negative one: 0,−1,1,−2,2 → 0,1,2,3,4. */
export function zigzag(v: number): number {
  return v >= 0 ? 2 * v : -2 * v - 1
}

/** Inverse of {@link zigzag}. */
export function unzigzag(u: number): number {
  return u & 1 ? -((u + 1) >>> 1) : u >>> 1
}

// ---------------------------------------------------------------------------
// Unary. n → n zero bits then a terminating 1. The atom every other code here
// is built from; optimal only for the geometric law P(n)=2^-(n+1).
// ---------------------------------------------------------------------------

export function writeUnary(bw: BitWriter, n: number): void {
  for (let i = 0; i < n; i++) bw.writeBit(0)
  bw.writeBit(1)
}

export function readUnary(br: BitReader): number {
  let n = 0
  while (br.readBit() === 0) n++
  return n
}

// ---------------------------------------------------------------------------
// Truncated binary — the tight code for a UNIFORM value in [0, m). Uses
// ⌊log₂m⌋ bits for the first (2^b − m) values and one more bit for the rest, so
// it never wastes the fractional bit a plain ⌈log₂m⌉-bit field would. Golomb's
// remainder rides on it.
// ---------------------------------------------------------------------------

function writeTruncatedBinary(bw: BitWriter, r: number, m: number): void {
  if (m <= 1) return // only value is 0 → nothing to send
  const b = 31 - Math.clz32(m) // ⌊log₂ m⌋
  const cutoff = (1 << (b + 1)) - m // how many short codewords
  if (r < cutoff) {
    bw.writeBits(r, b)
  } else {
    bw.writeBits(r + cutoff, b + 1)
  }
}

function readTruncatedBinary(br: BitReader, m: number): number {
  if (m <= 1) return 0
  const b = 31 - Math.clz32(m)
  const cutoff = (1 << (b + 1)) - m
  let x = br.readBits(b)
  if (x < cutoff) return x
  x = (x << 1) | br.readBit()
  return x - cutoff
}

// ---------------------------------------------------------------------------
// Golomb(m) and Rice(k). Optimal for a one-sided geometric source.
//   quotient  q = ⌊n/m⌋  in unary
//   remainder r = n mod m in truncated binary  (Golomb)  /  k plain bits (Rice)
// ---------------------------------------------------------------------------

export function writeGolomb(bw: BitWriter, n: number, m: number): void {
  const q = Math.floor(n / m)
  const r = n - q * m
  writeUnary(bw, q)
  writeTruncatedBinary(bw, r, m)
}

export function readGolomb(br: BitReader, m: number): number {
  const q = readUnary(br)
  const r = readTruncatedBinary(br, m)
  return q * m + r
}

// Rice is just Golomb(2^k) but hot enough (FLAC calls it per residual) to
// inline without the divide — a shift for the quotient, a mask for the low bits.
export function riceEncode(bw: BitWriter, n: number, k: number): void {
  const q = n >>> k
  for (let i = 0; i < q; i++) bw.writeBit(0)
  bw.writeBit(1)
  if (k > 0) bw.writeBits(n & ((1 << k) - 1), k)
}

export function riceDecode(br: BitReader, k: number): number {
  let q = 0
  while (br.readBit() === 0) q++
  const r = k > 0 ? br.readBits(k) : 0
  return (q << k) | r
}

/** Exact bit length of Rice(k) for a non-negative n (no I/O). */
export function riceLength(n: number, k: number): number {
  return (n >>> k) + 1 + k
}

// ---------------------------------------------------------------------------
// Elias γ / δ / ω — parameter-free universal codes for n ≥ 1.
// γ(n): ⌊log₂n⌋ zeros, then n in binary (leading 1 included). len = 2⌊log₂n⌋+1.
// δ(n): γ-code the bit-length, then the remaining low bits. Beats γ for large n.
// ω(n): recursively γ-less — prepend group lengths until the length is 2 or 3.
// We shift the domain by +1 so they also code n ≥ 0.
// ---------------------------------------------------------------------------

export function eliasGammaEncode(bw: BitWriter, n0: number): void {
  const n = n0 + 1 // domain shift: code 0 as γ(1)
  const b = 31 - Math.clz32(n) // ⌊log₂ n⌋
  for (let i = 0; i < b; i++) bw.writeBit(0)
  bw.writeBits(n, b + 1) // n has b+1 bits, MSB is the 1 that ends the unary
}

export function eliasGammaDecode(br: BitReader): number {
  let b = 0
  while (br.readBit() === 0) b++
  // We've consumed the leading 1 of the value; read the remaining b bits.
  let n = 1
  for (let i = 0; i < b; i++) n = (n << 1) | br.readBit()
  return n - 1
}

export function eliasDeltaEncode(bw: BitWriter, n0: number): void {
  const n = n0 + 1
  const b = 31 - Math.clz32(n) // ⌊log₂ n⌋, so n has b+1 bits
  eliasGammaEncode(bw, b) // γ-code the length index (b ≥ 0 → γ of b)
  if (b > 0) bw.writeBits(n & ((1 << b) - 1), b) // the low b bits (drop leading 1)
}

export function eliasDeltaDecode(br: BitReader): number {
  const b = eliasGammaDecode(br) // number of trailing bits
  let n = 1
  for (let i = 0; i < b; i++) n = (n << 1) | br.readBit()
  return n - 1
}

export function eliasOmegaEncode(bw: BitWriter, n0: number): void {
  let n = n0 + 1
  const groups: { v: number; len: number }[] = []
  while (n > 1) {
    const len = 32 - Math.clz32(n) // bit length of n
    groups.push({ v: n, len })
    n = len - 1 // ⌊log₂ n⌋
  }
  // Emit groups outermost-first (the last one computed is written first).
  for (let i = groups.length - 1; i >= 0; i--) {
    bw.writeBits(groups[i].v, groups[i].len)
  }
  bw.writeBit(0) // terminator
}

export function eliasOmegaDecode(br: BitReader): number {
  let n = 1
  for (;;) {
    const first = br.readBit()
    if (first === 0) return n - 1
    // Read (n) more bits after the leading 1 to form the next group value.
    let v = 1
    for (let i = 0; i < n; i++) v = (v << 1) | br.readBit()
    n = v
  }
}

// ---------------------------------------------------------------------------
// Exp-Golomb order k — the H.264/H.265 integer code. Order 0 is the "ue(v)" of
// the video standards; higher orders bias toward larger magnitudes. Effectively
// Elias-γ with k extra flat low bits.
// ---------------------------------------------------------------------------

export function expGolombEncode(bw: BitWriter, n: number, k = 0): void {
  const v = n + (1 << k) // maps n≥0 into the γ domain, biased by 2^k
  const b = 31 - Math.clz32(v) // ⌊log₂ v⌋
  for (let i = 0; i < b - k; i++) bw.writeBit(0)
  bw.writeBits(v, b + 1)
}

export function expGolombDecode(br: BitReader, k = 0): number {
  let lead = 0
  while (br.readBit() === 0) lead++
  const b = lead + k
  let v = 1
  for (let i = 0; i < b; i++) v = (v << 1) | br.readBit()
  return v - (1 << k)
}

// ---------------------------------------------------------------------------
// Fibonacci coding — a universal code with a robustness the Elias codes lack:
// every codeword ends in "11" and that pattern appears nowhere inside, so a
// single corrupted bit can only damage a bounded neighbourhood. Uses the
// Zeckendorf theorem: every n ≥ 1 is a unique sum of NON-consecutive Fibonacci
// numbers. Domain shifted by +1 to admit n ≥ 0.
// ---------------------------------------------------------------------------

// F = 1, 2, 3, 5, 8, ... (the Zeckendorf basis; note it starts 1,2 not 1,1).
const FIBS: number[] = (() => {
  const f = [1, 2]
  while (f[f.length - 1] + f[f.length - 2] < 0x40000000) {
    f.push(f[f.length - 1] + f[f.length - 2])
  }
  return f
})()

export function fibonacciEncode(bw: BitWriter, n0: number): void {
  let n = n0 + 1
  // Largest index with FIBS[idx] ≤ n.
  let hi = 0
  while (hi + 1 < FIBS.length && FIBS[hi + 1] <= n) hi++
  const bits = new Uint8Array(hi + 1)
  for (let i = hi; i >= 0; i--) {
    if (FIBS[i] <= n) {
      bits[i] = 1
      n -= FIBS[i]
    }
  }
  for (let i = 0; i <= hi; i++) bw.writeBit(bits[i]) // low-order Fibonacci first
  bw.writeBit(1) // terminating 1 → the "11" that ends every codeword
}

export function fibonacciDecode(br: BitReader): number {
  let sum = 0
  let idx = 0
  let prev = 0
  for (;;) {
    const bit = br.readBit()
    if (bit === 1 && prev === 1) break // the "11" terminator
    if (bit === 1) sum += FIBS[idx]
    prev = bit
    idx++
  }
  return sum - 1
}

// ---------------------------------------------------------------------------
// Optimal-parameter estimators. These are what turn a parametric code from a
// guess into the actual entropy-hugging optimum for a geometric source.
// ---------------------------------------------------------------------------

/**
 * The Rice parameter k that minimises expected length for a source of
 * non-negative integers with the given mean. The classic estimate is
 * k ≈ max(0, ⌈log₂(mean·ln2)⌉); we instead pick k directly by the exact
 * minimal-total-length search when a histogram is available (see
 * {@link bestRiceK}). This mean-based form is the O(1) fallback.
 */
export function riceKFromMean(mean: number): number {
  if (mean <= 0) return 0
  let k = 0
  // Golomb's rule: increase k while 2^k < mean·ln2 (≈ the geometric optimum).
  while ((1 << (k + 1)) <= mean * Math.LN2 * 2 + 1) k++
  return k
}

/** Exhaustive best Rice k for an explicit set of non-negative values. */
export function bestRiceK(values: ArrayLike<number>, kMax = 30): { k: number; bits: number } {
  let bestK = 0
  let bestBits = Infinity
  for (let k = 0; k <= kMax; k++) {
    let bits = 0
    for (let i = 0; i < values.length; i++) bits += (values[i] >>> k) + 1 + k
    if (bits < bestBits) {
      bestBits = bits
      bestK = k
    } else if (bits > bestBits * 2) {
      break // total is convex in k; once it climbs hard we're past the min
    }
  }
  return { k: bestK, bits: bestBits }
}

/**
 * The Golomb parameter m that is optimal for a geometric source with the given
 * mean: m = ⌈−1 / log₂ θ⌉ where θ = mean/(mean+1). Returns m ≥ 1.
 */
export function golombMFromMean(mean: number): number {
  if (mean <= 0) return 1
  const theta = mean / (mean + 1)
  const m = Math.ceil(-1 / Math.log2(theta))
  return Math.max(1, m)
}

// ---------------------------------------------------------------------------
// A tiny reflective registry so the Rice/Elias lab page can render every code's
// bit string for a value without hard-coding each one. Each entry encodes ONE
// value to a fresh writer and returns its '0'/'1' string plus the round-trip.
// ---------------------------------------------------------------------------

export interface IntCode {
  id: string
  name: string
  blurb: string
  /** Some codes take a parameter (Rice k, Golomb m, exp-Golomb order). */
  param?: { label: string; default: number }
  encode(bw: BitWriter, n: number, p: number): void
  decode(br: BitReader, p: number): number
}

export const INT_CODES: IntCode[] = [
  {
    id: 'unary',
    name: 'Unary',
    blurb: 'n zeros then a 1. Optimal only for P(n)=2^-(n+1); the atom all the others build on.',
    encode: (bw, n) => writeUnary(bw, n),
    decode: (br) => readUnary(br),
  },
  {
    id: 'gamma',
    name: 'Elias γ',
    blurb: 'Universal: ⌊log₂n⌋ zeros then n in binary. Length ≈ 2 log₂n; no parameter.',
    encode: (bw, n) => eliasGammaEncode(bw, n),
    decode: (br) => eliasGammaDecode(br),
  },
  {
    id: 'delta',
    name: 'Elias δ',
    blurb: 'Universal: γ-code the length, then the low bits. Shorter than γ for large n.',
    encode: (bw, n) => eliasDeltaEncode(bw, n),
    decode: (br) => eliasDeltaDecode(br),
  },
  {
    id: 'omega',
    name: 'Elias ω',
    blurb: 'Universal, recursively self-describing lengths — the asymptotically shortest of the three.',
    encode: (bw, n) => eliasOmegaEncode(bw, n),
    decode: (br) => eliasOmegaDecode(br),
  },
  {
    id: 'fib',
    name: 'Fibonacci',
    blurb: 'Universal Zeckendorf code ending in "11" — resynchronises after a bit error.',
    encode: (bw, n) => fibonacciEncode(bw, n),
    decode: (br) => fibonacciDecode(br),
  },
  {
    id: 'rice',
    name: 'Rice(k)',
    blurb: 'Golomb(2^k): quotient in unary, k low bits. Multiply-free; the code inside FLAC/ALAC/JPEG-LS.',
    param: { label: 'k', default: 3 },
    encode: (bw, n, p) => riceEncode(bw, n, p),
    decode: (br, p) => riceDecode(br, p),
  },
  {
    id: 'golomb',
    name: 'Golomb(m)',
    blurb: 'Exact optimum for a geometric source: unary quotient + truncated-binary remainder, any m.',
    param: { label: 'm', default: 5 },
    encode: (bw, n, p) => writeGolomb(bw, n, Math.max(1, p)),
    decode: (br, p) => readGolomb(br, Math.max(1, p)),
  },
  {
    id: 'expgolomb',
    name: 'Exp-Golomb',
    blurb: 'The H.264/H.265 integer code (ue(v) at order 0): γ with k flat low bits.',
    param: { label: 'order', default: 0 },
    encode: (bw, n, p) => expGolombEncode(bw, n, p),
    decode: (br, p) => expGolombDecode(br, p),
  },
]

/** Encode one value with a code and return its bit string (for the viz). */
export function codeword(code: IntCode, n: number, p = 0): string {
  const bw = new BitWriter()
  code.encode(bw, n, p)
  return bw.toBitString()
}

/** Exact codeword length in bits for a value (encodes to a scratch writer). */
export function codeLength(code: IntCode, n: number, p = 0): number {
  const bw = new BitWriter()
  code.encode(bw, n, p)
  return bw.bitLength
}
