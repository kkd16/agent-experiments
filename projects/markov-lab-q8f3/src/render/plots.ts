// Small self-contained canvas plots for the diagnostics rail: trace, marginal
// histogram, and the autocorrelation function. Each takes a 2-D context sized
// in CSS pixels (the caller handles DPI scaling).

import { autocorr, quantile } from '../diagnostics/diagnostics'
import type { ShapeGrids } from '../diagnostics/distance'
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

/** Overlaid traces of several chains — the head-to-head "who mixes faster". */
export function drawTraceMulti(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  seriesList: number[][],
  colors: string[],
) {
  clear(ctx, w, h)
  const win = 1200
  const windows = seriesList.map((s) => s.slice(Math.max(0, s.length - win)))
  let lo = Infinity
  let hi = -Infinity
  for (const data of windows)
    for (const v of data) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  if (!isFinite(lo) || !isFinite(hi)) return
  const pad = (hi - lo) * 0.08 || 1
  lo -= pad
  hi += pad
  const pl = 4
  windows.forEach((data, k) => {
    if (data.length < 2) return
    const n = data.length
    const toX = (i: number) => pl + (i / (n - 1)) * (w - 2 * pl)
    const toY = (v: number) => h - 4 - ((v - lo) / (hi - lo || 1)) * (h - 8)
    ctx.strokeStyle = colors[k]
    ctx.globalAlpha = 0.85
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(toX(0), toY(data[0]))
    for (let i = 1; i < n; i++) ctx.lineTo(toX(i), toY(data[i]))
    ctx.stroke()
  })
  ctx.globalAlpha = 1
}

/** Overlaid marginal histograms drawn as stroked outlines so neither hides. */
export function drawHistMulti(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  seriesList: number[][],
  colors: string[],
) {
  clear(ctx, w, h)
  const usable = seriesList.filter((s) => s.length >= 4)
  if (!usable.length) return
  // Shared range across all chains so the bins line up.
  let lo = Infinity
  let hi = -Infinity
  for (const s of usable) {
    lo = Math.min(lo, quantile(s, 0.005))
    hi = Math.max(hi, quantile(s, 0.995))
  }
  const bins = 44
  const width = hi - lo || 1
  const hist = (s: number[]) => {
    const counts = new Array<number>(bins).fill(0)
    for (const v of s) {
      let b = Math.floor(((v - lo) / width) * bins)
      if (b < 0) b = 0
      if (b >= bins) b = bins - 1
      counts[b]++
    }
    const maxC = Math.max(...counts) || 1
    return counts.map((c) => c / maxC) // normalise each to its own peak
  }
  const bw = (w - 8) / bins
  seriesList.forEach((s, k) => {
    if (s.length < 4) return
    const norm = hist(s)
    ctx.strokeStyle = colors[k]
    ctx.globalAlpha = 0.9
    ctx.lineWidth = 1.4
    ctx.beginPath()
    for (let i = 0; i < bins; i++) {
      const x = 4 + (i + 0.5) * bw
      const y = h - 4 - norm[i] * (h - 8)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  })
  ctx.globalAlpha = 1
}

/** Overlaid autocorrelation functions as lines — a direct mixing comparison. */
export function drawAcfMulti(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  seriesList: number[][],
  colors: string[],
  maxLag = 48,
) {
  clear(ctx, w, h)
  const pl = 4
  const zeroY = h * 0.5
  ctx.strokeStyle = AXIS
  ctx.beginPath()
  ctx.moveTo(pl, zeroY)
  ctx.lineTo(w - pl, zeroY)
  ctx.stroke()
  seriesList.forEach((series, k) => {
    if (series.length < 8) return
    const lag = Math.min(maxLag, series.length - 1)
    const rho = autocorr(series, lag)
    const bw = (w - 2 * pl) / (lag + 1)
    ctx.strokeStyle = colors[k]
    ctx.globalAlpha = 0.9
    ctx.lineWidth = 1.4
    ctx.beginPath()
    for (let i = 0; i <= lag; i++) {
      const x = pl + i * bw
      const y = zeroY - rho[i] * (h * 0.5 - 4)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  })
  ctx.globalAlpha = 1
}

/**
 * Running-mean convergence: each chain's whole-chain mean estimate vs. the
 * number of iterations, with a dashed line at the true value when known. The
 * curves should settle onto that line — and in Race mode you see which sampler
 * gets there first. The x-axis is log-scaled so early progress stays legible.
 */
export function drawConvergence(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  iters: number[][],
  vals: number[][],
  colors: string[],
  truth?: number,
) {
  clear(ctx, w, h)
  // Combined ranges across every lane (and the truth line).
  let vlo = Infinity
  let vhi = -Infinity
  let imax = 0
  for (const s of vals) for (const v of s) {
    if (v < vlo) vlo = v
    if (v > vhi) vhi = v
  }
  for (const s of iters) if (s.length) imax = Math.max(imax, s[s.length - 1])
  if (!isFinite(vlo) || !isFinite(vhi) || imax < 2) return
  if (truth !== undefined) {
    vlo = Math.min(vlo, truth)
    vhi = Math.max(vhi, truth)
  }
  const pad = (vhi - vlo) * 0.12 || 1
  vlo -= pad
  vhi += pad
  const pl = 4
  const logMax = Math.log10(Math.max(10, imax))
  const toX = (it: number) => pl + (Math.log10(Math.max(1, it)) / logMax) * (w - 2 * pl)
  const toY = (v: number) => h - 4 - ((v - vlo) / (vhi - vlo || 1)) * (h - 8)

  if (truth !== undefined) {
    ctx.strokeStyle = 'rgba(255,255,255,0.28)'
    ctx.setLineDash([4, 3])
    ctx.beginPath()
    ctx.moveTo(pl, toY(truth))
    ctx.lineTo(w - pl, toY(truth))
    ctx.stroke()
    ctx.setLineDash([])
  }
  vals.forEach((series, k) => {
    const it = iters[k]
    if (!series || series.length < 2) return
    ctx.strokeStyle = colors[k]
    ctx.globalAlpha = 0.9
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.moveTo(toX(it[0]), toY(series[0]))
    for (let i = 1; i < series.length; i++) ctx.lineTo(toX(it[i]), toY(series[i]))
    ctx.stroke()
  })
  ctx.globalAlpha = 1
}

/**
 * The "shape error" map: the signed discrepancy (empirical − reference) of the
 * sampled distribution, drawn as a diverging heatmap over the target's view.
 * Red = the sampler over-visits this region, blue = it under-visits it, black =
 * a match. A chain trapped in one mode glows red there and leaves the abandoned
 * modes blue. The TV distance is printed in the corner. `null` grids (too few
 * samples yet) draw a quiet "warming up" placeholder.
 */
export function drawShapeError(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  grids: ShapeGrids | null,
) {
  clear(ctx, w, h)
  if (!grids) {
    ctx.fillStyle = 'rgba(255,255,255,0.28)'
    ctx.font = '11px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('warming up…', w / 2, h / 2)
    ctx.textAlign = 'start'
    return
  }
  const { res, ref, emp } = grids
  // Symmetric colour scale from the largest single-cell discrepancy, with a
  // gentle floor so a near-perfect match doesn't amplify pure sampling noise.
  let maxAbs = 1e-4
  for (let k = 0; k < ref.length; k++) {
    const dd = Math.abs(emp[k] - ref[k])
    if (dd > maxAbs) maxAbs = dd
  }
  const img = ctx.createImageData(res, res)
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      // Grid row 0 is the bottom of the view; canvas row 0 is the top.
      const gk = (res - 1 - j) * res + i
      const t = Math.max(-1, Math.min(1, (emp[gk] - ref[gk]) / maxAbs))
      // A perceptual-ish diverging ramp: blue (under) → near-black → red (over).
      const mag = Math.pow(Math.abs(t), 0.6)
      let r: number
      let g: number
      let b: number
      if (t >= 0) {
        r = 20 + mag * 235
        g = 20 + mag * 70
        b = 24
      } else {
        r = 24
        g = 26 + mag * 90
        b = 30 + mag * 225
      }
      const p = (j * res + i) * 4
      img.data[p] = r
      img.data[p + 1] = g
      img.data[p + 2] = b
      img.data[p + 3] = 255
    }
  }
  // Blit the small grid up to the card, nearest-neighbour, via an offscreen.
  const off = document.createElement('canvas')
  off.width = res
  off.height = res
  off.getContext('2d')!.putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(off, 0, 0, res, res, 0, 0, w, h)
  ctx.imageSmoothingEnabled = true

  // TV read-out.
  ctx.fillStyle = 'rgba(0,0,0,0.45)'
  ctx.fillRect(4, 4, 74, 16)
  ctx.fillStyle = grids.tv < 0.1 ? '#7ce0a0' : grids.tv < 0.25 ? '#ffd166' : '#ff6b8a'
  ctx.font = '11px ui-monospace, monospace'
  ctx.fillText(`TV ${grids.tv.toFixed(3)}`, 8, 16)
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
