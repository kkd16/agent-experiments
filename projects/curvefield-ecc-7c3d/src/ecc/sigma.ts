// Σ-protocols, Pedersen commitments, and a range proof — the grammar of
// zero-knowledge, built from the secp256k1 group and made non-interactive with
// the Fiat–Shamir heuristic (replace the verifier's random challenge with a hash
// of the transcript, and an interactive proof becomes a signature-like object
// anyone can check offline).
//
// What's here:
//   • A second generator H with *unknown* discrete log to G (a NUMS point hashed
//     onto the curve), so a Pedersen commitment Com(m,r)=m·G+r·H perfectly hides
//     m yet binds the committer to it.
//   • Schnorr PoK — prove you know x with P = x·G, revealing nothing about x.
//   • Chaum–Pedersen — prove two points share a discrete log (log_G P = log_H Q),
//     the workhorse of verifiable encryption, VRFs and DLEQ proofs.
//   • A 1-of-2 OR-proof — prove a commitment opens to 0 *or* 1 without saying
//     which (a "bit proof").
//   • A range proof — prove a committed value lies in [0, 2ⁿ) by committing to its
//     bits and OR-proving each is a bit; the same bit-decomposition idea Bulletproofs
//     compresses, here in its plain linear-size form.
//
// All challenges are bound to the full statement, so none of these proofs can be
// replayed against a different statement.

import { secp256k1, G, N, taggedHash } from './secp256k1'
import { type Point } from './curve'
import { mod, modSqrt } from './field'
import { concat, bigToBytes, bytesToBig } from './sha256'
import { randomScalar } from './rng'

const ser = (Q: Point): Uint8Array => {
  if (Q === null) return new Uint8Array(33)
  const out = new Uint8Array(33)
  out[0] = Q.y % 2n === 0n ? 0x02 : 0x03
  out.set(bigToBytes(Q.x, 32), 1)
  return out
}

const eq = (A: Point, B: Point) =>
  (A === null && B === null) || (A !== null && B !== null && A.x === B.x && A.y === B.y)

/** Hash an arbitrary message to a curve point by try-and-increment: hash to a
 *  field element, attempt to lift it to the curve, bump a counter until it works.
 *  secp256k1 has cofactor 1, so the result is automatically a full-order point. */
export function hashToCurve(label: string): Point {
  for (let ctr = 0; ctr < 256; ctr++) {
    const h = taggedHash('Curvefield/hash2curve', concat(new TextEncoder().encode(label), new Uint8Array([ctr])))
    const x = mod(bytesToBig(h), secp256k1.p)
    const rhs = mod(x * x * x + secp256k1.b, secp256k1.p) // a = 0 on secp256k1
    const y = modSqrt(rhs, secp256k1.p)
    if (y !== null) {
      // Canonicalise to the even-y representative.
      return { x, y: y % 2n === 0n ? y : mod(-y, secp256k1.p) }
    }
  }
  throw new Error('hash-to-curve failed')
}

/** The NUMS ("nothing up my sleeve") second generator. Nobody knows log_G(H),
 *  which is exactly what makes Pedersen commitments binding. */
export const H: Point = hashToCurve('Curvefield/Pedersen/H')

/** Fiat–Shamir: hash a transcript of points (and optional extra scalars) into a
 *  challenge in F_n. The domain tag separates these challenges from every other
 *  hash in the engine. */
export function challenge(points: Point[], extra: bigint[] = []): bigint {
  const parts = [...points.map(ser), ...extra.map((e) => bigToBytes(mod(e, N), 32))]
  return mod(bytesToBig(taggedHash('Curvefield/sigma/challenge', concat(...parts))), N)
}

// ── Pedersen commitments ─────────────────────────────────────────────────────

/** Com(m, r) = m·G + r·H. Hiding (r uniform ⇒ commitment uniform) and binding
 *  (opening to two messages would reveal log_G H). */
export function commit(m: bigint, r: bigint): Point {
  return secp256k1.add(secp256k1.multiply(mod(m, N), G), secp256k1.multiply(mod(r, N), H))
}

// ── Schnorr proof of knowledge of a discrete log ─────────────────────────────

export interface SchnorrPoK {
  T: Point // commitment k·G
  s: bigint // response k + c·x
}

/** Prove knowledge of x such that P = x·G, in zero knowledge. */
export function provePoK(x: bigint): { P: Point; proof: SchnorrPoK } {
  const P = secp256k1.multiply(mod(x, N), G)
  const k = randomScalar(N) || 1n
  const T = secp256k1.multiply(k, G)
  const c = challenge([G, P, T])
  const s = mod(k + c * x, N)
  return { P, proof: { T, s } }
}

/** Verify a Schnorr PoK: s·G ?= T + c·P. */
export function verifyPoK(P: Point, proof: SchnorrPoK): boolean {
  const c = challenge([G, P, proof.T])
  return eq(secp256k1.multiply(proof.s, G), secp256k1.add(proof.T, secp256k1.multiply(c, P)))
}

// ── Chaum–Pedersen equality of discrete logs (DLEQ) ──────────────────────────

export interface DleqProof {
  T1: Point
  T2: Point
  s: bigint
}

/** Prove log_G(P) = log_H₂(Q) = x for an arbitrary second base `base2`. */
export function proveDleq(x: bigint, base2: Point): { P: Point; Q: Point; proof: DleqProof } {
  const xx = mod(x, N)
  const P = secp256k1.multiply(xx, G)
  const Q = secp256k1.multiply(xx, base2)
  const k = randomScalar(N) || 1n
  const T1 = secp256k1.multiply(k, G)
  const T2 = secp256k1.multiply(k, base2)
  const c = challenge([G, base2, P, Q, T1, T2])
  const s = mod(k + c * xx, N)
  return { P, Q, proof: { T1, T2, s } }
}

/** Verify a DLEQ proof: s·G = T1 + c·P and s·base2 = T2 + c·Q. */
export function verifyDleq(P: Point, Q: Point, base2: Point, proof: DleqProof): boolean {
  const c = challenge([G, base2, P, Q, proof.T1, proof.T2])
  const ok1 = eq(secp256k1.multiply(proof.s, G), secp256k1.add(proof.T1, secp256k1.multiply(c, P)))
  const ok2 = eq(
    secp256k1.multiply(proof.s, base2),
    secp256k1.add(proof.T2, secp256k1.multiply(c, Q)),
  )
  return ok1 && ok2
}

// ── 1-of-2 OR-proof: a Pedersen commitment opens to 0 or 1 ───────────────────
//
// Statement: C = m·G + r·H with m ∈ {0, 1}. Equivalently, *either* C = r·H
// (m=0) *or* C − G = r·H (m=1) — a knowledge-of-r proof against base H on one of
// two points Y₀ = C, Y₁ = C − G. The prover runs the real branch honestly and
// simulates the other, splitting the challenge c = c₀ + c₁.

export interface BitProof {
  C: Point // the commitment
  T0: Point
  T1: Point
  c0: bigint
  c1: bigint
  s0: bigint
  s1: bigint
}

/** Prove a Pedersen commitment C = bit·G + r·H hides a bit (0 or 1). */
export function proveBit(bit: number, r: bigint): BitProof {
  if (bit !== 0 && bit !== 1) throw new Error('bit must be 0 or 1')
  const rr = mod(r, N)
  const C = commit(BigInt(bit), rr)
  const Y0 = C // m = 0 branch:  C = r·H
  const Y1 = secp256k1.subtract(C, G) // m = 1 branch: C − G = r·H

  const k = randomScalar(N) || 1n // real-branch nonce
  // Simulate the *false* branch with a random challenge + response.
  const cFake = randomScalar(N) || 1n
  const sFake = randomScalar(N) || 1n

  let T0: Point, T1: Point
  if (bit === 0) {
    T0 = secp256k1.multiply(k, H) // real branch 0
    // Fake branch 1: T1 = sFake·H − cFake·Y1.
    T1 = secp256k1.subtract(secp256k1.multiply(sFake, H), secp256k1.multiply(cFake, Y1))
  } else {
    T1 = secp256k1.multiply(k, H) // real branch 1
    T0 = secp256k1.subtract(secp256k1.multiply(sFake, H), secp256k1.multiply(cFake, Y0))
  }

  const c = challenge([C, T0, T1])
  let c0: bigint, c1: bigint, s0: bigint, s1: bigint
  if (bit === 0) {
    c1 = cFake
    c0 = mod(c - c1, N)
    s0 = mod(k + c0 * rr, N)
    s1 = sFake
  } else {
    c0 = cFake
    c1 = mod(c - c0, N)
    s1 = mod(k + c1 * rr, N)
    s0 = sFake
  }
  return { C, T0, T1, c0, c1, s0, s1 }
}

/** Verify a bit proof: c₀+c₁ = H(C,T₀,T₁), s₀·H = T₀+c₀·C, s₁·H = T₁+c₁·(C−G). */
export function verifyBit(p: BitProof): boolean {
  const c = challenge([p.C, p.T0, p.T1])
  if (mod(p.c0 + p.c1, N) !== c) return false
  const Y0 = p.C
  const Y1 = secp256k1.subtract(p.C, G)
  const ok0 = eq(
    secp256k1.multiply(p.s0, H),
    secp256k1.add(p.T0, secp256k1.multiply(p.c0, Y0)),
  )
  const ok1 = eq(
    secp256k1.multiply(p.s1, H),
    secp256k1.add(p.T1, secp256k1.multiply(p.c1, Y1)),
  )
  return ok0 && ok1
}

// ── Range proof: a committed value lies in [0, 2ⁿ) ───────────────────────────

export interface RangeProof {
  V: Point // Pedersen commitment to v
  bits: number // n
  bitCommits: Point[] // Bᵢ = bᵢ·G + rᵢ·H
  bitProofs: BitProof[] // each Bᵢ proven to hide a bit
  r: bigint // commitment randomness for V (the prover's opening; shown for the demo)
}

/** Prove 0 ≤ v < 2ⁿ. Decompose v into n bits, commit to each, OR-prove each is a
 *  bit, and set V = Σ 2ⁱ·Bᵢ so V is a Pedersen commitment to v with randomness
 *  Σ 2ⁱ·rᵢ. Reveals nothing about v beyond "it fits in n bits". */
export function proveRange(v: bigint, bits: number): RangeProof {
  if (v < 0n || v >= 1n << BigInt(bits)) throw new Error('value out of range')
  const bitCommits: Point[] = []
  const bitProofs: BitProof[] = []
  let rTotal = 0n
  let V: Point = null
  for (let i = 0; i < bits; i++) {
    const b = Number((v >> BigInt(i)) & 1n)
    const ri = randomScalar(N) || 1n
    const proof = proveBit(b, ri)
    bitProofs.push(proof)
    bitCommits.push(proof.C)
    const weight = 1n << BigInt(i)
    rTotal = mod(rTotal + weight * ri, N)
    V = secp256k1.add(V, secp256k1.multiply(weight, proof.C))
  }
  return { V, bits, bitCommits, bitProofs, r: rTotal }
}

/** Verify a range proof: every Bᵢ is a bit, and V = Σ 2ⁱ·Bᵢ. */
export function verifyRange(p: RangeProof): boolean {
  if (p.bitProofs.length !== p.bits) return false
  let recon: Point = null
  for (let i = 0; i < p.bits; i++) {
    if (!eq(p.bitProofs[i].C, p.bitCommits[i])) return false
    if (!verifyBit(p.bitProofs[i])) return false
    recon = secp256k1.add(recon, secp256k1.multiply(1n << BigInt(i), p.bitCommits[i]))
  }
  return eq(recon, p.V)
}
