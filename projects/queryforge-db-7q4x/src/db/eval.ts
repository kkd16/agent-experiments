// Expression compiler + evaluator.
//
// Rather than walking the AST per row, we *compile* each expression once into
// a closure over a pre-resolved schema. Column references become positional
// row accesses, so evaluation is a tight series of function calls. This is the
// same idea behind compiled query expressions in real engines.

import {
  SqlError,
  coerceTo,
  compareValues,
  valuesEqual,
  type ColumnType,
  type SqlValue,
} from './types'
import {
  isTemporal,
  scaleInterval,
  addIntervals,
  applyIntervalMs,
  msDiffToInterval,
  mkDate,
  mkTime,
  mkTimestamp,
  mkInterval,
  parseDate as parseDateLit,
  parseTime as parseTimeLit,
  parseTimestamp as parseTimestampLit,
  parseInterval as parseIntervalLit,
  extractField,
  truncTimestamp,
  ageInterval,
  makeDate,
  makeTime,
  makeTimestamp,
  toChar,
  formatTemporal,
  MS_PER_DAY as TMS_PER_DAY,
  type Temporal,
  type TimeValue,
  type DateValue,
  type TimestampValue,
  type IntervalValue,
} from './temporal'
import {
  isDecimal,
  addDecimal,
  subDecimal,
  mulDecimal,
  divDecimal,
  modDecimal,
  negDecimal,
  absDecimal,
  signDecimal,
  roundDecimal,
  truncDecimal,
  floorDecimal,
  ceilDecimal,
  rescale as decRescale,
  precisionOf as decPrecisionOf,
  parseDecimal as parseDecimalArg,
  toNumber as decToNumber,
  fromInt as decFromInt,
  fromNumber as decFromNumber,
  formatDecimal,
  formatNumberTemplate,
  isNumericTemplate,
  type DecimalValue,
} from './decimal'
import type { Expr, ExistsExpr, FuncExpr, InSubqueryExpr, QuantifiedExpr, SubqueryExpr, WindowFuncExpr } from './ast'
import type { Row } from './catalog'

export type Evaluator = (row: Row) => SqlValue

/**
 * One enclosing query scope, used to resolve correlated column references from
 * inside a subquery. `resolve` returns the positional index of a column in the
 * outer row (or null if the column is not part of this scope); `row` is the
 * current outer row, set by the subquery evaluator before each inner run.
 */
export interface OuterScope {
  resolve: (table: string | undefined, name: string) => number | null
  row: Row | null
}

export interface CompileCtx {
  /** Resolve a column reference to a positional index in the (local) row. */
  resolve: (table: string | undefined, name: string) => number
  /**
   * Optional lookup for pre-computed sub-expressions (grouping keys and
   * aggregate results in a grouped query). If it returns an index, the whole
   * sub-expression is read straight from that slot.
   */
  lookup?: (expr: Expr) => number | undefined
  /** Enclosing scopes (innermost last) for correlated column resolution. */
  outer?: OuterScope[]
  /** Compile a subquery-bearing expression. Provided by the planner. */
  compileSubquery?: (expr: SubqueryExpr | ExistsExpr | InSubqueryExpr | QuantifiedExpr) => Evaluator
  /** Compile a window-function expression. Provided by the planner. */
  compileWindow?: (expr: WindowFuncExpr) => Evaluator
  /** Compile a `GROUPING(…)` call against the active grouping set. Provided by
   *  the planner for grouped queries using ROLLUP/CUBE/GROUPING SETS. */
  compileGrouping?: (expr: FuncExpr) => Evaluator
}

/** String coercion that renders temporal values via their canonical form. */
function strOf(v: SqlValue): string {
  if (isTemporal(v)) return formatTemporal(v)
  if (isDecimal(v)) return formatDecimal(v)
  return String(v)
}

/** Read a value as a JS number for the float math functions (decimals degrade). */
function numOf(v: SqlValue): number {
  if (isDecimal(v)) return decToNumber(v)
  return Number(v)
}

/** Read any value as an exact DECIMAL, or null if it can't be one exactly
 *  (a non-integer REAL contaminates, so the caller falls back to float math). */
function asExactDecimal(v: SqlValue): DecimalValue | null {
  if (isDecimal(v)) return v
  if (typeof v === 'boolean') return decFromInt(v ? 1 : 0)
  if (typeof v === 'number') return Number.isInteger(v) ? decFromInt(v) : null
  return null
}

/** Arithmetic where at least one operand is a DECIMAL. Stays exact when the
 *  other side is an integer/decimal; degrades to float against a REAL. */
function decimalArith(op: string, a: SqlValue, b: SqlValue): SqlValue {
  const da = asExactDecimal(a)
  const db = asExactDecimal(b)
  if (da && db) {
    switch (op) {
      case '+': return addDecimal(da, db)
      case '-': return subDecimal(da, db)
      case '*': return mulDecimal(da, db)
      case '/': return divDecimal(da, db)
      default: return modDecimal(da, db)
    }
  }
  // A non-integer REAL is involved: compute in floating point.
  const x = numOf(a)
  const y = numOf(b)
  switch (op) {
    case '+': return x + y
    case '-': return x - y
    case '*': return x * y
    case '/': return y === 0 ? null : x / y
    default: return y === 0 ? null : x % y
  }
}

// SQL three-valued logic helpers --------------------------------------------
function toBool(v: SqlValue): boolean | null {
  if (v === null) return null
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v.length > 0
  return null
}

function likeToRegExp(pattern: string): RegExp {
  let out = '^'
  for (const ch of pattern) {
    if (ch === '%') out += '[\\s\\S]*'
    else if (ch === '_') out += '[\\s\\S]'
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(out + '$')
}

function numericPair(a: SqlValue, b: SqlValue): [number, number] {
  const n = (v: SqlValue): number => {
    if (typeof v === 'number') return v
    if (typeof v === 'boolean') return v ? 1 : 0
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
    throw new SqlError(`arithmetic on non-numeric value ${JSON.stringify(v)}`, 'eval')
  }
  return [n(a), n(b)]
}

// --- temporal arithmetic ----------------------------------------------------
// Apply an interval to a non-interval temporal. Following Postgres: DATE ±
// INTERVAL yields a TIMESTAMP; TIMESTAMP stays a TIMESTAMP; TIME takes only the
// sub-day part of the interval and wraps within a 24-hour clock.
function applyToTemporal(base: DateValue | TimeValue | TimestampValue, iv: IntervalValue, sign: 1 | -1): Temporal {
  if (base.t === 'time') return mkTime(base.ms + sign * iv.ms)
  const ms = base.t === 'date' ? base.days * TMS_PER_DAY : base.ms
  return mkTimestamp(applyIntervalMs(ms, iv, sign))
}

/** Arithmetic where at least one operand is temporal. Returns undefined when the
 *  combination isn't a defined temporal operation (so the caller can fall back
 *  to numeric handling / a clear error). */
function temporalArith(op: string, a: SqlValue, b: SqlValue): SqlValue | undefined {
  const at = isTemporal(a) ? a : null
  const bt = isTemporal(b) ? b : null
  if (!at && !bt) return undefined

  if (op === '*' || op === '/') {
    if (at?.t === 'interval' && typeof b === 'number') return scaleInterval(at, op === '*' ? b : 1 / b)
    if (op === '*' && bt?.t === 'interval' && typeof a === 'number') return scaleInterval(bt, a)
    return undefined
  }
  if (op !== '+' && op !== '-') return undefined
  const sign: 1 | -1 = op === '+' ? 1 : -1

  // interval ± interval
  if (at?.t === 'interval' && bt?.t === 'interval') return addIntervals(at, bt, sign)

  // (date|time|timestamp) ± interval  — and, for '+', interval + (…)
  if (at && at.t !== 'interval' && bt?.t === 'interval') return applyToTemporal(at, bt, sign)
  if (op === '+' && at?.t === 'interval' && bt && bt.t !== 'interval') return applyToTemporal(bt, at, 1)

  // date ± integer  → date
  if (at?.t === 'date' && typeof b === 'number') return mkDate(at.days + sign * Math.trunc(b))
  if (op === '+' && bt?.t === 'date' && typeof a === 'number') return mkDate(bt.days + Math.trunc(a))

  // differences (subtraction only)
  if (op === '-' && at && bt) {
    if (at.t === 'date' && bt.t === 'date') return at.days - bt.days
    if ((at.t === 'date' || at.t === 'timestamp') && (bt.t === 'date' || bt.t === 'timestamp')) {
      const ams = at.t === 'date' ? at.days * TMS_PER_DAY : at.ms
      const bms = bt.t === 'date' ? bt.days * TMS_PER_DAY : bt.ms
      return msDiffToInterval(ams - bms)
    }
    if (at.t === 'time' && bt.t === 'time') return msDiffToInterval(at.ms - bt.ms)
  }
  return undefined
}

/** Read an arbitrary value as a temporal value for the date/time functions. */
function coerceTemporalArg(v: SqlValue): Temporal | null {
  if (isTemporal(v)) return v
  if (typeof v === 'number') return mkTimestamp(v)
  if (typeof v === 'string') {
    return parseTimestampLit(v) ?? parseDateLit(v) ?? parseTimeLit(v) ?? parseIntervalLit(v)
  }
  return null
}

/** A temporal value as a JS Date (for the legacy string-formatting helpers). */
function toInstant(v: SqlValue): Date | null {
  const t = coerceTemporalArg(v)
  if (!t) return null
  if (t.t === 'date') return new Date(t.days * TMS_PER_DAY)
  if (t.t === 'timestamp') return new Date(t.ms)
  if (t.t === 'time') return new Date(t.ms)
  return null
}

// --- date/time helpers ------------------------------------------------------
// Dates are represented as TEXT in ISO form ('YYYY-MM-DD' or full ISO 8601) or
// as a number of epoch-milliseconds. We parse into a JS Date for computation
// and format back to ISO so the value space stays serializable.
const MS_PER_DAY = 86_400_000
// Unix epoch (1970-01-01) expressed as a Julian Day Number.
const UNIX_EPOCH_JD = 2_440_587.5

function parseDate(v: SqlValue): Date | null {
  if (v === null) return null
  if (isTemporal(v)) return toInstant(v)
  if (typeof v === 'number') return new Date(v)
  if (typeof v === 'boolean') return null
  if (isDecimal(v)) return new Date(decToNumber(v))
  const s = v.trim()
  if (s.toUpperCase() === 'NOW') return new Date()
  // Date-only strings parse as UTC midnight (avoids local-timezone drift).
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s)
  const d = new Date(dateOnly ? s + 'T00:00:00Z' : s)
  return Number.isNaN(d.getTime()) ? null : d
}
function pad(n: number, w = 2): string {
  return String(Math.abs(n)).padStart(w, '0')
}
function formatDate(d: Date, withTime: boolean): string {
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  if (!withTime) return date
  return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}
function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1)
  return Math.floor((d.getTime() - start) / MS_PER_DAY) + 1
}
function strftime(fmt: string, d: Date): string {
  return fmt.replace(/%[YmdHMSjwQ%]/g, (m) => {
    switch (m) {
      case '%Y': return pad(d.getUTCFullYear(), 4)
      case '%m': return pad(d.getUTCMonth() + 1)
      case '%d': return pad(d.getUTCDate())
      case '%H': return pad(d.getUTCHours())
      case '%M': return pad(d.getUTCMinutes())
      case '%S': return pad(d.getUTCSeconds())
      case '%j': return pad(dayOfYear(d), 3)
      case '%w': return String(d.getUTCDay())
      case '%Q': return String(Math.floor(d.getUTCMonth() / 3) + 1)
      case '%%': return '%'
      default: return m
    }
  })
}

// Postgres-style multi-arg min/max that ignores NULLs.
function extremum(args: SqlValue[], want: -1 | 1): SqlValue {
  let best: SqlValue = null
  let has = false
  for (const a of args) {
    if (a === null) continue
    if (!has || Math.sign(compareValues(a, best) ?? 0) === want) {
      best = a
      has = true
    }
  }
  return best
}

// Scalar (non-aggregate) functions ------------------------------------------
type ScalarFn = (args: SqlValue[]) => SqlValue

export const SCALAR_FUNCTIONS: Record<string, ScalarFn> = {
  // --- string ---------------------------------------------------------------
  UPPER: ([a]) => (a === null ? null : String(a).toUpperCase()),
  LOWER: ([a]) => (a === null ? null : String(a).toLowerCase()),
  INITCAP: ([a]) =>
    a === null ? null : String(a).replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\B\w/g, (c) => c.toLowerCase()),
  LENGTH: ([a]) => (a === null ? null : String(a).length),
  TRIM: ([a, ch]) => (a === null ? null : ch == null ? String(a).trim() : trimChars(String(a), String(ch), true, true)),
  LTRIM: ([a, ch]) => (a === null ? null : ch == null ? String(a).replace(/^\s+/, '') : trimChars(String(a), String(ch), true, false)),
  RTRIM: ([a, ch]) => (a === null ? null : ch == null ? String(a).replace(/\s+$/, '') : trimChars(String(a), String(ch), false, true)),
  LPAD: ([s, n, p]) => (s === null || n === null ? null : padTo(String(s), Number(n), p == null ? ' ' : String(p), true)),
  RPAD: ([s, n, p]) => (s === null || n === null ? null : padTo(String(s), Number(n), p == null ? ' ' : String(p), false)),
  REPEAT: ([s, n]) => (s === null || n === null ? null : String(s).repeat(Math.max(0, Number(n)))),
  REVERSE: ([s]) => (s === null ? null : [...String(s)].reverse().join('')),
  LEFT: ([s, n]) => (s === null || n === null ? null : String(s).slice(0, Math.max(0, Number(n)))),
  RIGHT: ([s, n]) => {
    if (s === null || n === null) return null
    const k = Math.max(0, Number(n))
    return k === 0 ? '' : String(s).slice(-k)
  },
  INSTR: ([s, sub]) => (s === null || sub === null ? null : String(s).indexOf(String(sub)) + 1),
  CONCAT: (args) => args.map((a) => (a === null ? '' : strOf(a))).join(''),
  CONCAT_WS: ([sep, ...rest]) =>
    sep === null ? null : rest.filter((a) => a !== null).map((a) => strOf(a)).join(strOf(sep)),
  SUBSTR: ([s, start, len]) => {
    if (s === null) return null
    const str = String(s)
    const st = Math.max(0, Number(start) - 1)
    return len === null || len === undefined ? str.slice(st) : str.slice(st, st + Number(len))
  },
  REPLACE: ([s, a, b]) =>
    s === null ? null : String(s).split(String(a ?? '')).join(String(b ?? '')),
  ASCII: ([s]) => (s === null || String(s).length === 0 ? null : String(s).charCodeAt(0)),
  CHR: ([n]) => (n === null ? null : String.fromCharCode(Number(n))),

  // --- numeric --------------------------------------------------------------
  // The exact-numeric (DECIMAL) functions stay exact when handed a DECIMAL and
  // return a DECIMAL; over INTEGER/REAL they keep their original float behaviour.
  ABS: ([a]) => (a === null ? null : isDecimal(a) ? absDecimal(a) : Math.abs(Number(a))),
  SIGN: ([a]) => (a === null ? null : isDecimal(a) ? signDecimal(a) : Math.sign(Number(a))),
  ROUND: ([a, d]) => {
    if (a === null) return null
    const p = d === null || d === undefined ? 0 : Number(d)
    if (isDecimal(a)) return roundDecimal(a, p)
    const f = 10 ** p
    return Math.round(Number(a) * f) / f
  },
  CEIL: ([a]) => (a === null ? null : isDecimal(a) ? ceilDecimal(a) : Math.ceil(Number(a))),
  CEILING: ([a]) => (a === null ? null : isDecimal(a) ? ceilDecimal(a) : Math.ceil(Number(a))),
  FLOOR: ([a]) => (a === null ? null : isDecimal(a) ? floorDecimal(a) : Math.floor(Number(a))),
  TRUNC: ([a, d]) => {
    if (a === null) return null
    const p = d === null || d === undefined ? 0 : Number(d)
    if (isDecimal(a)) return truncDecimal(a, p)
    const f = 10 ** p
    return Math.trunc(Number(a) * f) / f
  },
  TO_NUMBER: ([a]) => {
    if (a === null) return null
    if (isDecimal(a)) return a
    if (typeof a === 'number') return decFromNumber(a)
    if (typeof a === 'boolean') return decFromInt(a ? 1 : 0)
    return parseDecimalArg(String(a))
  },
  DECIMAL: ([a, p, s]) => {
    if (a === null) return null
    let d: DecimalValue | null = isDecimal(a)
      ? a
      : typeof a === 'number'
        ? decFromNumber(a)
        : typeof a === 'boolean'
          ? decFromInt(a ? 1 : 0)
          : parseDecimalArg(String(a))
    if (!d) throw new SqlError(`DECIMAL(): cannot convert ${JSON.stringify(a)}`, 'eval')
    // DECIMAL(value, precision, scale) — the optional 2nd/3rd args set the scale.
    if (s !== null && s !== undefined) d = decRescale(d, Number(s))
    else if (p !== null && p !== undefined && (s === null || s === undefined)) d = decRescale(d, Number(p))
    return d
  },
  SCALE: ([a]) => (a === null ? null : isDecimal(a) ? a.s : 0),
  PRECISION: ([a]) => (a === null ? null : isDecimal(a) ? decPrecisionOf(a) : null),
  SQRT: ([a]) => (a === null ? null : Math.sqrt(Number(a))),
  EXP: ([a]) => (a === null ? null : Math.exp(Number(a))),
  LN: ([a]) => (a === null ? null : Math.log(Number(a))),
  LOG10: ([a]) => (a === null ? null : Math.log10(Number(a))),
  LOG: ([a, b]) => (a === null ? null : b == null ? Math.log(Number(a)) : Math.log(Number(b)) / Math.log(Number(a))),
  POW: ([a, b]) => (a === null || b === null ? null : Number(a) ** Number(b)),
  POWER: ([a, b]) => (a === null || b === null ? null : Number(a) ** Number(b)),
  MOD: ([a, b]) =>
    a === null || b === null ? null : isDecimal(a) || isDecimal(b) ? decimalArith('%', a, b) : Number(a) % Number(b),
  PI: () => Math.PI,
  SIN: ([a]) => (a === null ? null : Math.sin(Number(a))),
  COS: ([a]) => (a === null ? null : Math.cos(Number(a))),
  TAN: ([a]) => (a === null ? null : Math.tan(Number(a))),
  ASIN: ([a]) => (a === null ? null : Math.asin(Number(a))),
  ACOS: ([a]) => (a === null ? null : Math.acos(Number(a))),
  ATAN: ([a]) => (a === null ? null : Math.atan(Number(a))),
  ATAN2: ([a, b]) => (a === null || b === null ? null : Math.atan2(Number(a), Number(b))),
  RADIANS: ([a]) => (a === null ? null : (Number(a) * Math.PI) / 180),
  DEGREES: ([a]) => (a === null ? null : (Number(a) * 180) / Math.PI),
  RANDOM: () => Math.random(),

  // --- conditional / null ---------------------------------------------------
  COALESCE: (args) => {
    for (const a of args) if (a !== null) return a
    return null
  },
  IFNULL: ([a, b]) => (a === null ? (b ?? null) : a),
  NVL: ([a, b]) => (a === null ? (b ?? null) : a),
  NULLIF: ([a, b]) => (a !== null && b !== null && valuesEqual(a, b) ? null : (a ?? null)),
  IIF: ([cond, a, b]) => (toBool(cond) ? (a ?? null) : (b ?? null)),
  GREATEST: (args) => extremum(args, 1),
  LEAST: (args) => extremum(args, -1),
  TYPEOF: ([a]) => {
    if (a === null) return 'null'
    if (typeof a === 'boolean') return 'boolean'
    if (typeof a === 'string') return 'text'
    if (isDecimal(a)) return 'decimal'
    if (isTemporal(a)) return a.t
    return Number.isInteger(a) ? 'integer' : 'real'
  },

  // --- date / time ----------------------------------------------------------
  NOW: () => formatDate(new Date(), true),
  DATE: ([a]) => {
    const d = parseDate(a)
    return d ? formatDate(d, false) : null
  },
  DATETIME: ([a]) => {
    const d = parseDate(a)
    return d ? formatDate(d, true) : null
  },
  DATE_PART: ([part, a]) => extractAny(part, a),
  EXTRACT: ([part, a]) => extractAny(part, a),
  STRFTIME: ([fmt, a]) => {
    const d = parseDate(a)
    return d && fmt !== null ? strftime(String(fmt), d) : null
  },
  JULIANDAY: ([a]) => {
    const d = parseDate(a)
    return d ? d.getTime() / MS_PER_DAY + UNIX_EPOCH_JD : null
  },
  DATEDIFF: ([a, b]) => {
    const da = parseDate(a)
    const db = parseDate(b)
    return da && db ? Math.round((da.getTime() - db.getTime()) / MS_PER_DAY) : null
  },
  DATE_ADD: ([a, days]) => {
    const d = parseDate(a)
    return d && days !== null ? formatDate(new Date(d.getTime() + Number(days) * MS_PER_DAY), false) : null
  },

  // --- first-class temporal constructors / functions -----------------------
  CURRENT_DATE: () => mkDate(Math.floor(Date.now() / MS_PER_DAY)),
  CURRENT_TIME: () => {
    const now = Date.now()
    return mkTime(now - Math.floor(now / MS_PER_DAY) * MS_PER_DAY)
  },
  CURRENT_TIMESTAMP: () => mkTimestamp(Date.now()),
  CLOCK_TIMESTAMP: () => mkTimestamp(Date.now()),
  TO_DATE: ([a]) => (a === null ? null : parseDateLit(String(a))),
  TO_TIMESTAMP: ([a]) => {
    if (a === null) return null
    if (typeof a === 'number') return mkTimestamp(a * 1000) // epoch-seconds, à la Postgres
    return parseTimestampLit(String(a)) ?? parseDateLit(String(a))
  },
  TO_TIME: ([a]) => (a === null ? null : parseTimeLit(String(a))),
  TO_INTERVAL: ([a]) => (a === null ? null : parseIntervalLit(String(a))),
  MAKE_DATE: ([y, m, d]) =>
    y === null || m === null || d === null ? null : makeDate(Number(y), Number(m), Number(d)),
  MAKE_TIME: ([h, mi, s]) =>
    h === null || mi === null || s === null ? null : makeTime(Number(h), Number(mi), Number(s)),
  MAKE_TIMESTAMP: ([y, mo, d, h, mi, s]) =>
    [y, mo, d, h, mi, s].some((x) => x === null || x === undefined)
      ? null
      : makeTimestamp(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s)),
  MAKE_INTERVAL: ([y, mo, d, h, mi, s]) => {
    const n = (x: SqlValue) => (x === null || x === undefined ? 0 : Number(x))
    return mkInterval(n(y) * 12 + n(mo), n(d), (n(h) * 3600 + n(mi) * 60 + n(s)) * 1000)
  },
  DATE_TRUNC: ([unit, a]) => {
    if (unit === null) return null
    const t = coerceTemporalArg(a)
    if (!t || (t.t !== 'date' && t.t !== 'timestamp')) return null
    return truncTimestamp(String(unit), t)
  },
  AGE: (args) => {
    const datelike = (v: SqlValue): DateValue | TimestampValue | null => {
      const t = coerceTemporalArg(v)
      return t && (t.t === 'date' || t.t === 'timestamp') ? t : null
    }
    if (args.length >= 2) {
      const a = datelike(args[0])
      const b = datelike(args[1])
      return a && b ? ageInterval(a, b) : null
    }
    const start = datelike(args[0])
    if (!start) return null
    return ageInterval(mkDate(Math.floor(Date.now() / MS_PER_DAY)), start)
  },
  TO_CHAR: ([a, fmt]) => {
    if (a === null || fmt === null || fmt === undefined) return null
    const template = String(fmt)
    // A numeric template (contains 9/0 and no date fields) formats a number;
    // otherwise fall back to temporal formatting.
    if (isNumericTemplate(template)) {
      const d = asExactDecimal(a) ?? (typeof a === 'number' ? decFromNumber(a) : null)
      if (d) return formatNumberTemplate(template, d)
    }
    const t = coerceTemporalArg(a)
    return t ? toChar(template, t) : null
  },
  JUSTIFY_HOURS: ([a]) => {
    const t = coerceTemporalArg(a)
    if (!t || t.t !== 'interval') return null
    const extraDays = Math.trunc(t.ms / MS_PER_DAY)
    return mkInterval(t.months, t.days + extraDays, t.ms - extraDays * MS_PER_DAY)
  },
}

/** EXTRACT / DATE_PART for any value: temporal objects directly, strings/numbers
 *  parsed first. Returns null on an unparseable value or unknown field. */
function extractAny(part: SqlValue, a: SqlValue): SqlValue {
  if (part === null || a === null) return null
  const t = coerceTemporalArg(a)
  return t ? extractField(String(part), t) : null
}

/** All scalar function names the parser should treat as callable (incl. those
 *  that collide with keywords like LEFT/RIGHT). */
export const SCALAR_FUNCTION_NAMES: ReadonlySet<string> = new Set(Object.keys(SCALAR_FUNCTIONS))

function trimChars(s: string, chars: string, left: boolean, right: boolean): string {
  const set = new Set([...chars])
  let start = 0
  let end = s.length
  if (left) while (start < end && set.has(s[start])) start++
  if (right) while (end > start && set.has(s[end - 1])) end--
  return s.slice(start, end)
}
function padTo(s: string, n: number, pad: string, left: boolean): string {
  if (n <= s.length) return s.slice(0, n)
  if (pad.length === 0) return s
  let fill = ''
  while (fill.length < n - s.length) fill += pad
  fill = fill.slice(0, n - s.length)
  return left ? fill + s : s + fill
}

// ---------------------------------------------------------------------------
export function compileExpr(expr: Expr, ctx: CompileCtx): Evaluator {
  // Pre-computed slot? (grouping key / aggregate output)
  if (ctx.lookup) {
    const slot = ctx.lookup(expr)
    if (slot !== undefined) return (row) => row[slot]
  }

  switch (expr.kind) {
    case 'literal': {
      const v = expr.value
      return () => v
    }
    case 'star':
      throw new SqlError('"*" is not allowed in this context', 'bind')
    case 'column': {
      // Resolve against the local schema first.
      try {
        const idx = ctx.resolve(expr.table, expr.name)
        return (row) => row[idx]
      } catch (localErr) {
        // Then walk enclosing scopes for a correlated reference (innermost first).
        if (ctx.outer) {
          for (let d = ctx.outer.length - 1; d >= 0; d--) {
            const sc = ctx.outer[d]
            const oi = sc.resolve(expr.table, expr.name)
            if (oi !== null) return () => (sc.row ? sc.row[oi] : null)
          }
        }
        throw localErr
      }
    }
    case 'cast': {
      const inner = compileExpr(expr.expr, ctx)
      const type: ColumnType = expr.type
      const scale = expr.scale
      return (row) => coerceTo(type, inner(row), scale)
    }
    case 'unary': {
      const inner = compileExpr(expr.expr, ctx)
      if (expr.op === 'NOT') {
        return (row) => {
          const b = toBool(inner(row))
          return b === null ? null : !b
        }
      }
      const sign = expr.op === '-' ? -1 : 1
      return (row) => {
        const v = inner(row)
        if (v === null) return null
        if (isTemporal(v)) {
          if (v.t === 'interval') return expr.op === '-' ? scaleInterval(v, -1) : v
          throw new SqlError(`cannot apply unary ${expr.op} to a ${v.t} value`, 'eval')
        }
        if (isDecimal(v)) return expr.op === '-' ? negDecimal(v) : v
        return Number(v) * sign
      }
    }
    case 'binary':
      return compileBinary(expr.op, compileExpr(expr.left, ctx), compileExpr(expr.right, ctx))
    case 'isnull': {
      const inner = compileExpr(expr.expr, ctx)
      const neg = expr.negated
      return (row) => {
        const isNull = inner(row) === null
        return neg ? !isNull : isNull
      }
    }
    case 'between': {
      const v = compileExpr(expr.expr, ctx)
      const lo = compileExpr(expr.lo, ctx)
      const hi = compileExpr(expr.hi, ctx)
      const neg = expr.negated
      return (row) => {
        const x = v(row)
        if (x === null) return null
        const a = compareValues(x, lo(row))
        const b = compareValues(x, hi(row))
        if (a === null || b === null) return null
        const within = a >= 0 && b <= 0
        return neg ? !within : within
      }
    }
    case 'in': {
      const v = compileExpr(expr.expr, ctx)
      const items = expr.list.map((e) => compileExpr(e, ctx))
      const neg = expr.negated
      return (row) => {
        const x = v(row)
        if (x === null) return null
        let sawNull = false
        for (const it of items) {
          const y = it(row)
          if (y === null) {
            sawNull = true
            continue
          }
          if (valuesEqual(x, y)) return !neg
        }
        if (sawNull) return null
        return neg
      }
    }
    case 'like': {
      const v = compileExpr(expr.expr, ctx)
      const p = compileExpr(expr.pattern, ctx)
      const neg = expr.negated
      let cached: { src: string; re: RegExp } | null = null
      return (row) => {
        const x = v(row)
        const pat = p(row)
        if (x === null || pat === null) return null
        const src = String(pat)
        if (!cached || cached.src !== src) cached = { src, re: likeToRegExp(src) }
        const m = cached.re.test(String(x))
        return neg ? !m : m
      }
    }
    case 'case': {
      const operand = expr.operand ? compileExpr(expr.operand, ctx) : null
      const whens = expr.whens.map((w) => ({
        when: compileExpr(w.when, ctx),
        then: compileExpr(w.then, ctx),
      }))
      const elseE = expr.else ? compileExpr(expr.else, ctx) : null
      return (row) => {
        if (operand) {
          const o = operand(row)
          for (const w of whens) if (valuesEqual(o, w.when(row))) return w.then(row)
        } else {
          for (const w of whens) if (toBool(w.when(row)) === true) return w.then(row)
        }
        return elseE ? elseE(row) : null
      }
    }
    case 'func': {
      // GROUPING/GROUPING_ID are resolved against the active grouping set.
      if (expr.name === 'GROUPING' || expr.name === 'GROUPING_ID') {
        if (!ctx.compileGrouping) {
          throw new SqlError(`${expr.name}() is only allowed with GROUP BY ROLLUP/CUBE/GROUPING SETS`, 'bind')
        }
        return ctx.compileGrouping(expr)
      }
      const fn = SCALAR_FUNCTIONS[expr.name]
      if (!fn) {
        throw new SqlError(`unknown function ${expr.name}() in this context`, 'bind')
      }
      const args = expr.args.map((a) => compileExpr(a, ctx))
      return (row) => fn(args.map((a) => a(row)))
    }
    case 'subquery':
    case 'exists':
    case 'in_subquery':
    case 'quantified': {
      if (!ctx.compileSubquery) throw new SqlError('subqueries are not allowed in this context', 'bind')
      return ctx.compileSubquery(expr)
    }
    case 'window': {
      if (!ctx.compileWindow) {
        throw new SqlError('window functions are only allowed in the SELECT list', 'bind')
      }
      return ctx.compileWindow(expr)
    }
  }
}

function compileBinary(op: string, left: Evaluator, right: Evaluator): Evaluator {
  switch (op) {
    case 'AND':
      return (row) => {
        const a = toBool(left(row))
        if (a === false) return false
        const b = toBool(right(row))
        if (b === false) return false
        if (a === null || b === null) return null
        return true
      }
    case 'OR':
      return (row) => {
        const a = toBool(left(row))
        if (a === true) return true
        const b = toBool(right(row))
        if (b === true) return true
        if (a === null || b === null) return null
        return false
      }
    case '||':
      return (row) => {
        const a = left(row)
        const b = right(row)
        if (a === null || b === null) return null
        return strOf(a) + strOf(b)
      }
    case '+':
    case '-':
    case '*':
    case '/':
    case '%':
      return (row) => {
        const a = left(row)
        const b = right(row)
        if (a === null || b === null) return null
        if (isTemporal(a) || isTemporal(b)) {
          const t = temporalArith(op, a, b)
          if (t !== undefined) return t
        }
        if (isDecimal(a) || isDecimal(b)) return decimalArith(op, a, b)
        const [x, y] = numericPair(a, b)
        switch (op) {
          case '+': return x + y
          case '-': return x - y
          case '*': return x * y
          case '/': return y === 0 ? null : x / y
          default: return y === 0 ? null : x % y
        }
      }
    case '=':
    case '<>':
    case '<':
    case '<=':
    case '>':
    case '>=':
      return (row) => {
        const c = compareValues(left(row), right(row))
        if (c === null) return null
        switch (op) {
          case '=': return c === 0
          case '<>': return c !== 0
          case '<': return c < 0
          case '<=': return c <= 0
          case '>': return c > 0
          default: return c >= 0
        }
      }
    default:
      throw new SqlError(`unsupported operator ${op}`, 'eval')
  }
}

/** Convenience: evaluate a predicate to a definite boolean (NULL -> false). */
export function truthy(v: SqlValue): boolean {
  return toBool(v) === true
}

/** Structural key for an expression, used to match grouping keys/aggregates. */
export function exprKey(e: Expr): string {
  switch (e.kind) {
    case 'literal':
      return `lit:${typeof e.value}:${String(e.value)}`
    case 'column':
      return `col:${(e.table ?? '').toLowerCase()}.${e.name.toLowerCase()}`
    case 'star':
      return `star:${e.table ?? ''}`
    case 'unary':
      return `un:${e.op}(${exprKey(e.expr)})`
    case 'binary':
      return `bin:${e.op}(${exprKey(e.left)},${exprKey(e.right)})`
    case 'between':
      return `btw:${e.negated}(${exprKey(e.expr)},${exprKey(e.lo)},${exprKey(e.hi)})`
    case 'in':
      return `in:${e.negated}(${exprKey(e.expr)};${e.list.map(exprKey).join(',')})`
    case 'like':
      return `like:${e.negated}(${exprKey(e.expr)},${exprKey(e.pattern)})`
    case 'isnull':
      return `isnull:${e.negated}(${exprKey(e.expr)})`
    case 'func':
      return `fn:${e.name}:${e.distinct}:${e.star}:${e.filter ? exprKey(e.filter) : ''}:${
        e.withinGroup ? e.withinGroup.map((o) => `${exprKey(o.expr)}:${o.dir}`).join(',') : ''
      }(${e.args.map(exprKey).join(',')})`
    case 'case':
      return `case(${e.operand ? exprKey(e.operand) : ''};${e.whens
        .map((w) => `${exprKey(w.when)}=>${exprKey(w.then)}`)
        .join(',')};${e.else ? exprKey(e.else) : ''})`
    case 'cast':
      return `cast:${e.type}(${exprKey(e.expr)})`
    case 'subquery':
      return `subq:${subqueryKey(e.select)}`
    case 'exists':
      return `exists:${e.negated}(${subqueryKey(e.select)})`
    case 'in_subquery':
      return `inq:${e.negated}(${exprKey(e.expr)};${subqueryKey(e.select)})`
    case 'quantified':
      return `quant:${e.op}:${e.quantifier}(${exprKey(e.expr)};${subqueryKey(e.select)})`
    case 'window':
      return `win:${e.name}(${e.args.map(exprKey).join(',')})[part:${e.spec.partitionBy
        .map(exprKey)
        .join(',')};ord:${e.spec.orderBy.map((o) => `${exprKey(o.expr)}:${o.dir}`).join(',')}]`
  }
}

// A subquery's identity for exprKey: we don't structurally hash the whole inner
// SELECT (it would be large and is rarely needed), just enough to disambiguate
// distinct AST nodes by identity. A module counter assigns each a stable id.
const subqueryIds = new WeakMap<object, number>()
let nextSubqueryId = 1
function subqueryKey(select: object): string {
  let id = subqueryIds.get(select)
  if (id === undefined) {
    id = nextSubqueryId++
    subqueryIds.set(select, id)
  }
  return `#${id}`
}
