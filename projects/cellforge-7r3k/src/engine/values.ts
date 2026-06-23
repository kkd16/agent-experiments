// The typed value lattice the evaluator computes over. A spreadsheet value is one
// of: a number, a string, a boolean, an error, a "blank" (the value of an empty
// cell, which behaves like 0 / "" / false depending on context), a matrix (the
// value of a range), or a sparkline (a tiny inline chart). Coercions follow the
// conventions users expect from real spreadsheets.

export type ErrorCode =
  | '#DIV/0!'
  | '#VALUE!'
  | '#NAME?'
  | '#REF!'
  | '#N/A'
  | '#NUM!'
  | '#CIRC!'
  | '#PARSE!'

export interface ErrorValue {
  readonly kind: 'error'
  readonly code: ErrorCode
  readonly message?: string
}

export interface BlankValue {
  readonly kind: 'blank'
}

export interface SparklineValue {
  readonly kind: 'sparkline'
  readonly mode: 'bar' | 'line'
  readonly data: number[]
}

export type Scalar = number | string | boolean | ErrorValue | BlankValue

export interface MatrixValue {
  readonly kind: 'matrix'
  readonly rows: number
  readonly cols: number
  readonly data: Scalar[][]
}

export type RuntimeValue = Scalar | MatrixValue | SparklineValue

export const BLANK: BlankValue = { kind: 'blank' }

export const err = (code: ErrorCode, message?: string): ErrorValue => ({ kind: 'error', code, message })

export const isError = (v: unknown): v is ErrorValue =>
  typeof v === 'object' && v !== null && (v as { kind?: string }).kind === 'error'
export const isBlank = (v: RuntimeValue): v is BlankValue =>
  typeof v === 'object' && v !== null && (v as { kind?: string }).kind === 'blank'
export const isMatrix = (v: RuntimeValue): v is MatrixValue =>
  typeof v === 'object' && v !== null && (v as { kind?: string }).kind === 'matrix'
export const isSparkline = (v: RuntimeValue): v is SparklineValue =>
  typeof v === 'object' && v !== null && (v as { kind?: string }).kind === 'sparkline'
export const isNumber = (v: RuntimeValue): v is number => typeof v === 'number'
export const isString = (v: RuntimeValue): v is string => typeof v === 'string'
export const isBool = (v: RuntimeValue): v is boolean => typeof v === 'boolean'

export function matrix(data: Scalar[][]): MatrixValue {
  const rows = data.length
  const cols = rows > 0 ? data[0].length : 0
  return { kind: 'matrix', rows, cols, data }
}

/** Number coercion. Blanks are 0, booleans are 1/0, numeric strings parse; errors pass through. */
export function toNumber(v: Scalar): number | ErrorValue {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (isBlank(v)) return 0
  if (isError(v)) return v
  const trimmed = v.trim()
  if (trimmed === '') return 0
  const n = Number(trimmed)
  return Number.isNaN(n) ? err('#VALUE!', `cannot read "${v}" as a number`) : n
}

/** String coercion for display/concatenation. Errors pass through unchanged. */
export function toText(v: Scalar): string | ErrorValue {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return formatNumber(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (isBlank(v)) return ''
  return v // error
}

/** Truthiness for logical contexts. Non-zero numbers and non-empty strings are true. */
export function toBool(v: Scalar): boolean | ErrorValue {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (isBlank(v)) return false
  if (isError(v)) return v
  const t = v.trim().toUpperCase()
  if (t === 'TRUE') return true
  if (t === 'FALSE' || t === '') return false
  const n = Number(t)
  return Number.isNaN(n) ? err('#VALUE!', `cannot read "${v}" as a boolean`) : n !== 0
}

/** Format a number for cell display: trim float noise, keep it compact. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? '∞' : n < 0 ? '-∞' : '#NUM!'
  if (Number.isInteger(n)) return String(n)
  // Round to 10 significant places to hide binary-float noise, then trim.
  const rounded = Number(n.toPrecision(12))
  let s = String(rounded)
  if (s.includes('e') || s.includes('E')) return s
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s
}

/** How a final cell value is shown in the grid. */
export function displayValue(v: RuntimeValue): string {
  if (isError(v)) return v.code
  if (isBlank(v)) return ''
  if (isSparkline(v)) return ''
  if (isMatrix(v)) {
    if (v.rows === 1 && v.cols === 1) return displayValue(v.data[0][0])
    return '#VALUE!'
  }
  if (typeof v === 'number') return formatNumber(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return v
}

/** Reduce a possibly-spilled value down to the single scalar a cell holds. */
export function asScalar(v: RuntimeValue): Scalar {
  if (isSparkline(v)) return err('#VALUE!', 'sparkline used in a scalar context')
  if (isMatrix(v)) return v.rows === 1 && v.cols === 1 ? v.data[0][0] : err('#VALUE!', 'a range cannot collapse to one cell')
  return v
}
