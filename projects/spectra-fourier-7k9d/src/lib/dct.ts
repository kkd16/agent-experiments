// The Discrete Cosine Transform and a from-scratch JPEG-style block codec.
//
// The DFT assumes the signal repeats; splicing sample N−1 back to sample 0
// usually makes a jump, and a jump costs high-frequency energy. The DCT-II
// instead reflects the block to make it *even*, killing that artificial jump, so
// almost all the energy piles into the lowest few coefficients — which is exactly
// why it, not the DFT, sits at the heart of JPEG, MP3 and every video codec.
//
//   DCT-II :  X[k] = √(2/N)·c(k)·Σₙ x[n]·cos( π(2n+1)k / 2N )
//   DCT-III:  x[n] = √(2/N)·Σₖ c(k)·X[k]·cos( π(2n+1)k / 2N )   (the inverse)
//   with c(0)=1/√2, c(k)=1 otherwise. In this orthonormal form DCT-III = DCT-IIᵀ,
//   so the transform is an orthogonal rotation and inverts exactly.
//
// JPEG works on 8×8 blocks: level-shift, 2-D DCT (separable — rows then columns),
// divide each coefficient by a quantisation table entry and round (this is the
// only lossy step, and where the quality knob lives), then reverse. Everything
// here is direct O(N²) per block — N is 8, so it is plenty fast and stays legible.

export const BLOCK = 8

// Precomputed orthonormal DCT-II basis matrix M[k][n] for N = BLOCK.
// Forward: X = M · x. Inverse: x = Mᵀ · X (because M is orthogonal).
function buildBasis(N: number): Float64Array[] {
  const M: Float64Array[] = []
  const s0 = Math.sqrt(1 / N)
  const s = Math.sqrt(2 / N)
  for (let k = 0; k < N; k++) {
    const row = new Float64Array(N)
    const scale = k === 0 ? s0 : s
    for (let n = 0; n < N; n++) {
      row[n] = scale * Math.cos((Math.PI * (2 * n + 1) * k) / (2 * N))
    }
    M.push(row)
  }
  return M
}

const M8 = buildBasis(BLOCK)

/** 1-D orthonormal DCT-II of an N-vector (N = BLOCK). */
export function dct1d(x: ArrayLike<number>): Float64Array {
  const N = BLOCK
  const out = new Float64Array(N)
  for (let k = 0; k < N; k++) {
    const row = M8[k]
    let sum = 0
    for (let n = 0; n < N; n++) sum += row[n] * x[n]
    out[k] = sum
  }
  return out
}

/** 1-D inverse (orthonormal DCT-III) of an N-vector (N = BLOCK). */
export function idct1d(X: ArrayLike<number>): Float64Array {
  const N = BLOCK
  const out = new Float64Array(N)
  for (let n = 0; n < N; n++) {
    let sum = 0
    for (let k = 0; k < N; k++) sum += M8[k][n] * X[k]
    out[n] = sum
  }
  return out
}

/** 2-D DCT-II of an 8×8 block (row-major, length 64). Separable: rows then cols. */
export function dct2d(block: ArrayLike<number>): Float64Array {
  const N = BLOCK
  const tmp = new Float64Array(N * N)
  const row = new Float64Array(N)
  // Rows.
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) row[x] = block[y * N + x]
    const r = dct1d(row)
    for (let x = 0; x < N; x++) tmp[y * N + x] = r[x]
  }
  // Columns.
  const out = new Float64Array(N * N)
  const col = new Float64Array(N)
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) col[y] = tmp[y * N + x]
    const c = dct1d(col)
    for (let y = 0; y < N; y++) out[y * N + x] = c[y]
  }
  return out
}

/** 2-D inverse DCT of an 8×8 coefficient block (length 64). */
export function idct2d(coeff: ArrayLike<number>): Float64Array {
  const N = BLOCK
  const tmp = new Float64Array(N * N)
  const col = new Float64Array(N)
  // Columns first (inverse of the forward's column pass).
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) col[y] = coeff[y * N + x]
    const c = idct1d(col)
    for (let y = 0; y < N; y++) tmp[y * N + x] = c[y]
  }
  const out = new Float64Array(N * N)
  const row = new Float64Array(N)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) row[x] = tmp[y * N + x]
    const r = idct1d(row)
    for (let x = 0; x < N; x++) out[y * N + x] = r[x]
  }
  return out
}

// The standard JPEG (Annex K) luminance quantisation table, in zig-zag-natural
// (row-major) order. Bigger numbers = coarser quantisation of that frequency;
// note how it climbs toward the high-frequency bottom-right, matching the eye's
// falling sensitivity to fine detail.
export const JPEG_LUMA_Q: number[] = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
]

/**
 * Scale the base quantisation table by a JPEG "quality" (1..100) using the
 * classic IJG formula, clamped so every entry is ≥ 1.
 */
export function qTableForQuality(quality: number): Float64Array {
  const q = Math.max(1, Math.min(100, quality))
  const s = q < 50 ? 5000 / q : 200 - 2 * q
  const out = new Float64Array(BLOCK * BLOCK)
  for (let i = 0; i < out.length; i++) {
    const v = Math.floor((JPEG_LUMA_Q[i] * s + 50) / 100)
    out[i] = Math.max(1, v)
  }
  return out
}

// The JPEG zig-zag scan order (index → natural position), low frequencies first.
export const ZIGZAG: number[] = (() => {
  const order: number[] = []
  const N = BLOCK
  for (let s = 0; s < 2 * N - 1; s++) {
    if (s % 2 === 0) {
      for (let y = Math.min(s, N - 1); y >= 0 && s - y < N; y--) order.push(y * N + (s - y))
    } else {
      for (let x = Math.min(s, N - 1); x >= 0 && s - x < N; x--) order.push((s - x) * N + x)
    }
  }
  return order
})()

export interface CompressResult {
  recon: Float64Array // reconstructed image [0,1], same size as input
  residual: Float64Array // |orig − recon| in [0,1] (unamplified)
  psnr: number // dB
  nonzero: number // number of non-zero quantised coefficients
  total: number // total coefficients (= pixels)
  entropyBpp: number // order-0 entropy of the quantised coefficients (bits/pixel)
  ratio: number // 8 bpp / entropyBpp
}

/**
 * Run the full JPEG-lite pipeline over a grayscale image ([0,1], row-major).
 * Blocks that hang off the right/bottom edge reuse edge pixels. Returns the
 * reconstruction plus honest rate/distortion metrics.
 */
export function compressImage(gray: Float64Array, width: number, height: number, quality: number): CompressResult {
  const qt = qTableForQuality(quality)
  const recon = new Float64Array(width * height)
  const N = BLOCK
  const block = new Float64Array(N * N)
  let nonzero = 0
  const histo = new Map<number, number>()
  let coeffCount = 0

  for (let by = 0; by < height; by += N) {
    for (let bx = 0; bx < width; bx += N) {
      // Gather a block, level-shifted to [−128,128) in 8-bit units (×255 first).
      for (let y = 0; y < N; y++) {
        const sy = Math.min(by + y, height - 1)
        for (let x = 0; x < N; x++) {
          const sx = Math.min(bx + x, width - 1)
          block[y * N + x] = gray[sy * width + sx] * 255 - 128
        }
      }
      const coeff = dct2d(block)
      // Quantise → count stats → dequantise.
      for (let i = 0; i < N * N; i++) {
        const q = Math.round(coeff[i] / qt[i])
        if (q !== 0) nonzero++
        histo.set(q, (histo.get(q) ?? 0) + 1)
        coeffCount++
        coeff[i] = q * qt[i]
      }
      const rec = idct2d(coeff)
      for (let y = 0; y < N; y++) {
        const sy = by + y
        if (sy >= height) break
        for (let x = 0; x < N; x++) {
          const sx = bx + x
          if (sx >= width) break
          const v = (rec[y * N + x] + 128) / 255
          recon[sy * width + sx] = Math.max(0, Math.min(1, v))
        }
      }
    }
  }

  // Distortion.
  let mse = 0
  const residual = new Float64Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const d = gray[i] - recon[i]
    residual[i] = Math.abs(d)
    mse += d * d
  }
  mse /= width * height
  const psnr = mse < 1e-12 ? Infinity : 10 * Math.log10(1 / mse)

  // Rate: order-0 entropy of the quantised coefficient stream (a lower bound on
  // what an ideal entropy coder — JPEG's Huffman/arithmetic stage — would spend).
  let entropy = 0
  for (const count of histo.values()) {
    const p = count / coeffCount
    entropy -= p * Math.log2(p)
  }
  const entropyBpp = entropy // one coefficient per pixel
  const ratio = entropyBpp > 1e-6 ? 8 / entropyBpp : Infinity

  return {
    recon,
    residual,
    psnr,
    nonzero,
    total: width * height,
    entropyBpp,
    ratio,
  }
}

/** DCT coefficients (log-magnitude) of a single 8×8 block at (bx,by), for display. */
export function blockCoeffs(gray: Float64Array, width: number, height: number, bx: number, by: number): Float64Array {
  const N = BLOCK
  const block = new Float64Array(N * N)
  for (let y = 0; y < N; y++) {
    const sy = Math.min(by + y, height - 1)
    for (let x = 0; x < N; x++) {
      const sx = Math.min(bx + x, width - 1)
      block[y * N + x] = gray[sy * width + sx] * 255 - 128
    }
  }
  return dct2d(block)
}
