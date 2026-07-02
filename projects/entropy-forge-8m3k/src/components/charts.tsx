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
