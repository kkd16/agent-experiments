// BLS signatures, the IRTF standard scheme (draft-irtf-cfrg-bls-signature) on
// top of the from-scratch pairing and the RFC 9380 hash-to-curve. This is the
// "minimal-signature-size" ciphersuite — signatures live in 𝔾₁ (48 bytes), keys
// in 𝔾₂ — that secures Ethereum's consensus, Filecoin, Chia and Drand.
//
// Three pieces make it a real implementation rather than a toy:
//   • KeyGen derives the secret key from key material with HKDF (RFC 5869),
//     exactly as the draft specifies, so a 32-byte seed yields a standard key.
//   • Signing hashes the message into 𝔾₁ with the ciphersuite's domain tag, so
//     the wire bytes match every other conformant library (pinned to a vector).
//   • Proof-of-possession (PoP) closes the rogue-key hole that lets fast
//     aggregate verification (one message, summed keys) stay safe.

import { mod } from './field'
import { Fp12 } from './fp12'
import { concat, sha256, hmacSha256, utf8, bytesToBig } from './sha256'
import {
  G2_GEN,
  R,
  g1,
  g2,
  pairingProduct,
  type G1,
  type G2,
} from './bls12381'
import { hashToCurveG1 } from './hash2curve'
import { compressG1, compressG2 } from './blsenc'

// ── ciphersuite domain-separation tags (minimal-signature-size) ───────────────

/** Basic scheme: messages must be distinct across an aggregate. */
export const DST_BASIC = utf8('BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_')
/** Proof-of-possession scheme: the message DST. */
export const DST_POP_SIG = utf8('BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_')
/** Proof-of-possession scheme: the PoP-proof DST (a separate tag, by design). */
export const DST_POP_PROOF = utf8('BLS_POP_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_')

// ── HKDF-SHA256 (RFC 5869) ────────────────────────────────────────────────────

export function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Uint8Array {
  return hmacSha256(salt, ikm)
}

export function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  const out: Uint8Array[] = []
  let t: Uint8Array = new Uint8Array(0)
  const n = Math.ceil(length / 32)
  for (let i = 1; i <= n; i++) {
    t = hmacSha256(prk, concat(t, info, new Uint8Array([i])))
    out.push(t)
  }
  return concat(...out).slice(0, length)
}

// ── KeyGen (draft-irtf-cfrg-bls-signature §2.3) ───────────────────────────────

/** L = ceil((3·ceil(log2 r)) / 16) = 48 for BLS12-381. */
const KEYGEN_L = 48

/**
 * Derive a secret scalar from input key material (≥ 32 bytes of entropy) with
 * the salted HKDF construction from the BLS signature draft. Deterministic:
 * the same IKM always yields the same key.
 */
export function keyGen(ikm: Uint8Array, keyInfo: Uint8Array = new Uint8Array(0)): bigint {
  if (ikm.length < 32) throw new Error('IKM must be at least 32 bytes')
  let salt = utf8('BLS-SIG-KEYGEN-SALT-')
  let sk = 0n
  const l2 = new Uint8Array([(KEYGEN_L >> 8) & 0xff, KEYGEN_L & 0xff])
  while (sk === 0n) {
    salt = sha256(salt)
    const prk = hkdfExtract(salt, concat(ikm, new Uint8Array([0])))
    const okm = hkdfExpand(prk, concat(keyInfo, l2), KEYGEN_L)
    sk = mod(bytesToBig(okm), R)
  }
  return sk
}

/** SkToPk: the public key for a minimal-signature-size scheme lives in 𝔾₂. */
export function skToPk(sk: bigint): G2 {
  return g2.mul(mod(sk, R), G2_GEN)
}

// ── Core sign / verify (RFC draft §2.6–2.7) ───────────────────────────────────

/** CoreSign: σ = sk · H(m) ∈ 𝔾₁ with the ciphersuite domain tag. */
export function coreSign(sk: bigint, msg: Uint8Array, dst: Uint8Array): G1 {
  return g1.mul(mod(sk, R), hashToCurveG1(msg, dst))
}

/** CoreVerify: e(σ, G₂) ?= e(H(m), pk). */
export function coreVerify(pk: G2, msg: Uint8Array, sig: G1, dst: Uint8Array): boolean {
  if (pk === null) return false
  const H = hashToCurveG1(msg, dst)
  // e(σ, G₂) · e(H, −pk) ?= 1, one final exponentiation.
  const f = pairingProduct([
    { p: sig, q: G2_GEN },
    { p: H, q: g2.neg(pk) },
  ])
  return Fp12.isOne(f)
}

// Public basic-scheme wrappers.
export const sign = (sk: bigint, msg: Uint8Array): G1 => coreSign(sk, msg, DST_BASIC)
export const verify = (pk: G2, msg: Uint8Array, sig: G1): boolean =>
  coreVerify(pk, msg, sig, DST_BASIC)

// ── aggregation ───────────────────────────────────────────────────────────────

export function aggregate(sigs: G1[]): G1 {
  let acc: G1 = null
  for (const s of sigs) acc = g1.add(acc, s)
  return acc
}

/** AggregateVerify over distinct messages: ∏ e(H(mᵢ), pkᵢ) ?= e(σ, G₂). */
export function aggregateVerify(pks: G2[], msgs: Uint8Array[], aggSig: G1): boolean {
  if (pks.length !== msgs.length || pks.length === 0) return false
  // Distinct-message requirement of the basic scheme.
  const seen = new Set(msgs.map((m) => [...m].join(',')))
  if (seen.size !== msgs.length) return false
  const pairs = msgs.map((m, i) => ({ p: hashToCurveG1(m, DST_BASIC), q: pks[i] }))
  pairs.push({ p: g1.neg(aggSig), q: G2_GEN })
  return Fp12.isOne(pairingProduct(pairs))
}

/** FastAggregateVerify: one common message, public keys summed. Needs PoP. */
export function fastAggregateVerify(pks: G2[], msg: Uint8Array, aggSig: G1): boolean {
  let aggPk: G2 = null
  for (const k of pks) aggPk = g2.add(aggPk, k)
  return coreVerify(aggPk, msg, aggSig, DST_POP_SIG)
}

// ── proof of possession (closes the rogue-key attack) ─────────────────────────

/** PopProve: a signature over the public key itself, under a distinct DST. */
export function popProve(sk: bigint): G1 {
  const pkBytes = compressG2(skToPk(sk))
  return g1.mul(mod(sk, R), hashToCurveG1(pkBytes, DST_POP_PROOF))
}

/** PopVerify: e(proof, G₂) ?= e(H(pk), pk). */
export function popVerify(pk: G2, proof: G1): boolean {
  if (pk === null) return false
  const H = hashToCurveG1(compressG2(pk), DST_POP_PROOF)
  const f = pairingProduct([
    { p: proof, q: G2_GEN },
    { p: H, q: g2.neg(pk) },
  ])
  return Fp12.isOne(f)
}

/** Convenience: the compressed wire bytes of a key / signature. */
export const pkBytes = (pk: G2): Uint8Array => compressG2(pk)
export const sigBytes = (sig: G1): Uint8Array => compressG1(sig)

// A small helper for the UI: a deterministic IKM from a label.
export function ikmFromLabel(label: string): Uint8Array {
  return sha256(concat(utf8('curvefield-ikm:'), utf8(label)))
}
