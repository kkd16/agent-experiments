// OFDM — orthogonal frequency-division multiplexing, the technique behind Wi-Fi,
// LTE, 5G and DVB. It is the single most consequential application of the FFT in
// communications, so it belongs in a Fourier lab. The idea: instead of sending
// one fast symbol stream through a frequency-selective (echoey) channel, spread
// the data across many slow, orthogonal subcarriers with an IFFT. A short
// **cyclic prefix** turns the channel's linear convolution into a *circular* one,
// so after the receiver's FFT every subcarrier sees only a single complex gain —
// which a one-tap-per-carrier equalizer inverts. A hard multipath channel
// collapses into N independent flat channels.
//
// Built on the app's own FFT (fft/ifft), no libraries.

import { makeComplex } from './complex'
import { fft, ifft } from './fft'

export interface OfdmConfig {
  /** FFT size (number of subcarriers). Power of two. */
  nfft: number
  /** cyclic-prefix length in samples. */
  cpLen: number
  /** indices of the data-bearing subcarriers (others are nulled: DC + guards). */
  active: number[]
}

export interface CSig {
  re: Float64Array
  im: Float64Array
  length: number
}

/**
 * Default active-subcarrier set: drop DC (bin 0) and `guard` bins at each band
 * edge (Nyquist region), matching how real OFDM systems leave guard bands.
 */
export function activeCarriers(nfft: number, guard: number): number[] {
  const active: number[] = []
  for (let k = 1; k < nfft; k++) {
    // Distance to the nearest edge in the wrap-around spectrum.
    const edge = Math.min(k, nfft - k)
    if (edge <= guard) continue
    active.push(k)
  }
  return active
}

/**
 * Modulate one OFDM symbol: place `active.length` QAM symbols on the active
 * subcarriers, IFFT to the time domain, and prepend the cyclic prefix.
 * Returns nfft + cpLen complex time samples.
 */
export function modulateSymbol(symRe: ArrayLike<number>, symIm: ArrayLike<number>, cfg: OfdmConfig): CSig {
  const { nfft, cpLen, active } = cfg
  const X = makeComplex(nfft)
  for (let i = 0; i < active.length; i++) {
    X.re[active[i]] = symRe[i]
    X.im[active[i]] = symIm[i]
  }
  const time = ifft(X)
  const out = { re: new Float64Array(nfft + cpLen), im: new Float64Array(nfft + cpLen), length: nfft + cpLen }
  // Cyclic prefix: copy the last cpLen samples to the front.
  for (let i = 0; i < cpLen; i++) {
    out.re[i] = time.re[nfft - cpLen + i]
    out.im[i] = time.im[nfft - cpLen + i]
  }
  for (let i = 0; i < nfft; i++) {
    out.re[cpLen + i] = time.re[i]
    out.im[cpLen + i] = time.im[i]
  }
  return out
}

/** Modulate a stream of symbols (length must be a multiple of active.length). */
export function modulate(symRe: ArrayLike<number>, symIm: ArrayLike<number>, cfg: OfdmConfig): CSig {
  const nActive = cfg.active.length
  const nSyms = Math.floor(symRe.length / nActive)
  const symLen = cfg.nfft + cfg.cpLen
  const out = { re: new Float64Array(nSyms * symLen), im: new Float64Array(nSyms * symLen), length: nSyms * symLen }
  for (let b = 0; b < nSyms; b++) {
    const sr = new Float64Array(nActive)
    const si = new Float64Array(nActive)
    for (let i = 0; i < nActive; i++) {
      sr[i] = symRe[b * nActive + i]
      si[i] = symIm[b * nActive + i]
    }
    const blk = modulateSymbol(sr, si, cfg)
    out.re.set(blk.re, b * symLen)
    out.im.set(blk.im, b * symLen)
  }
  return out
}

/** Linear convolution of a complex signal with a complex channel impulse response. */
export function applyChannel(sig: CSig, hRe: ArrayLike<number>, hIm: ArrayLike<number>): CSig {
  const n = sig.length
  const m = hRe.length
  const out = { re: new Float64Array(n + m - 1), im: new Float64Array(n + m - 1), length: n + m - 1 }
  for (let i = 0; i < n; i++) {
    const xr = sig.re[i]
    const xi = sig.im[i]
    for (let j = 0; j < m; j++) {
      // (xr+ixi)(hr+ihi)
      out.re[i + j] += xr * hRe[j] - xi * hIm[j]
      out.im[i + j] += xr * hIm[j] + xi * hRe[j]
    }
  }
  return out
}

/** Channel frequency response H[k] over the nfft subcarriers (FFT of padded h). */
export function channelResponse(hRe: ArrayLike<number>, hIm: ArrayLike<number>, nfft: number): CSig {
  const H = makeComplex(nfft)
  for (let i = 0; i < hRe.length && i < nfft; i++) {
    H.re[i] = hRe[i]
    H.im[i] = hIm[i]
  }
  const F = fft(H)
  return { re: F.re, im: F.im, length: nfft }
}

export interface DemodResult {
  /** received symbols on the active carriers (concatenated across OFDM symbols). */
  symRe: Float64Array
  symIm: Float64Array
  /** the same, before equalization (raw FFT bins), for the before/after view. */
  rawRe: Float64Array
  rawIm: Float64Array
}

/**
 * Demodulate: strip the CP of each block, FFT, pull the active subcarriers, and
 * apply zero-forcing equalization X̂[k] = Y[k]/H[k] when a channel response is
 * given. Without H, returns the raw bins (H = 1).
 */
export function demodulate(sig: CSig, cfg: OfdmConfig, H?: CSig): DemodResult {
  const { nfft, cpLen, active } = cfg
  const symLen = nfft + cpLen
  const nSyms = Math.floor(sig.length / symLen)
  const nActive = active.length
  const symRe = new Float64Array(nSyms * nActive)
  const symIm = new Float64Array(nSyms * nActive)
  const rawRe = new Float64Array(nSyms * nActive)
  const rawIm = new Float64Array(nSyms * nActive)
  for (let b = 0; b < nSyms; b++) {
    const block = makeComplex(nfft)
    for (let i = 0; i < nfft; i++) {
      block.re[i] = sig.re[b * symLen + cpLen + i]
      block.im[i] = sig.im[b * symLen + cpLen + i]
    }
    const Y = fft(block)
    for (let i = 0; i < nActive; i++) {
      const k = active[i]
      const yr = Y.re[k]
      const yi = Y.im[k]
      rawRe[b * nActive + i] = yr
      rawIm[b * nActive + i] = yi
      if (H) {
        const hr = H.re[k]
        const hi = H.im[k]
        const d = hr * hr + hi * hi || 1e-30
        // (yr+iyi)/(hr+ihi)
        symRe[b * nActive + i] = (yr * hr + yi * hi) / d
        symIm[b * nActive + i] = (yi * hr - yr * hi) / d
      } else {
        symRe[b * nActive + i] = yr
        symIm[b * nActive + i] = yi
      }
    }
  }
  return { symRe, symIm, rawRe, rawIm }
}

/**
 * Peak-to-average power ratio (dB) of a time-domain signal — OFDM's Achilles
 * heel: summing many subcarriers can produce large peaks that stress the power
 * amplifier. Measured over the signal body (CP included).
 */
export function paprDb(sig: CSig): number {
  let peak = 0
  let sum = 0
  for (let i = 0; i < sig.length; i++) {
    const p = sig.re[i] * sig.re[i] + sig.im[i] * sig.im[i]
    if (p > peak) peak = p
    sum += p
  }
  const avg = sum / sig.length
  if (avg <= 0) return 0
  return 10 * Math.log10(peak / avg)
}

/** Add complex AWGN in place to a copy, returning the noisy signal. */
export function addNoise(sig: CSig, sigma: number, rng: () => number, gaussian: (r: () => number) => number): CSig {
  const out = { re: Float64Array.from(sig.re), im: Float64Array.from(sig.im), length: sig.length }
  for (let i = 0; i < sig.length; i++) {
    out.re[i] += sigma * gaussian(rng)
    out.im[i] += sigma * gaussian(rng)
  }
  return out
}

export interface ChannelPreset {
  id: string
  label: string
  hRe: number[]
  hIm: number[]
}

/** A few illustrative channel impulse responses (taps within a typical CP). */
export const CHANNELS: ChannelPreset[] = [
  { id: 'flat', label: 'Flat (ideal)', hRe: [1], hIm: [0] },
  { id: 'twopath', label: 'Two-path echo', hRe: [1, 0, 0, 0.6], hIm: [0, 0, 0, -0.15] },
  { id: 'multipath', label: 'Rich multipath', hRe: [1, 0.4, -0.25, 0, 0.15, 0, -0.1], hIm: [0, 0.2, 0.1, 0, -0.08, 0, 0.05] },
  { id: 'deepfade', label: 'Deep fade', hRe: [1, 0, 0.95], hIm: [0, 0, 0] },
]
