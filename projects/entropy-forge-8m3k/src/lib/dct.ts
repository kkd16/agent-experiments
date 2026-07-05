// dct.ts — the 8×8 Discrete Cosine Transform (DCT-II), JPEG's decorrelating
// transform. This is the one genuinely new idea the lossy pillar adds: instead
// of modelling the *symbols* of a byte stream, we change basis so that most of a
// natural image's energy collapses into a few low-frequency coefficients, and
// then spend bits only where the eye can see them.
//
// The transform is the separable, orthonormal 2-D DCT-II defined by ITU-T T.81:
//
//   F(u,v) = ¼·C(u)·C(v)·Σ_x Σ_y f(x,y)·cos((2x+1)uπ/16)·cos((2y+1)vπ/16)
//
// with C(0)=1/√2 and C(k)=1 for k>0. Because the basis is orthonormal, the
// inverse is the exact transpose — no separate normalisation — so
// idct8x8(fdct8x8(b)) is the identity up to floating-point rounding, which the
// self-test verifies. We keep everything in plain Float64 arrays of length 64
// (row-major, x = column, y = row).

const N = 8

// M[u][x] = α(u)·cos((2x+1)uπ/16), the 1-D orthonormal DCT-II basis matrix.
// α(0)=√(1/8), α(k>0)=½. A row-then-column application of M realises the 2-D
// transform: F = M · B · Mᵀ, and its inverse B = Mᵀ · F · M.
const M: Float64Array = (() => {
  const m = new Float64Array(N * N)
  for (let u = 0; u < N; u++) {
    const alpha = u === 0 ? Math.sqrt(1 / N) : Math.sqrt(2 / N)
    for (let x = 0; x < N; x++) {
      m[u * N + x] = alpha * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N))
    }
  }
  return m
})()

/** Forward 8×8 DCT-II. `block` is 64 spatial samples (already level-shifted);
 *  returns 64 frequency coefficients in natural (row-major) order. */
export function fdct8x8(block: Float64Array | number[], out?: Float64Array): Float64Array {
  const tmp = new Float64Array(N * N)
  // rows: tmp = M · block  (transform each row of the block)
  for (let u = 0; u < N; u++) {
    for (let x = 0; x < N; x++) {
      let s = 0
      for (let k = 0; k < N; k++) s += M[u * N + k] * block[x * N + k]
      tmp[x * N + u] = s
    }
  }
  // columns: out = tmp · Mᵀ  (transform each column)
  const res = out ?? new Float64Array(N * N)
  for (let v = 0; v < N; v++) {
    for (let x = 0; x < N; x++) {
      let s = 0
      for (let k = 0; k < N; k++) s += M[v * N + k] * tmp[k * N + x]
      res[v * N + x] = s
    }
  }
  return res
}

/** Inverse 8×8 DCT-II. `coef` is 64 frequency coefficients (dequantised);
 *  returns 64 spatial samples (still to be un-level-shifted / clamped). */
export function idct8x8(coef: Float64Array | number[], out?: Float64Array): Float64Array {
  const tmp = new Float64Array(N * N)
  // columns first: tmp = Mᵀ · coef
  for (let x = 0; x < N; x++) {
    for (let v = 0; v < N; v++) {
      let s = 0
      for (let k = 0; k < N; k++) s += M[k * N + x] * coef[k * N + v]
      tmp[x * N + v] = s
    }
  }
  // rows: out = tmp · M  (== (Mᵀ·coef·M) overall, the transpose of the forward)
  const res = out ?? new Float64Array(N * N)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let s = 0
      for (let k = 0; k < N; k++) s += tmp[y * N + k] * M[k * N + x]
      res[y * N + x] = s
    }
  }
  return res
}

// The JPEG zig-zag scan (Annex A, Figure A.6): read an 8×8 block in order of
// increasing spatial frequency so that the run of high-frequency zeros the
// quantiser produces lands contiguously at the tail, where run-length coding
// crushes it. `ZIGZAG[k]` is the natural-order index of the k-th zig-zag position.
export const ZIGZAG: readonly number[] = [
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
]

// Inverse permutation: DEZIGZAG[naturalIndex] = zig-zag position.
export const DEZIGZAG: readonly number[] = (() => {
  const d = new Array<number>(64)
  for (let k = 0; k < 64; k++) d[ZIGZAG[k]] = k
  return d
})()
