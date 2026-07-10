// Canvas rendering for both analysis modes. Pure drawing functions — they take
// a 2-D context, a model, its solved result, and display options, and paint.
// No React, no state; everything is recomputed each frame from props.

import type { FrameModel, FrameResult, SupportKind } from '../engine/frame'
import type { ContinuumResult } from '../engine/continuum'
import type { Mesh, EdgeName } from '../engine/mesh'
import { edgeSegments } from '../engine/mesh'
import { fieldColor, signedColor, rgbStr, type Colormap } from './colormap'
import { worldToScreen, type View } from './viewport'

const INK = '#e8ecf5'
const GRID = 'rgba(255,255,255,0.045)'
const GHOST = 'rgba(150,160,185,0.35)'
const ACCENT = '#6ea8ff'

export interface Picked {
  type: 'member' | 'node'
  index: number
}

export interface FrameDrawOpts {
  view: View
  deformScale: number
  loadFactor: number
  showUndeformed: boolean
  colorBy: 'force' | 'stress'
  colormap: Colormap
  showLoads: boolean
  showReactions: boolean
  showLabels: boolean
  hover: Picked | null
  selected: Picked | null
  editing: boolean
  pendingNode: number | null
}

function clear(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.clearRect(0, 0, w, h)
  const g = ctx.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, '#0d1017')
  g.addColorStop(1, '#0a0c12')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
}

function drawGrid(ctx: CanvasRenderingContext2D, view: View, w: number, h: number) {
  // Choose a "nice" world spacing that renders ~70 px apart.
  const target = 70 / view.scale
  const pow = Math.pow(10, Math.floor(Math.log10(target)))
  const candidates = [1, 2, 5, 10].map((m) => m * pow)
  const step = candidates.find((c) => c * view.scale >= 55) ?? candidates[candidates.length - 1]
  const [wx0, wy1] = [
    (0 - view.ox) / view.scale,
    (view.oy - h) / view.scale,
  ]
  const [wx1, wy0] = [(w - view.ox) / view.scale, view.oy / view.scale]
  ctx.strokeStyle = GRID
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let x = Math.ceil(wx0 / step) * step; x <= wx1; x += step) {
    const [sx] = worldToScreen(view, x, 0)
    ctx.moveTo(sx, 0)
    ctx.lineTo(sx, h)
  }
  for (let y = Math.ceil(wy1 / step) * step; y <= wy0; y += step) {
    const [, sy] = worldToScreen(view, 0, y)
    ctx.moveTo(0, sy)
    ctx.lineTo(w, sy)
  }
  ctx.stroke()
}

function arrow(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  width = 2,
) {
  const ang = Math.atan2(y2 - y1, x2 - x1)
  const head = 9
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = width
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x2, y2)
  ctx.lineTo(x2 - head * Math.cos(ang - 0.4), y2 - head * Math.sin(ang - 0.4))
  ctx.lineTo(x2 - head * Math.cos(ang + 0.4), y2 - head * Math.sin(ang + 0.4))
  ctx.closePath()
  ctx.fill()
}

function supportGlyph(
  ctx: CanvasRenderingContext2D,
  kind: SupportKind,
  sx: number,
  sy: number,
) {
  const s = 12
  ctx.strokeStyle = '#8fb0ff'
  ctx.fillStyle = 'rgba(110,168,255,0.25)'
  ctx.lineWidth = 2
  const hatch = (cx: number, cy: number, horizontal: boolean) => {
    ctx.strokeStyle = 'rgba(143,176,255,0.7)'
    ctx.lineWidth = 1.5
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath()
      if (horizontal) {
        ctx.moveTo(cx + i * 5, cy)
        ctx.lineTo(cx + i * 5 - 5, cy + 6)
      } else {
        ctx.moveTo(cx, cy + i * 5)
        ctx.lineTo(cx - 6, cy + i * 5 - 5)
      }
      ctx.stroke()
    }
  }
  const triangle = (dir: 'down' | 'left') => {
    ctx.strokeStyle = '#8fb0ff'
    ctx.fillStyle = 'rgba(110,168,255,0.25)'
    ctx.lineWidth = 2
    ctx.beginPath()
    if (dir === 'down') {
      ctx.moveTo(sx, sy)
      ctx.lineTo(sx - s, sy + s * 1.5)
      ctx.lineTo(sx + s, sy + s * 1.5)
    } else {
      ctx.moveTo(sx, sy)
      ctx.lineTo(sx - s * 1.5, sy - s)
      ctx.lineTo(sx - s * 1.5, sy + s)
    }
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  }
  switch (kind) {
    case 'pin':
      triangle('down')
      hatch(sx, sy + s * 1.5, true)
      break
    case 'roller-x':
      triangle('down')
      ctx.fillStyle = '#8fb0ff'
      ctx.beginPath()
      ctx.arc(sx - 6, sy + s * 1.5 + 4, 3, 0, 7)
      ctx.arc(sx + 6, sy + s * 1.5 + 4, 3, 0, 7)
      ctx.fill()
      break
    case 'roller-y':
      triangle('left')
      ctx.fillStyle = '#8fb0ff'
      ctx.beginPath()
      ctx.arc(sx - s * 1.5 - 4, sy - 6, 3, 0, 7)
      ctx.arc(sx - s * 1.5 - 4, sy + 6, 3, 0, 7)
      ctx.fill()
      break
    case 'fixed':
      ctx.fillStyle = 'rgba(110,168,255,0.2)'
      ctx.fillRect(sx - 16, sy - 16, 8, 32)
      hatch(sx - 12, sy - 16, false)
      break
    default:
      break
  }
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  model: FrameModel,
  result: FrameResult | null,
  o: FrameDrawOpts,
) {
  clear(ctx, w, h)
  drawGrid(ctx, o.view, w, h)
  const { view } = o
  const def = o.deformScale * o.loadFactor

  const defPos = (i: number): [number, number] => {
    const n = model.nodes[i]
    if (!result) return worldToScreen(view, n.x, n.y)
    const d = result.nodeDisp[i]
    return worldToScreen(view, n.x + d.ux * def, n.y + d.uy * def)
  }

  // Undeformed ghost.
  if (o.showUndeformed && result && def !== 0) {
    ctx.strokeStyle = GHOST
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    for (const m of model.members) {
      const [ax, ay] = worldToScreen(view, model.nodes[m.a].x, model.nodes[m.a].y)
      const [bx, by] = worldToScreen(view, model.nodes[m.b].x, model.nodes[m.b].y)
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.lineTo(bx, by)
      ctx.stroke()
    }
    ctx.setLineDash([])
  }

  // Members (deformed), coloured by force or stress.
  const maxAxial = result ? Math.max(result.maxAxial, 1e-9) : 1
  const maxStress = result ? Math.max(result.maxStress, 1e-9) : 1
  model.members.forEach((m, i) => {
    const [ax, ay] = defPos(m.a)
    const [bx, by] = defPos(m.b)
    let color = ACCENT
    let width = 3
    if (result) {
      const r = result.members[i]
      if (o.colorBy === 'force') {
        color = rgbStr(signedColor(r.axial / maxAxial))
      } else {
        color = rgbStr(fieldColor(r.maxFiberStress / maxStress, o.colormap))
      }
      width = 2 + 4 * (Math.abs(r.axial) / maxAxial)
    }
    const isSel = o.selected?.type === 'member' && o.selected.index === i
    const isHov = o.hover?.type === 'member' && o.hover.index === i
    if (isSel || isHov) {
      ctx.strokeStyle = isSel ? '#ffffff' : 'rgba(255,255,255,0.5)'
      ctx.lineWidth = width + 4
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.lineTo(bx, by)
      ctx.stroke()
    }
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(ax, ay)
    ctx.lineTo(bx, by)
    ctx.stroke()

    if (o.showLabels && result) {
      const r = result.members[i]
      ctx.fillStyle = INK
      ctx.font = '11px ui-monospace, monospace'
      ctx.textAlign = 'center'
      const kN = r.axial / 1e3
      ctx.fillText(`${kN >= 0 ? '+' : ''}${kN.toFixed(1)}kN`, (ax + bx) / 2, (ay + by) / 2 - 6)
    }
  })

  // Supports at undeformed positions.
  model.nodes.forEach((n) => {
    if (n.support === 'free') return
    const [sx, sy] = worldToScreen(view, n.x, n.y)
    supportGlyph(ctx, n.support, sx, sy)
  })

  // Loads (grow with the load factor).
  if (o.showLoads) {
    let maxF = 1e-9
    for (const l of model.loads) maxF = Math.max(maxF, Math.hypot(l.fx, l.fy))
    for (const l of model.loads) {
      const mag = Math.hypot(l.fx, l.fy)
      if (mag === 0) continue
      const [nx, ny] = defPos(l.node)
      const len = (30 + 45 * (mag / maxF)) * o.loadFactor
      const ux = (l.fx / mag) * len
      const uy = (-l.fy / mag) * len // screen y down
      arrow(ctx, nx - ux, ny - uy, nx, ny, '#ffd166', 2.5)
    }
  }

  // Reactions.
  if (o.showReactions && result) {
    let maxR = 1e-9
    for (const rr of result.reactions) maxR = Math.max(maxR, Math.hypot(rr.fx, rr.fy))
    for (const rr of result.reactions) {
      const mag = Math.hypot(rr.fx, rr.fy)
      if (mag < 1e-6) continue
      const n = model.nodes[rr.node]
      const [nx, ny] = worldToScreen(view, n.x, n.y)
      const len = (25 + 40 * (mag / maxR)) * o.loadFactor
      const ux = (rr.fx / mag) * len
      const uy = (-rr.fy / mag) * len
      arrow(ctx, nx, ny, nx + ux, ny + uy, '#4ade80', 2.5)
    }
  }

  // Nodes.
  model.nodes.forEach((_, i) => {
    const [sx, sy] = defPos(i)
    const isSel = o.selected?.type === 'node' && o.selected.index === i
    const isHov = o.hover?.type === 'node' && o.hover.index === i
    const pending = o.pendingNode === i
    ctx.beginPath()
    ctx.arc(sx, sy, isSel || isHov || pending ? 6 : 4, 0, 7)
    ctx.fillStyle = pending ? '#ffd166' : isSel ? '#fff' : isHov ? ACCENT : '#c7d2e8'
    ctx.fill()
    if (pending) {
      ctx.strokeStyle = '#ffd166'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(sx, sy, 10, 0, 7)
      ctx.stroke()
    }
  })
}

// ------------------------------------------------------------------ continuum

export interface ContinuumDrawOpts {
  view: View
  deformScale: number
  loadFactor: number
  showMesh: boolean
  showUndeformed: boolean
  colormap: Colormap
  field: 'vm' | 'disp'
  tractionEdge?: EdgeName
  tractionDir?: { tx: number; ty: number }
  fixedEdges?: EdgeName[]
}

export function drawContinuum(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  mesh: Mesh,
  result: ContinuumResult | null,
  o: ContinuumDrawOpts,
) {
  clear(ctx, w, h)
  drawGrid(ctx, o.view, w, h)
  const { view } = o
  const def = o.deformScale * o.loadFactor

  const px = new Float64Array(mesh.nodeCount)
  const py = new Float64Array(mesh.nodeCount)
  for (let i = 0; i < mesh.nodeCount; i++) {
    let x = mesh.x[i]
    let y = mesh.y[i]
    if (result) {
      x += result.dispX[i] * def
      y += result.dispY[i] * def
    }
    const [sx, sy] = worldToScreen(view, x, y)
    px[i] = sx
    py[i] = sy
  }

  // Undeformed ghost outline.
  if (o.showUndeformed && result && def !== 0) {
    ctx.strokeStyle = GHOST
    ctx.lineWidth = 0.6
    ctx.beginPath()
    for (let e = 0; e < mesh.triCount; e++) {
      const a = mesh.tris[e * 3], b = mesh.tris[e * 3 + 1], c = mesh.tris[e * 3 + 2]
      const [axs, ays] = worldToScreen(view, mesh.x[a], mesh.y[a])
      const [bxs, bys] = worldToScreen(view, mesh.x[b], mesh.y[b])
      const [cxs, cys] = worldToScreen(view, mesh.x[c], mesh.y[c])
      ctx.moveTo(axs, ays)
      ctx.lineTo(bxs, bys)
      ctx.lineTo(cxs, cys)
      ctx.closePath()
    }
    ctx.stroke()
  }

  // Stress field (flat per-element — the honest picture for constant-strain
  // triangles) or displacement magnitude.
  let lo = 0
  let hi = 1
  if (result) {
    if (o.field === 'vm') {
      lo = result.minVonMises
      hi = result.maxVonMises
    } else {
      lo = 0
      hi = Math.max(result.maxDisp, 1e-12)
    }
  }
  const span = hi - lo || 1
  for (let e = 0; e < mesh.triCount; e++) {
    const a = mesh.tris[e * 3], b = mesh.tris[e * 3 + 1], c = mesh.tris[e * 3 + 2]
    let t = 0.5
    if (result) {
      if (o.field === 'vm') {
        t = (result.elementStress[e].vm - lo) / span
      } else {
        const dm =
          (Math.hypot(result.dispX[a], result.dispY[a]) +
            Math.hypot(result.dispX[b], result.dispY[b]) +
            Math.hypot(result.dispX[c], result.dispY[c])) /
          3
        t = (dm - lo) / span
      }
    }
    ctx.fillStyle = rgbStr(fieldColor(t, o.colormap))
    ctx.beginPath()
    ctx.moveTo(px[a], py[a])
    ctx.lineTo(px[b], py[b])
    ctx.lineTo(px[c], py[c])
    ctx.closePath()
    ctx.fill()
    if (o.showMesh) {
      ctx.strokeStyle = 'rgba(0,0,0,0.25)'
      ctx.lineWidth = 0.5
      ctx.stroke()
    }
  }

  // Boundary conditions.
  if (o.fixedEdges) {
    for (const edge of o.fixedEdges) {
      ctx.strokeStyle = '#8fb0ff'
      ctx.lineWidth = 3
      for (const [n1, n2] of edgeSegments(mesh, edge)) {
        const [x1, y1] = worldToScreen(view, mesh.x[n1], mesh.y[n1])
        const [x2, y2] = worldToScreen(view, mesh.x[n2], mesh.y[n2])
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()
      }
    }
  }
  if (o.tractionEdge) {
    const d = o.tractionDir ?? { tx: 1, ty: 0 }
    const mag = Math.hypot(d.tx, d.ty) || 1
    const ux = (d.tx / mag) * 22
    const uy = (-d.ty / mag) * 22 // screen y down
    for (const [n1, n2] of edgeSegments(mesh, o.tractionEdge)) {
      const mx = worldToScreen(view, (mesh.x[n1] + mesh.x[n2]) / 2, (mesh.y[n1] + mesh.y[n2]) / 2)
      arrow(ctx, mx[0] - ux, mx[1] - uy, mx[0], mx[1], '#ffd166', 2)
    }
  }
}
