// Biorthogonal wavelets by the lifting scheme — the CDF 5/3 and 9/7 transforms
// that JPEG-2000 uses for lossless and lossy image coding.
//
// Orthonormal wavelets (dwt.ts) can never be symmetric — a hard theorem (Haar is
// the only exception). Symmetry matters: a symmetric filter is linear-phase, so
// it does not smear edges the way an asymmetric one does, which is exactly why
// image codecs use *biorthogonal* wavelets. Their analysis and synthesis filters
// differ (they are dual bases, not one self-dual basis), and both can be
// symmetric.
//
// Rather than juggle two filter pairs and their alignment, we use the **lifting
// scheme** (Sweldens 1996; Daubechies & Sweldens 1998): the transform is a
// sequence of "predict" and "update" steps between the even and odd samples.
// Every step is trivially invertible — you undo it by running it backwards with
// the sign flipped — so **perfect reconstruction is structural and exact**, with
// no filter-alignment bookkeeping at all. This is precisely how the JPEG-2000
// reference codec computes the 5/3 and 9/7 transforms.

export interface Lifted {
  cA: Float64Array // approximation (even lattice), length N/2
  cD: Float64Array // detail (odd lattice), length N/2
}

const wrapLo = (i: number, n: number) => (i - 1 + n) % n // i−1 mod n
const wrapHi = (i: number, n: number) => (i + 1) % n // i+1 mod n

// --- CDF 5/3 (LeGall) — two lifting steps, no scaling (the reversible form) ---

export function cdf53Forward(x: Float64Array): Lifted {
  const N = x.length
  const half = N >> 1
  const s = new Float64Array(half)
  const d = new Float64Array(half)
  for (let i = 0; i < half; i++) {
    s[i] = x[2 * i]
    d[i] = x[2 * i + 1]
  }
  // predict: detail = odd − average of neighbouring evens
  for (let i = 0; i < half; i++) d[i] -= 0.5 * (s[i] + s[wrapHi(i, half)])
  // update: smooth the evens with the new details
  for (let i = 0; i < half; i++) s[i] += 0.25 * (d[wrapLo(i, half)] + d[i])
  return { cA: s, cD: d }
}

export function cdf53Inverse(cA: Float64Array, cD: Float64Array): Float64Array {
  const half = cA.length
  const N = half * 2
  const s = cA.slice()
  const d = cD.slice()
  for (let i = 0; i < half; i++) s[i] -= 0.25 * (d[wrapLo(i, half)] + d[i]) // undo update
  for (let i = 0; i < half; i++) d[i] += 0.5 * (s[i] + s[wrapHi(i, half)]) // undo predict
  const x = new Float64Array(N)
  for (let i = 0; i < half; i++) {
    x[2 * i] = s[i]
    x[2 * i + 1] = d[i]
  }
  return x
}

// --- CDF 9/7 — four lifting steps + a scaling, the classic Daubechies–Feauveau
//     constants (Daubechies & Sweldens 1998, "Factoring wavelet transforms") ---

const A97 = -1.586134342059924
const B97 = -0.052980118572961
const C97 = 0.882911075530934
const D97 = 0.443506852043971
const K97 = 1.230174104914001

export function cdf97Forward(x: Float64Array): Lifted {
  const N = x.length
  const half = N >> 1
  const s = new Float64Array(half)
  const d = new Float64Array(half)
  for (let i = 0; i < half; i++) {
    s[i] = x[2 * i]
    d[i] = x[2 * i + 1]
  }
  for (let i = 0; i < half; i++) d[i] += A97 * (s[i] + s[wrapHi(i, half)]) // predict 1
  for (let i = 0; i < half; i++) s[i] += B97 * (d[wrapLo(i, half)] + d[i]) // update 1
  for (let i = 0; i < half; i++) d[i] += C97 * (s[i] + s[wrapHi(i, half)]) // predict 2
  for (let i = 0; i < half; i++) s[i] += D97 * (d[wrapLo(i, half)] + d[i]) // update 2
  for (let i = 0; i < half; i++) {
    s[i] /= K97
    d[i] *= K97
  }
  return { cA: s, cD: d }
}

export function cdf97Inverse(cA: Float64Array, cD: Float64Array): Float64Array {
  const half = cA.length
  const N = half * 2
  const s = cA.slice()
  const d = cD.slice()
  for (let i = 0; i < half; i++) {
    s[i] *= K97
    d[i] /= K97
  }
  for (let i = 0; i < half; i++) s[i] -= D97 * (d[wrapLo(i, half)] + d[i]) // undo update 2
  for (let i = 0; i < half; i++) d[i] -= C97 * (s[i] + s[wrapHi(i, half)]) // undo predict 2
  for (let i = 0; i < half; i++) s[i] -= B97 * (d[wrapLo(i, half)] + d[i]) // undo update 1
  for (let i = 0; i < half; i++) d[i] -= A97 * (s[i] + s[wrapHi(i, half)]) // undo predict 1
  const x = new Float64Array(N)
  for (let i = 0; i < half; i++) {
    x[2 * i] = s[i]
    x[2 * i + 1] = d[i]
  }
  return x
}

// Analysis low-pass / high-pass taps of each biorthogonal pair — used only to
// draw the filter frequency response (the transform itself runs by lifting).
export const BIOR_ANALYSIS: Record<string, { lo: number[]; hi: number[] }> = {
  cdf53: {
    lo: [-1 / 8, 1 / 4, 3 / 4, 1 / 4, -1 / 8].map((v) => v * Math.SQRT2),
    hi: [-1 / 2, 1, -1 / 2].map((v) => v * Math.SQRT2),
  },
  cdf97: {
    lo: [
      0.026748757411, -0.016864118443, -0.078223266529, 0.266864118443, 0.602949018236,
      0.266864118443, -0.078223266529, -0.016864118443, 0.026748757411,
    ].map((v) => v * Math.SQRT2),
    hi: [
      0.045635881557, -0.028771763114, -0.295635881557, 0.557543526229, -0.295635881557,
      -0.028771763114, 0.045635881557,
    ].map((v) => v * Math.SQRT2),
  },
}
