// A from-scratch phase vocoder: time-stretch and pitch-shift audio using nothing
// but the STFT and the FFT already in this lab.
//
// The idea. Chop the signal into overlapping frames, FFT each one, and you have a
// stack of spectra. To play it back *slower*, you'd like to space those frames
// further apart on output — but a spectrum only tells you a bin's magnitude and
// its phase *at that instant*, not how fast the phase is turning. Re-spacing the
// frames naïvely smears the phase and the result sounds like a robot in a cave.
//
// The fix is to recover each bin's *instantaneous frequency* from how its phase
// advanced between two input frames, then re-integrate that frequency across the
// (re-scaled) output hop so every bin stays phase-coherent. That is the whole
// trick, and it is pure Fourier bookkeeping:
//
//   Δφ_measured = φ[m] − φ[m−1]                       (raw phase advance)
//   Δφ_expected = ω_k · Ha                             (advance if bin sat still)
//   Δφ_wrapped  = princarg(Δφ_measured − Δφ_expected)  (the surprise, in (−π,π])
//   ω_true      = ω_k + Δφ_wrapped / Ha                (true bin frequency)
//   φ_synth[m]  = φ_synth[m−1] + ω_true · Hs           (re-integrate at new hop)
//
// with analysis hop Ha, synthesis hop Hs, and stretch factor = Hs / Ha. Rebuild
// each frame from (original magnitude, φ_synth), inverse-FFT, and overlap-add
// with a second window. Divide by the summed window energy (weighted overlap-add)
// and the reconstruction is unity when nothing is modified — the identity test.
//
// Pitch-shift is then free: stretch by the pitch ratio, then linearly resample
// back — same duration, transposed pitch.

import { makeComplex } from './complex'
import { fftInPlace, nextPow2 } from './fft'
import { resample1d } from './dsp'

const TWO_PI = 2 * Math.PI

/** A periodic Hann window (denominator N, not N−1) so shifted copies tile flat. */
export function hannPeriodic(n: number): Float64Array {
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / n)
  return w
}

/** Principal argument: wrap a phase into (−π, π]. */
export function princarg(x: number): number {
  const a = x - TWO_PI * Math.round(x / TWO_PI)
  return a
}

export interface StretchOptions {
  fftSize: number // power of two
  overlap: number // frames per window (analysis hop = fftSize / overlap), e.g. 4
}

/**
 * Time-stretch `signal` by `stretch` (2 = twice as long, half the tempo; 0.5 =
 * half as long) while preserving pitch. Returns a new Float64Array.
 */
export function timeStretch(signal: Float64Array, stretch: number, opts: StretchOptions): Float64Array {
  const N = nextPow2(opts.fftSize)
  const overlap = Math.max(2, Math.floor(opts.overlap))
  const Ha = Math.max(1, Math.floor(N / overlap))
  const Hs = Math.max(1, Math.round(Ha * stretch))
  const half = N >> 1 // process bins 0..N/2, mirror the rest by conjugate symmetry

  if (signal.length < N) return signal.slice()

  const win = hannPeriodic(N)
  const numFrames = Math.floor((signal.length - N) / Ha) + 1
  const outLen = N + (numFrames - 1) * Hs + 1
  const out = new Float64Array(outLen)
  const norm = new Float64Array(outLen)

  // Per-bin state across frames.
  const omega = new Float64Array(half + 1)
  for (let k = 0; k <= half; k++) omega[k] = (TWO_PI * k) / N
  const lastPhase = new Float64Array(half + 1)
  const sumPhase = new Float64Array(half + 1)

  const c = makeComplex(N)
  let outPos = 0

  for (let m = 0; m < numFrames; m++) {
    const start = m * Ha
    // Windowed analysis frame → FFT.
    for (let i = 0; i < N; i++) c.re[i] = signal[start + i] * win[i]
    c.im.fill(0)
    fftInPlace(c, false)

    // Recover instantaneous frequency and re-integrate the synthesis phase.
    for (let k = 0; k <= half; k++) {
      const re = c.re[k]
      const im = c.im[k]
      const mag = Math.hypot(re, im)
      const phase = Math.atan2(im, re)
      if (m === 0) {
        sumPhase[k] = phase
      } else {
        const dphi = princarg(phase - lastPhase[k] - omega[k] * Ha)
        const trueFreq = omega[k] + dphi / Ha
        sumPhase[k] += trueFreq * Hs
      }
      lastPhase[k] = phase
      // Write the re-phased bin back into the lower half.
      c.re[k] = mag * Math.cos(sumPhase[k])
      c.im[k] = mag * Math.sin(sumPhase[k])
    }
    // Rebuild the upper half by conjugate symmetry so the IFFT is real.
    for (let k = 1; k < half; k++) {
      c.re[N - k] = c.re[k]
      c.im[N - k] = -c.im[k]
    }

    fftInPlace(c, true) // inverse → time domain (real part)

    // Weighted overlap-add.
    for (let i = 0; i < N; i++) {
      const w = win[i]
      out[outPos + i] += c.re[i] * w
      norm[outPos + i] += w * w
    }
    outPos += Hs
  }

  // Normalise by the accumulated window energy (weighted overlap-add).
  const end = N + (numFrames - 1) * Hs
  const result = new Float64Array(end)
  for (let i = 0; i < end; i++) {
    result[i] = norm[i] > 1e-8 ? out[i] / norm[i] : 0
  }
  return result
}

export interface ShiftOptions extends StretchOptions {
  semitones: number // pitch shift in semitones (+12 = up an octave)
  stretch: number // independent time-stretch applied on top
}

/**
 * Pitch-shift by `semitones` and time-stretch by `stretch`, independently. The
 * pitch move is a stretch-by-ratio followed by a resample-by-1/ratio, so the two
 * controls are fully decoupled: duration ends up ≈ input · stretch, pitch × 2^(s/12).
 */
export function pitchTimeShift(signal: Float64Array, opts: ShiftOptions): Float64Array {
  const ratio = Math.pow(2, opts.semitones / 12)
  const totalStretch = opts.stretch * ratio
  const stretched = timeStretch(signal, totalStretch, opts)
  if (Math.abs(ratio - 1) < 1e-9) return stretched
  const outLen = Math.max(1, Math.round(stretched.length / ratio))
  return resample1d(stretched, outLen)
}

/** Signal-to-noise ratio (dB) of `approx` against `ref` over an interior slice. */
export function snrDb(ref: ArrayLike<number>, approx: ArrayLike<number>, guard = 0): number {
  const n = Math.min(ref.length, approx.length)
  let sig = 0
  let err = 0
  for (let i = guard; i < n - guard; i++) {
    sig += ref[i] * ref[i]
    const d = ref[i] - approx[i]
    err += d * d
  }
  if (err < 1e-20) return Infinity
  return 10 * Math.log10(sig / err)
}
