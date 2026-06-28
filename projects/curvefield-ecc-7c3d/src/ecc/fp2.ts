// The first floor of the BLS12-381 tower: the quadratic extension
//
//     F_{p²} = F_p[u] / (u² + 1).
//
// Every BLS12-381 pairing is built from a tower of extensions stacked on top of
// the 381-bit base prime p — F_{p²} ⊂ F_{p⁶} ⊂ F_{p¹²} — and this file is the
// bottom of that stack. An element is a + b·u with a, b ∈ F_p and u² = −1, so it
// behaves exactly like a Gaussian integer reduced modulo p. Everything is plain
// BigInt; there are no dependencies beyond the field helpers we already had.

import { mod, modInv } from './field'

/** The BLS12-381 base-field prime p (381 bits, p ≡ 3 mod 4). */
export const BLS_P =
  0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaabn

const P = BLS_P

/** An element a + b·u of F_{p²}. */
export type Fp2 = { a: bigint; b: bigint }

export const Fp2 = {
  ZERO: { a: 0n, b: 0n } as Fp2,
  ONE: { a: 1n, b: 0n } as Fp2,

  of(a: bigint, b: bigint): Fp2 {
    return { a: mod(a, P), b: mod(b, P) }
  },

  fromFp(x: bigint): Fp2 {
    return { a: mod(x, P), b: 0n }
  },

  eq(x: Fp2, y: Fp2): boolean {
    return x.a === y.a && x.b === y.b
  },

  isZero(x: Fp2): boolean {
    return x.a === 0n && x.b === 0n
  },

  add(x: Fp2, y: Fp2): Fp2 {
    return { a: mod(x.a + y.a, P), b: mod(x.b + y.b, P) }
  },

  sub(x: Fp2, y: Fp2): Fp2 {
    return { a: mod(x.a - y.a, P), b: mod(x.b - y.b, P) }
  },

  neg(x: Fp2): Fp2 {
    return { a: mod(-x.a, P), b: mod(-x.b, P) }
  },

  // (a + bu)(c + du) = (ac − bd) + (ad + bc)u, using u² = −1.
  mul(x: Fp2, y: Fp2): Fp2 {
    const ac = x.a * y.a
    const bd = x.b * y.b
    const cross = (x.a + x.b) * (y.a + y.b) // ac + ad + bc + bd
    return {
      a: mod(ac - bd, P),
      b: mod(cross - ac - bd, P),
    }
  },

  sqr(x: Fp2): Fp2 {
    // (a + bu)² = (a + b)(a − b) + 2ab·u.
    const apb = x.a + x.b
    const amb = x.a - x.b
    return { a: mod(apb * amb, P), b: mod(2n * x.a * x.b, P) }
  },

  /** Multiply by a base-field scalar. */
  mulFp(x: Fp2, s: bigint): Fp2 {
    return { a: mod(x.a * s, P), b: mod(x.b * s, P) }
  },

  /** 1/(a + bu) = (a − bu) / (a² + b²). */
  inv(x: Fp2): Fp2 {
    const factor = modInv(mod(x.a * x.a + x.b * x.b, P), P)
    return { a: mod(x.a * factor, P), b: mod(-x.b * factor, P) }
  },

  /** The non-trivial F_{p²}/F_p automorphism, a + bu ↦ a − bu (also = Frobenius, x ↦ xᵖ). */
  conj(x: Fp2): Fp2 {
    return { a: x.a, b: mod(-x.b, P) }
  },

  /**
   * Multiply by the cubic/sextic non-residue ξ = 1 + u used to climb the tower:
   * (a + bu)(1 + u) = (a − b) + (a + b)u.
   */
  mulNonres(x: Fp2): Fp2 {
    return { a: mod(x.a - x.b, P), b: mod(x.a + x.b, P) }
  },
}
