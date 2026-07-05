// The financial-modeling engine — a pure, React-free numeric core that mirrors the
// classic spreadsheet finance library (Excel/Sheets semantics) from first principles.
// Nothing here knows about cells: every function takes plain numbers/arrays and
// returns a number, or `null` when the inputs fall outside the function's domain
// (the caller turns that into a `#NUM!`). Three families live here:
//
//   • Time value of money — the annuity master equation and everything it derives
//     (PV/FV/PMT/NPER/RATE, plus the per-period split IPMT/PPMT and their cumulative
//     forms CUMIPMT/CUMPRINC).
//   • Investment analysis — discounted cash flow (NPV/IRR, the date-aware XNPV/XIRR,
//     the reinvestment-aware MIRR) and the small growth helpers.
//   • Depreciation — straight-line, sum-of-years, and the declining-balance family
//     (DB/DDB and the switch-aware VDB).
//
// The root finders (RATE, IRR, XIRR) pair a guarded Newton iteration with a
// bracketing bisection fallback so an awkward cash-flow shape still converges.

const pow = Math.pow

/** A finance result: a real number, or `null` for a domain error (→ `#NUM!`). */
export type Fin = number | null

// ---------------------------------------------------------------------------
// Time value of money
// ---------------------------------------------------------------------------
//
// Every annuity function is one rearrangement of the master equation (Excel's
// convention, cash-out negative):
//
//   pv·(1+r)ⁿ + pmt·(1+r·type)·((1+r)ⁿ − 1)/r + fv = 0        (r ≠ 0)
//   pv + pmt·n + fv = 0                                         (r = 0)
//
// `type` is 0 for payments at period end (ordinary annuity) or 1 for the start
// (annuity due).

/** The signed residual of the TVM master equation — zero at a consistent (r,n,pmt,pv,fv). */
export function tvmResidual(rate: number, nper: number, pmt: number, pv: number, fv: number, type: number): number {
  if (rate === 0) return pv + pmt * nper + fv
  const f = pow(1 + rate, nper)
  return pv * f + pmt * (1 + rate * type) * (f - 1) / rate + fv
}

/** Future value of an investment given a constant rate and periodic payment. */
export function fv(rate: number, nper: number, pmt: number, pv = 0, type = 0): number {
  if (rate === 0) return -(pv + pmt * nper)
  const f = pow(1 + rate, nper)
  return -(pv * f + pmt * (1 + rate * type) * (f - 1) / rate)
}

/** Present value of a stream of equal payments (and an optional final lump `fvv`). */
export function pv(rate: number, nper: number, pmt: number, fvv = 0, type = 0): number {
  if (rate === 0) return -(fvv + pmt * nper)
  const f = pow(1 + rate, nper)
  return -(fvv + pmt * (1 + rate * type) * (f - 1) / rate) / f
}

/** The level payment that amortizes `pvv` (to a residual `fvv`) over `nper` periods. */
export function pmt(rate: number, nper: number, pvv: number, fvv = 0, type = 0): Fin {
  if (nper === 0) return null
  if (rate === 0) return -(pvv + fvv) / nper
  const f = pow(1 + rate, nper)
  return -(pvv * f + fvv) * rate / ((1 + rate * type) * (f - 1))
}

/** Number of periods needed at a constant rate/payment. */
export function nper(rate: number, pmtv: number, pvv: number, fvv = 0, type = 0): Fin {
  if (rate === 0) {
    if (pmtv === 0) return null
    return -(pvv + fvv) / pmtv
  }
  const adj = pmtv * (1 + rate * type)
  const num = adj - fvv * rate
  const den = pvv * rate + adj
  if (den === 0) return null
  const q = num / den
  if (!(q > 0)) return null
  return Math.log(q) / Math.log(1 + rate)
}

/** The periodic rate implied by (nper, pmt, pv, fv) — solved from the master equation. */
export function rate(nperv: number, pmtv: number, pvv: number, fvv = 0, type = 0, guess = 0.1): Fin {
  if (nperv <= 0) return null
  return findRate((r) => tvmResidual(r, nperv, pmtv, pvv, fvv, type), guess)
}

/** Interest portion of the `per`-th payment of a level-payment loan. */
export function ipmt(rateV: number, per: number, nperv: number, pvv: number, fvv = 0, type = 0): Fin {
  if (per < 1 || per > nperv) return null
  const p = pmt(rateV, nperv, pvv, fvv, type)
  if (p === null) return null
  if (type === 1 && per === 1) return 0
  // Interest = rate × the balance carried into this period, expressed as the FV of
  // the first (per−1) payments. For annuity-due the balance is measured one period
  // early, so the interest is discounted back by (1+rate).
  let ip = fv(rateV, per - 1, p, pvv, type) * rateV
  if (type === 1) ip = ip / (1 + rateV)
  return ip
}

/** Principal portion of the `per`-th payment: the whole payment minus its interest. */
export function ppmt(rateV: number, per: number, nperv: number, pvv: number, fvv = 0, type = 0): Fin {
  const p = pmt(rateV, nperv, pvv, fvv, type)
  const ip = ipmt(rateV, per, nperv, pvv, fvv, type)
  if (p === null || ip === null) return null
  return p - ip
}

/** Cumulative interest paid between periods `start` and `end` (inclusive). */
export function cumipmt(rateV: number, nperv: number, pvv: number, start: number, end: number, type: number): Fin {
  if (rateV <= 0 || nperv <= 0 || pvv <= 0) return null
  if (start < 1 || end < start || end > nperv || (type !== 0 && type !== 1)) return null
  let sum = 0
  for (let p = Math.floor(start); p <= Math.floor(end); p++) {
    const ip = ipmt(rateV, p, nperv, pvv, 0, type)
    if (ip === null) return null
    sum += ip
  }
  return sum
}

/** Cumulative principal repaid between periods `start` and `end` (inclusive). */
export function cumprinc(rateV: number, nperv: number, pvv: number, start: number, end: number, type: number): Fin {
  if (rateV <= 0 || nperv <= 0 || pvv <= 0) return null
  if (start < 1 || end < start || end > nperv || (type !== 0 && type !== 1)) return null
  let sum = 0
  for (let p = Math.floor(start); p <= Math.floor(end); p++) {
    const pp = ppmt(rateV, p, nperv, pvv, 0, type)
    if (pp === null) return null
    sum += pp
  }
  return sum
}

// ---------------------------------------------------------------------------
// Investment analysis — discounted cash flow
// ---------------------------------------------------------------------------

/** Net present value: each flow `values[i]` discounted i+1 periods at `rate`. */
export function npv(rateV: number, values: number[]): Fin {
  const base = 1 + rateV
  if (base === 0) return null
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += values[i] / pow(base, i + 1)
  return sum
}

/** Internal rate of return — the rate that zeroes the NPV of an evenly-spaced series
 *  whose first flow sits at period 0. Needs at least one inflow and one outflow. */
export function irr(values: number[], guess = 0.1): Fin {
  if (values.length < 2) return null
  let hasPos = false
  let hasNeg = false
  for (const v of values) {
    if (v > 0) hasPos = true
    if (v < 0) hasNeg = true
  }
  if (!hasPos || !hasNeg) return null
  const f = (r: number): number => {
    const base = 1 + r
    let sum = 0
    for (let i = 0; i < values.length; i++) sum += values[i] / pow(base, i)
    return sum
  }
  return findRate(f, guess)
}

/** Modified IRR: outflows financed at `finance`, inflows reinvested at `reinvest`. */
export function mirr(values: number[], finance: number, reinvest: number): Fin {
  const n = values.length
  if (n < 2) return null
  const pos: number[] = new Array(n).fill(0)
  const neg: number[] = new Array(n).fill(0)
  let hasPos = false
  let hasNeg = false
  for (let i = 0; i < n; i++) {
    if (values[i] > 0) { pos[i] = values[i]; hasPos = true }
    else if (values[i] < 0) { neg[i] = values[i]; hasNeg = true }
  }
  if (!hasPos || !hasNeg) return null
  const npvPos = npv(reinvest, pos)
  const npvNeg = npv(finance, neg)
  if (npvPos === null || npvNeg === null || npvNeg === 0) return null
  const num = -npvPos * pow(1 + reinvest, n)
  const den = npvNeg * (1 + finance)
  const q = num / den
  if (!(q > 0)) return null
  return pow(q, 1 / (n - 1)) - 1
}

/** Date-aware NPV: flows on arbitrary dates (Excel serials), discounted by day count. */
export function xnpv(rateV: number, values: number[], dates: number[]): Fin {
  if (values.length !== dates.length || values.length === 0) return null
  if (rateV <= -1) return null
  const d0 = dates[0]
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i] / pow(1 + rateV, (dates[i] - d0) / 365)
  }
  return sum
}

/** Date-aware IRR: the rate that zeroes XNPV for cash flows on given dates. */
export function xirr(values: number[], dates: number[], guess = 0.1): Fin {
  if (values.length !== dates.length || values.length < 2) return null
  let hasPos = false
  let hasNeg = false
  for (const v of values) {
    if (v > 0) hasPos = true
    if (v < 0) hasNeg = true
  }
  if (!hasPos || !hasNeg) return null
  const d0 = dates[0]
  const f = (r: number): number => {
    let sum = 0
    for (let i = 0; i < values.length; i++) sum += values[i] / pow(1 + r, (dates[i] - d0) / 365)
    return sum
  }
  return findRate(f, guess)
}

/** Compound a principal through a sequence of period interest rates. */
export function fvschedule(principal: number, schedule: number[]): number {
  let acc = principal
  for (const s of schedule) acc *= 1 + s
  return acc
}

/** Periods for an investment at a fixed rate to reach a target value. */
export function pduration(rateV: number, pvv: number, fvv: number): Fin {
  if (rateV <= 0 || pvv <= 0 || fvv <= 0) return null
  return (Math.log(fvv) - Math.log(pvv)) / Math.log(1 + rateV)
}

/** The equivalent constant growth rate turning `pvv` into `fvv` over `nper` periods. */
export function rri(nperv: number, pvv: number, fvv: number): Fin {
  if (nperv <= 0 || pvv === 0) return null
  const q = fvv / pvv
  if (q < 0) return null
  return pow(q, 1 / nperv) - 1
}

/** Effective annual rate from a nominal rate compounded `npery` times a year. */
export function effect(nominalRate: number, npery: number): Fin {
  const n = Math.floor(npery)
  if (nominalRate <= 0 || n < 1) return null
  return pow(1 + nominalRate / n, n) - 1
}

/** Nominal annual rate from an effective rate and a compounding frequency. */
export function nominal(effectRate: number, npery: number): Fin {
  const n = Math.floor(npery)
  if (effectRate <= 0 || n < 1) return null
  return n * (pow(1 + effectRate, 1 / n) - 1)
}

// ---------------------------------------------------------------------------
// Fractional-dollar notation (e.g. bond prices quoted in 32nds)
// ---------------------------------------------------------------------------

const fracDigits = (frac: number): number => {
  const f = Math.floor(Math.abs(frac))
  if (f <= 1) return 0
  return Math.floor(Math.log10(f)) + 1
}

/** Convert a price expressed as integer.fraction (denominator `frac`) to a decimal. */
export function dollarde(fractional: number, frac: number): Fin {
  const f = Math.floor(frac)
  if (f < 0) return null
  if (f === 0) return null // → #DIV/0! at the call site
  const intPart = Math.trunc(fractional)
  const rest = fractional - intPart
  const digits = fracDigits(f)
  return intPart + (rest * pow(10, digits)) / f
}

/** The inverse of DOLLARDE: a decimal price back into integer.fraction form. */
export function dollarfr(decimal: number, frac: number): Fin {
  const f = Math.floor(frac)
  if (f < 0) return null
  if (f === 0) return null
  const intPart = Math.trunc(decimal)
  const rest = decimal - intPart
  const digits = fracDigits(f)
  return intPart + (rest * f) / pow(10, digits)
}

// ---------------------------------------------------------------------------
// Depreciation
// ---------------------------------------------------------------------------

/** Straight-line depreciation per period. */
export function sln(cost: number, salvage: number, life: number): Fin {
  if (life === 0) return null
  return (cost - salvage) / life
}

/** Sum-of-years'-digits depreciation for period `per`. */
export function syd(cost: number, salvage: number, life: number, per: number): Fin {
  if (life <= 0 || per < 1 || per > life) return null
  return ((cost - salvage) * (life - per + 1) * 2) / (life * (life + 1))
}

/** Fixed-declining-balance depreciation for a period (with a partial first year). */
export function db(cost: number, salvage: number, life: number, period: number, month = 12): Fin {
  if (cost <= 0 || salvage < 0 || life <= 0 || period < 1 || month < 1 || month > 12) return null
  if (period > life + 1) return null
  const r = Math.round((1 - pow(salvage / cost, 1 / life)) * 1000) / 1000
  let accum = 0
  let dep = 0
  const last = Math.floor(period)
  for (let p = 1; p <= last; p++) {
    if (p === 1) dep = (cost * r * month) / 12
    else if (p === life + 1) dep = ((cost - accum) * r * (12 - month)) / 12
    else dep = (cost - accum) * r
    if (p < last) accum += dep
  }
  return dep
}

/** Double- (or factor-) declining-balance depreciation for period `period`. */
export function ddb(cost: number, salvage: number, life: number, period: number, factor = 2): Fin {
  if (cost < 0 || salvage < 0 || life <= 0 || period < 1 || period > life || factor <= 0) return null
  let accum = 0
  let dep = 0
  const last = Math.ceil(period)
  for (let p = 1; p <= last; p++) {
    const book = cost - accum
    dep = Math.min((book * factor) / life, Math.max(0, book - salvage))
    if (p < last) accum += dep
  }
  return dep
}

/** Variable declining balance: DDB summed over (start, end], switching to
 *  straight-line once that yields more (unless `noSwitch`). Integer periods. */
export function vdb(cost: number, salvage: number, life: number, start: number, end: number, factor = 2, noSwitch = false): Fin {
  if (cost < 0 || salvage < 0 || life <= 0 || start < 0 || end < start || factor <= 0) return null
  let accum = 0
  let total = 0
  let switched = false
  const last = Math.ceil(end)
  for (let p = 1; p <= last; p++) {
    const book = cost - accum
    const ddbDep = Math.min((book * factor) / life, Math.max(0, book - salvage))
    let dep: number
    if (!noSwitch) {
      const remLife = life - (p - 1)
      const sl = remLife > 0 ? (book - salvage) / remLife : 0
      if (switched || sl > ddbDep) { switched = true; dep = sl } else dep = ddbDep
    } else {
      dep = ddbDep
    }
    dep = Math.max(0, Math.min(dep, Math.max(0, book - salvage)))
    const lo = Math.max(p - 1, start)
    const hi = Math.min(p, end)
    if (hi > lo) total += dep * (hi - lo)
    accum += dep
  }
  return total
}

// ---------------------------------------------------------------------------
// Root finding — guarded Newton with a bracketing bisection fallback
// ---------------------------------------------------------------------------

/** Solve f(r) = 0 for a periodic rate r > −1, starting near `guess`. */
function findRate(f: (r: number) => number, guess: number): Fin {
  const tol = 1e-10
  const eps = 1e-7
  let x = Number.isFinite(guess) ? guess : 0.1
  if (x <= -1) x = 0.1
  for (let i = 0; i < 100; i++) {
    const y = f(x)
    if (!Number.isFinite(y)) break
    if (Math.abs(y) < tol) return x
    const d = (f(x + eps) - f(x - eps)) / (2 * eps)
    if (!Number.isFinite(d) || d === 0) break
    let xn = x - y / d
    if (xn <= -1) xn = (x - 1) / 2 // stay in the valid domain r > −1
    if (!Number.isFinite(xn)) break
    if (Math.abs(xn - x) < tol * (1 + Math.abs(xn))) {
      x = xn
      if (Math.abs(f(x)) < 1e-8) return x
      break
    }
    x = xn
  }
  return bisectScan(f)
}

/** Scan a wide grid of candidate rates for a sign change, then bisect it. */
function bisectScan(f: (r: number) => number): Fin {
  const pts: number[] = []
  for (let r = -0.9999; r <= 1.0000001; r += 0.01) pts.push(Math.round(r * 1e6) / 1e6)
  for (let r = 1.5; r <= 1e6; r *= 1.5) pts.push(r)
  let prev = pts[0]
  let fprev = f(prev)
  for (let i = 1; i < pts.length; i++) {
    const cur = pts[i]
    const fcur = f(cur)
    if (Number.isFinite(fprev) && fprev === 0) return prev
    if (Number.isFinite(fprev) && Number.isFinite(fcur) && Math.sign(fprev) !== Math.sign(fcur)) {
      let lo = prev
      let hi = cur
      let flo = fprev
      for (let k = 0; k < 200; k++) {
        const mid = (lo + hi) / 2
        const fm = f(mid)
        if (!Number.isFinite(fm)) break
        if (Math.abs(fm) < 1e-11) return mid
        if (Math.sign(fm) === Math.sign(flo)) { lo = mid; flo = fm } else { hi = mid }
      }
      return (lo + hi) / 2
    }
    prev = cur
    fprev = fcur
  }
  return null
}
