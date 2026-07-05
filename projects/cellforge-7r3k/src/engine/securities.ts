// Fixed-income securities analytics — a pure, React-free core that mirrors Excel's
// bond/treasury library from first principles. Nothing here knows about cells: every
// function takes plain numbers (dates are Excel serials) and returns a number, or
// `null` on a domain error (the caller turns that into a `#NUM!`). Four families:
//
//   • Coupon bonds — PRICE (clean price per 100 face from a yield), YIELD (the
//     inverse, by a bracketed root solve on the strictly-decreasing price/yield
//     curve), Macaulay DURATION and MDURATION (its modified form).
//   • Accrued interest — ACCRINT (periodic-coupon security) and ACCRINTM (interest
//     at maturity), summed per quasi-coupon period so every day-count basis is exact.
//   • Discounted (money-market) securities — DISC, PRICEDISC, YIELDDISC, INTRATE and
//     RECEIVED, plus the Treasury-bill trio TBILLPRICE / TBILLYIELD / TBILLEQ.
//   • Interest-at-maturity securities — PRICEMAT and YIELDMAT.
//
// All the calendar work (day counts, coupon scheduling) lives in `daycount.ts`; this
// module is just the finance on top of it.

import type { Basis } from './daycount'
import {
  yearFrac as yearFracRaw,
  couponNum,
  coupDays,
  coupDaysNC,
  coupDaysBS,
  diffDays,
  daysInMonth,
} from './daycount'
import { serialToDate, dateToSerial } from './dates'

const pow = Math.pow

/** A securities result: a real number, or `null` for a domain error (→ `#NUM!`). */
export type Sec = number | null

const isFreq = (f: number): boolean => f === 1 || f === 2 || f === 4
const isBasis = (b: number): boolean => b >= 0 && b <= 4 && Number.isInteger(b)

/** `YEARFRAC` with domain checking (an unknown basis → null). */
export function yearFrac(start: number, end: number, basis: number): Sec {
  if (!isBasis(basis)) return null
  return yearFracRaw(start, end, basis as Basis)
}

// ---------------------------------------------------------------------------
// Coupon bonds
// ---------------------------------------------------------------------------

/**
 * Clean price per $100 face of a coupon bond, given the yield. Uses the standard
 * Excel present-value sum over the remaining coupons with a fractional first period
 * `DSC/E`, minus the accrued interest `A/E · coupon`. A single remaining period is
 * discounted with the money-market simple-interest rule, exactly like Excel.
 */
export function price(
  settle: number,
  maturity: number,
  rate: number,
  yld: number,
  redemption: number,
  frequency: number,
  basis: number,
): Sec {
  if (settle >= maturity || rate < 0 || yld < 0 || redemption <= 0 || !isFreq(frequency) || !isBasis(basis)) return null
  const b = basis as Basis
  const N = couponNum(settle, maturity, frequency)
  const E = coupDays(settle, maturity, frequency, b)
  const DSC = coupDaysNC(settle, maturity, frequency, b)
  const A = coupDaysBS(settle, maturity, frequency, b)
  const coupon = (100 * rate) / frequency
  const yf = yld / frequency
  const accrued = coupon * (A / E)

  if (N === 1) {
    const t = DSC / E
    const den = 1 + t * yf
    if (den === 0) return null
    return (redemption + coupon) / den - accrued
  }

  const T = DSC / E
  let p = redemption / pow(1 + yf, N - 1 + T)
  for (let k = 1; k <= N; k++) p += coupon / pow(1 + yf, k - 1 + T)
  return p - accrued
}

/**
 * The yield to maturity that reproduces a given clean `price`. Price is strictly
 * decreasing in yield, so we bracket the root (expanding the upper bound until the
 * modelled price falls below the target) and bisect to full precision.
 */
export function bondYield(
  settle: number,
  maturity: number,
  rate: number,
  pr: number,
  redemption: number,
  frequency: number,
  basis: number,
): Sec {
  if (settle >= maturity || rate < 0 || pr <= 0 || redemption <= 0 || !isFreq(frequency) || !isBasis(basis)) return null
  const f = (y: number): number | null => {
    const p = price(settle, maturity, rate, y, redemption, frequency, basis)
    return p === null ? null : p - pr
  }
  let lo = 0
  let flo = f(lo)
  if (flo === null) return null
  // A price at/above par with a zero yield already brackets from above; find a hi.
  let hi = 0.05
  let fhi = f(hi)
  let guard = 0
  while (fhi !== null && fhi > 0 && guard < 200) {
    hi *= 2
    fhi = f(hi)
    guard++
  }
  if (fhi === null) return null
  if (flo * fhi > 0) {
    // Root may be negative (deep-premium bond): walk lo below zero.
    lo = -0.9999
    flo = f(lo)
    if (flo === null || flo * fhi > 0) return null
  }
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    const fm = f(mid)
    if (fm === null) return null
    if (Math.abs(fm) < 1e-11) return mid
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
 * Macaulay duration (in years) of a coupon bond: the present-value-weighted average
 * time to each cash flow, with redemption assumed at 100. Cash-flow times run from
 * the fractional first period `DSC/E` outward in whole coupon periods.
 */
export function duration(
  settle: number,
  maturity: number,
  coupon: number,
  yld: number,
  frequency: number,
  basis: number,
): Sec {
  if (settle >= maturity || coupon < 0 || yld < 0 || !isFreq(frequency) || !isBasis(basis)) return null
  const b = basis as Basis
  const N = couponNum(settle, maturity, frequency)
  const E = coupDays(settle, maturity, frequency, b)
  const DSC = coupDaysNC(settle, maturity, frequency, b)
  const frac = DSC / E
  const yf = yld / frequency
  const v = 1 / (1 + yf)
  const cpn = (100 * coupon) / frequency
  let sumPV = 0
  let sumTPV = 0
  for (let k = 1; k <= N; k++) {
    const t = frac + (k - 1)
    const cf = cpn + (k === N ? 100 : 0)
    const pv = cf * pow(v, t)
    sumPV += pv
    sumTPV += t * pv
  }
  if (sumPV === 0) return null
  return sumTPV / sumPV / frequency
}

/** Modified duration: Macaulay duration divided by (1 + yld/frequency). */
export function mduration(
  settle: number,
  maturity: number,
  coupon: number,
  yld: number,
  frequency: number,
  basis: number,
): Sec {
  const d = duration(settle, maturity, coupon, yld, frequency, basis)
  if (d === null) return null
  return d / (1 + yld / frequency)
}

// ---------------------------------------------------------------------------
// Accrued interest
// ---------------------------------------------------------------------------

const monthsPerCoupon = (frequency: number): number => Math.round(12 / frequency)

/** Step an EOM-aware coupon date by whole months (mirrors daycount's private stepper). */
function shiftCoupon(serial: number, months: number): number {
  const d = serialToDate(serial)
  const eom = d.day === daysInMonth(d.year, d.month)
  const idx = d.month - 1 + months
  const year = d.year + Math.floor(idx / 12)
  const month = (((idx % 12) + 12) % 12) + 1
  const last = daysInMonth(year, month)
  return dateToSerial(year, month, eom ? last : Math.min(d.day, last))
}

/** The normal length of a quasi-coupon period under a basis. */
function periodLength(periodStart: number, periodEnd: number, frequency: number, basis: Basis): number {
  if (basis === 1) return periodEnd - periodStart
  if (basis === 3) return 365 / frequency
  return 360 / frequency
}

/**
 * Accrued interest of a security that pays periodic interest (Excel `ACCRINT`).
 * Quasi-coupon dates are anchored at `firstInterest`; we accrue from `issue` (the
 * `calcMethod = true` default) or from the quasi-coupon date preceding settlement
 * (`calcMethod = false`) up to settlement, summing each period's day-count fraction.
 */
export function accrint(
  issue: number,
  firstInterest: number,
  settle: number,
  rate: number,
  par: number,
  frequency: number,
  basis: number,
  calcMethod = true,
): Sec {
  if (rate <= 0 || par <= 0 || !isFreq(frequency) || !isBasis(basis) || issue >= settle) return null
  const b = basis as Basis
  const step = monthsPerCoupon(frequency)

  // Accrual start: issue, or (calcMethod = false) the quasi-coupon date at/preceding settle.
  let accrualStart = issue
  if (!calcMethod) {
    let c = firstInterest
    let guard = 0
    while (c > settle && guard < 100000) { c = shiftCoupon(c, -step); guard++ }
    if (c > issue) accrualStart = c
  }

  // Walk quasi-coupon periods from just before accrualStart up to settle.
  let c = firstInterest
  let guard = 0
  while (c > accrualStart && guard < 100000) { c = shiftCoupon(c, -step); guard++ }
  let total = 0
  guard = 0
  while (c < settle && guard < 100000) {
    const next = shiftCoupon(c, step)
    const s = Math.max(c, accrualStart)
    const e = Math.min(next, settle)
    if (e > s) {
      const NL = periodLength(c, next, frequency, b)
      if (NL !== 0) total += diffDays(s, e, b) / NL
    }
    c = next
    guard++
  }
  return (par * rate * total) / frequency
}

/** Accrued interest of a security that pays interest at maturity (Excel `ACCRINTM`). */
export function accrintm(issue: number, settle: number, rate: number, par: number, basis: number): Sec {
  if (rate <= 0 || par <= 0 || !isBasis(basis) || issue >= settle) return null
  const yf = yearFracRaw(issue, settle, basis as Basis)
  if (yf === null) return null
  return par * rate * yf
}

// ---------------------------------------------------------------------------
// Discounted (money-market) securities
// ---------------------------------------------------------------------------

/** Discount rate of a security (Excel `DISC`). */
export function disc(settle: number, maturity: number, pr: number, redemption: number, basis: number): Sec {
  if (settle >= maturity || pr <= 0 || redemption <= 0 || !isBasis(basis)) return null
  const yf = yearFracRaw(settle, maturity, basis as Basis)
  if (yf === null || yf === 0) return null
  return ((redemption - pr) / redemption) / yf
}

/** Price per $100 of a discounted security (Excel `PRICEDISC`). */
export function priceDisc(settle: number, maturity: number, discount: number, redemption: number, basis: number): Sec {
  if (settle >= maturity || discount <= 0 || redemption <= 0 || !isBasis(basis)) return null
  const yf = yearFracRaw(settle, maturity, basis as Basis)
  if (yf === null) return null
  return redemption - discount * redemption * yf
}

/** Annual yield of a discounted security (Excel `YIELDDISC`). */
export function yieldDisc(settle: number, maturity: number, pr: number, redemption: number, basis: number): Sec {
  if (settle >= maturity || pr <= 0 || redemption <= 0 || !isBasis(basis)) return null
  const yf = yearFracRaw(settle, maturity, basis as Basis)
  if (yf === null || yf === 0) return null
  return ((redemption - pr) / pr) / yf
}

/** Interest rate for a fully-invested security (Excel `INTRATE`). */
export function intrate(settle: number, maturity: number, investment: number, redemption: number, basis: number): Sec {
  if (settle >= maturity || investment <= 0 || redemption <= 0 || !isBasis(basis)) return null
  const yf = yearFracRaw(settle, maturity, basis as Basis)
  if (yf === null || yf === 0) return null
  return ((redemption - investment) / investment) / yf
}

/** Amount received at maturity for a fully-invested discounted security (Excel `RECEIVED`). */
export function received(settle: number, maturity: number, investment: number, discount: number, basis: number): Sec {
  if (settle >= maturity || investment <= 0 || discount <= 0 || !isBasis(basis)) return null
  const yf = yearFracRaw(settle, maturity, basis as Basis)
  if (yf === null) return null
  const den = 1 - discount * yf
  if (den === 0) return null
  return investment / den
}

// ---------------------------------------------------------------------------
// Treasury bills (actual/360 discount basis, capped at one year)
// ---------------------------------------------------------------------------

/** Price per $100 of a Treasury bill (Excel `TBILLPRICE`). */
export function tbillPrice(settle: number, maturity: number, discount: number): Sec {
  const dsm = maturity - settle
  if (dsm <= 0 || dsm > 365 || discount <= 0) return null
  return 100 * (1 - (discount * dsm) / 360)
}

/** Yield of a Treasury bill from its price (Excel `TBILLYIELD`). */
export function tbillYield(settle: number, maturity: number, pr: number): Sec {
  const dsm = maturity - settle
  if (dsm <= 0 || dsm > 365 || pr <= 0) return null
  return ((100 - pr) / pr) * (360 / dsm)
}

/** Bond-equivalent yield of a Treasury bill (Excel `TBILLEQ`). */
export function tbillEq(settle: number, maturity: number, discount: number): Sec {
  const dsm = maturity - settle
  if (dsm <= 0 || dsm > 365 || discount <= 0) return null
  if (dsm <= 182) {
    const den = 360 - discount * dsm
    if (den <= 0) return null
    return (365 * discount) / den
  }
  // > 182 days: the US Treasury coupon-equivalent quadratic on the discount price.
  const pFrac = 1 - (discount * dsm) / 360 // price as a fraction of face
  if (pFrac <= 0) return null
  const t = dsm / 365
  const disc = t * t - (2 * t - 1) * (1 - 1 / pFrac)
  if (disc < 0) return null
  const den = t - 0.5
  if (den === 0) return null
  return (-t + Math.sqrt(disc)) / den
}

// ---------------------------------------------------------------------------
// Interest-at-maturity securities
// ---------------------------------------------------------------------------

/** Price per $100 of a security that pays interest at maturity (Excel `PRICEMAT`). */
export function priceMat(settle: number, maturity: number, issue: number, rate: number, yld: number, basis: number): Sec {
  if (settle >= maturity || issue >= settle || rate < 0 || yld < 0 || !isBasis(basis)) return null
  const b = basis as Basis
  const DIM = yearFracRaw(issue, maturity, b)
  const DSM = yearFracRaw(settle, maturity, b)
  const A = yearFracRaw(issue, settle, b)
  if (DIM === null || DSM === null || A === null) return null
  const den = 1 + DSM * yld
  if (den === 0) return null
  return (100 + DIM * rate * 100) / den - A * rate * 100
}

/** Annual yield of a security that pays interest at maturity (Excel `YIELDMAT`). */
export function yieldMat(settle: number, maturity: number, issue: number, rate: number, pr: number, basis: number): Sec {
  if (settle >= maturity || issue >= settle || rate < 0 || pr <= 0 || !isBasis(basis)) return null
  const b = basis as Basis
  const DIM = yearFracRaw(issue, maturity, b)
  const DSM = yearFracRaw(settle, maturity, b)
  const A = yearFracRaw(issue, settle, b)
  if (DIM === null || DSM === null || A === null || DSM === 0) return null
  const den = pr / 100 + A * rate
  if (den === 0) return null
  return ((1 + DIM * rate) / den - 1) / DSM
}
