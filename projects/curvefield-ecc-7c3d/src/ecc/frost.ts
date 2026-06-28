// FROST — Flexible Round-Optimized Schnorr Threshold signatures
// (Komlo & Goldberg, the construction standardised in RFC 9591).
//
// A group of n parties holds a *shared* secret key x — split with Shamir, so no
// single party ever sees x — yet any t of them can jointly produce a single
// 64-byte Schnorr signature that verifies under one group public key X = x·G.
// The verifier runs the **ordinary, unmodified BIP-340 `schnorrVerify`** and
// cannot tell a 3-of-5 FROST signature from an everyday single-signer one. This
// is the threshold scheme behind modern custody and the FROST Bitcoin wallets.
//
// This module is the *trusted-dealer* variant: a dealer runs Shamir once to hand
// out the key shares (a real deployment replaces this with a distributed key
// generation, but the signing protocol below is identical). Signing is two
// rounds:
//
//   Round 1  each signer i publishes nonce commitments (Dᵢ, Eᵢ) = (dᵢ·G, eᵢ·G).
//   Round 2  given the message and the set S of signers, everyone derives the
//            *binding factors* ρᵢ = H(i, m, B) — the FROST innovation that binds
//            each nonce to the whole commitment set B and defeats the
//            Drijvers/ROS attack on naive two-round threshold Schnorr — forms the
//            group nonce R = Σ (Dᵢ + ρᵢ·Eᵢ), and each signer returns a partial
//
//                 zᵢ = (dᵢ + ρᵢ·eᵢ) + c·λᵢ·xᵢ ,
//
//            weighted by its Lagrange coefficient λᵢ. The partials sum to a valid
//            Schnorr scalar. BIP-340's even-Y conventions are handled exactly as
//            in the MuSig2 lab (the gx / gr parity fixes).

import { secp256k1, G, N, taggedHash } from './secp256k1'
import { type Point } from './curve'
import { mod } from './field'
import { concat, bigToBytes, bytesToBig } from './sha256'
import { lagrangeWeights } from './polynomial'
import { split, type Share, type SharingResult } from './shamir'
import { randomScalar } from './rng'

const ser = (Q: Point): Uint8Array => {
  // 33-byte compressed encoding, used inside the binding-factor hash.
  if (Q === null) return new Uint8Array(33)
  const out = new Uint8Array(33)
  out[0] = Q.y % 2n === 0n ? 0x02 : 0x03
  out.set(bigToBytes(Q.x, 32), 1)
  return out
}

const eq = (A: Point, B: Point) =>
  (A === null && B === null) || (A !== null && B !== null && A.x === B.x && A.y === B.y)

export interface KeyShares {
  groupPubXonly: bigint // the BIP-340 x-only group key
  groupPub: Point // X = x·G (may have odd y)
  shares: Share[] // (i, xᵢ) for each party
  publicShares: Map<string, Point> // i ↦ Xᵢ = xᵢ·G, for partial verification
  commitments: Point[] // Feldman commitments (so shares are verifiable)
  dealer: SharingResult // the full Shamir result (secret kept for the demo)
}

/** Trusted-dealer key generation: pick a random group secret, Shamir-split it
 *  into a t-of-n sharing, and publish the group key + per-party public shares. */
export function keygen(t: number, n: number, secret?: bigint): KeyShares {
  const x = secret !== undefined ? mod(secret, N) : randomScalar(N) || 1n
  const dealer = split(x, t, n)
  const groupPub = dealer.commitments[0]
  if (groupPub === null) throw new Error('group key is the identity')
  const publicShares = new Map<string, Point>()
  for (const sh of dealer.shares) publicShares.set(sh.i.toString(), secp256k1.multiply(sh.y, G))
  return {
    groupPubXonly: groupPub.x,
    groupPub,
    shares: dealer.shares,
    publicShares,
    commitments: dealer.commitments,
    dealer,
  }
}

export interface NonceCommit {
  i: bigint // signer index
  d: bigint // hiding nonce (secret)
  e: bigint // binding nonce (secret)
  D: Point // dᵢ·G
  E: Point // eᵢ·G
}

/** Round 1: a signer draws two fresh nonces and publishes their commitments.
 *  (Secret nonces are kept here so the lab can replay round 2; never reuse a
 *  nonce across messages in a real run.) */
export function commitNonces(i: bigint): NonceCommit {
  const d = randomScalar(N) || 1n
  const e = randomScalar(N) || 1n
  return { i, d, e, D: secp256k1.multiply(d, G), E: secp256k1.multiply(e, G) }
}

/** The encoding B of the round-1 commitment set, hashed into every binding
 *  factor so each signer's nonce is committed to the whole group's nonces. */
function encodeCommitList(commits: NonceCommit[]): Uint8Array {
  return concat(...commits.map((c) => concat(bigToBytes(c.i, 32), ser(c.D), ser(c.E))))
}

/** Binding factor ρᵢ = H("FROST/binding", i ‖ m ‖ B) mod n. */
export function bindingFactor(i: bigint, msg: Uint8Array, B: Uint8Array): bigint {
  return mod(bytesToBig(taggedHash('FROST/binding', concat(bigToBytes(i, 32), msg, B))), N) || 1n
}

export interface Partial {
  i: bigint
  rho: bigint // binding factor ρᵢ
  lambda: bigint // Lagrange weight λᵢ for the signing set
  z: bigint // the partial signature scalar
}

export interface FrostSignature {
  Rx: bigint
  z: bigint
  R: Point // group nonce (even-y, BIP-340)
  c: bigint // challenge
  sig: Uint8Array // 64-byte BIP-340 signature Rx ‖ z
  partials: Partial[]
  gx: bigint // +1 / −1 parity fix on the group key
  gr: bigint // +1 / −1 parity fix on the group nonce
}

/** Round 2: combine the chosen signers' nonce commitments and key shares into a
 *  single BIP-340 signature on `msg`. `signers` are the (commitment, share)
 *  pairs of the t participants doing the signing. */
export function sign(
  keys: KeyShares,
  signers: { commit: NonceCommit; share: Share }[],
  msg: Uint8Array,
): FrostSignature {
  const commits = signers.map((s) => s.commit)
  const B = encodeCommitList(commits)
  const Xx = keys.groupPubXonly

  // Lagrange weights λᵢ at 0 for exactly this signing set (over F_n).
  const xs = signers.map((s) => s.share.i)
  const lambdas = lagrangeWeights(xs, 0n, N)

  // Group nonce R = Σ (Dᵢ + ρᵢ·Eᵢ).
  const rhos = commits.map((c) => bindingFactor(c.i, msg, B))
  let Rraw: Point = null
  for (let k = 0; k < commits.length; k++) {
    const c = commits[k]
    Rraw = secp256k1.add(Rraw, secp256k1.add(c.D, secp256k1.multiply(rhos[k], c.E)))
  }
  if (Rraw === null) throw new Error('group nonce is the identity')

  // BIP-340 parity fixes: force R and X to even y.
  const gr = Rraw.y % 2n === 0n ? 1n : N - 1n
  const R = gr === 1n ? Rraw : secp256k1.negate(Rraw)
  const Rx = (R as { x: bigint }).x
  const gx = (keys.groupPub as { y: bigint }).y % 2n === 0n ? 1n : N - 1n

  // Challenge c = H(Rx ‖ Xx ‖ m).
  const c = mod(
    bytesToBig(taggedHash('BIP0340/challenge', concat(bigToBytes(Rx, 32), bigToBytes(Xx, 32), msg))),
    N,
  )

  // Partial signatures zᵢ = gr·(dᵢ + ρᵢ·eᵢ) + c·λᵢ·gx·xᵢ.
  const partials: Partial[] = signers.map((s, k) => {
    const nonceTerm = mod(gr * mod(s.commit.d + rhos[k] * s.commit.e, N), N)
    const keyTerm = mod(((c * lambdas[k]) % N) * ((gx * s.share.y) % N), N)
    return { i: s.share.i, rho: rhos[k], lambda: lambdas[k], z: mod(nonceTerm + keyTerm, N) }
  })

  const z = partials.reduce((acc, p) => mod(acc + p.z, N), 0n)
  const sig = concat(bigToBytes(Rx, 32), bigToBytes(z, 32))
  return { Rx, z, R, c, sig, partials, gx, gr }
}

/** Verify one signer's partial in isolation: zᵢ·G ?= gr·(Dᵢ + ρᵢ·Eᵢ) + c·λᵢ·gx·Xᵢ.
 *  An honest aggregator runs this so a single faulty signer can be identified
 *  rather than silently spoiling the whole signature. */
export function verifyPartial(
  keys: KeyShares,
  sig: FrostSignature,
  signer: { commit: NonceCommit; share: Share },
  partial: Partial,
): boolean {
  const Xi = keys.publicShares.get(signer.share.i.toString())
  if (Xi === undefined) return false
  const RiEffRaw = secp256k1.add(signer.commit.D, secp256k1.multiply(partial.rho, signer.commit.E))
  const RiEff = sig.gr === 1n ? RiEffRaw : secp256k1.negate(RiEffRaw)
  const lhs = secp256k1.multiply(partial.z, G)
  const keyCoeff = mod(((sig.c * partial.lambda) % N) * sig.gx, N)
  const rhs = secp256k1.add(RiEff, secp256k1.multiply(keyCoeff, Xi))
  return eq(lhs, rhs)
}
