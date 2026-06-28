// Schnorr adaptor signatures — the cryptographic primitive behind "scriptless
// scripts": atomic swaps, payment channels, and discreet log contracts that look
// like ordinary single signatures on-chain.
//
// An adaptor signature is a *pre-signature* ŝ that is locked to an adaptor point
// T = t·G. On its own ŝ is not a valid signature. But:
//
//   • anyone who knows the secret t can ADAPT ŝ into a valid signature s;
//   • anyone who sees both ŝ and the finished s can EXTRACT t = s − ŝ.
//
// Those two facts chain two transactions together: the moment one party publishes
// their adapted signature on chain A, they leak t, which lets the counterparty
// adapt their own pre-signature and claim on chain B. The swap is atomic, and a
// blockchain observer sees only two perfectly normal Schnorr signatures.
//
// This is schoolbook Schnorr over secp256k1 (full R points, no BIP-340 even-y
// normalization) so the algebra stays transparent — the same construction BIP-340
// uses, minus the x-only bookkeeping.

import { secp256k1, G, N } from './secp256k1'
import { taggedHash } from './secp256k1'
import type { Point } from './curve'
import { mod } from './field'
import { bigToBytes, bytesToBig, concat } from './sha256'
import { randomScalar } from './rng'

/** The point t·G that a pre-signature is locked to. */
export function adaptorPoint(t: bigint): Point {
  return secp256k1.multiply(mod(t, N), G)
}

/** Public key P = d·G. */
export function pubkey(d: bigint): Point {
  return secp256k1.multiply(mod(d, N), G)
}

// Challenge e = H(R̄.x ‖ P.x ‖ m), where R̄ = R + T is the *effective* nonce the
// finished signature will commit to. Binding the challenge to R̄ (not R) is what
// forces the adaptor secret into the final signature.
function challenge(Rbar: Point, P: Point, msg: Uint8Array): bigint {
  if (Rbar === null || P === null) throw new Error('challenge on identity point')
  const h = taggedHash(
    'Curvefield/adaptor',
    concat(bigToBytes(Rbar.x, 32), bigToBytes(P.x, 32), msg),
  )
  return mod(bytesToBig(h), N)
}

export interface PreSignature {
  R: Point // the signer's own nonce point r·G
  shat: bigint // ŝ = r + e·d   (the "adaptor signature")
  T: Point // the adaptor point this pre-signature is locked to
}

export interface FullSignature {
  Rbar: Point // R + T — the nonce point the chain actually sees
  s: bigint
}

/**
 * Create a pre-signature on `msg` under secret key `d`, locked to adaptor point
 * `T`. Uses a fresh random nonce by default; pass one for reproducible demos.
 */
export function preSign(d: bigint, msg: Uint8Array, T: Point, nonce?: bigint): PreSignature {
  const r = nonce === undefined ? randomScalar(N) : mod(nonce, N)
  const R = secp256k1.multiply(r, G)
  const Rbar = secp256k1.add(R, T)
  const P = pubkey(d)
  const e = challenge(Rbar, P, msg)
  const shat = mod(r + e * mod(d, N), N)
  return { R, shat, T }
}

/**
 * Verify a pre-signature without knowing t: it proves ŝ·G = R + e·P, i.e. the
 * pre-signature is a correct "almost-signature" that only needs +t to finish.
 */
export function preVerify(P: Point, msg: Uint8Array, pre: PreSignature): boolean {
  const { R, shat, T } = pre
  if (shat <= 0n || shat >= N) return false
  const Rbar = secp256k1.add(R, T)
  const e = challenge(Rbar, P, msg)
  const lhs = secp256k1.multiply(shat, G)
  const rhs = secp256k1.add(R, secp256k1.multiply(e, P))
  return lhs !== null && rhs !== null && lhs.x === rhs.x && lhs.y === rhs.y
}

/** Adapt a pre-signature into a finished signature using the secret t. */
export function adapt(pre: PreSignature, t: bigint): FullSignature {
  return { Rbar: secp256k1.add(pre.R, pre.T), s: mod(pre.shat + mod(t, N), N) }
}

/** Verify a finished signature the way an ordinary Schnorr verifier would. */
export function verifyFull(P: Point, msg: Uint8Array, sig: FullSignature): boolean {
  const { Rbar, s } = sig
  if (s <= 0n || s >= N) return false
  const e = challenge(Rbar, P, msg)
  const lhs = secp256k1.multiply(s, G)
  const rhs = secp256k1.add(Rbar, secp256k1.multiply(e, P))
  return lhs !== null && rhs !== null && lhs.x === rhs.x && lhs.y === rhs.y
}

/** Recover the adaptor secret from a pre-signature and the finished signature. */
export function extract(pre: PreSignature, sig: FullSignature): bigint {
  return mod(sig.s - pre.shat, N)
}

// ── A full atomic swap, run end to end ───────────────────────────────────────

export interface SwapTrace {
  t: bigint
  T: Point
  // Alice pays Bob (tx_A), signed by Alice's key; Bob pays Alice (tx_B), signed by Bob.
  alice: { d: bigint; P: Point }
  bob: { d: bigint; P: Point }
  preA: PreSignature // Alice's pre-signature on tx_A, locked to T
  preB: PreSignature // Bob's pre-signature on tx_B, locked to T
  preAok: boolean
  preBok: boolean
  // Step 1: Alice (who knows t) adapts Bob's pre-sig to claim tx_B and broadcasts it.
  sigB: FullSignature
  sigBok: boolean
  // Step 2: Bob sees sigB on chain, extracts t, adapts Alice's pre-sig to claim tx_A.
  tRecovered: bigint
  extractedOk: boolean
  sigA: FullSignature
  sigAok: boolean
  atomic: boolean
}

/**
 * Walk a complete scriptless atomic swap and return every intermediate value so
 * the UI can narrate it. Both legs are locked to one adaptor point T = t·G;
 * Alice claiming her leg unavoidably reveals t, which lets Bob claim his.
 */
export function runAtomicSwap(
  tSecret: bigint,
  aliceKey: bigint,
  bobKey: bigint,
  txA: Uint8Array,
  txB: Uint8Array,
  nonceA?: bigint,
  nonceB?: bigint,
): SwapTrace {
  const t = mod(tSecret, N)
  const T = adaptorPoint(t)
  const aP = pubkey(aliceKey)
  const bP = pubkey(bobKey)

  // Each party pre-signs the transaction that pays the other, locked to T.
  const preA = preSign(aliceKey, txA, T, nonceA) // Alice → Bob
  const preB = preSign(bobKey, txB, T, nonceB) // Bob → Alice
  const preAok = preVerify(aP, txA, preA)
  const preBok = preVerify(bP, txB, preB)

  // Step 1 — Alice knows t, so she completes Bob's pre-signature and claims tx_B.
  const sigB = adapt(preB, t)
  const sigBok = verifyFull(bP, txB, sigB)

  // Step 2 — sigB is now public. Bob extracts t and completes Alice's pre-sig.
  const tRecovered = extract(preB, sigB)
  const extractedOk = tRecovered === t
  const sigA = adapt(preA, tRecovered)
  const sigAok = verifyFull(aP, txA, sigA)

  return {
    t,
    T,
    alice: { d: aliceKey, P: aP },
    bob: { d: bobKey, P: bP },
    preA,
    preB,
    preAok,
    preBok,
    sigB,
    sigBok,
    tRecovered,
    extractedOk,
    sigA,
    sigAok,
    atomic: preAok && preBok && sigBok && extractedOk && sigAok,
  }
}
