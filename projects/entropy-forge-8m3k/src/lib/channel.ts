// channel.ts — the noisy channels and their Shannon capacities.
//
// A channel takes symbols in and, with some probability, changes or loses them.
// Shannon's noisy-channel coding theorem says every channel has a CAPACITY C
// (bits per channel use): any code of rate R < C can be decoded with error
// probability → 0 as the block length grows, and no code of rate R > C can. The
// codes in this pillar are concrete constructions living under that ceiling.
//
// Three channels are modelled:
//   • BSC (Binary Symmetric Channel): a transmitted bit is flipped with prob p.
//       Capacity C = 1 − H(p), where H is the binary entropy function.
//   • BEC (Binary Erasure Channel): a bit is erased (received as "?") with prob ε,
//       otherwise received correctly. Capacity C = 1 − ε.
//   • BI-AWGN (binary-input additive white Gaussian noise): a bit is mapped to a
//       BPSK symbol ±1 and Gaussian noise of variance σ² is added. This is the
//       channel soft-decision Viterbi and LDPC belief-propagation actually use;
//       it produces a real-valued sample per bit and a log-likelihood ratio.
//
// All randomness flows through a small seeded PRNG so every run in the UI and in
// the self-tests is exactly reproducible.

/** A deterministic xorshift128 PRNG — reproducible, decent quality, tiny. */
export class RNG {
  private a: number
  private b: number
  private c: number
  private d: number
  constructor(seed = 0x9e3779b9) {
    // Seed the four words from a splitmix-style expansion of the seed.
    let s = seed >>> 0
    const next = () => {
      s = (s + 0x6d2b79f5) >>> 0
      let t = s
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0)
    }
    this.a = next()
    this.b = next()
    this.c = next()
    this.d = next() || 1
  }
  /** Next uint32. */
  u32(): number {
    const t = this.b << 9
    let r = Math.imul(this.a, 5)
    r = ((r << 7) | (r >>> 25)) >>> 0
    r = Math.imul(r, 9) >>> 0
    this.c ^= this.a
    this.d ^= this.b
    this.b ^= this.c
    this.a ^= this.d
    this.c ^= t
    this.d = ((this.d << 11) | (this.d >>> 21)) >>> 0
    return r >>> 0
  }
  /** Uniform float in [0,1). */
  float(): number {
    return this.u32() / 4294967296
  }
  /** Standard normal via Box–Muller (one of the pair; adequate for a sim). */
  normal(): number {
    let u = 0
    let v = 0
    while (u === 0) u = this.float()
    while (v === 0) v = this.float()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
}

/** Binary entropy function H(p) = −p·log₂p − (1−p)·log₂(1−p), in bits. */
export function binaryEntropy(p: number): number {
  if (p <= 0 || p >= 1) return 0
  return -p * Math.log2(p) - (1 - p) * Math.log2(1 - p)
}

/** Capacity of the Binary Symmetric Channel with crossover probability p. */
export function bscCapacity(p: number): number {
  return 1 - binaryEntropy(p)
}

/** Capacity of the Binary Erasure Channel with erasure probability ε. */
export function becCapacity(eps: number): number {
  return 1 - eps
}

/**
 * Capacity of the binary-input AWGN channel at a given Es/N0 (linear), computed
 * by numerical integration of the mutual information for BPSK. Returned in bits
 * per channel use. Used to place the LDPC/convolutional operating point against
 * the ceiling.
 */
export function biawgnCapacity(esN0: number): number {
  // C = 1 − E[ log2(1 + e^{−2y/σ²}) ] with y ~ N(+1, σ²), σ² = 1/(2·Es/N0).
  const sigma2 = 1 / (2 * esN0)
  const sigma = Math.sqrt(sigma2)
  const N = 200
  let acc = 0
  // Integrate over ±6σ around the mean +1.
  const lo = 1 - 6 * sigma
  const hi = 1 + 6 * sigma
  const dz = (hi - lo) / N
  for (let i = 0; i <= N; i++) {
    const y = lo + i * dz
    const g = Math.exp(-((y - 1) * (y - 1)) / (2 * sigma2)) / (sigma * Math.sqrt(2 * Math.PI))
    const term = Math.log2(1 + Math.exp((-2 * y) / sigma2))
    const w = i === 0 || i === N ? 0.5 : 1
    acc += w * g * term * dz
  }
  return Math.max(0, 1 - acc)
}

export type ChannelKind = 'bsc' | 'bec' | 'awgn'

/** A received bit from a BEC: 0, 1, or the erasure symbol. */
export const ERASURE = -1

/**
 * Send bits through a Binary Symmetric Channel. Returns the received bits and the
 * indices that were flipped (for visualisation).
 */
export function bsc(bits: number[], p: number, rng: RNG): { out: number[]; flipped: number[] } {
  const out = bits.slice()
  const flipped: number[] = []
  for (let i = 0; i < bits.length; i++) {
    if (rng.float() < p) {
      out[i] ^= 1
      flipped.push(i)
    }
  }
  return { out, flipped }
}

/**
 * Send bits through a Binary Erasure Channel. Erased positions become ERASURE.
 */
export function bec(bits: number[], eps: number, rng: RNG): { out: number[]; erased: number[] } {
  const out = bits.slice()
  const erased: number[] = []
  for (let i = 0; i < bits.length; i++) {
    if (rng.float() < eps) {
      out[i] = ERASURE
      erased.push(i)
    }
  }
  return { out, erased }
}

/**
 * Send bits through a BI-AWGN channel. Each bit b maps to BPSK x = 1−2b (0→+1,
 * 1→−1); the receiver sees y = x + n, n ~ N(0, σ²). Returns the real samples,
 * the log-likelihood ratios L = 2y/σ² (positive ⇒ bit 0 more likely), and the
 * hard-decision bits (sign of y).
 */
export function awgn(
  bits: number[],
  esN0: number,
  rng: RNG,
): { samples: number[]; llr: number[]; hard: number[]; flipped: number[] } {
  const sigma2 = 1 / (2 * esN0)
  const sigma = Math.sqrt(sigma2)
  const samples: number[] = []
  const llr: number[] = []
  const hard: number[] = []
  const flipped: number[] = []
  for (let i = 0; i < bits.length; i++) {
    const x = 1 - 2 * bits[i]
    const y = x + sigma * rng.normal()
    samples.push(y)
    llr.push((2 * y) / sigma2)
    const h = y < 0 ? 1 : 0
    hard.push(h)
    if (h !== bits[i]) flipped.push(i)
  }
  return { samples, llr, hard, flipped }
}

/** Convert an Eb/N0 in dB to a linear Es/N0 given a code rate R (Es = R·Eb). */
export function ebN0dBtoEsN0(ebN0dB: number, rate: number): number {
  const ebN0 = Math.pow(10, ebN0dB / 10)
  return rate * ebN0
}

/** Bytes → bit array (MSB first within each byte). */
export function bytesToBits(bytes: Uint8Array): number[] {
  const bits: number[] = []
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >>> i) & 1)
  return bits
}

/** Bit array (MSB first) → bytes. Pads the final partial byte with zeros. */
export function bitsToBytes(bits: number[]): Uint8Array {
  const out = new Uint8Array(Math.ceil(bits.length / 8))
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] & 1) out[i >> 3] |= 1 << (7 - (i & 7))
  }
  return out
}

/** Count differing positions between two equal-length bit arrays. */
export function bitErrors(a: number[], b: number[]): number {
  let n = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) if ((a[i] & 1) !== (b[i] & 1)) n++
  return n + Math.abs(a.length - b.length)
}
