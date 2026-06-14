// The renderer. It draws a whole Project (a stack of layers) into a canvas or
// into an SVG string. All layers share one auto-fit transform so they stay
// registered; each layer is stroked in chunks, colored by its color mode and
// optionally given speed-driven width, glow and a blend mode. An optional
// `trace` (0..1) reveals the curve progressively for the animated drawing pass.

import type { LayerData, Point } from './harmonograph'
import type { ColorMode, Layer, LayerStyle, Project } from './types'

// Field the base line widths are authored against; widths scale with render size.
const FIELD = 720
const CHUNKS = 240 // colored segments per layer — smooth gradients, cheap to draw

type RGB = [number, number, number]

function hexToRgb(hex: string): RGB {
  let h = hex.replace('#', '').trim()
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ]
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// Sample a multi-stop color ramp at t in [0,1].
function sampleRamp(colors: string[], t: number): RGB {
  if (colors.length === 0) return [255, 255, 255]
  if (colors.length === 1) return hexToRgb(colors[0])
  const x = clamp01(t) * (colors.length - 1)
  const i = Math.min(Math.floor(x), colors.length - 2)
  const f = x - i
  const a = hexToRgb(colors[i])
  const b = hexToRgb(colors[i + 1])
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ]
}

const rgb = (c: RGB) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`

// Pick the scalar a color mode maps into its ramp at point index i.
function scalarAt(mode: ColorMode, data: LayerData, i: number, n: number): number {
  switch (mode) {
    case 'velocity':
      return data.speed[i]
    case 'curvature':
      return data.curvature[i]
    case 'angle':
      return data.angle[i]
    case 'path':
    default:
      return n > 1 ? i / (n - 1) : 0
  }
}

export interface Transform {
  scale: number
  ox: number
  oy: number
}

// Fit all visible layers into the square canvas with padding, preserving aspect.
export function computeTransform(
  layers: Layer[],
  datas: Map<string, LayerData>,
  size: number,
): Transform {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const layer of layers) {
    if (!layer.visible) continue
    const d = datas.get(layer.id)
    if (!d) continue
    for (const p of d.points) {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
  }
  if (!Number.isFinite(minX)) {
    return { scale: size * 0.4, ox: size / 2, oy: size / 2 }
  }
  const pad = size * 0.08
  const usable = size - pad * 2
  const w = Math.max(maxX - minX, 1e-6)
  const h = Math.max(maxY - minY, 1e-6)
  const scale = usable / Math.max(w, h)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return { scale, ox: size / 2 - cx * scale, oy: size / 2 - cy * scale }
}

function toPixel(p: Point, tf: Transform): Point {
  return { x: tf.ox + p.x * tf.scale, y: tf.oy + p.y * tf.scale }
}

export interface RenderOptions {
  trace?: number // 0..1, default 1 (whole curve)
}

function layerLimit(n: number, trace: number): number {
  if (trace >= 1) return n - 1
  return Math.max(1, Math.floor(clamp01(trace) * (n - 1)))
}

function drawLayer(
  ctx: CanvasRenderingContext2D,
  data: LayerData,
  style: LayerStyle,
  tf: Transform,
  size: number,
  trace: number,
) {
  const pts = data.points
  const n = pts.length
  if (n < 2) return
  const limit = layerLimit(n, trace)
  const widthScale = size / FIELD
  const per = Math.max(1, Math.ceil(n / CHUNKS))

  ctx.save()
  ctx.globalCompositeOperation = style.blend
  ctx.globalAlpha = style.opacity
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  if (style.glow > 0) ctx.shadowBlur = style.glow * 26 * widthScale

  for (let start = 0; start < limit; start += per) {
    const end = Math.min(start + per + 1, limit + 1)
    if (end - start < 2) continue
    const mid = Math.min((start + end) >> 1, n - 1)
    const color = sampleRamp(style.colors, scalarAt(style.colorMode, data, mid, n))
    const colorStr = rgb(color)
    ctx.strokeStyle = colorStr
    if (style.glow > 0) ctx.shadowColor = colorStr
    let w = style.lineWidth * widthScale
    if (style.widthMode === 'speed') w *= 0.3 + 1.7 * data.speed[mid]
    ctx.lineWidth = Math.max(w, 0.2)
    ctx.beginPath()
    const f = toPixel(pts[start], tf)
    ctx.moveTo(f.x, f.y)
    for (let i = start + 1; i < end; i++) {
      const p = toPixel(pts[i], tf)
      ctx.lineTo(p.x, p.y)
    }
    ctx.stroke()
  }

  // Pen head while the drawing pass is in flight.
  if (trace < 1) {
    const head = toPixel(pts[limit], tf)
    const color = sampleRamp(style.colors, scalarAt(style.colorMode, data, limit, n))
    ctx.fillStyle = rgb(color)
    ctx.shadowColor = rgb(color)
    ctx.shadowBlur = 14 * widthScale
    ctx.beginPath()
    ctx.arc(head.x, head.y, Math.max(style.lineWidth * widthScale * 1.6, 2.2), 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

function drawVignette(ctx: CanvasRenderingContext2D, size: number, amount: number) {
  if (amount <= 0) return
  ctx.save()
  ctx.globalCompositeOperation = 'multiply'
  const g = ctx.createRadialGradient(
    size / 2,
    size / 2,
    size * 0.25,
    size / 2,
    size / 2,
    size * 0.72,
  )
  const edge = Math.round(255 * (1 - clamp01(amount)))
  g.addColorStop(0, 'rgb(255, 255, 255)')
  g.addColorStop(1, `rgb(${edge}, ${edge}, ${edge})`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  ctx.restore()
}

export function drawProject(
  ctx: CanvasRenderingContext2D,
  project: Project,
  datas: Map<string, LayerData>,
  size: number,
  opts: RenderOptions = {},
) {
  const trace = opts.trace ?? 1
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.clearRect(0, 0, size, size)
  ctx.fillStyle = project.background
  ctx.fillRect(0, 0, size, size)

  const tf = computeTransform(project.layers, datas, size)
  for (const layer of project.layers) {
    if (!layer.visible) continue
    const d = datas.get(layer.id)
    if (d) drawLayer(ctx, d, layer.style, tf, size, trace)
  }
  drawVignette(ctx, size, project.vignette)
}

// ---- SVG export -----------------------------------------------------------

export function toSvg(
  project: Project,
  datas: Map<string, LayerData>,
  size: number,
  opts: RenderOptions = {},
): string {
  const trace = opts.trace ?? 1
  const tf = computeTransform(project.layers, datas, size)
  const widthScale = size / FIELD
  const defs: string[] = []
  const groups: string[] = []
  let filterId = 0

  for (const layer of project.layers) {
    if (!layer.visible) continue
    const data = datas.get(layer.id)
    if (!data) continue
    const style = layer.style
    const pts = data.points
    const n = pts.length
    if (n < 2) continue
    const limit = layerLimit(n, trace)
    const per = Math.max(1, Math.ceil(n / CHUNKS))

    let filterAttr = ''
    if (style.glow > 0) {
      const fid = `glow${filterId++}`
      const dev = (style.glow * 26 * widthScale) / 3
      defs.push(
        `<filter id="${fid}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${dev.toFixed(2)}"/></filter>`,
      )
      filterAttr = ` filter="url(#${fid})"`
    }

    const paths: string[] = []
    for (let start = 0; start < limit; start += per) {
      const end = Math.min(start + per + 1, limit + 1)
      if (end - start < 2) continue
      const mid = Math.min((start + end) >> 1, n - 1)
      const color = sampleRamp(style.colors, scalarAt(style.colorMode, data, mid, n))
      let w = style.lineWidth * widthScale
      if (style.widthMode === 'speed') w *= 0.3 + 1.7 * data.speed[mid]
      let d = ''
      for (let i = start; i < end; i++) {
        const p = toPixel(pts[i], tf)
        d += `${i === start ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)} `
      }
      paths.push(
        `<path d="${d.trim()}" fill="none" stroke="${rgb(color)}" stroke-width="${Math.max(w, 0.2).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`,
      )
    }

    groups.push(
      `<g style="mix-blend-mode:${style.blend}" opacity="${style.opacity}"${filterAttr}>\n${paths.join('\n')}\n</g>`,
    )
  }

  let vignette = ''
  if (project.vignette > 0) {
    const edge = Math.round(255 * (1 - clamp01(project.vignette)))
    defs.push(
      `<radialGradient id="vig" cx="50%" cy="50%" r="62%"><stop offset="35%" stop-color="rgb(255,255,255)"/><stop offset="100%" stop-color="rgb(${edge},${edge},${edge})"/></radialGradient>`,
    )
    vignette = `<rect width="${size}" height="${size}" fill="url(#vig)" style="mix-blend-mode:multiply"/>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<defs>
${defs.join('\n')}
</defs>
<rect width="${size}" height="${size}" fill="${project.background}"/>
${groups.join('\n')}
${vignette}
</svg>`
}
