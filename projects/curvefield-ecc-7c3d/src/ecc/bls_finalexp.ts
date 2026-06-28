// The optimized final exponentiation — the expensive tail of every pairing.
//
// The optimal-ate pairing finishes by raising a Miller-loop value to the power
// (p¹² − 1)/r. Done naïvely that is a square-and-multiply over a ~4000-bit
// exponent (the old `Fp12.pow(easy, FINAL_TAIL)`). The standard trick (Hayashida–
// Aranha–Menezes) splits it into an "easy part" — a couple of Frobenius maps and
// one inversion — and a "hard part" expressed as a short addition chain in the
// BLS seed x (a 64-bit number), with the work done by p-power Frobenius maps.
//
// The Frobenius constants here are not hard-coded: they are *derived* at load
// time as powers of the tower's non-residue ξ = 1 + u, so the file stays honest
// to the "from-scratch, zero magic numbers" spirit. The result is proven equal
// to the naïve exponentiation in selftest.ts, on the actual pairing inputs.

import { BLS_P, Fp2 } from './fp2'
import { Fp6 } from './fp6'
import { Fp12 } from './fp12'

const P = BLS_P
const ABS_X = 0xd201000000010000n // |x|, the BLS seed magnitude

// ── Frobenius (raise an F_{p¹²} element to the p-th power) ─────────────────────

function fp2Pow(a: Fp2, e: bigint): Fp2 {
  let r = Fp2.ONE
  let b = a
  let n = e
  while (n > 0n) {
    if (n & 1n) r = Fp2.mul(r, b)
    b = Fp2.sqr(b)
    n >>= 1n
  }
  return r
}

// ξ = 1 + u. The p-power Frobenius scales the v- and w-tower coordinates by
// fixed powers of ξ; deriving them once keeps everything reproducible.
const XI = Fp2.of(1n, 1n)
const GAMMA_W = fp2Pow(XI, (P - 1n) / 6n) // w  ↦ γ_w · w
const GAMMA_V1 = fp2Pow(XI, (P - 1n) / 3n) // v  ↦ γ_{v} · v
const GAMMA_V2 = fp2Pow(XI, (2n * (P - 1n)) / 3n) // v² ↦ γ_{v²} · v²

/** Frobenius on F_{p⁶}: conjugate each F_{p²} coefficient, then rescale v, v². */
function frob6(c: Fp6): Fp6 {
  return Fp6.of(
    Fp2.conj(c.c0),
    Fp2.mul(Fp2.conj(c.c1), GAMMA_V1),
    Fp2.mul(Fp2.conj(c.c2), GAMMA_V2),
  )
}

/** One application of the p-power Frobenius on F_{p¹²}. */
function frob1(z: Fp12): Fp12 {
  return Fp12.of(frob6(z.c0), Fp6.mulFp2(frob6(z.c1), GAMMA_W))
}

/** The p^k-power Frobenius (k applications). */
export function frobenius(z: Fp12, power: number): Fp12 {
  let out = z
  for (let i = 0; i < power; i++) out = frob1(out)
  return out
}

// ── the optimized final exponentiation ────────────────────────────────────────

const conj = Fp12.conj
/** a^x where x = −|x| (the seed is negative), via |x| square-and-multiply. */
function expX(a: Fp12): Fp12 {
  return conj(Fp12.pow(a, ABS_X))
}

/**
 * f^((p¹²−1)/r). Easy part: f^(p⁶−1)·(p²+1) lands in the cyclotomic subgroup
 * (where inverse = conjugate). Hard part: the Hayashida addition chain in x.
 */
export function finalExpFast(f: Fp12): Fp12 {
  // easy part
  const e0 = Fp12.mul(frobenius(f, 6), Fp12.inv(f)) // f^(p⁶ − 1)
  const t1 = Fp12.mul(frobenius(e0, 2), e0) // ^(p² + 1)  → cyclotomic

  // hard part (every tᵢ is unitary, so conj = inverse)
  const t2 = expX(t1)
  const t3 = Fp12.mul(conj(Fp12.sqr(t1)), t2)
  const t4 = expX(t3)
  const t5 = expX(t4)
  const t6 = Fp12.mul(expX(t5), Fp12.sqr(t2))
  const t7 = expX(t6)

  const a = frobenius(Fp12.mul(t2, t5), 2)
  const b = frobenius(Fp12.mul(t4, t1), 3)
  const c = frobenius(Fp12.mul(t6, conj(t1)), 1)
  const d = Fp12.mul(Fp12.mul(t7, conj(t3)), t1)
  return Fp12.mul(Fp12.mul(a, b), Fp12.mul(c, d))
}
