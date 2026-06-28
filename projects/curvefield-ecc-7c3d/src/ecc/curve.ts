// A short-Weierstrass elliptic curve  y² = x³ + ax + b  over the prime field F_p,
// with the full additive group law. The same code serves the toy curves in the
// visual labs (p = 97, 223, …) and the 256-bit secp256k1 curve used for real
// signatures — only the parameters differ.

import { mod, modInv, modSqrt } from './field'

/** An affine point, or the point at infinity O (the group identity). */
export type Point = { x: bigint; y: bigint } | null

export class Curve {
  readonly a: bigint
  readonly b: bigint
  readonly p: bigint

  constructor(a: bigint, b: bigint, p: bigint) {
    this.a = mod(a, p)
    this.b = mod(b, p)
    this.p = p
  }

  /** Discriminant ≠ 0 ⇔ the curve is non-singular (no cusp/node). */
  isNonSingular(): boolean {
    const { a, b, p } = this
    return mod(4n * a * a * a + 27n * b * b, p) !== 0n
  }

  /** Is the affine point (x, y) on the curve? O is always considered on-curve. */
  isOnCurve(pt: Point): boolean {
    if (pt === null) return true
    const { x, y } = pt
    const { a, b, p } = this
    return mod(y * y - (x * x * x + a * x + b), p) === 0n
  }

  /** Additive inverse: −(x, y) = (x, −y); −O = O. */
  negate(pt: Point): Point {
    if (pt === null) return null
    return { x: pt.x, y: mod(-pt.y, this.p) }
  }

  /** The group law: P + Q via the chord-and-tangent construction. */
  add(P: Point, Q: Point): Point {
    if (P === null) return Q
    if (Q === null) return P
    const { p } = this

    // P + (−P) = O.
    if (P.x === Q.x && mod(P.y + Q.y, p) === 0n) return null

    let lambda: bigint
    if (P.x === Q.x && P.y === Q.y) {
      // Doubling: slope of the tangent = (3x² + a) / (2y).
      if (P.y === 0n) return null // vertical tangent ⇒ O
      lambda = mod((3n * P.x * P.x + this.a) * modInv(2n * P.y, p), p)
    } else {
      // Chord through two distinct points: slope = (y₂ − y₁)/(x₂ − x₁).
      lambda = mod((Q.y - P.y) * modInv(Q.x - P.x, p), p)
    }

    const x3 = mod(lambda * lambda - P.x - Q.x, p)
    const y3 = mod(lambda * (P.x - x3) - P.y, p)
    return { x: x3, y: y3 }
  }

  /** P − Q. */
  subtract(P: Point, Q: Point): Point {
    return this.add(P, this.negate(Q))
  }

  /** Scalar multiplication k·P by right-to-left double-and-add. */
  multiply(k: bigint, P: Point): Point {
    if (P === null) return null
    let n = k
    if (this.order !== null) n = mod(n, this.order) // reduce mod group order if known
    if (n < 0n) {
      n = -n
      P = this.negate(P)
    }
    let result: Point = null
    let addend: Point = P
    while (n > 0n) {
      if (n & 1n) result = this.add(result, addend)
      addend = this.add(addend, addend)
      n >>= 1n
    }
    return result
  }

  /**
   * The trace of double-and-add: each step records the running accumulator and
   * whether the current bit triggered an add. Drives the scalar-mult walk view.
   */
  multiplyTrace(k: bigint, P: Point): { bit: number; doubled: Point; acc: Point }[] {
    const bits = k.toString(2).split('').map(Number)
    const steps: { bit: number; doubled: Point; acc: Point }[] = []
    let acc: Point = null
    for (const bit of bits) {
      const doubled = this.add(acc, acc)
      acc = bit ? this.add(doubled, P) : doubled
      steps.push({ bit, doubled, acc })
    }
    return steps
  }

  /** y-coordinates (0, 1, or 2 of them) of the on-curve points with this x. */
  liftX(x: bigint): bigint[] {
    const { a, b, p } = this
    const rhs = mod(x * x * x + a * x + b, p)
    const y = modSqrt(rhs, p)
    if (y === null) return []
    if (y === 0n) return [0n]
    return [y, mod(-y, p)]
  }

  /**
   * Enumerate every affine point on the curve (plus O). Only sensible for small
   * p — it scans all x in [0, p). Used by the finite-field explorer.
   */
  points(): Point[] {
    const pts: Point[] = [null]
    for (let x = 0n; x < this.p; x++) {
      for (const y of this.liftX(x)) pts.push({ x, y })
    }
    return pts
  }

  /** |E(F_p)|, computed by enumeration (small p only). Cached. */
  private _count: bigint | null = null
  count(): bigint {
    if (this._count === null) this._count = BigInt(this.points().length)
    return this._count
  }

  /** The additive order of P: least n > 0 with n·P = O (small curves only). */
  pointOrder(P: Point): bigint {
    if (P === null) return 1n
    let n = 1n
    let acc: Point = P
    while (acc !== null) {
      acc = this.add(acc, P)
      n++
    }
    return n
  }

  /** The cyclic subgroup ⟨P⟩ = {O, P, 2P, …}, in walk order. */
  subgroup(P: Point): Point[] {
    const group: Point[] = [null]
    let acc: Point = P
    while (acc !== null) {
      group.push(acc)
      acc = this.add(acc, P)
    }
    return group
  }

  /** Optional known group order, set for named curves so multiply() can reduce. */
  order: bigint | null = null
}

/** Format a point for display. */
export function fmtPoint(pt: Point): string {
  return pt === null ? 'O (∞)' : `(${pt.x}, ${pt.y})`
}
