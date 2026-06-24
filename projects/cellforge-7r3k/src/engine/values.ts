// The typed value lattice the evaluator computes over. A spreadsheet value is one
// of: a number, a string, a boolean, an error, a "blank" (the value of an empty
// cell, which behaves like 0 / "" / false depending on context), a matrix (the
// value of a range or dynamic array), a sparkline (a tiny inline chart), or — new
// in v3 — a lambda (a first-class anonymous function the evaluator can apply).
// Coercions follow the conventions users expect from real spreadsheets.

import type { Node } from './ast'

export type ErrorCode =
  | '#DIV/0!'
  | '#VALUE!'
  | '#NAME?'
  | '#REF!'
  | '#N/A'
  | '#NUM!'
  | '#CIRC!'
  | '#PARSE!'
  | '#SPILL!' // a dynamic array could not spill into the cells it needs
  | '#CALC!' // a calculation produced something a cell can't hold (e.g. a naked lambda / empty array)

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

/** A first-class anonymous function — the value of `LAMBDA(...)`. It captures the
 *  parameter names, its body AST, and the lexical bindings (LET names / outer
 *  lambda params) in scope where it was created, so closures behave correctly. */
export interface LambdaValue {
  readonly kind: 'lambda'
  readonly params: string[] // upper-cased parameter names
  readonly body: Node
  readonly closure: ReadonlyMap<string, RuntimeValue>
}

export type RuntimeValue = Scalar | MatrixValue | SparklineValue | LambdaValue

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
export const isLambda = (v: RuntimeValue): v is LambdaValue =>
  typeof v === 'object' && v !== null && (v as { kind?: string }).kind === 'lambda'
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
  if (isLambda(v)) return '#CALC!'
  if (isMatrix(v)) {
    if (v.rows === 1 && v.cols === 1) return displayValue(v.data[0][0])
    return '#VALUE!'
  }
  if (typeof v === 'number') return formatNumber(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return v
}

/** Reduce a possibly-spilled value down to the single scalar a cell holds. A matrix
 *  collapses to its single cell when 1×1; otherwise the caller is responsible for
 *  spilling it (see Workbook.recompute) — here it degrades to its top-left cell so
 *  intermediate scalar contexts (the "implicit intersection") still produce a value. */
export function asScalar(v: RuntimeValue): Scalar {
  if (isSparkline(v)) return err('#VALUE!', 'sparkline used in a scalar context')
  if (isLambda(v)) return err('#CALC!', 'a lambda must be called, not stored')
  if (isMatrix(v)) return v.rows === 1 && v.cols === 1 ? v.data[0][0] : err('#VALUE!', 'a range cannot collapse to one cell')
  return v
}
