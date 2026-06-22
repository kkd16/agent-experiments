// Type-specialized kernels: compile an expression tree into a closure over the
// CAPTURED typed arrays of a `ColumnStore`. A numeric column read is just
// `data[i]` (no `SqlValue` boxing); a comparison is `a < b` on two doubles (no
// trip through the generic `compareValues`). Every kernel is matched
// byte-for-byte to the row-at-a-time semantics in `eval.ts` — same NULL
// propagation, same Kleene three-valued logic, same divide-by-zero → NULL — so
// the two engines cannot disagree.
//
// Two value domains flow through here:
//   • a NUMERIC evaluator returns `number | null` (NULL ⇒ SQL NULL),
//   • a PREDICATE evaluator returns a tri-state byte: 0 = FALSE, 1 = TRUE,
//     2 = UNKNOWN (SQL NULL) — exactly the cases Kleene logic distinguishes.

import type { Expr } from '../ast'
import { SqlError, type SqlValue } from '../types'
import type { ColumnStore } from './types'
import { columnIndex, isNumericType } from './types'

/** A numeric (or NULL) per-row evaluator: `i ↦ number | null`. */
export type NumEval = (i: number) => number | null
/** A tri-state predicate evaluator: `i ↦ 0 (false) | 1 (true) | 2 (unknown)`. */
export type PredEval = (i: number) => number
/** A projection evaluator producing any SQL value (carries TEXT/etc. through). */
export type ValEval = (i: number) => SqlValue

const FALSE = 0
const TRUE = 1
const UNKNOWN = 2

/** Is this expression compilable as a NUMERIC kernel over the store? Used by the
 *  analyzer to decide support before we commit to the vectorized path. */
export function isNumericExpr(e: Expr, store: ColumnStore): boolean {
  switch (e.kind) {
    case 'literal':
      return e.value === null || typeof e.value === 'number' || typeof e.value === 'boolean'
    case 'column': {
      const idx = columnIndex(store, e.name)
      return idx >= 0 && isNumericType(store.columns[idx].type)
    }
    case 'unary':
      return (e.op === '-' || e.op === '+') && isNumericExpr(e.expr, store)
    case 'binary':
      return (
        (e.op === '+' || e.op === '-' || e.op === '*' || e.op === '/' || e.op === '%') &&
        isNumericExpr(e.left, store) &&
        isNumericExpr(e.right, store)
      )
    default:
      return false
  }
}

/** Compile a numeric expression to a `number | null` evaluator. */
export function compileNum(e: Expr, store: ColumnStore): NumEval {
  switch (e.kind) {
    case 'literal': {
      const v = e.value
      if (v === null) return () => null
      const n = typeof v === 'boolean' ? (v ? 1 : 0) : (v as number)
      return () => n
    }
    case 'column': {
      const idx = columnIndex(store, e.name)
      const col = store.columns[idx]
      if (col.kind !== 'f64') throw new SqlError('non-numeric column in a numeric kernel', 'plan')
      const data = col.data
      const nulls = col.nulls
      if (!nulls) return (i) => data[i]
      return (i) => (nulls[i] ? null : data[i])
    }
    case 'unary': {
      const inner = compileNum(e.expr, store)
      if (e.op === '+') return inner
      return (i) => {
        const v = inner(i)
        return v === null ? null : -v
      }
    }
    case 'binary': {
      const l = compileNum(e.left, store)
      const r = compileNum(e.right, store)
      switch (e.op) {
        case '+':
          return (i) => {
            const a = l(i)
            if (a === null) return null
            const b = r(i)
            return b === null ? null : a + b
          }
        case '-':
          return (i) => {
            const a = l(i)
            if (a === null) return null
            const b = r(i)
            return b === null ? null : a - b
          }
        case '*':
          return (i) => {
            const a = l(i)
            if (a === null) return null
            const b = r(i)
            return b === null ? null : a * b
          }
        case '/':
          return (i) => {
            const a = l(i)
            if (a === null) return null
            const b = r(i)
            if (b === null) return null
            return b === 0 ? null : a / b
          }
        default: // '%'
          return (i) => {
            const a = l(i)
            if (a === null) return null
            const b = r(i)
            if (b === null) return null
            return b === 0 ? null : a % b
          }
      }
    }
    default:
      throw new SqlError(`expression kind "${e.kind}" is not a numeric kernel`, 'plan')
  }
}

/** Is this expression compilable as a PREDICATE kernel? (boolean-valued over
 *  numeric operands). */
export function isPredExpr(e: Expr, store: ColumnStore): boolean {
  switch (e.kind) {
    case 'binary':
      if (e.op === 'AND' || e.op === 'OR') return isPredExpr(e.left, store) && isPredExpr(e.right, store)
      if (['=', '<>', '<', '<=', '>', '>='].includes(e.op))
        return isNumericExpr(e.left, store) && isNumericExpr(e.right, store)
      return false
    case 'unary':
      return e.op === 'NOT' && isPredExpr(e.expr, store)
    case 'isnull':
      return isNumericExpr(e.expr, store)
    case 'between':
      return isNumericExpr(e.expr, store) && isNumericExpr(e.lo, store) && isNumericExpr(e.hi, store)
    case 'in':
      return isNumericExpr(e.expr, store) && e.list.every((x) => isNumericExpr(x, store))
    default:
      return false
  }
}

/** Compile a boolean expression to a tri-state predicate evaluator. */
export function compilePred(e: Expr, store: ColumnStore): PredEval {
  switch (e.kind) {
    case 'binary': {
      if (e.op === 'AND') {
        const l = compilePred(e.left, store)
        const r = compilePred(e.right, store)
        return (i) => {
          const a = l(i)
          if (a === FALSE) return FALSE
          const b = r(i)
          if (b === FALSE) return FALSE
          return a === UNKNOWN || b === UNKNOWN ? UNKNOWN : TRUE
        }
      }
      if (e.op === 'OR') {
        const l = compilePred(e.left, store)
        const r = compilePred(e.right, store)
        return (i) => {
          const a = l(i)
          if (a === TRUE) return TRUE
          const b = r(i)
          if (b === TRUE) return TRUE
          return a === UNKNOWN || b === UNKNOWN ? UNKNOWN : FALSE
        }
      }
      // comparison
      const l = compileNum(e.left, store)
      const r = compileNum(e.right, store)
      switch (e.op) {
        case '=':
          return (i) => {
            const a = l(i)
            if (a === null) return UNKNOWN
            const b = r(i)
            return b === null ? UNKNOWN : a === b ? TRUE : FALSE
          }
        case '<>':
          return (i) => {
            const a = l(i)
            if (a === null) return UNKNOWN
            const b = r(i)
            return b === null ? UNKNOWN : a !== b ? TRUE : FALSE
          }
        case '<':
          return (i) => {
            const a = l(i)
            if (a === null) return UNKNOWN
            const b = r(i)
            return b === null ? UNKNOWN : a < b ? TRUE : FALSE
          }
        case '<=':
          return (i) => {
            const a = l(i)
            if (a === null) return UNKNOWN
            const b = r(i)
            return b === null ? UNKNOWN : a <= b ? TRUE : FALSE
          }
        case '>':
          return (i) => {
            const a = l(i)
            if (a === null) return UNKNOWN
            const b = r(i)
            return b === null ? UNKNOWN : a > b ? TRUE : FALSE
          }
        default: // '>='
          return (i) => {
            const a = l(i)
            if (a === null) return UNKNOWN
            const b = r(i)
            return b === null ? UNKNOWN : a >= b ? TRUE : FALSE
          }
      }
    }
    case 'unary': {
      // NOT
      const inner = compilePred(e.expr, store)
      return (i) => {
        const v = inner(i)
        return v === UNKNOWN ? UNKNOWN : v === TRUE ? FALSE : TRUE
      }
    }
    case 'isnull': {
      const inner = compileNum(e.expr, store)
      const neg = e.negated
      return (i) => {
        const isNull = inner(i) === null
        return (neg ? !isNull : isNull) ? TRUE : FALSE
      }
    }
    case 'between': {
      // x BETWEEN lo AND hi  ≡  x >= lo AND x <= hi   (NOT BETWEEN negates)
      const x = compileNum(e.expr, store)
      const lo = compileNum(e.lo, store)
      const hi = compileNum(e.hi, store)
      const core: PredEval = (i) => {
        const v = x(i)
        if (v === null) return UNKNOWN
        const a = lo(i)
        const geLo = a === null ? UNKNOWN : v >= a ? TRUE : FALSE
        if (geLo === FALSE) return FALSE
        const b = hi(i)
        const leHi = b === null ? UNKNOWN : v <= b ? TRUE : FALSE
        if (leHi === FALSE) return FALSE
        return geLo === UNKNOWN || leHi === UNKNOWN ? UNKNOWN : TRUE
      }
      if (!e.negated) return core
      return (i) => {
        const v = core(i)
        return v === UNKNOWN ? UNKNOWN : v === TRUE ? FALSE : TRUE
      }
    }
    case 'in': {
      // x IN (a, b, …)  ≡  (x = a) OR (x = b) OR …   (NOT IN negates the OR)
      const x = compileNum(e.expr, store)
      const items = e.list.map((it) => compileNum(it, store))
      const core: PredEval = (i) => {
        const v = x(i)
        if (v === null) return UNKNOWN
        let sawNull = false
        for (const it of items) {
          const w = it(i)
          if (w === null) {
            sawNull = true
            continue
          }
          if (v === w) return TRUE
        }
        return sawNull ? UNKNOWN : FALSE
      }
      if (!e.negated) return core
      return (i) => {
        const v = core(i)
        return v === UNKNOWN ? UNKNOWN : v === TRUE ? FALSE : TRUE
      }
    }
    default:
      throw new SqlError(`expression kind "${e.kind}" is not a predicate kernel`, 'plan')
  }
}

/** Can this expression be produced as an output value? (a column of any type,
 *  a literal, or a numeric expression). */
export function isValueExpr(e: Expr, store: ColumnStore): boolean {
  if (e.kind === 'column') return columnIndex(store, e.name) >= 0
  if (e.kind === 'literal') return true
  return isNumericExpr(e, store)
}

/** Compile a projection expression to a `SqlValue` evaluator. */
export function compileValue(e: Expr, store: ColumnStore): ValEval {
  if (e.kind === 'literal') {
    const v = e.value
    return () => v
  }
  if (e.kind === 'column') {
    const idx = columnIndex(store, e.name)
    const col = store.columns[idx]
    if (col.kind === 'gen') {
      const data = col.data
      return (i) => data[i]
    }
    const data = col.data
    const nulls = col.nulls
    if (!nulls) return (i) => data[i]
    return (i) => (nulls[i] ? null : data[i])
  }
  // numeric expression
  return compileNum(e, store) as ValEval
}
