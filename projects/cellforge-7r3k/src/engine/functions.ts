// The function library: ~60 spreadsheet functions across math, trig, statistics,
// logic, text, lookup, and info, plus the inline SPARKLINE chart. Each entry is a
// small pure function over already-parsed argument nodes. Functions that must
// short-circuit (IF, AND, OR, IFERROR) take the raw nodes and evaluate lazily;
// everything else uses the flatten/scalar helpers from the evaluator.

import type { Node } from './ast'
import type { FnImpl, FnHelpers } from './evaluator'
import type { Scalar, ErrorValue, RuntimeValue, SparklineValue, MatrixValue, LambdaValue } from './values'
import { BLANK, err, isError, isBlank, asScalar, toNumber, toText, toBool, matrix } from './values'
import {
  dateToSerial,
  timeToFraction,
  serialToDate,
  serialToTime,
  todaySerial,
  nowSerial,
  addMonths,
  endOfMonth,
  formatSerialPattern,
} from './dates'

// ---- argument helpers -------------------------------------------------------

const scalarAt = (args: Node[], i: number, h: FnHelpers): Scalar =>
  i < args.length ? h.scalarOf(args[i]) : BLANK

function numAt(args: Node[], i: number, h: FnHelpers, dflt?: number): number | ErrorValue {
  if (i >= args.length) return dflt ?? 0
  return toNumber(h.scalarOf(args[i]))
}

function textAt(args: Node[], i: number, h: FnHelpers, dflt = ''): string | ErrorValue {
  if (i >= args.length) return dflt
  return toText(h.scalarOf(args[i]))
}

/** Gather numeric values from a list of args, flattening ranges, ignoring text and
 *  blanks, treating booleans as 1/0, and propagating the first error encountered. */
function numbers(args: Node[], h: FnHelpers): number[] | ErrorValue {
  const out: number[] = []
  for (const x of h.flatten(args)) {
    if (isError(x)) return x
    if (typeof x === 'number') out.push(x)
    else if (typeof x === 'boolean') out.push(x ? 1 : 0)
  }
  return out
}

const need1 = (n: number | ErrorValue, f: (x: number) => RuntimeValue): RuntimeValue =>
  isError(n) ? n : f(n)

function flat1(args: Node[], h: FnHelpers): number | ErrorValue {
  return numAt(args, 0, h)
}

// ---- criteria matching (COUNTIF / SUMIF) ------------------------------------

function matchCriteria(value: Scalar, criteria: Scalar): boolean {
  let op = '='
  let target: Scalar = criteria
  if (typeof criteria === 'string') {
    const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(criteria)
    op = (m && m[1]) || '='
    const rest = (m && m[2]) || ''
    const num = Number(rest)
    target = rest !== '' && !Number.isNaN(num) ? num : rest
  }
  const cmp = looseCompare(value, target)
  if (cmp === null) return op === '<>'
  switch (op) {
    case '=':
      return cmp === 0
    case '<>':
      return cmp !== 0
    case '<':
      return cmp < 0
    case '>':
      return cmp > 0
    case '<=':
      return cmp <= 0
    case '>=':
      return cmp >= 0
  }
  return false
}

/** Returns -1/0/1, or null when the two values aren't comparable. */
function looseCompare(a: Scalar, b: Scalar): number | null {
  if (isError(a) || isError(b)) return null
  const av = isBlank(a) ? 0 : a
  const bv = isBlank(b) ? 0 : b
  if (typeof av === 'number' && typeof bv === 'number') return Math.sign(av - bv)
  const as = typeof av === 'string' ? av.toLowerCase() : String(av).toLowerCase()
  const bs = typeof bv === 'string' ? bv.toLowerCase() : String(bv).toLowerCase()
  return as < bs ? -1 : as > bs ? 1 : 0
}

// ---- math -------------------------------------------------------------------

const unaryMath =
  (f: (x: number) => number, guard?: (x: number) => ErrorValue | null): FnImpl =>
  (args, h) =>
    need1(flat1(args, h), (x) => {
      const g = guard?.(x)
      if (g) return g
      const r = f(x)
      return Number.isNaN(r) ? err('#NUM!') : r
    })

const numError = (ok: boolean): ErrorValue | null => (ok ? null : err('#NUM!'))

// ---- the registry -----------------------------------------------------------

export const FUNCTIONS: Record<string, FnImpl> = {
  // constants & non-deterministic
  PI: () => Math.PI,
  TRUE: () => true,
  FALSE: () => false,
  NA: () => err('#N/A'),
  RAND: () => Math.random(),
  RANDBETWEEN: (args, h) => {
    const lo = numAt(args, 0, h)
    if (isError(lo)) return lo
    const hi = numAt(args, 1, h)
    if (isError(hi)) return hi
    const a = Math.ceil(lo)
    const b = Math.floor(hi)
    if (b < a) return err('#NUM!')
    return a + Math.floor(Math.random() * (b - a + 1))
  },

  // single-argument math
  ABS: unaryMath(Math.abs),
  SQRT: unaryMath(Math.sqrt, (x) => numError(x >= 0)),
  EXP: unaryMath(Math.exp),
  LN: unaryMath(Math.log, (x) => numError(x > 0)),
  LOG10: unaryMath(Math.log10, (x) => numError(x > 0)),
  SIGN: unaryMath(Math.sign),
  INT: unaryMath(Math.floor),
  SIN: unaryMath(Math.sin),
  COS: unaryMath(Math.cos),
  TAN: unaryMath(Math.tan),
  ASIN: unaryMath(Math.asin, (x) => numError(Math.abs(x) <= 1)),
  ACOS: unaryMath(Math.acos, (x) => numError(Math.abs(x) <= 1)),
  ATAN: unaryMath(Math.atan),
  DEGREES: unaryMath((x) => (x * 180) / Math.PI),
  RADIANS: unaryMath((x) => (x * Math.PI) / 180),

  // multi-argument math
  POWER: (args, h) => {
    const a = numAt(args, 0, h)
    if (isError(a)) return a
    const b = numAt(args, 1, h)
    if (isError(b)) return b
    const r = Math.pow(a, b)
    return Number.isNaN(r) ? err('#NUM!') : r
  },
  LOG: (args, h) => {
    const x = numAt(args, 0, h)
    if (isError(x)) return x
    const base = numAt(args, 1, h, 10)
    if (isError(base)) return base
    if (x <= 0 || base <= 0 || base === 1) return err('#NUM!')
    return Math.log(x) / Math.log(base)
  },
  ATAN2: (args, h) => {
    const x = numAt(args, 0, h)
    if (isError(x)) return x
    const y = numAt(args, 1, h)
    if (isError(y)) return y
    return Math.atan2(y, x) // Excel order: ATAN2(x_num, y_num)
  },
  MOD: (args, h) => {
    const a = numAt(args, 0, h)
    if (isError(a)) return a
    const b = numAt(args, 1, h)
    if (isError(b)) return b
    if (b === 0) return err('#DIV/0!')
    return a - b * Math.floor(a / b)
  },
  ROUND: roundFn((x, f) => Math.round(x * f) / f),
  ROUNDUP: roundFn((x, f) => (x >= 0 ? Math.ceil(x * f) : Math.floor(x * f)) / f),
  ROUNDDOWN: roundFn((x, f) => (x >= 0 ? Math.floor(x * f) : Math.ceil(x * f)) / f),
  TRUNC: roundFn((x, f) => Math.trunc(x * f) / f),
  FLOOR: significanceFn(Math.floor),
  CEILING: significanceFn(Math.ceil),
  GCD: (args, h) => {
    const ns = numbers(args, h)
    if (isError(ns)) return ns
    const ints = ns.map((n) => Math.abs(Math.trunc(n)))
    return ints.reduce((g, n) => gcd2(g, n), 0)
  },

  // aggregates
  SUM: (args, h) => need(numbers(args, h), (ns) => ns.reduce((a, b) => a + b, 0)),
  PRODUCT: (args, h) => need(numbers(args, h), (ns) => ns.reduce((a, b) => a * b, 1)),
  AVERAGE: (args, h) => need(numbers(args, h), (ns) => (ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : err('#DIV/0!'))),
  MIN: (args, h) => need(numbers(args, h), (ns) => (ns.length ? Math.min(...ns) : 0)),
  MAX: (args, h) => need(numbers(args, h), (ns) => (ns.length ? Math.max(...ns) : 0)),
  MEDIAN: (args, h) =>
    need(numbers(args, h), (ns) => {
      if (!ns.length) return err('#NUM!')
      const s = [...ns].sort((a, b) => a - b)
      const mid = Math.floor(s.length / 2)
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
    }),
  STDEV: (args, h) => need(numbers(args, h), (ns) => sampleVariance(ns, true)),
  VAR: (args, h) => need(numbers(args, h), (ns) => sampleVariance(ns, false)),
  COUNT: (args, h) => {
    let c = 0
    for (const x of h.flatten(args)) if (typeof x === 'number') c++
    return c
  },
  COUNTA: (args, h) => {
    let c = 0
    for (const x of h.flatten(args)) if (!isBlank(x)) c++
    return c
  },
  COUNTBLANK: (args, h) => {
    let c = 0
    for (const x of h.flatten(args)) if (isBlank(x)) c++
    return c
  },
  COUNTIF: (args, h) => {
    const m = h.asMatrix(args[0])
    if (isError(m)) return m
    const crit = scalarAt(args, 1, h)
    if (isError(crit)) return crit
    let c = 0
    for (const row of m.data) for (const v of row) if (matchCriteria(v, crit)) c++
    return c
  },
  SUMIF: (args, h) => {
    const range = h.asMatrix(args[0])
    if (isError(range)) return range
    const crit = scalarAt(args, 1, h)
    if (isError(crit)) return crit
    const sumRange = args.length > 2 ? h.asMatrix(args[2]) : range
    if (isError(sumRange)) return sumRange
    let total = 0
    const flatR = range.data.flat()
    const flatS = sumRange.data.flat()
    for (let i = 0; i < flatR.length; i++) {
      if (matchCriteria(flatR[i], crit)) {
        const v = flatS[i] ?? BLANK
        if (typeof v === 'number') total += v
      }
    }
    return total
  },

  // logic (lazy where short-circuit matters)
  IF: (args, h) => {
    const cond = toBool(h.scalarOf(args[0]))
    if (isError(cond)) return cond
    if (cond) return args.length > 1 ? h.eval(args[1]) : true
    return args.length > 2 ? h.eval(args[2]) : false
  },
  IFERROR: (args, h) => {
    const v = h.eval(args[0])
    return isError(v) ? (args.length > 1 ? h.eval(args[1]) : '') : v
  },
  AND: (args, h) => {
    for (const a of args) {
      const b = toBool(h.scalarOf(a))
      if (isError(b)) return b
      if (!b) return false
    }
    return true
  },
  OR: (args, h) => {
    for (const a of args) {
      const b = toBool(h.scalarOf(a))
      if (isError(b)) return b
      if (b) return true
    }
    return false
  },
  XOR: (args, h) => {
    let count = 0
    for (const a of args) {
      const b = toBool(h.scalarOf(a))
      if (isError(b)) return b
      if (b) count++
    }
    return count % 2 === 1
  },
  NOT: (args, h) => {
    const b = toBool(scalarAt(args, 0, h))
    return isError(b) ? b : !b
  },

  // info / type tests
  ISBLANK: (args, h) => isBlank(h.scalarOf(args[0])),
  ISNUMBER: (args, h) => typeof h.scalarOf(args[0]) === 'number',
  ISTEXT: (args, h) => typeof h.scalarOf(args[0]) === 'string',
  ISLOGICAL: (args, h) => typeof h.scalarOf(args[0]) === 'boolean',
  ISERROR: (args, h) => isError(h.eval(args[0]) as RuntimeValue),
  ISNA: (args, h) => {
    const v = h.eval(args[0])
    return isError(v) && v.code === '#N/A'
  },
  ROW: (args, h) => refRowCol(args, h, 'row'),
  COLUMN: (args, h) => refRowCol(args, h, 'col'),

  // text
  LEN: (args, h) => need(textAt(args, 0, h), (s) => s.length),
  UPPER: (args, h) => need(textAt(args, 0, h), (s) => s.toUpperCase()),
  LOWER: (args, h) => need(textAt(args, 0, h), (s) => s.toLowerCase()),
  TRIM: (args, h) => need(textAt(args, 0, h), (s) => s.replace(/\s+/g, ' ').trim()),
  PROPER: (args, h) => need(textAt(args, 0, h), (s) => s.replace(/\b\w/g, (c) => c.toUpperCase())),
  LEFT: (args, h) => textSlice(args, h, 'left'),
  RIGHT: (args, h) => textSlice(args, h, 'right'),
  MID: (args, h) => {
    const s = textAt(args, 0, h)
    if (isError(s)) return s
    const start = numAt(args, 1, h)
    if (isError(start)) return start
    const len = numAt(args, 2, h)
    if (isError(len)) return len
    if (start < 1 || len < 0) return err('#VALUE!')
    return s.substr(start - 1, len)
  },
  REPT: (args, h) => {
    const s = textAt(args, 0, h)
    if (isError(s)) return s
    const n = numAt(args, 1, h)
    if (isError(n)) return n
    if (n < 0) return err('#VALUE!')
    return s.repeat(Math.floor(n))
  },
  CONCAT: concatFn,
  CONCATENATE: concatFn,
  TEXTJOIN: (args, h) => {
    const delim = textAt(args, 0, h)
    if (isError(delim)) return delim
    const ignoreEmpty = toBool(scalarAt(args, 1, h))
    if (isError(ignoreEmpty)) return ignoreEmpty
    const parts: string[] = []
    for (const v of h.flatten(args.slice(2))) {
      if (isError(v)) return v
      if (isBlank(v) && ignoreEmpty) continue
      const t = toText(v)
      if (isError(t)) return t
      if (t === '' && ignoreEmpty) continue
      parts.push(t)
    }
    return parts.join(delim)
  },
  SUBSTITUTE: (args, h) => {
    const s = textAt(args, 0, h)
    if (isError(s)) return s
    const oldT = textAt(args, 1, h)
    if (isError(oldT)) return oldT
    const newT = textAt(args, 2, h)
    if (isError(newT)) return newT
    if (oldT === '') return s
    if (args.length > 3) {
      const which = numAt(args, 3, h)
      if (isError(which)) return which
      let idx = -1
      let from = 0
      for (let k = 0; k < which; k++) {
        idx = s.indexOf(oldT, from)
        if (idx === -1) return s
        from = idx + oldT.length
      }
      return s.slice(0, idx) + newT + s.slice(idx + oldT.length)
    }
    return s.split(oldT).join(newT)
  },
  FIND: (args, h) => findFn(args, h, true),
  SEARCH: (args, h) => findFn(args, h, false),
  EXACT: (args, h) => {
    const a = textAt(args, 0, h)
    if (isError(a)) return a
    const b = textAt(args, 1, h)
    if (isError(b)) return b
    return a === b
  },
  VALUE: (args, h) => need(textAt(args, 0, h), (s) => toNumber(s)),
  CHAR: (args, h) => need(numAt(args, 0, h), (n) => (n >= 1 && n <= 0x10ffff ? String.fromCodePoint(Math.floor(n)) : err('#VALUE!'))),
  CODE: (args, h) => need(textAt(args, 0, h), (s) => (s.length ? s.codePointAt(0)! : err('#VALUE!'))),

  // lookup
  CHOOSE: (args, h) => {
    const idx = numAt(args, 0, h)
    if (isError(idx)) return idx
    const i = Math.floor(idx)
    if (i < 1 || i >= args.length) return err('#VALUE!')
    return h.eval(args[i])
  },
  INDEX: (args, h) => {
    const m = h.asMatrix(args[0])
    if (isError(m)) return m
    const rowNum = numAt(args, 1, h, 1)
    if (isError(rowNum)) return rowNum
    let r = Math.floor(rowNum)
    let c = 1
    if (args.length > 2) {
      const colNum = numAt(args, 2, h)
      if (isError(colNum)) return colNum
      c = Math.floor(colNum)
    } else if (m.rows === 1) {
      c = r
      r = 1
    }
    if (r < 1 || c < 1 || r > m.rows || c > m.cols) return err('#REF!')
    return m.data[r - 1][c - 1]
  },
  MATCH: (args, h) => {
    const key = h.scalarOf(args[0])
    if (isError(key)) return key
    const m = h.asMatrix(args[1])
    if (isError(m)) return m
    const type = args.length > 2 ? numAt(args, 2, h) : 1
    if (isError(type)) return type
    const vec = m.data.flat()
    if (type === 0) {
      for (let i = 0; i < vec.length; i++) if (looseCompare(vec[i], key) === 0) return i + 1
      return err('#N/A')
    }
    // type 1: largest value <= key (ascending); type -1: smallest >= key (descending)
    let best = -1
    for (let i = 0; i < vec.length; i++) {
      const cmp = looseCompare(vec[i], key)
      if (cmp === null) continue
      if (type >= 1 ? cmp <= 0 : cmp >= 0) best = i
      else break
    }
    return best === -1 ? err('#N/A') : best + 1
  },
  VLOOKUP: (args, h) => lookupFn(args, h, 'v'),
  HLOOKUP: (args, h) => lookupFn(args, h, 'h'),

  // inline chart
  SPARKLINE: (args, h) => {
    // Only the first argument carries data; a trailing arg picks the chart style.
    const ns = numbers(args.length ? [args[0]] : [], h)
    if (isError(ns)) return ns
    let mode: 'bar' | 'line' = 'bar'
    if (args.length > 1) {
      const t = textAt(args, 1, h)
      if (!isError(t) && t.toLowerCase() === 'line') mode = 'line'
    }
    const spark: SparklineValue = { kind: 'sparkline', mode, data: ns }
    return spark
  },

  // ---- dates & time ----
  TODAY: () => todaySerial(),
  NOW: () => nowSerial(),
  DATE: (args, h) => {
    const y = numAt(args, 0, h)
    if (isError(y)) return y
    const m = numAt(args, 1, h)
    if (isError(m)) return m
    const d = numAt(args, 2, h)
    if (isError(d)) return d
    return dateToSerial(Math.trunc(y), Math.trunc(m), Math.trunc(d))
  },
  TIME: (args, h) => {
    const hh = numAt(args, 0, h)
    if (isError(hh)) return hh
    const mm = numAt(args, 1, h)
    if (isError(mm)) return mm
    const ss = numAt(args, 2, h, 0)
    if (isError(ss)) return ss
    const frac = timeToFraction(hh, mm, ss)
    return frac - Math.floor(frac)
  },
  YEAR: datePart((d) => d.year),
  MONTH: datePart((d) => d.month),
  DAY: datePart((d) => d.day),
  WEEKDAY: (args, h) => {
    const s = numAt(args, 0, h)
    if (isError(s)) return s
    const type = numAt(args, 1, h, 1)
    if (isError(type)) return type
    const dow = serialToDate(s).weekday // 0=Sun..6=Sat
    if (type === 2) return dow === 0 ? 7 : dow // Mon=1..Sun=7
    if (type === 3) return dow === 0 ? 6 : dow - 1 // Mon=0..Sun=6
    return dow + 1 // Sun=1..Sat=7
  },
  HOUR: timePart((t) => t.hour),
  MINUTE: timePart((t) => t.minute),
  SECOND: timePart((t) => t.second),
  EDATE: (args, h) => {
    const s = numAt(args, 0, h)
    if (isError(s)) return s
    const m = numAt(args, 1, h)
    if (isError(m)) return m
    return addMonths(s, Math.trunc(m))
  },
  EOMONTH: (args, h) => {
    const s = numAt(args, 0, h)
    if (isError(s)) return s
    const m = numAt(args, 1, h)
    if (isError(m)) return m
    return endOfMonth(s, Math.trunc(m))
  },
  DAYS: (args, h) => {
    const end = numAt(args, 0, h)
    if (isError(end)) return end
    const start = numAt(args, 1, h)
    if (isError(start)) return start
    return Math.trunc(end) - Math.trunc(start)
  },
  DATEVALUE: (args, h) => {
    const s = textAt(args, 0, h)
    if (isError(s)) return s
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.trim()) || /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim())
    if (!m) return err('#VALUE!')
    return m[1].length === 4 ? dateToSerial(+m[1], +m[2], +m[3]) : dateToSerial(+m[3], +m[1], +m[2])
  },
  DATEDIF: (args, h) => {
    const start = numAt(args, 0, h)
    if (isError(start)) return start
    const end = numAt(args, 1, h)
    if (isError(end)) return end
    const unit = textAt(args, 2, h)
    if (isError(unit)) return unit
    return dateDif(Math.trunc(start), Math.trunc(end), unit.toUpperCase())
  },

  // ---- conditional aggregates ----
  AVERAGEIF: (args, h) => {
    const range = h.asMatrix(args[0])
    if (isError(range)) return range
    const crit = scalarAt(args, 1, h)
    if (isError(crit)) return crit
    const avgRange = args.length > 2 ? h.asMatrix(args[2]) : range
    if (isError(avgRange)) return avgRange
    const flatR = range.data.flat()
    const flatA = avgRange.data.flat()
    let total = 0
    let count = 0
    for (let i = 0; i < flatR.length; i++) {
      if (matchCriteria(flatR[i], crit)) {
        const v = flatA[i] ?? BLANK
        if (typeof v === 'number') {
          total += v
          count++
        }
      }
    }
    return count ? total / count : err('#DIV/0!')
  },
  SUMIFS: (args, h) => ifsReduce(args, h, 'sum'),
  COUNTIFS: (args, h) => ifsCount(args, h),
  AVERAGEIFS: (args, h) => ifsReduce(args, h, 'avg'),
  MAXIFS: (args, h) => ifsReduce(args, h, 'max'),
  MINIFS: (args, h) => ifsReduce(args, h, 'min'),

  // ---- lookup ----
  XLOOKUP: (args, h) => {
    const key = h.scalarOf(args[0])
    if (isError(key)) return key
    const lookup = h.asMatrix(args[1])
    if (isError(lookup)) return lookup
    const ret = h.asMatrix(args[2])
    if (isError(ret)) return ret
    const lvec = lookup.data.flat()
    const rvec = ret.data.flat()
    for (let i = 0; i < lvec.length; i++) if (looseCompare(lvec[i], key) === 0) return rvec[i] ?? err('#N/A')
    return args.length > 3 ? h.scalarOf(args[3]) : err('#N/A') // optional if-not-found
  },
  SUMPRODUCT: (args, h) => {
    const mats = args.map((a) => h.asMatrix(a))
    for (const m of mats) if (isError(m)) return m
    const flats = (mats as MatrixValue[]).map((m) => m.data.flat())
    const len = flats[0]?.length ?? 0
    for (const f of flats) if (f.length !== len) return err('#VALUE!')
    let total = 0
    for (let i = 0; i < len; i++) {
      let prod = 1
      for (const f of flats) {
        const v = f[i]
        prod *= typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : 0
      }
      total += prod
    }
    return total
  },

  // ---- more stats ----
  VARP: (args, h) => need(numbers(args, h), (ns) => populationVariance(ns, false)),
  STDEVP: (args, h) => need(numbers(args, h), (ns) => populationVariance(ns, true)),
  GEOMEAN: (args, h) =>
    need(numbers(args, h), (ns) => {
      if (!ns.length) return err('#NUM!')
      let prod = 1
      for (const n of ns) {
        if (n <= 0) return err('#NUM!')
        prod *= n
      }
      return Math.pow(prod, 1 / ns.length)
    }),
  MODE: (args, h) =>
    need(numbers(args, h), (ns) => {
      const counts = new Map<number, number>()
      let best: number | null = null
      let bestC = 1
      for (const n of ns) {
        const c = (counts.get(n) ?? 0) + 1
        counts.set(n, c)
        if (c > bestC) {
          bestC = c
          best = n
        }
      }
      return best === null ? err('#N/A') : best
    }),
  LARGE: (args, h) => nthOrder(args, h, 'large'),
  SMALL: (args, h) => nthOrder(args, h, 'small'),
  RANK: (args, h) => {
    const x = numAt(args, 0, h)
    if (isError(x)) return x
    const ns = numbers([args[1]], h)
    if (isError(ns)) return ns
    const order = args.length > 2 ? numAt(args, 2, h) : 0
    if (isError(order)) return order
    const sorted = [...ns].sort((a, b) => (order ? a - b : b - a))
    const idx = sorted.indexOf(x)
    return idx === -1 ? err('#N/A') : idx + 1
  },
  PERCENTILE: (args, h) => {
    const ns = numbers([args[0]], h)
    if (isError(ns)) return ns
    const p = numAt(args, 1, h)
    if (isError(p)) return p
    return percentile(ns, p)
  },
  QUARTILE: (args, h) => {
    const ns = numbers([args[0]], h)
    if (isError(ns)) return ns
    const q = numAt(args, 1, h)
    if (isError(q)) return q
    if (q < 0 || q > 4) return err('#NUM!')
    return percentile(ns, q / 4)
  },

  // ---- more math ----
  MROUND: (args, h) => {
    const x = numAt(args, 0, h)
    if (isError(x)) return x
    const m = numAt(args, 1, h)
    if (isError(m)) return m
    if (m === 0) return 0
    return Math.round(x / m) * m
  },
  EVEN: unaryMath((x) => (x >= 0 ? Math.ceil(x / 2) * 2 : Math.floor(x / 2) * 2)),
  ODD: unaryMath((x) => {
    const r = x >= 0 ? Math.ceil(x) : Math.floor(x)
    return r % 2 === 0 ? r + Math.sign(x || 1) : r
  }),
  FACT: (args, h) => need(numAt(args, 0, h), (n) => factorial(Math.trunc(n))),
  COMBIN: (args, h) => {
    const n = numAt(args, 0, h)
    if (isError(n)) return n
    const k = numAt(args, 1, h)
    if (isError(k)) return k
    return combinations(Math.trunc(n), Math.trunc(k))
  },
  PERMUT: (args, h) => {
    const n = numAt(args, 0, h)
    if (isError(n)) return n
    const k = numAt(args, 1, h)
    if (isError(k)) return k
    const c = combinations(Math.trunc(n), Math.trunc(k))
    if (isError(c)) return c
    const f = factorial(Math.trunc(k))
    return isError(f) ? f : c * f
  },
  SUMSQ: (args, h) => need(numbers(args, h), (ns) => ns.reduce((a, b) => a + b * b, 0)),
  'CEILING.MATH': (args, h) => {
    const x = numAt(args, 0, h)
    if (isError(x)) return x
    const sig = numAt(args, 1, h, 1)
    if (isError(sig)) return sig
    if (sig === 0) return 0
    return Math.ceil(x / Math.abs(sig)) * Math.abs(sig)
  },

  // ---- logic / utility ----
  IFS: (args, h) => {
    for (let i = 0; i + 1 < args.length; i += 2) {
      const cond = toBool(h.scalarOf(args[i]))
      if (isError(cond)) return cond
      if (cond) return h.eval(args[i + 1])
    }
    return err('#N/A')
  },
  SWITCH: (args, h) => {
    const subject = h.scalarOf(args[0])
    if (isError(subject)) return subject
    let i = 1
    for (; i + 1 < args.length; i += 2) {
      const c = h.scalarOf(args[i])
      if (isError(c)) return c
      if (looseCompare(subject, c) === 0) return h.eval(args[i + 1])
    }
    return i < args.length ? h.eval(args[i]) : err('#N/A') // trailing default
  },
  IFNA: (args, h) => {
    const v = h.eval(args[0])
    return isError(v) && v.code === '#N/A' ? (args.length > 1 ? h.eval(args[1]) : '') : v
  },

  // ---- text / regex ----
  TEXT: (args, h) => {
    const v = scalarAt(args, 0, h)
    if (isError(v)) return v
    const pattern = textAt(args, 1, h)
    if (isError(pattern)) return pattern
    return textFormat(v, pattern)
  },
  NUMBERVALUE: (args, h) => {
    const s = textAt(args, 0, h)
    if (isError(s)) return s
    const cleaned = s.replace(/[\s,]/g, '')
    const n = Number(cleaned)
    return Number.isNaN(n) ? err('#VALUE!') : n
  },
  SPLIT: (args, h) => {
    const s = textAt(args, 0, h)
    if (isError(s)) return s
    const delim = textAt(args, 1, h, ' ')
    if (isError(delim)) return delim
    const parts = delim === '' ? [...s] : s.split(delim).filter((p) => p !== '')
    return matrix([parts.length ? parts : ['']])
  },
  REGEXMATCH: (args, h) => regexOp(args, h, 'match'),
  REGEXEXTRACT: (args, h) => regexOp(args, h, 'extract'),
  REGEXREPLACE: (args, h) => regexOp(args, h, 'replace'),
  UNICHAR: (args, h) => need(numAt(args, 0, h), (n) => (n >= 1 && n <= 0x10ffff ? String.fromCodePoint(Math.floor(n)) : err('#VALUE!'))),
  UNICODE: (args, h) => need(textAt(args, 0, h), (s) => (s.length ? s.codePointAt(0)! : err('#VALUE!'))),

  // ---- dynamic arrays (v3): these return matrices, which the workbook *spills* ----
  SEQUENCE: (args, h) => {
    const rows = numAt(args, 0, h, 1)
    if (isError(rows)) return rows
    const cols = numAt(args, 1, h, 1)
    if (isError(cols)) return cols
    const start = numAt(args, 2, h, 1)
    if (isError(start)) return start
    const step = numAt(args, 3, h, 1)
    if (isError(step)) return step
    const R = Math.trunc(rows)
    const C = Math.trunc(cols)
    if (R < 1 || C < 1) return err('#VALUE!')
    if (R * C > MAX_ARRAY) return err('#NUM!', 'array too large')
    const data: Scalar[][] = []
    let k = 0
    for (let r = 0; r < R; r++) {
      const row: Scalar[] = []
      for (let c = 0; c < C; c++) row.push(start + k++ * step)
      data.push(row)
    }
    return matrix(data)
  },
  TRANSPOSE: (args, h) => {
    const m = h.asMatrix(args[0])
    if (isError(m)) return m
    return matrix(transpose(m.data))
  },
  ROWS: (args, h) => {
    const m = h.asMatrix(args[0])
    return isError(m) ? m : m.rows
  },
  COLUMNS: (args, h) => {
    const m = h.asMatrix(args[0])
    return isError(m) ? m : m.cols
  },
  UNIQUE: (args, h) => {
    const m = h.asMatrix(args[0])
    if (isError(m)) return m
    const byCol = args.length > 1 && truthy(toBool(h.scalarOf(args[1])))
    const exactlyOnce = args.length > 2 && truthy(toBool(h.scalarOf(args[2])))
    const lines = byCol ? transpose(m.data) : m.data
    const counts = new Map<string, number>()
    for (const line of lines) {
      const k = lineKey(line)
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    const seen = new Set<string>()
    const kept: Scalar[][] = []
    for (const line of lines) {
      const k = lineKey(line)
      if (seen.has(k)) continue
      seen.add(k)
      if (exactlyOnce && counts.get(k) !== 1) continue
      kept.push(line)
    }
    if (!kept.length) return err('#CALC!', 'UNIQUE found nothing')
    return matrix(byCol ? transpose(kept) : kept)
  },
  SORT: (args, h) => {
    const m = h.asMatrix(args[0])
    if (isError(m)) return m
    const idx = numAt(args, 1, h, 1)
    if (isError(idx)) return idx
    const order = numAt(args, 2, h, 1)
    if (isError(order)) return order
    const byCol = args.length > 3 && truthy(toBool(h.scalarOf(args[3])))
    const lines = byCol ? transpose(m.data) : m.data
    const i = Math.trunc(idx) - 1
    if (i < 0 || i >= (lines[0]?.length ?? 0)) return err('#VALUE!', 'SORT index out of range')
    const dir = order < 0 ? -1 : 1
    const sorted = stableSort(lines, (a, b) => {
      const c = looseCompare(a[i] ?? BLANK, b[i] ?? BLANK)
      return (c === null ? 0 : c) * dir
    })
    return matrix(byCol ? transpose(sorted) : sorted)
  },
  SORTBY: (args, h) => {
    const m = h.asMatrix(args[0])
    if (isError(m)) return m
    // SORTBY(array, by_array, [order]) — sort the rows of `array` by `by_array`.
    const by = h.asMatrix(args[1])
    if (isError(by)) return by
    const order = numAt(args, 2, h, 1)
    if (isError(order)) return order
    const keys = by.data.flat()
    if (keys.length !== m.data.length) return err('#VALUE!', 'SORTBY sizes differ')
    const dir = order < 0 ? -1 : 1
    const rows = m.data.map((row, r) => ({ row, key: keys[r] ?? BLANK }))
    const sorted = stableSort(rows, (a, b) => {
      const c = looseCompare(a.key, b.key)
      return (c === null ? 0 : c) * dir
    })
    return matrix(sorted.map((x) => x.row))
  },
  FILTER: (args, h) => {
    const m = h.asMatrix(args[0])
    if (isError(m)) return m
    const inc = h.asMatrix(args[1])
    if (isError(inc)) return inc
    const flags = inc.data.flat()
    if (flags.length === m.data.length) {
      const kept = m.data.filter((_, r) => truthy(toBool(flags[r] ?? BLANK)))
      if (!kept.length) return args.length > 2 ? h.eval(args[2]) : err('#CALC!', 'FILTER kept nothing')
      return matrix(kept)
    }
    if (flags.length === (m.data[0]?.length ?? 0)) {
      const T = transpose(m.data)
      const kept = T.filter((_, c) => truthy(toBool(flags[c] ?? BLANK)))
      if (!kept.length) return args.length > 2 ? h.eval(args[2]) : err('#CALC!', 'FILTER kept nothing')
      return matrix(transpose(kept))
    }
    return err('#VALUE!', 'FILTER condition size mismatch')
  },
  RANDARRAY: (args, h) => {
    const rows = numAt(args, 0, h, 1)
    if (isError(rows)) return rows
    const cols = numAt(args, 1, h, 1)
    if (isError(cols)) return cols
    const lo = numAt(args, 2, h, 0)
    if (isError(lo)) return lo
    const hi = numAt(args, 3, h, 1)
    if (isError(hi)) return hi
    const whole = args.length > 4 && truthy(toBool(h.scalarOf(args[4])))
    const R = Math.trunc(rows)
    const C = Math.trunc(cols)
    if (R < 1 || C < 1) return err('#VALUE!')
    if (R * C > MAX_ARRAY) return err('#NUM!', 'array too large')
    const data: Scalar[][] = []
    for (let r = 0; r < R; r++) {
      const row: Scalar[] = []
      for (let c = 0; c < C; c++) {
        const x = lo + Math.random() * (hi - lo)
        row.push(whole ? Math.floor(x) : x)
      }
      data.push(row)
    }
    return matrix(data)
  },
  HSTACK: (args, h) => stack(args, h, 'h'),
  VSTACK: (args, h) => stack(args, h, 'v'),
  TOCOL: (args, h) => toVector(args, h, 'col'),
  TOROW: (args, h) => toVector(args, h, 'row'),
  TAKE: (args, h) => takeDrop(args, h, 'take'),
  DROP: (args, h) => takeDrop(args, h, 'drop'),
  EXPAND: (args, h) => {
    const m = h.asMatrix(args[0])
    if (isError(m)) return m
    const rows = numAt(args, 1, h, m.rows)
    if (isError(rows)) return rows
    const cols = numAt(args, 2, h, m.cols)
    if (isError(cols)) return cols
    const pad: Scalar = args.length > 3 ? h.scalarOf(args[3]) : err('#N/A')
    const R = Math.trunc(rows)
    const C = Math.trunc(cols)
    if (R < m.rows || C < m.cols) return err('#VALUE!', 'EXPAND cannot shrink')
    if (R * C > MAX_ARRAY) return err('#NUM!')
    const data: Scalar[][] = []
    for (let r = 0; r < R; r++) {
      const row: Scalar[] = []
      for (let c = 0; c < C; c++) row.push(r < m.rows && c < m.cols ? m.data[r][c] : pad)
      data.push(row)
    }
    return matrix(data)
  },
  CHOOSEROWS: (args, h) => chooseLines(args, h, 'row'),
  CHOOSECOLS: (args, h) => chooseLines(args, h, 'col'),
  FREQUENCY: (args, h) => {
    const data = numbers([args[0]], h)
    if (isError(data)) return data
    const bins = numbers([args[1]], h)
    if (isError(bins)) return bins
    const sortedBins = [...bins].sort((a, b) => a - b)
    const counts = new Array(sortedBins.length + 1).fill(0)
    for (const x of data) {
      let placed = false
      for (let i = 0; i < sortedBins.length; i++) {
        if (x <= sortedBins[i]) {
          counts[i]++
          placed = true
          break
        }
      }
      if (!placed) counts[counts.length - 1]++
    }
    return matrix(counts.map((c) => [c]))
  },

  // ---- LAMBDA & higher-order functions (v3): a real functional layer ----
  LAMBDA: (args, h) => {
    if (args.length < 1) return err('#VALUE!', 'LAMBDA needs a body')
    const params: string[] = []
    for (let i = 0; i < args.length - 1; i++) {
      const p = args[i]
      if (p.type !== 'name') return err('#VALUE!', 'LAMBDA parameters must be plain names')
      params.push(p.name.toUpperCase())
    }
    const closure = new Map<string, RuntimeValue>(h.ctx.locals ?? [])
    const lam: LambdaValue = { kind: 'lambda', params, body: args[args.length - 1], closure }
    return lam
  },
  LET: (args, h) => {
    const n = args.length
    if (n < 3 || n % 2 === 0) return err('#VALUE!', 'LET needs name/value pairs and a final expression')
    const extra = new Map<string, RuntimeValue>()
    for (let i = 0; i + 2 <= n - 1; i += 2) {
      const nameNode = args[i]
      if (nameNode.type !== 'name') return err('#VALUE!', 'LET names must be identifiers')
      const value = h.evalWith(args[i + 1], extra)
      extra.set(nameNode.name.toUpperCase(), value)
    }
    return h.evalWith(args[n - 1], extra)
  },
  MAP: (args, h) => {
    if (args.length < 2) return err('#VALUE!', 'MAP needs an array and a lambda')
    const fn = h.asLambda(args[args.length - 1])
    if (isError(fn)) return fn
    const mats: MatrixValue[] = []
    for (let i = 0; i < args.length - 1; i++) {
      const m = h.asMatrix(args[i])
      if (isError(m)) return m
      mats.push(m)
    }
    const rows = mats[0].rows
    const cols = mats[0].cols
    for (const m of mats) if (m.rows !== rows || m.cols !== cols) return err('#VALUE!', 'MAP arrays differ in shape')
    const data: Scalar[][] = []
    for (let r = 0; r < rows; r++) {
      const row: Scalar[] = []
      for (let c = 0; c < cols; c++) {
        const out = h.applyLambda(fn, mats.map((m) => m.data[r][c]))
        row.push(asScalar(out))
      }
      data.push(row)
    }
    return matrix(data)
  },
  REDUCE: (args, h) => {
    if (args.length !== 3) return err('#VALUE!', 'REDUCE(init, array, lambda)')
    let acc: RuntimeValue = h.eval(args[0])
    const m = h.asMatrix(args[1])
    if (isError(m)) return m
    const fn = h.asLambda(args[2])
    if (isError(fn)) return fn
    for (const row of m.data)
      for (const v of row) {
        acc = h.applyLambda(fn, [acc, v])
        if (isError(acc)) return acc
      }
    return asScalar(acc)
  },
  SCAN: (args, h) => {
    if (args.length !== 3) return err('#VALUE!', 'SCAN(init, array, lambda)')
    let acc: RuntimeValue = h.eval(args[0])
    const m = h.asMatrix(args[1])
    if (isError(m)) return m
    const fn = h.asLambda(args[2])
    if (isError(fn)) return fn
    const data: Scalar[][] = []
    for (const row of m.data) {
      const outRow: Scalar[] = []
      for (const v of row) {
        acc = h.applyLambda(fn, [acc, v])
        if (isError(acc)) return acc
        outRow.push(asScalar(acc))
      }
      data.push(outRow)
    }
    return matrix(data)
  },
  BYROW: (args, h) => byLine(args, h, 'row'),
  BYCOL: (args, h) => byLine(args, h, 'col'),
  MAKEARRAY: (args, h) => {
    const rows = numAt(args, 0, h)
    if (isError(rows)) return rows
    const cols = numAt(args, 1, h)
    if (isError(cols)) return cols
    const fn = h.asLambda(args[2])
    if (isError(fn)) return fn
    const R = Math.trunc(rows)
    const C = Math.trunc(cols)
    if (R < 1 || C < 1) return err('#VALUE!')
    if (R * C > MAX_ARRAY) return err('#NUM!', 'array too large')
    const data: Scalar[][] = []
    for (let r = 0; r < R; r++) {
      const row: Scalar[] = []
      for (let c = 0; c < C; c++) row.push(asScalar(h.applyLambda(fn, [r + 1, c + 1])))
      data.push(row)
    }
    return matrix(data)
  },
}

/** A hard ceiling on how big a generated array can be, to keep the UI responsive. */
const MAX_ARRAY = 200_000

// ---- dynamic-array helpers --------------------------------------------------

/** Strict truthiness for array conditions — an error or non-boolean is *not* kept. */
function truthy(b: boolean | ErrorValue): boolean {
  return b === true
}

const numRange = (a: number, b: number): number[] => {
  const out: number[] = []
  for (let i = a; i < b; i++) out.push(i)
  return out
}

/** A canonical key for a row/column, so UNIQUE can dedupe (text compares case-insensitively). */
function lineKey(line: Scalar[]): string {
  return line.map(scalarKey).join('␟')
}
function scalarKey(v: Scalar): string {
  if (typeof v === 'number') return 'n:' + v
  if (typeof v === 'string') return 's:' + v.toLowerCase()
  if (typeof v === 'boolean') return 'b:' + v
  if (isBlank(v)) return 'x'
  if (isError(v)) return 'e:' + v.code
  return '?'
}

/** A guaranteed-stable sort (ties keep their original order) regardless of engine. */
function stableSort<T>(arr: T[], cmp: (a: T, b: T) => number): T[] {
  return arr
    .map((v, i) => [v, i] as const)
    .sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1])
    .map((x) => x[0])
}

function stack(args: Node[], h: FnHelpers, dir: 'h' | 'v'): RuntimeValue {
  const mats: MatrixValue[] = []
  for (const a of args) {
    const m = h.asMatrix(a)
    if (isError(m)) return m
    mats.push(m)
  }
  if (!mats.length) return err('#VALUE!')
  if (dir === 'h') {
    const rows = Math.max(...mats.map((m) => m.rows))
    const out: Scalar[][] = []
    for (let r = 0; r < rows; r++) {
      const row: Scalar[] = []
      for (const m of mats) for (let c = 0; c < m.cols; c++) row.push(r < m.rows ? m.data[r][c] : err('#N/A'))
      out.push(row)
    }
    return matrix(out)
  }
  const cols = Math.max(...mats.map((m) => m.cols))
  const out: Scalar[][] = []
  for (const m of mats)
    for (let r = 0; r < m.rows; r++) {
      const row: Scalar[] = []
      for (let c = 0; c < cols; c++) row.push(c < m.cols ? m.data[r][c] : err('#N/A'))
      out.push(row)
    }
  return matrix(out)
}

function toVector(args: Node[], h: FnHelpers, dir: 'col' | 'row'): RuntimeValue {
  const m = h.asMatrix(args[0])
  if (isError(m)) return m
  const ignore = numAt(args, 1, h, 0)
  if (isError(ignore)) return ignore
  const byCol = args.length > 2 && truthy(toBool(h.scalarOf(args[2])))
  const ig = Math.trunc(ignore)
  const flat: Scalar[] = []
  const push = (v: Scalar) => {
    if ((ig === 1 || ig === 3) && isBlank(v)) return
    if ((ig === 2 || ig === 3) && isError(v)) return
    flat.push(v)
  }
  if (byCol) for (let c = 0; c < m.cols; c++) for (let r = 0; r < m.rows; r++) push(m.data[r][c])
  else for (let r = 0; r < m.rows; r++) for (let c = 0; c < m.cols; c++) push(m.data[r][c])
  if (!flat.length) return err('#CALC!')
  return dir === 'col' ? matrix(flat.map((v) => [v])) : matrix([flat])
}

/** Indices to keep for a TAKE/DROP of `count` along an axis of length `len`. */
function pickEdge(count: number | null, len: number, kind: 'take' | 'drop'): number[] {
  if (count === null) return numRange(0, len)
  const k = Math.trunc(count)
  if (kind === 'take') return k >= 0 ? numRange(0, Math.min(k, len)) : numRange(Math.max(0, len + k), len)
  return k >= 0 ? numRange(Math.min(k, len), len) : numRange(0, Math.max(0, len + k))
}

function takeDrop(args: Node[], h: FnHelpers, kind: 'take' | 'drop'): RuntimeValue {
  const m = h.asMatrix(args[0])
  if (isError(m)) return m
  let rCount: number | null = null
  if (args.length > 1) {
    const v = numAt(args, 1, h)
    if (isError(v)) return v
    rCount = v
  }
  let cCount: number | null = null
  if (args.length > 2) {
    const v = numAt(args, 2, h)
    if (isError(v)) return v
    cCount = v
  }
  const rowIdx = pickEdge(rCount, m.rows, kind)
  const colIdx = pickEdge(cCount, m.cols, kind)
  if (!rowIdx.length || !colIdx.length) return err('#CALC!')
  return matrix(rowIdx.map((r) => colIdx.map((c) => m.data[r][c])))
}

function chooseLines(args: Node[], h: FnHelpers, dir: 'row' | 'col'): RuntimeValue {
  const m = h.asMatrix(args[0])
  if (isError(m)) return m
  const lines = dir === 'row' ? m.data : transpose(m.data)
  const picked: Scalar[][] = []
  for (let i = 1; i < args.length; i++) {
    const idx = numAt(args, i, h)
    if (isError(idx)) return idx
    let k = Math.trunc(idx)
    if (k < 0) k = lines.length + k + 1
    if (k < 1 || k > lines.length) return err('#VALUE!', 'index out of range')
    picked.push(lines[k - 1])
  }
  if (!picked.length) return err('#VALUE!')
  return matrix(dir === 'row' ? picked : transpose(picked))
}

function byLine(args: Node[], h: FnHelpers, dir: 'row' | 'col'): RuntimeValue {
  const m = h.asMatrix(args[0])
  if (isError(m)) return m
  const fn = h.asLambda(args[1])
  if (isError(fn)) return fn
  if (dir === 'row') return matrix(m.data.map((row) => [asScalar(h.applyLambda(fn, [matrix([row])]))]))
  const T = transpose(m.data)
  return matrix([T.map((col) => asScalar(h.applyLambda(fn, [matrix(col.map((v) => [v]))])))])
}

// ---- shared implementations -------------------------------------------------

function need<T extends RuntimeValue>(
  v: number[] | ErrorValue,
  f: (xs: number[]) => T | ErrorValue,
): RuntimeValue
function need<T extends RuntimeValue>(v: string | ErrorValue, f: (s: string) => T | ErrorValue): RuntimeValue
function need<T extends RuntimeValue>(v: number | ErrorValue, f: (n: number) => T | ErrorValue): RuntimeValue
function need(v: unknown, f: (x: never) => RuntimeValue): RuntimeValue {
  if (isError(v as RuntimeValue)) return v as ErrorValue
  return f(v as never)
}

function roundFn(apply: (x: number, factor: number) => number): FnImpl {
  return (args, h) => {
    const x = numAt(args, 0, h)
    if (isError(x)) return x
    const d = numAt(args, 1, h, 0)
    if (isError(d)) return d
    const factor = Math.pow(10, Math.floor(d))
    return apply(x, factor)
  }
}

function significanceFn(round: (x: number) => number): FnImpl {
  return (args, h) => {
    const x = numAt(args, 0, h)
    if (isError(x)) return x
    const sig = numAt(args, 1, h, 1)
    if (isError(sig)) return sig
    if (sig === 0) return 0
    return round(x / sig) * sig
  }
}

function concatFn(args: Node[], h: FnHelpers): RuntimeValue {
  let out = ''
  for (const v of h.flatten(args)) {
    if (isError(v)) return v
    const t = toText(v)
    if (isError(t)) return t
    out += t
  }
  return out
}

function textSlice(args: Node[], h: FnHelpers, side: 'left' | 'right'): RuntimeValue {
  const s = textAt(args, 0, h)
  if (isError(s)) return s
  const n = numAt(args, 1, h, 1)
  if (isError(n)) return n
  if (n < 0) return err('#VALUE!')
  const k = Math.floor(n)
  return side === 'left' ? s.slice(0, k) : s.slice(s.length - k)
}

function findFn(args: Node[], h: FnHelpers, caseSensitive: boolean): RuntimeValue {
  const sub = textAt(args, 0, h)
  if (isError(sub)) return sub
  const s = textAt(args, 1, h)
  if (isError(s)) return s
  const start = numAt(args, 2, h, 1)
  if (isError(start)) return start
  const hay = caseSensitive ? s : s.toLowerCase()
  const needle = caseSensitive ? sub : sub.toLowerCase()
  const idx = hay.indexOf(needle, Math.max(0, Math.floor(start) - 1))
  return idx === -1 ? err('#VALUE!') : idx + 1
}

function lookupFn(args: Node[], h: FnHelpers, kind: 'v' | 'h'): RuntimeValue {
  const key = h.scalarOf(args[0])
  if (isError(key)) return key
  const table = h.asMatrix(args[1])
  if (isError(table)) return table
  const index = numAt(args, 2, h)
  if (isError(index)) return index
  const approx = args.length > 3 ? toBool(h.scalarOf(args[3])) : true
  if (isError(approx)) return approx

  const i = Math.floor(index)
  const lines = kind === 'v' ? table.data : transpose(table.data)
  const lookupVec = lines.map((line) => line[0])

  let hit = -1
  if (approx) {
    for (let r = 0; r < lookupVec.length; r++) {
      const cmp = looseCompare(lookupVec[r], key)
      if (cmp === null) continue
      if (cmp <= 0) hit = r
      else break
    }
  } else {
    for (let r = 0; r < lookupVec.length; r++) {
      if (looseCompare(lookupVec[r], key) === 0) {
        hit = r
        break
      }
    }
  }
  if (hit === -1) return err('#N/A')
  const line = lines[hit]
  if (i < 1 || i > line.length) return err('#REF!')
  return line[i - 1]
}

function refRowCol(args: Node[], h: FnHelpers, which: 'row' | 'col'): RuntimeValue {
  if (args.length === 0) {
    const cur = h.ctx.current
    if (!cur) return err('#REF!')
    return (which === 'row' ? cur.row : cur.col) + 1
  }
  const node = args[0]
  if (node.type === 'ref') return (which === 'row' ? node.ref.row : node.ref.col) + 1
  if (node.type === 'range') return (which === 'row' ? node.from.row : node.from.col) + 1
  return err('#REF!')
}

function transpose(m: Scalar[][]): Scalar[][] {
  if (!m.length) return []
  const rows = m.length
  const cols = m[0].length
  const out: Scalar[][] = []
  for (let c = 0; c < cols; c++) {
    const line: Scalar[] = []
    for (let r = 0; r < rows; r++) line.push(m[r][c])
    out.push(line)
  }
  return out
}

function gcd2(a: number, b: number): number {
  while (b) {
    ;[a, b] = [b, a % b]
  }
  return a
}

function sampleVariance(ns: number[], sqrtIt: boolean): number | ErrorValue {
  if (ns.length < 2) return err('#DIV/0!')
  const mean = ns.reduce((a, b) => a + b, 0) / ns.length
  const v = ns.reduce((a, b) => a + (b - mean) ** 2, 0) / (ns.length - 1)
  return sqrtIt ? Math.sqrt(v) : v
}

function populationVariance(ns: number[], sqrtIt: boolean): number | ErrorValue {
  if (ns.length < 1) return err('#DIV/0!')
  const mean = ns.reduce((a, b) => a + b, 0) / ns.length
  const v = ns.reduce((a, b) => a + (b - mean) ** 2, 0) / ns.length
  return sqrtIt ? Math.sqrt(v) : v
}

// ---- dates ------------------------------------------------------------------

function datePart(get: (d: ReturnType<typeof serialToDate>) => number): FnImpl {
  return (args, h) => need(numAt(args, 0, h), (n) => get(serialToDate(n)))
}
function timePart(get: (t: ReturnType<typeof serialToTime>) => number): FnImpl {
  return (args, h) => need(numAt(args, 0, h), (n) => get(serialToTime(n)))
}

function dateDif(start: number, end: number, unit: string): number | ErrorValue {
  if (end < start) return err('#NUM!')
  const a = serialToDate(start)
  const b = serialToDate(end)
  switch (unit) {
    case 'D':
      return end - start
    case 'M':
      return (b.year - a.year) * 12 + (b.month - a.month) - (b.day < a.day ? 1 : 0)
    case 'Y': {
      let years = b.year - a.year
      if (b.month < a.month || (b.month === a.month && b.day < a.day)) years--
      return years
    }
    case 'MD': {
      // Days, ignoring months and years; borrow from the month before `end` if needed.
      if (b.day >= a.day) return b.day - a.day
      const daysInPrevMonth = new Date(Date.UTC(b.year, b.month - 1, 0)).getUTCDate()
      return daysInPrevMonth - a.day + b.day
    }
    case 'YM':
      return ((b.month - a.month - (b.day < a.day ? 1 : 0)) % 12 + 12) % 12
    case 'YD': {
      // Days, ignoring years: move the start to end's year (or the year before if
      // that anniversary falls after `end`), then count the gap.
      let anniv = dateToSerial(b.year, a.month, a.day)
      if (anniv > end) anniv = dateToSerial(b.year - 1, a.month, a.day)
      return end - anniv
    }
    default:
      return err('#NUM!')
  }
}

// ---- conditional aggregates -------------------------------------------------

/** Indices into the first criteria range that satisfy *every* (range, criterion) pair. */
function matchingIndices(pairsStart: number, args: Node[], h: FnHelpers): number[] | ErrorValue {
  const ranges: Scalar[][] = []
  const crits: Scalar[] = []
  for (let i = pairsStart; i + 1 < args.length; i += 2) {
    const m = h.asMatrix(args[i])
    if (isError(m)) return m
    ranges.push(m.data.flat())
    const c = h.scalarOf(args[i + 1])
    if (isError(c)) return c
    crits.push(c)
  }
  if (!ranges.length) return []
  const len = ranges[0].length
  const out: number[] = []
  for (let i = 0; i < len; i++) {
    let ok = true
    for (let p = 0; p < ranges.length; p++) {
      if (!matchCriteria(ranges[p][i] ?? BLANK, crits[p])) {
        ok = false
        break
      }
    }
    if (ok) out.push(i)
  }
  return out
}

function ifsReduce(args: Node[], h: FnHelpers, mode: 'sum' | 'avg' | 'max' | 'min'): RuntimeValue {
  const target = h.asMatrix(args[0])
  if (isError(target)) return target
  const idx = matchingIndices(1, args, h)
  if (isError(idx)) return idx
  const flat = target.data.flat()
  const picked: number[] = []
  for (const i of idx) {
    const v = flat[i] ?? BLANK
    if (typeof v === 'number') picked.push(v)
  }
  if (mode === 'sum') return picked.reduce((a, b) => a + b, 0)
  if (mode === 'avg') return picked.length ? picked.reduce((a, b) => a + b, 0) / picked.length : err('#DIV/0!')
  if (mode === 'max') return picked.length ? Math.max(...picked) : 0
  return picked.length ? Math.min(...picked) : 0
}

function ifsCount(args: Node[], h: FnHelpers): RuntimeValue {
  const idx = matchingIndices(0, args, h)
  if (isError(idx)) return idx
  return idx.length
}

// ---- order statistics -------------------------------------------------------

function nthOrder(args: Node[], h: FnHelpers, which: 'large' | 'small'): RuntimeValue {
  const ns = numbers([args[0]], h)
  if (isError(ns)) return ns
  const k = numAt(args, 1, h)
  if (isError(k)) return k
  const i = Math.trunc(k)
  if (i < 1 || i > ns.length) return err('#NUM!')
  const sorted = [...ns].sort((a, b) => (which === 'large' ? b - a : a - b))
  return sorted[i - 1]
}

function percentile(ns: number[], p: number): number | ErrorValue {
  if (!ns.length || p < 0 || p > 1) return err('#NUM!')
  const sorted = [...ns].sort((a, b) => a - b)
  if (sorted.length === 1) return sorted[0]
  const rank = p * (sorted.length - 1)
  const lo = Math.floor(rank)
  const frac = rank - lo
  return lo + 1 < sorted.length ? sorted[lo] + frac * (sorted[lo + 1] - sorted[lo]) : sorted[lo]
}

// ---- combinatorics ----------------------------------------------------------

function factorial(n: number): number | ErrorValue {
  if (n < 0 || n > 170) return err('#NUM!')
  let r = 1
  for (let i = 2; i <= n; i++) r *= i
  return r
}
function combinations(n: number, k: number): number | ErrorValue {
  if (k < 0 || n < 0 || k > n) return err('#NUM!')
  k = Math.min(k, n - k)
  let r = 1
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1)
  return Math.round(r)
}

// ---- TEXT formatting --------------------------------------------------------

function textFormat(v: Scalar, pattern: string): string | ErrorValue {
  if (isBlank(v)) return ''
  const n = toNumber(v)
  // Date/time pattern (contains a date/time letter) applied to a numeric serial.
  if (!isError(n) && /[ymdhs]/i.test(pattern) && !/[#0]/.test(pattern)) {
    return formatSerialPattern(n, pattern)
  }
  if (isError(n)) return toText(v)
  return numericTextFormat(n, pattern)
}

function numericTextFormat(n: number, pattern: string): string {
  const percent = pattern.includes('%')
  const currency = /[$€£¥]/.exec(pattern)?.[0]
  const grouped = pattern.includes(',')
  const dot = pattern.indexOf('.')
  const decimals = dot === -1 ? 0 : (pattern.slice(dot + 1).match(/[0#]/g) ?? []).length
  const value = percent ? n * 100 : n
  const neg = value < 0
  let body = Math.abs(value).toFixed(decimals)
  if (grouped) {
    const [intPart, frac] = body.split('.')
    const g = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    body = frac !== undefined ? `${g}.${frac}` : g
  }
  return (neg ? '-' : '') + (currency ?? '') + body + (percent ? '%' : '')
}

// ---- regex ------------------------------------------------------------------

function regexOp(args: Node[], h: FnHelpers, op: 'match' | 'extract' | 'replace'): RuntimeValue {
  const s = textAt(args, 0, h)
  if (isError(s)) return s
  const pat = textAt(args, 1, h)
  if (isError(pat)) return pat
  let re: RegExp
  try {
    re = new RegExp(pat, op === 'replace' ? 'g' : '')
  } catch {
    return err('#VALUE!', 'invalid regular expression')
  }
  if (op === 'match') return re.test(s)
  if (op === 'extract') {
    const m = re.exec(s)
    return m ? (m[1] ?? m[0]) : err('#N/A')
  }
  const repl = textAt(args, 2, h)
  if (isError(repl)) return repl
  return s.replace(re, repl)
}
