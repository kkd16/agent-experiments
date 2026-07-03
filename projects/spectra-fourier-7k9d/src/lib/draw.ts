// Small canvas drawing helpers shared by the analysis modes. All coordinates are
// CSS pixels (the context is pre-scaled for devicePixelRatio by prepareContext).

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const GRID = 'rgba(120,140,220,0.12)'
const AXIS = 'rgba(120,140,220,0.28)'
const LABEL = 'rgba(154,166,212,0.85)'

export function fillPlotBg(ctx: CanvasRenderingContext2D, r: Rect) {
  ctx.fillStyle = 'rgba(6,9,20,0.55)'
  ctx.fillRect(r.x, r.y, r.w, r.h)
}

export function grid(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  cols: number,
  rows: number,
) {
  ctx.strokeStyle = GRID
  ctx.lineWidth = 1
  for (let i = 0; i <= cols; i++) {
    const x = r.x + (i / cols) * r.w
    ctx.beginPath()
    ctx.moveTo(x, r.y)
    ctx.lineTo(x, r.y + r.h)
    ctx.stroke()
  }
  for (let j = 0; j <= rows; j++) {
    const y = r.y + (j / rows) * r.h
    ctx.beginPath()
    ctx.moveTo(r.x, y)
    ctx.lineTo(r.x + r.w, y)
    ctx.stroke()
  }
}

export function zeroLine(ctx: CanvasRenderingContext2D, r: Rect) {
  ctx.strokeStyle = AXIS
  ctx.lineWidth = 1.2
  const y = r.y + r.h / 2
  ctx.beginPath()
  ctx.moveTo(r.x, y)
  ctx.lineTo(r.x + r.w, y)
  ctx.stroke()
}

/** Line plot of a symmetric signal in [-range, range] mapped to the rect. */
export function linePlot(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  data: ArrayLike<number>,
  range: number,
  color: string,
  lineWidth = 2,
) {
  const n = data.length
  if (n === 0) return
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.lineJoin = 'round'
  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const x = r.x + (i / (n - 1)) * r.w
    const norm = Math.max(-1, Math.min(1, data[i] / range))
    const y = r.y + r.h / 2 - norm * (r.h / 2) * 0.94
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
}

/** Filled area under a non-negative curve mapped to [0, max] over the rect. */
export function areaPlot(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  data: ArrayLike<number>,
  max: number,
  stroke: string,
  fill: string,
) {
  const n = data.length
  if (n === 0 || max <= 0) return
  ctx.beginPath()
  ctx.moveTo(r.x, r.y + r.h)
  for (let i = 0; i < n; i++) {
    const x = r.x + (i / (n - 1)) * r.w
    const norm = Math.max(0, Math.min(1, data[i] / max))
    const y = r.y + r.h - norm * r.h * 0.96
    ctx.lineTo(x, y)
  }
  ctx.lineTo(r.x + r.w, r.y + r.h)
  ctx.closePath()
  ctx.fillStyle = fill
  ctx.fill()
  ctx.strokeStyle = stroke
  ctx.lineWidth = 1.8
  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const x = r.x + (i / (n - 1)) * r.w
    const norm = Math.max(0, Math.min(1, data[i] / max))
    const y = r.y + r.h - norm * r.h * 0.96
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
}

export function axisLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  align: CanvasTextAlign = 'left',
) {
  ctx.fillStyle = LABEL
  ctx.font = '11px JetBrains Mono, ui-monospace, monospace'
  ctx.textAlign = align
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(text, x, y)
}

// --- raster painting: blit a small pixel buffer scaled up to a destination rect ---

export interface DrawSize {
  width: number
  height: number
  dpr: number
}

/** Blit a grayscale field (0..1, row-major w×h) into `ctx`, scaled to fill the rect. */
export function paintGray(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  gray: ArrayLike<number>,
  w: number,
  h: number,
  smooth = false,
) {
  const off = document.createElement('canvas')
  off.width = w
  off.height = h
  const octx = off.getContext('2d')
  if (!octx) return
  const img = octx.createImageData(w, h)
  for (let i = 0; i < w * h; i++) {
    const v = Math.max(0, Math.min(255, Math.round(gray[i] * 255)))
    img.data[i * 4] = v
    img.data[i * 4 + 1] = v
    img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  octx.putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = smooth
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(off, 0, 0, w, h, r.x, r.y, r.w, r.h)
}

/** Blit a normalized field (0..1) through a 256-entry RGBA LUT, scaled to the rect. */
export function paintColormap(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  data: ArrayLike<number>,
  w: number,
  h: number,
  lut: Uint8ClampedArray,
  smooth = true,
) {
  const off = document.createElement('canvas')
  off.width = w
  off.height = h
  const octx = off.getContext('2d')
  if (!octx) return
  const img = octx.createImageData(w, h)
  for (let i = 0; i < w * h; i++) {
    const li = (Math.max(0, Math.min(255, Math.round(data[i] * 255))) & 255) * 4
    img.data[i * 4] = lut[li]
    img.data[i * 4 + 1] = lut[li + 1]
    img.data[i * 4 + 2] = lut[li + 2]
    img.data[i * 4 + 3] = 255
  }
  octx.putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = smooth
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(off, 0, 0, w, h, r.x, r.y, r.w, r.h)
}
