// Time-frequency reassignment and synchrosqueezing — from scratch.
//
// An ordinary spectrogram smears every event over the whole width of its
// analysis window: a clean chirp becomes a fuzzy diagonal band, two close tones
// blur together. **Reassignment** (Kodera 1976; Auger & Flandrin 1995) fixes
// this without changing the window. For each STFT cell it asks *where did this
// energy really come from?* and moves the value from the grid point (t, ω) to
// the signal's local centre of gravity (t̂, ω̂) in the time-frequency plane. A
// chirp collapses from a band to a razor-thin line that traces its instantaneous
// frequency exactly.
//
// The trick (Auger–Flandrin) is that both corrections are ratios of STFTs taken
// with *companion windows* derived from the same analysis window h:
//
//   t̂(n,k) = n  +  Re( X_{Th}(n,k) / X_h(n,k) )                (local group delay)
//   ω̂(n,k) = ω_k −  Im( X_{Dh}(n,k) / X_h(n,k) )              (instantaneous freq)
//
// where (Th)[τ] = τ·h[τ] is the time-ramped window and (Dh)[τ] = h′[τ] the
// window derivative. We use a Gaussian analysis window because its derivative is
// exactly −(τ/σ²)·h[τ], so all three windows are analytic — no finite
// differences, bit-for-bit reproducible.
//
// **Synchrosqueezing** (Daubechies, Lu & Wu 2011) is the invertible cousin:
// reassign in frequency only, keep the time bin, so the transform can be summed
// back to recover the signal. We show its sharpened magnitude here.
//
// Everything runs on the project's from-scratch radix-2 FFT. No math libraries.

import { fftInPlace, nextPow2 } from './fft'

export interface ReassignOptions {
  fs: number // sample rate (Hz)
  fftSize: number // FFT length L (power of two)
  hop: number // samples between frame centres
  sigma: number // Gaussian window standard deviation, in samples
  powerFloorRel?: number // ignore cells below this fraction of peak power (default 1e-4)
}

export interface Tfr {
  cols: number
  rows: number // = fftSize/2, one row per positive-frequency bin (row 0 = DC)
  data: Float64Array // rows*cols, decibels, row-major [row*cols + col]
  maxDb: number
  minDb: number
}

export interface ReassignResult {
  stft: Tfr // ordinary spectrogram (Gaussian window) — the baseline
  reassigned: Tfr // reassigned spectrogram (sharpened in time *and* frequency)
  synchro: Tfr // synchrosqueezed (sharpened in frequency, time preserved)
  ridge: Float64Array // per column: dominant reassigned frequency (Hz), NaN if silent
  frameTimes: Float64Array // seconds at each column centre
  fs: number
  hop: number
  cols: number
  rows: number
  binHz: number // Hz per frequency row (fs / L)
  // Rényi entropy (order 3, bits) of the normalized energy — a concentration
  // measure. Lower means sharper; the reassigned value should sit well below the
  // STFT's, which is the whole point.
  entropy: { stft: number; reassigned: number }
}

interface Gaussians {
  h: Float64Array // analysis window
  th: Float64Array // time-ramped window τ·h
  dh: Float64Array // derivative window h′ = −(τ/σ²)·h
}

/** Build the Gaussian analysis window and its two companion windows. */
export function gaussianWindows(L: number, sigma: number): Gaussians {
  const h = new Float64Array(L)
  const th = new Float64Array(L)
  const dh = new Float64Array(L)
  const c = (L - 1) / 2
  const s2 = sigma * sigma
  for (let j = 0; j < L; j++) {
    const tau = j - c
    const g = Math.exp(-0.5 * (tau * tau) / s2)
    h[j] = g
    th[j] = tau * g
    dh[j] = -(tau / s2) * g
  }
  return { h, th, dh }
}

// Reusable FFT of a real frame multiplied by a window, written into `out`.
function windowedFft(
  signal: Float64Array,
  start: number,
  win: Float64Array,
  scratchRe: Float64Array,
  scratchIm: Float64Array,
) {
  const L = win.length
  for (let j = 0; j < L; j++) {
    const idx = start + j
    scratchRe[j] = idx >= 0 && idx < signal.length ? signal[idx] * win[j] : 0
    scratchIm[j] = 0
  }
  fftInPlace({ re: scratchRe, im: scratchIm, length: L }, false)
}

/** Rényi entropy of order 3 (in bits) of a non-negative energy grid. */
function renyiEntropy(power: Float64Array): number {
  let total = 0
  for (let i = 0; i < power.length; i++) total += power[i]
  if (total <= 0) return 0
  let s = 0 // Σ p_i^3
  for (let i = 0; i < power.length; i++) {
    const p = power[i] / total
    s += p * p * p
  }
  if (s <= 0) return 0
  return (Math.log2(s) / (1 - 3)) // 1/(1-α)·log2 Σ pᵢ^α, α = 3
}

function powerToDb(power: Float64Array, cols: number, rows: number): Tfr {
  let maxP = 0
  for (let i = 0; i < power.length; i++) if (power[i] > maxP) maxP = power[i]
  const ref = maxP > 0 ? maxP : 1
  const data = new Float64Array(power.length)
  let maxDb = -Infinity
  let minDb = Infinity
  for (let i = 0; i < power.length; i++) {
    const db = 10 * Math.log10(power[i] / ref + 1e-12)
    data[i] = db
    if (db > maxDb) maxDb = db
    if (db < minDb) minDb = db
  }
  if (!isFinite(maxDb)) {
    maxDb = 0
    minDb = -120
  }
  return { cols, rows, data, maxDb, minDb }
}

/**
 * Compute the ordinary, reassigned, and synchrosqueezed spectrograms of a real
 * signal. All three share one Gaussian analysis window so the comparison is
 * honest — only the *placement* of energy differs.
 */
export function reassignSpectrogram(signal: Float64Array, opts: ReassignOptions): ReassignResult {
  const L = nextPow2(opts.fftSize)
  const hop = Math.max(1, Math.floor(opts.hop))
  const fs = opts.fs
  const rows = L >> 1
  const binHz = fs / L
  const floorRel = opts.powerFloorRel ?? 1e-4
  const { h, th, dh } = gaussianWindows(L, opts.sigma)
  const c = (L - 1) / 2

  // Frame starts so the window is fully inside the signal.
  const starts: number[] = []
  for (let start = 0; start + L <= signal.length; start += hop) starts.push(start)
  if (starts.length === 0) starts.push(0)
  const cols = starts.length

  const frameTimes = new Float64Array(cols)
  for (let ci = 0; ci < cols; ci++) frameTimes[ci] = (starts[ci] + c) / fs

  // Scratch FFT buffers reused across frames.
  const hRe = new Float64Array(L)
  const hIm = new Float64Array(L)
  const tRe = new Float64Array(L)
  const tIm = new Float64Array(L)
  const dRe = new Float64Array(L)
  const dIm = new Float64Array(L)

  const stftPower = new Float64Array(rows * cols)
  const reassignedPower = new Float64Array(rows * cols)
  const synchroPower = new Float64Array(rows * cols)
  // Track the strongest reassigned frequency per column for the ridge.
  const ridgePower = new Float64Array(cols)
  const ridge = new Float64Array(cols).fill(NaN)

  // First pass to find the global peak power for the floor gate.
  let peakPower = 0

  // We store per-frame magnitudes to avoid recomputing; but memory-friendly:
  // do it in a single pass, gating against a peak estimated from the STFT grid.
  // Simplest correct approach: two passes. Pass 1 fills stftPower and finds peak.
  const twoPi = 2 * Math.PI

  // Pass 1: ordinary spectrogram + peak.
  const cache: { start: number; ci: number }[] = starts.map((start, ci) => ({ start, ci }))
  for (const { start, ci } of cache) {
    windowedFft(signal, start, h, hRe, hIm)
    for (let k = 0; k < rows; k++) {
      const p = hRe[k] * hRe[k] + hIm[k] * hIm[k]
      stftPower[k * cols + ci] = p
      if (p > peakPower) peakPower = p
    }
  }
  const floor = peakPower * floorRel

  // Pass 2: reassignment. Recompute the three windowed FFTs and scatter.
  for (const { start, ci } of cache) {
    windowedFft(signal, start, h, hRe, hIm)
    windowedFft(signal, start, th, tRe, tIm)
    windowedFft(signal, start, dh, dRe, dIm)
    for (let k = 0; k < rows; k++) {
      const Xr = hRe[k]
      const Xi = hIm[k]
      const denom = Xr * Xr + Xi * Xi
      if (denom <= floor || denom <= 0) continue

      // Re( X_Th · conj(X_h) ) / |X_h|²  → time-offset correction (samples).
      const tHatOffset = (tRe[k] * Xr + tIm[k] * Xi) / denom
      // Im( X_Dh · conj(X_h) ) / |X_h|²  → frequency correction (rad/sample).
      const imDh = (dIm[k] * Xr - dRe[k] * Xi) / denom
      const omegaHat = (twoPi * k) / L - imDh // rad/sample
      const fHat = (omegaHat * fs) / twoPi // Hz

      if (fHat < 0 || fHat >= fs / 2) continue

      const row = Math.round(fHat / binHz)
      if (row < 0 || row >= rows) continue

      const power = denom

      // Reassigned: move in both time and frequency.
      const colHat = Math.round((start + c + tHatOffset - c) / hop) // = round((start+off)/hop)
      if (colHat >= 0 && colHat < cols) {
        reassignedPower[row * cols + colHat] += power
        if (power > ridgePower[colHat]) {
          ridgePower[colHat] = power
          ridge[colHat] = fHat
        }
      }

      // Synchrosqueezed: frequency only, keep the time bin.
      synchroPower[row * cols + ci] += power
    }
  }

  const entStft = renyiEntropy(stftPower)
  const entReassigned = renyiEntropy(reassignedPower)

  return {
    stft: powerToDb(stftPower, cols, rows),
    reassigned: powerToDb(reassignedPower, cols, rows),
    synchro: powerToDb(synchroPower, cols, rows),
    ridge,
    frameTimes,
    fs,
    hop,
    cols,
    rows,
    binHz,
    entropy: { stft: entStft, reassigned: entReassigned },
  }
}

// ---------------------------------------------------------------------------
// Multi-component test signals that make the sharpening obvious. These are the
// classic time-frequency showcases: a lone linear chirp, two chirps that cross,
// a sinusoidally modulated (vibrato) tone, a quadratic sweep, and a two-tone +
// chirp mixture. Kept here (not in dsp.ts) so this mode's exotic signals don't
// clutter the other modes' pickers.
// ---------------------------------------------------------------------------

export type TfrSignalName =
  | 'linearChirp'
  | 'crossingChirps'
  | 'sineFM'
  | 'quadraticChirp'
  | 'parallelChirps'
  | 'toneAndChirp'
  | 'impulses'

export const TFR_SIGNALS: { id: TfrSignalName; label: string }[] = [
  { id: 'linearChirp', label: 'Linear chirp' },
  { id: 'crossingChirps', label: 'Crossing chirps' },
  { id: 'parallelChirps', label: 'Parallel chirps' },
  { id: 'sineFM', label: 'Vibrato (sine-FM)' },
  { id: 'quadraticChirp', label: 'Quadratic sweep' },
  { id: 'toneAndChirp', label: 'Tone + chirp' },
  { id: 'impulses', label: 'Impulses + tone' },
]

/**
 * The analytic instantaneous frequency (Hz) of a test signal at time t (s), for
 * the *dominant* / first component. Used by the self-tests to check the ridge.
 */
export function instantaneousFreq(name: TfrSignalName, t: number, dur: number, fs: number): number {
  const ny = fs / 2
  switch (name) {
    case 'linearChirp': {
      const f0 = 0.08 * ny
      const f1 = 0.42 * ny
      return f0 + ((f1 - f0) / dur) * t
    }
    case 'quadraticChirp': {
      const f0 = 0.06 * ny
      const f1 = 0.45 * ny
      return f0 + (f1 - f0) * (t / dur) * (t / dur)
    }
    default:
      return NaN
  }
}

export function makeTfrSignal(name: TfrSignalName, n: number, fs: number): Float64Array {
  const out = new Float64Array(n)
  const dur = n / fs
  const ny = fs / 2
  const chirp = (t: number, f0: number, f1: number) => {
    const rate = (f1 - f0) / dur
    return Math.sin(2 * Math.PI * (f0 * t + 0.5 * rate * t * t))
  }
  for (let i = 0; i < n; i++) {
    const t = i / fs
    let v = 0
    switch (name) {
      case 'linearChirp':
        v = chirp(t, 0.08 * ny, 0.42 * ny)
        break
      case 'crossingChirps':
        v = 0.8 * chirp(t, 0.08 * ny, 0.44 * ny) + 0.8 * chirp(t, 0.44 * ny, 0.08 * ny)
        break
      case 'parallelChirps':
        v = 0.7 * chirp(t, 0.1 * ny, 0.3 * ny) + 0.7 * chirp(t, 0.16 * ny, 0.36 * ny)
        break
      case 'sineFM': {
        const fc = 0.25 * ny
        const dev = 0.12 * ny
        const fm = 3 // Hz vibrato rate
        // phase = ∫ 2π f(t) dt, f(t) = fc + dev·sin(2π fm t)
        const phase =
          2 * Math.PI * fc * t - ((dev / fm) * Math.cos(2 * Math.PI * fm * t) - dev / fm)
        v = Math.sin(phase)
        break
      }
      case 'quadraticChirp': {
        const f0 = 0.06 * ny
        const f1 = 0.45 * ny
        // f(t) = f0 + (f1-f0)(t/dur)²  → phase = ∫2πf dt
        const a = (f1 - f0) / (dur * dur)
        const phase = 2 * Math.PI * (f0 * t + (a / 3) * t * t * t)
        v = Math.sin(phase)
        break
      }
      case 'toneAndChirp':
        v = 0.7 * Math.sin(2 * Math.PI * 0.18 * ny * t) + 0.7 * chirp(t, 0.28 * ny, 0.46 * ny)
        break
      case 'impulses': {
        v = 0.5 * Math.sin(2 * Math.PI * 0.2 * ny * t)
        for (const frac of [0.25, 0.5, 0.75]) {
          const centre = Math.round(frac * n)
          if (i === centre) v += 3
        }
        break
      }
    }
    out[i] = v
  }
  return out
}
