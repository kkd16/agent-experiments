// A strong, from-scratch 64-bit hash for the sketch engine.
//
// Every probabilistic sketch here (HyperLogLog, Count–Min, Bloom, Space-Saving)
// leans on one assumption: the hash spreads inputs like an independent uniform
// draw. If the hash clusters, the *bounds do not hold* — an HLL register never
// sees a long zero-run, a Bloom filter's false-positive rate blows past its
// prediction. So the primitive matters, and we build it rather than borrow it.
//
// The core is MurmurHash3's 32-bit finalizer/mix (Appleby, public domain), which
// has excellent avalanche (a one-bit input change flips ≈half the output bits).
// We hash the engine's own canonical value encoding (`hashKey([v])`), so two
// SQL values that are equal — an integer and the same-valued DECIMAL, a
// normalized JSON — hash identically, exactly as they compare and group.
//
// `hash64` returns TWO independent 32-bit lanes (a Murmur pass under two
// different seeds). That is a genuine ~64-bit hash for HyperLogLog, and it is
// also what the double-hashing schemes want: Count–Min row i and Bloom probe i
// use `h1 + i·h2` (Kirsch–Mitzenmacher), which is provably as good as i
// independent hashes for these structures — from just two.

import { hashKey } from '../types'
import type { SqlValue } from '../types'

/** MurmurHash3 x86_32 over a UTF-16-ish byte view of `str`, seeded. Public-domain algorithm. */
export function murmur32(str: string, seed: number): number {
  let h = seed >>> 0
  const len = str.length
  const nblocks = len & ~3 // process 4 chars (bytes) at a time
  let i = 0
  for (; i < nblocks; i += 4) {
    let k =
      (str.charCodeAt(i) & 0xff) |
      ((str.charCodeAt(i + 1) & 0xff) << 8) |
      ((str.charCodeAt(i + 2) & 0xff) << 16) |
      ((str.charCodeAt(i + 3) & 0xff) << 24)
    k = Math.imul(k, 0xcc9e2d51)
    k = (k << 15) | (k >>> 17)
    k = Math.imul(k, 0x1b873593)
    h ^= k
    h = (h << 13) | (h >>> 19)
    h = (Math.imul(h, 5) + 0xe6546b64) | 0
  }
  // Tail (the trailing 1–3 chars).
  let k1 = 0
  const rem = len & 3
  if (rem === 3) k1 ^= (str.charCodeAt(i + 2) & 0xff) << 16
  if (rem >= 2) k1 ^= (str.charCodeAt(i + 1) & 0xff) << 8
  if (rem >= 1) {
    k1 ^= str.charCodeAt(i) & 0xff
    k1 = Math.imul(k1, 0xcc9e2d51)
    k1 = (k1 << 15) | (k1 >>> 17)
    k1 = Math.imul(k1, 0x1b873593)
    h ^= k1
  }
  // Finalization mix — force all bits to avalanche.
  h ^= len
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** Mix an already-integer key straight through the Murmur finalizer (no string). */
export function mix32(x: number, seed: number): number {
  let h = (x ^ seed) >>> 0
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

const SEED_HI = 0x9e3779b1 // golden-ratio derived, arbitrary but fixed
const SEED_LO = 0x85ebca77

/** Two independent 32-bit lanes of a value — a ~64-bit hash. */
export interface Hash64 {
  hi: number
  lo: number
}

/** Hash any SQL value (via its canonical encoding) into two independent lanes. */
export function hashValue64(v: SqlValue, seed = 0): Hash64 {
  const key = hashKey([v])
  return {
    hi: murmur32(key, (SEED_HI ^ seed) >>> 0),
    lo: murmur32(key, (SEED_LO ^ seed) >>> 0),
  }
}

/** Hash a raw string into two independent lanes. */
export function hashString64(key: string, seed = 0): Hash64 {
  return {
    hi: murmur32(key, (SEED_HI ^ seed) >>> 0),
    lo: murmur32(key, (SEED_LO ^ seed) >>> 0),
  }
}

/** Count trailing zeros of a 32-bit word (0 → 32). */
export function ctz32(x: number): number {
  if ((x & 0xffffffff) === 0) return 32
  let n = 0
  x = x >>> 0
  if ((x & 0x0000ffff) === 0) {
    n += 16
    x >>>= 16
  }
  if ((x & 0x000000ff) === 0) {
    n += 8
    x >>>= 8
  }
  if ((x & 0x0000000f) === 0) {
    n += 4
    x >>>= 4
  }
  if ((x & 0x00000003) === 0) {
    n += 2
    x >>>= 2
  }
  if ((x & 0x00000001) === 0) n += 1
  return n
}

/** Population count of a 32-bit word. */
export function popcount32(x: number): number {
  x = x >>> 0
  x = x - ((x >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  x = (x + (x >>> 4)) & 0x0f0f0f0f
  return (Math.imul(x, 0x01010101) >>> 24) & 0xff
}

/**
 * ρ for HyperLogLog: after the low `p` bits of the 64-bit hash select a
 * register, ρ is the 1-indexed position of the first set bit among the
 * remaining `64 − p` bits (Redis/Google-style "first one" convention). The
 * register keeps the max ρ it has seen; a rare all-zero remainder returns the
 * saturated `64 − p + 1`.
 */
export function rho64(h: Hash64, p: number): number {
  // Remaining low bits of `lo` above the p index bits: 32 − p of them.
  const restLo = h.lo >>> p
  if (restLo !== 0) return ctz32(restLo) + 1
  // Then the whole `hi` lane.
  if (h.hi !== 0) return 32 - p + ctz32(h.hi) + 1
  return 64 - p + 1
}
