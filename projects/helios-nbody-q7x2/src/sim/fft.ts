// A minimal, dependency-free radix-2 Cooley–Tukey FFT on split real/imaginary
// Float64 arrays. It is the coarse-search workhorse inside the NAFF spectral
// analyser (`naff.ts`): a length-N FFT locates the dominant frequency to within
// one bin, after which NAFF refines it continuously to far below bin resolution.
//
// The transform is in place and iterative (no recursion, no allocation): a
// bit-reversal permutation followed by ⌈log₂N⌉ butterfly stages. The forward
// transform uses the e^{-2πi·mk/N} kernel; the inverse divides by N. Lengths must
// be a power of two — `nextPow2`/`isPow2` help the caller arrange that.

/** True when `n` is a positive power of two. */
export function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0
}

/** Smallest power of two ≥ `n` (≥ 1). */
export function nextPow2(n: number): number {
  let p = 1
  while (p < n) p <<= 1
  return p
}

// In-place transform. `sign = -1` is the forward (analysis) kernel; `sign = +1`
// the inverse kernel (left un-normalised — `ifft` divides by N afterwards). The
// twiddle factors are advanced by a single complex multiply per butterfly via the
// recurrence wᵏ⁺¹ = wᵏ·w, so no trig runs in the inner loop.
function transform(re: Float64Array, im: Float64Array, sign: number): void {
  const n = re.length
  if (n <= 1) return

  // Decimation-in-time bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr
      const ti = im[i]; im[i] = im[j]; im[j] = ti
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const ang = (sign * 2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        // t = w·x[b]
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        // Advance the twiddle factor: (cr,ci) ← (cr,ci)·(wr,wi).
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

/** Forward FFT, in place. Length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  transform(re, im, -1)
}

/** Inverse FFT, in place (normalised by 1/N). Length must be a power of two. */
export function ifft(re: Float64Array, im: Float64Array): void {
  transform(re, im, 1)
  const n = re.length
  const inv = 1 / n
  for (let i = 0; i < n; i++) {
    re[i] *= inv
    im[i] *= inv
  }
}
