// Filter-order estimators — the inverse of design: given the tolerances, how
// cheap a filter meets them?
//
// A spec is four numbers: a passband edge fp, a stopband edge fs, a maximum
// passband ripple Rp (dB) and a minimum stopband attenuation Rs (dB). Each classic
// family has a closed-form minimum order that just satisfies that spec; the FIR
// (Parks–McClellan) has a length *estimate*. These are the textbook `buttord`,
// `cheb1ord`, `cheb2ord`, `ellipord` and Kaiser formulas, computed against the
// bilinear-prewarped analog band edges so the estimate matches the filter that
// `filterdesign.ts` will actually build.

import { ellipk } from './ellip'

export interface FilterSpec {
  /** passband edge, Hz */
  fp: number
  /** stopband edge, Hz */
  fs: number
  /** max passband ripple, dB */
  rp: number
  /** min stopband attenuation, dB */
  rs: number
  /** sample rate, Hz */
  fsamp: number
  response: 'low' | 'high'
}

export interface OrderEstimate {
  butter: number
  cheby1: number
  cheby2: number
  ellip: number
  /** Parks–McClellan tap count (odd). */
  firRemez: number
}

// Bilinear pre-warp: digital Hz → analog rad/s (up to a common scale that cancels
// in every ratio below). Matches the warp used by the IIR design pipeline.
function warp(fHz: number, fsamp: number): number {
  const wn = Math.min(0.999, Math.max(1e-4, (2 * fHz) / fsamp)) // fraction of Nyquist
  return Math.tan((Math.PI * wn) / 2)
}

/**
 * The lowpass-normalised selectivity ratio (always > 1): the stopband edge over
 * the passband edge in the prototype's frame. Low-pass keeps the order; high-pass
 * inverts it (ω → 1/ω), so the roles of the two edges swap.
 */
function selectivity(spec: FilterSpec): number {
  const Wp = warp(spec.fp, spec.fsamp)
  const Ws = warp(spec.fs, spec.fsamp)
  const ratio = spec.response === 'low' ? Ws / Wp : Wp / Ws
  return Math.max(ratio, 1 + 1e-9)
}

function gpass(rp: number): number {
  return Math.pow(10, rp / 10) - 1
}
function gstop(rs: number): number {
  return Math.pow(10, rs / 10) - 1
}

export function buttord(spec: FilterSpec): number {
  const r = selectivity(spec)
  const n = Math.log10(gstop(spec.rs) / gpass(spec.rp)) / (2 * Math.log10(r))
  return Math.max(1, Math.ceil(n))
}

export function cheb1ord(spec: FilterSpec): number {
  const r = selectivity(spec)
  const n = Math.acosh(Math.sqrt(gstop(spec.rs) / gpass(spec.rp))) / Math.acosh(r)
  return Math.max(1, Math.ceil(n))
}

// Chebyshev-II needs the same order as Chebyshev-I for the same spec.
export function cheb2ord(spec: FilterSpec): number {
  return cheb1ord(spec)
}

export function ellipord(spec: FilterSpec): number {
  const r = selectivity(spec)
  const k = 1 / r // selectivity modulus (< 1)
  const k1 = Math.sqrt(gpass(spec.rp) / gstop(spec.rs)) // discrimination modulus (< 1)
  const kp = Math.sqrt(1 - k * k)
  const k1p = Math.sqrt(1 - k1 * k1)
  // n = K(k)·K'(k1) / (K'(k)·K(k1))
  const n = (ellipk(k * k) * ellipk(k1p * k1p)) / (ellipk(kp * kp) * ellipk(k1 * k1))
  return Math.max(1, Math.ceil(n))
}

// Kaiser's estimate for the Parks–McClellan tap count (rounded up to odd).
export function remezOrd(spec: FilterSpec): number {
  const dp = (Math.pow(10, spec.rp / 20) - 1) / (Math.pow(10, spec.rp / 20) + 1)
  const ds = Math.pow(10, -spec.rs / 20)
  const df = Math.abs(spec.fs - spec.fp) / spec.fsamp // transition width, cycles/sample
  const num = -20 * Math.log10(Math.sqrt(dp * ds)) - 13
  let n = Math.ceil(num / (14.6 * df)) + 1
  if (n % 2 === 0) n += 1
  return Math.max(3, n)
}

export function estimateOrders(spec: FilterSpec): OrderEstimate {
  return {
    butter: buttord(spec),
    cheby1: cheb1ord(spec),
    cheby2: cheb2ord(spec),
    ellip: ellipord(spec),
    firRemez: remezOrd(spec),
  }
}
