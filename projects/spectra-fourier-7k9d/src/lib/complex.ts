// Complex vectors stored as a struct-of-arrays: parallel Float64Arrays for the
// real and imaginary parts. This keeps the FFT allocation-light and cache-friendly
// compared to an array of {re, im} objects.

export interface Complex {
  re: number
  im: number
}

export interface ComplexArray {
  re: Float64Array
  im: Float64Array
  readonly length: number
}

export function makeComplex(length: number): ComplexArray {
  return { re: new Float64Array(length), im: new Float64Array(length), length }
}

/** Build a ComplexArray from a real-valued signal (imaginary parts zeroed). */
export function fromReal(signal: ArrayLike<number>): ComplexArray {
  const n = signal.length
  const out = makeComplex(n)
  for (let i = 0; i < n; i++) out.re[i] = signal[i]
  return out
}

/** Build from explicit re/im arrays (copied). */
export function fromParts(re: ArrayLike<number>, im: ArrayLike<number>): ComplexArray {
  const n = re.length
  const out = makeComplex(n)
  for (let i = 0; i < n; i++) {
    out.re[i] = re[i]
    out.im[i] = im[i]
  }
  return out
}

export function cloneComplex(a: ComplexArray): ComplexArray {
  const out = makeComplex(a.length)
  out.re.set(a.re)
  out.im.set(a.im)
  return out
}

/** Elementwise magnitude sqrt(re^2 + im^2). */
export function magnitude(a: ComplexArray): Float64Array {
  const out = new Float64Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = Math.hypot(a.re[i], a.im[i])
  return out
}

/** Elementwise phase atan2(im, re) in radians (-pi, pi]. */
export function phase(a: ComplexArray): Float64Array {
  const out = new Float64Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = Math.atan2(a.im[i], a.re[i])
  return out
}

/** Power spectrum re^2 + im^2. */
export function power(a: ComplexArray): Float64Array {
  const out = new Float64Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a.re[i] * a.re[i] + a.im[i] * a.im[i]
  return out
}

/** Single complex multiply. */
export function cmul(a: Complex, b: Complex): Complex {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }
}
