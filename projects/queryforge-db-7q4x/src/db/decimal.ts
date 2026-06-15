// First-class exact numerics: DECIMAL / NUMERIC.
//
// Like the temporal types, a DECIMAL joins the engine's deliberately small,
// JS-native value space as a *plain tagged object* so the whole database still
// serializes to localStorage with no special-casing:
//
//   DECIMAL -> { t:'decimal', d: string, s: number }
//
// `d` is the *unscaled* integer written as a base-10 string (a canonical
// `BigInt` rendering: a leading '-' for negatives, no superfluous leading
// zeros, "0" for zero) and `s` is the scale (s >= 0). The value it denotes is
//
//   value = BigInt(d) / 10 ** s
//
// so `{ d:'-1999', s:2 }` is exactly -19.99. Arithmetic is carried out in
// `BigInt`, so a DECIMAL never loses a cent to binary floating point — `SUM`ing
// a column of money is exact, `0.1 + 0.2` is exactly `0.3`, and a 40-digit
// integer compares correctly. Strings keep the value JSON-round-trippable
// (BigInt itself is not serializable), which is the whole point.

export interface DecimalValue {
  t: 'decimal'
  /** Unscaled integer as a canonical base-10 string (BigInt rendering). */
  d: string
  /** Scale: number of fractional digits (>= 0). */
  s: number
}

/** Runtime guard: is this value one of our tagged decimal objects? */
export function isDecimal(v: unknown): v is DecimalValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { t?: unknown }).t === 'decimal' &&
    typeof (v as DecimalValue).d === 'string' &&
    typeof (v as DecimalValue).s === 'number'
  )
}

/** The default minimum fractional scale produced by DECIMAL division. */
export const DIV_DEFAULT_SCALE = 6

const POW10: bigint[] = []
function pow10(n: number): bigint {
  if (n < 0) throw new Error('pow10: negative exponent')
  for (let i = POW10.length; i <= n; i++) POW10[i] = i === 0 ? 1n : POW10[i - 1] * 10n
  return POW10[n]
}

// --- constructors -----------------------------------------------------------

/** Build a normalized DECIMAL from an unscaled BigInt and a scale. */
export function mkDecimal(unscaled: bigint, scale: number): DecimalValue {
  const s = Math.max(0, Math.trunc(scale))
  return { t: 'decimal', d: unscaled.toString(), s }
}

const big = (d: DecimalValue): bigint => BigInt(d.d)

/** The DECIMAL value 0 (scale 0). */
export const DECIMAL_ZERO: DecimalValue = { t: 'decimal', d: '0', s: 0 }

/**
 * Parse a decimal literal (`-12.34`, `.5`, `1e3`, `1.5E-2`) into an exact
 * DECIMAL, or null if the text isn't a well-formed decimal number.
 */
export function parseDecimal(str: string): DecimalValue | null {
  const m = /^\s*([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?\s*$/.exec(str)
  if (!m) return null
  const sign = m[1]
  const intp = m[2] ?? ''
  const frac = m[3] ?? ''
  const exp = m[4]
  if (intp === '' && frac === '') return null // bare sign / lone '.'
  let scale = frac.length
  if (exp !== undefined) scale -= Number(exp)
  let unscaled = BigInt((sign === '-' ? '-' : '') + (intp + frac || '0'))
  if (scale < 0) {
    unscaled *= pow10(-scale)
    scale = 0
  }
  return mkDecimal(unscaled, scale)
}

/** Convert a finite JS number to an exact DECIMAL via its shortest round-trip
 *  string (so 19.99 becomes exactly 19.99, not 19.989999…). */
export function fromNumber(n: number): DecimalValue | null {
  if (!Number.isFinite(n)) return null
  return parseDecimal(String(n))
}

/** A DECIMAL holding an exact integer. */
export function fromInt(n: number | bigint): DecimalValue {
  return mkDecimal(typeof n === 'bigint' ? n : BigInt(Math.trunc(n)), 0)
}

/** Lossy conversion to a JS number (for mixing with REAL / transcendentals). */
export function toNumber(d: DecimalValue): number {
  return Number(formatDecimal(d))
}

// --- formatting -------------------------------------------------------------

/** Render a DECIMAL with its full declared scale, e.g. {d:'-1999',s:2} -> "-19.99". */
export function formatDecimal(d: DecimalValue): string {
  const neg = d.d.startsWith('-')
  let digits = neg ? d.d.slice(1) : d.d
  if (d.s === 0) return d.d
  if (digits.length <= d.s) digits = digits.padStart(d.s + 1, '0')
  const cut = digits.length - d.s
  return (neg ? '-' : '') + digits.slice(0, cut) + '.' + digits.slice(cut)
}

/** A canonical key with trailing fractional zeros stripped, so 1.00, 1.0 and
 *  the integer 1 all share one identity in GROUP BY / DISTINCT / joins. */
export function hashDecimal(d: DecimalValue): string {
  let s = formatDecimal(d)
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s === '-0' ? '0' : s
}

// --- comparison -------------------------------------------------------------

/** Exact three-way comparison of two DECIMALs (scale-independent). */
export function compareDecimal(a: DecimalValue, b: DecimalValue): -1 | 0 | 1 {
  const s = Math.max(a.s, b.s)
  const ua = big(a) * pow10(s - a.s)
  const ub = big(b) * pow10(s - b.s)
  return ua < ub ? -1 : ua > ub ? 1 : 0
}

// --- arithmetic -------------------------------------------------------------

/** Integer division of n by a positive d, rounded half away from zero. */
function divRoundHalfUp(n: bigint, d: bigint): bigint {
  const neg = n < 0n
  const an = neg ? -n : n
  let q = an / d
  if ((an % d) * 2n >= d) q += 1n
  return neg ? -q : q
}

/** Integer division truncated toward zero. */
function divTrunc(n: bigint, d: bigint): bigint {
  const neg = n < 0n !== d < 0n
  const q = (n < 0n ? -n : n) / (d < 0n ? -d : d)
  return neg ? -q : q
}

/** Floor division (toward -∞), d > 0. */
function divFloor(n: bigint, d: bigint): bigint {
  let q = n / d
  if (n % d !== 0n && n < 0n) q -= 1n
  return q
}

export function addDecimal(a: DecimalValue, b: DecimalValue): DecimalValue {
  const s = Math.max(a.s, b.s)
  return mkDecimal(big(a) * pow10(s - a.s) + big(b) * pow10(s - b.s), s)
}
export function subDecimal(a: DecimalValue, b: DecimalValue): DecimalValue {
  const s = Math.max(a.s, b.s)
  return mkDecimal(big(a) * pow10(s - a.s) - big(b) * pow10(s - b.s), s)
}
export function mulDecimal(a: DecimalValue, b: DecimalValue): DecimalValue {
  return mkDecimal(big(a) * big(b), a.s + b.s)
}
/** Exact division to a chosen scale (default: max(sa, sb, 6)), half-up rounded.
 *  Returns null for division by zero (matching the engine's `/` semantics). */
export function divDecimal(a: DecimalValue, b: DecimalValue, minScale = DIV_DEFAULT_SCALE): DecimalValue | null {
  if (big(b) === 0n) return null
  const rscale = Math.max(a.s, b.s, minScale)
  let num = big(a) * pow10(rscale + b.s)
  let den = big(b) * pow10(a.s)
  if (den < 0n) {
    num = -num
    den = -den
  }
  return mkDecimal(divRoundHalfUp(num, den), rscale)
}
/** SQL modulo: result shares the dividend's sign; null on a zero divisor. */
export function modDecimal(a: DecimalValue, b: DecimalValue): DecimalValue | null {
  const s = Math.max(a.s, b.s)
  const ub = big(b) * pow10(s - b.s)
  if (ub === 0n) return null
  const ua = big(a) * pow10(s - a.s)
  return mkDecimal(ua % ub, s)
}
export function negDecimal(d: DecimalValue): DecimalValue {
  return mkDecimal(-big(d), d.s)
}
export function absDecimal(d: DecimalValue): DecimalValue {
  const u = big(d)
  return mkDecimal(u < 0n ? -u : u, d.s)
}
export function signDecimal(d: DecimalValue): number {
  const u = big(d)
  return u < 0n ? -1 : u > 0n ? 1 : 0
}

/** Rescale to exactly `newScale` fractional digits, half-up rounding when narrowing. */
export function rescale(d: DecimalValue, newScale: number): DecimalValue {
  const ns = Math.max(0, Math.trunc(newScale))
  if (ns === d.s) return d
  if (ns > d.s) return mkDecimal(big(d) * pow10(ns - d.s), ns)
  return mkDecimal(divRoundHalfUp(big(d), pow10(d.s - ns)), ns)
}

/** ROUND(d, places): half-away-from-zero to `places` fractional digits (places
 *  may be negative to round to tens/hundreds). */
export function roundDecimal(d: DecimalValue, places = 0): DecimalValue {
  const p = Math.trunc(places)
  if (p >= d.s) return p >= 0 ? rescale(d, p) : d
  const m = divRoundHalfUp(big(d), pow10(d.s - p))
  return p >= 0 ? mkDecimal(m, p) : mkDecimal(m * pow10(-p), 0)
}

/** TRUNC(d, places): toward zero. */
export function truncDecimal(d: DecimalValue, places = 0): DecimalValue {
  const p = Math.trunc(places)
  if (p >= d.s) return p >= 0 ? rescale(d, p) : d
  const m = divTrunc(big(d), pow10(d.s - p))
  return p >= 0 ? mkDecimal(m, p) : mkDecimal(m * pow10(-p), 0)
}

export function floorDecimal(d: DecimalValue): DecimalValue {
  if (d.s === 0) return d
  return mkDecimal(divFloor(big(d), pow10(d.s)), 0)
}
export function ceilDecimal(d: DecimalValue): DecimalValue {
  if (d.s === 0) return d
  return mkDecimal(-divFloor(-big(d), pow10(d.s)), 0)
}

/** Number of significant digits (the "precision" half of DECIMAL(p, s)). */
export function precisionOf(d: DecimalValue): number {
  const digits = d.d.replace('-', '').replace(/^0+/, '')
  return Math.max(digits.length, d.s, 1)
}

// --- TO_CHAR numeric template formatting ------------------------------------
// A pragmatic subset of Postgres's numeric `to_char` template language:
//   9   digit position (blank when not significant)
//   0   digit position (always a digit, zero-padded)
//   .   decimal point        ,   group (thousands) separator
//   D   locale decimal point G   locale group separator
//   S   sign (+/-) anchored where it appears (lead or trail)
//   MI  trailing minus for negatives (blank for non-negative)
//   PR  negative values wrapped in <angle brackets>
//   $ L  a literal currency symbol ($)
//   FM  (prefix) fill mode — strip the padding blanks
//
// Returns null if the template contains no digit positions (not a number fmt).

/** Detect whether a TO_CHAR template is a *numeric* (vs temporal) template. */
export function isNumericTemplate(template: string): boolean {
  return /[90]/.test(template) && !/(YY|MM|DD|HH|MI?N|MON|DAY|DY|SS|AM|PM|TZ|Q|WW|DDD)/i.test(template.replace(/MI/g, ''))
}

export function formatNumberTemplate(template: string, dec: DecimalValue): string {
  let tmpl = template
  let fill = false
  if (/^FM/i.test(tmpl)) {
    fill = true
    tmpl = tmpl.slice(2)
  }
  const hasMI = /MI/i.test(tmpl)
  const hasPR = /PR/i.test(tmpl)
  const hasS = /S/i.test(tmpl)
  // Where does the sign sit? (leading vs trailing 'S')
  const sIndex = tmpl.search(/S/i)
  const sTrailing = hasS && sIndex >= tmpl.length - 1
  // Strip the sign/format-modifier letters from the digit grammar.
  const grammar = tmpl.replace(/MI/gi, '').replace(/PR/gi, '').replace(/S/gi, '').replace(/L/gi, '$')

  const dotMatch = grammar.search(/[.D]/i)
  const intTmpl = dotMatch >= 0 ? grammar.slice(0, dotMatch) : grammar
  const fracTmpl = dotMatch >= 0 ? grammar.slice(dotMatch + 1) : ''
  const fracCount = (fracTmpl.match(/[90]/g) || []).length

  const rounded = (function round(d: DecimalValue): DecimalValue {
    const p = Math.trunc(fracCount)
    if (p >= d.s) return p >= 0 ? rescale(d, p) : d
    return rescale(d, p)
  })(dec)
  const neg = rounded.d.startsWith('-')
  const abs = neg ? { ...rounded, d: rounded.d.slice(1) } : rounded
  const full = formatDecimal(abs)
  const [intRaw, fracRaw = ''] = full.split('.')
  const intDigits = intRaw === '0' ? '0' : intRaw
  const fracDigits = fracRaw.padEnd(fracCount, '0').slice(0, fracCount)

  // Render the integer field right-to-left against its template slots.
  const intSlots = [...intTmpl]
  let di = intDigits.length - 1
  const outRev: string[] = []
  let overflow = false
  for (let k = intSlots.length - 1; k >= 0; k--) {
    const ch = intSlots[k]
    if (ch === '9' || ch === '0') {
      if (di >= 0) {
        outRev.push(intDigits[di--])
      } else {
        outRev.push(ch === '0' ? '0' : fill ? '' : ' ')
      }
    } else if (ch === ',' || ch === 'G' || ch === 'g') {
      outRev.push(di >= 0 ? ',' : fill ? '' : ' ')
    } else if (ch === '$') {
      outRev.push('$')
    } else {
      outRev.push(ch)
    }
  }
  if (di >= 0) overflow = true
  let intOut = outRev.reverse().join('')
  if (overflow) {
    // Postgres marks a field that can't hold the value with '#'.
    intOut = '#'.repeat(Math.max(1, intSlots.filter((c) => c === '9' || c === '0').length))
  }

  let out = intOut
  if (dotMatch >= 0) out += '.' + fracDigits

  // Apply the sign / wrapping modifiers.
  if (hasPR) {
    out = neg ? `<${out.trim()}>` : fill ? out.trim() : ` ${out.trim()} `
  } else if (hasMI) {
    out = out + (neg ? '-' : fill ? '' : ' ')
  } else if (hasS) {
    const sign = neg ? '-' : '+'
    out = sTrailing ? out + sign : sign + out
  } else if (neg) {
    out = '-' + out
  }
  if (fill) out = out.trim()
  return out
}
