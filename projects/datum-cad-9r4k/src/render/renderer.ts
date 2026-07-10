import type { Sketch } from '../model/sketch'
import type { Constraint, EntityId } from '../model/types'
import type { DofStatus } from '../solver/dof'
import type { View } from './view'
import { worldToScreen } from './view'

export type TracePath = { pts: [number, number][]; color: string }

export type RenderState = {
  view: View
  selection: Set<EntityId>
  hover: EntityId | null
  pending: Set<EntityId> // entities chosen toward a not-yet-applied constraint
  traces: TracePath[]
  dofStatus: DofStatus
  redundant: Set<EntityId> // constraint ids flagged as linearly dependent / conflicting
  highlight: Set<EntityId> // entities to accent (e.g. the geometry of a hovered constraint)
  showConstraints: boolean
  showGrid: boolean
  preview: { kind: 'line' | 'circle'; from: [number, number]; to: [number, number] } | null
}

const COL = {
  bg: '#0a0e13',
  gridMinor: '#131c26',
  gridMajor: '#1c2a37',
  axis: '#2c4256',
  geo: '#78a9ff',
  geoConstruction: '#48586a',
  pointFree: '#ffd166',
  pointFixed: '#ff6b81',
  pointConstruction: '#7d8ea0',
  select: '#57e6c9',
  pending: '#c792ea',
  hover: '#ffffff',
  dim: '#e0913b',
  glyphBg: 'rgba(12,18,26,0.92)',
  glyphBorder: '#33475a',
  glyphText: '#a9c0d6',
  conflict: '#ff5c72',
  highlight: '#8ad4ff',
}

export function statusColor(s: DofStatus): string {
  switch (s) {
    case 'well':
      return '#57e6c9'
    case 'under':
      return '#78a9ff'
    case 'over':
      return '#ff6b81'
    case 'empty':
      return '#7d8ea0'
  }
}

export function render(ctx: CanvasRenderingContext2D, sketch: Sketch, st: RenderState, w: number, h: number) {
  const v = st.view
  ctx.save()
  ctx.fillStyle = COL.bg
  ctx.fillRect(0, 0, w, h)

  if (st.showGrid) drawGrid(ctx, v, w, h)

  // Traced coupler curves sit under the geometry.
  for (const t of st.traces) drawTrace(ctx, v, t)

  drawGeometry(ctx, sketch, st)
  if (st.showConstraints) drawConstraints(ctx, sketch, st)
  drawPoints(ctx, sketch, st)
  if (st.preview) drawPreview(ctx, v, st.preview)

  ctx.restore()
}

function niceStep(worldPerPx: number): number {
  // Choose a grid step (in world units) that lands near ~64px on screen.
  const target = 64 * worldPerPx
  const pow = Math.pow(10, Math.floor(Math.log10(target)))
  const candidates = [1, 2, 5, 10].map((m) => m * pow)
  return candidates.find((c) => c >= target) ?? candidates[candidates.length - 1]
}

function drawGrid(ctx: CanvasRenderingContext2D, v: View, w: number, h: number) {
  const step = niceStep(1 / v.scale)
  const [x0, y0] = [(0 - v.ox) / v.scale, (v.oy - h) / v.scale] // world at screen corner
  const [x1] = [(w - v.ox) / v.scale]
  const startX = Math.floor(x0 / step) * step
  const endX = Math.ceil(x1 / step) * step
  const yTop = (v.oy - 0) / v.scale
  const startY = Math.floor(y0 / step) * step
  const endY = Math.ceil(yTop / step) * step

  ctx.lineWidth = 1
  for (let x = startX; x <= endX; x += step) {
    const [sx] = worldToScreen(v, x, 0)
    ctx.strokeStyle = Math.abs(x % (step * 5)) < step / 2 ? COL.gridMajor : COL.gridMinor
    ctx.beginPath()
    ctx.moveTo(Math.round(sx) + 0.5, 0)
    ctx.lineTo(Math.round(sx) + 0.5, h)
    ctx.stroke()
  }
  for (let y = startY; y <= endY; y += step) {
    const [, sy] = worldToScreen(v, 0, y)
    ctx.strokeStyle = Math.abs(y % (step * 5)) < step / 2 ? COL.gridMajor : COL.gridMinor
    ctx.beginPath()
    ctx.moveTo(0, Math.round(sy) + 0.5)
    ctx.lineTo(w, Math.round(sy) + 0.5)
    ctx.stroke()
  }
  // Axes through the world origin.
  const [ax, ay] = worldToScreen(v, 0, 0)
  ctx.strokeStyle = COL.axis
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(0, Math.round(ay) + 0.5)
  ctx.lineTo(w, Math.round(ay) + 0.5)
  ctx.moveTo(Math.round(ax) + 0.5, 0)
  ctx.lineTo(Math.round(ax) + 0.5, h)
  ctx.stroke()
}

function drawTrace(ctx: CanvasRenderingContext2D, v: View, t: TracePath) {
  if (t.pts.length < 2) return
  ctx.strokeStyle = t.color
  ctx.lineWidth = 1.5
  ctx.globalAlpha = 0.85
  ctx.beginPath()
  for (let i = 0; i < t.pts.length; i++) {
    const [sx, sy] = worldToScreen(v, t.pts[i][0], t.pts[i][1])
    if (i === 0) ctx.moveTo(sx, sy)
    else ctx.lineTo(sx, sy)
  }
  ctx.stroke()
  ctx.globalAlpha = 1
}

function strokeFor(id: EntityId, st: RenderState, base: string): string {
  if (st.selection.has(id)) return COL.select
  if (st.pending.has(id)) return COL.pending
  if (st.hover === id) return COL.hover
  if (st.highlight.has(id)) return COL.highlight
  return base
}

function drawGeometry(ctx: CanvasRenderingContext2D, sketch: Sketch, st: RenderState) {
  const v = st.view
  for (const e of sketch.entities) {
    if (e.kind === 'line') {
      const a = sketch.point(e.p1)
      const b = sketch.point(e.p2)
      const [ax, ay] = worldToScreen(v, a.x, a.y)
      const [bx, by] = worldToScreen(v, b.x, b.y)
      const isConstr = e.construction
      ctx.strokeStyle = strokeFor(e.id, st, isConstr ? COL.geoConstruction : COL.geo)
      ctx.lineWidth = st.selection.has(e.id) || st.hover === e.id || st.highlight.has(e.id) ? 3 : isConstr ? 1 : 2
      ctx.setLineDash(isConstr ? [5, 5] : [])
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.lineTo(bx, by)
      ctx.stroke()
      ctx.setLineDash([])
    } else if (e.kind === 'circle') {
      const c = sketch.point(e.c)
      const [cx, cy] = worldToScreen(v, c.x, c.y)
      ctx.strokeStyle = strokeFor(e.id, st, e.construction ? COL.geoConstruction : COL.geo)
      ctx.lineWidth = st.selection.has(e.id) || st.hover === e.id || st.highlight.has(e.id) ? 3 : 2
      ctx.setLineDash(e.construction ? [5, 5] : [])
      ctx.beginPath()
      ctx.arc(cx, cy, e.r * v.scale, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
    }
  }
}

function drawPoints(ctx: CanvasRenderingContext2D, sketch: Sketch, st: RenderState) {
  const v = st.view
  for (const e of sketch.entities) {
    if (e.kind !== 'point') continue
    const [sx, sy] = worldToScreen(v, e.x, e.y)
    const selected = st.selection.has(e.id)
    const pending = st.pending.has(e.id)
    const hovered = st.hover === e.id
    const highlighted = st.highlight.has(e.id)
    const r = selected || hovered ? 6 : 4.5

    if (selected || pending || hovered || highlighted) {
      ctx.beginPath()
      ctx.arc(sx, sy, r + 4, 0, Math.PI * 2)
      ctx.fillStyle = (selected ? COL.select : pending ? COL.pending : hovered ? COL.hover : COL.highlight) + '33'
      ctx.fill()
    }

    if (e.fixed) {
      // Anchored points draw as a small square.
      ctx.fillStyle = COL.pointFixed
      ctx.fillRect(sx - r, sy - r, r * 2, r * 2)
      ctx.strokeStyle = '#000'
      ctx.lineWidth = 1
      ctx.strokeRect(sx - r, sy - r, r * 2, r * 2)
    } else {
      ctx.beginPath()
      ctx.arc(sx, sy, r, 0, Math.PI * 2)
      ctx.fillStyle = e.construction ? COL.pointConstruction : COL.pointFree
      ctx.fill()
      ctx.strokeStyle = '#0a0e13'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }
}

function drawPreview(
  ctx: CanvasRenderingContext2D,
  v: View,
  p: { kind: 'line' | 'circle'; from: [number, number]; to: [number, number] },
) {
  const [ax, ay] = worldToScreen(v, p.from[0], p.from[1])
  const [bx, by] = worldToScreen(v, p.to[0], p.to[1])
  ctx.strokeStyle = COL.pending
  ctx.lineWidth = 1.5
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  if (p.kind === 'line') {
    ctx.moveTo(ax, ay)
    ctx.lineTo(bx, by)
  } else {
    const rad = Math.hypot(bx - ax, by - ay)
    ctx.arc(ax, ay, rad, 0, Math.PI * 2)
  }
  ctx.stroke()
  ctx.setLineDash([])
}

// --- constraint annotations ------------------------------------------------

const GLYPH: Partial<Record<Constraint['kind'], string>> = {
  horizontal: 'H',
  vertical: 'V',
  parallel: '∥',
  perpendicular: '⟂',
  equalLength: '=',
  equalRadius: '=',
  pointOnLine: '—',
  pointOnCircle: '○',
  concentric: '◎',
  tangentLineCircle: 'T',
  tangentCircles: 'T',
  midpoint: 'M',
  symmetric: '⇄',
  colinear: '≡',
  coincident: '•',
}

function midOfLine(sketch: Sketch, id: EntityId): [number, number] {
  const l = sketch.line(id)
  const a = sketch.point(l.p1)
  const b = sketch.point(l.p2)
  return [(a.x + b.x) / 2, (a.y + b.y) / 2]
}

function drawConstraints(ctx: CanvasRenderingContext2D, sketch: Sketch, st: RenderState) {
  // Badges are laid out with a small per-anchor stagger so overlapping ones on
  // the same entity don't stack exactly.
  const anchorCount = new Map<string, number>()
  for (const c of sketch.constraints) {
    const conflict = st.redundant.has(c.id)
    if (c.kind === 'distance') {
      drawDistanceDim(ctx, sketch, c, st, conflict)
    } else if (c.kind === 'radius' || c.kind === 'diameter') {
      drawRadiusDim(ctx, sketch, c, st, conflict)
    } else if (c.kind === 'angle') {
      drawAngleDim(ctx, sketch, c, st, conflict)
    } else {
      const sym = GLYPH[c.kind]
      if (!sym) continue
      const [wx, wy] = constraintAnchor(sketch, c)
      const key = `${Math.round(wx)},${Math.round(wy)}`
      const idx = anchorCount.get(key) ?? 0
      anchorCount.set(key, idx + 1)
      drawBadge(ctx, st.view, wx, wy, sym, idx, c.driver === true, conflict)
    }
  }
}

function constraintAnchor(sketch: Sketch, c: Constraint): [number, number] {
  const first = sketch.get(c.entities[0])
  if (first?.kind === 'line') return midOfLine(sketch, first.id)
  if (first?.kind === 'circle') {
    const ctr = sketch.point(first.c)
    return [ctr.x + first.r, ctr.y]
  }
  if (first?.kind === 'point') {
    const second = sketch.get(c.entities[1])
    if (second?.kind === 'point') return [(first.x + second.x) / 2, (first.y + second.y) / 2]
    return [first.x, first.y]
  }
  return [0, 0]
}

function drawBadge(
  ctx: CanvasRenderingContext2D,
  v: View,
  wx: number,
  wy: number,
  text: string,
  idx: number,
  driver: boolean,
  conflict: boolean,
) {
  const [sx, sy] = worldToScreen(v, wx, wy)
  const ox = 14 + (idx % 3) * 20
  const oy = -14 - Math.floor(idx / 3) * 20
  const bx = sx + ox
  const by = sy + oy
  const rr = 9
  ctx.beginPath()
  ctx.arc(bx, by, rr, 0, Math.PI * 2)
  ctx.fillStyle = COL.glyphBg
  ctx.fill()
  ctx.strokeStyle = conflict ? COL.conflict : driver ? COL.dim : COL.glyphBorder
  ctx.lineWidth = conflict ? 1.5 : 1
  ctx.stroke()
  ctx.fillStyle = conflict ? COL.conflict : driver ? COL.dim : COL.glyphText
  ctx.font = '11px ui-monospace, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, bx, by + 0.5)
}

function drawDistanceDim(ctx: CanvasRenderingContext2D, sketch: Sketch, c: Constraint, st: RenderState, conflict: boolean) {
  const v = st.view
  const a = sketch.point(c.entities[0])
  const b = sketch.point(c.entities[1])
  const [ax, ay] = worldToScreen(v, a.x, a.y)
  const [bx, by] = worldToScreen(v, b.x, b.y)
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  const off = 22
  const p1x = ax + nx * off
  const p1y = ay + ny * off
  const p2x = bx + nx * off
  const p2y = by + ny * off
  ctx.strokeStyle = conflict ? COL.conflict : COL.dim
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(ax, ay)
  ctx.lineTo(p1x + nx * 4, p1y + ny * 4)
  ctx.moveTo(bx, by)
  ctx.lineTo(p2x + nx * 4, p2y + ny * 4)
  ctx.moveTo(p1x, p1y)
  ctx.lineTo(p2x, p2y)
  ctx.stroke()
  drawDimLabel(ctx, (p1x + p2x) / 2, (p1y + p2y) / 2, `${(c.value ?? 0).toFixed(0)}`, c.driver === true, conflict)
}

function drawRadiusDim(ctx: CanvasRenderingContext2D, sketch: Sketch, c: Constraint, st: RenderState, conflict: boolean) {
  const v = st.view
  const circ = sketch.circle(c.entities[0])
  const ctr = sketch.point(circ.c)
  const [cx, cy] = worldToScreen(v, ctr.x, ctr.y)
  const ang = -Math.PI / 4
  const ex = cx + Math.cos(ang) * circ.r * v.scale
  const ey = cy + Math.sin(ang) * circ.r * v.scale
  ctx.strokeStyle = conflict ? COL.conflict : COL.dim
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.lineTo(ex, ey)
  ctx.stroke()
  const label = (c.kind === 'diameter' ? '⌀' : 'R') + (c.value ?? 0).toFixed(0)
  drawDimLabel(ctx, ex, ey, label, false, conflict)
}

function drawAngleDim(ctx: CanvasRenderingContext2D, sketch: Sketch, c: Constraint, st: RenderState, conflict: boolean) {
  const v = st.view
  const l0 = sketch.line(c.entities[0])
  const l1 = sketch.line(c.entities[1])
  // Draw the arc at l1's base point (the moving line's pivot).
  const pivot = sketch.point(l1.p1)
  const [px, py] = worldToScreen(v, pivot.x, pivot.y)
  const d0 = sketch.lineDir(l0)
  const d1 = sketch.lineDir(l1)
  const a0 = Math.atan2(-d0.dy, d0.dx)
  const a1 = Math.atan2(-d1.dy, d1.dx)
  const rad = 30
  ctx.strokeStyle = conflict ? COL.conflict : COL.dim
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(px, py, rad, Math.min(a0, a1), Math.max(a0, a1))
  ctx.stroke()
  const mid = (a0 + a1) / 2
  drawDimLabel(ctx, px + Math.cos(mid) * (rad + 12), py + Math.sin(mid) * (rad + 12), `${(c.value ?? 0).toFixed(0)}°`, c.driver === true, conflict)
}

function drawDimLabel(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, driver: boolean, conflict = false) {
  ctx.font = '11px ui-monospace, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const w = ctx.measureText(text).width + 8
  ctx.fillStyle = COL.glyphBg
  ctx.fillRect(x - w / 2, y - 8, w, 16)
  ctx.fillStyle = conflict ? COL.conflict : driver ? '#ffd166' : COL.dim
  ctx.fillText(text, x, y + 0.5)
}
