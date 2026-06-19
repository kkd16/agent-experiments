// fft.ts — a from-scratch FFT and the kinetic-energy spectrum it powers.
//
// The velocity field hides structure the eye can't read: a turbulent flow looks
// like noise, but in Fourier space it has a *spectrum* — how much kinetic energy
// lives at each spatial scale. In two dimensions that spectrum tells a famous
// story (Kraichnan 1967): energy injected at one scale flows *up* to larger
// scales (the inverse cascade, E(k) ∝ k^−5/3) while enstrophy flows *down* to
// small scales (the forward-enstrophy cascade, E(k) ∝ k^−3). To see it we need a
// real Fourier transform — written here from scratch, no library.
//
// `fft1d` is an in-place iterative radix-2 Cooley–Tukey transform (bit-reversal
// permutation + butterfly stages); `fft2d` applies it along rows then columns.
// Everything is double precision so the round-trip and Parseval identities hold
// to machine precision (which the verify suite checks).

/**
 * In-place radix-2 Cooley–Tukey FFT of a complex signal held in parallel real /
 * imaginary arrays. `n = re.length` must be a power of two. `inverse` runs the
 * inverse transform (and divides by n, so ifft(fft(x)) = x).
 */
export function fft1d(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  // Butterfly stages.
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/**
 * 2-D FFT (in place) of an M×M complex field stored row-major. Transforms every
 * row, then every column — separability of the multidimensional DFT.
 */
export function fft2d(re: Float64Array, im: Float64Array, M: number, inverse: boolean): void {
  const rowRe = new Float64Array(M);
  const rowIm = new Float64Array(M);
  // Rows.
  for (let j = 0; j < M; j++) {
    const off = j * M;
    for (let i = 0; i < M; i++) {
      rowRe[i] = re[off + i];
      rowIm[i] = im[off + i];
    }
    fft1d(rowRe, rowIm, inverse);
    for (let i = 0; i < M; i++) {
      re[off + i] = rowRe[i];
      im[off + i] = rowIm[i];
    }
  }
  // Columns.
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < M; j++) {
      rowRe[j] = re[j * M + i];
      rowIm[j] = im[j * M + i];
    }
    fft1d(rowRe, rowIm, inverse);
    for (let j = 0; j < M; j++) {
      re[j * M + i] = rowRe[j];
      im[j * M + i] = rowIm[j];
    }
  }
}

export interface Spectrum {
  /** E(k) for integer wavenumber shells k = 0 … M/2 (energy in each shell). */
  e: Float64Array;
  /** Total kinetic energy summed from the spectrum (∑ₖ E(k)). */
  total: number;
}

/**
 * Radially-averaged kinetic-energy spectrum of a velocity field (u, v) sampled on
 * an M×M grid (M a power of two), treated as periodic. Returns E(k), the kinetic
 * energy in each integer-wavenumber shell, normalised so that ∑ₖ E(k) equals the
 * mean physical kinetic energy ½⟨u²+v²⟩ (Parseval's theorem). The k = 0 shell is
 * the mean-flow (DC) energy.
 */
export function energySpectrum(u: Float64Array, v: Float64Array, M: number): Spectrum {
  const ur = Float64Array.from(u);
  const ui = new Float64Array(M * M);
  const vr = Float64Array.from(v);
  const vi = new Float64Array(M * M);
  fft2d(ur, ui, M, false);
  fft2d(vr, vi, M, false);
  const kmax = M >> 1;
  const e = new Float64Array(kmax + 1);
  // Parseval in our convention: ∑ₓ |x|² = (1/M²) ∑_k |X|². We want the *mean*
  // energy ½⟨u²+v²⟩ = (1/M²)∑ₓ ½(u²+v²) = (1/M⁴) ∑_k ½(|û|²+|v̂|²).
  const norm = 1 / (M * M * M * M);
  let total = 0;
  for (let ky = 0; ky < M; ky++) {
    const kys = ky <= kmax ? ky : ky - M;
    for (let kx = 0; kx < M; kx++) {
      const kxs = kx <= kmax ? kx : kx - M;
      const k = Math.round(Math.hypot(kxs, kys));
      if (k > kmax) continue;
      const idx = ky * M + kx;
      const energy = 0.5 * (ur[idx] * ur[idx] + ui[idx] * ui[idx] + vr[idx] * vr[idx] + vi[idx] * vi[idx]) * norm;
      e[k] += energy;
      total += energy;
    }
  }
  return { e, total };
}

/** Mean physical kinetic energy ½⟨u²+v²⟩ over an M×M field — the Parseval target. */
export function meanKineticEnergy(u: Float64Array, v: Float64Array, M: number): number {
  let s = 0;
  for (let i = 0; i < M * M; i++) s += 0.5 * (u[i] * u[i] + v[i] * v[i]);
  return s / (M * M);
}
