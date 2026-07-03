// A from-scratch Fast Fourier Transform.
//
// The workhorse is an in-place, iterative radix-2 Cooley–Tukey FFT (decimation in
// time). It runs in O(N log N) and requires N to be a power of two. For arbitrary
// lengths we fall back to a direct O(N^2) DFT, which the epicycle machine also uses
// to obtain the full set of complex coefficients for a resampled path.

import type { ComplexArray } from './complex'
import { makeComplex } from './complex'

export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0
}

export function nextPow2(n: number): number {
  if (n < 1) return 1
  let p = 1
  while (p < n) p <<= 1
  return p
}

// Reverse the low `bits` bits of `x`. Used to permute the input into
// bit-reversed order, the prerequisite for the in-place butterfly passes.
function reverseBits(x: number, bits: number): number {
  let r = 0
  for (let i = 0; i < bits; i++) {
    r = (r << 1) | (x & 1)
    x >>= 1
  }
  return r
}

/**
 * In-place radix-2 FFT. Mutates `a`. `inverse` selects the sign of the exponent
 * and, when true, divides the result by N so that ifft(fft(x)) === x.
 * Throws if the length is not a power of two.
 */
export function fftInPlace(a: ComplexArray, inverse = false): ComplexArray {
  const n = a.length
  if (n <= 1) return a
  if (!isPowerOfTwo(n)) {
    throw new Error(`fftInPlace requires a power-of-two length, got ${n}`)
  }
  const { re, im } = a
  const bits = Math.log2(n)

  // Bit-reversal permutation.
  for (let i = 0; i < n; i++) {
    const j = reverseBits(i, bits)
    if (j > i) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }

  const sign = inverse ? 1 : -1
  // Butterfly passes over successively larger halves.
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1
    const theta = (sign * 2 * Math.PI) / size
    const wRe = Math.cos(theta)
    const wIm = Math.sin(theta)
    for (let start = 0; start < n; start += size) {
      // Twiddle factor, advanced incrementally within each block.
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < half; k++) {
        const evenIdx = start + k
        const oddIdx = start + k + half
        const oRe = re[oddIdx]
        const oIm = im[oddIdx]
        // t = twiddle * odd
        const tRe = curRe * oRe - curIm * oIm
        const tIm = curRe * oIm + curIm * oRe
        re[oddIdx] = re[evenIdx] - tRe
        im[oddIdx] = im[evenIdx] - tIm
        re[evenIdx] += tRe
        im[evenIdx] += tIm
        // advance twiddle: cur *= w
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n
      im[i] /= n
    }
  }
  return a
}

/** Non-mutating forward FFT (power-of-two length). */
export function fft(a: ComplexArray): ComplexArray {
  const out = makeComplex(a.length)
  out.re.set(a.re)
  out.im.set(a.im)
  return fftInPlace(out, false)
}

/** Non-mutating inverse FFT (power-of-two length). */
export function ifft(a: ComplexArray): ComplexArray {
  const out = makeComplex(a.length)
  out.re.set(a.re)
  out.im.set(a.im)
  return fftInPlace(out, true)
}

/**
 * Direct discrete Fourier transform, O(N^2), for any length N. Slower but exact
 * and length-agnostic. `inverse` mirrors fftInPlace's convention (1/N scaling).
 */
export function dft(a: ComplexArray, inverse = false): ComplexArray {
  const n = a.length
  const out = makeComplex(n)
  const sign = inverse ? 1 : -1
  for (let k = 0; k < n; k++) {
    let sumRe = 0
    let sumIm = 0
    for (let t = 0; t < n; t++) {
      const angle = (sign * 2 * Math.PI * k * t) / n
      const c = Math.cos(angle)
      const s = Math.sin(angle)
      sumRe += a.re[t] * c - a.im[t] * s
      sumIm += a.re[t] * s + a.im[t] * c
    }
    if (inverse) {
      sumRe /= n
      sumIm /= n
    }
    out.re[k] = sumRe
    out.im[k] = sumIm
  }
  return out
}

/**
 * Transform of arbitrary length: uses the fast path when N is a power of two,
 * otherwise the direct DFT.
 */
export function transform(a: ComplexArray, inverse = false): ComplexArray {
  return isPowerOfTwo(a.length) ? (inverse ? ifft(a) : fft(a)) : dft(a, inverse)
}

/**
 * Shift the zero-frequency component to the center of the spectrum (numpy's
 * fftshift). Returns a new array. Useful when displaying magnitude with negative
 * frequencies on the left.
 */
export function fftShift(a: ComplexArray): ComplexArray {
  const n = a.length
  const out = makeComplex(n)
  const mid = Math.ceil(n / 2)
  for (let i = 0; i < n; i++) {
    const j = (i + mid) % n
    out.re[i] = a.re[j]
    out.im[i] = a.im[j]
  }
  return out
}

/** Real FFT convenience: transform a real signal, return the ComplexArray. */
export function rfft(signal: ArrayLike<number>): ComplexArray {
  const a = makeComplex(signal.length)
  for (let i = 0; i < signal.length; i++) a.re[i] = signal[i]
  return transform(a, false)
}
