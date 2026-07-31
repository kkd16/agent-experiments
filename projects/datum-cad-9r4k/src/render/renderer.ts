import type { Sketch } from '../model/sketch'
import type { Constraint, EntityId } from '../model/types'
import type { DofStatus } from '../solver/dof'
import type { View } from './view'
import { worldToScreen } from './view'
import { cubicPoint } from '../solver/curve'

export type TracePath = { pts: [number, number][]; color: string }

// One point's instantaneous motion, in world coordinates: position plus the
// first- and second-order kinematic coefficients (velocity / acceleration fields).
export type MotionArrow = { x: number; y: number; vx: number; vy: number; ax: number; ay: number }
export type MotionOverlay = {
  arrows: MotionArrow[]
  showVelocity: boolean
  showAccel: boolean
  tracer: EntityId | null // the traced point, emphasised
  tracerPos: [number, number] | null
}

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
  motion: MotionOverlay | null
  preview:
    | { kind: 'line' | 'circle'; from: [number, number]; to: [number, number] }
    | { kind: 'arc'; center: [number, number]; from: [number, number]; to: [number, number] }
    | { kind: 'spline'; ctrl: [number, number][]; to: [number, number] }
    | null
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
  splineHandle: '#5a6b7d',
  velocity: '#57e6c9',
  accel: '#c792ea',
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
  if (st.motion) drawMotion(ctx, v, st.motion)
  if (st.preview) drawPreview(ctx, v, st.preview)

  ctx.restore()
}

// The velocity and acceleration fields of a driven mechanism, drawn as arrows at
// each moving point. Both fields are auto-scaled independently so the largest arrow
// of each reads at a fixed on-screen length — the *shape* of the field (relative
// magnitudes and directions) is what matters, and it stays legible at any zoom or
// mechanism scale. Screen y is flipped, so the world→screen vector negates dy.
function drawMotion(ctx: CanvasRenderingContext2D, v: View, m: MotionOverlay) {
  const MAX_PX = 62 // on-screen length of the single largest arrow in each field
  let maxV = 0
  let maxA = 0
  for (const a of m.arrows) {
    maxV = Math.max(maxV, Math.hypot(a.vx, a.vy))
    maxA = Math.max(maxA, Math.hypot(a.ax, a.ay))
  }
  const drawField = (pick: (a: MotionArrow) => [number, number], max: number, color: string) => {
    if (max <= 1e-9) return
    for (const a of m.arrows) {
      const [dx, dy] = pick(a)
      const mag = Math.hypot(dx, dy)
      if (mag < max * 0.01) continue // hide numerically dead arrows
      const [sx, sy] = worldToScreen(v, a.x, a.y)
      const lenPx = (mag / max) * MAX_PX
      // Unit direction in screen space (y flips).
      const ux = (dx / mag) * lenPx
      const uy = -(dy / mag) * lenPx
      drawArrow(ctx, sx, sy, sx + ux, sy + uy, color)
    }
  }
  if (m.showVelocity) drawField((a) => [a.vx, a.vy], maxV, COL.velocity)
  if (m.showAccel) drawField((a) => [a.ax, a.ay], maxA, COL.accel)

  if (m.tracerPos) {
    const [tx, ty] = worldToScreen(v, m.tracerPos[0], m.tracerPos[1])
    ctx.beginPath()
    ctx.arc(tx, ty, 7, 0, Math.PI * 2)
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
}

function drawArrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string) {
  const ang = Math.atan2(y1 - y0, x1 - x0)
  const head = 6
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 1.8
  ctx.globalAlpha = 0.92
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(x1, y1)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x1 - head * Math.cos(ang - 0.4), y1 - head * Math.sin(ang - 0.4))
  ctx.lineTo(x1 - head * Math.cos(ang + 0.4), y1 - head * Math.sin(ang + 0.4))
  ctx.closePath()
  ctx.fill()
  ctx.globalAlpha = 1
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
    } else if (e.kind === 'arc') {
      const g = sketch.arcGeom(e)
      ctx.strokeStyle = strokeFor(e.id, st, e.construction ? COL.geoConstruction : COL.geo)
      ctx.lineWidth = st.selection.has(e.id) || st.hover === e.id || st.highlight.has(e.id) ? 3 : e.construction ? 1 : 2
      ctx.setLineDash(e.construction ? [5, 5] : [])
      strokeArcWorld(ctx, v, g.cx, g.cy, g.r, g.a0, g.sweep)
      ctx.setLineDash([])
    } else if (e.kind === 'spline') {
      const p0 = sketch.point(e.p0)
      const c0 = sketch.point(e.c0)
      const c1 = sketch.point(e.c1)
      const p1 = sketch.point(e.p1)
      const accent = st.selection.has(e.id) || st.hover === e.id || st.highlight.has(e.id)
      // The control handles: thin faint tethers from each endpoint to its control
      // point, so the (draggable) control points read as handles rather than strays.
      const [h0x, h0y] = worldToScreen(v, p0.x, p0.y)
      const [k0x, k0y] = worldToScreen(v, c0.x, c0.y)
      const [k1x, k1y] = worldToScreen(v, c1.x, c1.y)
      const [h1x, h1y] = worldToScreen(v, p1.x, p1.y)
      ctx.strokeStyle = COL.splineHandle
      ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(h0x, h0y)
      ctx.lineTo(k0x, k0y)
      ctx.moveTo(h1x, h1y)
      ctx.lineTo(k1x, k1y)
      ctx.stroke()
      ctx.setLineDash([])
      // The curve itself. A cubic Bézier is affine-invariant, so projecting the four
      // control points and calling bezierCurveTo draws the exact projected curve.
      ctx.strokeStyle = strokeFor(e.id, st, e.construction ? COL.geoConstruction : COL.geo)
      ctx.lineWidth = accent ? 3 : e.construction ? 1 : 2
      ctx.setLineDash(e.construction ? [5, 5] : [])
      ctx.beginPath()
      ctx.moveTo(h0x, h0y)
      ctx.bezierCurveTo(k0x, k0y, k1x, k1y, h1x, h1y)
      ctx.stroke()
      ctx.setLineDash([])
    }
  }
}

// Stroke a circular arc by sampling it in world space and projecting each sample —
// robust against the screen's y-flip (a world CCW sweep would otherwise need a
// reversed canvas-arc direction). Sampled densely enough to read as smooth.
function strokeArcWorld(
  ctx: CanvasRenderingContext2D,
  v: View,
  cx: number,
  cy: number,
  r: number,
  a0: number,
  sweep: number,
) {
  const rpx = r * v.scale
  const segs = Math.max(8, Math.min(240, Math.ceil((rpx * sweep) / 4)))
  ctx.beginPath()
  for (let i = 0; i <= segs; i++) {
    const a = a0 + (sweep * i) / segs
    const [sx, sy] = worldToScreen(v, cx + Math.cos(a) * r, cy + Math.sin(a) * r)
    if (i === 0) ctx.moveTo(sx, sy)
    else ctx.lineTo(sx, sy)
  }
  ctx.stroke()
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

function drawPreview(ctx: CanvasRenderingContext2D, v: View, p: NonNullable<RenderState['preview']>) {
  ctx.strokeStyle = COL.pending
  ctx.lineWidth = 1.5
  ctx.setLineDash([4, 4])
  if (p.kind === 'arc') {
    // Preview the arc under construction: center fixed, radius set by the start
    // point, sweeping CCW from the start to the cursor's angle.
    const [cx, cy] = p.center
    const r = Math.hypot(p.from[0] - cx, p.from[1] - cy)
    const a0 = Math.atan2(p.from[1] - cy, p.from[0] - cx)
    const a1 = Math.atan2(p.to[1] - cy, p.to[0] - cx)
    let sweep = a1 - a0
    while (sweep <= 0) sweep += Math.PI * 2
    while (sweep > Math.PI * 2) sweep -= Math.PI * 2
    strokeArcWorld(ctx, v, cx, cy, r, a0, sweep)
    ctx.setLineDash([])
    return
  }
  if (p.kind === 'spline') {
    // The control points placed so far, plus the cursor, in world space.
    const pts = [...p.ctrl, p.to]
    // The control polygon.
    ctx.beginPath()
    for (let i = 0; i < pts.length; i++) {
      const [sx, sy] = worldToScreen(v, pts[i][0], pts[i][1])
      if (i === 0) ctx.moveTo(sx, sy)
      else ctx.lineTo(sx, sy)
    }
    ctx.stroke()
    // A live cubic, padding any not-yet-placed control points with the cursor so
    // the curve reads plausibly at every click of the four-point gesture.
    const cp = [p.ctrl[0] ?? p.to, p.ctrl[1] ?? p.to, p.ctrl[2] ?? p.to, p.to]
    const s0 = worldToScreen(v, cp[0][0], cp[0][1])
    const s1 = worldToScreen(v, cp[1][0], cp[1][1])
    const s2 = worldToScreen(v, cp[2][0], cp[2][1])
    const s3 = worldToScreen(v, cp[3][0], cp[3][1])
    ctx.strokeStyle = COL.geo
    ctx.beginPath()
    ctx.moveTo(s0[0], s0[1])
    ctx.bezierCurveTo(s1[0], s1[1], s2[0], s2[1], s3[0], s3[1])
    ctx.stroke()
    ctx.setLineDash([])
    return
  }
  const [ax, ay] = worldToScreen(v, p.from[0], p.from[1])
  const [bx, by] = worldToScreen(v, p.to[0], p.to[1])
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
  splineTangentLine: '⌒',
  splineTangentSpline: '⌒',
  splineTangentArc: '⌒',
  pointOnSpline: '∿',
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
    } else if (c.kind === 'splineLength') {
      drawSplineLengthDim(ctx, sketch, c, st, conflict)
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
  if (first?.kind === 'arc') {
    // Anchor a badge at the arc's midpoint, on the curve.
    const g = sketch.arcGeom(first)
    const a = g.a0 + g.sweep / 2
    return [g.cx + Math.cos(a) * g.r, g.cy + Math.sin(a) * g.r]
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
  const circ = sketch.circleLike(c.entities[0])
  const ctr = sketch.point(circ.c)
  const [cx, cy] = worldToScreen(v, ctr.x, ctr.y)
  // For an arc, run the leader out to the arc's midpoint so it lands on the curve;
  // for a full circle a fixed −45° reads cleanly.
  let ang = -Math.PI / 4
  if (circ.kind === 'arc') {
    const g = sketch.arcGeom(circ)
    // Screen angle of the arc midpoint (y is flipped on screen).
    ang = -(g.a0 + g.sweep / 2)
  }
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

// A spline's arc-length dimension: an "L…" badge floated just above the curve's
// midpoint (the point B(0.5)), so it reads as a measurement of that curve.
function drawSplineLengthDim(ctx: CanvasRenderingContext2D, sketch: Sketch, c: Constraint, st: RenderState, conflict: boolean) {
  const v = st.view
  const s = sketch.spline(c.entities[0])
  const P = (id: EntityId): [number, number] => {
    const p = sketch.point(id)
    return [p.x, p.y]
  }
  const mid = cubicPoint(P(s.p0), P(s.c0), P(s.c1), P(s.p1), 0.5)
  const [mx, my] = worldToScreen(v, mid[0], mid[1])
  drawDimLabel(ctx, mx, my - 16, `L${(c.value ?? 0).toFixed(0)}`, c.driver === true, conflict)
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
