// Small self-contained canvas plots for the diagnostics rail: trace, marginal
// histogram, and the autocorrelation function. Each takes a 2-D context sized
// in CSS pixels (the caller handles DPI scaling).

import { autocorr, quantile } from '../diagnostics/diagnostics'
import { ACCENT, ACCENT_WARM } from './colormap'

const GRID = 'rgba(255,255,255,0.06)'
const AXIS = 'rgba(255,255,255,0.22)'

function clear(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = 'rgba(255,255,255,0.02)'
  ctx.fillRect(0, 0, w, h)
}

/** A running trace of one coordinate — the classic "hairy caterpillar". */
export function drawTrace(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  series: number[],
  color = ACCENT,
) {
  clear(ctx, w, h)
  if (series.length < 2) return
  // Show the most recent window so the caterpillar stays legible.
  const win = Math.min(series.length, 1200)
  const data = series.slice(series.length - win)
  let lo = Infinity
  let hi = -Infinity
  for (const v of data) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  const pad = (hi - lo) * 0.08 || 1
  lo -= pad
  hi += pad
  const pl = 4
  const toX = (i: number) => pl + (i / (win - 1)) * (w - 2 * pl)
  const toY = (v: number) => h - 4 - ((v - lo) / (hi - lo || 1)) * (h - 8)

  // mean line
  const m = data.reduce((a, b) => a + b, 0) / data.length
  ctx.strokeStyle = GRID
  ctx.beginPath()
  ctx.moveTo(pl, toY(m))
  ctx.lineTo(w - pl, toY(m))
  ctx.stroke()

  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(toX(0), toY(data[0]))
  for (let i = 1; i < win; i++) ctx.lineTo(toX(i), toY(data[i]))
  ctx.stroke()
}

/** Marginal histogram of one coordinate. */
export function drawHistogram(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  series: number[],
  color = ACCENT_WARM,
) {
  clear(ctx, w, h)
  if (series.length < 4) return
  const lo = quantile(series, 0.005)
  const hi = quantile(series, 0.995)
  const bins = 44
  const counts = new Array<number>(bins).fill(0)
  const width = hi - lo || 1
  for (const v of series) {
    let b = Math.floor(((v - lo) / width) * bins)
    if (b < 0) b = 0
    if (b >= bins) b = bins - 1
    counts[b]++
  }
  const maxC = Math.max(...counts) || 1
  const bw = (w - 8) / bins
  for (let i = 0; i < bins; i++) {
    const bh = (counts[i] / maxC) * (h - 8)
    const x = 4 + i * bw
    const grad = ctx.createLinearGradient(0, h - 4 - bh, 0, h - 4)
    grad.addColorStop(0, color)
    grad.addColorStop(1, 'rgba(255,181,74,0.15)')
    ctx.fillStyle = grad
    ctx.fillRect(x, h - 4 - bh, Math.max(1, bw - 1), bh)
  }
}

/** Autocorrelation function — how fast the chain forgets where it was. */
export function drawAcf(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  series: number[],
  maxLag = 48,
  color = ACCENT,
) {
  clear(ctx, w, h)
  if (series.length < 8) return
  const lag = Math.min(maxLag, series.length - 1)
  const rho = autocorr(series, lag)
  const pl = 4
  const zeroY = h * 0.5
  const bw = (w - 2 * pl) / (lag + 1)
  // zero axis
  ctx.strokeStyle = AXIS
  ctx.beginPath()
  ctx.moveTo(pl, zeroY)
  ctx.lineTo(w - pl, zeroY)
  ctx.stroke()
  for (let k = 0; k <= lag; k++) {
    const x = pl + k * bw
    const bh = rho[k] * (h * 0.5 - 4)
    ctx.fillStyle = k === 0 ? 'rgba(255,255,255,0.5)' : color
    ctx.fillRect(x, zeroY - Math.max(bh, 0), Math.max(1, bw - 1), Math.abs(bh))
    if (bh < 0) ctx.fillRect(x, zeroY, Math.max(1, bw - 1), -bh)
  }
}
