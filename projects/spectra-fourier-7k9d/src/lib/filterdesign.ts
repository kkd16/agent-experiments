// A from-scratch digital-filter design engine.
//
// This is the numerical heart of the Design studio. It turns a high-level spec
// ("6th-order Butterworth low-pass at 120 Hz") into a concrete transfer function
// you can *see* on the z-plane, *measure* (magnitude / phase / group delay), and
// *run* on a signal — with no DSP library underneath, only the complex/polynomial
// primitives in `cplx.ts` and `poly.ts`.
//
// The pipeline mirrors the classic textbook route and scipy's `iirfilter`:
//
//   analog prototype (Butterworth / Chebyshev)      — poles & zeros in the s-plane
//        │  lp2lp / lp2hp / lp2bp / lp2bs            — analog frequency transform
//        ▼
//   bilinear transform  s → z  (with frequency pre-warp)
//        │
//        ▼
//   zeros / poles / gain in the z-plane  ─► second-order sections ─► difference eq.
//
// FIR filters take the parallel windowed-sinc route, and their many zeros are
// recovered for the z-plane by factoring the tap polynomial (Durand–Kerner).

import type { Cx } from './cplx'
import {
  cx,
  cadd,
  csub,
  cmul,
  cdiv,
  cscale,
  cabs,
  carg,
  csqrt,
  cunit,
  CONE,
} from './cplx'
import { polyRoots } from './poly'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FamilyId = 'butter' | 'cheby1' | 'cheby2' | 'fir' | 'biquad' | 'manual'
export type ResponseType = 'low' | 'high' | 'band' | 'notch'
export type BiquadType =
  | 'lowpass'
  | 'highpass'
  | 'bandpass'
  | 'notch'
  | 'peak'
  | 'lowshelf'
  | 'highshelf'

/** A single second-order section, a0 normalised to 1. */
export interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

export interface Design {
  kind: 'iir' | 'fir'
  zeros: Cx[]
  poles: Cx[]
  gain: number
  sos: Biquad[]
  taps: Float64Array | null
  order: number
  stable: boolean
  fs: number
  label: string
}

export interface DesignParams {
  family: FamilyId
  response: ResponseType
  order: number
  fs: number
  // cutoff (low-pass / high-pass) or band edges (band / notch), in Hz
  cutoff: number
  cutoffHi: number
  rippleDb: number // Chebyshev-I passband ripple
  stopDb: number // Chebyshev-II stopband attenuation
  // biquad-cookbook knobs
  biquadType: BiquadType
  q: number
  gainDb: number
  // FIR
  taps: number
  window: 'rect' | 'hann' | 'hamming' | 'blackman'
}

interface Zpk {
  z: Cx[]
  p: Cx[]
  k: number
}

// ---------------------------------------------------------------------------
// Complex product helper: ∏ (−rᵢ), taking the real part (roots come conjugate).
// ---------------------------------------------------------------------------

function prodNeg(roots: Cx[]): Cx {
  let acc = CONE
  for (const r of roots) acc = cmul(acc, cx(-r.re, -r.im))
  return acc
}

// ---------------------------------------------------------------------------
// Analog prototypes (normalised low-pass, cutoff = 1 rad/s)
// ---------------------------------------------------------------------------

function butterAP(N: number): Zpk {
  const p: Cx[] = []
  for (let k = 0; k < N; k++) {
    const theta = (Math.PI * (2 * k + 1)) / (2 * N)
    p.push(cx(-Math.sin(theta), Math.cos(theta)))
  }
  return { z: [], p, k: 1 }
}

function cheby1AP(N: number, rippleDb: number): Zpk {
  const eps = Math.sqrt(Math.pow(10, rippleDb / 10) - 1)
  const mu = Math.asinh(1 / eps) / N
  const p: Cx[] = []
  for (let k = 0; k < N; k++) {
    const theta = (Math.PI * (2 * k + 1)) / (2 * N)
    p.push(cx(-Math.sinh(mu) * Math.sin(theta), Math.cosh(mu) * Math.cos(theta)))
  }
  // k = ∏(−p); even order sits at the ripple bottom at DC.
  let k = prodNeg(p).re
  if (N % 2 === 0) k /= Math.sqrt(1 + eps * eps)
  return { z: [], p, k }
}

function cheby2AP(N: number, stopDb: number): Zpk {
  // de = 1/√(10^(Rs/10) − 1); the inverse-Chebyshev poles are the *reciprocals*
  // of a Chebyshev-I-style pole set (which keeps them in the left half-plane), and
  // the finite zeros sit on the imaginary axis at ±j/cos θ_k (the stopband nulls).
  const de = 1 / Math.sqrt(Math.pow(10, stopDb / 10) - 1)
  const mu = Math.asinh(1 / de) / N
  const p: Cx[] = []
  const z: Cx[] = []
  for (let k = 0; k < N; k++) {
    const theta = (Math.PI * (2 * k + 1)) / (2 * N)
    const base = cx(-Math.sinh(mu) * Math.sin(theta), Math.cosh(mu) * Math.cos(theta))
    p.push(cdiv(CONE, base)) // 1/base — real part stays negative (stable)
    const c = Math.cos(theta)
    if (Math.abs(c) > 1e-8) z.push(cx(0, 1 / c)) // skip the θ=π/2 zero (→ ∞) for odd N
  }
  const k = cdiv(prodNeg(p), prodNeg(z)).re
  return { z, p, k }
}

// ---------------------------------------------------------------------------
// Analog frequency transforms (operate on zpk)
// ---------------------------------------------------------------------------

function lp2lp(zpk: Zpk, wo: number): Zpk {
  const degree = zpk.p.length - zpk.z.length
  return {
    z: zpk.z.map((zi) => cscale(zi, wo)),
    p: zpk.p.map((pi) => cscale(pi, wo)),
    k: zpk.k * Math.pow(wo, degree),
  }
}

function lp2hp(zpk: Zpk, wo: number): Zpk {
  const degree = zpk.p.length - zpk.z.length
  const z = zpk.z.map((zi) => cdiv(cx(wo), zi))
  const p = zpk.p.map((pi) => cdiv(cx(wo), pi))
  for (let i = 0; i < degree; i++) z.push(cx(0)) // zeros at origin
  const k = zpk.k * cdiv(prodNeg(zpk.z), prodNeg(zpk.p)).re
  return { z, p, k }
}

function lp2bp(zpk: Zpk, wo: number, bw: number): Zpk {
  const degree = zpk.p.length - zpk.z.length
  const wo2 = cx(wo * wo)
  const shift = (r: Cx): Cx[] => {
    const lp = cscale(r, bw / 2)
    const root = csqrt(csub(cmul(lp, lp), wo2))
    return [cadd(lp, root), csub(lp, root)]
  }
  const z: Cx[] = []
  for (const zi of zpk.z) z.push(...shift(zi))
  const p: Cx[] = []
  for (const pi of zpk.p) p.push(...shift(pi))
  for (let i = 0; i < degree; i++) z.push(cx(0)) // zeros at origin
  return { z, p, k: zpk.k * Math.pow(bw, degree) }
}

function lp2bs(zpk: Zpk, wo: number, bw: number): Zpk {
  const degree = zpk.p.length - zpk.z.length
  const wo2 = cx(wo * wo)
  const shift = (r: Cx): Cx[] => {
    const hp = cdiv(cx(bw / 2), r)
    const root = csqrt(csub(cmul(hp, hp), wo2))
    return [cadd(hp, root), csub(hp, root)]
  }
  const z: Cx[] = []
  for (const zi of zpk.z) z.push(...shift(zi))
  const p: Cx[] = []
  for (const pi of zpk.p) p.push(...shift(pi))
  // add zeros at ±j·wo (degree of them each)
  for (let i = 0; i < degree; i++) {
    z.push(cx(0, wo))
    z.push(cx(0, -wo))
  }
  const k = zpk.k * cdiv(prodNeg(zpk.z), prodNeg(zpk.p)).re
  return { z, p, k }
}

// ---------------------------------------------------------------------------
// Bilinear transform  s → z
// ---------------------------------------------------------------------------

function bilinear(zpk: Zpk, fs: number): Zpk {
  const fs2 = 2 * fs
  const map = (s: Cx): Cx => cdiv(cx(fs2 + s.re, s.im), cx(fs2 - s.re, -s.im))
  const z = zpk.z.map(map)
  const p = zpk.p.map(map)
  const degree = zpk.p.length - zpk.z.length
  for (let i = 0; i < degree; i++) z.push(cx(-1)) // zeros at Nyquist
  // k scaling: k · Re[ ∏(fs2 − zᵢ) / ∏(fs2 − pⱼ) ]
  const num = zpk.z.reduce((a, s) => cmul(a, cx(fs2 - s.re, -s.im)), CONE)
  const den = zpk.p.reduce((a, s) => cmul(a, cx(fs2 - s.re, -s.im)), CONE)
  const k = zpk.k * cdiv(num, den).re
  return { z, p, k }
}

// ---------------------------------------------------------------------------
// zpk → second-order sections (conjugate pairing)
// ---------------------------------------------------------------------------

function pairRoots(roots: Cx[]): Cx[][] {
  const used = new Array(roots.length).fill(false)
  const groups: Cx[][] = []
  for (let i = 0; i < roots.length; i++) {
    if (used[i]) continue
    used[i] = true
    const r = roots[i]
    if (Math.abs(r.im) < 1e-8) {
      // real root: pair with the next unused real root if any
      let j = -1
      for (let t = i + 1; t < roots.length; t++) {
        if (!used[t] && Math.abs(roots[t].im) < 1e-8) {
          j = t
          break
        }
      }
      if (j >= 0) {
        used[j] = true
        groups.push([r, roots[j]])
      } else {
        groups.push([r])
      }
    } else {
      // complex root: find its conjugate partner
      let best = -1
      let bestD = Infinity
      for (let t = i + 1; t < roots.length; t++) {
        if (used[t]) continue
        const d = Math.abs(roots[t].re - r.re) + Math.abs(roots[t].im + r.im)
        if (d < bestD) {
          bestD = d
          best = t
        }
      }
      if (best >= 0) {
        used[best] = true
        groups.push([r, roots[best]])
      } else {
        groups.push([r])
      }
    }
  }
  return groups
}

/** Real quadratic coefficients [c0, c1, c2] for ∏(x − root) of a 1–2 root group. */
function quadFromGroup(group: Cx[]): [number, number, number] {
  if (group.length === 1) return [1, -group[0].re, 0]
  const [a, b] = group
  const sum = a.re + b.re
  const prod = a.re * b.re - a.im * b.im
  return [1, -sum, prod]
}

export function zpkToSos(z: Cx[], p: Cx[], k: number): Biquad[] {
  const zg = pairRoots(z)
  const pg = pairRoots(p)
  const n = Math.max(zg.length, pg.length)
  const sos: Biquad[] = []
  for (let i = 0; i < n; i++) {
    const [nb0, nb1, nb2] = i < zg.length ? quadFromGroup(zg[i]) : [1, 0, 0]
    const [, na1, na2] = i < pg.length ? quadFromGroup(pg[i]) : [1, 0, 0]
    sos.push({ b0: nb0, b1: nb1, b2: nb2, a1: na1, a2: na2 })
  }
  if (sos.length === 0) sos.push({ b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 })
  // Fold the overall gain into the first section's numerator.
  sos[0].b0 *= k
  sos[0].b1 *= k
  sos[0].b2 *= k
  return sos
}

// ---------------------------------------------------------------------------
// Roots of a single biquad (for z-plane display of cookbook / manual filters)
// ---------------------------------------------------------------------------

function quadRoots(a: number, b: number, c: number): Cx[] {
  if (Math.abs(a) < 1e-14) {
    return Math.abs(b) < 1e-14 ? [] : [cx(-c / b)]
  }
  const disc = b * b - 4 * a * c
  if (disc >= 0) {
    const s = Math.sqrt(disc)
    return [cx((-b + s) / (2 * a)), cx((-b - s) / (2 * a))]
  }
  const s = Math.sqrt(-disc)
  return [cx(-b / (2 * a), s / (2 * a)), cx(-b / (2 * a), -s / (2 * a))]
}

function rootsFromSos(sos: Biquad[]): { zeros: Cx[]; poles: Cx[] } {
  const zeros: Cx[] = []
  const poles: Cx[] = []
  for (const s of sos) {
    zeros.push(...quadRoots(s.b0, s.b1, s.b2))
    poles.push(...quadRoots(1, s.a1, s.a2))
  }
  return { zeros, poles }
}

// ---------------------------------------------------------------------------
// RBJ biquad cookbook
// ---------------------------------------------------------------------------

export function rbjBiquad(type: BiquadType, f0: number, fs: number, Q: number, gainDb: number): Biquad {
  const w0 = (2 * Math.PI * f0) / fs
  const cosw = Math.cos(w0)
  const sinw = Math.sin(w0)
  const alpha = sinw / (2 * Math.max(Q, 1e-4))
  const A = Math.pow(10, gainDb / 40)
  const sqA = Math.sqrt(Math.max(A, 0))
  let b0 = 1
  let b1 = 0
  let b2 = 0
  let a0 = 1
  let a1 = 0
  let a2 = 0
  switch (type) {
    case 'lowpass':
      b0 = (1 - cosw) / 2
      b1 = 1 - cosw
      b2 = (1 - cosw) / 2
      a0 = 1 + alpha
      a1 = -2 * cosw
      a2 = 1 - alpha
      break
    case 'highpass':
      b0 = (1 + cosw) / 2
      b1 = -(1 + cosw)
      b2 = (1 + cosw) / 2
      a0 = 1 + alpha
      a1 = -2 * cosw
      a2 = 1 - alpha
      break
    case 'bandpass':
      b0 = alpha
      b1 = 0
      b2 = -alpha
      a0 = 1 + alpha
      a1 = -2 * cosw
      a2 = 1 - alpha
      break
    case 'notch':
      b0 = 1
      b1 = -2 * cosw
      b2 = 1
      a0 = 1 + alpha
      a1 = -2 * cosw
      a2 = 1 - alpha
      break
    case 'peak':
      b0 = 1 + alpha * A
      b1 = -2 * cosw
      b2 = 1 - alpha * A
      a0 = 1 + alpha / A
      a1 = -2 * cosw
      a2 = 1 - alpha / A
      break
    case 'lowshelf':
      b0 = A * (A + 1 - (A - 1) * cosw + 2 * sqA * alpha)
      b1 = 2 * A * (A - 1 - (A + 1) * cosw)
      b2 = A * (A + 1 - (A - 1) * cosw - 2 * sqA * alpha)
      a0 = A + 1 + (A - 1) * cosw + 2 * sqA * alpha
      a1 = -2 * (A - 1 + (A + 1) * cosw)
      a2 = A + 1 + (A - 1) * cosw - 2 * sqA * alpha
      break
    case 'highshelf':
      b0 = A * (A + 1 + (A - 1) * cosw + 2 * sqA * alpha)
      b1 = -2 * A * (A - 1 + (A + 1) * cosw)
      b2 = A * (A + 1 + (A - 1) * cosw - 2 * sqA * alpha)
      a0 = A + 1 - (A - 1) * cosw + 2 * sqA * alpha
      a1 = 2 * (A - 1 - (A + 1) * cosw)
      a2 = A + 1 - (A - 1) * cosw - 2 * sqA * alpha
      break
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

// ---------------------------------------------------------------------------
// FIR: windowed-sinc
// ---------------------------------------------------------------------------

function sinc(x: number): number {
  if (Math.abs(x) < 1e-9) return 1
  const px = Math.PI * x
  return Math.sin(px) / px
}

function windowCoef(name: DesignParams['window'], n: number, M: number): number {
  const x = (2 * Math.PI * n) / M
  switch (name) {
    case 'rect':
      return 1
    case 'hann':
      return 0.5 - 0.5 * Math.cos(x)
    case 'hamming':
      return 0.54 - 0.46 * Math.cos(x)
    case 'blackman':
      return 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x)
  }
}

/** Windowed-sinc FIR taps. Cutoffs fc are in cycles/sample (Nyquist = 0.5). */
export function firDesign(
  numTaps: number,
  response: ResponseType,
  fc1: number,
  fc2: number,
  window: DesignParams['window'],
): Float64Array {
  const N = Math.max(3, numTaps | 1) // force odd length for a clean linear phase
  const M = N - 1
  const h = new Float64Array(N)
  const lp = (m: number, fc: number) => 2 * fc * sinc(2 * fc * m)
  for (let n = 0; n < N; n++) {
    const m = n - M / 2
    let v = 0
    switch (response) {
      case 'low':
        v = lp(m, fc1)
        break
      case 'high':
        v = (m === 0 ? 1 : 0) - lp(m, fc1)
        break
      case 'band':
        v = lp(m, fc2) - lp(m, fc1)
        break
      case 'notch':
        v = (m === 0 ? 1 : 0) - (lp(m, fc2) - lp(m, fc1))
        break
    }
    h[n] = v * windowCoef(window, n, M)
  }
  // Normalise the passband gain to ~1 by evaluating |H| at a reference frequency.
  const refW =
    response === 'high' ? Math.PI : response === 'band' ? Math.PI * (fc1 + fc2) : 0
  let re = 0
  let im = 0
  for (let n = 0; n < N; n++) {
    re += h[n] * Math.cos(-refW * n)
    im += h[n] * Math.sin(-refW * n)
  }
  const g = Math.hypot(re, im)
  if (g > 1e-9) for (let n = 0; n < N; n++) h[n] /= g
  return h
}

// ---------------------------------------------------------------------------
// Top-level design
// ---------------------------------------------------------------------------

function designIIRClassic(params: DesignParams): Design {
  const { family, response, order, fs, cutoff, cutoffHi, rippleDb, stopDb } = params
  const N = Math.max(1, Math.min(10, Math.round(order)))
  const nyq = fs / 2
  // Pre-warp: digital edge (normalised to Nyquist) → analog frequency.
  const warp = (fHz: number) => {
    const wn = Math.min(0.999, Math.max(0.001, fHz / nyq))
    return 2 * 2 * Math.tan((Math.PI * wn) / 2) // 2·fs_internal·tan(π·Wn/fs_internal), fs_internal = 2
  }

  let proto: Zpk
  if (family === 'butter') proto = butterAP(N)
  else if (family === 'cheby1') proto = cheby1AP(N, rippleDb)
  else proto = cheby2AP(N, stopDb)

  let zpk: Zpk
  if (response === 'low') {
    zpk = lp2lp(proto, warp(cutoff))
  } else if (response === 'high') {
    zpk = lp2hp(proto, warp(cutoff))
  } else {
    const w1 = warp(Math.min(cutoff, cutoffHi))
    const w2 = warp(Math.max(cutoff, cutoffHi))
    const wo = Math.sqrt(w1 * w2)
    const bw = w2 - w1
    zpk = response === 'band' ? lp2bp(proto, wo, bw) : lp2bs(proto, wo, bw)
  }
  zpk = bilinear(zpk, 2) // fs_internal = 2 matches the pre-warp above

  const sos = zpkToSos(zpk.z, zpk.p, zpk.k)
  const stable = zpk.p.every((p) => cabs(p) < 1 - 1e-9)
  const famLabel =
    family === 'butter' ? 'Butterworth' : family === 'cheby1' ? 'Chebyshev I' : 'Chebyshev II'
  return {
    kind: 'iir',
    zeros: zpk.z,
    poles: zpk.p,
    gain: zpk.k,
    sos,
    taps: null,
    order: zpk.p.length,
    stable,
    fs,
    label: `${famLabel} · ${response}`,
  }
}

function designBiquad(params: DesignParams): Design {
  const bq = rbjBiquad(params.biquadType, params.cutoff, params.fs, params.q, params.gainDb)
  const { zeros, poles } = rootsFromSos([bq])
  return {
    kind: 'iir',
    zeros,
    poles,
    gain: 1,
    sos: [bq],
    taps: null,
    order: 2,
    stable: poles.every((p) => cabs(p) < 1 - 1e-9),
    fs: params.fs,
    label: `Biquad · ${params.biquadType}`,
  }
}

function designFIR(params: DesignParams): Design {
  const nyq = params.fs / 2
  const fc1 = Math.min(0.499, Math.max(0.001, params.cutoff / params.fs))
  const fc2 = Math.min(0.499, Math.max(0.001, params.cutoffHi / params.fs))
  const taps = firDesign(params.taps, params.response, fc1, fc2, params.window)
  // Recover zeros by factoring the tap polynomial (highest degree first).
  const poly = Array.from(taps, (t) => cx(t))
  const zeros = polyRoots(poly)
  void nyq
  return {
    kind: 'fir',
    zeros,
    poles: Array.from({ length: taps.length - 1 }, () => cx(0)), // poles at origin
    gain: 1,
    sos: [],
    taps,
    order: taps.length - 1,
    stable: true,
    fs: params.fs,
    label: `FIR · ${params.response} · ${taps.length} taps`,
  }
}

/** Build a design straight from a set of z-plane roots (manual / dragged mode). */
export function designFromZpk(zeros: Cx[], poles: Cx[], gain: number, fs: number): Design {
  const sos = zpkToSos(zeros, poles, gain)
  return {
    kind: 'iir',
    zeros,
    poles,
    gain,
    sos,
    taps: null,
    order: Math.max(zeros.length, poles.length),
    stable: poles.every((p) => cabs(p) < 1 - 1e-9),
    fs,
    label: 'Manual · z-plane',
  }
}

export function designFilter(params: DesignParams): Design {
  switch (params.family) {
    case 'biquad':
      return designBiquad(params)
    case 'fir':
      return designFIR(params)
    case 'cheby1':
    case 'cheby2':
    case 'butter':
      return designIIRClassic(params)
    case 'manual':
      // manual designs are built via designFromZpk; fall back to a passthrough.
      return designFromZpk([], [], 1, params.fs)
  }
}

// ---------------------------------------------------------------------------
// Frequency response, group delay, impulse / step responses
// ---------------------------------------------------------------------------

export interface FreqResponse {
  w: Float64Array // 0..π
  hz: Float64Array // 0..Nyquist
  mag: Float64Array // linear |H|
  magDb: Float64Array
  phase: Float64Array // unwrapped, radians
  groupDelay: Float64Array // samples
}

/** Evaluate H(e^{jω}) for an IIR (zpk) design and its exact group delay. */
function responseIIR(design: Design, omega: number): { mag: number; phase: number; gd: number } {
  const z = cunit(omega)
  let num = cx(design.gain)
  for (const zi of design.zeros) num = cmul(num, csub(z, zi))
  let den = CONE
  for (const pi of design.poles) den = cmul(den, csub(z, pi))
  const H = cdiv(num, den)
  // Exact group delay: τ = Σ_poles Re[z/(z−p)] − Σ_zeros Re[z/(z−z_i)]
  let gd = 0
  for (const pi of design.poles) gd += cdiv(z, csub(z, pi)).re
  for (const zi of design.zeros) gd -= cdiv(z, csub(z, zi)).re
  return { mag: cabs(H), phase: carg(H), gd }
}

/** Evaluate an FIR design (DTFT of the taps) and its group delay. */
function responseFIR(design: Design, omega: number): { mag: number; phase: number; gd: number } {
  const h = design.taps!
  let re = 0
  let im = 0
  let nre = 0
  let nim = 0
  for (let n = 0; n < h.length; n++) {
    const c = Math.cos(-omega * n)
    const s = Math.sin(-omega * n)
    re += h[n] * c
    im += h[n] * s
    nre += n * h[n] * c
    nim += n * h[n] * s
  }
  // group delay = Re[ Σ n·h·e^{-jωn} / Σ h·e^{-jωn} ]
  const H = cx(re, im)
  const Hn = cx(nre, nim)
  const gd = cdiv(Hn, H).re
  return { mag: cabs(H), phase: carg(H), gd }
}

export function freqResponse(design: Design, points = 512): FreqResponse {
  const w = new Float64Array(points)
  const hz = new Float64Array(points)
  const mag = new Float64Array(points)
  const magDb = new Float64Array(points)
  const phaseRaw = new Float64Array(points)
  const groupDelay = new Float64Array(points)
  const nyq = design.fs / 2
  for (let i = 0; i < points; i++) {
    const omega = (Math.PI * i) / (points - 1)
    const r = design.kind === 'fir' ? responseFIR(design, omega) : responseIIR(design, omega)
    w[i] = omega
    hz[i] = (omega / Math.PI) * nyq
    mag[i] = r.mag
    magDb[i] = 20 * Math.log10(Math.max(r.mag, 1e-9))
    phaseRaw[i] = r.phase
    groupDelay[i] = r.gd
  }
  // Unwrap phase.
  const phase = new Float64Array(points)
  let offset = 0
  phase[0] = phaseRaw[0]
  for (let i = 1; i < points; i++) {
    let d = phaseRaw[i] - phaseRaw[i - 1]
    while (d > Math.PI) {
      offset -= 2 * Math.PI
      d -= 2 * Math.PI
    }
    while (d < -Math.PI) {
      offset += 2 * Math.PI
      d += 2 * Math.PI
    }
    phase[i] = phaseRaw[i] + offset
  }
  return { w, hz, mag, magDb, phase, groupDelay }
}

/** Run a signal through the design (SOS cascade for IIR, convolution for FIR). */
export function applyFilter(design: Design, x: ArrayLike<number>): Float64Array {
  const n = x.length
  const out = new Float64Array(n)
  if (design.kind === 'fir') {
    const h = design.taps!
    for (let i = 0; i < n; i++) {
      let acc = 0
      for (let k = 0; k < h.length; k++) {
        const j = i - k
        if (j >= 0) acc += h[k] * x[j]
      }
      out[i] = acc
    }
    return out
  }
  // IIR: cascade of transposed direct-form-II biquads.
  for (let i = 0; i < n; i++) out[i] = x[i]
  for (const s of design.sos) {
    let z1 = 0
    let z2 = 0
    for (let i = 0; i < n; i++) {
      const xn = out[i]
      const yn = s.b0 * xn + z1
      z1 = s.b1 * xn - s.a1 * yn + z2
      z2 = s.b2 * xn - s.a2 * yn
      out[i] = yn
    }
  }
  return out
}

export function impulseResponse(design: Design, len: number): Float64Array {
  const imp = new Float64Array(len)
  imp[0] = 1
  return applyFilter(design, imp)
}

export function stepResponse(design: Design, len: number): Float64Array {
  const step = new Float64Array(len)
  step.fill(1)
  return applyFilter(design, step)
}
