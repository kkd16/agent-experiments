// Statistical special functions and probability distributions — pure, dependency-free
// numerics, zero React, exactly like `solver.ts` and `optimizer.ts`. This is the
// numerical backbone of v7's statistics layer: the log-gamma (Lanczos), the regularized
// incomplete gamma and beta functions (the cousins behind almost every continuous
// distribution), the error function, and the four workhorse distributions — Normal,
// Student's t, chi-square and Fisher's F — each with a CDF, a PDF and an inverse-CDF.
//
// The incomplete-gamma / incomplete-beta routines are the classic Numerical-Recipes
// formulations (series expansion where it converges fastest, continued fraction
// elsewhere); they're accurate to ~1e-12 across the ranges a spreadsheet meets. The
// inverse CDFs bracket the root and bisect, so they're robust for every df ≥ 1 without
// needing a good initial guess.

const SQRT2 = Math.SQRT2
const SQRT2PI = Math.sqrt(2 * Math.PI)

// ---- log-gamma (Lanczos approximation, g=7, n=9) ----------------------------
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
]

/** ln Γ(x) for x > 0 (and, by reflection, for x < 0 away from the non-positive poles). */
export function lgamma(x: number): number {
  if (x < 0.5) {
    // Reflection: Γ(x)Γ(1-x) = π / sin(πx).
    return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x)
  }
  x -= 1
  let a = LANCZOS[0]
  const t = x + 7.5
  for (let i = 1; i < LANCZOS.length; i++) a += LANCZOS[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

/** Γ(x). Handles negative non-integer arguments via the reflection in `lgamma`. */
export function gamma(x: number): number {
  if (Number.isInteger(x) && x <= 0) return NaN // poles
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x))
  return Math.exp(lgamma(x))
}

/** Regularized lower incomplete gamma P(a, x) = γ(a,x)/Γ(a), a > 0, x ≥ 0. */
export function gammp(a: number, x: number): number {
  if (x < 0 || a <= 0) return NaN
  if (x === 0) return 0
  if (x < a + 1) return gammSeries(a, x) // series converges fastest here
  return 1 - gammContinued(a, x) // else use the complement's continued fraction
}

/** Regularized upper incomplete gamma Q(a, x) = 1 − P(a, x). */
export function gammq(a: number, x: number): number {
  return 1 - gammp(a, x)
}

function gammSeries(a: number, x: number): number {
  const gln = lgamma(a)
  let ap = a
  let sum = 1 / a
  let del = sum
  for (let n = 0; n < 300; n++) {
    ap += 1
    del *= x / ap
    sum += del
    if (Math.abs(del) < Math.abs(sum) * 1e-15) break
  }
  return sum * Math.exp(-x + a * Math.log(x) - gln)
}

function gammContinued(a: number, x: number): number {
  const gln = lgamma(a)
  const TINY = 1e-300
  let b = x + 1 - a
  let c = 1 / TINY
  let d = 1 / b
  let h = d
  for (let i = 1; i <= 300; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < TINY) d = TINY
    c = b + an / c
    if (Math.abs(c) < TINY) c = TINY
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-15) break
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h
}

// ---- regularized incomplete beta I_x(a, b) ----------------------------------
/** I_x(a, b) — the regularized incomplete beta function, 0 ≤ x ≤ 1, a,b > 0. */
export function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const lbeta = lgamma(a + b) - lgamma(a) - lgamma(b)
  const front = Math.exp(lbeta + a * Math.log(x) + b * Math.log(1 - x))
  // Use the continued fraction in whichever tail converges; reflect when needed.
  if (x < (a + 1) / (a + b + 2)) return (front * betacf(a, b, x)) / a
  return 1 - (front * betacf(b, a, 1 - x)) / b
}

function betacf(a: number, b: number, x: number): number {
  const TINY = 1e-300
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < TINY) d = TINY
  d = 1 / d
  let h = d
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < TINY) d = TINY
    c = 1 + aa / c
    if (Math.abs(c) < TINY) c = TINY
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < TINY) d = TINY
    c = 1 + aa / c
    if (Math.abs(c) < TINY) c = TINY
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-15) break
  }
  return h
}

// ---- error function ---------------------------------------------------------
/** erf(x) = sign(x)·P(½, x²). */
export function erf(x: number): number {
  return x < 0 ? -gammp(0.5, x * x) : gammp(0.5, x * x)
}
export function erfc(x: number): number {
  return 1 - erf(x)
}

// ---- Normal -----------------------------------------------------------------
export function normPdf(x: number, mean = 0, sd = 1): number {
  const z = (x - mean) / sd
  return Math.exp(-0.5 * z * z) / (sd * SQRT2PI)
}

export function normCdf(x: number, mean = 0, sd = 1): number {
  return 0.5 * erfc(-(x - mean) / (sd * SQRT2))
}

/** Inverse normal CDF: Acklam's rational approximation refined by one Halley step. */
export function normInv(p: number, mean = 0, sd = 1): number {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  // Coefficients for Peter Acklam's algorithm.
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const plow = 0.02425
  const phigh = 1 - plow
  let z: number
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p))
    z = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  } else if (p <= phigh) {
    const q = p - 0.5
    const r = q * q
    z = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    z = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  // One Halley refinement step against the high-accuracy erf-based CDF.
  const e = normCdf(z) - p
  const u = e * SQRT2PI * Math.exp((z * z) / 2)
  z = z - u / (1 + (z * u) / 2)
  return mean + sd * z
}

// ---- Student's t ------------------------------------------------------------
export function tPdf(x: number, df: number): number {
  const c = Math.exp(lgamma((df + 1) / 2) - lgamma(df / 2)) / Math.sqrt(df * Math.PI)
  return c * Math.pow(1 + (x * x) / df, -(df + 1) / 2)
}

/** Left-tail CDF of Student's t with `df` degrees of freedom. */
export function tCdf(x: number, df: number): number {
  const xt = df / (df + x * x)
  const ib = 0.5 * betai(df / 2, 0.5, xt)
  return x > 0 ? 1 - ib : ib
}

export function tInv(p: number, df: number): number {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  return bisectCdf((x) => tCdf(x, df), p, -1e6, 1e6)
}

// ---- chi-square -------------------------------------------------------------
export function chiPdf(x: number, df: number): number {
  if (x < 0) return 0
  const k = df / 2
  return Math.exp((k - 1) * Math.log(x) - x / 2 - k * Math.log(2) - lgamma(k))
}

export function chiCdf(x: number, df: number): number {
  return x <= 0 ? 0 : gammp(df / 2, x / 2)
}

export function chiInv(p: number, df: number): number {
  if (p <= 0) return 0
  if (p >= 1) return Infinity
  return bisectCdf((x) => chiCdf(x, df), p, 0, 1e7)
}

// ---- Fisher's F -------------------------------------------------------------
export function fPdf(x: number, d1: number, d2: number): number {
  if (x <= 0) return 0
  const lnum = (d1 / 2) * Math.log(d1 / d2) + (d1 / 2 - 1) * Math.log(x)
  const lden = ((d1 + d2) / 2) * Math.log(1 + (d1 * x) / d2) + lgamma(d1 / 2) + lgamma(d2 / 2) - lgamma((d1 + d2) / 2)
  return Math.exp(lnum - lden)
}

export function fCdf(x: number, d1: number, d2: number): number {
  if (x <= 0) return 0
  return betai(d1 / 2, d2 / 2, (d1 * x) / (d1 * x + d2))
}

export function fInv(p: number, d1: number, d2: number): number {
  if (p <= 0) return 0
  if (p >= 1) return Infinity
  return bisectCdf((x) => fCdf(x, d1, d2), p, 0, 1e7)
}

// ---- a robust monotone inverter --------------------------------------------
/** Invert a monotone increasing CDF on [lo, hi] for the value where cdf(x) = p. */
function bisectCdf(cdf: (x: number) => number, p: number, lo: number, hi: number): number {
  let a = lo
  let b = hi
  for (let i = 0; i < 200; i++) {
    const m = (a + b) / 2
    const v = cdf(m)
    if (v < p) a = m
    else b = m
    if (b - a < 1e-12 * (1 + Math.abs(m))) return m
  }
  return (a + b) / 2
}
