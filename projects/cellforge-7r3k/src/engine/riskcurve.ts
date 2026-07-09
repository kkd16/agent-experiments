// Fixed-income risk analytics & a from-scratch yield-curve engine — a pure, React-free
// core that sits directly on top of `securities.ts` / `daycount.ts`. Two families:
//
//   • Bond risk — CONVEXITY (the second-order price/yield sensitivity), DV01 (the dollar
//     value of a one-basis-point yield move) and their *effective* (bump-and-reprice)
//     twins EFFDURATION / EFFCONVEXITY, all differentiating one shared, audited cash-flow
//     model that reproduces `securities.price` to the penny for any multi-period bond.
//   • The yield curve — a classic par-instrument BOOTSTRAP that turns a set of par (coupon
//     = yield) rates at a grid of tenors into discount factors and zero (spot) rates,
//     plus log-linear discount-factor interpolation, forward rates, and a curve query.
//
// Everything takes plain numbers (dates are Excel serials) and returns a number, or `null`
// on a domain error (the caller turns that into a `#NUM!`). The maths is pinned two ways:
// the analytic risk measures agree with a central finite difference of the price function,
// and every bootstrapped curve reprices its own par instruments back to par by construction.

import type { Basis } from './daycount'
import { couponNum, coupDays, coupDaysNC, coupDaysBS } from './daycount'

/** A risk/curve result: a real number, or `null` for a domain error (→ `#NUM!`). */
export type Risk = number | null

const pow = Math.pow
const isFreq = (f: number): boolean => f === 1 || f === 2 || f === 4
const isBasis = (b: number): boolean => b >= 0 && b <= 4 && Number.isInteger(b)

// ---------------------------------------------------------------------------
// The shared cash-flow model
// ---------------------------------------------------------------------------

/** One remaining cash flow: `tau` is its time to settlement measured in *coupon
 *  periods* (a fractional first period `DSC/E`, then whole periods), `cf` the amount
 *  per 100 face. */
export interface Cashflow {
  tau: number
  cf: number
}

/** The remaining cash flows of a coupon bond, in the exact convention `securities.price`
 *  uses: `tau_k = (k−1) + DSC/E` for `k = 1..N`, each paying the periodic coupon, with the
 *  redemption added to the final flow. Also returns the accrued interest and the period
 *  length `E`. Discounting these compound-style, `Σ cf·(1+y/f)^(−tau)`, returns the *dirty*
 *  price; subtracting accrued gives the clean price, which matches `securities.price` for
 *  every multi-period bond (the single-period money-market case is intentionally kept in
 *  `securities.price` only — see `dirtyPrice`). */
export function bondCashflows(
  settle: number,
  maturity: number,
  rate: number,
  redemption: number,
  frequency: number,
  basis: number,
): { flows: Cashflow[]; accrued: number; E: number } | null {
  if (settle >= maturity || rate < 0 || redemption <= 0 || !isFreq(frequency) || !isBasis(basis)) return null
  const b = basis as Basis
  const N = couponNum(settle, maturity, frequency)
  const E = coupDays(settle, maturity, frequency, b)
  const DSC = coupDaysNC(settle, maturity, frequency, b)
  const A = coupDaysBS(settle, maturity, frequency, b)
  if (E === 0) return null
  const coupon = (100 * rate) / frequency
  const T = DSC / E
  const flows: Cashflow[] = []
  for (let k = 1; k <= N; k++) {
    const tau = k - 1 + T
    const cf = coupon + (k === N ? redemption : 0)
    flows.push({ tau, cf })
  }
  return { flows, accrued: coupon * (A / E), E }
}

/** Dirty price per 100 face of the shared compound cash-flow model at yield `y`
 *  (nominal, compounded `frequency` times a year). */
function dirtyFromFlows(flows: Cashflow[], y: number, frequency: number): number {
  const base = 1 + y / frequency
  let p = 0
  for (const f of flows) p += f.cf * pow(base, -f.tau)
  return p
}

/**
 * Dirty price per 100 face of a coupon bond under the compound model. For a
 * multi-period bond this equals `securities.price(...) + accrued`; it is the single
 * function every risk measure below differentiates, so duration, convexity and their
 * effective twins are guaranteed mutually consistent.
 */
export function dirtyPrice(
  settle: number,
  maturity: number,
  rate: number,
  yld: number,
  redemption: number,
  frequency: number,
  basis: number,
): Risk {
  if (yld < 0) return null
  const cf = bondCashflows(settle, maturity, rate, redemption, frequency, basis)
  if (!cf) return null
  return dirtyFromFlows(cf.flows, yld, frequency)
}

// ---------------------------------------------------------------------------
// Analytic risk measures
// ---------------------------------------------------------------------------

/**
 * Macaulay duration (years), redemption-aware. The present-value-weighted average
 * time to each cash flow. With `redemption = 100` this reproduces
 * `securities.duration` exactly; the parameter lets a non-par redemption flow in.
 */
export function macaulay(
  settle: number,
  maturity: number,
  rate: number,
  yld: number,
  redemption: number,
  frequency: number,
  basis: number,
): Risk {
  if (yld < 0) return null
  const cf = bondCashflows(settle, maturity, rate, redemption, frequency, basis)
  if (!cf) return null
  const base = 1 + yld / frequency
  let sumPV = 0
  let sumTPV = 0
  for (const f of cf.flows) {
    const pv = f.cf * pow(base, -f.tau)
    sumPV += pv
    sumTPV += f.tau * pv
  }
  if (sumPV === 0) return null
  return sumTPV / sumPV / frequency
}

/** Modified duration (years): Macaulay ÷ (1 + yld/frequency). */
export function modDuration(
  settle: number,
  maturity: number,
  rate: number,
  yld: number,
  redemption: number,
  frequency: number,
  basis: number,
): Risk {
  const mac = macaulay(settle, maturity, rate, yld, redemption, frequency, basis)
  if (mac === null) return null
  return mac / (1 + yld / frequency)
}

/**
 * Convexity (years²): the curvature of the price/yield relationship,
 * `C = P''(y) / P(y)`, evaluated on the shared model. Closed form
 * `C = Σ cf·tau·(tau+1)·(1+y/f)^(−(tau+2)) / (f²·P_dirty)`.
 */
export function convexity(
  settle: number,
  maturity: number,
  rate: number,
  yld: number,
  redemption: number,
  frequency: number,
  basis: number,
): Risk {
  if (yld < 0) return null
  const cf = bondCashflows(settle, maturity, rate, redemption, frequency, basis)
  if (!cf) return null
  const base = 1 + yld / frequency
  let sumPV = 0
  let sumC = 0
  for (const f of cf.flows) {
    sumPV += f.cf * pow(base, -f.tau)
    sumC += f.cf * f.tau * (f.tau + 1) * pow(base, -(f.tau + 2))
  }
  if (sumPV === 0) return null
  return sumC / (frequency * frequency) / sumPV
}

/**
 * DV01 (a.k.a. PV01 / dollar duration): the price change per 100 face for a one-basis-point
 * fall in yield, `≈ ModDuration · DirtyPrice · 0.0001`. Reported positive (a yield fall lifts
 * the price). A robust cross-check is the symmetric bump `(P(y−1bp) − P(y+1bp))/2`.
 */
export function dv01(
  settle: number,
  maturity: number,
  rate: number,
  yld: number,
  redemption: number,
  frequency: number,
  basis: number,
): Risk {
  const md = modDuration(settle, maturity, rate, yld, redemption, frequency, basis)
  const p = dirtyPrice(settle, maturity, rate, yld, redemption, frequency, basis)
  if (md === null || p === null) return null
  return md * p * 1e-4
}

/**
 * Effective duration by a symmetric bump-and-reprice of the yield,
 * `(P(y−Δ) − P(y+Δ)) / (2·Δ·P)`. Model-free (it never touches the analytic derivative),
 * so it validates `modDuration`. `bump` is in yield units (default 1bp).
 */
export function effDuration(
  settle: number,
  maturity: number,
  rate: number,
  yld: number,
  redemption: number,
  frequency: number,
  basis: number,
  bump = 1e-4,
): Risk {
  if (bump <= 0 || yld - bump < 0) return null
  const cf = bondCashflows(settle, maturity, rate, redemption, frequency, basis)
  if (!cf) return null
  const p0 = dirtyFromFlows(cf.flows, yld, frequency)
  const pUp = dirtyFromFlows(cf.flows, yld + bump, frequency)
  const pDn = dirtyFromFlows(cf.flows, yld - bump, frequency)
  if (p0 === 0) return null
  return (pDn - pUp) / (2 * bump * p0)
}

/**
 * Effective convexity by a symmetric bump-and-reprice,
 * `(P(y+Δ) + P(y−Δ) − 2·P) / (P·Δ²)`. Validates the analytic `convexity`.
 */
export function effConvexity(
  settle: number,
  maturity: number,
  rate: number,
  yld: number,
  redemption: number,
  frequency: number,
  basis: number,
  bump = 1e-4,
): Risk {
  if (bump <= 0 || yld - bump < 0) return null
  const cf = bondCashflows(settle, maturity, rate, redemption, frequency, basis)
  if (!cf) return null
  const p0 = dirtyFromFlows(cf.flows, yld, frequency)
  const pUp = dirtyFromFlows(cf.flows, yld + bump, frequency)
  const pDn = dirtyFromFlows(cf.flows, yld - bump, frequency)
  if (p0 === 0) return null
  return (pUp + pDn - 2 * p0) / (p0 * bump * bump)
}

// ---------------------------------------------------------------------------
// The yield-curve engine — par-instrument bootstrap
// ---------------------------------------------------------------------------

/** A bootstrapped curve: aligned arrays of tenors (years), zero (spot) rates
 *  (annually compounded, as fractions) and discount factors. */
export interface Curve {
  tenors: number[]
  zeros: number[]
  dfs: number[]
}

/**
 * Bootstrap a discount curve from par (coupon = yield) rates on a grid of tenors.
 *
 * Instrument `i` is a par bond maturing at `tenors[i]` that pays an annual coupon
 * `parRates[i]` at every tenor node up to and including its maturity and redeems 1 at
 * maturity — priced at par (1). Solving the par condition
 * `1 = c·Σ_{j≤i} DF_j + DF_i` outward gives
 * `DF_i = (1 − c·Σ_{j<i} DF_j) / (1 + c)`, so repricing any instrument off the curve
 * returns par by construction. Zero rates are annually compounded: `DF_i = (1+z_i)^(−t_i)`.
 *
 * Tenors must be strictly increasing and positive; the two arrays must be equal length.
 */
export function bootstrap(tenors: number[], parRates: number[]): Curve | null {
  const n = tenors.length
  if (n === 0 || parRates.length !== n) return null
  for (let i = 0; i < n; i++) {
    if (!(tenors[i] > 0) || !Number.isFinite(parRates[i]) || parRates[i] <= -1) return null
    if (i > 0 && !(tenors[i] > tenors[i - 1])) return null
  }
  const dfs: number[] = []
  const zeros: number[] = []
  let sum = 0 // Σ DF_j over already-solved nodes
  for (let i = 0; i < n; i++) {
    const c = parRates[i]
    const df = (1 - c * sum) / (1 + c)
    if (!(df > 0) || df > 1.0000001) return null // an arbitrage-free curve has 0 < DF ≤ 1
    dfs.push(df)
    zeros.push(pow(df, -1 / tenors[i]) - 1)
    sum += df
  }
  return { tenors, zeros, dfs }
}

/** Log-linear discount-factor interpolation (i.e. linear in `t·z_cont`), the market
 *  standard. Anchored at `DF(0)=1`; beyond the last node the final segment's slope in
 *  `ln DF` is continued (a flat instantaneous forward). */
export function discountAt(curve: Curve, t: number): number {
  if (t <= 0) return 1
  const { tenors, dfs } = curve
  const n = tenors.length
  const ln = (x: number) => Math.log(x)
  // Knots include the origin (t=0, lnDF=0).
  let t0 = 0
  let l0 = 0
  for (let i = 0; i < n; i++) {
    const t1 = tenors[i]
    const l1 = ln(dfs[i])
    if (t <= t1) {
      const w = (t - t0) / (t1 - t0)
      return Math.exp(l0 + w * (l1 - l0))
    }
    t0 = t1
    l0 = l1
  }
  // Extrapolate past the last node along the last segment's slope.
  if (n === 1) return Math.exp((ln(dfs[0]) / tenors[0]) * t)
  const slope = (ln(dfs[n - 1]) - ln(dfs[n - 2])) / (tenors[n - 1] - tenors[n - 2])
  return Math.exp(ln(dfs[n - 1]) + slope * (t - tenors[n - 1]))
}

/** The annually-compounded zero (spot) rate at maturity `t`, from the interpolated
 *  discount factor: `z = DF(t)^(−1/t) − 1`. */
export function spotAt(curve: Curve, t: number): number | null {
  if (!(t > 0)) return null
  const df = discountAt(curve, t)
  if (!(df > 0)) return null
  return pow(df, -1 / t) - 1
}

/** The annually-compounded forward rate for the period `[t1, t2]` implied by the curve:
 *  `f = (DF(t1)/DF(t2))^(1/(t2−t1)) − 1`. */
export function forwardRate(curve: Curve, t1: number, t2: number): number | null {
  if (!(t2 > t1) || t1 < 0) return null
  const d1 = discountAt(curve, t1)
  const d2 = discountAt(curve, t2)
  if (!(d1 > 0) || !(d2 > 0)) return null
  return pow(d1 / d2, 1 / (t2 - t1)) - 1
}

/** Build a curve directly from zero (spot) rates (annually compounded) — the inverse of
 *  reading `.zeros` off a bootstrap. `DF_i = (1 + z_i)^(−t_i)`. Tenors must be strictly
 *  increasing and positive. Used by the curve-based risk measures, which shock the zeros. */
export function curveFromZeros(tenors: number[], zeros: number[]): Curve | null {
  const n = tenors.length
  if (n === 0 || zeros.length !== n) return null
  const dfs: number[] = []
  for (let i = 0; i < n; i++) {
    if (!(tenors[i] > 0) || !(zeros[i] > -1)) return null
    if (i > 0 && !(tenors[i] > tenors[i - 1])) return null
    dfs.push(pow(1 + zeros[i], -tenors[i]))
  }
  return { tenors, zeros: [...zeros], dfs }
}

// ---------------------------------------------------------------------------
// Curve-based bond pricing & key-rate (partial) durations
// ---------------------------------------------------------------------------

/**
 * Price a coupon bond by discounting each of its cash flows on a curve (rather than at a
 * single flat yield): `dirty = Σ cf_k · DF(tau_k / f)`, with the clean price the dirty
 * price minus accrued. A par bond built from the curve's own par rates prices back to 100.
 */
export function priceOnCurve(
  settle: number,
  maturity: number,
  rate: number,
  redemption: number,
  frequency: number,
  basis: number,
  curve: Curve,
): { dirty: number; clean: number } | null {
  const cf = bondCashflows(settle, maturity, rate, redemption, frequency, basis)
  if (!cf) return null
  let dirty = 0
  for (const f of cf.flows) dirty += f.cf * discountAt(curve, f.tau / frequency)
  return { dirty, clean: dirty - cf.accrued }
}

/**
 * Effective duration measured against a *curve* — a parallel shock of every zero rate by
 * ±`bump`, repriced: `(P(z−Δ) − P(z+Δ)) / (2·Δ·P)`. Because the key-rate shocks below
 * partition a parallel shift, their sum reproduces this number (to O(Δ²)).
 */
export function curveEffDuration(
  settle: number,
  maturity: number,
  rate: number,
  redemption: number,
  frequency: number,
  basis: number,
  tenors: number[],
  zeros: number[],
  bump = 1e-4,
): Risk {
  if (bump <= 0) return null
  const up = curveFromZeros(tenors, zeros.map((z) => z + bump))
  const dn = curveFromZeros(tenors, zeros.map((z) => z - bump))
  const base = curveFromZeros(tenors, zeros)
  if (!up || !dn || !base) return null
  const pu = priceOnCurve(settle, maturity, rate, redemption, frequency, basis, up)
  const pd = priceOnCurve(settle, maturity, rate, redemption, frequency, basis, dn)
  const p0 = priceOnCurve(settle, maturity, rate, redemption, frequency, basis, base)
  if (!pu || !pd || !p0 || p0.dirty === 0) return null
  return (pd.dirty - pu.dirty) / (2 * bump * p0.dirty)
}

/**
 * Clean price per 100 face of a bond discounted on a curve with a constant continuously-
 * compounded **spread** `s` added to every point: `dirty = Σ cf_k · DF(t_k)·e^(−s·t_k)`, clean
 * = dirty − accrued. At `s = 0` this is `priceOnCurve`; it is strictly decreasing in `s`.
 */
export function priceWithSpread(
  settle: number,
  maturity: number,
  rate: number,
  redemption: number,
  frequency: number,
  basis: number,
  curve: Curve,
  spread: number,
): number | null {
  const cf = bondCashflows(settle, maturity, rate, redemption, frequency, basis)
  if (!cf) return null
  let dirty = 0
  for (const f of cf.flows) {
    const t = f.tau / frequency
    dirty += f.cf * discountAt(curve, t) * Math.exp(-spread * t)
  }
  return dirty - cf.accrued
}

/**
 * The **Z-spread** (zero-volatility spread): the single constant spread over the whole curve
 * that makes the bond's curve-discounted price equal a given market clean price. Because the
 * price is strictly monotone in the spread, it is found by a bracketed bisection. A bond
 * trading exactly at its curve price has a zero Z-spread, and `priceWithSpread(…, zSpread) `
 * round-trips back to the market price.
 */
export function zSpread(
  settle: number,
  maturity: number,
  rate: number,
  redemption: number,
  frequency: number,
  basis: number,
  curve: Curve,
  marketClean: number,
): Risk {
  const cf = bondCashflows(settle, maturity, rate, redemption, frequency, basis)
  if (!cf) return null
  const target = marketClean + cf.accrued // work in dirty price
  const dirtyAt = (s: number): number => {
    let p = 0
    for (const f of cf.flows) {
      const t = f.tau / frequency
      p += f.cf * discountAt(curve, t) * Math.exp(-s * t)
    }
    return p
  }
  let lo = -0.5
  let hi = 0.5
  let flo = dirtyAt(lo) - target
  let fhi = dirtyAt(hi) - target
  let guard = 0
  while (flo * fhi > 0 && guard < 200) {
    lo -= 0.5
    hi += 0.5
    flo = dirtyAt(lo) - target
    fhi = dirtyAt(hi) - target
    guard++
  }
  if (flo * fhi > 0) return null
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    const fm = dirtyAt(mid) - target
    if (Math.abs(fm) < 1e-12) return mid
    if (flo * fm <= 0) {
      hi = mid
    } else {
      lo = mid
      flo = fm
    }
  }
  return (lo + hi) / 2
}

/**
 * Key-rate (partial) durations: the bond's sensitivity to a ±`bump` shock of *one* zero-rate
 * node at a time (the shock tents linearly to the neighbouring nodes, so the family
 * partitions a parallel shift). Returns one number per curve node; their sum equals the
 * parallel `curveEffDuration`, which is exactly how a desk decomposes rate risk along the
 * curve. `KRD_i = (P(node i −Δ) − P(node i +Δ)) / (2·Δ·P)`.
 */
export function keyRateDurations(
  settle: number,
  maturity: number,
  rate: number,
  redemption: number,
  frequency: number,
  basis: number,
  tenors: number[],
  zeros: number[],
  bump = 1e-4,
): number[] | null {
  if (bump <= 0) return null
  const base = curveFromZeros(tenors, zeros)
  if (!base) return null
  const p0 = priceOnCurve(settle, maturity, rate, redemption, frequency, basis, base)
  if (!p0 || p0.dirty === 0) return null
  const out: number[] = []
  for (let i = 0; i < tenors.length; i++) {
    const up = curveFromZeros(tenors, zeros.map((z, j) => (j === i ? z + bump : z)))
    const dn = curveFromZeros(tenors, zeros.map((z, j) => (j === i ? z - bump : z)))
    if (!up || !dn) return null
    const pu = priceOnCurve(settle, maturity, rate, redemption, frequency, basis, up)
    const pd = priceOnCurve(settle, maturity, rate, redemption, frequency, basis, dn)
    if (!pu || !pd) return null
    out.push((pd.dirty - pu.dirty) / (2 * bump * p0.dirty))
  }
  return out
}
