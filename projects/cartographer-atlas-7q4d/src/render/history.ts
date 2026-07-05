// Rendering "The Ages" — one frame of the history simulation drawn over the relief.
//
// Territory is tinted by realm (a stable golden-angle-ish hue per realm), inked along the
// frontiers between differing owners, and topped with capital stars, town pips, realm
// labels and a dated cartouche. It is swapped in for the static province/road/city layers
// whenever the timeline is active, so the same map reads as a political snapshot of any year.

import type { HistoryFrame, WorldMap } from '../core/types'
import type { Palette } from './palettes'

const nextHalfedge = (e: number): number => (e % 3 === 2 ? e - 2 : e + 1)
const triangleOfEdge = (e: number): number => Math.floor(e / 3)

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

function realmFill(hue: number): string {
  return `hsla(${hue.toFixed(0)}, 58%, 52%, 0.5)`
}

/** Realm-tinted territory fills + inked frontiers between differing owners. */
export function drawAgesTerritory(
  ctx: CanvasRenderingContext2D,
  world: WorldMap,
  frame: HistoryFrame,
  pal: Palette,
): void {
  const { mesh } = world
  const owner = frame.owner
  const realms = world.history.realms
  ctx.lineWidth = 0.7
  for (let r = 0; r < mesh.numSolid; r++) {
    if (world.ocean[r] || world.lake[r]) continue
    const o = owner[r]
    if (o < 0) continue
    const hue = realms[o]?.hue ?? 0
    const css = realmFill(hue)
    ctx.fillStyle = css
    ctx.strokeStyle = css
    if (cellPath(ctx, world, r)) {
      ctx.fill()
      ctx.stroke()
    }
  }

  // Frontier ink: Voronoi edges between two differently owned land cells.
  const tri = mesh.triangles
  const half = mesh.halfedges
  ctx.strokeStyle = pal.provinceLine
  ctx.lineWidth = 1.4
  ctx.lineJoin = 'round'
  ctx.beginPath()
  for (let e = 0; e < tri.length; e++) {
    const opp = half[e]
    if (opp === -1 || opp < e) continue
    const a = tri[e]
    const b = tri[nextHalfedge(e)]
    if (a >= mesh.numSolid || b >= mesh.numSolid) continue
    const oa = owner[a]
    const ob = owner[b]
    if (oa === ob) continue
    if (oa < 0 && ob < 0) continue
    ctx.moveTo(mesh.cx[triangleOfEdge(e)], mesh.cy[triangleOfEdge(e)])
    ctx.lineTo(mesh.cx[triangleOfEdge(opp)], mesh.cy[triangleOfEdge(opp)])
  }
  ctx.stroke()
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

/** Capitals, towns, realm names and the dated cartouche — drawn on top of everything. */
export function drawAgesFurniture(
  ctx: CanvasRenderingContext2D,
  world: WorldMap,
  frame: HistoryFrame,
  pal: Palette,
): void {
  const { mesh } = world
  const realms = world.history.realms

  // Towns first (small), then capitals (stars), so capitals sit on top.
  for (const c of frame.cities) {
    if (c.capital || c.realm < 0) continue
    const rad = 1.8 + c.tier * 1.1
    const hue = realms[c.realm]?.hue ?? 0
    ctx.beginPath()
    ctx.arc(mesh.px[c.r], mesh.py[c.r], rad, 0, Math.PI * 2)
    ctx.fillStyle = `hsl(${hue.toFixed(0)}, 55%, 78%)`
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(15,12,8,0.7)'
    ctx.stroke()
  }
  for (const c of frame.cities) {
    if (!c.capital) continue
    const hue = realms[c.realm]?.hue ?? 45
    drawStar(ctx, mesh.px[c.r], mesh.py[c.r], 6.4, 2.7, 5)
    ctx.fillStyle = `hsl(${hue.toFixed(0)}, 70%, 66%)`
    ctx.fill()
    ctx.lineWidth = 1.4
    ctx.strokeStyle = 'rgba(15,12,8,0.85)'
    ctx.stroke()
  }

  // Realm labels: the biggest realms of the year, at their capitals, collision-culled.
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // Reserve the top-centre ribbon so labels never fight the cartouche.
  const cx = world.params.width / 2
  const kept: Array<{ x0: number; x1: number; y0: number; y1: number }> = [
    { x0: cx - 170, x1: cx + 170, y0: 0, y1: 62 },
  ]
  const top = frame.realms.filter((s) => s.area >= 5 && s.capital >= 0).slice(0, 12)
  for (const s of top) {
    const name = realms[s.id]?.name ?? ''
    if (!name) continue
    const size = clamp(11 + Math.sqrt(s.area) * 0.7, 11, 21)
    ctx.font = `700 ${size.toFixed(1)}px Georgia, "Times New Roman", serif`
    const w = ctx.measureText(name).width
    const x = mesh.px[s.capital]
    const y = mesh.py[s.capital] - 12
    const box = { x0: x - w / 2 - 3, x1: x + w / 2 + 3, y0: y - size * 0.62, y1: y + size * 0.62 }
    let clash = false
    for (const q of kept) {
      if (!(box.x1 < q.x0 || box.x0 > q.x1 || box.y1 < q.y0 || box.y0 > q.y1)) { clash = true; break }
    }
    if (clash) continue
    kept.push(box)
    ctx.lineWidth = Math.max(2, size * 0.16)
    ctx.lineJoin = 'round'
    ctx.strokeStyle = pal.cityLabelStroke
    ctx.strokeText(name, x, y)
    ctx.fillStyle = pal.cityLabel
    ctx.fillText(name, x, y)
  }

  drawCartouche(ctx, world, frame)
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** A parchment ribbon across the top naming the year and era of the scrubbed frame. */
function drawCartouche(ctx: CanvasRenderingContext2D, world: WorldMap, frame: HistoryFrame): void {
  const W = world.params.width
  const realmCount = frame.realms.length
  const line = `Year ${frame.year} · ${world.history.era}`
  const sub = realmCount === 1 ? '1 realm' : `${realmCount} realms`
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `700 17px Georgia, "Times New Roman", serif`
  const tw = ctx.measureText(line).width
  const boxW = Math.max(tw + 44, 200)
  const boxH = 40
  const x = W / 2 - boxW / 2
  const y = 14
  // Ribbon.
  ctx.fillStyle = 'rgba(18,14,9,0.82)'
  ctx.strokeStyle = 'rgba(214,190,140,0.75)'
  ctx.lineWidth = 1.2
  roundRect(ctx, x, y, boxW, boxH, 8)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = '#f2e6c9'
  ctx.fillText(line, W / 2, y + 15)
  ctx.font = `600 11px Georgia, serif`
  ctx.fillStyle = 'rgba(226,206,160,0.8)'
  ctx.fillText(sub, W / 2, y + 30)
  ctx.restore()
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
