// Draw a WorldMap onto a 2D canvas. Layers, bottom to top: biome-filled Voronoi
// cells (with Lambert hillshade from the elevation gradient), coastline, rivers
// tapered by √flux, optional faint region borders, place labels, and a paper-grain
// + vignette finish. All drawing is in world units (0..width, 0..height); the
// caller is expected to have applied any device-pixel-ratio scaling already.

import type { WorldMap } from '../core/types'
import type { Palette, RGB } from './palettes'
import { rgbToCss } from './palettes'
import { Rng } from '../core/rng'

export interface RenderOptions {
  palette: Palette
  showRivers: boolean
  showCoast: boolean
  showHillshade: boolean
  showBorders: boolean
  showLabels: boolean
  showGrain: boolean
}

const nextHalfedge = (e: number): number => (e % 3 === 2 ? e - 2 : e + 1)
const triangleOfEdge = (e: number): number => Math.floor(e / 3)
const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v)

/** Per-region Lambert shade factor from the local elevation gradient. */
function computeShade(world: WorldMap, strength: number): Float32Array {
  const { mesh, elevation } = world
  const shade = new Float32Array(mesh.numRegions).fill(1)
  const H = 170 * strength // elevation → pixel-height exaggeration
  // Light from the upper-left, fairly high in the sky.
  let lx = -0.6
  let ly = -0.85
  let lz = 1.1
  const ll = Math.hypot(lx, ly, lz)
  lx /= ll
  ly /= ll
  lz /= ll
  for (let r = 0; r < mesh.numSolid; r++) {
    const nb = mesh.neighbors[r]
    if (nb.length === 0) continue
    let gx = 0
    let gy = 0
    for (const j of nb) {
      const dx = mesh.px[j] - mesh.px[r]
      const dy = mesh.py[j] - mesh.py[r]
      const l2 = dx * dx + dy * dy || 1
      const de = (elevation[j] - elevation[r]) * H
      gx += (de * dx) / l2
      gy += (de * dy) / l2
    }
    gx /= nb.length
    gy /= nb.length
    const nl = Math.hypot(gx, gy, 1)
    const d = (-gx * lx - gy * ly + lz) / nl // dot(normal, light)
    let f = 0.72 + d * 0.62
    if (f < 0.5) f = 0.5
    if (f > 1.45) f = 1.45
    shade[r] = f
  }
  return shade
}

function fillCell(ctx: CanvasRenderingContext2D, world: WorldMap, r: number): void {
  const tris = world.mesh.cellTriangles[r]
  if (tris.length < 3) return
  const { cx, cy } = world.mesh
  ctx.beginPath()
  ctx.moveTo(cx[tris[0]], cy[tris[0]])
  for (let k = 1; k < tris.length; k++) ctx.lineTo(cx[tris[k]], cy[tris[k]])
  ctx.closePath()
  ctx.fill()
  // A hairline stroke in the same colour hides sub-pixel seams between cells.
  ctx.stroke()
}

function drawCells(ctx: CanvasRenderingContext2D, world: WorldMap, opts: RenderOptions): void {
  const { mesh, ocean, biome, elevation, params } = world
  const pal = opts.palette
  const seaLevel = params.seaLevel
  const denom = 1 - seaLevel || 1
  const shade = opts.showHillshade ? computeShade(world, pal.hillshade) : null

  for (let r = 0; r < mesh.numSolid; r++) {
    let col: RGB
    if (ocean[r]) {
      const depth = Math.min(1, Math.max(0, (seaLevel - elevation[r]) / (seaLevel || 1)))
      col = pal.ocean(depth)
    } else {
      const above = Math.max(0, elevation[r] - seaLevel) / denom
      col = pal.land(biome[r], above, world.moisture[r])
      if (shade) {
        const f = shade[r]
        col = [col[0] * f, col[1] * f, col[2] * f]
      }
    }
    const css = rgbToCss([clampByte(col[0]), clampByte(col[1]), clampByte(col[2])])
    ctx.fillStyle = css
    ctx.strokeStyle = css
    ctx.lineWidth = 0.7
    fillCell(ctx, world, r)
  }
}

function drawCoast(ctx: CanvasRenderingContext2D, world: WorldMap, pal: Palette): void {
  const { mesh, ocean } = world
  const tri = mesh.triangles
  const half = mesh.halfedges
  ctx.strokeStyle = pal.coast
  ctx.lineWidth = 1.4
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.beginPath()
  for (let e = 0; e < tri.length; e++) {
    const opp = half[e]
    if (opp === -1) continue
    if (opp < e) continue // draw each Voronoi edge once
    const a = tri[e]
    const b = tri[nextHalfedge(e)]
    if (ocean[a] === ocean[b]) continue
    const t1 = triangleOfEdge(e)
    const t2 = triangleOfEdge(opp)
    ctx.moveTo(mesh.cx[t1], mesh.cy[t1])
    ctx.lineTo(mesh.cx[t2], mesh.cy[t2])
  }
  ctx.stroke()
}

function drawBorders(ctx: CanvasRenderingContext2D, world: WorldMap, pal: Palette): void {
  const { mesh, ocean } = world
  const tri = mesh.triangles
  const half = mesh.halfedges
  ctx.strokeStyle = pal.border
  ctx.lineWidth = 0.5
  ctx.beginPath()
  for (let e = 0; e < tri.length; e++) {
    const opp = half[e]
    if (opp === -1 || opp < e) continue
    const a = tri[e]
    const b = tri[nextHalfedge(e)]
    if (ocean[a] && ocean[b]) continue // skip open water
    const t1 = triangleOfEdge(e)
    const t2 = triangleOfEdge(opp)
    ctx.moveTo(mesh.cx[t1], mesh.cy[t1])
    ctx.lineTo(mesh.cx[t2], mesh.cy[t2])
  }
  ctx.stroke()
}

function drawRivers(ctx: CanvasRenderingContext2D, world: WorldMap, pal: Palette): void {
  const { mesh, rivers } = world
  if (rivers.length === 0) return
  let maxF = 0
  for (const rv of rivers) if (rv.flux > maxF) maxF = rv.flux
  ctx.strokeStyle = pal.water
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const rv of rivers) {
    const w = 0.6 + 3.4 * Math.sqrt(rv.flux / (maxF || 1))
    ctx.lineWidth = w
    ctx.beginPath()
    ctx.moveTo(mesh.px[rv.a], mesh.py[rv.a])
    ctx.lineTo(mesh.px[rv.b], mesh.py[rv.b])
    ctx.stroke()
  }
}

function drawLabels(ctx: CanvasRenderingContext2D, world: WorldMap, pal: Palette): void {
  const W = world.params.width
  const H = world.params.height
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const l of world.labels) {
    let size: number
    let style = ''
    if (l.kind === 'kingdom') size = 15 + 15 * l.weight
    else if (l.kind === 'range') {
      size = 11 + 6 * l.weight
      style = 'italic '
    } else {
      size = 14 + 6 * l.weight
      style = 'italic '
    }
    ctx.font = `${style}600 ${size.toFixed(1)}px Georgia, "Times New Roman", serif`
    // Keep the whole label on the canvas even when its anchor is near an edge.
    const halfW = ctx.measureText(l.text).width / 2 + 4
    const x = Math.min(W - halfW, Math.max(halfW, l.x))
    const y = Math.min(H - size, Math.max(size, l.y))
    ctx.lineWidth = Math.max(2, size * 0.16)
    ctx.strokeStyle = pal.labelStroke
    ctx.lineJoin = 'round'
    ctx.strokeText(l.text, x, y)
    ctx.fillStyle = pal.labelFill
    ctx.fillText(l.text, x, y)
  }
}

/** Cached-per-call paper grain: a small noise tile tiled over the whole map. */
function drawGrain(
  ctx: CanvasRenderingContext2D,
  world: WorldMap,
  pal: Palette,
): void {
  const W = world.params.width
  const H = world.params.height
  const size = 128
  let tile: HTMLCanvasElement | null = null
  try {
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas')
      c.width = size
      c.height = size
      tile = c
    }
  } catch {
    tile = null
  }
  if (!tile) return
  const tctx = tile.getContext('2d')
  if (!tctx) return
  const img = tctx.createImageData(size, size)
  const rng = new Rng(`${world.params.seed}:grain`)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (rng.next() - 0.5) * 255
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v
    img.data[i + 3] = 255
  }
  tctx.putImageData(img, 0, 0)
  const pattern = ctx.createPattern(tile, 'repeat')
  if (!pattern) return
  ctx.save()
  ctx.globalAlpha = pal.grain
  ctx.globalCompositeOperation = 'soft-light'
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, W, H)
  ctx.restore()
}

function drawVignette(ctx: CanvasRenderingContext2D, world: WorldMap): void {
  const W = world.params.width
  const H = world.params.height
  const g = ctx.createRadialGradient(
    W / 2,
    H / 2,
    Math.min(W, H) * 0.35,
    W / 2,
    H / 2,
    Math.max(W, H) * 0.75,
  )
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(1, 'rgba(0,0,0,0.22)')
  ctx.save()
  ctx.globalCompositeOperation = 'multiply'
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
  ctx.restore()
}

export function renderWorld(
  ctx: CanvasRenderingContext2D,
  world: WorldMap,
  opts: RenderOptions,
): void {
  const W = world.params.width
  const H = world.params.height
  ctx.save()
  ctx.fillStyle = opts.palette.background
  ctx.fillRect(0, 0, W, H)

  drawCells(ctx, world, opts)
  if (opts.showBorders) drawBorders(ctx, world, opts.palette)
  if (opts.showCoast) drawCoast(ctx, world, opts.palette)
  if (opts.showRivers) drawRivers(ctx, world, opts.palette)
  if (opts.showLabels) drawLabels(ctx, world, opts.palette)
  if (opts.showGrain) drawGrain(ctx, world, opts.palette)
  drawVignette(ctx, world)
  ctx.restore()
}
