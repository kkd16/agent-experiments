import type { ChartData, ChartType } from '../engine/chart'
import { trendFit } from '../engine/chart'

interface Props {
  type: ChartType
  data: ChartData
  width: number
  height: number
  trendline?: boolean
}

const PALETTE = ['#7c9cff', '#5fd0ff', '#58d39b', '#ffce6b', '#ff8a8a', '#c89bff', '#6be0c4', '#ff9f5a']

/** A dependency-free SVG chart: line, column, bar, area, scatter, and pie. */
export default function ChartView({ type, data, width, height, trendline }: Props) {
  const hasData = data.series.some((s) => s.values.some((v) => v !== null))
  if (!hasData) {
    return (
      <div className="chart-empty" style={{ width, height }}>
        no numeric data in range
      </div>
    )
  }
  if (type === 'pie') return <Pie data={data} width={width} height={height} />
  return <Cartesian type={type} data={data} width={width} height={height} trendline={trendline} />
}

// ---- niceness for axis ticks -----------------------------------------------

function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    const pad = Math.abs(min) || 1
    min -= pad
    max += pad
  }
  const span = max - min
  const raw = span / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag
  const start = Math.floor(min / step) * step
  const ticks: number[] = []
  for (let v = start; v <= max + step * 0.5; v += step) ticks.push(Number(v.toFixed(10)))
  return ticks
}

const fmtTick = (n: number) => {
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US')
  return Number(n.toPrecision(6)).toString()
}

// ---- cartesian charts (line / column / bar / area / scatter) ---------------

function Cartesian({ type, data, width, height, trendline }: { type: ChartType; data: ChartData; width: number; height: number; trendline?: boolean }) {
  const horizontal = type === 'bar'
  const ML = 46
  const MR = 12
  const MT = 10
  const legendH = data.series.length > 1 ? 18 : 0
  const MB = 34 + legendH
  const plotW = Math.max(10, width - ML - MR)
  const plotH = Math.max(10, height - MT - MB)

  const allVals = data.series.flatMap((s) => s.values.filter((v): v is number => v !== null))
  let min = Math.min(0, ...allVals)
  let max = Math.max(0, ...allVals)
  if (min === max) max = min + 1
  const ticks = niceTicks(min, max)
  min = Math.min(min, ticks[0])
  max = Math.max(max, ticks[ticks.length - 1])

  const n = data.categories.length
  // value axis (vertical for most, horizontal for bar)
  const valSpan = max - min || 1
  const valToPx = (v: number) => (horizontal ? ((v - min) / valSpan) * plotW : plotH - ((v - min) / valSpan) * plotH)
  const catBand = (horizontal ? plotH : plotW) / Math.max(1, n)

  const S = data.series.length
  const elems: React.ReactNode[] = []

  // gridlines + value tick labels
  for (const t of ticks) {
    if (horizontal) {
      const x = ML + valToPx(t)
      elems.push(<line key={`g${t}`} x1={x} y1={MT} x2={x} y2={MT + plotH} stroke="var(--line)" strokeWidth={1} />)
      elems.push(<text key={`gt${t}`} x={x} y={MT + plotH + 14} className="chart-axis" textAnchor="middle">{fmtTick(t)}</text>)
    } else {
      const y = MT + valToPx(t)
      elems.push(<line key={`g${t}`} x1={ML} y1={y} x2={ML + plotW} y2={y} stroke="var(--line)" strokeWidth={1} />)
      elems.push(<text key={`gt${t}`} x={ML - 6} y={y + 3} className="chart-axis" textAnchor="end">{fmtTick(t)}</text>)
    }
  }

  // category labels (thinned to avoid overlap)
  const labelEvery = Math.ceil(n / (horizontal ? plotH / 16 : plotW / 44))
  for (let i = 0; i < n; i++) {
    if (i % labelEvery !== 0 && i !== n - 1) continue
    const center = i * catBand + catBand / 2
    if (horizontal) {
      elems.push(<text key={`c${i}`} x={ML - 6} y={MT + center + 3} className="chart-axis" textAnchor="end">{data.categories[i]}</text>)
    } else {
      elems.push(<text key={`c${i}`} x={ML + center} y={MT + plotH + 14} className="chart-axis" textAnchor="middle">{trunc(data.categories[i], 8)}</text>)
    }
  }

  // zero baseline
  const zeroPx = valToPx(0)
  if (horizontal) elems.push(<line key="zero" x1={ML + zeroPx} y1={MT} x2={ML + zeroPx} y2={MT + plotH} stroke="var(--line-2)" strokeWidth={1.5} />)
  else elems.push(<line key="zero" x1={ML} y1={MT + zeroPx} x2={ML + plotW} y2={MT + zeroPx} stroke="var(--line-2)" strokeWidth={1.5} />)

  data.series.forEach((s, si) => {
    const color = PALETTE[si % PALETTE.length]
    if (type === 'column' || type === 'bar') {
      const groupPad = catBand * 0.18
      const barW = (catBand - groupPad * 2) / S
      s.values.forEach((v, i) => {
        if (v === null) return
        const base = i * catBand + groupPad + si * barW
        if (horizontal) {
          const x = ML + Math.min(valToPx(0), valToPx(v))
          const w = Math.abs(valToPx(v) - valToPx(0))
          elems.push(<rect key={`b${si}-${i}`} x={x} y={MT + base + 1} width={Math.max(1, w)} height={Math.max(1, barW - 2)} fill={color} rx={1} />)
        } else {
          const y = MT + Math.min(valToPx(0), valToPx(v))
          const hgt = Math.abs(valToPx(v) - valToPx(0))
          elems.push(<rect key={`b${si}-${i}`} x={ML + base + 1} y={y} width={Math.max(1, barW - 2)} height={Math.max(1, hgt)} fill={color} rx={1} />)
        }
      })
    } else if (type === 'scatter') {
      s.values.forEach((v, i) => {
        if (v === null) return
        const cx = ML + i * catBand + catBand / 2
        const cy = MT + valToPx(v)
        elems.push(<circle key={`p${si}-${i}`} cx={cx} cy={cy} r={3} fill={color} fillOpacity={0.85} />)
      })
    } else {
      // line / area
      const pts: Array<[number, number]> = []
      s.values.forEach((v, i) => {
        if (v === null) return
        pts.push([ML + i * catBand + catBand / 2, MT + valToPx(v)])
      })
      if (type === 'area' && pts.length) {
        const baseY = MT + valToPx(0)
        const d = `M ${pts[0][0]} ${baseY} ` + pts.map(([x, y]) => `L ${x} ${y}`).join(' ') + ` L ${pts[pts.length - 1][0]} ${baseY} Z`
        elems.push(<path key={`a${si}`} d={d} fill={color} fillOpacity={0.18} stroke="none" />)
      }
      const poly = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
      elems.push(<polyline key={`l${si}`} points={poly} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)
      if (pts.length < 40) pts.forEach(([x, y], i) => elems.push(<circle key={`d${si}-${i}`} cx={x} cy={y} r={2} fill={color} />))
    }
  })

  // least-squares trendlines (line / area / scatter): the OLS fit of each series over
  // its category positions, drawn as a dashed line in the series colour with an R² tag.
  if (trendline && !horizontal && (type === 'line' || type === 'area' || type === 'scatter')) {
    const clampY = (v: number) => MT + Math.max(0, Math.min(plotH, valToPx(v)))
    data.series.forEach((s, si) => {
      const fit = trendFit(s.values)
      if (!fit) return
      const color = PALETTE[si % PALETTE.length]
      const x0 = ML + catBand / 2
      const x1 = ML + (n - 1) * catBand + catBand / 2
      const y0 = clampY(fit.intercept)
      const y1v = clampY(fit.slope * (n - 1) + fit.intercept)
      elems.push(
        <line
          key={`trend${si}`}
          x1={x0}
          y1={y0}
          x2={x1}
          y2={y1v}
          stroke={color}
          strokeWidth={1.75}
          strokeDasharray="5 3"
          opacity={0.9}
        />,
      )
      elems.push(
        <text key={`r2${si}`} x={x1 - 2} y={y1v - 4} className="chart-axis" textAnchor="end" fill={color}>
          R²={fit.r2.toFixed(3)}
        </text>,
      )
    })
  }

  // axis frame
  elems.push(<line key="ax" x1={ML} y1={MT} x2={ML} y2={MT + plotH} stroke="var(--line-2)" strokeWidth={1} />)
  elems.push(<line key="ay" x1={ML} y1={MT + plotH} x2={ML + plotW} y2={MT + plotH} stroke="var(--line-2)" strokeWidth={1} />)

  return (
    <svg width={width} height={height} className="chart-svg">
      {elems}
      {data.series.length > 1 ? <Legend series={data.series} y={height - legendH + 2} width={width} /> : null}
    </svg>
  )
}

function Legend({ series, y, width }: { series: ChartData['series']; y: number; width: number }) {
  const items = series.map((s, i) => ({ name: trunc(s.name, 12), color: PALETTE[i % PALETTE.length] }))
  const itemW = Math.min(120, width / items.length)
  return (
    <g>
      {items.map((it, i) => {
        const x = 8 + i * itemW
        return (
          <g key={i}>
            <rect x={x} y={y} width={9} height={9} rx={2} fill={it.color} />
            <text x={x + 13} y={y + 8} className="chart-legend">{it.name}</text>
          </g>
        )
      })}
    </g>
  )
}

// ---- pie --------------------------------------------------------------------

function Pie({ data, width, height }: { data: ChartData; width: number; height: number }) {
  // Pie uses the first series; categories label the slices.
  const series = data.series[0]
  const slices = series.values.map((v, i) => ({ label: data.categories[i] ?? `#${i + 1}`, value: v ?? 0 })).filter((s) => s.value > 0)
  const total = slices.reduce((a, s) => a + s.value, 0)
  const legendW = 96
  const cx = (width - legendW) / 2
  const cy = height / 2
  const radius = Math.max(10, Math.min(cx, cy) - 10)
  if (total <= 0) return <div className="chart-empty" style={{ width, height }}>no positive values</div>

  // Pre-compute each slice's start angle so the render maps over plain data.
  const starts: number[] = []
  slices.reduce((acc, s) => {
    starts.push(acc)
    return acc + (s.value / total) * Math.PI * 2
  }, -Math.PI / 2)
  const paths = slices.map((s, i) => {
    const frac = s.value / total
    const angle = starts[i]
    const next = angle + frac * Math.PI * 2
    const large = frac > 0.5 ? 1 : 0
    const x1 = cx + radius * Math.cos(angle)
    const y1 = cy + radius * Math.sin(angle)
    const x2 = cx + radius * Math.cos(next)
    const y2 = cy + radius * Math.sin(next)
    const mid = (angle + next) / 2
    const lx = cx + radius * 0.62 * Math.cos(mid)
    const ly = cy + radius * 0.62 * Math.sin(mid)
    const d = `M ${cx} ${cy} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${radius} ${radius} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z`
    return { d, color: PALETTE[i % PALETTE.length], pct: frac, lx, ly, label: s.label }
  })

  return (
    <svg width={width} height={height} className="chart-svg">
      {paths.map((p, i) => (
        <path key={i} d={p.d} fill={p.color} stroke="var(--bg-2)" strokeWidth={1} />
      ))}
      {paths.map((p, i) => (p.pct > 0.06 ? <text key={`t${i}`} x={p.lx} y={p.ly + 3} className="chart-slice" textAnchor="middle">{Math.round(p.pct * 100)}%</text> : null))}
      {slices.map((s, i) => {
        const y = 14 + i * 15
        if (y > height - 6) return null
        return (
          <g key={`lg${i}`}>
            <rect x={width - legendW + 6} y={y - 8} width={9} height={9} rx={2} fill={PALETTE[i % PALETTE.length]} />
            <text x={width - legendW + 19} y={y} className="chart-legend">{trunc(s.label, 10)}</text>
          </g>
        )
      })}
    </svg>
  )
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
