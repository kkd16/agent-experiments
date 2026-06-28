// ZCash / Ethereum BLS12-381 point serialization — the wire format that carries
// every aggregated signature and validator public key on Ethereum's beacon
// chain. A 𝔾₁ point is a single 48-byte string and a 𝔾₂ point 96 bytes, because
// only the x-coordinate is stored: the three high bits of the first byte are
// flags (compression / infinity / sign) and y is recovered from the curve
// equation, its sign pinned by the lexicographic "is y the larger root?" bit.
//
// Two subtleties this gets right: F_{p²} is packed imaginary-part-first
// (c₁ ‖ c₀), and the sign bit compares the *whole* field element
// lexicographically (c₁ then c₀), not just a parity. Verified against the
// canonical compressed generators in selftest.ts.

import { mod, modSqrt } from './field'
import { BLS_P, Fp2 } from './fp2'
import { bigToBytes, bytesToBig } from './sha256'
import type { G1, G2 } from './bls12381'
import { fp2Sqrt } from './hash2curve'

const P = BLS_P
const L = 48 // bytes per F_p element

// ── the "sort" (sign) bit: is this y the lexicographically larger root? ───────

/** sortBit([parts…]): first nonzero part decides; 1 iff that part > p/2. */
function sortBit(parts: bigint[]): boolean {
  for (const part of parts) {
    if (part !== 0n) return (part * 2n) / P === 1n
  }
  return false
}

const FLAG_COMP = 0x80
const FLAG_INF = 0x40
const FLAG_SORT = 0x20

function setFlags(bytes: Uint8Array, compressed: boolean, infinity: boolean, sort: boolean): Uint8Array {
  if (compressed) bytes[0] |= FLAG_COMP
  if (infinity) bytes[0] |= FLAG_INF
  if (sort) bytes[0] |= FLAG_SORT
  return bytes
}

function parseFlags(bytes: Uint8Array): {
  compressed: boolean
  infinity: boolean
  sort: boolean
  value: Uint8Array
} {
  const compressed = (bytes[0] & FLAG_COMP) !== 0
  const infinity = (bytes[0] & FLAG_INF) !== 0
  const sort = (bytes[0] & FLAG_SORT) !== 0
  // Reject the invalid flag combinations (pairing-friendly-curves draft C.2).
  if ((!compressed && sort) || (infinity && sort)) throw new Error('invalid encoding flags')
  const value = bytes.slice()
  value[0] &= 0x1f
  return { compressed, infinity, sort, value }
}

// ── 𝔾₁ : E(F_p), y² = x³ + 4 ──────────────────────────────────────────────────

const B1 = 4n

/** Compress a 𝔾₁ point to 48 bytes (x with the three flag bits). */
export function compressG1(Pt: G1): Uint8Array {
  if (Pt === null) return setFlags(new Uint8Array(L), true, true, false)
  const bytes = bigToBytes(Pt.x, L)
  return setFlags(bytes, true, false, sortBit([Pt.y]))
}

/** Serialize a 𝔾₁ point uncompressed (96 bytes, x ‖ y). */
export function toBytesG1(Pt: G1): Uint8Array {
  if (Pt === null) return setFlags(new Uint8Array(2 * L), false, true, false)
  const out = new Uint8Array(2 * L)
  out.set(bigToBytes(Pt.x, L), 0)
  out.set(bigToBytes(Pt.y, L), L)
  return setFlags(out, false, false, false)
}

/** Decompress / parse a 𝔾₁ point from its 48- or 96-byte encoding. */
export function decompressG1(bytes: Uint8Array): G1 {
  const { compressed, infinity, sort, value } = parseFlags(bytes)
  if (infinity) {
    for (const b of value) if (b !== 0) throw new Error('non-canonical infinity')
    return null
  }
  if (compressed) {
    if (value.length !== L) throw new Error('𝔾₁ compressed point must be 48 bytes')
    const x = mod(bytesToBig(value), P)
    let y = modSqrt(mod(x * x * x + B1, P), P)
    if (y === null) throw new Error('𝔾₁ point: x has no y on the curve')
    if (sortBit([y]) !== sort) y = mod(-y, P)
    return { x, y }
  }
  if (value.length !== 2 * L) throw new Error('𝔾₁ uncompressed point must be 96 bytes')
  const x = mod(bytesToBig(value.subarray(0, L)), P)
  const y = mod(bytesToBig(value.subarray(L)), P)
  return { x, y }
}

// ── 𝔾₂ : E'(F_{p²}), y² = x³ + 4(1+u) — packed imaginary-part-first ───────────

const B2 = Fp2.of(4n, 4n)

function fp2ToBytes(a: Fp2): Uint8Array {
  const out = new Uint8Array(2 * L)
  out.set(bigToBytes(a.b, L), 0) // c₁ first
  out.set(bigToBytes(a.a, L), L) // then c₀
  return out
}

function fp2FromBytes(b: Uint8Array): Fp2 {
  const c1 = mod(bytesToBig(b.subarray(0, L)), P)
  const c0 = mod(bytesToBig(b.subarray(L, 2 * L)), P)
  return Fp2.of(c0, c1)
}

/** Compress a 𝔾₂ point to 96 bytes. */
export function compressG2(Pt: G2): Uint8Array {
  if (Pt === null) return setFlags(new Uint8Array(2 * L), true, true, false)
  const bytes = fp2ToBytes(Pt.x)
  return setFlags(bytes, true, false, sortBit([Pt.y.b, Pt.y.a]))
}

/** Serialize a 𝔾₂ point uncompressed (192 bytes, x ‖ y, each imaginary-first). */
export function toBytesG2(Pt: G2): Uint8Array {
  if (Pt === null) return setFlags(new Uint8Array(4 * L), false, true, false)
  const out = new Uint8Array(4 * L)
  out.set(fp2ToBytes(Pt.x), 0)
  out.set(fp2ToBytes(Pt.y), 2 * L)
  return setFlags(out, false, false, false)
}

/** Decompress / parse a 𝔾₂ point from its 96- or 192-byte encoding. */
export function decompressG2(bytes: Uint8Array): G2 {
  const { compressed, infinity, sort, value } = parseFlags(bytes)
  if (infinity) {
    for (const b of value) if (b !== 0) throw new Error('non-canonical infinity')
    return null
  }
  if (compressed) {
    if (value.length !== 2 * L) throw new Error('𝔾₂ compressed point must be 96 bytes')
    const x = fp2FromBytes(value)
    const rhs = Fp2.add(Fp2.mul(Fp2.sqr(x), x), B2)
    let y = fp2Sqrt(rhs)
    if (y === null) throw new Error('𝔾₂ point: x has no y on the curve')
    if (sortBit([y.b, y.a]) !== sort) y = Fp2.neg(y)
    return { x, y }
  }
  if (value.length !== 4 * L) throw new Error('𝔾₂ uncompressed point must be 192 bytes')
  const x = fp2FromBytes(value.subarray(0, 2 * L))
  const y = fp2FromBytes(value.subarray(2 * L))
  return { x, y }
}
