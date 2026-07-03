// A Wesolowski VERIFIABLE DELAY FUNCTION over the class group of an imaginary
// quadratic order — proof-of-sequential-time with NO trusted setup.
//
// The construction is the same shape as the RSA-group VDF in ./vdf.ts, but the
// group of unknown order is now Cl(Δ) (see ./classgroup.ts) instead of (ℤ/N)*.
// That single change removes the trapdoor: there is no φ(N) to know, because the
// group order h(Δ) is a public discriminant's well-guarded secret that even its
// creator must run a subexponential algorithm to learn. This is the exact engine
// under Chia's proof-of-time.
//
//     y = g^(2^T)             (T sequential squarings in Cl(Δ) — the delay)
//
// Squaring a class-group element is a fixed handful of BigInt operations
// (compose + reduce), and reduction keeps the form's coordinates bounded by
// ~√|Δ| forever, so the per-step cost is constant no matter how large T grows.
//
// Wesolowski's proof certifies y = g^(2^T) with a SINGLE group element:
//   ℓ  = Hprime(Δ ‖ g ‖ y ‖ T)     a ~128-bit Fiat–Shamir prime
//   q  = ⌊2^T / ℓ⌋,  r = 2^T mod ℓ
//   π  = g^q
// and the verifier checks  π^ℓ ∘ g^r = y  in two class-group exponentiations —
// O(1) work, independent of T. Everything is native BigInt and cross-checked on
// the Self-Test page (roundtrip, streaming-prover equivalence, and rejection of
// forged π / mauled y / wrong T).

import type { Form } from './classgroup'
import { compose, square, power, identity, formEq, primeForm, generateDiscriminant, serializeForm, isqrt, bitLength } from './classgroup'
import { hashToPrime, isProbablePrime } from './vdf'
import { modPow } from './field'
import { sha256, concat, utf8, bigToBytes } from './sha256'

export type { Form } from './classgroup'
export { isProbablePrime } from './vdf'

// ── A default, nothing-up-my-sleeve discriminant + generator ────────────────
// Derived from a fixed public seed so anyone can reproduce and audit it. 256-bit
// for a snappy in-browser demo; a production beacon uses ≥ 1024-bit |Δ|.
export const CG = (() => {
  const D = generateDiscriminant(utf8('curvefield/class-group/v1'), 256)
  const g = primeForm(D)
  return { D, g }
})()

// ── The delay: y = g^(2^T) by T sequential squarings ────────────────────────
/** Honest evaluation — T squarings in Cl(Δ), the work no shortcut can avoid. */
export function evalVDF(g: Form, T: number, D: bigint): Form {
  let y = g
  for (let i = 0; i < T; i++) y = square(y, D)
  return y
}

// ── Fiat–Shamir: hash (Δ, g, y, T) to a ~128-bit prime ℓ ────────────────────
export function wesolowskiChallenge(D: bigint, g: Form, y: Form, T: number, bits = 128): bigint {
  const seed = concat(
    utf8('curvefield/cg-vdf/' + T),
    serializeForm(g, D),
    serializeForm(y, D),
    bigToBytes(BigInt(T), 8),
  )
  return hashToPrime(sha256(seed), bits)
}

export interface CgProof {
  ell: bigint // the Fiat–Shamir prime challenge
  pi: Form // π = g^⌊2^T/ℓ⌋
}

/**
 * Prove y = g^(2^T). Forms 2^T as a big integer, so it is the simple reference
 * prover (fine for the demo's bounded T); the streaming prover below avoids it.
 */
export function wesolowskiProve(g: Form, T: number, D: bigint, y?: Form): CgProof {
  const Y = y ?? evalVDF(g, T, D)
  const ell = wesolowskiChallenge(D, g, Y, T)
  const twoT = 1n << BigInt(T)
  const q = twoT / ell
  return { ell, pi: power(g, q, D) }
}

/**
 * Streaming prover — the same π = g^⌊2^T/ℓ⌋ in O(1) memory, WITHOUT ever forming
 * the T-bit integer 2^T. Track rᵢ = 2^i mod ℓ; the i-th quotient bit is
 * bᵢ = ⌊2·rᵢ₋₁/ℓ⌋ ∈ {0,1}, and π accumulates as π ← π²·g^bᵢ. The exponent
 * telescopes to exactly ⌊2^T/ℓ⌋. Two O(T) passes, constant extra space — the
 * trick that makes Wesolowski practical for the huge T a real VDF uses.
 */
export function wesolowskiProveStreaming(g: Form, T: number, D: bigint, y?: Form): CgProof {
  const Y = y ?? evalVDF(g, T, D)
  const ell = wesolowskiChallenge(D, g, Y, T)
  let pi = identity(D)
  let r = 1n
  for (let i = 0; i < T; i++) {
    const rp = r << 1n
    const bit = rp >= ell
    r = bit ? rp - ell : rp
    pi = square(pi, D)
    if (bit) pi = compose(pi, g, D)
  }
  return { ell, pi }
}

/** Verify with two class-group exponentiations: π^ℓ ∘ g^r = y, r = 2^T mod ℓ. */
export function wesolowskiVerify(g: Form, y: Form, T: number, D: bigint, proof: CgProof): boolean {
  const ell = wesolowskiChallenge(D, g, y, T)
  if (ell !== proof.ell) return false // ℓ is bound to (g, y, T); a mismatch is a forgery
  if (!isProbablePrime(proof.ell)) return false
  const r = modPow(2n, BigInt(T), ell)
  const lhs = compose(power(proof.pi, ell, D), power(g, r, D), D)
  return formEq(lhs, y)
}

// ── A delay-based randomness beacon in the class group ──────────────────────
// βᵢ₊₁ = SHA256(VDF(βᵢ)). Each round is unpredictable until someone spends T
// sequential steps and unbiasable — trying many seeds costs the full delay each
// time. The RANDAO+VDF beacon shape, now with no trusted setup underneath.
export interface CgBeaconRound {
  input: Form
  output: Form
  beta: Uint8Array
  proof: CgProof
  verified: boolean
}

/** Map arbitrary bytes to a class-group element (a fresh prime form perturbation). */
export function hashToForm(bytes: Uint8Array, D: bigint, base: Form): Form {
  // Deterministically pick an exponent from the hash and raise the base to it;
  // stays inside the (unknown-order) subgroup ⟨base⟩ and needs no root-finding.
  const h = sha256(concat(utf8('curvefield/cg-vdf/h2f'), bytes))
  let e = 0n
  for (const byte of h) e = (e << 8n) | BigInt(byte)
  return power(base, (e % (1n << 64n)) + 2n, D)
}

export function beaconChain(seed: Uint8Array, T: number, D: bigint, base: Form, rounds: number): CgBeaconRound[] {
  const out: CgBeaconRound[] = []
  let current = sha256(concat(utf8('curvefield/cg-vdf/beacon-seed'), seed))
  for (let i = 0; i < rounds; i++) {
    const input = hashToForm(current, D, base)
    const output = evalVDF(input, T, D)
    const proof = wesolowskiProve(input, T, D, output)
    const verified = wesolowskiVerify(input, output, T, D, proof)
    const beta = sha256(concat(utf8('curvefield/cg-vdf/beacon-out'), serializeForm(output, D)))
    out.push({ input, output, beta, proof, verified })
    current = beta
  }
  return out
}

// A couple of tiny re-exports the UI leans on.
export { isqrt, bitLength }
