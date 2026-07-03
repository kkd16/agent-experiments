// A from-scratch continuous wavelet transform (CWT) using the complex Morlet
// wavelet, evaluated efficiently in the frequency domain.
//
// Where the STFT slides a *fixed* window across a signal, the CWT dilates a
// mother wavelet: high frequencies are analysed with a short window (sharp in
// time) and low frequencies with a long one (sharp in frequency). That adaptive
// trade-off is the whole point, and it falls straight out of the convolution
// theorem — convolving the signal with each scaled wavelet is a multiply in the
// frequency domain (Torrence & Compo, 1998).

import { makeComplex, magnitude } from './complex'
import { fft, ifft, nextPow2 } from './fft'

export interface CwtOptions {
  fs: number // sample rate (Hz)
  omega0?: number // Morlet central frequency (dimensionless); 6 is standard
  scalesPerOctave?: number
  minFreq?: number // Hz
  maxFreq?: number // Hz
}

export interface CwtResult {
  power: Float64Array[] // one row per scale (low freq first), each length = signal len
  freqs: Float64Array // pseudo-frequency (Hz) for each scale/row
  fs: number
  length: number
}

/**
 * The Fourier factor that converts a Morlet scale to a pseudo-frequency:
 * f = 1 / (Fourier_factor · s). For the Morlet wavelet this is exact for the
 * dominant frequency of the wavelet at scale s.
 */
export function morletFourierFactor(omega0: number): number {
  return (4 * Math.PI) / (omega0 + Math.sqrt(2 + omega0 * omega0))
}

/** Convert a scale (seconds) to its pseudo-frequency (Hz). */
export function scaleToFreq(scale: number, omega0: number): number {
  return 1 / (morletFourierFactor(omega0) * scale)
}

/** Convert a pseudo-frequency (Hz) back to a Morlet scale (seconds). */
export function freqToScale(freq: number, omega0: number): number {
  return 1 / (morletFourierFactor(omega0) * freq)
}

/**
 * Continuous wavelet transform of a real signal. Returns the wavelet power
 * |W(s, t)|² as a matrix of rows (one per scale, lowest frequency first).
 */
export function cwtMorlet(signal: ArrayLike<number>, opts: CwtOptions): CwtResult {
  const fs = opts.fs
  const omega0 = opts.omega0 ?? 6
  const perOct = opts.scalesPerOctave ?? 12
  const len = signal.length
  const dt = 1 / fs

  // Pad to a power of two so the fast FFT drives the convolution.
  const N = nextPow2(len)
  const x = makeComplex(N)
  for (let i = 0; i < len; i++) x.re[i] = signal[i]
  const X = fft(x)

  // Angular frequency grid for the DFT bins (rad/s), with the usual
  // positive/negative split.
  const omega = new Float64Array(N)
  for (let k = 0; k < N; k++) {
    const kk = k <= N / 2 ? k : k - N
    omega[k] = (2 * Math.PI * kk) / (N * dt)
  }

  // Frequency band → scale band (log-spaced).
  const nyquist = fs / 2
  const fMax = Math.min(opts.maxFreq ?? nyquist * 0.9, nyquist * 0.98)
  const fMin = Math.max(opts.minFreq ?? fs / len, fMax / 512)
  const octaves = Math.log2(fMax / fMin)
  const nScales = Math.max(8, Math.round(octaves * perOct))

  const power: Float64Array[] = []
  const freqs = new Float64Array(nScales)
  const norm0 = Math.pow(Math.PI, -0.25)

  // Rows are emitted low-frequency first (bottom of the scalogram).
  for (let si = 0; si < nScales; si++) {
    const frac = nScales === 1 ? 0 : si / (nScales - 1)
    const f = fMin * Math.pow(fMax / fMin, frac)
    const s = freqToScale(f, omega0)
    freqs[si] = f

    // Morlet daughter wavelet in the frequency domain (analytic: positive
    // frequencies only), with energy normalization.
    const psi = makeComplex(N)
    const amp = norm0 * Math.sqrt((2 * Math.PI * s) / dt)
    for (let k = 0; k < N; k++) {
      const w = omega[k]
      if (w > 0) {
        const arg = s * w - omega0
        const g = amp * Math.exp(-0.5 * arg * arg)
        // Multiply X by the (real) wavelet response.
        psi.re[k] = X.re[k] * g
        psi.im[k] = X.im[k] * g
      }
    }
    const conv = ifft(psi)
    const mag = magnitude(conv)
    const row = new Float64Array(len)
    for (let i = 0; i < len; i++) {
      const m = mag[i]
      row[i] = m * m // power
    }
    power.push(row)
  }

  return { power, freqs, fs, length: len }
}

/**
 * Downsample a CWT result along the time axis to at most `maxCols` columns by
 * averaging power within each column — enough for a crisp on-screen scalogram
 * without shipping one pixel per sample.
 */
export function reduceTime(result: CwtResult, maxCols: number): {
  cols: Float64Array[] // one per scale row, length = actual column count
  columns: number
  freqs: Float64Array
} {
  const { power, length, freqs } = result
  const columns = Math.min(maxCols, length)
  const cols: Float64Array[] = []
  for (const row of power) {
    const out = new Float64Array(columns)
    for (let c = 0; c < columns; c++) {
      const a = Math.floor((c * length) / columns)
      const b = Math.max(a + 1, Math.floor(((c + 1) * length) / columns))
      let sum = 0
      for (let i = a; i < b; i++) sum += row[i]
      out[c] = sum / (b - a)
    }
    cols.push(out)
  }
  return { cols, columns, freqs }
}
