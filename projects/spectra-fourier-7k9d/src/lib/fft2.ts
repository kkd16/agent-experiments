// A from-scratch two-dimensional FFT, built on the same 1-D radix-2 core.
//
// The 2-D DFT is separable: transforming an image is exactly "FFT every row,
// then FFT every column" (or vice-versa). We reuse `fftInPlace` on scratch
// ComplexArrays for each line, so there is still no external math anywhere.
//
// Fields are stored row-major as parallel Float64Arrays (re / im), the same
// struct-of-arrays convention as the 1-D core.

import { makeComplex } from './complex'
import { fftInPlace, isPowerOfTwo } from './fft'

export interface Field2D {
  width: number
  height: number
  re: Float64Array
  im: Float64Array
}

export function makeField(width: number, height: number): Field2D {
  return { width, height, re: new Float64Array(width * height), im: new Float64Array(width * height) }
}

/** Build a complex field from a real-valued grayscale buffer (imaginary = 0). */
export function fieldFromGray(gray: ArrayLike<number>, width: number, height: number): Field2D {
  const f = makeField(width, height)
  const n = width * height
  for (let i = 0; i < n; i++) f.re[i] = gray[i]
  return f
}

export function cloneField(f: Field2D): Field2D {
  return { width: f.width, height: f.height, re: f.re.slice(), im: f.im.slice() }
}

/**
 * In-place 2-D FFT (both dimensions must be powers of two). `inverse` divides by
 * width·height overall, so ifft2(fft2(x)) === x. Mutates and returns `f`.
 */
export function fft2(f: Field2D, inverse = false): Field2D {
  const { width: w, height: h, re, im } = f
  if (!isPowerOfTwo(w) || !isPowerOfTwo(h)) {
    throw new Error(`fft2 requires power-of-two dimensions, got ${w}x${h}`)
  }

  // Transform each row.
  const row = makeComplex(w)
  for (let y = 0; y < h; y++) {
    const base = y * w
    for (let x = 0; x < w; x++) {
      row.re[x] = re[base + x]
      row.im[x] = im[base + x]
    }
    fftInPlace(row, inverse)
    for (let x = 0; x < w; x++) {
      re[base + x] = row.re[x]
      im[base + x] = row.im[x]
    }
  }

  // Transform each column.
  const col = makeComplex(h)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const idx = y * w + x
      col.re[y] = re[idx]
      col.im[y] = im[idx]
    }
    fftInPlace(col, inverse)
    for (let y = 0; y < h; y++) {
      const idx = y * w + x
      re[idx] = col.re[y]
      im[idx] = col.im[y]
    }
  }

  return f
}

/**
 * Swap the four quadrants so the DC (zero-frequency) component moves from the
 * corner to the center of the field — the conventional way to view a 2-D
 * spectrum. Returns a new field. For power-of-two (even) sizes this operation is
 * its own inverse.
 */
export function fftShift2(f: Field2D): Field2D {
  const { width: w, height: h } = f
  const out = makeField(w, h)
  const hx = w >> 1
  const hy = h >> 1
  for (let y = 0; y < h; y++) {
    const sy = (y + hy) % h
    for (let x = 0; x < w; x++) {
      const sx = (x + hx) % w
      const di = y * w + x
      const si = sy * w + sx
      out.re[di] = f.re[si]
      out.im[di] = f.im[si]
    }
  }
  return out
}

/** Elementwise magnitude of a field. */
export function magnitude2(f: Field2D): Float64Array {
  const n = f.width * f.height
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.hypot(f.re[i], f.im[i])
  return out
}

/**
 * Perceptually useful log-magnitude, normalized to [0,1]. Raw spectra span many
 * orders of magnitude and are dominated by DC; log compression makes the
 * structure visible. Returns a fresh Float64Array.
 */
export function logMagnitude2(f: Field2D): Float64Array {
  const n = f.width * f.height
  const out = new Float64Array(n)
  let max = 0
  for (let i = 0; i < n; i++) {
    const v = Math.log1p(Math.hypot(f.re[i], f.im[i]))
    out[i] = v
    if (v > max) max = v
  }
  const inv = max > 0 ? 1 / max : 0
  for (let i = 0; i < n; i++) out[i] *= inv
  return out
}

/** Extract the real part (used after an inverse transform). */
export function realPart(f: Field2D): Float64Array {
  return f.re.slice()
}
