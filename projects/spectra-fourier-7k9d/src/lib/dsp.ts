// Digital signal building blocks: window functions, canonical test signals, an
// additive (harmonic) synthesizer, and small helpers.

export type WindowName = 'rect' | 'hann' | 'hamming' | 'blackman'

export const WINDOWS: { id: WindowName; label: string }[] = [
  { id: 'rect', label: 'Rectangular' },
  { id: 'hann', label: 'Hann' },
  { id: 'hamming', label: 'Hamming' },
  { id: 'blackman', label: 'Blackman' },
]

/** Return the window coefficients of length n for the given window. */
export function windowFn(name: WindowName, n: number): Float64Array {
  const w = new Float64Array(n)
  if (n === 1) {
    w[0] = 1
    return w
  }
  const N = n - 1
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / N
    switch (name) {
      case 'rect':
        w[i] = 1
        break
      case 'hann':
        w[i] = 0.5 - 0.5 * Math.cos(x)
        break
      case 'hamming':
        w[i] = 0.54 - 0.46 * Math.cos(x)
        break
      case 'blackman':
        w[i] = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x)
        break
    }
  }
  return w
}

/** Coherent gain of a window (mean of coefficients) — used to normalize spectra. */
export function windowGain(w: Float64Array): number {
  let s = 0
  for (let i = 0; i < w.length; i++) s += w[i]
  return s / w.length
}

/** Apply a window to a signal in place-safe fashion (returns a new array). */
export function applyWindow(signal: Float64Array, w: Float64Array): Float64Array {
  const out = new Float64Array(signal.length)
  for (let i = 0; i < signal.length; i++) out[i] = signal[i] * w[i]
  return out
}

// ---------------------------------------------------------------------------
// Test signals. All take a length n and a sample rate fs (Hz).
// ---------------------------------------------------------------------------

export type SignalName =
  | 'sine'
  | 'square'
  | 'sawtooth'
  | 'triangle'
  | 'chirp'
  | 'noise'
  | 'impulse'
  | 'twoTone'

export const SIGNALS: { id: SignalName; label: string }[] = [
  { id: 'sine', label: 'Sine' },
  { id: 'square', label: 'Square' },
  { id: 'sawtooth', label: 'Sawtooth' },
  { id: 'triangle', label: 'Triangle' },
  { id: 'twoTone', label: 'Two tones' },
  { id: 'chirp', label: 'Chirp (sweep)' },
  { id: 'noise', label: 'White noise' },
  { id: 'impulse', label: 'Impulse' },
]

// A tiny deterministic PRNG so "noise" is reproducible across renders.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface SignalOptions {
  freq: number // Hz (base frequency)
  fs: number // sample rate Hz
  amp: number
  noise: number // added white-noise amplitude
  seed: number
}

export function generateSignal(name: SignalName, n: number, opts: SignalOptions): Float64Array {
  const { freq, fs, amp, noise, seed } = opts
  const out = new Float64Array(n)
  const rng = mulberry32(seed)
  for (let i = 0; i < n; i++) {
    const t = i / fs
    let v = 0
    switch (name) {
      case 'sine':
        v = Math.sin(2 * Math.PI * freq * t)
        break
      case 'square':
        v = Math.sign(Math.sin(2 * Math.PI * freq * t))
        break
      case 'sawtooth': {
        const p = (freq * t) % 1
        v = 2 * p - 1
        break
      }
      case 'triangle': {
        const p = (freq * t) % 1
        v = 4 * Math.abs(p - 0.5) - 1
        break
      }
      case 'twoTone':
        v = 0.6 * Math.sin(2 * Math.PI * freq * t) + 0.4 * Math.sin(2 * Math.PI * freq * 2.5 * t)
        break
      case 'chirp': {
        // Linear sweep from freq to freq*8 across the buffer.
        const dur = n / fs
        const f1 = freq * 8
        const rate = (f1 - freq) / dur
        v = Math.sin(2 * Math.PI * (freq * t + 0.5 * rate * t * t))
        break
      }
      case 'noise':
        v = 0
        break
      case 'impulse':
        v = i === (n >> 3) ? 1 : 0
        break
    }
    out[i] = amp * v + noise * (rng() * 2 - 1)
  }
  return out
}

// ---------------------------------------------------------------------------
// Additive (harmonic) synthesis — build a signal from a set of partials.
// ---------------------------------------------------------------------------

export interface Partial {
  harmonic: number // integer multiple of the fundamental
  amp: number // 0..1
  phase: number // radians
}

export function additiveSignal(
  partials: Partial[],
  n: number,
  fundamental: number,
  fs: number,
): Float64Array {
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / fs
    let v = 0
    for (const p of partials) {
      v += p.amp * Math.sin(2 * Math.PI * fundamental * p.harmonic * t + p.phase)
    }
    out[i] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Peak absolute value of a signal (>= epsilon). */
export function peak(signal: ArrayLike<number>): number {
  let m = 1e-12
  for (let i = 0; i < signal.length; i++) {
    const a = Math.abs(signal[i])
    if (a > m) m = a
  }
  return m
}

/** Convert a linear magnitude to decibels relative to `ref`. */
export function toDb(mag: number, ref = 1): number {
  return 20 * Math.log10(Math.max(mag, 1e-12) / ref)
}

/** Linearly resample a 1D array to `m` points. */
export function resample1d(src: ArrayLike<number>, m: number): Float64Array {
  const n = src.length
  const out = new Float64Array(m)
  if (n === 0) return out
  if (n === 1) {
    out.fill(src[0])
    return out
  }
  for (let i = 0; i < m; i++) {
    const x = (i * (n - 1)) / (m - 1)
    const i0 = Math.floor(x)
    const i1 = Math.min(i0 + 1, n - 1)
    const f = x - i0
    out[i] = src[i0] * (1 - f) + src[i1] * f
  }
  return out
}
