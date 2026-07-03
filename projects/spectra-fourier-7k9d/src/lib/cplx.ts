// A tiny *scalar* complex-number library.
//
// The FFT core (`complex.ts`) stores complex vectors as a struct-of-arrays for
// cache-friendly bulk transforms. The filter-design math, by contrast, works
// pole-by-pole on a handful of individual complex numbers — roots of quadratics,
// bilinear transforms, DTFT sums — where an immutable value type reads far more
// clearly than juggling parallel arrays. This module is that value type.

export interface Cx {
  re: number
  im: number
}

export const cx = (re: number, im = 0): Cx => ({ re, im })
export const CZERO: Cx = { re: 0, im: 0 }
export const CONE: Cx = { re: 1, im: 0 }

export const cadd = (a: Cx, b: Cx): Cx => ({ re: a.re + b.re, im: a.im + b.im })
export const csub = (a: Cx, b: Cx): Cx => ({ re: a.re - b.re, im: a.im - b.im })
export const cmul = (a: Cx, b: Cx): Cx => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
})
export const cscale = (a: Cx, s: number): Cx => ({ re: a.re * s, im: a.im * s })
export const cconj = (a: Cx): Cx => ({ re: a.re, im: -a.im })
export const cneg = (a: Cx): Cx => ({ re: -a.re, im: -a.im })

export function cdiv(a: Cx, b: Cx): Cx {
  const d = b.re * b.re + b.im * b.im
  if (d === 0) return { re: 0, im: 0 }
  return {
    re: (a.re * b.re + a.im * b.im) / d,
    im: (a.im * b.re - a.re * b.im) / d,
  }
}

export const cabs = (a: Cx): number => Math.hypot(a.re, a.im)
export const carg = (a: Cx): number => Math.atan2(a.im, a.re)

/** Principal complex square root. */
export function csqrt(a: Cx): Cx {
  const r = Math.hypot(a.re, a.im)
  if (r === 0) return { re: 0, im: 0 }
  const re = Math.sqrt((r + a.re) / 2)
  let im = Math.sqrt((r - a.re) / 2)
  if (a.im < 0) im = -im
  return { re, im }
}

/** e^a for complex a. */
export function cexp(a: Cx): Cx {
  const e = Math.exp(a.re)
  return { re: e * Math.cos(a.im), im: e * Math.sin(a.im) }
}

/** Complex from magnitude + phase. */
export const cpolar = (mag: number, ang: number): Cx => ({
  re: mag * Math.cos(ang),
  im: mag * Math.sin(ang),
})

/** The point e^{jω} on the unit circle — the z we evaluate a filter at. */
export const cunit = (omega: number): Cx => ({ re: Math.cos(omega), im: Math.sin(omega) })

/** True when a lies within `eps` of the real axis. */
export const isReal = (a: Cx, eps = 1e-9): boolean => Math.abs(a.im) <= eps
