// KZG polynomial commitments (Kate–Zaverucha–Goldberg, 2010) on BLS12-381.
//
// A KZG commitment squeezes an entire polynomial f of degree up to d into a
// *single* group element C = f(τ)·G₁, and later lets the prover convince a
// verifier that "f(z) = y" with a *constant-size* proof — one more group element
// — checked by a single pairing equation. Constant commitment, constant proof,
// constant verification, regardless of the polynomial's degree. This is the
// engine under PLONK, Marlin, and Ethereum's EIP-4844 blob transactions.
//
// The magic ingredient is a **structured reference string** (the "powers of τ"):
// a secret scalar τ is chosen, the points [τⁱ]₁ = τⁱ·G₁ and [τ]₂ = τ·G₂ are
// published, and τ itself is destroyed (the "toxic waste" — anyone who keeps it
// can forge proofs). The prover can then evaluate any committed polynomial *at
// the unknown τ* purely from the public powers, without knowing τ.
//
// The opening proof rests on one polynomial fact: f(z) = y iff (X − z) divides
// f(X) − y exactly. The quotient q(X) = (f(X) − y)/(X − z) is committed as the
// proof W = q(τ)·G₁, and the verifier checks the identity f(τ) − y = q(τ)·(τ − z)
// *in the exponent* via the pairing
//
//        e(C − [y]₁, [1]₂)  =  e(W, [τ]₂ − [z]₂).
//
// Built entirely on the from-scratch BLS12-381 pairing already in this engine.

import {
  G1_GEN,
  G2_GEN,
  R,
  g1,
  g2,
  pairing,
  pairingProduct,
  type G1,
  type G2,
} from './bls12381'
import { Fp12 } from './fp12'
import { evaluate, divmod, sub as polySub, type Poly } from './polynomial'
import { sha256, concat, bigToBytes, bytesToBig } from './sha256'
import { mod } from './field'

/** The trusted-setup output: powers of τ in G₁ (up to maxDegree) and τ in G₂.
 *  `tau` is the toxic waste — present here only so the lab can *show* the setup;
 *  a real ceremony destroys it. */
export interface SRS {
  maxDegree: number
  powG1: G1[] // [τ⁰·G₁, τ¹·G₁, …, τ^d·G₁]
  g2: G2 // [1]₂ = G₂
  tauG2: G2 // [τ]₂ = τ·G₂
  tau: bigint // toxic waste (destroy after setup!)
}

/** Run a (single-party, for the lab) powers-of-τ ceremony. */
export function setup(maxDegree: number, tau: bigint): SRS {
  const t = mod(tau, R)
  const powG1: G1[] = []
  let acc = 1n
  for (let i = 0; i <= maxDegree; i++) {
    powG1.push(g1.mul(acc, G1_GEN))
    acc = mod(acc * t, R)
  }
  return { maxDegree, powG1, g2: G2_GEN, tauG2: g2.mul(t, G2_GEN), tau: t }
}

const g2sub = (A: G2, B: G2): G2 => g2.add(A, g2.neg(B))

/** Commit to a polynomial: C = Σ fᵢ·[τⁱ]₁ = f(τ)·G₁. The prover never learns τ —
 *  it only combines the public SRS powers. */
export function commit(srs: SRS, poly: Poly): G1 {
  if (poly.length > srs.powG1.length) throw new Error('polynomial degree exceeds SRS')
  let C: G1 = null
  for (let i = 0; i < poly.length; i++) {
    if (poly[i] === 0n) continue
    C = g1.add(C, g1.mul(mod(poly[i], R), srs.powG1[i]))
  }
  return C
}

export interface Opening {
  z: bigint // the evaluation point
  y: bigint // the claimed value f(z)
  W: G1 // the proof = q(τ)·G₁
}

/** Produce an evaluation proof that f(z) = y. Computes the quotient
 *  q(X) = (f(X) − y)/(X − z) — which divides exactly precisely because z is a
 *  root of f(X) − y — and commits to it. */
export function open(srs: SRS, poly: Poly, z: bigint): Opening {
  const zz = mod(z, R)
  const y = evaluate(poly, zz, R)
  // numerator = f(X) − y;  denominator = (X − z).
  const numer = polySub(poly, [y], R)
  const { q, r } = divmod(numer, [mod(-zz, R), 1n], R)
  if (r.length !== 0) throw new Error('non-exact division (z is not a root of f−y)') // never happens
  return { z: zz, y, W: commit(srs, q) }
}

/** Verify an opening against a commitment via the pairing identity
 *  e(C − [y]₁, [1]₂) = e(W, [τ]₂ − [z]₂), evaluated as a single product so only
 *  one final exponentiation runs. */
export function verify(srs: SRS, C: G1, op: Opening): boolean {
  const Cy = g1.add(C, g1.neg(g1.mul(op.y, G1_GEN))) // C − [y]₁
  const tauMinusZ = g2sub(srs.tauG2, g2.mul(op.z, G2_GEN)) // [τ]₂ − [z]₂
  // e(C−[y], [1]) · e(W, [z]−[τ]) = 1  ⇔  e(C−[y],[1]) = e(W,[τ]−[z]).
  const prod = pairingProduct([
    { p: Cy, q: G2_GEN },
    { p: g1.neg(op.W), q: tauMinusZ },
  ])
  return Fp12.eq(prod, Fp12.ONE)
}

/** The additive homomorphism: Commit(f + g) = Commit(f) + Commit(g). Returned as
 *  a boolean the lab can assert live. */
export function homomorphismHolds(srs: SRS, f: Poly, gp: Poly): boolean {
  const sum: Poly = []
  const n = Math.max(f.length, gp.length)
  for (let i = 0; i < n; i++) sum.push(mod((f[i] ?? 0n) + (gp[i] ?? 0n), R))
  const lhs = commit(srs, sum)
  const rhs = g1.add(commit(srs, f), commit(srs, gp))
  return g1.eq(lhs, rhs)
}

// ── Batch verification ───────────────────────────────────────────────────────
//
// Re-arranging the single-opening check gives the pairing-free-of-z form
//
//     e(Cⱼ − yⱼ·G₁ + zⱼ·Wⱼ, [1]₂) = e(Wⱼ, [τ]₂),
//
// whose left/right G₁ arguments are *linear* in the opening, so m independent
// openings collapse into one pairing equation by a random linear combination
// with coefficients γⱼ (Fiat–Shamir, so no interaction). This is exactly how
// production KZG verifiers check thousands of proofs in one shot.

export interface BatchItem {
  C: G1
  op: Opening
}

/** Deterministic batching coefficients γⱼ = H(j ‖ transcript) mod r. */
function batchGammas(items: BatchItem[]): bigint[] {
  const transcript = concat(
    ...items.flatMap(({ C, op }) => [
      bigToBytes(C === null ? 0n : C.x, 48),
      bigToBytes(op.z, 32),
      bigToBytes(op.y, 32),
      bigToBytes(op.W === null ? 0n : op.W.x, 48),
    ]),
  )
  return items.map((_, j) =>
    mod(bytesToBig(sha256(concat(new Uint8Array([j & 0xff]), transcript))), R) || 1n,
  )
}

/** Verify m openings (possibly against different commitments) with a single
 *  multi-pairing. Equivalent to checking each individually, but one final
 *  exponentiation instead of m. */
export function batchVerify(srs: SRS, items: BatchItem[]): boolean {
  if (items.length === 0) return true
  const gammas = batchGammas(items)
  let lhsG1: G1 = null // Σ γⱼ (Cⱼ − yⱼ·G₁ + zⱼ·Wⱼ)
  let rhsG1: G1 = null // Σ γⱼ Wⱼ
  items.forEach(({ C, op }, j) => {
    const term = g1.add(
      g1.add(C, g1.neg(g1.mul(op.y, G1_GEN))),
      g1.mul(op.z, op.W),
    )
    lhsG1 = g1.add(lhsG1, g1.mul(gammas[j], term))
    rhsG1 = g1.add(rhsG1, g1.mul(gammas[j], op.W))
  })
  // e(lhsG1, [1]₂) = e(rhsG1, [τ]₂)  ⇔  e(lhsG1,[1]) · e(−rhsG1,[τ]) = 1.
  const prod = pairingProduct([
    { p: lhsG1, q: G2_GEN },
    { p: g1.neg(rhsG1), q: srs.tauG2 },
  ])
  return Fp12.eq(prod, Fp12.ONE)
}

/** Convenience for the lab's bilinearity sanity check: the raw pairing of the
 *  generators (a fixed element of order r in F_{p¹²}). */
export function pairGenerators(): ReturnType<typeof pairing> {
  return pairing(G1_GEN, G2_GEN)
}
