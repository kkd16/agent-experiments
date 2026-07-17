// The separable 2-D discrete wavelet transform — the heart of JPEG-2000.
//
// The 2-D transform is separable: at each level you run the 1-D DWT along every
// row, then along every column of the result. That splits the image into four
// quarter-size subbands — LL (a smaller copy of the image), LH, HL, HH (the
// horizontal, vertical and diagonal detail) — and you recurse on LL. The result
// is the familiar wavelet "pyramid" of an image, and because it is built from
// the exact 1-D dwtStep/idwtStep (dwt.ts), perfect reconstruction is inherited
// for every wavelet, orthogonal or biorthogonal.
//
// Compression is then almost embarrassingly simple: keep only the largest
// coefficients and throw the rest away. A natural image concentrates its energy
// into a tiny fraction of wavelet coefficients, so keeping ~5% of them still
// reconstructs a recognisable picture — that is the whole idea behind wavelet
// image coding.

import { dwtStep, idwtStep, type FilterBank } from './dwt'

/** Forward 2-D DWT of a square n×n image (n a power of two). Returns the packed
 *  subband pyramid, same length as the input. */
export function dwt2(img: Float64Array, n: number, bank: FilterBank, levels: number): Float64Array {
  const data = img.slice()
  let size = n
  for (let l = 0; l < levels; l++) {
    const half = size >> 1
    // transform every row of the current top-left block
    const row = new Float64Array(size)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) row[x] = data[y * n + x]
      const { cA, cD } = dwtStep(row, bank)
      for (let x = 0; x < half; x++) {
        data[y * n + x] = cA[x]
        data[y * n + half + x] = cD[x]
      }
    }
    // transform every column of the current top-left block
    const col = new Float64Array(size)
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) col[y] = data[y * n + x]
      const { cA, cD } = dwtStep(col, bank)
      for (let y = 0; y < half; y++) {
        data[y * n + x] = cA[y]
        data[(half + y) * n + x] = cD[y]
      }
    }
    size = half
  }
  return data
}

/** Inverse 2-D DWT — exact inverse of dwt2. */
export function idwt2(coeffs: Float64Array, n: number, bank: FilterBank, levels: number): Float64Array {
  const out = coeffs.slice()
  for (let l = levels - 1; l >= 0; l--) {
    const size = n >> l
    const half = size >> 1
    // inverse columns (undo the last forward step first)
    const cA = new Float64Array(half)
    const cD = new Float64Array(half)
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < half; y++) {
        cA[y] = out[y * n + x]
        cD[y] = out[(half + y) * n + x]
      }
      const rec = idwtStep(cA, cD, bank)
      for (let y = 0; y < size; y++) out[y * n + x] = rec[y]
    }
    // inverse rows
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < half; x++) {
        cA[x] = out[y * n + x]
        cD[x] = out[y * n + half + x]
      }
      const rec = idwtStep(cA, cD, bank)
      for (let x = 0; x < size; x++) out[y * n + x] = rec[x]
    }
  }
  return out
}

/** Peak signal-to-noise ratio (dB) between two images sharing a peak value. */
export function psnr(ref: Float64Array, est: Float64Array, peak = 1): number {
  let mse = 0
  for (let i = 0; i < ref.length; i++) {
    const e = ref[i] - est[i]
    mse += e * e
  }
  mse /= ref.length
  return 10 * Math.log10((peak * peak) / Math.max(mse, 1e-30))
}

export interface Compressed {
  coeffs: Float64Array // full transform
  kept: Float64Array // transform after thresholding
  rec: Float64Array // reconstructed image
  threshold: number
  keptCount: number
  psnr: number
}

/**
 * Wavelet image compression by coefficient thresholding: transform, keep the
 * `keepFraction` largest-magnitude coefficients, zero the rest, invert.
 */
export function compress2(
  img: Float64Array,
  n: number,
  bank: FilterBank,
  levels: number,
  keepFraction: number,
): Compressed {
  const coeffs = dwt2(img, n, bank, levels)
  const mags = Float64Array.from(coeffs, Math.abs).sort()
  const total = mags.length
  const keepN = Math.max(1, Math.min(total, Math.round(keepFraction * total)))
  // threshold = the (total-keepN)-th smallest magnitude (so keepN survive)
  const threshold = mags[total - keepN]
  const kept = new Float64Array(total)
  let keptCount = 0
  for (let i = 0; i < total; i++) {
    if (Math.abs(coeffs[i]) >= threshold && threshold > 0) {
      kept[i] = coeffs[i]
      keptCount++
    } else if (threshold === 0) {
      kept[i] = coeffs[i]
      keptCount++
    }
  }
  const rec = idwt2(kept, n, bank, levels)
  let peak = 0
  for (let i = 0; i < img.length; i++) peak = Math.max(peak, Math.abs(img[i]))
  return { coeffs, kept, rec, threshold, keptCount, psnr: psnr(img, rec, peak || 1) }
}
