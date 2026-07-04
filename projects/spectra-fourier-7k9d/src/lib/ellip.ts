// Jacobi elliptic functions and the elliptic (Cauer) analog filter prototype.
//
// The elliptic filter is the *optimal* IIR shape: for a given order it has the
// steepest possible transition band, achieved by letting the response ripple
// equally in BOTH the passband and the stopband (Butterworth ripples in neither,
// Chebyshev in one). Building it needs the machinery of elliptic functions —
// there is no elementary closed form — so this module implements, from scratch
// and with no libraries, the four pieces the design rests on:
//
//   1. K(m)          — the complete elliptic integral of the first kind, via the
//                      arithmetic–geometric mean (AGM).
//   2. sn/cn/dn(u,m) — the Jacobi elliptic functions for a real argument, via the
//                      descending Landen (Gauss) transformation (A&S 16.4).
//   3. ellipdeg(N,k₁)— the elliptic *degree equation*, solved for the modulus k by
//                      the theta/nome series, fixing the selectivity from the order
//                      and the ripple ratio.
//   4. arcsn(w,m)    — the inverse of sn for a *complex* argument, by the
//                      descending-Landen recursion, needed to place the poles.
//
// From these `ellipap(N, Rp, Rs)` returns the normalised low-pass prototype
// (passband edge = 1 rad/s) as zeros / poles / gain, in exactly the form the rest
// of `filterdesign.ts` already consumes (butter/cheby prototypes → lp2lp/hp/bp/bs
// → bilinear → SOS). The construction follows the classic route used by SciPy's
// `ellipap`, re-derived here in plain TypeScript on the scalar `Cx` type.

import type { Cx } from './cplx'
import { cx, cadd, csub, cmul, cscale, cdiv, cabs, csqrt, CONE } from './cplx'

// ---------------------------------------------------------------------------
// Complex helpers used only by the inverse-sn recursion.
// ---------------------------------------------------------------------------

/** Complex natural logarithm (principal branch). */
function clog(z: Cx): Cx {
  return cx(Math.log(cabs(z)), Math.atan2(z.im, z.re))
}

/** Complex arcsine: asin(z) = −i·ln(i·z + √(1 − z²)). */
function casin(z: Cx): Cx {
  const s = csqrt(csub(CONE, cmul(z, z))) // √(1 − z²)
  const iz = cx(-z.im, z.re) // i·z
  const L = clog(cadd(iz, s))
  return cx(L.im, -L.re) // −i·L
}

// ---------------------------------------------------------------------------
// 1. Complete elliptic integral of the first kind, K(m), m = k².
//    K(m) = π / (2·AGM(1, √(1−m))). Converges quadratically.
// ---------------------------------------------------------------------------

export function ellipk(m: number): number {
  if (m >= 1) return Infinity
  if (m <= 0) return Math.PI / 2
  let a = 1
  let b = Math.sqrt(1 - m)
  for (let i = 0; i < 60; i++) {
    if (Math.abs(a - b) <= 1e-16 * a) break
    const an = 0.5 * (a + b)
    const bn = Math.sqrt(a * b)
    a = an
    b = bn
  }
  return Math.PI / (2 * a)
}

// ---------------------------------------------------------------------------
// 2. Jacobi elliptic functions for a real argument, descending Landen (A&S 16.4).
// ---------------------------------------------------------------------------

export interface Jacobi {
  sn: number
  cn: number
  dn: number
}

export function ellipj(u: number, m: number): Jacobi {
  if (m <= 0) return { sn: Math.sin(u), cn: Math.cos(u), dn: 1 }
  if (m >= 1) {
    const t = Math.tanh(u)
    const sech = 1 / Math.cosh(u)
    return { sn: t, cn: sech, dn: sech }
  }
  const a: number[] = [1]
  const c: number[] = [Math.sqrt(m)]
  let b = Math.sqrt(1 - m)
  let n = 0
  while (Math.abs(c[n]) > 1e-16 && n < 30) {
    a.push(0.5 * (a[n] + b))
    c.push(0.5 * (a[n] - b))
    b = Math.sqrt(a[n] * b)
    n++
  }
  let phi = Math.pow(2, n) * a[n] * u
  for (let i = n; i >= 1; i--) {
    phi = 0.5 * (phi + Math.asin((c[i] / a[i]) * Math.sin(phi)))
  }
  const sn = Math.sin(phi)
  const cn = Math.cos(phi)
  const dn = Math.sqrt(1 - m * sn * sn)
  return { sn, cn, dn }
}

// ---------------------------------------------------------------------------
// 3. Elliptic degree equation: given the order N and the discrimination
//    modulus k₁ (as m₁ = k₁²), return the selectivity modulus m = k² such that
//    N·K(k₁)/K′(k₁) = K(k)/K′(k). Solved directly through the nome series
//    k = 4√q·[Σ q^{i(i+1)} / (1 + 2Σ q^{i²})]²  with q = q₁^{1/N}.
// ---------------------------------------------------------------------------

export function ellipdeg(N: number, m1: number): number {
  const K1 = ellipk(m1)
  const K1p = ellipk(1 - m1)
  const q1 = Math.exp(-Math.PI * (K1p / K1))
  const q = Math.pow(q1, 1 / N)
  const MMAX = 7
  let num = 0
  for (let i = 0; i <= MMAX; i++) num += Math.pow(q, i * (i + 1))
  let den = 1
  for (let i = 1; i <= MMAX + 1; i++) den += 2 * Math.pow(q, i * i)
  const r = num / den
  return 16 * q * r * r * r * r
}

// ---------------------------------------------------------------------------
// 4. Inverse Jacobi sn for a complex argument, w = sn(z, m) ⇒ z, by the
//    descending Landen transformation on the (real) modulus ladder.
// ---------------------------------------------------------------------------

export function arcJacSn(w: Cx, m: number): Cx {
  const k = Math.sqrt(m)
  if (k >= 1) return cx(0, 0)
  const ks: number[] = [k]
  for (let iter = 0; iter < 12; iter++) {
    const kn = ks[ks.length - 1]
    if (kn <= 0) break
    const knp = Math.sqrt(1 - kn * kn) // complementary modulus
    const next = (1 - knp) / (1 + knp)
    ks.push(next)
    if (next <= 1e-16) break
  }
  let K = 1
  for (let i = 1; i < ks.length; i++) K *= 1 + ks[i]
  K *= Math.PI / 2

  let wn: Cx = w
  for (let i = 0; i + 1 < ks.length; i++) {
    const kn = ks[i]
    const knext = ks[i + 1]
    const kw = cscale(wn, kn)
    const compl = csqrt(csub(CONE, cmul(kw, kw))) // √(1 − (kₙ·wₙ)²)
    const denom = cscale(cadd(CONE, compl), 1 + knext)
    wn = cdiv(cscale(wn, 2), denom)
  }
  const u = cscale(casin(wn), 2 / Math.PI)
  return cscale(u, K)
}

// ---------------------------------------------------------------------------
// The elliptic (Cauer) analog low-pass prototype (passband edge = 1 rad/s).
// Returns zeros / poles / gain in the same shape as butterAP / cheby*AP.
// ---------------------------------------------------------------------------

export interface EllipZpk {
  z: Cx[]
  p: Cx[]
  k: number
}

export function ellipap(N: number, rp: number, rs: number): EllipZpk {
  const EPS = 1e-10
  if (N === 1) {
    // A first-order elliptic filter degenerates to a single real pole (no ripple
    // room, no finite zero) — identical to a first-order Butterworth/Chebyshev.
    const p = -Math.sqrt(1 / (Math.pow(10, rp / 10) - 1))
    return { z: [], p: [cx(p, 0)], k: -p }
  }

  const epsSq = Math.pow(10, rp / 10) - 1
  const eps = Math.sqrt(epsSq)
  const m1 = epsSq / (Math.pow(10, rs / 10) - 1) // discrimination modulus k₁²
  const Kk1 = ellipk(m1)
  const m = ellipdeg(N, m1) // selectivity modulus k²
  const capk = ellipk(m)
  const sqrtm = Math.sqrt(m)

  // j-index set: N even → 1,3,…,N−1 ; N odd → 0,2,…,N−1.
  const jvals: number[] = []
  for (let j = 1 - (N % 2); j < N; j += 2) jvals.push(j)

  const sArr: number[] = []
  const cArr: number[] = []
  const dArr: number[] = []
  const z: Cx[] = []
  for (const j of jvals) {
    const { sn, cn, dn } = ellipj((j * capk) / N, m)
    sArr.push(sn)
    cArr.push(cn)
    dArr.push(dn)
    if (Math.abs(sn) > EPS) {
      const zi = 1 / (sqrtm * sn) // finite transmission zero on the jω axis
      z.push(cx(0, zi))
      z.push(cx(0, -zi))
    }
  }

  // Pole real-axis offset v₀ from the inverse-sn of j/ε at modulus k₁.
  const r = arcJacSn(cx(0, 1 / eps), m1)
  const v0 = (capk * r.im) / (N * Kk1)
  const { sn: sv, cn: cv, dn: dv } = ellipj(v0, 1 - m)

  const pRaw: Cx[] = []
  for (let i = 0; i < jvals.length; i++) {
    const s = sArr[i]
    const c = cArr[i]
    const d = dArr[i]
    const denom = 1 - (d * sv) * (d * sv)
    const re = -(c * d * sv * cv) / denom
    const im = -(s * dv) / denom
    pRaw.push(cx(re, im))
  }

  const p: Cx[] = []
  if (N % 2) {
    // Odd order: one genuinely real pole (kept once) + conjugates of the rest.
    for (const pp of pRaw) p.push(pp)
    for (const pp of pRaw) {
      if (Math.abs(pp.im) > EPS * Math.hypot(pp.re, pp.im)) p.push(cx(pp.re, -pp.im))
    }
  } else {
    for (const pp of pRaw) {
      p.push(pp)
      p.push(cx(pp.re, -pp.im))
    }
  }

  // Gain so the passband ripple sits at 0 dB (odd) / −Rp/2 baseline (even).
  let np = CONE
  for (const pp of p) np = cmul(np, cx(-pp.re, -pp.im))
  let nz = CONE
  for (const zz of z) nz = cmul(nz, cx(-zz.re, -zz.im))
  let k = z.length ? cdiv(np, nz).re : np.re
  if (N % 2 === 0) k /= Math.sqrt(1 + epsSq)
  return { z, p, k }
}
