// The renderer. It draws a whole Project (a stack of layers) into a canvas or
// into an SVG string. All layers share one auto-fit transform so they stay
// registered; each layer is stroked in chunks, colored by its color mode and
// optionally given speed-driven width, glow and a blend mode. An optional
// `trace` (0..1) reveals the curve progressively for the animated drawing pass.

import type { LayerData, Point } from './harmonograph'
import type { ColorMode, Layer, LayerStyle, Project, StereoMode } from './types'
import { renderDensity } from './density'
import { computeLayerData, is3dKind, layerCamera, patchLayerCamera } from './curves'
import { chainAt, epicyclesForShape } from './fourier'

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
  transform?: Transform // override auto-fit (Live mode freezes framing)
  densityQuality?: number // 0..1 iteration-budget scale for density layers
  overlays?: boolean // draw annotations (the Fourier epicycle chain); default true
}

function layerLimit(n: number, trace: number): number {
  if (trace >= 1) return n - 1
  return Math.max(1, Math.floor(clamp01(trace) * (n - 1)))
}

// The radial / mirror copies a layer is stamped through. Each copy is a 2D
// transform (rotation + optional horizontal flip) about the canvas centre.
function symmetryCopies(style: LayerStyle): { rot: number; flip: boolean }[] {
  const sym = Math.max(1, Math.round(style.symmetry ?? 1))
  const mirror = style.mirror ?? false
  const copies: { rot: number; flip: boolean }[] = []
  for (let k = 0; k < sym; k++) {
    const rot = (k * 2 * Math.PI) / sym
    copies.push({ rot, flip: false })
    if (mirror) copies.push({ rot, flip: true })
  }
  return copies
}

function strokeCurve(
  ctx: CanvasRenderingContext2D,
  data: LayerData,
  style: LayerStyle,
  tf: Transform,
  size: number,
  trace: number,
) {
  const pts = data.points
  const breaks = data.breaks
  const n = pts.length
  const limit = layerLimit(n, trace)
  const widthScale = size / FIELD
  const per = Math.max(1, Math.ceil(n / CHUNKS))
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
      // A pen-up break starts a fresh sub-path (branching plants/trees) rather
      // than drawing a connecting chord back to the branch point.
      if (breaks?.[i]) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
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
}

// The Fourier epicycle overlay: the nested chain of rotating circles that draws
// the shape. Drawn once (not per kaleidoscope copy), in base orientation, on top
// of the stroke. The chain tip sits at draw-parameter `u = trace`, so it rides
// the existing Play (pen-drawing) animation — the circles orbit and trace out the
// figure. Pure annotation: a contrasting colour independent of the palette.
function drawEpicycles(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  tf: Transform,
  size: number,
  trace: number,
) {
  const f = layer.fourier
  if (!f || !f.epicycles) return
  const eps = epicyclesForShape(f.shape)
  const k = Math.max(1, Math.min(Math.round(f.harmonics), eps.length))
  // At trace = 1 the pen has closed the loop; snapshot the start arrangement.
  const u = trace >= 1 ? 0 : trace
  const chain = chainAt(eps, k, u, f.phase)
  const widthScale = size / FIELD
  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  // The faint circles, one per rotating vector.
  ctx.strokeStyle = 'rgba(255,255,255,0.16)'
  ctx.lineWidth = Math.max(0.6 * widthScale, 0.4)
  for (let i = 0; i < chain.length - 1; i++) {
    const c = toPixel(chain[i], tf)
    const next = chain[i + 1]
    const r = Math.hypot(next.x - chain[i].x, next.y - chain[i].y) * tf.scale
    if (r < 0.4) continue
    ctx.beginPath()
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2)
    ctx.stroke()
  }

  // The radial arms (the vectors themselves), brighter.
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'
  ctx.lineWidth = Math.max(0.9 * widthScale, 0.6)
  ctx.beginPath()
  for (let i = 0; i < chain.length; i++) {
    const p = toPixel(chain[i], tf)
    if (i === 0) ctx.moveTo(p.x, p.y)
    else ctx.lineTo(p.x, p.y)
  }
  ctx.stroke()

  // The pen tip — a glowing dot where the chain meets the curve.
  const tip = toPixel(chain[chain.length - 1], tf)
  ctx.fillStyle = '#ffffff'
  ctx.shadowColor = 'rgba(255,255,255,0.9)'
  ctx.shadowBlur = 10 * widthScale
  ctx.beginPath()
  ctx.arc(tip.x, tip.y, Math.max(2.4 * widthScale, 1.8), 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function drawLayer(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  data: LayerData,
  tf: Transform,
  size: number,
  trace: number,
  densityQuality: number,
  overlays: boolean,
) {
  const style = layer.style
  if (data.points.length < 2) return
  const copies = symmetryCopies(style)
  const dim = copies.length > 1 ? 0.92 : 1
  const cx = size / 2
  const cy = size / 2

  // Density field: render the histogram once into an offscreen canvas, then
  // stamp it through the same blend / opacity / kaleidoscope copies as a stroke.
  if (style.renderStyle === 'density') {
    const result = renderDensity(layer, data, tf, size, trace, densityQuality)
    if (!result) return
    for (const copy of copies) {
      ctx.save()
      ctx.globalCompositeOperation = style.blend
      ctx.globalAlpha = style.opacity * dim
      ctx.translate(cx, cy)
      ctx.rotate(copy.rot)
      if (copy.flip) ctx.scale(-1, 1)
      ctx.translate(-cx, -cy)
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(result.canvas, 0, 0, size, size)
      ctx.restore()
    }
    return
  }

  for (const copy of copies) {
    ctx.save()
    ctx.globalCompositeOperation = style.blend
    ctx.globalAlpha = style.opacity * dim
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.translate(cx, cy)
    ctx.rotate(copy.rot)
    if (copy.flip) ctx.scale(-1, 1)
    ctx.translate(-cx, -cy)
    strokeCurve(ctx, data, style, tf, size, trace)
    ctx.restore()
  }

  if (overlays && layer.kind === 'fourier') drawEpicycles(ctx, layer, tf, size, trace)
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

// Resolve the canvas background: a flat color, or a linear / radial gradient
// between `background` and `bg2`.
function backgroundFill(
  ctx: CanvasRenderingContext2D,
  project: Project,
  size: number,
): string | CanvasGradient {
  const mode = project.bgMode ?? 'solid'
  const b2 = project.bg2 ?? project.background
  if (mode === 'linear') {
    const g = ctx.createLinearGradient(0, 0, size, size)
    g.addColorStop(0, project.background)
    g.addColorStop(1, b2)
    return g
  }
  if (mode === 'radial') {
    const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.72)
    g.addColorStop(0, project.background)
    g.addColorStop(1, b2)
    return g
  }
  return project.background
}

// Draw the full scene (background + every visible layer + vignette) with a given
// shared transform. Extracted so the stereo path can render two eyes through it.
function drawSceneInto(
  ctx: CanvasRenderingContext2D,
  project: Project,
  datas: Map<string, LayerData>,
  size: number,
  tf: Transform,
  trace: number,
  dq: number,
  overlays: boolean,
) {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.clearRect(0, 0, size, size)
  ctx.fillStyle = backgroundFill(ctx, project, size)
  ctx.fillRect(0, 0, size, size)
  for (const layer of project.layers) {
    if (!layer.visible) continue
    const d = datas.get(layer.id)
    if (d) drawLayer(ctx, layer, d, tf, size, trace, dq, overlays)
  }
  drawVignette(ctx, size, project.vignette)
}

function hasVisible3d(project: Project): boolean {
  return project.layers.some((l) => l.visible && is3dKind(l.kind))
}

export function drawProject(
  ctx: CanvasRenderingContext2D,
  project: Project,
  datas: Map<string, LayerData>,
  size: number,
  opts: RenderOptions = {},
) {
  const trace = opts.trace ?? 1
  const dq = opts.densityQuality ?? 1
  const overlays = opts.overlays ?? true
  // The transform is shared across both eyes so the stereo pair stays registered,
  // and is always measured from the base (centre-eye) datas.
  const tf = opts.transform ?? computeTransform(project.layers, datas, size)

  const stereo = project.stereo ?? 'off'
  if (stereo !== 'off' && hasVisible3d(project)) {
    if (drawStereo(ctx, project, datas, size, tf, trace, dq, stereo, overlays)) return
    // fall through to mono if the offscreen buffers couldn't be created (sandbox)
  }
  drawSceneInto(ctx, project, datas, size, tf, trace, dq, overlays)
}

// Per-eye datas: re-project every 3D *line* layer from the eye-offset camera so
// it shows the right parallax (density 3D layers read their camera from the
// per-eye project clone instead — see `eyeProject`). 2D layers are shared.
function eyeDatas(
  project: Project,
  datas: Map<string, LayerData>,
  eyeYaw: number,
): Map<string, LayerData> {
  if (eyeYaw === 0) return datas
  const m = new Map(datas)
  for (const layer of project.layers) {
    if (!layer.visible || !is3dKind(layer.kind)) continue
    if (layer.style.renderStyle === 'density') continue // density reads the clone's camera
    const cam = layerCamera(layer)
    if (!cam) continue
    m.set(layer.id, computeLayerData(patchLayerCamera(layer, { yaw: cam.yaw + eyeYaw })))
  }
  return m
}

// Per-eye project clone: 3D layers get their camera yaw nudged so density layers
// (which read the camera straight off the layer) splat from the eye viewpoint.
function eyeProject(project: Project, eyeYaw: number): Project {
  if (eyeYaw === 0) return project
  return {
    ...project,
    layers: project.layers.map((l) => {
      if (!is3dKind(l.kind)) return l
      const cam = layerCamera(l)
      return cam ? patchLayerCamera(l, { yaw: cam.yaw + eyeYaw }) : l
    }),
  }
}

// Render the scene twice (left / right eye) into offscreen buffers and composite
// them: a red-cyan anaglyph, or a side-by-side pair (parallel or cross-eyed).
// Returns false if the offscreen buffers couldn't be created so the caller can
// gracefully fall back to a mono render. Both eyes share `tf`, so they register.
function drawStereo(
  ctx: CanvasRenderingContext2D,
  project: Project,
  datas: Map<string, LayerData>,
  size: number,
  tf: Transform,
  trace: number,
  dq: number,
  mode: StereoMode,
  overlays: boolean,
): boolean {
  const baseline = project.stereoBaseline ?? 0.08
  const half = baseline / 2
  let left: HTMLCanvasElement
  let right: HTMLCanvasElement
  try {
    left = document.createElement('canvas')
    right = document.createElement('canvas')
  } catch {
    return false
  }
  left.width = left.height = size
  right.width = right.height = size
  const lc = left.getContext('2d')
  const rc = right.getContext('2d')
  if (!lc || !rc) return false

  drawSceneInto(lc, eyeProject(project, -half), eyeDatas(project, datas, -half), size, tf, trace, dq, overlays)
  drawSceneInto(rc, eyeProject(project, +half), eyeDatas(project, datas, +half), size, tf, trace, dq, overlays)

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.clearRect(0, 0, size, size)

  if (mode === 'anaglyph') {
    // Colour anaglyph: red channel from the left eye, green+blue from the right.
    let lImg: ImageData
    let rImg: ImageData
    try {
      lImg = lc.getImageData(0, 0, size, size)
      rImg = rc.getImageData(0, 0, size, size)
    } catch {
      return false
    }
    const a = lImg.data
    const b = rImg.data
    for (let i = 0; i < a.length; i += 4) {
      // a[i] (left red) stays; pull green/blue from the right eye.
      a[i + 1] = b[i + 1]
      a[i + 2] = b[i + 2]
      a[i + 3] = 255
    }
    ctx.putImageData(lImg, 0, 0)
    return true
  }

  // Side-by-side: two half-width eyes. `crosseye` swaps them for free-viewing.
  const first = mode === 'crosseye' ? right : left
  const second = mode === 'crosseye' ? left : right
  ctx.fillStyle = project.background
  ctx.fillRect(0, 0, size, size)
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(first, 0, 0, size, size, 0, 0, size / 2, size)
  ctx.drawImage(second, 0, 0, size, size, size / 2, 0, size / 2, size)
  return true
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

    // Density layers are inherently raster — embed the tone-mapped histogram as
    // a base64 PNG <image>, stamped through the same symmetry copies as strokes.
    if (style.renderStyle === 'density') {
      const result = renderDensity(layer, data, tf, size, trace, opts.densityQuality ?? 1)
      if (!result) continue
      let href: string
      try {
        href = result.canvas.toDataURL('image/png')
      } catch {
        continue
      }
      const copies = symmetryCopies(style)
      const dim = copies.length > 1 ? 0.92 : 1
      const cx = size / 2
      const cy = size / 2
      const img = `<image href="${href}" x="0" y="0" width="${size}" height="${size}" preserveAspectRatio="none"/>`
      const stamped = copies
        .map((copy) => {
          const deg = (copy.rot * 180) / Math.PI
          const flip = copy.flip ? ' scale(-1 1)' : ''
          const tform = `translate(${cx} ${cy}) rotate(${deg.toFixed(3)})${flip} translate(${-cx} ${-cy})`
          return `<g transform="${tform}">${img}</g>`
        })
        .join('\n')
      groups.push(
        `<g style="mix-blend-mode:${style.blend}" opacity="${(style.opacity * dim).toFixed(3)}">\n${stamped}\n</g>`,
      )
      continue
    }

    const pts = data.points
    const dbreaks = data.breaks
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
        const move = i === start || dbreaks?.[i]
        d += `${move ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)} `
      }
      paths.push(
        `<path d="${d.trim()}" fill="none" stroke="${rgb(color)}" stroke-width="${Math.max(w, 0.2).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`,
      )
    }

    const copies = symmetryCopies(style)
    const dim = copies.length > 1 ? 0.92 : 1
    const cx = size / 2
    const cy = size / 2
    const wedge = paths.join('\n')
    const stamped = copies
      .map((copy) => {
        const deg = (copy.rot * 180) / Math.PI
        const flip = copy.flip ? ' scale(-1 1)' : ''
        const tform = `translate(${cx} ${cy}) rotate(${deg.toFixed(3)})${flip} translate(${-cx} ${-cy})`
        return `<g transform="${tform}">\n${wedge}\n</g>`
      })
      .join('\n')
    groups.push(
      `<g style="mix-blend-mode:${style.blend}" opacity="${(style.opacity * dim).toFixed(3)}"${filterAttr}>\n${stamped}\n</g>`,
    )
  }

  // Background: solid fill or a gradient def referenced by the backing rect.
  const bgMode = project.bgMode ?? 'solid'
  const bg2 = project.bg2 ?? project.background
  let bgFill = project.background
  if (bgMode === 'linear') {
    defs.push(
      `<linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${project.background}"/><stop offset="100%" stop-color="${bg2}"/></linearGradient>`,
    )
    bgFill = 'url(#bg)'
  } else if (bgMode === 'radial') {
    defs.push(
      `<radialGradient id="bg" cx="50%" cy="50%" r="72%"><stop offset="0%" stop-color="${project.background}"/><stop offset="100%" stop-color="${bg2}"/></radialGradient>`,
    )
    bgFill = 'url(#bg)'
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
<rect width="${size}" height="${size}" fill="${bgFill}"/>
${groups.join('\n')}
${vignette}
</svg>`
}
