// Hand-rolled SVG charts — no charting library. Responsive via viewBox.

import { moneyShort } from '../lib/format'

export function BarChart({
  data,
  currency,
  height = 200,
}: {
  data: { label: string; value: number }[]
  currency: string
  height?: number
}) {
  const max = Math.max(1, ...data.map((d) => d.value))
  const n = data.length || 1
  const W = 600
  const H = height
  const padX = 8
  const padBottom = 28
  const padTop = 16
  const slot = (W - padX * 2) / n
  const barW = Math.min(46, slot * 0.6)
  const chartH = H - padBottom - padTop

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="barchart" preserveAspectRatio="none" role="img">
      {[0.25, 0.5, 0.75, 1].map((g) => (
        <line
          key={g}
          x1={padX}
          x2={W - padX}
          y1={padTop + chartH * (1 - g)}
          y2={padTop + chartH * (1 - g)}
          className="grid-line"
        />
      ))}
      {data.map((d, i) => {
        const h = (d.value / max) * chartH
        const x = padX + slot * i + (slot - barW) / 2
        const y = padTop + chartH - h
        return (
          <g key={i}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={Math.max(h, d.value > 0 ? 2 : 0)}
              rx={5}
              className="bar"
            >
              <title>{`${d.label}: ${moneyShort(d.value, currency)}`}</title>
            </rect>
            {d.value > 0 && (
              <text x={x + barW / 2} y={y - 6} className="bar-value" textAnchor="middle">
                {moneyShort(d.value, currency)}
              </text>
            )}
            <text
              x={padX + slot * i + slot / 2}
              y={H - 8}
              className="bar-label"
              textAnchor="middle"
            >
              {d.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

const STATUS_COLORS: Record<string, string> = {
  paid: 'var(--ok)',
  sent: 'var(--accent)',
  overdue: 'var(--danger)',
  draft: 'var(--muted-strong)',
}

export function DonutChart({
  segments,
  size = 160,
}: {
  segments: { label: string; value: number; key: string }[]
  size?: number
}) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  const r = 60
  const c = 2 * Math.PI * r
  const cx = size / 2
  const cy = size / 2
  let offset = 0

  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="donut" role="img">
      <circle cx={cx} cy={cy} r={r} className="donut-track" fill="none" strokeWidth={18} />
      {total > 0 &&
        segments.map((seg) => {
          const frac = seg.value / total
          const len = frac * c
          const dash = `${len} ${c - len}`
          const el = (
            <circle
              key={seg.key}
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              strokeWidth={18}
              stroke={STATUS_COLORS[seg.key] ?? 'var(--accent)'}
              strokeDasharray={dash}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${cx} ${cy})`}
            >
              <title>{`${seg.label}: ${seg.value}`}</title>
            </circle>
          )
          offset += len
          return el
        })}
      <text x={cx} y={cy - 4} textAnchor="middle" className="donut-total">
        {total}
      </text>
      <text x={cx} y={cy + 14} textAnchor="middle" className="donut-caption">
        invoices
      </text>
    </svg>
  )
}
