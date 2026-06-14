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
import type { Expr, ExistsExpr, InSubqueryExpr, QuantifiedExpr, SubqueryExpr, WindowFuncExpr } from './ast'
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

// --- date/time helpers ------------------------------------------------------
// Dates are represented as TEXT in ISO form ('YYYY-MM-DD' or full ISO 8601) or
// as a number of epoch-milliseconds. We parse into a JS Date for computation
// and format back to ISO so the value space stays serializable.
const MS_PER_DAY = 86_400_000
// Unix epoch (1970-01-01) expressed as a Julian Day Number.
const UNIX_EPOCH_JD = 2_440_587.5

function parseDate(v: SqlValue): Date | null {
  if (v === null) return null
  if (typeof v === 'number') return new Date(v)
  if (typeof v === 'boolean') return null
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
function datePart(part: string, d: Date): number | null {
  switch (part.toLowerCase()) {
    case 'year': case 'y': case 'yyyy': return d.getUTCFullYear()
    case 'month': case 'mon': case 'mm': return d.getUTCMonth() + 1
    case 'day': case 'dd': case 'd': return d.getUTCDate()
    case 'hour': case 'hh': return d.getUTCHours()
    case 'minute': case 'mi': return d.getUTCMinutes()
    case 'second': case 'ss': return d.getUTCSeconds()
    case 'dow': case 'weekday': return d.getUTCDay()
    case 'doy': return dayOfYear(d)
    case 'quarter': return Math.floor(d.getUTCMonth() / 3) + 1
    case 'epoch': return Math.floor(d.getTime() / 1000)
    default: return null
  }
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
  CONCAT: (args) => args.map((a) => (a === null ? '' : String(a))).join(''),
  CONCAT_WS: ([sep, ...rest]) =>
    sep === null ? null : rest.filter((a) => a !== null).map((a) => String(a)).join(String(sep)),
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
  ABS: ([a]) => (a === null ? null : Math.abs(Number(a))),
  SIGN: ([a]) => (a === null ? null : Math.sign(Number(a))),
  ROUND: ([a, d]) => {
    if (a === null) return null
    const p = d === null || d === undefined ? 0 : Number(d)
    const f = 10 ** p
    return Math.round(Number(a) * f) / f
  },
  CEIL: ([a]) => (a === null ? null : Math.ceil(Number(a))),
  CEILING: ([a]) => (a === null ? null : Math.ceil(Number(a))),
  FLOOR: ([a]) => (a === null ? null : Math.floor(Number(a))),
  TRUNC: ([a, d]) => {
    if (a === null) return null
    const p = d === null || d === undefined ? 0 : Number(d)
    const f = 10 ** p
    return Math.trunc(Number(a) * f) / f
  },
  SQRT: ([a]) => (a === null ? null : Math.sqrt(Number(a))),
  EXP: ([a]) => (a === null ? null : Math.exp(Number(a))),
  LN: ([a]) => (a === null ? null : Math.log(Number(a))),
  LOG10: ([a]) => (a === null ? null : Math.log10(Number(a))),
  LOG: ([a, b]) => (a === null ? null : b == null ? Math.log(Number(a)) : Math.log(Number(b)) / Math.log(Number(a))),
  POW: ([a, b]) => (a === null || b === null ? null : Number(a) ** Number(b)),
  POWER: ([a, b]) => (a === null || b === null ? null : Number(a) ** Number(b)),
  MOD: ([a, b]) => (a === null || b === null ? null : Number(a) % Number(b)),
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
  DATE_PART: ([part, a]) => {
    const d = parseDate(a)
    return d && part !== null ? datePart(String(part), d) : null
  },
  EXTRACT: ([part, a]) => {
    const d = parseDate(a)
    return d && part !== null ? datePart(String(part), d) : null
  },
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
      return (row) => coerceTo(type, inner(row))
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
        return v === null ? null : Number(v) * sign
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
        return String(a) + String(b)
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
      return `fn:${e.name}:${e.distinct}:${e.star}:${e.filter ? exprKey(e.filter) : ''}(${e.args.map(exprKey).join(',')})`
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
