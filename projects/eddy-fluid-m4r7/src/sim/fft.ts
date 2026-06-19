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

/** Signed wavenumber index for FFT bin m on an M-point transform: 0..M/2 stay, the
 *  upper half wraps to negative frequencies. */
function signedK(m: number, M: number): number {
  return m <= M >> 1 ? m : m - M;
}

/**
 * Radially-averaged **variance spectrum** of a scalar field (e.g. dye / a passive
 * tracer) sampled on an M×M grid, treated as periodic. The field is de-meaned
 * first (the k = 0 mode carries the mean and is excluded from variance), then
 * ½? no — binned as |ŝ(k)|², normalised so that ∑_{k≥1} V(k) equals the spatial
 * **variance** ⟨s²⟩ − ⟨s⟩². This is the scalar analogue of the kinetic-energy
 * spectrum: it shows at which scales a stirred dye carries its structure, and its
 * decay encodes the Batchelor / inertial-convective scaling of scalar turbulence.
 */
export function scalarVarianceSpectrum(s: Float64Array, M: number): Spectrum {
  const re = Float64Array.from(s);
  const im = new Float64Array(M * M);
  // De-mean so the variance (not the mean²) is what the spectrum integrates to.
  let mean = 0;
  for (let i = 0; i < M * M; i++) mean += re[i];
  mean /= M * M;
  for (let i = 0; i < M * M; i++) re[i] -= mean;
  fft2d(re, im, M, false);
  const kmax = M >> 1;
  const e = new Float64Array(kmax + 1);
  const norm = 1 / (M * M * M * M);
  let total = 0;
  for (let ky = 0; ky < M; ky++) {
    const kys = signedK(ky, M);
    for (let kx = 0; kx < M; kx++) {
      const kxs = signedK(kx, M);
      const k = Math.round(Math.hypot(kxs, kys));
      if (k > kmax) continue;
      const idx = ky * M + kx;
      const val = (re[idx] * re[idx] + im[idx] * im[idx]) * norm;
      e[k] += val;
      total += val;
    }
  }
  return { e, total };
}

/**
 * Radially-averaged **enstrophy spectrum** Z(k) = ½⟨|ω̂(k)|²⟩, where the vorticity
 * ω = ∂v/∂x − ∂u/∂y is taken *spectrally* (ω̂ = i·2π(kₓv̂ − k_yû) on the unit
 * torus). In 2-D turbulence enstrophy, not energy, cascades *down* to small scales
 * (Z(k) ∝ k^{1/3} in the Kraichnan forward-enstrophy range), which is the dual of
 * the inverse energy cascade. Normalised so ∑ₖ Z(k) = ½⟨ω²⟩, the mean enstrophy.
 */
export function enstrophySpectrum(u: Float64Array, v: Float64Array, M: number): Spectrum {
  const ur = Float64Array.from(u);
  const ui = new Float64Array(M * M);
  const vr = Float64Array.from(v);
  const vi = new Float64Array(M * M);
  fft2d(ur, ui, M, false);
  fft2d(vr, vi, M, false);
  const kmax = M >> 1;
  const e = new Float64Array(kmax + 1);
  const norm = 1 / (M * M * M * M);
  let total = 0;
  const TWO_PI = 2 * Math.PI;
  for (let ky = 0; ky < M; ky++) {
    const kys = signedK(ky, M);
    for (let kx = 0; kx < M; kx++) {
      const kxs = signedK(kx, M);
      const k = Math.round(Math.hypot(kxs, kys));
      if (k > kmax) continue;
      const idx = ky * M + kx;
      // ω̂ = i·2π(kₓ v̂ − k_y û). |ω̂|² = (2π)²|kₓv̂ − k_yû|².
      const a = TWO_PI * kxs;
      const b = TWO_PI * kys;
      const reW = a * vr[idx] - b * ur[idx]; // real part before the i·
      const imW = a * vi[idx] - b * ui[idx];
      // multiply by i: ω̂ = i(reW + i·imW) = −imW + i·reW; |ω̂|² = reW²+imW².
      const val = 0.5 * (reW * reW + imW * imW) * norm;
      e[k] += val;
      total += val;
    }
  }
  return { e, total };
}

export interface Transfer {
  /** Nonlinear kinetic-energy transfer into each shell, T(k). ∑ₖ T(k) = 0. */
  t: Float64Array;
  /** Spectral energy flux Π(k) = −∑_{k'≤k} T(k') — net energy flowing to scales
   *  finer than k. Π < 0 is an *inverse* cascade (energy to large scales). */
  flux: Float64Array;
}

/**
 * The spectral **kinetic-energy transfer** T(k) and **flux** Π(k) of a periodic
 * M×M velocity field — the quantitative fingerprint of the turbulent cascade,
 * showing not just *where* the energy lives (E(k)) but which way it *flows*.
 *
 * The nonlinear term of the incompressible Euler/Navier–Stokes equations is split
 * into its rotational and gradient parts, (u·∇)u = ω×u + ∇(½|u|²). The gradient
 * part is curl-free, so in Fourier space it is parallel to k and does no work on
 * the (divergence-free ⇒ û⊥k) velocity — it cannot transfer energy between
 * scales. So the transfer is carried entirely by the rotational part:
 *
 *     T(k) = −Re ∑_{|k'|=k} û*(k')·\widehat{(ω×u)}(k')
 *
 * In 2-D, ω×u = (−ωv, ωu), and u·(ω×u) = a(−ωb) + b(ωa) = 0 *pointwise*, so by
 * Parseval ∑ₖ T(k) = −⟨u·(ω×u)⟩ = 0 *exactly* (to FFT round-off): the nonlinear
 * term conserves total kinetic energy and only *shuffles* it between scales. The
 * verification suite checks this conservation directly. The flux Π(k) = −∑_{k'≤k}
 * T(k') then reveals the famous 2-D inverse cascade as a negative flux.
 *
 * Vorticity is taken spectrally for accuracy; the product is formed in physical
 * space (a pseudo-spectral evaluation).
 */
export function energyTransfer(u: Float64Array, v: Float64Array, M: number): Transfer {
  const MM = M * M;
  // FFT the velocity.
  const ur = Float64Array.from(u);
  const ui = new Float64Array(MM);
  const vr = Float64Array.from(v);
  const vi = new Float64Array(MM);
  fft2d(ur, ui, M, false);
  fft2d(vr, vi, M, false);
  // Spectral vorticity ω̂ = i·2π(kₓv̂ − k_yû), then inverse-transform to physical ω.
  const wr = new Float64Array(MM);
  const wi = new Float64Array(MM);
  const TWO_PI = 2 * Math.PI;
  for (let ky = 0; ky < M; ky++) {
    const b = TWO_PI * signedK(ky, M);
    for (let kx = 0; kx < M; kx++) {
      const a = TWO_PI * signedK(kx, M);
      const idx = ky * M + kx;
      const reW = a * vr[idx] - b * ur[idx];
      const imW = a * vi[idx] - b * ui[idx];
      // ω̂ = i·(reW + i·imW) = −imW + i·reW.
      wr[idx] = -imW;
      wi[idx] = reW;
    }
  }
  fft2d(wr, wi, M, true); // ω in physical space (wr; wi ≈ 0)
  // Rotational nonlinear term in physical space: N = ω × u = (−ω v, ω u).
  const nur = new Float64Array(MM);
  const nui = new Float64Array(MM);
  const nvr = new Float64Array(MM);
  const nvi = new Float64Array(MM);
  for (let i = 0; i < MM; i++) {
    const w = wr[i];
    nur[i] = -w * v[i];
    nvr[i] = w * u[i];
  }
  fft2d(nur, nui, M, false);
  fft2d(nvr, nvi, M, false);
  // T(k) = −Re[û*·N̂] binned by shell.
  const kmax = M >> 1;
  const t = new Float64Array(kmax + 1);
  const norm = 1 / (MM * MM);
  for (let ky = 0; ky < M; ky++) {
    const kys = signedK(ky, M);
    for (let kx = 0; kx < M; kx++) {
      const kxs = signedK(kx, M);
      const k = Math.round(Math.hypot(kxs, kys));
      if (k > kmax) continue;
      const idx = ky * M + kx;
      // Re[û* N̂u] + Re[v̂* N̂v] = ûr·N̂ur + ûi·N̂ui + v̂r·N̂vr + v̂i·N̂vi.
      const dot =
        ur[idx] * nur[idx] + ui[idx] * nui[idx] + vr[idx] * nvr[idx] + vi[idx] * nvi[idx];
      t[k] += -dot * norm;
    }
  }
  // Flux Π(k) = −∑_{k'=0}^{k} T(k').
  const flux = new Float64Array(kmax + 1);
  let acc = 0;
  for (let k = 0; k <= kmax; k++) {
    acc += t[k];
    flux[k] = -acc;
  }
  return { t, flux };
}
