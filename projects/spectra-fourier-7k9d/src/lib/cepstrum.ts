// The cepstrum — "spectrum" with the first four letters reversed — and pitch
// detection built on it.
//
// A voiced sound is a buzzy pitched *source* passed through a resonant *filter*
// (the vocal tract). In the spectrum those multiply; take a logarithm and they
// *add*: log|X| = log|source| + log|filter|. The source contributes a fast ripple
// (its harmonics, spaced by the pitch) and the filter contributes a slow, smooth
// envelope (the formants). Adding a fast and a slow component and then running a
// Fourier transform *of the log-spectrum* separates them by rate — which is the
// cepstrum:
//
//   c[q] = IFFT( log |FFT(x)| )
//
// The horizontal axis q is "quefrency", measured in samples of *time*. The pitch
// ripple, being periodic in frequency with spacing f0, lands as a sharp peak at
// quefrency q = fs / f0 — so the tallest peak in the mid-quefrency range *is* the
// pitch. Keep only the low quefrencies (a "lifter") and transform back and you
// recover the smooth formant envelope with the pitch ripple stripped away.

import { makeComplex } from './complex'
import { fftInPlace, nextPow2 } from './fft'
import { windowFn } from './dsp'
import type { WindowName } from './dsp'

export interface CepstrumResult {
  logMag: Float64Array // log-magnitude spectrum, bins = fftSize/2
  cepstrum: Float64Array // real cepstrum, length fftSize (quefrency in samples)
  envelopeLogMag: Float64Array // low-quefrency liftered envelope (formants), bins
  bins: number
  fftSize: number
  fs: number
  lifterCutoff: number
  pitchHz: number // 0 if none found
  pitchQuefrency: number // samples
  minQ: number
  maxQ: number
}

export interface CepstrumOptions {
  fftSize: number
  fs: number
  window: WindowName
  lifterCutoff: number // quefrency samples kept for the envelope
  minF: number // lowest pitch to search (Hz)
  maxF: number // highest pitch to search (Hz)
}

/** Compute the real cepstrum of a (single windowed) frame plus its pitch peak. */
export function cepstrum(frame: Float64Array, opts: CepstrumOptions): CepstrumResult {
  const N = nextPow2(opts.fftSize)
  const bins = N >> 1
  const win = windowFn(opts.window, N)

  // Windowed FFT.
  const c = makeComplex(N)
  for (let i = 0; i < N; i++) c.re[i] = (frame[i] ?? 0) * win[i]
  fftInPlace(c, false)

  // Log-magnitude over the full spectrum (needed for a real IFFT back).
  const logFull = makeComplex(N)
  for (let k = 0; k < N; k++) {
    logFull.re[k] = Math.log(Math.hypot(c.re[k], c.im[k]) + 1e-9)
  }
  // Real cepstrum = IFFT(log|X|); the imaginary part is ~0 by symmetry.
  const cep = makeComplex(N)
  cep.re.set(logFull.re)
  fftInPlace(cep, true)
  const cepstrumArr = new Float64Array(N)
  for (let n = 0; n < N; n++) cepstrumArr[n] = cep.re[n]

  const logMag = new Float64Array(bins)
  for (let k = 0; k < bins; k++) logMag[k] = logFull.re[k]

  // Pitch peak: search the quefrency band [fs/maxF, fs/minF].
  const minQ = Math.max(2, Math.floor(opts.fs / opts.maxF))
  const maxQ = Math.min(bins - 1, Math.ceil(opts.fs / opts.minF))
  let peakQ = 0
  let peakV = -Infinity
  for (let q = minQ; q <= maxQ; q++) {
    if (cepstrumArr[q] > peakV) {
      peakV = cepstrumArr[q]
      peakQ = q
    }
  }
  // Only accept a peak that stands clearly above the local average (voiced test).
  let mean = 0
  for (let q = minQ; q <= maxQ; q++) mean += cepstrumArr[q]
  mean /= Math.max(1, maxQ - minQ + 1)
  const voiced = peakV > mean + 3 * stddev(cepstrumArr, minQ, maxQ, mean)
  const pitchQuefrency = voiced ? refinePeak(cepstrumArr, peakQ) : 0
  const pitchHz = pitchQuefrency > 0 ? opts.fs / pitchQuefrency : 0

  // Low-quefrency lifter → smooth formant envelope. Keep |q| < cutoff, zero the
  // rest (both ends, since the cepstrum is symmetric), FFT back to the log domain.
  const cut = Math.max(1, Math.min(bins - 1, Math.floor(opts.lifterCutoff)))
  const lifted = makeComplex(N)
  for (let q = 0; q < N; q++) {
    const keep = q <= cut || q >= N - cut
    lifted.re[q] = keep ? cepstrumArr[q] : 0
  }
  fftInPlace(lifted, false)
  const envelopeLogMag = new Float64Array(bins)
  for (let k = 0; k < bins; k++) envelopeLogMag[k] = lifted.re[k]

  return {
    logMag,
    cepstrum: cepstrumArr,
    envelopeLogMag,
    bins,
    fftSize: N,
    fs: opts.fs,
    lifterCutoff: cut,
    pitchHz,
    pitchQuefrency,
    minQ,
    maxQ,
  }
}

function stddev(a: Float64Array, lo: number, hi: number, mean: number): number {
  let s = 0
  const n = Math.max(1, hi - lo + 1)
  for (let i = lo; i <= hi; i++) {
    const d = a[i] - mean
    s += d * d
  }
  return Math.sqrt(s / n)
}

/** Parabolic interpolation around an integer peak for sub-sample quefrency. */
function refinePeak(a: Float64Array, q: number): number {
  if (q <= 0 || q >= a.length - 1) return q
  const y0 = a[q - 1]
  const y1 = a[q]
  const y2 = a[q + 1]
  const denom = y0 - 2 * y1 + y2
  if (Math.abs(denom) < 1e-12) return q
  const delta = (0.5 * (y0 - y2)) / denom
  return q + Math.max(-1, Math.min(1, delta))
}

/**
 * Autocorrelation pitch estimate — the classic time-domain method, kept as an
 * independent cross-check on the cepstral peak. Returns 0 if unvoiced.
 */
export function autocorrPitch(frame: Float64Array, fs: number, minF: number, maxF: number): number {
  const n = frame.length
  // Remove DC.
  let mean = 0
  for (let i = 0; i < n; i++) mean += frame[i]
  mean /= n
  const x = new Float64Array(n)
  for (let i = 0; i < n; i++) x[i] = frame[i] - mean

  let energy = 0
  for (let i = 0; i < n; i++) energy += x[i] * x[i]
  if (energy < 1e-12) return 0

  const minLag = Math.max(1, Math.floor(fs / maxF))
  const maxLag = Math.min(n - 1, Math.ceil(fs / minF))
  // Keep the normalised correlation curve so the peak can be refined sub-sample.
  const curve = new Float64Array(maxLag + 2)
  let bestLag = 0
  let bestVal = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0
    for (let i = 0; i < n - lag; i++) s += x[i] * x[i + lag]
    const norm = s / energy
    curve[lag] = norm
    if (norm > bestVal) {
      bestVal = norm
      bestLag = lag
    }
  }
  // Require a reasonably strong periodicity to call it voiced.
  if (bestVal < 0.3 || bestLag === 0) return 0
  const lag = refinePeak(curve, bestLag)
  return fs / lag
}
