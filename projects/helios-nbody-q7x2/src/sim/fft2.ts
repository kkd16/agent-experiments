// A 2-D FFT, built row-by-column on the existing 1-D radix-2 transform (`fft.ts`).
//
// The Particle-Mesh gravity solver (`pm.ts`) solves Poisson's equation on a square
// mesh by taking the whole density field into Fourier space, dividing by −k², and
// coming back. That needs a 2-D transform. A 2-D DFT is separable — transform every
// row, then every column (or vice-versa) — so a from-scratch 2-D FFT is just the 1-D
// FFT applied along each axis in turn. Fields are stored **row-major** in a single
// Float64Array of length M·M (row r, column c → index r·M + c), with real and
// imaginary parts in separate arrays, matching `fft.ts`'s split-array convention.

import { fft, ifft } from './fft'

/** Forward 2-D FFT, in place. `m` is the side length (a power of two). */
export function fft2(re: Float64Array, im: Float64Array, m: number): void {
  transform2(re, im, m, false)
}

/** Inverse 2-D FFT, in place (normalised by 1/M²). */
export function ifft2(re: Float64Array, im: Float64Array, m: number): void {
  transform2(re, im, m, true)
}

// Row-column decomposition. A scratch length-M complex vector is reused for every
// row and column so the transform allocates O(M), not O(M²).
function transform2(re: Float64Array, im: Float64Array, m: number, inverse: boolean): void {
  const line1d = inverse ? ifft : fft
  const sr = new Float64Array(m)
  const si = new Float64Array(m)

  // Rows: each row is already contiguous, so transform it in a scratch buffer and
  // write it back.
  for (let r = 0; r < m; r++) {
    const base = r * m
    for (let c = 0; c < m; c++) {
      sr[c] = re[base + c]
      si[c] = im[base + c]
    }
    line1d(sr, si)
    for (let c = 0; c < m; c++) {
      re[base + c] = sr[c]
      im[base + c] = si[c]
    }
  }

  // Columns: gather the strided column into the scratch buffer, transform, scatter.
  for (let c = 0; c < m; c++) {
    for (let r = 0; r < m; r++) {
      sr[r] = re[r * m + c]
      si[r] = im[r * m + c]
    }
    line1d(sr, si)
    for (let r = 0; r < m; r++) {
      re[r * m + c] = sr[r]
      im[r * m + c] = si[r]
    }
  }
}

// A naive O(M⁴) 2-D DFT, used only by the self-test as an independent oracle for the
// FFT (small grids only). Returns fresh output arrays.
export function dft2Ref(
  re: Float64Array,
  im: Float64Array,
  m: number,
): { re: Float64Array; im: Float64Array } {
  const outR = new Float64Array(m * m)
  const outI = new Float64Array(m * m)
  const twoPi = 2 * Math.PI
  for (let ku = 0; ku < m; ku++) {
    for (let kv = 0; kv < m; kv++) {
      let accR = 0
      let accI = 0
      for (let r = 0; r < m; r++) {
        for (let c = 0; c < m; c++) {
          const ang = -twoPi * ((ku * r) / m + (kv * c) / m)
          const cr = Math.cos(ang)
          const ci = Math.sin(ang)
          const vr = re[r * m + c]
          const vi = im[r * m + c]
          accR += vr * cr - vi * ci
          accI += vr * ci + vi * cr
        }
      }
      outR[ku * m + kv] = accR
      outI[ku * m + kv] = accI
    }
  }
  return { re: outR, im: outI }
}

/**
 * The integer wavenumber along one axis for FFT bin `i` on a length-`m` transform,
 * wrapped into (−M/2, M/2]. Bin 0 is the DC term; bins above M/2 are negative
 * frequencies. This is what turns an FFT index into a physical `k`.
 */
export function wavenumber(i: number, m: number): number {
  return i <= m / 2 ? i : i - m
}
