// Exact rational arithmetic on BigInt, used everywhere the SMT layer needs a
// number that must be *exact*: numeric literals, the simplex tableau, computed
// models. A Rational is always stored in lowest terms with a positive
// denominator, so equality is structural (n === n && d === d).
//
// There is no floating point anywhere in the arithmetic theory — 1/3 + 1/3 +
// 1/3 is exactly 1, and a simplex pivot never accumulates rounding error.

function gcdBig(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a
  b = b < 0n ? -b : b
  while (b) {
    ;[a, b] = [b, a % b]
  }
  return a
}

export class Rational {
  readonly n: bigint // numerator (carries the sign)
  readonly d: bigint // denominator (always > 0)

  private constructor(n: bigint, d: bigint) {
    this.n = n
    this.d = d
  }

  static readonly ZERO = new Rational(0n, 1n)
  static readonly ONE = new Rational(1n, 1n)

  /** Build a reduced rational from any integer/fraction. */
  static of(n: bigint | number, d: bigint | number = 1n): Rational {
    let nn = typeof n === 'bigint' ? n : BigInt(Math.trunc(n))
    let dd = typeof d === 'bigint' ? d : BigInt(Math.trunc(d))
    if (dd === 0n) throw new Error('Rational: zero denominator')
    if (dd < 0n) {
      nn = -nn
      dd = -dd
    }
    const g = gcdBig(nn, dd) || 1n
    return new Rational(nn / g, dd / g)
  }

  /** Parse a decimal/fraction literal: "3", "-1/2", "0.25", ".5", "10.0". */
  static parse(s: string): Rational {
    s = s.trim()
    if (s.includes('/')) {
      const [a, b] = s.split('/')
      return Rational.of(BigInt(a.trim()), BigInt(b.trim()))
    }
    if (s.includes('.')) {
      const neg = s.startsWith('-')
      const body = neg ? s.slice(1) : s
      const [intPart, fracPart = ''] = body.split('.')
      const denom = 10n ** BigInt(fracPart.length)
      const num = BigInt((intPart || '0') + fracPart || '0')
      return Rational.of(neg ? -num : num, denom)
    }
    return Rational.of(BigInt(s))
  }

  add(o: Rational): Rational {
    return Rational.of(this.n * o.d + o.n * this.d, this.d * o.d)
  }
  sub(o: Rational): Rational {
    return Rational.of(this.n * o.d - o.n * this.d, this.d * o.d)
  }
  mul(o: Rational): Rational {
    return Rational.of(this.n * o.n, this.d * o.d)
  }
  div(o: Rational): Rational {
    if (o.n === 0n) throw new Error('Rational: division by zero')
    return Rational.of(this.n * o.d, this.d * o.n)
  }
  neg(): Rational {
    return new Rational(-this.n, this.d)
  }
  abs(): Rational {
    return this.n < 0n ? this.neg() : this
  }

  cmp(o: Rational): number {
    const lhs = this.n * o.d
    const rhs = o.n * this.d
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0
  }
  eq(o: Rational): boolean {
    return this.n === o.n && this.d === o.d
  }
  lt(o: Rational): boolean {
    return this.cmp(o) < 0
  }
  le(o: Rational): boolean {
    return this.cmp(o) <= 0
  }
  gt(o: Rational): boolean {
    return this.cmp(o) > 0
  }
  ge(o: Rational): boolean {
    return this.cmp(o) >= 0
  }

  isZero(): boolean {
    return this.n === 0n
  }
  isInteger(): boolean {
    return this.d === 1n
  }
  sign(): number {
    return this.n < 0n ? -1 : this.n > 0n ? 1 : 0
  }
  /** Greatest integer ≤ this (BigInt). */
  floor(): bigint {
    if (this.d === 1n) return this.n
    const q = this.n / this.d
    // BigInt division truncates toward zero; adjust for negatives.
    return this.n < 0n ? q - 1n : q
  }
  /** Least integer ≥ this (BigInt). */
  ceil(): bigint {
    if (this.d === 1n) return this.n
    const q = this.n / this.d
    return this.n > 0n ? q + 1n : q
  }
  /** Nearest Number, for display only — never used inside the solver. */
  toNumber(): number {
    return Number(this.n) / Number(this.d)
  }
  toString(): string {
    return this.d === 1n ? this.n.toString() : `${this.n}/${this.d}`
  }
}

export const R = Rational.of
