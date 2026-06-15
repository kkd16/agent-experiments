// NAFF — Numerical Analysis of Fundamental Frequencies (Laskar 1988, 1992).
//
// A bound orbit is *quasi-periodic*: its complex coordinate z(t) = x(t) + i·y(t)
// (taken relative to a primary or the barycentre) is a sum of pure tones whose
// frequencies are integer combinations of a few *fundamental* frequencies,
//   z(t) = Σₖ aₖ · e^{i·ωₖ·t}.
// NAFF recovers those (ωₖ, aₖ) from a finite, sampled record — and does so far
// more accurately than a bare FFT. The trick is two-fold:
//
//   1. A Hann window χ(t) = 1 − cos(2πt/T) (zero, with zero slope, at both ends)
//      multiplies the signal inside an inner product
//        ⟨f, g⟩ = (1/N) Σₖ χ[k]·f[k]·conj(g[k]),   (1/N)Σχ = 1.
//      The window collapses spectral leakage so that the windowed correlation
//        φ(ω) = ⟨f, e^{iωt}⟩
//      has an extremely sharp, smooth peak at each true frequency — its error
//      falls as 1/T⁴ instead of the FFT's 1/T.
//
//   2. The frequency is then found *continuously*. An N-point FFT of the windowed
//      signal locates the dominant bin; a golden-section search on |φ(ω)| then
//      refines ω to machine-level precision between bins (super-resolution). The
//      tone is projected out and the search repeats on the residual (a greedy
//      matching pursuit), peeling off one fundamental at a time.
//
// After the frequency set {ωⱼ} is fixed, the amplitudes are recovered *jointly*:
// because the windowed exponentials are not orthogonal we solve the small complex
// Gram system  Σₖ ⟨E_{ωⱼ}, E_{ωₖ}⟩ aₖ = ⟨f, E_{ωⱼ}⟩  for the least-squares
// amplitudes — the exact projection of the signal onto the chosen lines.
//
// Two physical pay-offs sit on top of the decomposition:
//   • the *fundamental frequency* of an orbit (its mean motion) and its harmonics;
//   • *frequency-map analysis* (Laskar 1990/1993): the leading frequency measured
//     on the first vs the second half of the record drifts by |Δν/ν| ≈ 0 for a
//     regular orbit and by a large, measurable amount for a chaotic one — an
//     independent chaos indicator that complements the Chaos Lab's MEGNO/Lyapunov.

import { fft, isPow2 } from './fft'

/** One recovered spectral line: a tone aₖ·e^{i ωₖ t}. */
export interface SpectralLine {
  /** Angular frequency ω (radians per unit simulated time); signed. */
  omega: number
  /** |aₖ| — the amplitude (radius) of the tone. */
  amp: number
  /** arg(aₖ) — the phase at t = 0 (radians). */
  phase: number
  /** Real/imaginary parts of the complex amplitude aₖ. */
  ampRe: number
  ampIm: number
}

export interface NaffResult {
  /** Recovered lines, sorted by descending amplitude. */
  lines: SpectralLine[]
  /** |ω| of the dominant non-DC line — an orbit's fundamental frequency. */
  fundamental: number
  /** Signed dominant frequency (sign encodes prograde +, retrograde −). */
  fundamentalSigned: number
  /** Relative RMS reconstruction error ‖f − Σ aⱼe^{iωⱼt}‖ / ‖f‖ over the record. */
  reconError: number
  /** Number of lines actually recovered. */
  terms: number
  /** Sample spacing in simulated time. */
  dt: number
  /** Number of samples analysed. */
  samples: number
}

export interface NaffOptions {
  /** Maximum number of tones to extract (default 6, capped at 16). */
  maxTerms?: number
  /**
   * Stop early once the residual's leading amplitude falls below this fraction of
   * the signal's RMS (default 1e-4).
   */
  ampFloor?: number
}

// ---------------------------------------------------------------------------
// Small complex-linear-algebra helpers used by the joint amplitude solve.
// Complex numbers are passed around as bare (re, im) pairs to avoid allocation.
// ---------------------------------------------------------------------------

/** Solve the K×K complex system A·x = b by Gaussian elimination w/ partial pivot.
 *  `ar`/`ai` are row-major K² arrays; `br`/`bi` length K; result written to
 *  `xr`/`xi`. Returns false if the matrix is numerically singular. */
function solveComplex(
  K: number,
  ar: Float64Array, ai: Float64Array,
  br: Float64Array, bi: Float64Array,
  xr: Float64Array, xi: Float64Array,
): boolean {
  // Work on copies so the caller's matrix/rhs survive.
  const Ar = Float64Array.from(ar)
  const Ai = Float64Array.from(ai)
  const Br = Float64Array.from(br)
  const Bi = Float64Array.from(bi)
  for (let col = 0; col < K; col++) {
    // Partial pivot: largest |A[row][col]| at or below the diagonal.
    let piv = col
    let best = Ar[col * K + col] ** 2 + Ai[col * K + col] ** 2
    for (let row = col + 1; row < K; row++) {
      const mag = Ar[row * K + col] ** 2 + Ai[row * K + col] ** 2
      if (mag > best) { best = mag; piv = row }
    }
    if (best < 1e-300) return false
    if (piv !== col) {
      for (let c = 0; c < K; c++) {
        const t1 = Ar[piv * K + c]; Ar[piv * K + c] = Ar[col * K + c]; Ar[col * K + c] = t1
        const t2 = Ai[piv * K + c]; Ai[piv * K + c] = Ai[col * K + c]; Ai[col * K + c] = t2
      }
      const tr = Br[piv]; Br[piv] = Br[col]; Br[col] = tr
      const ti = Bi[piv]; Bi[piv] = Bi[col]; Bi[col] = ti
    }
    // Eliminate below.
    const dr = Ar[col * K + col]
    const di = Ai[col * K + col]
    const dd = dr * dr + di * di
    for (let row = col + 1; row < K; row++) {
      const nr = Ar[row * K + col]
      const ni = Ai[row * K + col]
      // factor = A[row][col] / A[col][col]
      const fr = (nr * dr + ni * di) / dd
      const fi = (ni * dr - nr * di) / dd
      for (let c = col; c < K; c++) {
        const cr = Ar[col * K + c]
        const ci = Ai[col * K + c]
        Ar[row * K + c] -= fr * cr - fi * ci
        Ai[row * K + c] -= fr * ci + fi * cr
      }
      Br[row] -= fr * Br[col] - fi * Bi[col]
      Bi[row] -= fr * Bi[col] + fi * Br[col]
    }
  }
  // Back-substitution.
  for (let row = K - 1; row >= 0; row--) {
    let sr = Br[row]
    let si = Bi[row]
    for (let c = row + 1; c < K; c++) {
      const cr = Ar[row * K + c]
      const ci = Ai[row * K + c]
      sr -= cr * xr[c] - ci * xi[c]
      si -= cr * xi[c] + ci * xr[c]
    }
    const dr = Ar[row * K + row]
    const di = Ai[row * K + row]
    const dd = dr * dr + di * di
    xr[row] = (sr * dr + si * di) / dd
    xi[row] = (si * dr - sr * di) / dd
  }
  return true
}

// ---------------------------------------------------------------------------
// The analyser.
// ---------------------------------------------------------------------------

/**
 * Decompose a sampled complex signal into quasi-periodic tones via NAFF.
 *
 * `re`/`im` are N = 2ᵏ uniform samples of z(t) and `dt` their spacing. Returns
 * the recovered lines (frequencies + complex amplitudes), the orbit's fundamental
 * frequency, and the reconstruction error.
 */
export function naff(re: Float64Array, im: Float64Array, dt: number, opts: NaffOptions = {}): NaffResult {
  const N = re.length
  const maxTerms = Math.max(1, Math.min(16, opts.maxTerms ?? 6))
  const ampFloor = opts.ampFloor ?? 1e-4

  if (!isPow2(N) || N < 8 || dt <= 0) {
    return { lines: [], fundamental: 0, fundamentalSigned: 0, reconError: 1, terms: 0, dt, samples: N }
  }

  // Hann window χ[k] = 1 − cos(2πk/N), normalised so (1/N)Σχ = 1 (it already is:
  // Σcos over a full period vanishes, so Σχ = N).
  const chi = new Float64Array(N)
  for (let k = 0; k < N; k++) chi[k] = 1 - Math.cos((2 * Math.PI * k) / N)

  // Signal RMS (unwindowed) for the amplitude floor and error normalisation.
  let sig2 = 0
  for (let k = 0; k < N; k++) sig2 += re[k] * re[k] + im[k] * im[k]
  const sigRms = Math.sqrt(sig2 / N) || 1e-30

  // φ(ω) = ⟨sig, e^{iωt}⟩ = (1/N) Σ χ[k]·sig[k]·e^{-iωkdt}. The complex exponential
  // is advanced by a recurrence (one complex multiply per sample) so no trig runs
  // in the hot loop. Returns [Re φ, Im φ].
  const phiOf = (sr: Float64Array, si: Float64Array, omega: number): [number, number] => {
    const theta = -omega * dt
    const wr = Math.cos(theta)
    const wi = Math.sin(theta)
    let er = 1
    let ei = 0
    let accR = 0
    let accI = 0
    for (let k = 0; k < N; k++) {
      const c = chi[k]
      const fr = c * sr[k]
      const fi = c * si[k]
      accR += fr * er - fi * ei
      accI += fr * ei + fi * er
      const ner = er * wr - ei * wi
      ei = er * wi + ei * wr
      er = ner
    }
    return [accR / N, accI / N]
  }

  // ⟨E_α, E_β⟩ = (1/N) Σ χ[k] e^{i(α−β)kdt}, a function of δ = α − β only.
  const windowCorr = (delta: number): [number, number] => {
    const theta = delta * dt
    const wr = Math.cos(theta)
    const wi = Math.sin(theta)
    let er = 1
    let ei = 0
    let accR = 0
    let accI = 0
    for (let k = 0; k < N; k++) {
      const c = chi[k]
      accR += c * er
      accI += c * ei
      const ner = er * wr - ei * wi
      ei = er * wi + ei * wr
      er = ner
    }
    return [accR / N, accI / N]
  }

  const dOmega = (2 * Math.PI) / (N * dt) // one FFT bin in angular frequency

  // Coarse search: FFT of the windowed residual; return the bin frequency with
  // the largest magnitude. Bins m > N/2 alias to negative frequencies (m − N).
  const fr = new Float64Array(N)
  const fi = new Float64Array(N)
  const coarsePeak = (sr: Float64Array, si: Float64Array): number => {
    for (let k = 0; k < N; k++) {
      const c = chi[k]
      fr[k] = c * sr[k]
      fi[k] = c * si[k]
    }
    fft(fr, fi)
    let bestM = 0
    let bestMag = -1
    for (let m = 0; m < N; m++) {
      const mag = fr[m] * fr[m] + fi[m] * fi[m]
      if (mag > bestMag) { bestMag = mag; bestM = m }
    }
    const signedM = bestM <= N / 2 ? bestM : bestM - N
    return signedM * dOmega
  }

  // Golden-section refinement of |φ(ω)|² on [a, b] (a single, smooth main lobe).
  const refine = (sr: Float64Array, si: Float64Array, a: number, b: number): number => {
    const gr = (Math.sqrt(5) - 1) / 2 // 1/φ
    const mag2 = (omega: number) => {
      const [pr, pi] = phiOf(sr, si, omega)
      return pr * pr + pi * pi
    }
    let lo = a
    let hi = b
    let c = hi - gr * (hi - lo)
    let d = lo + gr * (hi - lo)
    let fc = mag2(c)
    let fd = mag2(d)
    for (let it = 0; it < 80; it++) {
      if (fc > fd) {
        hi = d; d = c; fd = fc
        c = hi - gr * (hi - lo); fc = mag2(c)
      } else {
        lo = c; c = d; fc = fd
        d = lo + gr * (hi - lo); fd = mag2(d)
      }
      if (hi - lo < 1e-12) break
    }
    return 0.5 * (lo + hi)
  }

  // Residual (raw, un-windowed) signal that tones are peeled off of.
  const rr = Float64Array.from(re)
  const ri = Float64Array.from(im)

  const freqs: number[] = []
  for (let term = 0; term < maxTerms; term++) {
    const coarse = coarsePeak(rr, ri)
    const omega = refine(rr, ri, coarse - dOmega, coarse + dOmega)

    // Stop if this frequency duplicates an earlier one (within ~half a bin): the
    // Gram system would be singular and no new information is gained.
    let dup = false
    for (const f of freqs) if (Math.abs(f - omega) < 0.5 * dOmega) { dup = true; break }
    if (dup) break

    // Single-tone coefficient a = ⟨residual, E_ω⟩ (since ⟨E_ω, E_ω⟩ = 1), used
    // only to deflate the residual; final amplitudes come from the joint solve.
    const [ar0, ai0] = phiOf(rr, ri, omega)
    if (Math.sqrt(ar0 * ar0 + ai0 * ai0) < ampFloor * sigRms && term > 0) break
    freqs.push(omega)

    // residual ← residual − a·e^{iωt}
    {
      const theta = omega * dt
      const wr = Math.cos(theta)
      const wi = Math.sin(theta)
      let er = 1
      let ei = 0
      for (let k = 0; k < N; k++) {
        // a·e^{iωt} = (ar0 + i ai0)(er + i ei)
        rr[k] -= ar0 * er - ai0 * ei
        ri[k] -= ar0 * ei + ai0 * er
        const ner = er * wr - ei * wi
        ei = er * wi + ei * wr
        er = ner
      }
    }
  }

  const K = freqs.length
  if (K === 0) {
    return { lines: [], fundamental: 0, fundamentalSigned: 0, reconError: 1, terms: 0, dt, samples: N }
  }

  // Joint amplitudes: solve the Gram system M·a = r on the original signal.
  const Mr = new Float64Array(K * K)
  const Mi = new Float64Array(K * K)
  for (let j = 0; j < K; j++) {
    for (let k = 0; k < K; k++) {
      const [wr, wi] = windowCorr(freqs[j] - freqs[k])
      Mr[j * K + k] = wr
      Mi[j * K + k] = wi
    }
  }
  const Rr = new Float64Array(K)
  const Ri = new Float64Array(K)
  for (let j = 0; j < K; j++) {
    const [pr, pi] = phiOf(re, im, freqs[j])
    Rr[j] = pr
    Ri[j] = pi
  }
  const Axr = new Float64Array(K)
  const Axi = new Float64Array(K)
  const ok = solveComplex(K, Mr, Mi, Rr, Ri, Axr, Axi)
  if (!ok) {
    // Fall back to the greedy single-tone coefficients (frequencies are still good).
    for (let j = 0; j < K; j++) {
      const [pr, pi] = phiOf(re, im, freqs[j])
      Axr[j] = pr
      Axi[j] = pi
    }
  }

  const lines: SpectralLine[] = []
  for (let j = 0; j < K; j++) {
    const amp = Math.hypot(Axr[j], Axi[j])
    lines.push({ omega: freqs[j], amp, phase: Math.atan2(Axi[j], Axr[j]), ampRe: Axr[j], ampIm: Axi[j] })
  }
  lines.sort((p, q) => q.amp - p.amp)

  // Reconstruction error over the (un-windowed) record.
  let err2 = 0
  for (let k = 0; k < N; k++) {
    let recR = 0
    let recI = 0
    for (let j = 0; j < K; j++) {
      const theta = freqs[j] * (k * dt)
      const cr = Math.cos(theta)
      const ci = Math.sin(theta)
      recR += Axr[j] * cr - Axi[j] * ci
      recI += Axr[j] * ci + Axi[j] * cr
    }
    const dr = re[k] - recR
    const di = im[k] - recI
    err2 += dr * dr + di * di
  }
  const reconError = Math.sqrt(err2 / Math.max(sig2, 1e-300))

  // Fundamental = dominant line with |ω| meaningfully above zero (skip slow drift).
  let fundamentalSigned = 0
  for (const ln of lines) {
    if (Math.abs(ln.omega) > 1.5 * dOmega) { fundamentalSigned = ln.omega; break }
  }
  if (fundamentalSigned === 0 && lines.length > 0) fundamentalSigned = lines[0].omega

  return {
    lines,
    fundamental: Math.abs(fundamentalSigned),
    fundamentalSigned,
    reconError,
    terms: K,
    dt,
    samples: N,
  }
}

export type DiffusionClass = 'regular' | 'weakly-chaotic' | 'chaotic'

export interface FreqDiffusion {
  /** Fundamental frequency over the first half of the record. */
  nu1: number
  /** Fundamental frequency over the second half. */
  nu2: number
  /** Relative frequency drift |ν₂ − ν₁| / |ν₁|. */
  diffusion: number
  /** log₁₀ of the diffusion (−∞ → 0 clamped); the headline number. */
  logDiffusion: number
  classification: DiffusionClass
  /** Whether the analysis succeeded (a fundamental was found in both halves). */
  valid: boolean
}

/**
 * Frequency-map analysis: measure the leading frequency on the first and second
 * halves of the record and report how much it drifts. A regular (quasi-periodic)
 * orbit keeps a constant fundamental — the drift sits near sampling precision
 * (log₁₀|Δν/ν| ≲ −5). A chaotic orbit's frequency wanders measurably (≳ −2.5).
 */
export function frequencyDiffusion(
  re: Float64Array, im: Float64Array, dt: number, maxTerms = 5,
): FreqDiffusion {
  const N = re.length
  const half = N >> 1
  const invalid: FreqDiffusion = {
    nu1: 0, nu2: 0, diffusion: NaN, logDiffusion: NaN, classification: 'weakly-chaotic', valid: false,
  }
  if (!isPow2(N) || half < 8 || !isPow2(half)) return invalid

  const a = naff(re.subarray(0, half), im.subarray(0, half), dt, { maxTerms })
  const b = naff(re.subarray(half, N), im.subarray(half, N), dt, { maxTerms })
  const nu1 = a.fundamentalSigned
  const nu2 = b.fundamentalSigned
  if (nu1 === 0 || !Number.isFinite(nu1) || !Number.isFinite(nu2)) return invalid

  const diffusion = Math.abs(nu2 - nu1) / Math.abs(nu1)
  const logDiffusion = Math.log10(Math.max(diffusion, 1e-16))
  let classification: DiffusionClass
  if (logDiffusion < -4) classification = 'regular'
  else if (logDiffusion > -2.5) classification = 'chaotic'
  else classification = 'weakly-chaotic'

  return { nu1, nu2, diffusion, logDiffusion, classification, valid: true }
}
