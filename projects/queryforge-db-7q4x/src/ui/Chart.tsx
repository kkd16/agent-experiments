// A dependency-free SVG chart for a query result. Picks the first non-numeric
// column as the category axis and every numeric column as a series; renders a
// grouped bar or multi-series line chart. Everything is hand-rolled SVG — no
// charting library — to keep the app pure Vite + React + TypeScript.

import { useState } from 'react'
import type { RowsResult } from '../db/engine'

const PALETTE = ['#5b9cff', '#27c2a0', '#f6b73c', '#e36588', '#9b7df0', '#56c2e6', '#7bd47b', '#ff8f5c']
const MAX_POINTS = 120

function isNumericType(t: string): boolean {
  return t === 'INTEGER' || t === 'REAL'
}

function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    const d = Math.abs(min) || 1
    min -= d
    max += d
  }
  const span = max - min
  const step0 = span / count
  const mag = Math.pow(10, Math.floor(Math.log10(step0)))
  const norm = step0 / mag
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag
  const start = Math.floor(min / step) * step
  const ticks: number[] = []
  for (let v = start; v <= max + step / 2; v += step) ticks.push(Number(v.toFixed(10)))
  return ticks
}

export function ChartView({ res }: { res: RowsResult }) {
  const numericCols = res.columns.map((c, i) => ({ i, name: c.name, t: c.type })).filter((c) => isNumericType(c.t))
  const labelColIdx = res.columns.findIndex((c) => !isNumericType(c.type))
  const [type, setType] = useState<'bar' | 'line'>('bar')

  if (numericCols.length === 0) {
    return <div className="chart-empty">This result has no numeric columns to chart.</div>
  }

  const rows = res.rows.slice(0, MAX_POINTS)
  const truncated = res.rows.length > MAX_POINTS
  const label = (r: number): string => {
    if (labelColIdx >= 0) {
      const v = rows[r][labelColIdx]
      return v === null ? '∅' : String(v)
    }
    return String(r + 1)
  }
  const series = numericCols.map((c, si) => ({
    name: c.name,
    color: PALETTE[si % PALETTE.length],
    values: rows.map((row) => {
      const v = row[c.i]
      return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : null
    }),
  }))

  const allVals = series.flatMap((s) => s.values).filter((v): v is number => v !== null)
  let dMin = allVals.length ? Math.min(...allVals) : 0
  const dMax = allVals.length ? Math.max(...allVals) : 1
  if (type === 'bar') dMin = Math.min(0, dMin)
  const ticks = niceTicks(dMin, dMax)
  const yMin = Math.min(dMin, ticks[0])
  const yMax = Math.max(dMax, ticks[ticks.length - 1])

  const W = 760
  const H = 340
  const pad = { l: 56, r: 16, t: 16, b: 64 }
  const pw = W - pad.l - pad.r
  const ph = H - pad.t - pad.b
  const x0 = pad.l
  const y0 = pad.t
  const yOf = (v: number) => y0 + ph - ((v - yMin) / (yMax - yMin || 1)) * ph
  const n = rows.length
  const bandW = pw / Math.max(1, n)
  // Show at most ~24 x labels to avoid overlap.
  const labelStep = Math.ceil(n / 24)

  return (
    <div className="chart">
      <div className="chart-toolbar">
        <div className="chart-types">
          <button className={`chart-type ${type === 'bar' ? 'active' : ''}`} onClick={() => setType('bar')}>
            Bar
          </button>
          <button className={`chart-type ${type === 'line' ? 'active' : ''}`} onClick={() => setType('line')}>
            Line
          </button>
        </div>
        <div className="chart-legend">
          {series.map((s) => (
            <span key={s.name} className="legend-item">
              <span className="legend-swatch" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      </div>
      <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img">
        {/* gridlines + y ticks */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={x0} y1={yOf(t)} x2={x0 + pw} y2={yOf(t)} className="chart-grid" />
            <text x={x0 - 8} y={yOf(t) + 4} className="chart-ylabel">
              {formatTick(t)}
            </text>
          </g>
        ))}
        {/* zero baseline */}
        {yMin < 0 && yMax > 0 && <line x1={x0} y1={yOf(0)} x2={x0 + pw} y2={yOf(0)} className="chart-axis" />}
        {/* x axis */}
        <line x1={x0} y1={y0 + ph} x2={x0 + pw} y2={y0 + ph} className="chart-axis" />

        {type === 'bar'
          ? rows.map((_, r) => {
              const groupX = x0 + r * bandW
              const inner = bandW * 0.8
              const bw = inner / series.length
              return (
                <g key={r}>
                  {series.map((s, si) => {
                    const v = s.values[r]
                    if (v === null) return null
                    const bx = groupX + bandW * 0.1 + si * bw
                    const top = yOf(Math.max(0, v))
                    const bot = yOf(Math.min(0, v))
                    return (
                      <rect key={si} x={bx} y={top} width={Math.max(1, bw - 1)} height={Math.max(0, bot - top)} fill={s.color}>
                        <title>{`${label(r)} · ${s.name}: ${v}`}</title>
                      </rect>
                    )
                  })}
                </g>
              )
            })
          : series.map((s) => {
              const pts = s.values
                .map((v, r) => (v === null ? null : `${x0 + (r + 0.5) * bandW},${yOf(v)}`))
                .filter((p): p is string => p !== null)
                .join(' ')
              return (
                <g key={s.name}>
                  <polyline points={pts} fill="none" stroke={s.color} strokeWidth={2} />
                  {s.values.map((v, r) =>
                    v === null ? null : (
                      <circle key={r} cx={x0 + (r + 0.5) * bandW} cy={yOf(v)} r={2.5} fill={s.color}>
                        <title>{`${label(r)} · ${s.name}: ${v}`}</title>
                      </circle>
                    ),
                  )}
                </g>
              )
            })}

        {/* x labels */}
        {rows.map((_, r) =>
          r % labelStep === 0 ? (
            <text
              key={r}
              x={x0 + (r + 0.5) * bandW}
              y={y0 + ph + 18}
              className="chart-xlabel"
              transform={n > 12 ? `rotate(35 ${x0 + (r + 0.5) * bandW} ${y0 + ph + 18})` : undefined}
            >
              {truncate(label(r), 14)}
            </text>
          ) : null,
        )}
      </svg>
      <div className="chart-foot">
        {labelColIdx >= 0 ? `category: ${res.columns[labelColIdx].name} · ` : 'category: row # · '}
        {series.length} series{truncated ? ` · showing first ${MAX_POINTS} of ${res.rows.length} rows` : ''}
      </div>
    </div>
  )
}

function formatTick(v: number): string {
  if (Math.abs(v) >= 1000) return v.toLocaleString()
  return String(Number(v.toFixed(4)))
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
