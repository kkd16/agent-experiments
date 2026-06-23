import type { SparklineValue } from '../engine/values'

interface Props {
  spark: SparklineValue
  width?: number
  height?: number
}

/** A tiny inline chart drawn in SVG — the visual payload of the SPARKLINE function. */
export default function Sparkline({ spark, width = 84, height = 18 }: Props) {
  const data = spark.data
  if (data.length === 0) return <span className="spark-empty">—</span>

  const min = Math.min(...data, 0)
  const max = Math.max(...data, 0)
  const span = max - min || 1
  const pad = 1

  if (spark.mode === 'line') {
    const stepX = data.length > 1 ? (width - pad * 2) / (data.length - 1) : 0
    const points = data
      .map((v, i) => {
        const x = pad + i * stepX
        const y = height - pad - ((v - min) / span) * (height - pad * 2)
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
    const lastX = pad + (data.length - 1) * stepX
    const lastY = height - pad - ((data[data.length - 1] - min) / span) * (height - pad * 2)
    return (
      <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <polyline points={points} fill="none" stroke="#5fd0ff" strokeWidth="1.5" strokeLinejoin="round" />
        <circle cx={lastX} cy={lastY} r="1.8" fill="#aef0ff" />
      </svg>
    )
  }

  // bar mode
  const n = data.length
  const gap = 1.5
  const barW = Math.max(1, (width - pad * 2 - gap * (n - 1)) / n)
  const zeroY = height - pad - ((0 - min) / span) * (height - pad * 2)
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {data.map((v, i) => {
        const x = pad + i * (barW + gap)
        const valueY = height - pad - ((v - min) / span) * (height - pad * 2)
        const top = Math.min(valueY, zeroY)
        const h = Math.max(1, Math.abs(valueY - zeroY))
        return <rect key={i} x={x} y={top} width={barW} height={h} fill={v < 0 ? '#ff8a8a' : '#7c9cff'} rx="0.5" />
      })}
    </svg>
  )
}
