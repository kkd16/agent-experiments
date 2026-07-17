// The Discrete Wavelet Transform — a from-scratch orthonormal filter bank.
//
// The CWT (see wavelet.ts) is a *redundant*, continuous picture: one row per
// scale, one column per sample. The DWT is its critically-sampled cousin — an
// orthonormal change of basis that produces exactly as many coefficients as it
// consumes samples, and inverts *exactly*. It is the transform behind JPEG-2000,
// FBI fingerprint compression, and most practical wavelet denoising.
//
// Two things make this file more than a table lookup:
//
//   1. The wavelet filters are **derived, not hard-coded.** Given a number of
//      vanishing moments N, we build the Daubechies maximally-flat half-band
//      polynomial, factor it with the lab's own Durand–Kerner root finder
//      (poly.ts), and spectrally factor it into a minimum-phase (Daubechies) or
//      least-asymmetric (Symlet) scaling filter. No coefficient tables anywhere.
//
//   2. Perfect reconstruction is **structural, not approximate.** The periodic
//      analysis operator W is paraunitary (W·Wᵀ = I), so the synthesis step is
//      literally the adjoint of the analysis step — a scatter that mirrors the
//      analysis gather. Reconstruction error is at the floating-point floor for
//      *any* orthonormal filter, which the self-tests verify to ~1e-12.
//
// References: Daubechies, "Ten Lectures on Wavelets" (1992); Mallat, "A Wavelet
// Tour of Signal Processing" (2009); Donoho & Johnstone, "Ideal spatial
// adaptation by wavelet shrinkage" (Biometrika 1994).

import type { Cx } from './cplx'
import { cx, cabs, cconj, csqrt, cscale, cadd, cmul, cdiv } from './cplx'
import { polyFromRoots, polyRoots, type Poly } from './poly'
import {
  cdf53Forward,
  cdf53Inverse,
  cdf97Forward,
  cdf97Inverse,
  BIOR_ANALYSIS,
} from './lifting'

// ---------------------------------------------------------------------------
// Filter-bank derivation
// ---------------------------------------------------------------------------

export type WaveletFamily = 'db' | 'sym' | 'bior'

/** How a bank computes one transform level. Orthogonal families convolve;
 *  biorthogonal families run the lifting scheme (see lifting.ts). */
export type TransformKind = 'ortho' | 'cdf53' | 'cdf97'

export interface FilterBank {
  name: string
  /** analysis / decomposition low-pass (scaling) filter, Σ = √2 */
  lo: Float64Array
  /** analysis high-pass (wavelet) filter: hi[n] = (−1)ⁿ·lo[L−1−n] */
  hi: Float64Array
  len: number
  /** number of vanishing moments */
  vanishing: number
  family: WaveletFamily
  /** transform implementation; absent/`ortho` = the orthonormal filter bank */
  transform?: TransformKind
}

function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  let r = 1
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1)
  return Math.round(r)
}

/**
 * The Daubechies half-band polynomial P(y) = Σ_{k=0}^{N-1} C(N-1+k, k)·yᵏ, whose
 * roots (mapped z ↔ y) become the non-trivial zeros of the scaling filter. All
 * coefficients are positive, so P has no non-negative real roots — every root is
 * negative-real or a strict complex-conjugate pair, which is what lets us always
 * pick a clean interior/exterior member of each reciprocal z-pair.
 */
function halfbandRoots(N: number): Cx[] {
  // coefficients highest-degree first for polyRoots: degree N-1.
  const coeffs: Poly = []
  for (let d = N - 1; d >= 0; d--) coeffs.push(cx(binom(N - 1 + d, d)))
  return polyRoots(coeffs, 400, 1e-14)
}

/** Solve z + 1/z = 2 − 4y for the root with |z| < 1 (the interior member). */
function interiorZ(y: Cx): Cx {
  // z² − b·z + 1 = 0 with b = 2 − 4y ⇒ z = (b ± √(b²−4)) / 2, roots reciprocal.
  const b = cx(2 - 4 * y.re, -4 * y.im)
  const disc = csqrt(cadd(cmul(b, b), cx(-4)))
  const z1 = cscale(cadd(b, disc), 0.5)
  const z2 = cscale(cadd(b, cscale(disc, -1)), 0.5)
  return cabs(z1) <= cabs(z2) ? z1 : z2
}

interface RootGroup {
  // two synthesis options for this group (interior vs exterior), each a set of
  // z-roots that keeps the resulting filter real.
  interior: Cx[]
  exterior: Cx[]
}

/** Group the N−1 half-band roots into conjugate pairs / real roots, each with an
 *  interior and exterior z-choice, so a selection pattern yields a real filter. */
function groupRoots(yRoots: Cx[]): RootGroup[] {
  const groups: RootGroup[] = []
  const used = new Array(yRoots.length).fill(false)
  const isReal = (c: Cx) => Math.abs(c.im) < 1e-7
  for (let i = 0; i < yRoots.length; i++) {
    if (used[i]) continue
    const y = yRoots[i]
    if (isReal(y)) {
      used[i] = true
      const zin = interiorZ(cx(y.re, 0))
      const zout = cx(zin.re / (zin.re * zin.re + zin.im * zin.im), -zin.im / (zin.re * zin.re + zin.im * zin.im))
      groups.push({ interior: [cx(zin.re, 0)], exterior: [cx(zout.re, 0)] })
    } else {
      // find the conjugate partner
      let j = -1
      let best = Infinity
      for (let k = i + 1; k < yRoots.length; k++) {
        if (used[k]) continue
        const d = cabs(cadd(yRoots[k], cx(-y.re, y.im))) // |y_k − conj(y_i)|
        if (d < best) {
          best = d
          j = k
        }
      }
      used[i] = true
      if (j >= 0) used[j] = true
      const zin = interiorZ(y)
      const zout = cdiv(cx(1, 0), zin)
      groups.push({
        interior: [zin, cconj(zin)],
        exterior: [zout, cconj(zout)],
      })
    }
  }
  return groups
}

/** Build a real scaling filter from a root-selection pattern, normalised Σ = √2. */
function filterFromPattern(N: number, groups: RootGroup[], pattern: number[]): Float64Array {
  const roots: Cx[] = []
  for (let n = 0; n < N; n++) roots.push(cx(-1, 0)) // N zeros at z = −1 (vanishing moments)
  groups.forEach((g, gi) => {
    for (const r of pattern[gi] === 0 ? g.interior : g.exterior) roots.push(r)
  })
  const poly = polyFromRoots(roots) // highest-degree first, complex
  const raw = poly.map((c) => c.re)
  let sum = 0
  for (const v of raw) sum += v
  const scale = Math.SQRT2 / sum // fixes Σ = +√2 (and sign)
  return Float64Array.from(raw, (v) => v * scale)
}

/** Symmetry defect Σ (h[n] − h[L−1−n])² — minimised to pick the Symlet member. */
function symmetryDefect(h: Float64Array): number {
  const L = h.length
  let s = 0
  for (let n = 0; n < L; n++) {
    const d = h[n] - h[L - 1 - n]
    s += d * d
  }
  return s
}

function buildScalingFilter(N: number, family: WaveletFamily): Float64Array {
  if (N === 1) return Float64Array.from([Math.SQRT1_2, Math.SQRT1_2]) // Haar
  const groups = groupRoots(halfbandRoots(N))
  const g = groups.length
  if (family === 'db') {
    // Extremal (minimum) phase: every group interior.
    return filterFromPattern(N, groups, new Array(g).fill(0))
  }
  // Symlet: least-asymmetric — search all 2ᵍ patterns for minimum symmetry defect.
  let best: Float64Array | null = null
  let bestDefect = Infinity
  const total = 1 << g
  for (let p = 0; p < total; p++) {
    const pattern: number[] = []
    for (let b = 0; b < g; b++) pattern.push((p >> b) & 1)
    const h = filterFromPattern(N, groups, pattern)
    const d = symmetryDefect(h)
    if (d < bestDefect) {
      bestDefect = d
      best = h
    }
  }
  return best!
}

function makeBank(name: string, N: number, family: WaveletFamily): FilterBank {
  const lo = buildScalingFilter(N, family)
  const L = lo.length
  const hi = new Float64Array(L)
  for (let n = 0; n < L; n++) hi[n] = (n % 2 === 0 ? 1 : -1) * lo[L - 1 - n]
  return { name, lo, hi, len: L, vanishing: N, family }
}

export interface WaveletSpec {
  id: string
  label: string
  N: number
  family: WaveletFamily
}

export const WAVELETS: WaveletSpec[] = [
  { id: 'haar', label: 'Haar (db1)', N: 1, family: 'db' },
  { id: 'db2', label: 'Daubechies db2', N: 2, family: 'db' },
  { id: 'db3', label: 'Daubechies db3', N: 3, family: 'db' },
  { id: 'db4', label: 'Daubechies db4', N: 4, family: 'db' },
  { id: 'db6', label: 'Daubechies db6', N: 6, family: 'db' },
  { id: 'db8', label: 'Daubechies db8', N: 8, family: 'db' },
  { id: 'db10', label: 'Daubechies db10', N: 10, family: 'db' },
  { id: 'sym4', label: 'Symlet sym4', N: 4, family: 'sym' },
  { id: 'sym6', label: 'Symlet sym6', N: 6, family: 'sym' },
  { id: 'sym8', label: 'Symlet sym8', N: 8, family: 'sym' },
]

/** Biorthogonal (symmetric, linear-phase) wavelets, computed by lifting. */
export const BIOR_WAVELETS: { id: string; label: string; transform: TransformKind; vanishing: number }[] = [
  { id: 'cdf53', label: 'CDF 5/3 (LeGall)', transform: 'cdf53', vanishing: 2 },
  { id: 'cdf97', label: 'CDF 9/7 (JPEG-2000)', transform: 'cdf97', vanishing: 4 },
]

/** All wavelets for a UI picker: orthonormal families plus the biorthogonal pair. */
export const ALL_WAVELETS: { id: string; label: string }[] = [
  ...WAVELETS.map((w) => ({ id: w.id, label: w.label })),
  ...BIOR_WAVELETS.map((w) => ({ id: w.id, label: w.label })),
]

const bankCache = new Map<string, FilterBank>()

function makeBiorBank(id: string): FilterBank {
  const spec = BIOR_WAVELETS.find((w) => w.id === id)!
  const taps = BIOR_ANALYSIS[id]
  return {
    name: id,
    lo: Float64Array.from(taps.lo),
    hi: Float64Array.from(taps.hi),
    len: taps.lo.length,
    vanishing: spec.vanishing,
    family: 'bior',
    transform: spec.transform,
  }
}

export function getBank(id: string): FilterBank {
  const hit = bankCache.get(id)
  if (hit) return hit
  const bank = BIOR_WAVELETS.some((w) => w.id === id)
    ? makeBiorBank(id)
    : (() => {
        const spec = WAVELETS.find((w) => w.id === id) ?? WAVELETS[0]
        return makeBank(spec.id, spec.N, spec.family)
      })()
  bankCache.set(id, bank)
  return bank
}

// ---------------------------------------------------------------------------
// The transform: periodic (paraunitary) analysis + adjoint synthesis
// ---------------------------------------------------------------------------

export interface OneLevel {
  cA: Float64Array
  cD: Float64Array
}

/** One analysis level: circular convolve + downsample by 2 (the gather), or the
 *  lifting scheme for biorthogonal banks. */
export function dwtStep(x: Float64Array, bank: FilterBank): OneLevel {
  if (bank.transform === 'cdf53') return cdf53Forward(x)
  if (bank.transform === 'cdf97') return cdf97Forward(x)
  const N = x.length
  const half = N >> 1
  const cA = new Float64Array(half)
  const cD = new Float64Array(half)
  const { lo, hi, len: L } = bank
  for (let i = 0; i < half; i++) {
    let a = 0
    let d = 0
    const base = 2 * i
    for (let k = 0; k < L; k++) {
      const v = x[(base + k) % N]
      a += lo[k] * v
      d += hi[k] * v
    }
    cA[i] = a
    cD[i] = d
  }
  return { cA, cD }
}

/** One synthesis level: the exact adjoint of dwtStep (the scatter), or the
 *  inverse lifting scheme for biorthogonal banks. */
export function idwtStep(cA: Float64Array, cD: Float64Array, bank: FilterBank): Float64Array {
  if (bank.transform === 'cdf53') return cdf53Inverse(cA, cD)
  if (bank.transform === 'cdf97') return cdf97Inverse(cA, cD)
  const half = cA.length
  const N = half * 2
  const x = new Float64Array(N)
  const { lo, hi, len: L } = bank
  for (let i = 0; i < half; i++) {
    const a = cA[i]
    const d = cD[i]
    const base = 2 * i
    for (let k = 0; k < L; k++) {
      const idx = (base + k) % N
      x[idx] += lo[k] * a + hi[k] * d
    }
  }
  return x
}

export interface Decomposition {
  approx: Float64Array // coarsest approximation a_J
  details: Float64Array[] // details[0] = d1 (finest) … details[J-1] = d_J (coarsest)
  levels: number
  bank: FilterBank
  n: number
}

/** Largest level for which every subband length stays even and ≥ filter length. */
export function maxLevel(n: number, bank: FilterBank): number {
  let len = n
  let lv = 0
  while (len % 2 === 0 && len / 2 >= bank.len) {
    len >>= 1
    lv++
  }
  return Math.max(1, lv)
}

/** Multi-level analysis (Mallat's pyramid algorithm). */
export function wavedec(x: Float64Array, bank: FilterBank, levels: number): Decomposition {
  const details: Float64Array[] = []
  let cur = x
  for (let l = 0; l < levels; l++) {
    const { cA, cD } = dwtStep(cur, bank)
    details.push(cD)
    cur = cA
  }
  return { approx: cur, details, levels, bank, n: x.length }
}

/** Multi-level synthesis — exact inverse of wavedec. */
export function waverec(dec: Decomposition): Float64Array {
  let cur = dec.approx
  for (let l = dec.levels - 1; l >= 0; l--) {
    cur = idwtStep(cur, dec.details[l], dec.bank)
  }
  return cur
}

// ---------------------------------------------------------------------------
// Multiresolution analysis: split a signal into full-length additive bands
// ---------------------------------------------------------------------------

export interface Mra {
  approx: Float64Array // A_J, full length
  details: Float64Array[] // D_1 … D_J, full length; Σ + approx = signal
  dec: Decomposition
}

function zeros(n: number): Float64Array {
  return new Float64Array(n)
}

/**
 * Reconstruct each subband on its own — the approximation A_J and every detail
 * band D_j projected back to full length. Because the transform is linear and
 * orthonormal, A_J + Σ_j D_j reproduces the signal exactly.
 */
export function mra(x: Float64Array, bank: FilterBank, levels: number): Mra {
  const dec = wavedec(x, bank, levels)
  const approxBand = waverec({
    approx: dec.approx,
    details: dec.details.map((d) => zeros(d.length)),
    levels,
    bank,
    n: x.length,
  })
  const details: Float64Array[] = []
  for (let j = 0; j < levels; j++) {
    const only = dec.details.map((d, idx) => (idx === j ? d : zeros(d.length)))
    details.push(
      waverec({ approx: zeros(dec.approx.length), details: only, levels, bank, n: x.length }),
    )
  }
  return { approx: approxBand, details, dec }
}

// ---------------------------------------------------------------------------
// Wavelet denoising (Donoho–Johnstone shrinkage)
// ---------------------------------------------------------------------------

export type ThresholdMode = 'soft' | 'hard'
export type ShrinkRule = 'universal' | 'sure' | 'bayes'

function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = values.slice().sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m])
}

/** Robust noise σ from the finest detail band via the median absolute deviation. */
export function estimateSigma(d1: Float64Array): number {
  const abs: number[] = []
  for (let i = 0; i < d1.length; i++) abs.push(Math.abs(d1[i]))
  return median(abs) / 0.6745
}

function shrink(x: number, t: number, mode: ThresholdMode): number {
  if (mode === 'hard') return Math.abs(x) > t ? x : 0
  const a = Math.abs(x) - t
  return a > 0 ? Math.sign(x) * a : 0
}

/** Stein's Unbiased Risk Estimate for soft-thresholding a subband at level t. */
function sureThreshold(coef: Float64Array, sigma: number): number {
  const n = coef.length
  if (sigma <= 0) return 0
  const x = Array.from(coef, (c) => Math.abs(c) / sigma).sort((a, b) => a - b)
  // Candidate thresholds are the sorted magnitudes; evaluate SURE at each.
  let bestT = x[0]
  let bestRisk = Infinity
  // prefix sums of squares for the Σ min(x², t²) term
  let cumSq = 0
  for (let i = 0; i < n; i++) {
    const t = x[i]
    // #{|x| ≤ t} = i+1 (x sorted, t = x[i]); Σ min(x_j², t²):
    // for j ≤ i, x_j² ; for j > i, t². cumSq accumulates x_j² up to i.
    cumSq += x[i] * x[i]
    const sumMin = cumSq + (n - 1 - i) * t * t
    const risk = n - 2 * (i + 1) + sumMin
    if (risk < bestRisk) {
      bestRisk = risk
      bestT = t
    }
  }
  return bestT * sigma
}

/** BayesShrink data-driven threshold for a subband (soft). */
function bayesThreshold(coef: Float64Array, sigma: number): number {
  let sumSq = 0
  for (let i = 0; i < coef.length; i++) sumSq += coef[i] * coef[i]
  const sigmaY2 = sumSq / coef.length
  const sigmaX2 = Math.max(sigmaY2 - sigma * sigma, 1e-12)
  const sigmaX = Math.sqrt(sigmaX2)
  return (sigma * sigma) / sigmaX
}

export interface DenoiseResult {
  clean: Float64Array
  sigma: number
  perLevelThreshold: number[]
  kept: number // fraction of detail coefficients retained (non-zero)
  totalDetail: number
}

/** Wavelet-shrinkage denoise: analyse, threshold detail bands, synthesise. */
export function denoise(
  x: Float64Array,
  bank: FilterBank,
  levels: number,
  rule: ShrinkRule,
  mode: ThresholdMode,
): DenoiseResult {
  const dec = wavedec(x, bank, levels)
  const sigma = estimateSigma(dec.details[0])
  const n = x.length
  const universal = sigma * Math.sqrt(2 * Math.log(n))
  const perLevelThreshold: number[] = []
  let kept = 0
  let totalDetail = 0
  const newDetails = dec.details.map((band) => {
    let t: number
    if (rule === 'universal') t = universal
    else if (rule === 'sure') t = sureThreshold(band, sigma)
    else t = bayesThreshold(band, sigma)
    perLevelThreshold.push(t)
    const out = new Float64Array(band.length)
    for (let i = 0; i < band.length; i++) {
      const v = shrink(band[i], t, mode)
      out[i] = v
      totalDetail++
      if (v !== 0) kept++
    }
    return out
  })
  const clean = waverec({ approx: dec.approx, details: newDetails, levels, bank, n })
  return { clean, sigma, perLevelThreshold, kept: kept / Math.max(1, totalDetail), totalDetail }
}

// ---------------------------------------------------------------------------
// Small helpers used by the UI / self-tests
// ---------------------------------------------------------------------------

/** Signal-to-noise ratio in dB of `est` against the clean reference `ref`. */
export function snrDb(ref: ArrayLike<number>, est: ArrayLike<number>): number {
  let sig = 0
  let err = 0
  for (let i = 0; i < ref.length; i++) {
    sig += ref[i] * ref[i]
    const e = ref[i] - est[i]
    err += e * e
  }
  return 10 * Math.log10(sig / Math.max(err, 1e-30))
}

/** Magnitude response |H(e^{iω})| of a real filter over ω ∈ [0, π], M+1 points. */
export function magnitudeResponse(h: Float64Array, M: number): Float64Array {
  const out = new Float64Array(M + 1)
  for (let m = 0; m <= M; m++) {
    const w = (Math.PI * m) / M
    let re = 0
    let im = 0
    for (let n = 0; n < h.length; n++) {
      re += h[n] * Math.cos(w * n)
      im -= h[n] * Math.sin(w * n)
    }
    out[m] = Math.hypot(re, im)
  }
  return out
}

/** Double-shift autocorrelation defect: max|Σ h[n]h[n+2k] − δ_k| — 0 iff orthonormal. */
export function orthonormalityDefect(h: Float64Array): number {
  const L = h.length
  let worst = 0
  for (let k = 0; k * 2 < L; k++) {
    let s = 0
    for (let n = 0; n + 2 * k < L; n++) s += h[n] * h[n + 2 * k]
    const target = k === 0 ? 1 : 0
    worst = Math.max(worst, Math.abs(s - target))
  }
  return worst
}
