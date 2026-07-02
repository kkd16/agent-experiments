// The data model for an in-grid chart. A chart is a small persisted record that
// names a source range and a type; the actual numbers are pulled live from the
// workbook whenever it renders, so a chart always reflects the current values.

import type { RangeBox } from './address'
import type { RuntimeValue } from './values'
import { coordToA1 } from './address'

export type ChartType = 'line' | 'column' | 'bar' | 'area' | 'scatter' | 'pie'

export interface ChartSpec {
  id: string
  type: ChartType
  /** The source data range, on the sheet that owns the chart. */
  range: RangeBox
  title: string
  /** Floating position (px) within the grid viewport. */
  x: number
  y: number
  w: number
  h: number
  /** Treat the first row of the range as series headers. */
  headers: boolean
  /** Treat the first column of the range as category labels. */
  labels: boolean
  /** Draw a least-squares trendline (+ R²) over each series (line/area/scatter). */
  trendline?: boolean
}

export const CHART_TYPES: ChartType[] = ['line', 'column', 'bar', 'area', 'scatter', 'pie']

export const CHART_LABELS: Record<ChartType, string> = {
  line: 'Line',
  column: 'Column',
  bar: 'Bar',
  area: 'Area',
  scatter: 'Scatter',
  pie: 'Pie',
}

export interface Series {
  name: string
  values: Array<number | null>
}

export interface ChartData {
  categories: string[]
  series: Series[]
}

export interface TrendFit {
  slope: number
  intercept: number
  r2: number
}

/**
 * Ordinary-least-squares fit of a series' values against their category positions
 * (0, 1, 2, …), the same x the chart plots each point at — so the returned line is the
 * one that visually best-fits the drawn marks. Returns null when there are fewer than
 * two numeric points or the x-values are degenerate.
 */
export function trendFit(values: Array<number | null>): TrendFit | null {
  const xs: number[] = []
  const ys: number[] = []
  values.forEach((v, i) => {
    if (v !== null && Number.isFinite(v)) {
      xs.push(i)
      ys.push(v)
    }
  })
  const n = xs.length
  if (n < 2) return null
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }
  if (sxx === 0) return null
  const slope = sxy / sxx
  const intercept = my - slope * mx
  const r2 = syy === 0 ? 1 : Math.max(0, Math.min(1, (sxy * sxy) / (sxx * syy)))
  return { slope, intercept, r2 }
}

const num = (v: RuntimeValue): number | null => (typeof v === 'number' ? v : null)
const str = (v: RuntimeValue): string => {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return ''
}

/**
 * Pull a chart's numbers out of its source range, live. `read(r, c)` returns the
 * current value of a cell. With `headers`, the first row names the series; with
 * `labels`, the first column gives the category labels (otherwise categories are
 * "1, 2, 3, ..."). Each remaining column becomes one series.
 */
export function buildChartData(spec: ChartSpec, read: (r: number, c: number) => RuntimeValue): ChartData {
  const { range, headers, labels } = spec
  const r0 = range.top + (headers ? 1 : 0)
  const c0 = range.left + (labels ? 1 : 0)
  const rowCount = range.bottom - r0 + 1
  const colCount = range.right - c0 + 1
  if (rowCount <= 0 || colCount <= 0) return { categories: [], series: [] }

  const categories: string[] = []
  for (let r = r0; r <= range.bottom; r++) {
    categories.push(labels ? str(read(r, range.left)) : String(r - r0 + 1))
  }

  const series: Series[] = []
  for (let c = c0; c <= range.right; c++) {
    const name = headers ? str(read(range.top, c)) || coordToA1(0, c) : `Series ${c - c0 + 1}`
    const values: Array<number | null> = []
    for (let r = r0; r <= range.bottom; r++) values.push(num(read(r, c)))
    series.push({ name, values })
  }
  return { categories, series }
}
