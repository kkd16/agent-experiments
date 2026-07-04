// charts.tsx — dependency-free SVG charts. Everything is drawn by hand so the app
// keeps zero runtime chart libraries; the palette comes from the CSS series vars.

export interface Bar {
  label: string
  value: number
  color?: string
  caption?: string
}

/** Horizontal bar chart — good when labels are words (codec names, symbols). */
export function HBarChart({
  bars,
  max,
  unit = '',
  height = 26,
  valueFmt = (v: number) => v.toFixed(0),
  marker,
}: {
  bars: Bar[]
  max?: number
  unit?: string
  height?: number
  valueFmt?: (v: number) => string
  marker?: { value: number; label: string }
}) {
  const top = max ?? Math.max(1, ...bars.map((b) => b.value))
  const labelW = 164
  const valueW = 74
  const gap = 8
  const chartH = bars.length * (height + gap)
  const innerW = 620
  const totalW = labelW + innerW + valueW
  const barX = labelW
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${totalW} ${chartH + 8}`} width="100%" style={{ minWidth: 520 }} role="img">
        {marker && (
          <g>
            <line
              x1={barX + (marker.value / top) * innerW}
              x2={barX + (marker.value / top) * innerW}
              y1={0}
              y2={chartH}
              stroke="var(--amber)"
              strokeDasharray="4 4"
              strokeWidth={1.5}
              opacity={0.8}
            />
            <text
              x={barX + (marker.value / top) * innerW + 5}
              y={11}
              fill="var(--amber)"
              fontSize={10}
            >
              {marker.label}
            </text>
          </g>
        )}
        {bars.map((b, i) => {
          const y = i * (height + gap)
          const w = Math.max(0, (b.value / top) * innerW)
          const color = b.color ?? 'var(--teal)'
          return (
            <g key={i}>
              <text x={labelW - 10} y={y + height / 2 + 4} textAnchor="end" fill="var(--text-mid)" fontSize={12}>
                {b.label}
              </text>
              <rect x={barX} y={y} width={innerW} height={height} rx={5} fill="var(--panel-2)" />
              <rect x={barX} y={y} width={w} height={height} rx={5} fill={color} opacity={0.85} />
              <text x={barX + innerW + 8} y={y + height / 2 + 4} fill="var(--text)" fontSize={12} fontFamily="var(--mono)">
                {valueFmt(b.value)}
                {unit}
              </text>
              {b.caption && (
                <text x={barX + 8} y={y + height / 2 + 4} fill="#0a0d13" fontSize={11} fontFamily="var(--mono)" opacity={w > 60 ? 0.85 : 0}>
                  {b.caption}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/** Vertical column chart for a symbol frequency distribution (up to ~64 cols). */
export function ColumnChart({
  cols,
  height = 180,
  color = 'var(--teal)',
}: {
  cols: { label: string; value: number }[]
  height?: number
  color?: string
}) {
  const top = Math.max(1, ...cols.map((c) => c.value))
  const n = cols.length
  const w = Math.max(600, n * 22)
  const colW = w / n
  const showLabels = n <= 48
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${w} ${height + 26}`} width="100%" style={{ minWidth: Math.min(w, 640) }} role="img">
        {cols.map((c, i) => {
          const h = (c.value / top) * height
          const x = i * colW
          return (
            <g key={i}>
              <rect x={x + 2} y={height - h} width={colW - 4} height={h} rx={3} fill={color} opacity={0.85} />
              {showLabels && (
                <text x={x + colW / 2} y={height + 15} textAnchor="middle" fill="var(--text-dim)" fontSize={10}>
                  {c.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export interface Series {
  label: string
  color: string
  points: [number, number][]
  dashed?: boolean
}

/**
 * A hand-drawn multi-series line chart with labelled axes and an optional log-y
 * scale (for BER "waterfall" curves that span decades). Used by the channel-
 * coding pages for capacity curves, BER-vs-noise waterfalls and BP convergence.
 */
export function LineChart({
  series,
  xDomain,
  yDomain,
  xLabel,
  yLabel,
  height = 240,
  logY = false,
  xTicks = 5,
  yTicks = 5,
  xFmt = (v: number) => v.toFixed(2),
  yFmt = (v: number) => v.toFixed(2),
  markers = [],
}: {
  series: Series[]
  xDomain: [number, number]
  yDomain: [number, number]
  xLabel?: string
  yLabel?: string
  height?: number
  logY?: boolean
  xTicks?: number
  yTicks?: number
  xFmt?: (v: number) => string
  yFmt?: (v: number) => string
  markers?: { x?: number; y?: number; label: string; color?: string }[]
}) {
  const W = 680
  const padL = 56
  const padR = 16
  const padB = 34
  const padT = 12
  const innerW = W - padL - padR
  const innerH = height - padB - padT
  const [x0, x1] = xDomain
  const ly0 = logY ? Math.log10(yDomain[0]) : yDomain[0]
  const ly1 = logY ? Math.log10(yDomain[1]) : yDomain[1]
  const sx = (x: number) => padL + ((x - x0) / (x1 - x0 || 1)) * innerW
  const sy = (y: number) => {
    const yy = logY ? Math.log10(Math.max(y, yDomain[0])) : y
    return padT + (1 - (yy - ly0) / (ly1 - ly0 || 1)) * innerH
  }
  const xtickVals = Array.from({ length: xTicks + 1 }, (_, i) => x0 + ((x1 - x0) * i) / xTicks)
  const ytickVals = logY
    ? Array.from({ length: Math.round(ly1 - ly0) + 1 }, (_, i) => Math.pow(10, ly0 + i))
    : Array.from({ length: yTicks + 1 }, (_, i) => yDomain[0] + ((yDomain[1] - yDomain[0]) * i) / yTicks)

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" style={{ minWidth: 480 }} role="img">
        {/* grid + ticks */}
        {ytickVals.map((v, i) => (
          <g key={`y${i}`}>
            <line x1={padL} x2={W - padR} y1={sy(v)} y2={sy(v)} stroke="var(--border)" strokeWidth={1} opacity={0.5} />
            <text x={padL - 8} y={sy(v) + 4} textAnchor="end" fontSize={10} fill="var(--text-dim)" fontFamily="var(--mono)">
              {yFmt(v)}
            </text>
          </g>
        ))}
        {xtickVals.map((v, i) => (
          <g key={`x${i}`}>
            <line x1={sx(v)} x2={sx(v)} y1={padT} y2={height - padB} stroke="var(--border)" strokeWidth={1} opacity={0.3} />
            <text x={sx(v)} y={height - padB + 16} textAnchor="middle" fontSize={10} fill="var(--text-dim)" fontFamily="var(--mono)">
              {xFmt(v)}
            </text>
          </g>
        ))}
        {yLabel && (
          <text x={14} y={padT + innerH / 2} textAnchor="middle" fontSize={11} fill="var(--text-mid)" transform={`rotate(-90 14 ${padT + innerH / 2})`}>
            {yLabel}
          </text>
        )}
        {xLabel && (
          <text x={padL + innerW / 2} y={height - 2} textAnchor="middle" fontSize={11} fill="var(--text-mid)">
            {xLabel}
          </text>
        )}
        {/* markers */}
        {markers.map((m, i) => (
          <g key={`m${i}`}>
            {m.x !== undefined && (
              <line x1={sx(m.x)} x2={sx(m.x)} y1={padT} y2={height - padB} stroke={m.color ?? 'var(--amber)'} strokeDasharray="4 3" strokeWidth={1.3} opacity={0.8} />
            )}
            {m.y !== undefined && (
              <line x1={padL} x2={W - padR} y1={sy(m.y)} y2={sy(m.y)} stroke={m.color ?? 'var(--amber)'} strokeDasharray="4 3" strokeWidth={1.3} opacity={0.8} />
            )}
            <text x={m.x !== undefined ? sx(m.x) + 5 : W - padR - 5} y={m.y !== undefined ? sy(m.y) - 5 : padT + 12} textAnchor={m.x !== undefined ? 'start' : 'end'} fontSize={10} fill={m.color ?? 'var(--amber)'}>
              {m.label}
            </text>
          </g>
        ))}
        {/* series */}
        {series.map((s, i) => {
          const d = s.points
            .filter((p) => p[1] >= yDomain[0] || !logY)
            .map((p, j) => `${j === 0 ? 'M' : 'L'} ${sx(p[0]).toFixed(1)} ${sy(p[1]).toFixed(1)}`)
            .join(' ')
          return (
            <path key={i} d={d} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? '5 4' : undefined} opacity={0.95} />
          )
        })}
      </svg>
      <div className="chip-row" style={{ marginTop: 8 }}>
        {series.map((s, i) => (
          <span key={i} className="chip" style={{ cursor: 'default', borderColor: s.color, color: s.color }}>
            <span style={{ display: 'inline-block', width: 10, height: 2, background: s.color, marginRight: 6, verticalAlign: 'middle' }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  )
}
