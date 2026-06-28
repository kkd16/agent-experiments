// The middle floor of the tower:
//
//     F_{p⁶} = F_{p²}[v] / (v³ − ξ),   ξ = 1 + u.
//
// An element is c0 + c1·v + c2·v² with each cᵢ ∈ F_{p²}. Multiplication reduces
// v³ → ξ, which is why F_{p²}.mulNonres (multiply by ξ) shows up throughout.

import { Fp2 } from './fp2'

/** c0 + c1·v + c2·v² with cᵢ ∈ F_{p²}. */
export type Fp6 = { c0: Fp2; c1: Fp2; c2: Fp2 }

export const Fp6 = {
  ZERO: { c0: Fp2.ZERO, c1: Fp2.ZERO, c2: Fp2.ZERO } as Fp6,
  ONE: { c0: Fp2.ONE, c1: Fp2.ZERO, c2: Fp2.ZERO } as Fp6,

  of(c0: Fp2, c1: Fp2, c2: Fp2): Fp6 {
    return { c0, c1, c2 }
  },

  fromFp2(a: Fp2): Fp6 {
    return { c0: a, c1: Fp2.ZERO, c2: Fp2.ZERO }
  },

  eq(x: Fp6, y: Fp6): boolean {
    return Fp2.eq(x.c0, y.c0) && Fp2.eq(x.c1, y.c1) && Fp2.eq(x.c2, y.c2)
  },

  isZero(x: Fp6): boolean {
    return Fp2.isZero(x.c0) && Fp2.isZero(x.c1) && Fp2.isZero(x.c2)
  },

  add(x: Fp6, y: Fp6): Fp6 {
    return { c0: Fp2.add(x.c0, y.c0), c1: Fp2.add(x.c1, y.c1), c2: Fp2.add(x.c2, y.c2) }
  },

  sub(x: Fp6, y: Fp6): Fp6 {
    return { c0: Fp2.sub(x.c0, y.c0), c1: Fp2.sub(x.c1, y.c1), c2: Fp2.sub(x.c2, y.c2) }
  },

  neg(x: Fp6): Fp6 {
    return { c0: Fp2.neg(x.c0), c1: Fp2.neg(x.c1), c2: Fp2.neg(x.c2) }
  },

  // Schoolbook multiply, reducing v³ = ξ:
  //   c0 = a0·b0 + ξ·(a1·b2 + a2·b1)
  //   c1 = a0·b1 + a1·b0 + ξ·(a2·b2)
  //   c2 = a0·b2 + a1·b1 + a2·b0
  mul(x: Fp6, y: Fp6): Fp6 {
    const a0b0 = Fp2.mul(x.c0, y.c0)
    const a1b1 = Fp2.mul(x.c1, y.c1)
    const a2b2 = Fp2.mul(x.c2, y.c2)

    const t1 = Fp2.add(Fp2.mul(Fp2.add(x.c1, x.c2), Fp2.add(y.c1, y.c2)), Fp2.neg(Fp2.add(a1b1, a2b2)))
    const c0 = Fp2.add(a0b0, Fp2.mulNonres(t1))

    const t2 = Fp2.sub(Fp2.mul(Fp2.add(x.c0, x.c1), Fp2.add(y.c0, y.c1)), Fp2.add(a0b0, a1b1))
    const c1 = Fp2.add(t2, Fp2.mulNonres(a2b2))

    const t3 = Fp2.sub(Fp2.mul(Fp2.add(x.c0, x.c2), Fp2.add(y.c0, y.c2)), Fp2.add(a0b0, a2b2))
    const c2 = Fp2.add(t3, a1b1)

    return { c0, c1, c2 }
  },

  sqr(x: Fp6): Fp6 {
    return Fp6.mul(x, x)
  },

  /** Multiply by a single F_{p²} coefficient (scales every component). */
  mulFp2(x: Fp6, s: Fp2): Fp6 {
    return { c0: Fp2.mul(x.c0, s), c1: Fp2.mul(x.c1, s), c2: Fp2.mul(x.c2, s) }
  },

  /** Multiply by v: (c0 + c1 v + c2 v²)·v = ξ·c2 + c0·v + c1·v². */
  mulV(x: Fp6): Fp6 {
    return { c0: Fp2.mulNonres(x.c2), c1: x.c0, c2: x.c1 }
  },

  // Standard F_{p⁶} inversion via the F_{p²}-norm.
  inv(x: Fp6): Fp6 {
    const { c0, c1, c2 } = x
    const t0 = Fp2.sub(Fp2.sqr(c0), Fp2.mulNonres(Fp2.mul(c1, c2)))
    const t1 = Fp2.sub(Fp2.mulNonres(Fp2.sqr(c2)), Fp2.mul(c0, c1))
    const t2 = Fp2.sub(Fp2.sqr(c1), Fp2.mul(c0, c2))
    const det = Fp2.add(
      Fp2.mul(c0, t0),
      Fp2.mulNonres(Fp2.add(Fp2.mul(c2, t1), Fp2.mul(c1, t2))),
    )
    const f = Fp2.inv(det)
    return { c0: Fp2.mul(t0, f), c1: Fp2.mul(t1, f), c2: Fp2.mul(t2, f) }
  },
}
