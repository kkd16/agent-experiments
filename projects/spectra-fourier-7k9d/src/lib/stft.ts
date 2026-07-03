// Short-time Fourier transform: slide a window across the signal, FFT each frame,
// and keep the magnitude of the lower half (real signal → symmetric spectrum).
// The result is a time × frequency matrix suitable for a spectrogram.

import { makeComplex } from './complex'
import { fftInPlace, nextPow2 } from './fft'
import { applyWindow, windowFn } from './dsp'
import type { WindowName } from './dsp'

export interface StftResult {
  frames: Float64Array[] // one magnitude column per frame, length = fftSize/2
  fftSize: number
  hop: number
  bins: number // fftSize / 2
  maxDb: number
  minDb: number
}

export interface StftOptions {
  fftSize: number // power of two
  hop: number // samples between frame starts
  window: WindowName
}

export function stft(signal: Float64Array, opts: StftOptions): StftResult {
  const fftSize = nextPow2(opts.fftSize)
  const hop = Math.max(1, opts.hop)
  const bins = fftSize >> 1
  const win = windowFn(opts.window, fftSize)
  const frames: Float64Array[] = []
  let maxDb = -Infinity
  let minDb = Infinity

  for (let start = 0; start + fftSize <= signal.length; start += hop) {
    const frame = signal.subarray(start, start + fftSize)
    const windowed = applyWindow(frame as Float64Array, win)
    const c = makeComplex(fftSize)
    c.re.set(windowed)
    fftInPlace(c, false)
    const col = new Float64Array(bins)
    for (let k = 0; k < bins; k++) {
      const mag = Math.hypot(c.re[k], c.im[k]) / fftSize
      const db = 20 * Math.log10(mag + 1e-9)
      col[k] = db
      if (db > maxDb) maxDb = db
      if (db < minDb) minDb = db
    }
    frames.push(col)
  }

  if (!isFinite(maxDb)) {
    maxDb = 0
    minDb = -120
  }
  return { frames, fftSize, hop, bins, maxDb, minDb }
}
