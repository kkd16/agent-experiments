// Time-frequency spectroscopy — the short-time Fourier transform (STFT) plus a
// NAFF fundamental "ridge".
//
// A single NAFF spectrum (see `naff.ts`) assumes the orbit's frequencies are
// *constant* over the whole record. But a chaotic orbit's frequencies drift — it
// hops between resonances — and the most vivid way to *see* that is a spectrogram:
// slide a short window along the signal and Fourier-analyse each slice, stacking
// the magnitude spectra into a time × frequency image. A regular orbit draws a set
// of dead-straight horizontal lines (frozen frequencies); a chaotic one draws a
// wandering, smeared ridge — frequency diffusion made directly visible.
//
// Each slice is Hann-windowed (to suppress leakage) before a complex radix-2 FFT;
// the bins are re-ordered to a signed axis [−ν_Nyq, +ν_Nyq] so prograde and
// retrograde lines sit either side of zero. Over each window we also run the full
// NAFF refinement to extract the sub-bin fundamental — the ridge overlay.

import { fft, isPow2 } from './fft'
import { naff } from './naff'

export interface SpectrogramOptions {
  /** Window length (power of two; default 256). Trades time vs frequency resolution. */
  window?: number
  /** Hop between window starts in samples (default window/4 — 75% overlap). */
  hop?: number
  /** Optional |ω| band to keep; rows outside are dropped (default: full Nyquist). */
  fMax?: number
}

export interface SpectrogramResult {
  /** Window-centre times (one per column). */
  times: Float64Array
  /** Signed angular-frequency axis (one per row), ascending. */
  freqs: Float64Array
  /** Magnitudes, row-major [row*cols + col], normalised to [0,1] over the image. */
  mag: Float64Array
  /** Per-window NAFF fundamental (signed) — the ridge, aligned with `times`. */
  ridge: Float64Array
  cols: number
  rows: number
  dt: number
  valid: boolean
}

/**
 * Compute the STFT magnitude image + the NAFF ridge of a complex signal z = re+i·im
 * sampled at spacing `dt`. Returns an empty (invalid) result if the signal is too
 * short for even a single window.
 */
export function spectrogram(
  re: Float64Array, im: Float64Array, dt: number, opts: SpectrogramOptions = {},
): SpectrogramResult {
  const N = re.length
  const empty: SpectrogramResult = {
    times: new Float64Array(0), freqs: new Float64Array(0), mag: new Float64Array(0),
    ridge: new Float64Array(0), cols: 0, rows: 0, dt, valid: false,
  }
  const W = opts.window ?? 256
  if (!isPow2(W) || N < W || dt <= 0) return empty
  const hop = Math.max(1, opts.hop ?? W >> 2)
  const cols = Math.floor((N - W) / hop) + 1
  if (cols < 1) return empty

  // Signed frequency axis for an N=W complex FFT: bin m maps to ω = m·dω, with the
  // upper half (m > W/2) aliasing to negative frequency (m − W)·dω.
  const dOmega = (2 * Math.PI) / (W * dt)
  const fullFreqs = new Float64Array(W)
  const order = new Int32Array(W) // FFT-bin index in ascending-frequency order
  {
    // Negative frequencies first: bins W/2+1 … W−1  → (m−W)·dω, then 0 … W/2.
    let r = 0
    for (let m = W >> 1; m < W; m++) { fullFreqs[r] = (m - W) * dOmega; order[r] = m; r++ }
    for (let m = 0; m <= W >> 1; m++) { fullFreqs[r] = m * dOmega; order[r] = m; r++ }
    // (length is W/2−1 + (W/2+1) = W ✓)
  }

  // Optional band-limit: keep only rows with |ω| ≤ fMax.
  const fMax = opts.fMax && opts.fMax > 0 ? opts.fMax : Infinity
  const keepRows: number[] = []
  for (let r = 0; r < W; r++) if (Math.abs(fullFreqs[r]) <= fMax) keepRows.push(r)
  const rows = keepRows.length
  const freqs = new Float64Array(rows)
  for (let r = 0; r < rows; r++) freqs[r] = fullFreqs[keepRows[r]]

  const chi = new Float64Array(W)
  for (let k = 0; k < W; k++) chi[k] = 1 - Math.cos((2 * Math.PI * k) / W)

  const mag = new Float64Array(rows * cols)
  const times = new Float64Array(cols)
  const ridge = new Float64Array(cols)

  const fr = new Float64Array(W)
  const fi = new Float64Array(W)
  const winRe = new Float64Array(W)
  const winIm = new Float64Array(W)
  let globalMax = 1e-30

  for (let c = 0; c < cols; c++) {
    const start = c * hop
    times[c] = (start + W / 2) * dt
    for (let k = 0; k < W; k++) {
      winRe[k] = re[start + k]
      winIm[k] = im[start + k]
      fr[k] = chi[k] * winRe[k]
      fi[k] = chi[k] * winIm[k]
    }
    fft(fr, fi)
    for (let r = 0; r < rows; r++) {
      const m = order[keepRows[r]]
      const a = Math.hypot(fr[m], fi[m])
      mag[r * cols + c] = a
      if (a > globalMax) globalMax = a
    }
    // Sub-bin fundamental for the ridge (full NAFF on the un-windowed slice).
    const nf = naff(winRe, winIm, dt, { maxTerms: 3 })
    ridge[c] = nf.fundamental > 0 ? nf.fundamentalSigned : NaN
  }

  // Normalise the image to [0,1] on a perceptual (sqrt-magnitude) scale.
  const inv = 1 / globalMax
  for (let i = 0; i < mag.length; i++) mag[i] = Math.sqrt(mag[i] * inv)

  return { times, freqs, mag, ridge, cols, rows, dt, valid: true }
}
