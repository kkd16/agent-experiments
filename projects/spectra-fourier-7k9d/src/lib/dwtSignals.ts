// Test signals for the discrete-wavelet modes.
//
// The four "Blocks / Bumps / HeaviSine / Doppler" functions are the canonical
// Donoho–Johnstone benchmark suite (Biometrika 1994) used to study wavelet
// denoising: each stresses a different regularity — jumps, spikes, a smooth
// wave with two discontinuities, and a chirp whose frequency blows up near the
// origin. They are exactly the signals wavelet shrinkage was designed to beat.

import { mulberry32 } from './cs'

export type DwtSignalName = 'blocks' | 'bumps' | 'heavisine' | 'doppler' | 'ramps' | 'piece-regular'

export const DWT_SIGNALS: { id: DwtSignalName; label: string }[] = [
  { id: 'blocks', label: 'Blocks' },
  { id: 'bumps', label: 'Bumps' },
  { id: 'heavisine', label: 'HeaviSine' },
  { id: 'doppler', label: 'Doppler' },
  { id: 'ramps', label: 'Ramps' },
  { id: 'piece-regular', label: 'Piece-Regular' },
]

const POS = [0.1, 0.13, 0.15, 0.23, 0.25, 0.4, 0.44, 0.65, 0.76, 0.78, 0.81]

function blocks(t: number): number {
  const h = [4, -5, 3, -4, 5, -4.2, 2.1, 4.3, -3.1, 2.1, -4.2]
  let v = 0
  for (let j = 0; j < POS.length; j++) v += h[j] * (1 + Math.sign(t - POS[j])) / 2
  return v
}

function bumps(t: number): number {
  const h = [4, 5, 3, 4, 5, 4.2, 2.1, 4.3, 3.1, 5.1, 4.2]
  const w = [0.005, 0.005, 0.006, 0.01, 0.01, 0.03, 0.01, 0.01, 0.005, 0.008, 0.005]
  let v = 0
  for (let j = 0; j < POS.length; j++) {
    const x = Math.abs((t - POS[j]) / w[j])
    v += h[j] * Math.pow(1 + x, -4)
  }
  return v
}

function heavisine(t: number): number {
  return 4 * Math.sin(4 * Math.PI * t) - Math.sign(t - 0.3) - Math.sign(0.72 - t)
}

function doppler(t: number): number {
  const eps = 0.05
  return Math.sqrt(t * (1 - t)) * Math.sin((2 * Math.PI * (1 + eps)) / (t + eps))
}

function ramps(t: number): number {
  // A sawtooth of rising ramps with sharp resets — smooth regions + jumps.
  const edges = [0.1, 0.25, 0.45, 0.6, 0.85]
  let v = 0
  for (const e of edges) v += (t >= e ? 1 : 0)
  return (t * 3) % 1 > 0.5 ? v - 0.5 : v
}

function pieceRegular(t: number): number {
  // A mix of a smooth sinusoid, a quiet flat, and a rougher high-frequency patch.
  if (t < 0.3) return Math.sin(6 * Math.PI * t)
  if (t < 0.55) return 0.2
  if (t < 0.78) return Math.sin(24 * Math.PI * t) * 0.8
  return 1.4 * (t - 0.78) * 5 - 1
}

/** Sample a named test signal on [0,1) at n points, roughly unit-scaled. */
export function dwtSignal(name: DwtSignalName, n: number): Float64Array {
  const out = new Float64Array(n)
  const f =
    name === 'blocks'
      ? blocks
      : name === 'bumps'
        ? bumps
        : name === 'heavisine'
          ? heavisine
          : name === 'doppler'
            ? doppler
            : name === 'ramps'
              ? ramps
              : pieceRegular
  for (let i = 0; i < n; i++) out[i] = f(i / n)
  // Normalise to zero mean, unit-ish RMS so a chosen noise σ means the same thing
  // across signals.
  let mean = 0
  for (let i = 0; i < n; i++) mean += out[i]
  mean /= n
  let rms = 0
  for (let i = 0; i < n; i++) {
    out[i] -= mean
    rms += out[i] * out[i]
  }
  rms = Math.sqrt(rms / n) || 1
  for (let i = 0; i < n; i++) out[i] /= rms
  return out
}

/** A composite multi-scale signal for the multiresolution view: a low carrier, a
 *  mid tone burst, and a sharp transient — so the bands visibly separate. */
export function mraDemoSignal(n: number): Float64Array {
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / n
    let v = Math.sin(2 * Math.PI * 3 * t) // slow carrier → approximation band
    if (t > 0.3 && t < 0.6) v += 0.6 * Math.sin(2 * Math.PI * 40 * t) // mid burst
    v += 0.35 * Math.sin(2 * Math.PI * 110 * t) // steady high detail
    const tc = 0.75
    v += 1.2 * Math.exp(-((t - tc) ** 2) / (2 * 0.004 ** 2)) // sharp click
    out[i] = v
  }
  return out
}

/** Add deterministic i.i.d. Gaussian noise of standard deviation σ. */
export function addNoise(x: Float64Array, sigma: number, seed = 7): Float64Array {
  const rng = mulberry32(seed)
  const out = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) {
    const u1 = Math.max(rng(), 1e-12)
    const u2 = rng()
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    out[i] = x[i] + sigma * g
  }
  return out
}
