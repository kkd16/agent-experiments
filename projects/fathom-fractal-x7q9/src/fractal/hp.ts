// High-precision real numbers, as fixed-point BigInt values scaled by 2^PBITS.
//
// A plain JavaScript `number` is an IEEE double with ~15–16 significant decimal
// digits. That alone caps a fractal zoom at ~1e-13 no matter how clever the
// shader is: once the *stored* view centre can't distinguish neighbouring
// pixels, there's nothing for the GPU to render. Fathom's perturbation engine
// (see `refOrbit.ts`) computes a reference orbit from the exact centre, so the
// centre has to carry far more than a double's worth of digits.
//
// The representation is dead simple: a real x in a small range is stored as the
// integer round(x · 2^PBITS). Addition is exact integer addition; multiplication
// is (a·b) >> PBITS with round-to-nearest. 224 fractional bits ≈ 67 decimal
// digits — comfortably past the float32 delta floor (~1e-31) that actually
// limits how deep the GPU can dive, so coordinate precision is never the
// bottleneck.

export const PBITS = 224

/** A high-precision real: the fixed-point value round(x · 2^PBITS). */
export type HP = bigint

/** Exact conversion of a finite JS double to fixed-point. */
export function hpFromNumber(x: number): HP {
  if (x === 0 || !Number.isFinite(x)) return 0n
  const neg = x < 0
  let a = Math.abs(x)
  // Normalise a into [1, 2) tracking the binary exponent, then read 53 bits.
  let e = 0
  while (a >= 2) {
    a /= 2
    e++
  }
  while (a < 1) {
    a *= 2
    e--
  }
  let mant = 0n
  for (let i = 0; i < 53; i++) {
    mant <<= 1n
    if (a >= 1) {
      mant |= 1n
      a -= 1
    }
    a *= 2
  }
  // value = mant · 2^(e-52); scale by 2^PBITS.
  const shift = PBITS + e - 52
  let fixed: bigint
  if (shift >= 0) fixed = mant << BigInt(shift)
  else {
    const s = BigInt(-shift)
    fixed = (mant + (1n << (s - 1n))) >> s // round to nearest
  }
  return neg ? -fixed : fixed
}

/** Convert fixed-point back to the nearest JS double. */
export function hpToNumber(v: HP): number {
  if (v === 0n) return 0
  const neg = v < 0n
  const m = neg ? -v : v
  const bits = m.toString(2).length
  const shift = bits - 53
  let val: number
  if (shift > 0) val = Number(m >> BigInt(shift)) * Math.pow(2, shift)
  else val = Number(m)
  val *= Math.pow(2, -PBITS)
  return neg ? -val : val
}

/** Add a JS double to a high-precision value (exact). */
export function hpAddNumber(v: HP, x: number): HP {
  return v + hpFromNumber(x)
}

/** Fixed-point multiply with round-to-nearest. */
export function hpMul(a: HP, b: HP): HP {
  const prod = a * b
  const half = 1n << BigInt(PBITS - 1)
  if (prod >= 0n) return (prod + half) >> BigInt(PBITS)
  return -((-prod + half) >> BigInt(PBITS))
}

/** Parse a decimal string (e.g. "-0.743643887037158704752191506") into HP. */
export function hpFromString(str: string): HP {
  let s = str.trim()
  if (s === '' || s === '-' || s === '+') return 0n
  let neg = false
  if (s[0] === '-') {
    neg = true
    s = s.slice(1)
  } else if (s[0] === '+') {
    s = s.slice(1)
  }
  // Support scientific notation from the URL / bookmarks.
  let exp = 0
  const eIdx = s.search(/[eE]/)
  if (eIdx >= 0) {
    exp = parseInt(s.slice(eIdx + 1), 10) || 0
    s = s.slice(0, eIdx)
  }
  const dot = s.indexOf('.')
  let intPart = s
  let fracPart = ''
  if (dot >= 0) {
    intPart = s.slice(0, dot)
    fracPart = s.slice(dot + 1)
  }
  const digits = (intPart + fracPart).replace(/[^0-9]/g, '') || '0'
  const k = fracPart.length - exp // net fractional-digit count
  const num = BigInt(digits)
  // value = num · 10^(-k). Fold the sign of k into a numerator/denominator.
  let numer: bigint
  let denom: bigint
  if (k >= 0) {
    numer = num << BigInt(PBITS)
    denom = 10n ** BigInt(k)
  } else {
    numer = (num * 10n ** BigInt(-k)) << BigInt(PBITS)
    denom = 1n
  }
  const q = numer / denom
  const r = numer % denom
  const fixed = q + (r * 2n >= denom ? 1n : 0n) // round to nearest
  return neg ? -fixed : fixed
}

/** Render a high-precision value as a decimal string with `digits` places. */
export function hpToString(v: HP, digits: number): string {
  const neg = v < 0n
  const m = neg ? -v : v
  const pow = 10n ** BigInt(digits)
  const half = 1n << BigInt(PBITS - 1)
  // round(value · 10^digits) = round(m · 10^digits / 2^PBITS)
  const scaled = (m * pow + half) >> BigInt(PBITS)
  const s = scaled.toString().padStart(digits + 1, '0')
  const intS = s.slice(0, s.length - digits)
  const fracS = digits > 0 ? '.' + s.slice(s.length - digits) : ''
  return (neg ? '-' : '') + intS + fracS
}
