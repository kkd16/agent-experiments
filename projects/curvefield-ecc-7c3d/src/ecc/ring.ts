// Linkable ring signatures & stealth addresses — the cryptographic core of a
// private, Monero-style payment.
// ─────────────────────────────────────────────────────────────────────────────
// A *ring signature* proves "one of these n public keys signed this message"
// without revealing which. Add a *key image* — a second, deterministic point
// derived from the signer's secret — and you get a *linkable* ring signature:
// still anonymous, but any two signatures from the same key carry the *same*
// image, so a verifier can detect a double-spend without ever learning who the
// spender is. That is exactly what lets a currency hide senders yet still forbid
// spending the same coin twice.
//
// This file builds, from scratch on this lab's Ed25519 group and SHA-512:
//
//   • SAG   — a plain (unlinkable) Spontaneous Anonymous Group signature (AOS),
//             the ancestor of the rest.
//   • bLSAG — Back's Linkable SAG: SAG + a key image. Monero's original scheme.
//   • CLSAG — Concise LSAG (Goodell–Noether–RandomRun 2019): signs a *vector* of
//             keys per ring member (output key + amount commitment) with a single
//             scalar each, via aggregation coefficients. Monero's scheme since
//             2020's Bulletproofs+ upgrade.
//   • Stealth addresses — CryptoNote one-time keys: the sender derives a fresh
//             output key only the recipient can spend, tying the whole payment
//             together.
//
// The *algorithm* is faithful to Monero's; the concrete hash primitives are this
// lab's SHA-512 + Elligator2 hash-to-point rather than Keccak, so signatures are
// not byte-compatible with mainnet Monero — but every security property (correct-
// ness, anonymity, linkability, unforgeability) holds and is checked live.

import { sha512 } from './sha512'
import { concat, bytesToBig, utf8 } from './sha256'
import { mod } from './field'
import { randomScalar } from './rng'
import { hashToFieldEll2, mapToCurveEll2 } from './ecvrf'
import {
  L25519,
  ED_B,
  edMul,
  edPointAdd,
  edEncode,
  edEqual2,
  type EdPoint,
} from './ed25519'

const q = L25519 // prime subgroup order ℓ

// ── Scalar / point helpers ───────────────────────────────────────────────────
export const scalarMod = (n: bigint): bigint => mod(n, q)
export const mulBase = (k: bigint): EdPoint => edMul(k, ED_B)
export const pubFromSecret = (x: bigint): EdPoint => mulBase(scalarMod(x))

/** Hash-to-scalar: reduce SHA-512(tag ‖ data) into F_ℓ. */
export function hashToScalar(tag: string, ...parts: Uint8Array[]): bigint {
  return mod(bytesToBig(sha512(concat(utf8(tag), ...parts))), q)
}

/** Hash-to-point Hp: map a point deterministically to another curve point,
 *  reusing the ECVRF Elligator2 hash-to-curve. Used to build key images. */
export function hashToPoint(P: EdPoint): EdPoint {
  return mapToCurveEll2(hashToFieldEll2(edEncode(P), new Uint8Array(0)))
}

/** The key image I = x · Hp(x·B) — deterministic in the secret, revealing
 *  nothing about it, and identical across every signature the key ever makes. */
export function keyImage(x: bigint, P: EdPoint): EdPoint {
  return edMul(scalarMod(x), hashToPoint(P))
}

const enc = edEncode

// ═════════════════════════════════════════════════════════════════════════════
// SAG — plain (unlinkable) ring signature (Abe–Ohkubo–Suzuki)
// ═════════════════════════════════════════════════════════════════════════════
export interface SagSig {
  c0: bigint
  s: bigint[]
}

/** Sign `msg` with secret `x` at ring index `signerIdx`; `ring` holds every
 *  member's public key P_i (with P_signerIdx = x·B). */
export function sagSign(
  msg: Uint8Array,
  ring: EdPoint[],
  x: bigint,
  signerIdx: number,
): SagSig {
  const n = ring.length
  const c = new Array<bigint>(n).fill(0n)
  const s = new Array<bigint>(n).fill(0n)
  const alpha = randomScalar(q)
  // Start the loop just after the signer: c_{π+1} = H(msg, α·B).
  let i = (signerIdx + 1) % n
  c[i] = hashToScalar('CLSAG_lab_SAG', msg, enc(edMul(alpha, ED_B)))
  while (i !== signerIdx) {
    s[i] = randomScalar(q)
    // L = s_i·B + c_i·P_i
    const L = edPointAdd(edMul(s[i], ED_B), edMul(c[i], ring[i]))
    const next = (i + 1) % n
    c[next] = hashToScalar('CLSAG_lab_SAG', msg, enc(L))
    i = next
  }
  // Close the ring: s_π = α − c_π·x.
  s[signerIdx] = scalarMod(alpha - c[signerIdx] * x)
  return { c0: c[0], s }
}

export function sagVerify(msg: Uint8Array, ring: EdPoint[], sig: SagSig): boolean {
  const n = ring.length
  if (sig.s.length !== n) return false
  let c = sig.c0
  for (let i = 0; i < n; i++) {
    const L = edPointAdd(edMul(sig.s[i], ED_B), edMul(c, ring[i]))
    c = hashToScalar('CLSAG_lab_SAG', msg, enc(L))
  }
  return c === sig.c0
}

// ═════════════════════════════════════════════════════════════════════════════
// bLSAG — Back's Linkable Spontaneous Anonymous Group signature
// ═════════════════════════════════════════════════════════════════════════════
export interface BlsagSig {
  c0: bigint
  s: bigint[]
  image: EdPoint // key image I = x·Hp(P)
}

const BLSAG_TAG = 'CLSAG_lab_bLSAG'

export function blsagSign(
  msg: Uint8Array,
  ring: EdPoint[],
  x: bigint,
  signerIdx: number,
): BlsagSig {
  const n = ring.length
  const c = new Array<bigint>(n).fill(0n)
  const s = new Array<bigint>(n).fill(0n)
  const Pπ = ring[signerIdx]
  const image = keyImage(x, Pπ)
  const alpha = randomScalar(q)
  let i = (signerIdx + 1) % n
  // c_{π+1} = H(msg, α·B, α·Hp(P_π))
  c[i] = hashToScalar(BLSAG_TAG, msg, enc(edMul(alpha, ED_B)), enc(edMul(alpha, hashToPoint(Pπ))))
  while (i !== signerIdx) {
    s[i] = randomScalar(q)
    const L = edPointAdd(edMul(s[i], ED_B), edMul(c[i], ring[i])) // s_i·B + c_i·P_i
    const R = edPointAdd(edMul(s[i], hashToPoint(ring[i])), edMul(c[i], image)) // s_i·Hp(P_i)+c_i·I
    const next = (i + 1) % n
    c[next] = hashToScalar(BLSAG_TAG, msg, enc(L), enc(R))
    i = next
  }
  s[signerIdx] = scalarMod(alpha - c[signerIdx] * x)
  return { c0: c[0], s, image }
}

export function blsagVerify(msg: Uint8Array, ring: EdPoint[], sig: BlsagSig): boolean {
  const n = ring.length
  if (sig.s.length !== n) return false
  let c = sig.c0
  for (let i = 0; i < n; i++) {
    const L = edPointAdd(edMul(sig.s[i], ED_B), edMul(c, ring[i]))
    const R = edPointAdd(edMul(sig.s[i], hashToPoint(ring[i])), edMul(c, sig.image))
    c = hashToScalar(BLSAG_TAG, msg, enc(L), enc(R))
  }
  return c === sig.c0
}

/** Two bLSAG/CLSAG signatures are *linked* (same signer) iff their key images
 *  are the same point — the whole point of a linkable ring signature. */
export function imagesLinked(a: EdPoint, b: EdPoint): boolean {
  return edEqual2(a, b)
}

// ═════════════════════════════════════════════════════════════════════════════
// CLSAG — Concise LSAG over (output key P_i, commitment C_i)
// ═════════════════════════════════════════════════════════════════════════════
// The signer at index π knows p (P_π = p·B) and z (C_π = z·B). Two key images:
//   I = p·Hp(P_π)  (the linking image; depends only on the spend key)
//   D = z·Hp(P_π)  (auxiliary, proves the commitment difference opens to 0·B)
// Aggregation coefficients μ_P, μ_C fold the two rings into one:
//   W_i = μ_P·P_i + μ_C·C_i,   Ĩ = μ_P·I + μ_C·D,   w = μ_P·p + μ_C·z.
// Then a single LSAG runs over (W_i, base Hp(P_i), aggregate image Ĩ), so there
// is just ONE response scalar s_i per ring member — hence "concise".
export interface ClsagSig {
  c0: bigint
  s: bigint[]
  I: EdPoint // linking key image
  D: EdPoint // auxiliary (commitment) key image
}

const AGG0 = 'CLSAG_lab_agg_0'
const AGG1 = 'CLSAG_lab_agg_1'
const ROUND = 'CLSAG_lab_round'

function ringBytes(ringP: EdPoint[], ringC: EdPoint[], I: EdPoint, D: EdPoint): Uint8Array {
  return concat(...ringP.map(enc), ...ringC.map(enc), enc(I), enc(D))
}

function aggCoeffs(
  ringP: EdPoint[],
  ringC: EdPoint[],
  I: EdPoint,
  D: EdPoint,
): { muP: bigint; muC: bigint } {
  const body = ringBytes(ringP, ringC, I, D)
  return { muP: hashToScalar(AGG0, body), muC: hashToScalar(AGG1, body) }
}

export function clsagSign(
  msg: Uint8Array,
  ringP: EdPoint[],
  ringC: EdPoint[],
  p: bigint,
  z: bigint,
  signerIdx: number,
): ClsagSig {
  const n = ringP.length
  const Pπ = ringP[signerIdx]
  const Hpπ = hashToPoint(Pπ)
  const I = edMul(scalarMod(p), Hpπ)
  const D = edMul(scalarMod(z), Hpπ)
  const { muP, muC } = aggCoeffs(ringP, ringC, I, D)
  const Itilde = edPointAdd(edMul(muP, I), edMul(muC, D))
  const w = scalarMod(muP * p + muC * z)
  const aggW = (i: number): EdPoint => edPointAdd(edMul(muP, ringP[i]), edMul(muC, ringC[i]))

  const c = new Array<bigint>(n).fill(0n)
  const s = new Array<bigint>(n).fill(0n)
  const prefix = ringBytes(ringP, ringC, I, D)
  const alpha = randomScalar(q)
  let i = (signerIdx + 1) % n
  // c_{π+1} = H(ring, msg, α·B, α·Hp(P_π))
  c[i] = hashToScalar(ROUND, prefix, msg, enc(edMul(alpha, ED_B)), enc(edMul(alpha, Hpπ)))
  while (i !== signerIdx) {
    s[i] = randomScalar(q)
    const L = edPointAdd(edMul(s[i], ED_B), edMul(c[i], aggW(i))) // s·B + c·W_i
    const R = edPointAdd(edMul(s[i], hashToPoint(ringP[i])), edMul(c[i], Itilde)) // s·Hp(P_i)+c·Ĩ
    const next = (i + 1) % n
    c[next] = hashToScalar(ROUND, prefix, msg, enc(L), enc(R))
    i = next
  }
  s[signerIdx] = scalarMod(alpha - c[signerIdx] * w)
  return { c0: c[0], s, I, D }
}

export function clsagVerify(
  msg: Uint8Array,
  ringP: EdPoint[],
  ringC: EdPoint[],
  sig: ClsagSig,
): boolean {
  const n = ringP.length
  if (sig.s.length !== n || ringC.length !== n) return false
  const { muP, muC } = aggCoeffs(ringP, ringC, sig.I, sig.D)
  const Itilde = edPointAdd(edMul(muP, sig.I), edMul(muC, sig.D))
  const prefix = ringBytes(ringP, ringC, sig.I, sig.D)
  let c = sig.c0
  for (let i = 0; i < n; i++) {
    const W = edPointAdd(edMul(muP, ringP[i]), edMul(muC, ringC[i]))
    const L = edPointAdd(edMul(sig.s[i], ED_B), edMul(c, W))
    const R = edPointAdd(edMul(sig.s[i], hashToPoint(ringP[i])), edMul(c, Itilde))
    c = hashToScalar(ROUND, prefix, msg, enc(L), enc(R))
  }
  return c === sig.c0
}

// ═════════════════════════════════════════════════════════════════════════════
// Stealth addresses — CryptoNote one-time output keys
// ═════════════════════════════════════════════════════════════════════════════
// A recipient publishes two key pairs: view (a, A=a·B) and spend (b, B_s=b·B).
// A sender picks random r, publishes R = r·B, and derives a fresh one-time key
//   P = H(r·A ‖ index)·B + B_s
// that only the recipient can spend. The recipient recovers the shared secret
// from a·R = r·A and the one-time *secret* x = H(a·R ‖ index) + b, with P = x·B.
export interface StealthKeys {
  a: bigint
  A: EdPoint // view public
  b: bigint
  Bs: EdPoint // spend public
}

export function stealthKeygen(): StealthKeys {
  const a = randomScalar(q)
  const b = randomScalar(q)
  return { a, A: mulBase(a), b, Bs: mulBase(b) }
}

const idxBytes = (i: number): Uint8Array => Uint8Array.of(i & 0xff, (i >> 8) & 0xff)

/** Sender: produce the tx public key R and one-time output key P for output `index`. */
export function stealthSend(
  A: EdPoint,
  Bs: EdPoint,
  index = 0,
): { R: EdPoint; P: EdPoint; r: bigint } {
  const r = randomScalar(q)
  const R = mulBase(r)
  const shared = hashToScalar('CryptoNote_derive', enc(edMul(r, A)), idxBytes(index))
  const P = edPointAdd(mulBase(shared), Bs)
  return { R, P, r }
}

/** Recipient: from the tx key R, recover the one-time secret x with x·B = P. */
export function stealthReceive(
  keys: StealthKeys,
  R: EdPoint,
  index = 0,
): { x: bigint; P: EdPoint } {
  const shared = hashToScalar('CryptoNote_derive', enc(edMul(keys.a, R)), idxBytes(index))
  const x = scalarMod(shared + keys.b)
  return { x, P: mulBase(x) }
}
