// Exact rational arithmetic on BigInt — the engine's ground truth. A discrete-time Markov chain's
// reachability probabilities are the solution of a linear system whose coefficients are the exact
// transition probabilities (rationals). Solved over `Frac` (a reduced BigInt fraction), the answer
// is EXACT — 1/6 is 1/6, never 0.16666… — which is what lets the Verify tab pin floating-point value
// iteration against a rational oracle and declare them equal with no epsilon fudge on the exact side.
//
// Why BigInt and not the plain-number `Rational` the games engine uses: Gaussian elimination on a
// probability matrix multiplies denominators together, and even a dozen states can push a denominator
// past 2^53. BigInt fractions never lose a bit, so the "exact" column of the proof is genuinely exact.

/** A reduced fraction n/d with d > 0. Integers are n/1. Always kept in lowest terms. */
export interface Frac {
  readonly n: bigint
  readonly d: bigint
}

function bgcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a
  b = b < 0n ? -b : b
  while (b) {
    ;[a, b] = [b, a % b]
  }
  return a
}

/** Build a reduced fraction from any BigInt (or number) numerator/denominator (d ≠ 0). */
export function fr(n: bigint | number, d: bigint | number = 1n): Frac {
  let nn = typeof n === 'bigint' ? n : BigInt(Math.trunc(n))
  let dd = typeof d === 'bigint' ? d : BigInt(Math.trunc(d))
  if (dd === 0n) throw new Error('fraction with zero denominator')
  if (dd < 0n) {
    nn = -nn
    dd = -dd
  }
  const g = bgcd(nn, dd) || 1n
  return { n: nn / g, d: dd / g }
}

export const F0: Frac = { n: 0n, d: 1n }
export const F1: Frac = { n: 1n, d: 1n }

export function fadd(a: Frac, b: Frac): Frac {
  return fr(a.n * b.d + b.n * a.d, a.d * b.d)
}
export function fsub(a: Frac, b: Frac): Frac {
  return fr(a.n * b.d - b.n * a.d, a.d * b.d)
}
export function fmul(a: Frac, b: Frac): Frac {
  return fr(a.n * b.n, a.d * b.d)
}
export function fdiv(a: Frac, b: Frac): Frac {
  if (b.n === 0n) throw new Error('division by zero fraction')
  return fr(a.n * b.d, a.d * b.n)
}
export function fneg(a: Frac): Frac {
  return { n: -a.n, d: a.d }
}
/** sign(a − b): −1, 0, or +1. */
export function fcmp(a: Frac, b: Frac): number {
  const l = a.n * b.d
  const r = b.n * a.d
  return l < r ? -1 : l > r ? 1 : 0
}
export function feq(a: Frac, b: Frac): boolean {
  return a.n === b.n && a.d === b.d
}
export function fisZero(a: Frac): boolean {
  return a.n === 0n
}
export function fisOne(a: Frac): boolean {
  return a.n === a.d
}
export function fsign(a: Frac): number {
  return a.n < 0n ? -1 : a.n > 0n ? 1 : 0
}
export function fmin(a: Frac, b: Frac): Frac {
  return fcmp(a, b) <= 0 ? a : b
}
export function fmax(a: Frac, b: Frac): Frac {
  return fcmp(a, b) >= 0 ? a : b
}
export function ftoNumber(a: Frac): number {
  // Exact for small values; for huge BigInts fall back to a scaled ratio that stays in double range.
  const n = a.n
  const d = a.d
  if (n === 0n) return 0
  const neg = n < 0n
  let an = neg ? -n : n
  // Reduce both by their common magnitude so Number() doesn't overflow to Infinity.
  const bits = (x: bigint) => x.toString(2).length
  const shift = Math.max(0, Math.max(bits(an), bits(d)) - 52)
  if (shift > 0) {
    const s = BigInt(shift)
    an = an >> s
    const dd = d >> s || 1n
    const v = Number(an) / Number(dd)
    return neg ? -v : v
  }
  const v = Number(an) / Number(d)
  return neg ? -v : v
}

/** Compact display: an integer prints plainly, otherwise `n/d`. */
export function ftoStr(a: Frac): string {
  return a.d === 1n ? a.n.toString() : `${a.n}/${a.d}`
}

/** A rounded decimal string with up to `places` significant fractional digits (trailing zeros trimmed). */
export function ftoDecimal(a: Frac, places = 6): string {
  if (a.n === 0n) return '0'
  const neg = a.n < 0n
  const n = neg ? -a.n : a.n
  const whole = n / a.d
  let rem = n % a.d
  if (rem === 0n) return (neg ? '-' : '') + whole.toString()
  let frac = ''
  for (let i = 0; i < places && rem !== 0n; i++) {
    rem *= 10n
    frac += (rem / a.d).toString()
    rem %= a.d
  }
  frac = frac.replace(/0+$/, '')
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '')
}

/**
 * Parse a probability literal: an integer (`3`), a fraction (`1/6`), or a decimal (`0.25`). Decimals
 * become EXACT fractions (0.25 → 1/4), so a model typed with decimals is still solved exactly.
 */
export function parseFrac(raw: string): Frac | null {
  const s = raw.trim()
  if (s === '') return null
  const slash = s.indexOf('/')
  if (slash >= 0) {
    const a = s.slice(0, slash).trim()
    const b = s.slice(slash + 1).trim()
    if (!/^[+-]?\d+$/.test(a) || !/^[+-]?\d+$/.test(b)) return null
    if (BigInt(b) === 0n) return null
    return fr(BigInt(a), BigInt(b))
  }
  if (/^[+-]?\d+$/.test(s)) return fr(BigInt(s), 1n)
  const m = /^([+-]?)(\d*)\.(\d+)$/.exec(s)
  if (m) {
    const sign = m[1] === '-' ? -1n : 1n
    const intPart = m[2] === '' ? 0n : BigInt(m[2])
    const fracDigits = m[3]
    const denom = 10n ** BigInt(fracDigits.length)
    const num = intPart * denom + BigInt(fracDigits)
    return fr(sign * num, denom)
  }
  return null
}

/** Exact sum of a list (empty → 0). */
export function fsum(xs: Frac[]): Frac {
  let acc = F0
  for (const x of xs) acc = fadd(acc, x)
  return acc
}
