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
import type { Expr } from './ast'
import type { Row } from './catalog'

export type Evaluator = (row: Row) => SqlValue

export interface CompileCtx {
  /** Resolve a column reference to a positional index in the row. */
  resolve: (table: string | undefined, name: string) => number
  /**
   * Optional lookup for pre-computed sub-expressions (grouping keys and
   * aggregate results in a grouped query). If it returns an index, the whole
   * sub-expression is read straight from that slot.
   */
  lookup?: (expr: Expr) => number | undefined
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

// Scalar (non-aggregate) functions ------------------------------------------
type ScalarFn = (args: SqlValue[]) => SqlValue
export const SCALAR_FUNCTIONS: Record<string, ScalarFn> = {
  UPPER: ([a]) => (a === null ? null : String(a).toUpperCase()),
  LOWER: ([a]) => (a === null ? null : String(a).toLowerCase()),
  LENGTH: ([a]) => (a === null ? null : String(a).length),
  TRIM: ([a]) => (a === null ? null : String(a).trim()),
  ABS: ([a]) => (a === null ? null : Math.abs(Number(a))),
  ROUND: ([a, d]) => {
    if (a === null) return null
    const p = d === null || d === undefined ? 0 : Number(d)
    const f = 10 ** p
    return Math.round(Number(a) * f) / f
  },
  CEIL: ([a]) => (a === null ? null : Math.ceil(Number(a))),
  FLOOR: ([a]) => (a === null ? null : Math.floor(Number(a))),
  SQRT: ([a]) => (a === null ? null : Math.sqrt(Number(a))),
  COALESCE: (args) => {
    for (const a of args) if (a !== null) return a
    return null
  },
  IFNULL: ([a, b]) => (a === null ? (b ?? null) : a),
  IIF: ([cond, a, b]) => (toBool(cond) ? (a ?? null) : (b ?? null)),
  CONCAT: (args) => args.map((a) => (a === null ? '' : String(a))).join(''),
  SUBSTR: ([s, start, len]) => {
    if (s === null) return null
    const str = String(s)
    const st = Math.max(0, Number(start) - 1)
    return len === null || len === undefined ? str.slice(st) : str.slice(st, st + Number(len))
  },
  REPLACE: ([s, a, b]) =>
    s === null ? null : String(s).split(String(a ?? '')).join(String(b ?? '')),
  TYPEOF: ([a]) => {
    if (a === null) return 'null'
    if (typeof a === 'boolean') return 'boolean'
    if (typeof a === 'string') return 'text'
    return Number.isInteger(a) ? 'integer' : 'real'
  },
  POW: ([a, b]) => (a === null || b === null ? null : Number(a) ** Number(b)),
  MOD: ([a, b]) => (a === null || b === null ? null : Number(a) % Number(b)),
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
      const idx = ctx.resolve(expr.table, expr.name)
      return (row) => row[idx]
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
      return `fn:${e.name}:${e.distinct}:${e.star}(${e.args.map(exprKey).join(',')})`
    case 'case':
      return `case(${e.operand ? exprKey(e.operand) : ''};${e.whens
        .map((w) => `${exprKey(w.when)}=>${exprKey(w.then)}`)
        .join(',')};${e.else ? exprKey(e.else) : ''})`
    case 'cast':
      return `cast:${e.type}(${exprKey(e.expr)})`
  }
}
