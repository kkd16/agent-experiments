// The function library: ~60 spreadsheet functions across math, trig, statistics,
// logic, text, lookup, and info, plus the inline SPARKLINE chart. Each entry is a
// small pure function over already-parsed argument nodes. Functions that must
// short-circuit (IF, AND, OR, IFERROR) take the raw nodes and evaluate lazily;
// everything else uses the flatten/scalar helpers from the evaluator.

import type { Node } from './ast'
import type { FnImpl, FnHelpers } from './evaluator'
import type { Scalar, ErrorValue, RuntimeValue, SparklineValue } from './values'
import { BLANK, err, isError, isBlank, toNumber, toText, toBool } from './values'

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
