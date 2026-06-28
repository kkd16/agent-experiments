// The top floor of the tower, where pairing values live:
//
//     F_{p¹²} = F_{p⁶}[w] / (w² − v).
//
// An element is a0 + a1·w with a0, a1 ∈ F_{p⁶}, and w² = v. This is the codomain
// of the optimal-ate pairing (after the final exponentiation, its values are the
// r-th roots of unity — the target group G_T).

import { BLS_P } from './fp2'
import { Fp2 } from './fp2'
import { Fp6 } from './fp6'

const P = BLS_P

/** a0 + a1·w with a0, a1 ∈ F_{p⁶}. */
export type Fp12 = { c0: Fp6; c1: Fp6 }

export const Fp12 = {
  ZERO: { c0: Fp6.ZERO, c1: Fp6.ZERO } as Fp12,
  ONE: { c0: Fp6.ONE, c1: Fp6.ZERO } as Fp12,

  of(c0: Fp6, c1: Fp6): Fp12 {
    return { c0, c1 }
  },

  fromFp6(a: Fp6): Fp12 {
    return { c0: a, c1: Fp6.ZERO }
  },

  fromFp(x: bigint): Fp12 {
    return { c0: Fp6.fromFp2(Fp2.fromFp(x)), c1: Fp6.ZERO }
  },

  eq(x: Fp12, y: Fp12): boolean {
    return Fp6.eq(x.c0, y.c0) && Fp6.eq(x.c1, y.c1)
  },

  isOne(x: Fp12): boolean {
    return Fp12.eq(x, Fp12.ONE)
  },

  add(x: Fp12, y: Fp12): Fp12 {
    return { c0: Fp6.add(x.c0, y.c0), c1: Fp6.add(x.c1, y.c1) }
  },

  sub(x: Fp12, y: Fp12): Fp12 {
    return { c0: Fp6.sub(x.c0, y.c0), c1: Fp6.sub(x.c1, y.c1) }
  },

  neg(x: Fp12): Fp12 {
    return { c0: Fp6.neg(x.c0), c1: Fp6.neg(x.c1) }
  },

  // (a0 + a1 w)(b0 + b1 w) = (a0 b0 + v·a1 b1) + (a0 b1 + a1 b0) w, since w² = v.
  mul(x: Fp12, y: Fp12): Fp12 {
    const a0b0 = Fp6.mul(x.c0, y.c0)
    const a1b1 = Fp6.mul(x.c1, y.c1)
    const c0 = Fp6.add(a0b0, Fp6.mulV(a1b1))
    const c1 = Fp6.sub(
      Fp6.mul(Fp6.add(x.c0, x.c1), Fp6.add(y.c0, y.c1)),
      Fp6.add(a0b0, a1b1),
    )
    return { c0, c1 }
  },

  sqr(x: Fp12): Fp12 {
    return Fp12.mul(x, x)
  },

  /** 1/(a0 + a1 w) = (a0 − a1 w) / (a0² − v·a1²). */
  inv(x: Fp12): Fp12 {
    const det = Fp6.sub(Fp6.sqr(x.c0), Fp6.mulV(Fp6.sqr(x.c1)))
    const f = Fp6.inv(det)
    return { c0: Fp6.mul(x.c0, f), c1: Fp6.neg(Fp6.mul(x.c1, f)) }
  },

  /** Conjugation over F_{p⁶}: a0 + a1 w ↦ a0 − a1 w. Equals the p⁶-power Frobenius. */
  conj(x: Fp12): Fp12 {
    return { c0: x.c0, c1: Fp6.neg(x.c1) }
  },

  div(x: Fp12, y: Fp12): Fp12 {
    return Fp12.mul(x, Fp12.inv(y))
  },

  /** Exponentiation by a (possibly large) integer, square-and-multiply. */
  pow(x: Fp12, e: bigint): Fp12 {
    let base = x
    let exp = e
    let result = Fp12.ONE
    while (exp > 0n) {
      if (exp & 1n) result = Fp12.mul(result, base)
      base = Fp12.sqr(base)
      exp >>= 1n
    }
    return result
  },
}

export { P as FP12_P }
