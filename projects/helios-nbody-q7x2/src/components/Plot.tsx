// A tiny rolling line-plot on a canvas. Auto-scales the y-axis to the visible
// data and draws a baseline at y = 0 when the range straddles it. Used for the
// energy-conservation and momentum diagnostics.

import { useEffect, useRef } from 'react'

export interface Series {
  color: string
  data: Float64Array
  /** Number of valid samples in `data` (a ring buffer fill count). */
  length: number
  /** Index of the oldest sample (ring start). */
  start: number
}

interface PlotProps {
  series: Series[]
  height?: number
  zeroBaseline?: boolean
  unit?: string
}

export function Plot({ series, height = 64, zeroBaseline = true, unit }: PlotProps) {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = canvas.clientWidth
    const h = height
    canvas.width = Math.max(1, Math.round(w * dpr))
    canvas.height = Math.max(1, Math.round(h * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(255,255,255,0.02)'
    ctx.fillRect(0, 0, w, h)

    // Find the combined min/max across all series.
    let lo = Infinity
    let hi = -Infinity
    let maxLen = 0
    for (const s of series) {
      maxLen = Math.max(maxLen, s.length)
      for (let k = 0; k < s.length; k++) {
        const idx = (s.start + k) % s.data.length
        const v = s.data[idx]
        if (!Number.isFinite(v)) continue
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || maxLen < 2) {
      ctx.fillStyle = 'rgba(255,255,255,0.25)'
      ctx.font = '11px ui-monospace, monospace'
      ctx.fillText('collecting…', 8, h / 2)
      return
    }
    if (zeroBaseline) {
      lo = Math.min(lo, 0)
      hi = Math.max(hi, 0)
    }
    if (hi - lo < 1e-12) {
      hi += 1
      lo -= 1
    }
    const pad = (hi - lo) * 0.1
    lo -= pad
    hi += pad

    const yOf = (v: number) => h - ((v - lo) / (hi - lo)) * h

    // Zero baseline.
    if (lo < 0 && hi > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, yOf(0))
      ctx.lineTo(w, yOf(0))
      ctx.stroke()
    }

    for (const s of series) {
      if (s.length < 2) continue
      ctx.strokeStyle = s.color
      ctx.lineWidth = 1.5
      ctx.beginPath()
      for (let k = 0; k < s.length; k++) {
        const idx = (s.start + k) % s.data.length
        const v = s.data[idx]
        const x = (k / (s.length - 1)) * w
        const y = yOf(v)
        if (k === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }

    // Range labels.
    ctx.fillStyle = 'rgba(255,255,255,0.4)'
    ctx.font = '10px ui-monospace, monospace'
    const fmt = (v: number) => (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(1) : v.toFixed(2))
    ctx.fillText(`${fmt(hi)}${unit ?? ''}`, 4, 11)
    ctx.fillText(`${fmt(lo)}${unit ?? ''}`, 4, h - 4)
  }, [series, height, zeroBaseline, unit])

  return <canvas className="plot" ref={ref} style={{ width: '100%', height }} />
}
