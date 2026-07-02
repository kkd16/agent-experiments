// ECVRF — a Verifiable Random Function on Edwards25519 (RFC 9381)
// ─────────────────────────────────────────────────────────────────────────────
// A VRF is a public-key pseudorandom function. The secret-key holder can, for
// any input α, compute a value β = VRF(sk, α) *together with a proof* π. Anyone
// with the public key can check π and be convinced that β is the one true output
// for (pk, α) — yet without the key, β is indistinguishable from random and
// unpredictable. It is, in effect, a signature whose *hash* is unique and
// uniformly random: exactly one β verifies per (pk, α), and the signer can't
// steer it.
//
// That combination — unpredictable, unbiasable, but publicly checkable — is why
// VRFs run leader election in Algorand, randomness beacons and lotteries in
// Chainlink and Cardano, and the hashed-name privacy layer in DNSSEC (NSEC5).
//
// This is a from-scratch, byte-for-byte implementation of the two Edwards25519
// ciphersuites standardised in RFC 9381:
//
//   • ECVRF-EDWARDS25519-SHA512-TAI  (suite 0x03) — hashes α to a curve point by
//     try-and-increment.
//   • ECVRF-EDWARDS25519-SHA512-ELL2 (suite 0x04) — hashes α to a curve point by
//     the constant-time Elligator2 map (hash-to-curve, RFC 9380 style).
//
// It reuses this lab's own Ed25519 group and SHA-512, and is pinned in the
// Self-Test against the official RFC 9381 Appendix B.3 / B.4 test vectors — the
// exact π and β bytes, reproduced here from the standard.

import { sha512 } from './sha512'
import { concat, bytesToBig } from './sha256'
import { legendre, mod, modInv } from './field'
import {
  P25519,
  L25519,
  ED_B,
  edMul,
  edSub,
  edEncode,
  edDecode,
  edExpandSeed,
  edIsIdentity,
  decodeLittleEndian,
  type EdPoint,
} from './ed25519'

const q = L25519 // prime group order ℓ
const cofactor = 8n
const A_MONT = 486662n // Montgomery curve coefficient A
// √(−A−2) = √(−486664) mod p, the constant of the Montgomery↔Edwards birational map.
const SQRT_MINUS_A_PLUS_2 =
  6853475219497561581579357271197624642482790079785650197046958215289687604742n

export type Suite = 'TAI' | 'ELL2'
const suiteByte = (s: Suite): number => (s === 'ELL2' ? 0x04 : 0x03)

// The Elligator2 domain-separation tag: "ECVRF_edwards25519_XMD:SHA-512_ELL2_NU_"
// followed by the suite octet 0x04.
const ELL2_DST = (() => {
  const s = 'ECVRF_edwards25519_XMD:SHA-512_ELL2_NU_'
  const b = new Uint8Array(s.length + 1)
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i)
  b[s.length] = 0x04
  return b
})()

const fmod = (a: bigint): bigint => mod(a, P25519)

/** int_to_string: a nonnegative integer as `len` little-endian octets. */
function i2osLE(n: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len)
  let v = n
  for (let i = 0; i < len; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}
const oct = (b: number): Uint8Array => Uint8Array.of(b & 0xff)

// ── Hash-to-curve, suite TAI (RFC 9381 §5.4.1.1) ─────────────────────────────
// H = cofactor · string_to_point( SHA-512(0x03‖0x01‖PK‖α‖ctr‖0x00)[0:32] ),
// scanning ctr = 0,1,2,… until the 32-byte prefix decodes to a point whose
// cofactor multiple is not the identity. Returns H and the winning counter.
export function encodeToCurveTAI(
  pkBytes: Uint8Array,
  alpha: Uint8Array,
): { H: EdPoint; ctr: number } {
  for (let ctr = 0; ctr < 256; ctr++) {
    const hash = sha512(concat(oct(0x03), oct(0x01), pkBytes, alpha, oct(ctr), oct(0x00)))
    const cand = edDecode(hash.slice(0, 32))
    if (cand) {
      const H = edMul(cofactor, cand)
      if (!edIsIdentity(H)) return { H, ctr }
    }
  }
  throw new Error('encode_to_curve_tai: no valid point in 256 tries')
}

// ── Hash-to-curve, suite ELL2 (RFC 9381 §5.4.1.2 + RFC 9380) ─────────────────
// expand_message_xmd with SHA-512, L = 48, to one field element, then the
// Elligator2 map to Curve25519, birational transfer to Edwards, and cofactor
// clearing. Constant-time by construction: no rejection loop.
export function hashToFieldEll2(pkBytes: Uint8Array, alpha: Uint8Array): bigint {
  const msg = concat(pkBytes, alpha)
  const lenInBytes = 48
  const bInBytes = 128 // SHA-512 block size → Z_pad length
  const zPad = new Uint8Array(bInBytes)
  const libStr = Uint8Array.of(0x00, lenInBytes) // I2OSP(48, 2), big-endian
  const dstPrime = concat(ELL2_DST, oct(ELL2_DST.length))
  const b0 = sha512(concat(zPad, msg, libStr, oct(0x00), dstPrime))
  const b1 = sha512(concat(b0, oct(0x01), dstPrime))
  // uniform_bytes = b1[0:48], interpreted big-endian, reduced mod p.
  return mod(bytesToBig(b1.slice(0, lenInBytes)), P25519)
}

/** The Elligator2 map + cofactor clear: F_p element → point on Edwards25519. */
export function mapToCurveEll2(u: bigint): EdPoint {
  const A = fmod(A_MONT)
  // Candidate Montgomery u-coordinate x1 = −A / (1 + 2u²).
  const x1 = fmod(-A * modInv(fmod(1n + 2n * u * u), P25519))
  // g(x1) = x1·(x1² + A·x1 + 1); its quadratic character picks the true u.
  const gx1 = fmod(x1 * fmod(x1 * x1 + A * x1 + 1n))
  const jac = legendre(gx1, P25519)
  const mu = jac === 1 ? x1 : fmod(-A - x1)
  // Birational transfer to Edwards: y = (u − 1)/(u + 1).
  const edwardsY = fmod((mu - 1n) * modInv(fmod(mu + 1n), P25519))
  const enc = i2osLE(edwardsY, 32) // top bit clear → decode the even-x root
  const H0 = edDecode(enc)
  if (!H0) throw new Error('elligator2: y did not decode')
  // The decoded point has even x; fix the sign from the Montgomery v-coordinate.
  const xAff = fmod(H0.X * modInv(H0.Z, P25519))
  const v = fmod(SQRT_MINUS_A_PLUS_2 * mu * modInv(xAff, P25519))
  const sgn0 = Number(v & 1n)
  const needFlip = (jac === 1 && sgn0 === 0) || (jac === -1 && sgn0 === 1)
  const H1 = needFlip ? { X: fmod(-H0.X), Y: H0.Y, Z: H0.Z, T: fmod(-H0.T) } : H0
  return edMul(cofactor, H1)
}

export function encodeToCurve(suite: Suite, pkBytes: Uint8Array, alpha: Uint8Array): EdPoint {
  if (suite === 'TAI') return encodeToCurveTAI(pkBytes, alpha).H
  return mapToCurveEll2(hashToFieldEll2(pkBytes, alpha))
}

// ── Challenge generation (RFC 9381 §5.4.3) ───────────────────────────────────
// c = string_to_int( SHA-512(suite‖0x02‖P1‖P2‖P3‖P4‖P5‖0x00)[0:16] ), the 16
// low bytes read little-endian (cLen = 16, half the field width).
function challenge(suite: Suite, pts: EdPoint[]): bigint {
  const parts = [oct(suiteByte(suite)), oct(0x02), ...pts.map((p) => edEncode(p)), oct(0x00)]
  const h = sha512(concat(...parts))
  return decodeLittleEndian(h.slice(0, 16))
}

export interface VrfProof {
  gamma: Uint8Array // 32-byte compressed point
  c: bigint // challenge scalar (cLen = 16 bytes)
  s: bigint // response scalar (mod ℓ)
}

/** Serialise π = point_to_string(Γ) ‖ int_to_string(c,16) ‖ int_to_string(s,32) (80 bytes). */
export function proofToBytes(pi: VrfProof): Uint8Array {
  return concat(pi.gamma, i2osLE(pi.c, 16), i2osLE(pi.s, 32))
}

/** Parse an 80-byte proof; returns null on the wrong length. */
export function proofFromBytes(b: Uint8Array): VrfProof | null {
  if (b.length !== 80) return null
  return {
    gamma: b.slice(0, 32),
    c: decodeLittleEndian(b.slice(32, 48)),
    s: decodeLittleEndian(b.slice(48, 80)),
  }
}

/** ECVRF public key: the 32-byte Ed25519 point Y = x·B for the seed's scalar. */
export function ecvrfKeygen(seed: Uint8Array): Uint8Array {
  return edExpandSeed(seed).A
}

// ── Prove (RFC 9381 §5.1) ────────────────────────────────────────────────────
export function ecvrfProve(suite: Suite, seed: Uint8Array, alpha: Uint8Array): VrfProof {
  const { x, prefix, A: pk } = edExpandSeed(seed)
  const H = encodeToCurve(suite, pk, alpha)
  const Hbytes = edEncode(H)
  const gamma = edMul(x, H)
  // Nonce k = string_to_int( SHA-512(prefix ‖ point_to_string(H)) ) mod ℓ.
  const k = mod(decodeLittleEndian(sha512(concat(prefix, Hbytes))), q)
  const U = edMul(k, ED_B) // k·B
  const V = edMul(k, H) // k·H
  const Y = edDecode(pk)!
  const c = challenge(suite, [Y, H, gamma, U, V])
  const s = mod(k + c * x, q)
  return { gamma: edEncode(gamma), c, s }
}

/** proof_to_hash: β = SHA-512(suite‖0x03‖point_to_string(cofactor·Γ)‖0x00) (64 bytes). */
export function proofToHash(suite: Suite, pi: VrfProof): Uint8Array {
  const gamma = edDecode(pi.gamma)
  if (!gamma) throw new Error('proof_to_hash: bad Γ')
  const cg = edMul(cofactor, gamma)
  return sha512(concat(oct(suiteByte(suite)), oct(0x03), edEncode(cg), oct(0x00)))
}

// ── Verify (RFC 9381 §5.3) ───────────────────────────────────────────────────
export function ecvrfVerify(
  suite: Suite,
  pkBytes: Uint8Array,
  alpha: Uint8Array,
  pi: VrfProof,
): boolean {
  const Y = edDecode(pkBytes)
  if (!Y) return false
  const gamma = edDecode(pi.gamma)
  if (!gamma) return false
  if (pi.s >= q) return false
  const H = encodeToCurve(suite, pkBytes, alpha)
  // U = s·B − c·Y,  V = s·H − c·Γ.
  const U = edSub(edMul(pi.s, ED_B), edMul(pi.c, Y))
  const V = edSub(edMul(pi.s, H), edMul(pi.c, gamma))
  const cPrime = challenge(suite, [Y, H, gamma, U, V])
  return cPrime === pi.c
}

/** Convenience: prove and immediately hash to the β output (32 bytes shown, 64 full). */
export function ecvrfEvaluate(
  suite: Suite,
  seed: Uint8Array,
  alpha: Uint8Array,
): { pi: VrfProof; beta: Uint8Array } {
  const pi = ecvrfProve(suite, seed, alpha)
  return { pi, beta: proofToHash(suite, pi) }
}
