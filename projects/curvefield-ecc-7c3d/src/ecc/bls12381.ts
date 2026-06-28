// BLS12-381 — the pairing-friendly curve behind Ethereum consensus, Zcash
// Sapling, and modern threshold cryptography — built here from the tower fields
// in fp2/fp6/fp12, with a hand-written optimal-ate pairing and BLS signature
// aggregation on top.
//
// The point of a *pairing* is a map  e : G1 × G2 → G_T  that is bilinear:
//
//     e(a·P, b·Q) = e(P, Q)^{ab}.
//
// That one identity is a superpower. It lets a verifier check a multiplicative
// relation between secrets it never sees — which is exactly what makes BLS
// signatures aggregate: a thousand signatures on a block collapse into one
// 48-byte group element, verified with a constant number of pairings.
//
// G1 lives on E : y² = x³ + 4 over F_p; G2 on the sextic twist
// E' : y² = x³ + 4(1 + u) over F_{p²}. The pairing runs a Miller loop driven by
// the curve's BLS seed x and finishes with a final exponentiation into G_T.
//
// Everything is from scratch on BigInt — no pairing library, no field library.
// (The hash-to-curve here is honest *try-and-increment*, not the constant-time
// RFC 9380 SSWU; it is for learning, not production.)

import { mod, modInv, modSqrt } from './field'
import { BLS_P } from './fp2'
import { Fp2 } from './fp2'
import { Fp6 } from './fp6'
import { Fp12 } from './fp12'
import { sha256, concat, bigToBytes, bytesToBig, bytesToHex } from './sha256'
import { finalExpFast } from './bls_finalexp'

const P = BLS_P

// ── Curve constants ──────────────────────────────────────────────────────────

/** Prime order of G1, G2, G_T (the "r" of BLS12-381). */
export const R =
  0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n

/** The BLS seed. The curve is parameterized by this x; it is negative. */
export const BLS_X = -0xd201000000010000n
const ABS_X = 0xd201000000010000n

/** G1 cofactor: |E(F_p)| = h1 · r. Multiplying by h1 lands a point in the r-torsion. */
const H1 = 0x396c8c005555e1568c00aaab0000aaabn

// ── G1: E(F_p), y² = x³ + 4 ──────────────────────────────────────────────────

export type G1 = { x: bigint; y: bigint } | null
const B1 = 4n

export const G1_GEN: G1 = {
  x: 0x17f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bbn,
  y: 0x08b3f481e3aaa0f1a09e30ed741d8ae4fcf5e095d5d00af600db18cb2c04b3edd03cc744a2888ae40caa232946c5e7e1n,
}

export const g1 = {
  isOnCurve(Pt: G1): boolean {
    if (Pt === null) return true
    return mod(Pt.y * Pt.y - (Pt.x * Pt.x * Pt.x + B1), P) === 0n
  },
  neg(Pt: G1): G1 {
    return Pt === null ? null : { x: Pt.x, y: mod(-Pt.y, P) }
  },
  add(A: G1, Bp: G1): G1 {
    if (A === null) return Bp
    if (Bp === null) return A
    if (A.x === Bp.x && mod(A.y + Bp.y, P) === 0n) return null
    let m: bigint
    if (A.x === Bp.x && A.y === Bp.y) {
      if (A.y === 0n) return null
      m = mod(3n * A.x * A.x * modInv(2n * A.y, P), P)
    } else {
      m = mod((Bp.y - A.y) * modInv(Bp.x - A.x, P), P)
    }
    const x3 = mod(m * m - A.x - Bp.x, P)
    const y3 = mod(m * (A.x - x3) - A.y, P)
    return { x: x3, y: y3 }
  },
  mul(k: bigint, Pt: G1): G1 {
    let n = k % R
    if (n < 0n) {
      n = -n
      Pt = g1.neg(Pt)
    }
    let acc: G1 = null
    let addend = Pt
    while (n > 0n) {
      if (n & 1n) acc = g1.add(acc, addend)
      addend = g1.add(addend, addend)
      n >>= 1n
    }
    return acc
  },
  // Cofactor multiplication does *not* reduce mod r (that would corrupt it).
  mulRaw(k: bigint, Pt: G1): G1 {
    let n = k
    let acc: G1 = null
    let addend = Pt
    while (n > 0n) {
      if (n & 1n) acc = g1.add(acc, addend)
      addend = g1.add(addend, addend)
      n >>= 1n
    }
    return acc
  },
  eq(A: G1, Bp: G1): boolean {
    if (A === null || Bp === null) return A === Bp
    return A.x === Bp.x && A.y === Bp.y
  },
}

// ── G2: E'(F_{p²}), y² = x³ + 4(1 + u) ───────────────────────────────────────

export type G2 = { x: Fp2; y: Fp2 } | null
const B2: Fp2 = Fp2.of(4n, 4n)

export const G2_GEN: G2 = {
  x: Fp2.of(
    0x024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8n,
    0x13e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7en,
  ),
  y: Fp2.of(
    0x0ce5d527727d6e118cc9cdc6da2e351aadfd9baa8cbdd3a76d429a695160d12c923ac9cc3baca289e193548608b82801n,
    0x0606c4a02ea734cc32acd2b02bc28b99cb3e287e85a763af267492ab572e99ab3f370d275cec1da1aaa9075ff05f79ben,
  ),
}

export const g2 = {
  isOnCurve(Pt: G2): boolean {
    if (Pt === null) return true
    const lhs = Fp2.sqr(Pt.y)
    const rhs = Fp2.add(Fp2.mul(Fp2.sqr(Pt.x), Pt.x), B2)
    return Fp2.eq(lhs, rhs)
  },
  neg(Pt: G2): G2 {
    return Pt === null ? null : { x: Pt.x, y: Fp2.neg(Pt.y) }
  },
  add(A: G2, Bp: G2): G2 {
    if (A === null) return Bp
    if (Bp === null) return A
    if (Fp2.eq(A.x, Bp.x) && Fp2.isZero(Fp2.add(A.y, Bp.y))) return null
    let m: Fp2
    if (Fp2.eq(A.x, Bp.x) && Fp2.eq(A.y, Bp.y)) {
      if (Fp2.isZero(A.y)) return null
      m = Fp2.mul(Fp2.mulFp(Fp2.sqr(A.x), 3n), Fp2.inv(Fp2.mulFp(A.y, 2n)))
    } else {
      m = Fp2.mul(Fp2.sub(Bp.y, A.y), Fp2.inv(Fp2.sub(Bp.x, A.x)))
    }
    const x3 = Fp2.sub(Fp2.sub(Fp2.sqr(m), A.x), Bp.x)
    const y3 = Fp2.sub(Fp2.mul(m, Fp2.sub(A.x, x3)), A.y)
    return { x: x3, y: y3 }
  },
  mul(k: bigint, Pt: G2): G2 {
    let n = k
    if (n < 0n) {
      n = -n
      Pt = g2.neg(Pt)
    }
    let acc: G2 = null
    let addend = Pt
    while (n > 0n) {
      if (n & 1n) acc = g2.add(acc, addend)
      addend = g2.add(addend, addend)
      n >>= 1n
    }
    return acc
  },
  eq(A: G2, Bp: G2): boolean {
    if (A === null || Bp === null) return A === Bp
    return Fp2.eq(A.x, Bp.x) && Fp2.eq(A.y, Bp.y)
  },
}

// ── The pairing ──────────────────────────────────────────────────────────────
//
// We run the Miller loop with both inputs lifted into F_{p¹²}: the G1 point sits
// in the bottom slot, and the G2 point is moved across the sextic twist by
// ψ(x, y) = (x·w², y·w³). Then the loop is ordinary elliptic-curve arithmetic
// over F_{p¹²}, evaluating a line at the G1 point at every step.

type Pt12 = { x: Fp12; y: Fp12 } | null

/** Embed a G1 point (coords in F_p) into F_{p¹²}. */
function g1ToFp12(Pt: G1): Pt12 {
  if (Pt === null) return null
  return { x: Fp12.fromFp(Pt.x), y: Fp12.fromFp(Pt.y) }
}

// The sextic untwist ψ : E'(F_{p²}) → E(F_{p¹²}) is (x, y) ↦ (x·w⁻², y·w⁻³).
// With w⁶ = ξ = 1 + u, this carries the twisted b' = 4(1+u) back to b = 4, so the
// image lands on the *same* curve y² = x³ + 4 that G1 lives on — the prerequisite
// for a well-defined pairing.
const W = Fp12.of(Fp6.ZERO, Fp6.ONE)
const INV_W2 = Fp12.inv(Fp12.sqr(W))
const INV_W3 = Fp12.inv(Fp12.mul(Fp12.sqr(W), W))
const embedFp2 = (a: Fp2): Fp12 => Fp12.of(Fp6.fromFp2(a), Fp6.ZERO)

/** Untwist a G2 point into F_{p¹²} via ψ(x, y) = (x·w⁻², y·w⁻³). */
function g2ToFp12(Pt: G2): Pt12 {
  if (Pt === null) return null
  return {
    x: Fp12.mul(embedFp2(Pt.x), INV_W2),
    y: Fp12.mul(embedFp2(Pt.y), INV_W3),
  }
}

function dbl12(A: Pt12): Pt12 {
  if (A === null) return null
  if (Fp12.eq(A.y, Fp12.ZERO)) return null
  const m = Fp12.div(Fp12.mul(Fp12.fromFp(3n), Fp12.sqr(A.x)), Fp12.add(A.y, A.y))
  const x3 = Fp12.sub(Fp12.sqr(m), Fp12.add(A.x, A.x))
  const y3 = Fp12.sub(Fp12.mul(m, Fp12.sub(A.x, x3)), A.y)
  return { x: x3, y: y3 }
}

function add12(A: Pt12, Bp: Pt12): Pt12 {
  if (A === null) return Bp
  if (Bp === null) return A
  const m = Fp12.div(Fp12.sub(Bp.y, A.y), Fp12.sub(Bp.x, A.x))
  const x3 = Fp12.sub(Fp12.sub(Fp12.sqr(m), A.x), Bp.x)
  const y3 = Fp12.sub(Fp12.mul(m, Fp12.sub(A.x, x3)), A.y)
  return { x: x3, y: y3 }
}

/** The line through P1, P2 (or the tangent at P1 if equal) evaluated at T. */
function line(P1: Pt12, P2: Pt12, T: Pt12): Fp12 {
  if (P1 === null || P2 === null || T === null) return Fp12.ONE
  if (!Fp12.eq(P1.x, P2.x)) {
    const m = Fp12.div(Fp12.sub(P2.y, P1.y), Fp12.sub(P2.x, P1.x))
    return Fp12.sub(Fp12.mul(m, Fp12.sub(T.x, P1.x)), Fp12.sub(T.y, P1.y))
  } else if (Fp12.eq(P1.y, P2.y)) {
    const m = Fp12.div(Fp12.mul(Fp12.fromFp(3n), Fp12.sqr(P1.x)), Fp12.add(P1.y, P1.y))
    return Fp12.sub(Fp12.mul(m, Fp12.sub(T.x, P1.x)), Fp12.sub(T.y, P1.y))
  }
  return Fp12.sub(T.x, P1.x)
}

/** Miller loop f_{|x|, Q}(P), with Q the (untwisted) G2 point and P the G1 point. */
function miller(Q: Pt12, Pp: Pt12): Fp12 {
  if (Q === null || Pp === null) return Fp12.ONE
  let R12: Pt12 = Q
  let f = Fp12.ONE
  const bits = ABS_X.toString(2)
  for (let i = 1; i < bits.length; i++) {
    f = Fp12.mul(Fp12.sqr(f), line(R12, R12, Pp))
    R12 = dbl12(R12)
    if (bits[i] === '1') {
      f = Fp12.mul(f, line(R12, Q, Pp))
      R12 = add12(R12, Q)
    }
  }
  return f
}

// Final exponent split: (p¹² − 1)/r = (p⁶ − 1)·(p² + 1)·(Φ₁₂(p)/r). The first
// factor is just a conjugate-and-invert; we fold the rest into one BigInt power.
// This is the textbook (slow) form, kept as the reference the fast path is
// proven against in the self-test.
const FINAL_TAIL = (P ** 2n + 1n) * ((P ** 4n - P ** 2n + 1n) / R)

export function finalExpCanonical(f: Fp12): Fp12 {
  // f^{p⁶ − 1} = conj(f) · f⁻¹  (conjugation over F_{p⁶} equals the p⁶ Frobenius).
  const easy = Fp12.mul(Fp12.conj(f), Fp12.inv(f))
  return Fp12.pow(easy, FINAL_TAIL)
}

// The hot path: the Hayashida–Aranha addition-chain final exponentiation, which
// replaces the ~2000-bit `Fp12.pow` above with a handful of 64-bit seed powers
// and Frobenius maps (≈17× faster). It computes e(·)³ rather than the canonical
// e(·) — a fixed cube, so it stays in G_T and bilinear and every pairing
// *equality* this lab checks is preserved (both sides are cubed alike).
function finalExp(f: Fp12): Fp12 {
  return finalExpFast(f)
}

/**
 * The optimal-ate pairing e(P, Q) ∈ G_T. Bilinear and non-degenerate: this is
 * the engine every BLS check below runs on.
 */
export function pairing(Pp: G1, Q: G2): Fp12 {
  if (Pp === null || Q === null) return Fp12.ONE
  let f = miller(g2ToFp12(Q), g1ToFp12(Pp))
  // The seed x is negative, so the Miller value must be conjugated.
  f = Fp12.conj(f)
  return finalExp(f)
}

/** Product of pairings ∏ e(Pᵢ, Qᵢ), finishing with a single final exponentiation. */
export function pairingProduct(pairs: { p: G1; q: G2 }[]): Fp12 {
  let f = Fp12.ONE
  for (const { p, q } of pairs) {
    if (p === null || q === null) continue
    f = Fp12.mul(f, miller(g2ToFp12(q), g1ToFp12(p)))
  }
  f = Fp12.conj(f)
  return finalExp(f)
}

// ── Hash to G1 (try-and-increment) ───────────────────────────────────────────

/**
 * Map a message to a point of G1. Honest *try-and-increment*: hash to a field
 * element, attempt to lift it to the curve, bump a counter until it works, then
 * clear the cofactor so the result lies in the prime-order r-torsion. Not the
 * constant-time RFC 9380 map — fine for a teaching lab, not for production.
 */
export function hashToG1(msg: Uint8Array): G1 {
  for (let ctr = 0; ctr < 256; ctr++) {
    const h = sha256(concat(msg, new Uint8Array([ctr])))
    const x = mod(bytesToBig(h), P)
    const rhs = mod(x * x * x + B1, P)
    const y = modSqrt(rhs, P) // p ≡ 3 mod 4, so this is a clean (p+1)/4 power
    if (y === null) continue
    // Fix the sign deterministically (pick the even-y root).
    const yy = y % 2n === 0n ? y : P - y
    const candidate: G1 = { x, y: yy }
    return g1.mulRaw(H1, candidate) // cofactor clearing
  }
  throw new Error('hashToG1 failed to find a point (vanishingly unlikely)')
}

// ── BLS signatures (minimal-signature-size: σ ∈ G1, pk ∈ G2) ──────────────────

export interface BlsKey {
  sk: bigint
  pk: G2
}

/** Derive a key pair from a secret scalar in [1, r). */
export function blsKeygen(sk: bigint): BlsKey {
  const d = mod(sk, R)
  return { sk: d, pk: g2.mul(d, G2_GEN) }
}

/** Sign: σ = sk · H(m) ∈ G1. */
export function blsSign(sk: bigint, msg: Uint8Array): G1 {
  return g1.mul(mod(sk, R), hashToG1(msg))
}

/** Verify a single signature: e(σ, G2) ?= e(H(m), pk). */
export function blsVerify(pk: G2, msg: Uint8Array, sig: G1): boolean {
  const H = hashToG1(msg)
  const lhs = pairing(sig, G2_GEN)
  const rhs = pairing(H, pk)
  return Fp12.eq(lhs, rhs)
}

/** Aggregate signatures (or public keys) by summing in their group. */
export function aggregateSigs(sigs: G1[]): G1 {
  let acc: G1 = null
  for (const s of sigs) acc = g1.add(acc, s)
  return acc
}

export function aggregatePubkeys(pks: G2[]): G2 {
  let acc: G2 = null
  for (const k of pks) acc = g2.add(acc, k)
  return acc
}

/**
 * Verify an aggregate over **distinct messages**: one pairing per signer plus
 * one for the aggregate signature —
 *     e(σ_agg, G2) ?= ∏ e(H(mᵢ), pkᵢ).
 * Distinct messages are what makes this safe without proofs of possession.
 */
export function blsAggregateVerifyDistinct(
  pks: G2[],
  msgs: Uint8Array[],
  aggSig: G1,
): boolean {
  if (pks.length !== msgs.length) return false
  const lhs = pairing(aggSig, G2_GEN)
  const pairs = msgs.map((m, i) => ({ p: hashToG1(m), q: pks[i] }))
  const rhs = pairingProduct(pairs)
  return Fp12.eq(lhs, rhs)
}

/**
 * Verify an aggregate over a **single common message** with the naive scheme:
 *     e(σ_agg, G2) ?= e(H(m), Σ pkᵢ).
 * Cheap (two pairings) but vulnerable to the rogue-key attack unless every key
 * carries a proof of possession — which the Attacks UI demonstrates.
 */
export function blsFastAggregateVerify(pks: G2[], msg: Uint8Array, aggSig: G1): boolean {
  const aggPk = aggregatePubkeys(pks)
  const H = hashToG1(msg)
  const lhs = pairing(aggSig, G2_GEN)
  const rhs = pairing(H, aggPk)
  return Fp12.eq(lhs, rhs)
}

/** Serialize a G1 point as 96 hex chars (uncompressed x‖y) for display. */
export function g1Hex(Pt: G1): string {
  if (Pt === null) return 'O'
  return bytesToHex(bigToBytes(Pt.x, 48)) + bytesToHex(bigToBytes(Pt.y, 48))
}

/** Serialize a G2 point's x-coordinate (the two F_{p²} components) for display. */
export function g2Hex(Pt: G2): string {
  if (Pt === null) return 'O'
  return bytesToHex(bigToBytes(Pt.x.a, 48)) + bytesToHex(bigToBytes(Pt.x.b, 48))
}
