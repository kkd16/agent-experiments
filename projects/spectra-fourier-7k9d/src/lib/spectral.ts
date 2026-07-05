// Super-resolution spectral estimation — the "Resolve" mode's engine.
//
// The rest of the lab reads the world through the FFT, and the FFT has a hard wall:
// the Rayleigh resolution limit. Two tones closer than one DFT bin (Δf ≈ fs/N) blur
// into a single lobe and no window or zero-pad separates them. The *parametric* /
// *subspace* school of spectral estimation breaks that wall by modelling the signal
// as a few sinusoids in noise and exploiting the eigenstructure of the sample
// covariance matrix. This module implements that school from scratch:
//
//   - a real-symmetric Jacobi eigensolver, and a complex Hermitian eigensolver built
//     on it via the 2M×2M real embedding (there is no LAPACK here);
//   - the sample covariance with forward–backward averaging;
//   - MUSIC + Pisarenko (noise-subspace nulling), Root-MUSIC (polynomial rooting via
//     the lab's Durand–Kerner), ESPRIT (rotational invariance + a Faddeev–LeVerrier
//     characteristic polynomial), Capon/MVDR, and the Burg maximum-entropy AR spectrum;
//   - the periodogram / Welch FFT baselines, for the same-axes comparison;
//   - AIC / MDL model-order selection from the eigenvalue profile.
//
// Complex arithmetic reuses `cplx`; polynomial rooting reuses `poly`; the FFT reuses
// `fft`. Everything else is here.

import type { Cx } from './cplx'
import { cadd, csub, cmul, cconj, cscale, cabs, carg, cdiv, cx } from './cplx'
import { polyRoots } from './poly'
import { makeComplex } from './complex'
import { transform, nextPow2 } from './fft'

const abs2 = (a: Cx): number => a.re * a.re + a.im * a.im

// ---------------------------------------------------------------------------
// Deterministic PRNG + Gaussian, so scenes are reproducible across renders.
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-12)
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// ---------------------------------------------------------------------------
// Signal model: a sum of sinusoids in additive white noise.
// ---------------------------------------------------------------------------

export interface Tone {
  freq: number // Hz
  amp: number // linear amplitude
}

export interface SignalConfig {
  N: number
  fs: number
  tones: Tone[]
  snrDb: number
  complex: boolean // complex exponentials (analytic) vs real cosines
  seed: number
}

export interface GeneratedSignal {
  data: Cx[] // the samples (imag = 0 for the real model)
  re: Float64Array // real part, for plotting
  im: Float64Array
}

export function generateSignal(cfg: SignalConfig): GeneratedSignal {
  const { N, fs, tones, snrDb, complex, seed } = cfg
  const rng = mulberry32(seed >>> 0)
  const phases = tones.map(() => 2 * Math.PI * rng())
  let sigPow = 0
  for (const t of tones) sigPow += t.amp * t.amp
  if (complex && sigPow === 0) sigPow = 1
  // For the complex model the tone power is amp²; for the real model a cosine of
  // amplitude A has average power A²/2. Match the noise to the requested SNR.
  const refPow = complex ? sigPow : sigPow / 2
  const linSnr = Math.pow(10, snrDb / 10)
  const noiseStd = Math.sqrt(Math.max(refPow, 1e-12) / Math.max(linSnr, 1e-12))
  const perComp = complex ? noiseStd / Math.SQRT2 : noiseStd

  const data: Cx[] = new Array(N)
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  for (let n = 0; n < N; n++) {
    let sr = 0
    let si = 0
    for (let i = 0; i < tones.length; i++) {
      const w = (2 * Math.PI * tones[i].freq) / fs
      const ph = w * n + phases[i]
      if (complex) {
        sr += tones[i].amp * Math.cos(ph)
        si += tones[i].amp * Math.sin(ph)
      } else {
        sr += tones[i].amp * Math.cos(ph)
      }
    }
    sr += perComp * gaussian(rng)
    if (complex) si += perComp * gaussian(rng)
    data[n] = cx(sr, si)
    re[n] = sr
    im[n] = si
  }
  return { data, re, im }
}

// ---------------------------------------------------------------------------
// Real-symmetric cyclic Jacobi eigensolver.
//   a: row-major n×n symmetric (not mutated). Returns eigenvalues and eigenvectors
//   (vectors[k*n + i] = component k of eigenvector i).
// ---------------------------------------------------------------------------

export interface RealEig {
  values: Float64Array
  vectors: Float64Array // column i is eigenvector i
  n: number
}

export function jacobiSym(aIn: Float64Array, n: number): RealEig {
  const a = Float64Array.from(aIn)
  const v = new Float64Array(n * n)
  for (let i = 0; i < n; i++) v[i * n + i] = 1

  const offDiag = (): number => {
    let s = 0
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) s += a[p * n + q] * a[p * n + q]
    return s
  }

  for (let sweep = 0; sweep < 100; sweep++) {
    if (offDiag() < 1e-30) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q]
        if (Math.abs(apq) < 1e-300) continue
        const app = a[p * n + p]
        const aqq = a[q * n + q]
        const phi = 0.5 * Math.atan2(2 * apq, aqq - app)
        const c = Math.cos(phi)
        const s = Math.sin(phi)
        // Apply the rotation to columns p,q, then rows p,q, then accumulate into v.
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p]
          const akq = a[k * n + q]
          a[k * n + p] = c * akp - s * akq
          a[k * n + q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k]
          const aqk = a[q * n + k]
          a[p * n + k] = c * apk - s * aqk
          a[q * n + k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p]
          const vkq = v[k * n + q]
          v[k * n + p] = c * vkp - s * vkq
          v[k * n + q] = s * vkp + c * vkq
        }
      }
    }
  }
  const values = new Float64Array(n)
  for (let i = 0; i < n; i++) values[i] = a[i * n + i]
  return { values, vectors: v, n }
}

// ---------------------------------------------------------------------------
// Complex Hermitian eigensolver via the 2M×2M real embedding.
//   H = A + iB (A symmetric, B skew) ⇒ the real symmetric T = [[A,−B],[B,A]] has
//   every eigenvalue of H twice, with eigenvector [u;v] ⇔ complex u+iv. We solve T,
//   sort, and take one representative per duplicate pair. The result is a full
//   orthonormal complex eigenbasis sorted by eigenvalue descending.
// ---------------------------------------------------------------------------

export interface HermEigPair {
  value: number
  vec: Cx[] // length M, complex eigenvector (unit norm)
}

export function hermitianEig(Hre: Float64Array, Him: Float64Array, M: number): HermEigPair[] {
  const n2 = 2 * M
  const T = new Float64Array(n2 * n2)
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < M; j++) {
      const A = Hre[i * M + j]
      const B = Him[i * M + j]
      T[i * n2 + j] = A
      T[i * n2 + (j + M)] = -B
      T[(i + M) * n2 + j] = B
      T[(i + M) * n2 + (j + M)] = A
    }
  }
  const { values, vectors } = jacobiSym(T, n2)
  const idx = Array.from({ length: n2 }, (_, i) => i).sort((p, q) => values[q] - values[p])

  const pairs: HermEigPair[] = []
  for (let s = 0; s < n2; s += 2) {
    const col = idx[s]
    const q: Cx[] = new Array(M)
    let nrm = 0
    for (let k = 0; k < M; k++) {
      const c = cx(vectors[k * n2 + col], vectors[(k + M) * n2 + col])
      q[k] = c
      nrm += abs2(c)
    }
    nrm = Math.sqrt(nrm) || 1
    for (let k = 0; k < M; k++) q[k] = cscale(q[k], 1 / nrm)
    pairs.push({ value: values[col], vec: q })
  }
  return pairs
}

// ---------------------------------------------------------------------------
// Sample covariance from length-M snapshots, with optional forward–backward
// averaging (R_fb = (R + J R* J)/2, J the exchange matrix).
// ---------------------------------------------------------------------------

export interface Covariance {
  Hre: Float64Array
  Him: Float64Array
  M: number
  L: number // number of snapshots
}

export function sampleCovariance(x: Cx[], M: number, forwardBackward: boolean): Covariance {
  const N = x.length
  const L = N - M + 1
  const Hre = new Float64Array(M * M)
  const Him = new Float64Array(M * M)
  for (let l = 0; l < L; l++) {
    for (let i = 0; i < M; i++) {
      const yi = x[l + i]
      for (let j = 0; j < M; j++) {
        const yj = x[l + j]
        // R[i][j] += y_i · conj(y_j)
        Hre[i * M + j] += yi.re * yj.re + yi.im * yj.im
        Him[i * M + j] += yi.im * yj.re - yi.re * yj.im
      }
    }
  }
  for (let k = 0; k < M * M; k++) {
    Hre[k] /= L
    Him[k] /= L
  }
  if (!forwardBackward) return { Hre, Him, M, L }

  const Fre = new Float64Array(M * M)
  const Fim = new Float64Array(M * M)
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < M; j++) {
      const ii = M - 1 - i
      const jj = M - 1 - j
      // (J R* J)[i][j] = conj(R[ii][jj])
      Fre[i * M + j] = 0.5 * (Hre[i * M + j] + Hre[ii * M + jj])
      Fim[i * M + j] = 0.5 * (Him[i * M + j] - Him[ii * M + jj])
    }
  }
  return { Hre: Fre, Him: Fim, M, L }
}

// ---------------------------------------------------------------------------
// Steering vectors and the noise-subspace inner product.
// ---------------------------------------------------------------------------

/** a(ω)_m = e^{jωm}, m = 0..M-1. */
export function steering(omega: number, M: number): Cx[] {
  const a: Cx[] = new Array(M)
  for (let m = 0; m < M; m++) a[m] = cx(Math.cos(omega * m), Math.sin(omega * m))
  return a
}

/** qᴴ a = Σ conj(q_k) a_k. */
function innerQHa(q: Cx[], a: Cx[], M: number): Cx {
  let re = 0
  let im = 0
  for (let k = 0; k < M; k++) {
    // conj(q)·a
    re += q[k].re * a[k].re + q[k].im * a[k].im
    im += q[k].re * a[k].im - q[k].im * a[k].re
  }
  return cx(re, im)
}

// ---------------------------------------------------------------------------
// MUSIC pseudospectrum and its Pisarenko limit.
// ---------------------------------------------------------------------------

/** MUSIC: 1 / Σ_{i≥p} |q_iᴴ a(ω)|² over an ω grid. */
export function music(eig: HermEigPair[], p: number, M: number, grid: Float64Array): Float64Array {
  const out = new Float64Array(grid.length)
  for (let g = 0; g < grid.length; g++) {
    const a = steering(grid[g], M)
    let denom = 0
    for (let i = p; i < M; i++) denom += abs2(innerQHa(eig[i].vec, a, M))
    out[g] = 1 / (denom + 1e-12)
  }
  return out
}

// ---------------------------------------------------------------------------
// Capon / MVDR minimum-variance spectrum, via the eigen-expansion of R⁻¹ with
// diagonal loading: aᴴ R⁻¹ a = Σ |q_iᴴ a|² / (λ_i + δ).
// ---------------------------------------------------------------------------

export function capon(
  eig: HermEigPair[],
  M: number,
  grid: Float64Array,
  loading: number,
): Float64Array {
  const out = new Float64Array(grid.length)
  for (let g = 0; g < grid.length; g++) {
    const a = steering(grid[g], M)
    let s = 0
    for (let i = 0; i < M; i++) s += abs2(innerQHa(eig[i].vec, a, M)) / (eig[i].value + loading)
    out[g] = 1 / (s + 1e-12)
  }
  return out
}

// ---------------------------------------------------------------------------
// Root-MUSIC: root the noise-subspace polynomial. The p roots inside and nearest
// the unit circle give ω = arg(z). Grid-free.
// ---------------------------------------------------------------------------

export function rootMusic(eig: HermEigPair[], p: number, M: number): { omegas: number[]; roots: Cx[] } {
  // Noise projection Pn = Σ_{i≥p} q q^H.
  const Pre = new Float64Array(M * M)
  const Pim = new Float64Array(M * M)
  for (let i = p; i < M; i++) {
    const q = eig[i].vec
    for (let a = 0; a < M; a++) {
      for (let b = 0; b < M; b++) {
        // q_a · conj(q_b)
        Pre[a * M + b] += q[a].re * q[b].re + q[a].im * q[b].im
        Pim[a * M + b] += q[a].im * q[b].re - q[a].re * q[b].im
      }
    }
  }
  // Diagonal sums c_l = Σ_m Pn[m, m+l], l = -(M-1)..(M-1).
  const coefByL: Cx[] = new Array(2 * M - 1)
  for (let l = -(M - 1); l <= M - 1; l++) {
    let re = 0
    let im = 0
    for (let m = 0; m < M; m++) {
      const mm = m + l
      if (mm < 0 || mm >= M) continue
      re += Pre[m * M + mm]
      im += Pim[m * M + mm]
    }
    coefByL[l + (M - 1)] = cx(re, im)
  }
  // Polynomial P(z) = Σ_l c_l z^{l+M-1}; highest degree (l=M-1) first.
  const poly: Cx[] = []
  for (let l = M - 1; l >= -(M - 1); l--) poly.push(coefByL[l + (M - 1)])
  const roots = polyRoots(poly, 400, 1e-13)
  const inside = roots
    .filter((r) => cabs(r) < 1 - 1e-9)
    .sort((a, b) => cabs(b) - cabs(a))
  const chosen = inside.slice(0, p)
  return { omegas: chosen.map((z) => carg(z)), roots: chosen }
}

// ---------------------------------------------------------------------------
// Small dense complex linear algebra for ESPRIT.
// ---------------------------------------------------------------------------

function cmatMul(A: Cx[], B: Cx[], r: number, k: number, c: number): Cx[] {
  const O: Cx[] = new Array(r * c)
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      let s = cx(0, 0)
      for (let t = 0; t < k; t++) s = cadd(s, cmul(A[i * k + t], B[t * c + j]))
      O[i * c + j] = s
    }
  }
  return O
}

function cmatInv(A: Cx[], n: number): Cx[] {
  const M = A.map((x) => cx(x.re, x.im))
  const I: Cx[] = new Array(n * n)
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) I[i * n + j] = cx(i === j ? 1 : 0, 0)
  for (let col = 0; col < n; col++) {
    let piv = col
    let best = cabs(M[col * n + col])
    for (let r = col + 1; r < n; r++) {
      const v = cabs(M[r * n + col])
      if (v > best) {
        best = v
        piv = r
      }
    }
    if (piv !== col) {
      for (let j = 0; j < n; j++) {
        let t = M[col * n + j]
        M[col * n + j] = M[piv * n + j]
        M[piv * n + j] = t
        t = I[col * n + j]
        I[col * n + j] = I[piv * n + j]
        I[piv * n + j] = t
      }
    }
    const d = M[col * n + col]
    for (let j = 0; j < n; j++) {
      M[col * n + j] = cdiv(M[col * n + j], d)
      I[col * n + j] = cdiv(I[col * n + j], d)
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = M[r * n + col]
      for (let j = 0; j < n; j++) {
        M[r * n + j] = csub(M[r * n + j], cmul(f, M[col * n + j]))
        I[r * n + j] = csub(I[r * n + j], cmul(f, I[col * n + j]))
      }
    }
  }
  return I
}

/** Faddeev–LeVerrier characteristic polynomial of a complex n×n matrix (highest degree first). */
function charPoly(A: Cx[], n: number): Cx[] {
  let Mk: Cx[] = new Array(n * n)
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) Mk[i * n + j] = cx(i === j ? 1 : 0, 0)
  const c: Cx[] = [cx(1, 0)]
  for (let k = 1; k <= n; k++) {
    const AM = cmatMul(A, Mk, n, n, n)
    let tr = cx(0, 0)
    for (let i = 0; i < n; i++) tr = cadd(tr, AM[i * n + i])
    const ck = cscale(tr, -1 / k)
    c.push(ck)
    const next: Cx[] = new Array(n * n)
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        next[i * n + j] = cadd(AM[i * n + j], i === j ? ck : cx(0, 0))
      }
    }
    Mk = next
  }
  return c
}

// ---------------------------------------------------------------------------
// ESPRIT (Total Least Squares). Rotational invariance of the signal subspace.
// ---------------------------------------------------------------------------

export function esprit(eig: HermEigPair[], p: number, M: number): { omegas: number[]; roots: Cx[] } {
  if (p < 1 || p > M - 1) return { omegas: [], roots: [] }
  const rows = M - 1
  const P2 = 2 * p
  // C = [E1 | E2], rows×2p, from the top-p signal eigenvectors (shifted by one row).
  const Cm: Cx[] = new Array(rows * P2)
  for (let r = 0; r < rows; r++) {
    for (let j = 0; j < p; j++) {
      Cm[r * P2 + j] = eig[j].vec[r]
      Cm[r * P2 + p + j] = eig[j].vec[r + 1]
    }
  }
  // G = Cᴴ C (2p×2p Hermitian).
  const Gre = new Float64Array(P2 * P2)
  const Gim = new Float64Array(P2 * P2)
  for (let i = 0; i < P2; i++) {
    for (let j = 0; j < P2; j++) {
      let re = 0
      let im = 0
      for (let r = 0; r < rows; r++) {
        const ci = Cm[r * P2 + i]
        const cj = Cm[r * P2 + j]
        // conj(ci)·cj
        re += ci.re * cj.re + ci.im * cj.im
        im += ci.re * cj.im - ci.im * cj.re
      }
      Gre[i * P2 + j] = re
      Gim[i * P2 + j] = im
    }
  }
  const geig = hermitianEig(Gre, Gim, P2) // sorted descending
  // Smallest-p eigenvectors span the [Ψ; −I] subspace → indices p..2p-1.
  const Wtop: Cx[] = new Array(p * p)
  const Wbot: Cx[] = new Array(p * p)
  for (let cCol = 0; cCol < p; cCol++) {
    const w = geig[p + cCol].vec
    for (let r = 0; r < p; r++) {
      Wtop[r * p + cCol] = w[r]
      Wbot[r * p + cCol] = w[r + p]
    }
  }
  const WbotInv = cmatInv(Wbot, p)
  const Psi0 = cmatMul(Wtop, WbotInv, p, p, p)
  const Psi = Psi0.map((x) => cscale(x, -1)) // Ψ = −Wtop Wbot⁻¹
  const cp = charPoly(Psi, p)
  const roots = polyRoots(cp, 400, 1e-13)
  return { omegas: roots.map((z) => carg(z)), roots }
}

// ---------------------------------------------------------------------------
// Burg maximum-entropy AR spectrum (complex lattice recursion).
// ---------------------------------------------------------------------------

export interface BurgModel {
  a: Cx[] // AR coefficients, a[0] = 1
  sigma2: number
  reflection: number[] // |k_m| per stage, for display
}

export function burg(x: Cx[], order: number): BurgModel {
  const N = x.length
  const f = x.map((c) => cx(c.re, c.im))
  const b = x.map((c) => cx(c.re, c.im))
  let a: Cx[] = [cx(1, 0)]
  let sigma2 = 0
  for (let n = 0; n < N; n++) sigma2 += abs2(x[n])
  sigma2 /= N
  const reflection: number[] = []
  for (let m = 1; m <= order; m++) {
    let num = cx(0, 0)
    let den = 0
    for (let n = m; n < N; n++) {
      num = cadd(num, cmul(f[n], cconj(b[n - 1])))
      den += abs2(f[n]) + abs2(b[n - 1])
    }
    const k = den > 0 ? cscale(num, -2 / den) : cx(0, 0)
    reflection.push(cabs(k))
    // Levinson update of the AR coefficients.
    const anew: Cx[] = a.slice()
    anew.push(cx(0, 0))
    for (let i = 1; i <= m; i++) {
      const ai = a[i] ?? cx(0, 0)
      const ami = a[m - i] ?? cx(0, 0)
      anew[i] = cadd(ai, cmul(k, cconj(ami)))
    }
    a = anew
    // Update forward/backward prediction errors (high-to-low so b[n-1] is pristine).
    for (let n = N - 1; n >= m; n--) {
      const fn = f[n]
      const bn1 = b[n - 1]
      f[n] = cadd(fn, cmul(k, bn1))
      b[n] = cadd(bn1, cmul(cconj(k), fn))
    }
    sigma2 *= 1 - abs2(k)
  }
  return { a, sigma2, reflection }
}

/** AR / maximum-entropy spectrum P(ω) = σ² / |Σ a_i e^{−jωi}|². */
export function arSpectrum(model: BurgModel, grid: Float64Array): Float64Array {
  const { a, sigma2 } = model
  const out = new Float64Array(grid.length)
  for (let g = 0; g < grid.length; g++) {
    const w = grid[g]
    let re = 0
    let im = 0
    for (let i = 0; i < a.length; i++) {
      const c = Math.cos(-w * i)
      const s = Math.sin(-w * i)
      re += a[i].re * c - a[i].im * s
      im += a[i].re * s + a[i].im * c
    }
    out[g] = sigma2 / (re * re + im * im + 1e-18)
  }
  return out
}

// ---------------------------------------------------------------------------
// Periodogram + Welch FFT baselines. Evaluated on the SAME ω grid via a chirp-free
// interpolation of a fine zero-padded FFT, so all curves share one axis.
// ---------------------------------------------------------------------------

function hann(n: number, N: number): number {
  if (N <= 1) return 1
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1))
}

/** Power spectrum of one windowed, zero-padded complex segment, on ω∈(−π,π]. */
function segmentPeriodogram(seg: Cx[], nfft: number): { omega: Float64Array; power: Float64Array } {
  const L = seg.length
  let winEnergy = 0
  const ca = makeComplex(nfft)
  for (let n = 0; n < L; n++) {
    const w = hann(n, L)
    winEnergy += w * w
    ca.re[n] = seg[n].re * w
    ca.im[n] = seg[n].im * w
  }
  const spec = transform(ca, false)
  const omega = new Float64Array(nfft)
  const power = new Float64Array(nfft)
  const half = nfft >> 1
  // fftshift: output index i maps to a strictly increasing ω = −π + 2πi/nfft,
  // reading from source bin (i + N/2) mod N. The monotone axis is what lets
  // resampleToGrid binary-search it.
  for (let i = 0; i < nfft; i++) {
    const src = (i + half) % nfft
    omega[i] = -Math.PI + (2 * Math.PI * i) / nfft
    power[i] = (spec.re[src] * spec.re[src] + spec.im[src] * spec.im[src]) / (winEnergy + 1e-18)
  }
  return { omega, power }
}

/** Sample a natively-uniform (already sorted) FFT spectrum onto an arbitrary grid. */
function resampleToGrid(omega: Float64Array, power: Float64Array, grid: Float64Array): Float64Array {
  const out = new Float64Array(grid.length)
  const n = omega.length
  for (let g = 0; g < grid.length; g++) {
    const w = grid[g]
    // omega is monotonically increasing in (−π, π]; binary search.
    let lo = 0
    let hi = n - 1
    if (w <= omega[0]) {
      out[g] = power[0]
      continue
    }
    if (w >= omega[n - 1]) {
      out[g] = power[n - 1]
      continue
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (omega[mid] <= w) lo = mid
      else hi = mid
    }
    const t = (w - omega[lo]) / (omega[hi] - omega[lo] || 1)
    out[g] = power[lo] * (1 - t) + power[hi] * t
  }
  return out
}

export function periodogram(x: Cx[], grid: Float64Array): Float64Array {
  const nfft = Math.max(1024, nextPow2(x.length * 8))
  const { omega, power } = segmentPeriodogram(x, nfft)
  return resampleToGrid(omega, power, grid)
}

export function welch(x: Cx[], grid: Float64Array, segLen: number, overlap: number): Float64Array {
  const N = x.length
  const L = Math.min(segLen, N)
  const step = Math.max(1, Math.floor(L * (1 - overlap)))
  const nfft = Math.max(1024, nextPow2(L * 8))
  const acc = new Float64Array(grid.length)
  let count = 0
  for (let start = 0; start + L <= N; start += step) {
    const seg = x.slice(start, start + L)
    const { omega, power } = segmentPeriodogram(seg, nfft)
    const on = resampleToGrid(omega, power, grid)
    for (let g = 0; g < grid.length; g++) acc[g] += on[g]
    count++
  }
  if (count === 0) return periodogram(x, grid)
  for (let g = 0; g < grid.length; g++) acc[g] /= count
  return acc
}

// ---------------------------------------------------------------------------
// AIC / MDL model-order selection (Wax–Kailath) from the eigenvalue profile.
// ---------------------------------------------------------------------------

export interface OrderInfo {
  aic: Float64Array
  mdl: Float64Array
  kAIC: number
  kMDL: number
}

export function aicMdl(eigvals: number[], L: number, M: number): OrderInfo {
  const aic = new Float64Array(M)
  const mdl = new Float64Array(M)
  for (let k = 0; k < M; k++) {
    const cnt = M - k
    let sum = 0
    let logsum = 0
    for (let i = k; i < M; i++) {
      const v = Math.max(eigvals[i], 1e-18)
      sum += v
      logsum += Math.log(v)
    }
    const arith = sum / cnt
    const geo = Math.exp(logsum / cnt)
    const ll = cnt * Math.log(geo / arith)
    aic[k] = -2 * L * ll + 2 * k * (2 * M - k)
    mdl[k] = -L * ll + 0.5 * k * (2 * M - k) * Math.log(Math.max(L, 2))
  }
  let ka = 0
  let km = 0
  for (let k = 1; k < M; k++) {
    if (aic[k] < aic[ka]) ka = k
    if (mdl[k] < mdl[km]) km = k
  }
  return { aic, mdl, kAIC: ka, kMDL: km }
}

// ---------------------------------------------------------------------------
// High-level analysis: run everything the UI needs in one pass.
// ---------------------------------------------------------------------------

export type MethodId = 'periodogram' | 'welch' | 'capon' | 'burg' | 'music'

export interface AnalyzeOptions {
  M: number // snapshot / covariance order
  p: number // assumed number of complex exponentials
  autoOrder: boolean // use MDL for p
  forwardBackward: boolean
  burgOrder: number
  gridSize: number
  methods: MethodId[]
}

export interface DiscreteResult {
  freqsHz: number[] // sorted, folded to [0, fs/2] for the real model
  omegas: number[]
  roots: { re: number; im: number }[]
}

export interface Analysis {
  gridHz: Float64Array
  curves: Partial<Record<MethodId, Float64Array>> // linear power, per method
  rootMusic: DiscreteResult
  esprit: DiscreteResult
  eigenvalues: number[]
  order: OrderInfo
  usedP: number
  rayleighHz: number
  binHz: number
  fs: number
  L: number
}

/** Fold ω (rad/sample) to Hz; for the real model map ±ω onto [0, fs/2]. */
function omegaToHz(omega: number, fs: number, fold: boolean): number {
  let f = (omega / (2 * Math.PI)) * fs
  if (fold) f = Math.abs(f)
  return f
}

function dedupeFold(omegas: number[], fs: number, fold: boolean, tolHz: number): number[] {
  const hz = omegas.map((w) => omegaToHz(w, fs, fold)).sort((a, b) => a - b)
  const out: number[] = []
  for (const f of hz) {
    if (out.length === 0 || Math.abs(f - out[out.length - 1]) > tolHz) out.push(f)
  }
  return out
}

export function analyze(sig: GeneratedSignal, cfg: SignalConfig, opts: AnalyzeOptions): Analysis {
  const { fs, N, complex } = cfg
  const M = Math.min(opts.M, N - 1)
  const cov = sampleCovariance(sig.data, M, opts.forwardBackward)
  const eig = hermitianEig(cov.Hre, cov.Him, M)
  const eigvals = eig.map((e) => e.value)
  const order = aicMdl(eigvals, cov.L, M)

  const requestedP = opts.autoOrder ? Math.max(1, order.kMDL) : Math.max(1, opts.p)
  const p = Math.min(requestedP, M - 1)

  // ω grid. Complex model spans (−π, π]; real model is symmetric so [0, π] suffices
  // but we keep the full span for the shared-axis overlay and fold the estimates.
  const G = opts.gridSize
  const grid = new Float64Array(G)
  for (let g = 0; g < G; g++) grid[g] = -Math.PI + (2 * Math.PI * g) / (G - 1)
  const gridHz = new Float64Array(G)
  for (let g = 0; g < G; g++) gridHz[g] = (grid[g] / (2 * Math.PI)) * fs

  const curves: Partial<Record<MethodId, Float64Array>> = {}
  const want = new Set(opts.methods)
  if (want.has('periodogram')) curves.periodogram = periodogram(sig.data, grid)
  if (want.has('welch')) curves.welch = welch(sig.data, grid, Math.max(8, Math.floor(N / 2)), 0.5)
  if (want.has('capon')) curves.capon = capon(eig, M, grid, 1e-3 * (eigvals[0] || 1))
  if (want.has('burg')) curves.burg = arSpectrum(burg(sig.data, Math.min(opts.burgOrder, N - 1)), grid)
  if (want.has('music')) curves.music = music(eig, p, M, grid)

  const rm = rootMusic(eig, p, M)
  const es = esprit(eig, p, M)
  const fold = !complex
  const tolHz = (fs / N) * 0.25

  const rootMusicRes: DiscreteResult = {
    omegas: rm.omegas,
    roots: rm.roots.map((r) => ({ re: r.re, im: r.im })),
    freqsHz: dedupeFold(rm.omegas, fs, fold, tolHz),
  }
  const espritRes: DiscreteResult = {
    omegas: es.omegas,
    roots: es.roots.map((r) => ({ re: r.re, im: r.im })),
    freqsHz: dedupeFold(es.omegas, fs, fold, tolHz),
  }

  return {
    gridHz,
    curves,
    rootMusic: rootMusicRes,
    esprit: espritRes,
    eigenvalues: eigvals,
    order,
    usedP: p,
    rayleighHz: fs / N,
    binHz: fs / N,
    fs,
    L: cov.L,
  }
}
