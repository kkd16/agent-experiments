// Per-cell formatting: how a value is *displayed* (number format) and *styled*
// (weight, slant, alignment, colour). Formatting never changes a cell's computed
// value — a 0.5 shown as "50%" still sums as 0.5 — it only governs presentation,
// exactly like a real spreadsheet. The pure display logic lives here so it can be
// unit-tested without React; the visual styles are applied by the Grid.

import type { RuntimeValue } from './values'
import { isError, isBlank, isSparkline, isMatrix, isLambda, formatNumber } from './values'
import { formatDate, formatTime, formatDateTime } from './dates'

export type NumberFormat =
  | 'auto' // engine default (trimmed number / raw text)
  | 'plain' // fixed decimal places, no grouping
  | 'thousands' // 1,234.50 with grouping
  | 'currency' // $1,234.50
  | 'percent' // 12.5%
  | 'scientific' // 1.23E+4
  | 'date' // 2026-06-23
  | 'time' // 14:05:00
  | 'datetime' // 2026-06-23 14:05:00
  | 'text' // show the value verbatim, never as a number

export type Align = 'left' | 'center' | 'right'

export interface CellFormat {
  nf?: NumberFormat
  decimals?: number
  currency?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  align?: Align
  color?: string // text colour
  bg?: string // fill colour
}

/** True when a format carries no information and can be dropped from storage. */
export function isEmptyFormat(f: CellFormat | undefined): boolean {
  if (!f) return true
  return (
    (f.nf === undefined || f.nf === 'auto') &&
    f.decimals === undefined &&
    f.currency === undefined &&
    !f.bold &&
    !f.italic &&
    !f.underline &&
    f.align === undefined &&
    f.color === undefined &&
    f.bg === undefined
  )
}

/** Group the integer part of an already-rendered, sign-stripped numeric string. */
function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function fixed(n: number, decimals: number, grouped: boolean): string {
  const neg = n < 0 || Object.is(n, -0)
  const s = Math.abs(n).toFixed(decimals)
  const [intPart, frac] = s.split('.')
  const grpInt = grouped ? groupThousands(intPart) : intPart
  const body = frac !== undefined ? `${grpInt}.${frac}` : grpInt
  return (neg ? '-' : '') + body
}

/** Format a finite number according to a number format. */
function formatNumberAs(n: number, f: CellFormat): string {
  if (!Number.isFinite(n)) return formatNumber(n)
  const nf = f.nf ?? 'auto'
  switch (nf) {
    case 'plain':
      return f.decimals !== undefined ? fixed(n, f.decimals, false) : formatNumber(n)
    case 'thousands':
      return fixed(n, f.decimals ?? 0, true)
    case 'currency': {
      const sym = f.currency ?? '$'
      const dec = f.decimals ?? 2
      const neg = n < 0
      return (neg ? '-' : '') + sym + fixed(Math.abs(n), dec, true)
    }
    case 'percent':
      return fixed(n * 100, f.decimals ?? 0, false) + '%'
    case 'scientific':
      return n.toExponential(f.decimals ?? 2).replace('e', 'E')
    case 'date':
      return formatDate(n)
    case 'time':
      return formatTime(n)
    case 'datetime':
      return formatDateTime(n)
    default:
      return formatNumber(n)
  }
}

/** How a final cell value is shown in the grid, given its (optional) format. */
export function displayWithFormat(v: RuntimeValue, f: CellFormat | undefined): string {
  if (isError(v)) return v.code
  if (isBlank(v)) return ''
  if (isSparkline(v)) return ''
  if (isLambda(v)) return '#CALC!'
  if (isMatrix(v)) {
    if (v.rows === 1 && v.cols === 1) return displayWithFormat(v.data[0][0], f)
    return '#VALUE!'
  }
  if (typeof v === 'number') {
    if (f && f.nf === 'text') return formatNumber(v)
    return f ? formatNumberAs(v, f) : formatNumber(v)
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return v
}

/** Whether a value renders right-aligned by default (numbers, dates, errors). */
export function defaultRightAlign(v: RuntimeValue, f: CellFormat | undefined): boolean {
  if (typeof v === 'number') return f?.nf !== 'text'
  return isError(v)
}
