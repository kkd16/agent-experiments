// Draw a WorldMap onto a 2D canvas. Layers, bottom to top: biome-filled Voronoi
// cells (with Lambert hillshade), plate/province overlays, lakes, contours,
// coastline, rivers, roads, a lat/long graticule, place labels, city markers, and a
// framed-atlas finish (compass rose, scale bar, double border, paper grain, vignette).
// All drawing is in world units (0..width, 0..height); the caller applies any
// device-pixel-ratio scaling.

import type { WorldMap } from '../core/types'
import type { Palette, RGB } from './palettes'
import { rgbToCss } from './palettes'
import { computeContours, defaultLevels } from '../core/contours'
import type { Overlay, ViewOptions } from '../ui/viewOptions'
import { overlayLandColor } from './overlay'
import { Noise2D } from '../core/noise'
import { Rng } from '../core/rng'

export interface RenderOptions {
  palette: Palette
  view: ViewOptions
  /** Region index highlighted by the inspector, or null. */
  selected?: number | null
}

const nextHalfedge = (e: number): number => (e % 3 === 2 ? e - 2 : e + 1)
const triangleOfEdge = (e: number): number => Math.floor(e / 3)
const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v)

/** Golden-angle hue so adjacent province indices get well-separated colours. */
function provinceCss(i: number, pal: Palette, alpha?: number): string {
  const hue = (i * 137.508 + 20) % 360
  const a = alpha ?? pal.provinceAlpha
  return `hsla(${hue.toFixed(0)},${pal.provinceSat}%,${pal.provinceLum}%,${a})`
}

/** Per-region Lambert shade factor from the local elevation gradient. */
export function computeShade(world: WorldMap, strength: number): Float32Array {
  const { mesh, elevation } = world
  const shade = new Float32Array(mesh.numRegions).fill(1)
  const H = 170 * strength
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
    const d = (-gx * lx - gy * ly + lz) / nl
    let f = 0.72 + d * 0.62
    if (f < 0.5) f = 0.5
    if (f > 1.45) f = 1.45
    shade[r] = f
  }
  return shade
}

function cellPath(ctx: CanvasRenderingContext2D, world: WorldMap, r: number): boolean {
  const tris = world.mesh.cellTriangles[r]
  if (tris.length < 3) return false
  const { cx, cy } = world.mesh
  ctx.beginPath()
  ctx.moveTo(cx[tris[0]], cy[tris[0]])
  for (let k = 1; k < tris.length; k++) ctx.lineTo(cx[tris[k]], cy[tris[k]])
  ctx.closePath()
  return true
}

function fillCell(ctx: CanvasRenderingContext2D, world: WorldMap, r: number): void {
  if (!cellPath(ctx, world, r)) return
  ctx.fill()
  ctx.stroke() // hairline in the same colour hides sub-pixel seams
}

/** Base fill colour for one region (ocean depth / lake / shaded biome or overlay). */
export function regionColor(
  world: WorldMap,
  r: number,
  pal: Palette,
  shade: Float32Array | null,
  overlay: Overlay = 'none',
): RGB {
  const { ocean, lake, biome, elevation, params } = world
  const seaLevel = params.seaLevel
  const denom = 1 - seaLevel || 1
  let col: RGB
  if (ocean[r]) {
    const depth = Math.min(1, Math.max(0, (seaLevel - elevation[r]) / (seaLevel || 1)))
    col = pal.ocean(depth)
  } else if (lake[r]) {
    col = pal.lake ?? pal.ocean(0)
    if (shade) {
      const f = 0.85 + (shade[r] - 1) * 0.3
      col = [col[0] * f, col[1] * f, col[2] * f]
    }
  } else {
    const above = Math.max(0, elevation[r] - seaLevel) / denom
    col = overlay === 'none' ? pal.land(biome[r], above, world.moisture[r]) : overlayLandColor(world, r, overlay)
    if (shade) {
      // Data overlays keep only a gentle relief so the field colour stays legible.
      const f = overlay === 'none' ? shade[r] : 0.82 + (shade[r] - 1) * 0.45
      col = [col[0] * f, col[1] * f, col[2] * f]
    }
  }
  return [clampByte(col[0]), clampByte(col[1]), clampByte(col[2])]
}

function drawCells(ctx: CanvasRenderingContext2D, world: WorldMap, opts: RenderOptions): void {
  const { mesh } = world
  const pal = opts.palette
  const overlay = opts.view.overlay
  const shade = opts.view.showHillshade ? computeShade(world, pal.hillshade) : null
  for (let r = 0; r < mesh.numSolid; r++) {
    const css = rgbToCss(regionColor(world, r, pal, shade, overlay))
    ctx.fillStyle = css
    ctx.strokeStyle = css
    ctx.lineWidth = 0.7
    fillCell(ctx, world, r)
  }
}

/** Plate-tectonics overlay: tint each cell by plate, ink the boundaries. */
function drawPlates(ctx: CanvasRenderingContext2D, world: WorldMap): void {
  const { mesh, plateId, plateBoundary } = world
  if (plateId.length === 0) return
  ctx.lineWidth = 0.7
  for (let r = 0; r < mesh.numSolid; r++) {
    const p = plateId[r]
    if (p < 0) continue
    const hue = (p * 47 + 10) % 360
    const css = `hsla(${hue},55%,55%,0.18)`
    ctx.fillStyle = css
    ctx.strokeStyle = css
    fillCell(ctx, world, r)
  }
  // Boundary ink: Voronoi edges between differing plates.
  const tri = mesh.triangles
  const half = mesh.halfedges
  ctx.strokeStyle = 'rgba(20,20,30,0.5)'
  ctx.lineWidth = 1.6
  ctx.beginPath()
  for (let e = 0; e < tri.length; e++) {
    const opp = half[e]
    if (opp === -1 || opp < e) continue
    const a = tri[e]
    const b = tri[nextHalfedge(e)]
    if (a >= mesh.numSolid || b >= mesh.numSolid) continue
    if (plateId[a] === plateId[b]) continue
    if (!plateBoundary[a] && !plateBoundary[b]) continue
    ctx.moveTo(mesh.cx[triangleOfEdge(e)], mesh.cy[triangleOfEdge(e)])
    ctx.lineTo(mesh.cx[triangleOfEdge(opp)], mesh.cy[triangleOfEdge(opp)])
  }
  ctx.stroke()
}

/** Province tint fills (semi-transparent so relief still reads underneath). */
function drawProvinceFills(ctx: CanvasRenderingContext2D, world: WorldMap, pal: Palette): void {
  const { mesh, province, ocean, lake } = world
  ctx.lineWidth = 0.7
  for (let r = 0; r < mesh.numSolid; r++) {
    if (ocean[r] || lake[r]) continue
    const p = province[r]
    if (p < 0) continue
    const css = provinceCss(p, pal)
    ctx.fillStyle = css
    ctx.strokeStyle = css
    fillCell(ctx, world, r)
  }
}

/** Ink the borders between provinces. */
function drawProvinceBorders(ctx: CanvasRenderingContext2D, world: WorldMap, pal: Palette): void {
  const { mesh, province, ocean, lake } = world
  const tri = mesh.triangles
  const half = mesh.halfedges
  ctx.strokeStyle = pal.provinceLine
  ctx.lineWidth = 1.1
  ctx.lineJoin = 'round'
  ctx.setLineDash([5, 3])
  ctx.beginPath()
  for (let e = 0; e < tri.length; e++) {
    const opp = half[e]
    if (opp === -1 || opp < e) continue
    const a = tri[e]
    const b = tri[nextHalfedge(e)]
    if (a >= mesh.numSolid || b >= mesh.numSolid) continue
    if (ocean[a] || ocean[b] || lake[a] || lake[b]) continue
    if (province[a] === province[b]) continue
    ctx.moveTo(mesh.cx[triangleOfEdge(e)], mesh.cy[triangleOfEdge(e)])
    ctx.lineTo(mesh.cx[triangleOfEdge(opp)], mesh.cy[triangleOfEdge(opp)])
  }
  ctx.stroke()
  ctx.setLineDash([])
}

function drawContours(ctx: CanvasRenderingContext2D, world: WorldMap, pal: Palette): void {
  const levels = defaultLevels(world.params.seaLevel, 6)
  const segs = computeContours(world, levels)
  ctx.strokeStyle = pal.contour
  ctx.lineCap = 'round'
  ctx.beginPath()
  for (const s of segs) {
    ctx.moveTo(s.x1, s.y1)
    ctx.lineTo(s.x2, s.y2)
  }
  ctx.lineWidth = 0.6
  ctx.stroke()
}

function drawCoast(ctx: CanvasRenderingContext2D, world: WorldMap, pal: Palette): void {
  const { mesh, ocean, lake } = world
  const tri = mesh.triangles
  const half = mesh.halfedges
  ctx.strokeStyle = pal.coast
  ctx.lineWidth = 1.4
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.beginPath()
  for (let e = 0; e < tri.length; e++) {
    const opp = half[e]
    if (opp === -1 || opp < e) continue
    const a = tri[e]
    const b = tri[nextHalfedge(e)]
    const wa = ocean[a] || lake[a]
    const wb = ocean[b] || lake[b]
    if (wa === wb) continue
    ctx.moveTo(mesh.cx[triangleOfEdge(e)], mesh.cy[triangleOfEdge(e)])
    ctx.lineTo(mesh.cx[triangleOfEdge(opp)], mesh.cy[triangleOfEdge(opp)])
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
    if (ocean[a] && ocean[b]) continue
    ctx.moveTo(mesh.cx[triangleOfEdge(e)], mesh.cy[triangleOfEdge(e)])
    ctx.lineTo(mesh.cx[triangleOfEdge(opp)], mesh.cy[triangleOfEdge(opp)])
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

function drawRoads(ctx: CanvasRenderingContext2D, world: WorldMap, pal: Palette): void {
  const { mesh, roads } = world
  if (roads.length === 0) return
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  // Casing pass, then the road itself, for a subtle engraved look. Busy trade arteries
  // (high `trade`) draw heavier than quiet local links.
  for (const pass of [0, 1]) {
    for (const rd of roads) {
      const t = rd.trade ?? (rd.trunk ? 0.7 : 0.3)
      const w = (rd.trunk ? 1.7 : 1.1) + t * 2.1
      ctx.strokeStyle = pass === 0 ? pal.roadCasing : pal.road
      ctx.lineWidth = pass === 0 ? w + 1.6 : w
      if (pass === 1 && !rd.trunk) ctx.setLineDash([4, 3])
      ctx.beginPath()
      const p0 = rd.path[0]
      ctx.moveTo(mesh.px[p0], mesh.py[p0])
      for (let k = 1; k < rd.path.length; k++) ctx.lineTo(mesh.px[rd.path[k]], mesh.py[rd.path[k]])
      ctx.stroke()
      ctx.setLineDash([])
    }
  }
}

function drawCities(ctx: CanvasRenderingContext2D, world: WorldMap, pal: Palette): void {
  const { cities } = world
  for (const c of cities) {
    const rad = 2.6 + c.tier * 1.5
    ctx.lineWidth = 1.4
    ctx.fillStyle = pal.city
    ctx.strokeStyle = pal.cityStroke
    if (c.capital) {
      // Capitals get a star inside a ring.
      drawStar(ctx, c.x, c.y, rad + 2.2, rad * 0.9, 5)
      ctx.fill()
      ctx.stroke()
    } else {
      ctx.beginPath()
      ctx.arc(c.x, c.y, rad, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      if (c.tier >= 2) {
        // A central pip marks the larger towns.
        ctx.beginPath()
        ctx.fillStyle = pal.cityStroke
        ctx.arc(c.x, c.y, rad * 0.32, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
}

function drawCityLabels(ctx: CanvasRenderingContext2D, world: WorldMap, pal: Palette): void {
  const { cities, params } = world
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  for (const c of cities) {
    if (c.tier < 1 && !c.capital) continue // keep the smallest hamlets unlabelled
    const size = c.capital ? 15 : 10 + c.tier * 1.6
    ctx.font = `${c.capital ? '700' : '600'} ${size.toFixed(1)}px Georgia, "Times New Roman", serif`
    const label = c.capital ? `★ ${c.name}` : c.name
    const w = ctx.measureText(label).width
    // Prefer a right-side label; flip left near the east edge.
    const rightRoom = c.x + 8 + w < params.width - 4
    const x = rightRoom ? c.x + 6 + c.tier : c.x - 6 - c.tier - w
    const y = c.y - 1
    ctx.lineWidth = Math.max(2, size * 0.16)
    ctx.strokeStyle = pal.cityLabelStroke
    ctx.lineJoin = 'round'
    ctx.strokeText(label, x, y)
    ctx.fillStyle = pal.cityLabel
    ctx.fillText(label, x, y)
  }
}

function drawStar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  points: number,
): void {
  ctx.beginPath()
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner
    const a = (Math.PI * i) / points - Math.PI / 2
    const x = cx + Math.cos(a) * r
    const y = cy + Math.sin(a) * r
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

/** Draw priority for placement: important places win the space, filler is culled. */
const LABEL_PRIO: Record<string, number> = { kingdom: 5, sea: 4, lake: 3, range: 2, river: 1 }

interface PlacedLabel {
  text: string
  size: number
  style: string
  tracked: boolean
  fill: string
  x: number
  y: number
  x0: number
  x1: number
  y0: number
  y1: number
}

function drawLabels(ctx: CanvasRenderingContext2D, world: WorldMap, pal: Palette): void {
  const W = world.params.width
  const H = world.params.height
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // 1) Measure every candidate and clamp it inside the frame.
  const cands = world.labels.map((l) => {
    let size: number
    let style = ''
    if (l.kind === 'kingdom') size = 15 + 15 * l.weight
    else if (l.kind === 'range') {
      size = 11 + 6 * l.weight
      style = 'italic '
    } else if (l.kind === 'river') {
      size = 10 + 5 * l.weight
      style = 'italic '
    } else {
      size = 13 + 6 * l.weight
      style = 'italic '
    }
    ctx.font = `${style}600 ${size.toFixed(1)}px Georgia, "Times New Roman", serif`
    const tracked = l.kind === 'sea' || l.kind === 'lake'
    const text = tracked ? l.text.toUpperCase() : l.text
    let w = ctx.measureText(text).width
    if (tracked) w += (text.length - 1) * size * 0.14
    const halfW = w / 2 + 4
    const x = Math.min(W - halfW, Math.max(halfW, l.x))
    const y = Math.min(H - size, Math.max(size, l.y))
    const fill = l.kind === 'river' ? pal.riverLabel ?? pal.water : pal.labelFill
    const placed: PlacedLabel = {
      text,
      size,
      style,
      tracked,
      fill,
      x,
      y,
      x0: x - halfW,
      x1: x + halfW,
      y0: y - size * 0.62,
      y1: y + size * 0.62,
    }
    return { l, placed }
  })

  // 2) Greedily place high-priority labels first; drop any that would collide.
  cands.sort(
    (a, b) => (LABEL_PRIO[b.l.kind] - LABEL_PRIO[a.l.kind]) || b.l.weight - a.l.weight,
  )
  const kept: PlacedLabel[] = []
  for (const c of cands) {
    const p = c.placed
    let clash = false
    for (const q of kept) {
      if (!(p.x1 < q.x0 || p.x0 > q.x1 || p.y1 < q.y0 || p.y0 > q.y1)) {
        clash = true
        break
      }
    }
    if (!clash) kept.push(p)
  }

  // 3) Draw the survivors.
  ctx.lineJoin = 'round'
  for (const p of kept) {
    ctx.font = `${p.style}600 ${p.size.toFixed(1)}px Georgia, "Times New Roman", serif`
    ctx.lineWidth = Math.max(2, p.size * 0.16)
    ctx.strokeStyle = pal.labelStroke
    if (p.tracked) {
      drawTracked(ctx, p.text, p.x, p.y, p.size * 0.14, pal)
    } else {
      ctx.strokeText(p.text, p.x, p.y)
      ctx.fillStyle = p.fill
      ctx.fillText(p.text, p.x, p.y)
    }
  }
}

/** Draw centred text with manual letter-spacing (canvas has no tracking). */
function drawTracked(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  spacing: number,
  pal: Palette,
): void {
  const widths = [...text].map((ch) => ctx.measureText(ch).width + spacing)
  const total = widths.reduce((a, b) => a + b, 0) - spacing
  let x = cx - total / 2
  ctx.textAlign = 'left'
  for (let i = 0; i < text.length; i++) {
    ctx.strokeText(text[i], x, cy)
    ctx.fillStyle = pal.labelFill
    ctx.fillText(text[i], x, cy)
    x += widths[i]
  }
  ctx.textAlign = 'center'
}

/** Lat/long graticule — faint meridians & parallels with edge ticks. */
function drawGraticule(ctx: CanvasRenderingContext2D, world: WorldMap, pal: Palette): void {
  const W = world.params.width
  const H = world.params.height
  ctx.strokeStyle = pal.graticule
  ctx.lineWidth = 0.6
  const stepX = W / 10
  const stepY = H / 7
  ctx.beginPath()
  for (let x = stepX; x < W; x += stepX) {
    ctx.moveTo(x, 0)
    ctx.lineTo(x, H)
  }
  for (let y = stepY; y < H; y += stepY) {
    ctx.moveTo(0, y)
    ctx.lineTo(W, y)
  }
  ctx.stroke()
}

/** Prevailing-wind rhumb arrows over open sea — an old-chart flourish. The stream is
 * bent by a little curl noise so the arrows flow rather than march in lockstep. */
function drawWind(ctx: CanvasRenderingContext2D, world: WorldMap, pal: Palette): void {
  const { mesh, ocean } = world
  const base = (world.params.windAngle * Math.PI) / 180
  const curl = new Noise2D(`${world.params.seed}:wind`)
  // Open-sea cells only: every neighbour is also water, so arrows never crowd the coast.
  const open: number[] = []
  for (let r = 0; r < mesh.numSolid; r++) {
    if (!ocean[r] || mesh.isFrame[r]) continue
    let allSea = true
    for (const j of mesh.neighbors[r]) {
      if (!ocean[j]) {
        allSea = false
        break
      }
    }
    if (allSea) open.push(r)
  }
  if (open.length === 0) return
  const stride = Math.max(1, Math.round(open.length / 130))
  const L = Math.min(world.params.width, world.params.height) * 0.028
  ctx.strokeStyle = pal.wind ?? 'rgba(255,255,255,0.16)'
  ctx.fillStyle = ctx.strokeStyle
  ctx.lineWidth = 1
  ctx.lineCap = 'round'
  for (let i = 0; i < open.length; i += stride) {
    const r = open[i]
    const x = mesh.px[r]
    const y = mesh.py[r]
    const n = curl.fbm((x / world.params.width) * 3, (y / world.params.height) * 3, 2)
    const ang = base + (n - 0.5) * 0.9
    const dx = Math.cos(ang)
    const dy = Math.sin(ang)
    const x0 = x - dx * L
    const y0 = y - dy * L
    const x1 = x + dx * L
    const y1 = y + dy * L
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    // Arrowhead.
    const hl = L * 0.5
    const a2 = 0.42
    ctx.lineTo(x1 - hl * Math.cos(ang - a2), y1 - hl * Math.sin(ang - a2))
    ctx.moveTo(x1, y1)
    ctx.lineTo(x1 - hl * Math.cos(ang + a2), y1 - hl * Math.sin(ang + a2))
    ctx.stroke()
  }
}

/** A compass rose in a corner, engraved in the palette's ink. */
function drawCompass(ctx: CanvasRenderingContext2D, world: WorldMap, pal: Palette): void {
  const W = world.params.width
  const R = Math.min(W, world.params.height) * 0.05
  const cx = W - R - 24
  const cy = R + 26
  ctx.save()
  ctx.translate(cx, cy)
  ctx.strokeStyle = pal.compass
  ctx.fillStyle = pal.compass
  ctx.lineWidth = 1
  // Outer ring.
  ctx.beginPath()
  ctx.arc(0, 0, R, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(0, 0, R * 0.72, 0, Math.PI * 2)
  ctx.lineWidth = 0.6
  ctx.stroke()
  // Eight-point star.
  for (let i = 0; i < 4; i++) {
    const a = (Math.PI / 2) * i - Math.PI / 2
    const major = i === 0 // north
    const len = major ? R : R * 0.82
    ctx.beginPath()
    ctx.moveTo(Math.cos(a - 0.13) * (R * 0.16), Math.sin(a - 0.13) * (R * 0.16))
    ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len)
    ctx.lineTo(Math.cos(a + 0.13) * (R * 0.16), Math.sin(a + 0.13) * (R * 0.16))
    ctx.closePath()
    if (major) ctx.fill()
    else ctx.stroke()
  }
  for (let i = 0; i < 4; i++) {
    const a = (Math.PI / 2) * i - Math.PI / 4
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5)
    ctx.stroke()
  }
  ctx.fillStyle = pal.compass
  ctx.font = `700 ${(R * 0.34).toFixed(1)}px Georgia, serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('N', 0, -R * 1.28)
  ctx.restore()
}

/** A scale bar in leagues (an arbitrary but consistent world scale). */
function drawScale(ctx: CanvasRenderingContext2D, world: WorldMap, pal: Palette): void {
  const W = world.params.width
  const H = world.params.height
  const leaguesPerWorld = 1600 / W // ⇒ ~1600 leagues across a default map
  const barLeagues = 200
  const barW = barLeagues / leaguesPerWorld
  const x0 = 26
  const y0 = H - 30
  const h = 6
  ctx.save()
  ctx.strokeStyle = pal.scaleInk
  ctx.fillStyle = pal.scaleInk
  ctx.lineWidth = 1
  // Alternating black/white segments.
  const segs = 4
  for (let i = 0; i < segs; i++) {
    const sx = x0 + (barW * i) / segs
    ctx.beginPath()
    ctx.rect(sx, y0, barW / segs, h)
    if (i % 2 === 0) ctx.fill()
    else ctx.stroke()
  }
  ctx.strokeRect(x0, y0, barW, h)
  ctx.font = `600 10px Georgia, serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'bottom'
  ctx.fillText('0', x0 - 1, y0 - 3)
  ctx.textAlign = 'center'
  ctx.fillText(`${barLeagues} leagues`, x0 + barW / 2, y0 - 3)
  ctx.restore()
}

/** A double-ruled atlas frame with corner ticks. */
function drawFrame(ctx: CanvasRenderingContext2D, world: WorldMap, pal: Palette): void {
  const W = world.params.width
  const H = world.params.height
  ctx.strokeStyle = pal.frame
  const inset = 8
  ctx.lineWidth = 2.4
  ctx.strokeRect(inset, inset, W - 2 * inset, H - 2 * inset)
  ctx.lineWidth = 0.8
  ctx.strokeRect(inset + 5, inset + 5, W - 2 * inset - 10, H - 2 * inset - 10)
}

function drawSelection(ctx: CanvasRenderingContext2D, world: WorldMap, r: number): void {
  const { mesh } = world
  if (r < 0 || r >= mesh.numSolid) return
  if (cellPath(ctx, world, r)) {
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.strokeStyle = 'rgba(10,15,25,0.8)'
    ctx.lineWidth = 0.8
    ctx.stroke()
  }
  const x = mesh.px[r]
  const y = mesh.py[r]
  const rad = 9
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(x, y, rad, 0, Math.PI * 2)
  ctx.moveTo(x - rad - 4, y)
  ctx.lineTo(x - rad + 2, y)
  ctx.moveTo(x + rad - 2, y)
  ctx.lineTo(x + rad + 4, y)
  ctx.moveTo(x, y - rad - 4)
  ctx.lineTo(x, y - rad + 2)
  ctx.moveTo(x, y + rad - 2)
  ctx.lineTo(x, y + rad + 4)
  ctx.stroke()
}

function drawGrain(ctx: CanvasRenderingContext2D, world: WorldMap, pal: Palette): void {
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
  const pal = opts.palette
  const v = opts.view
  ctx.save()
  ctx.fillStyle = pal.background
  ctx.fillRect(0, 0, W, H)

  drawCells(ctx, world, opts)
  if (v.showPlates) drawPlates(ctx, world)
  if (v.showProvinces) drawProvinceFills(ctx, world, pal)
  if (v.showContours) drawContours(ctx, world, pal)
  if (v.showBorders) drawBorders(ctx, world, pal)
  if (v.showProvinces) drawProvinceBorders(ctx, world, pal)
  if (v.showCoast) drawCoast(ctx, world, pal)
  if (v.showWind) drawWind(ctx, world, pal)
  if (v.showRivers) drawRivers(ctx, world, pal)
  if (v.showRoads) drawRoads(ctx, world, pal)
  if (v.showGraticule) drawGraticule(ctx, world, pal)
  if (v.showLabels) drawLabels(ctx, world, pal)
  if (v.showCities) {
    drawCities(ctx, world, pal)
    drawCityLabels(ctx, world, pal)
  }
  if (v.showGrain) drawGrain(ctx, world, pal)
  drawVignette(ctx, world)
  if (v.showFrame) drawFrame(ctx, world, pal)
  if (v.showCompass) drawCompass(ctx, world, pal)
  if (v.showScale) drawScale(ctx, world, pal)
  if (opts.selected != null && opts.selected >= 0) drawSelection(ctx, world, opts.selected)
  ctx.restore()
}

/** Nearest region site to a world-space point — the Voronoi cell it lands in. */
export function nearestRegion(world: WorldMap, x: number, y: number): number {
  const { mesh } = world
  let best = -1
  let bestD = Infinity
  for (let r = 0; r < mesh.numSolid; r++) {
    const dx = mesh.px[r] - x
    const dy = mesh.py[r] - y
    const d = dx * dx + dy * dy
    if (d < bestD) {
      bestD = d
      best = r
    }
  }
  return best
}
