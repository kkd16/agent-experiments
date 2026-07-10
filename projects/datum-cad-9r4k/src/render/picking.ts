import type { Sketch } from '../model/sketch'
import type { EntityId } from '../model/types'
import type { View } from './view'
import { worldToScreen } from './view'

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

// Pick the topmost entity under the screen point. Points win over lines/circles
// because they are the interactive handles.
export function pickEntity(sketch: Sketch, v: View, sx: number, sy: number, tol = 9): EntityId | null {
  let bestPoint: EntityId | null = null
  let bestPointD = tol
  for (const e of sketch.entities) {
    if (e.kind !== 'point') continue
    const [ex, ey] = worldToScreen(v, e.x, e.y)
    const d = Math.hypot(sx - ex, sy - ey)
    if (d < bestPointD) {
      bestPointD = d
      bestPoint = e.id
    }
  }
  if (bestPoint !== null) return bestPoint

  let best: EntityId | null = null
  let bestD = tol
  for (const e of sketch.entities) {
    if (e.kind === 'line') {
      const a = sketch.point(e.p1)
      const b = sketch.point(e.p2)
      const [ax, ay] = worldToScreen(v, a.x, a.y)
      const [bx, by] = worldToScreen(v, b.x, b.y)
      const d = distToSegment(sx, sy, ax, ay, bx, by)
      if (d < bestD) {
        bestD = d
        best = e.id
      }
    } else if (e.kind === 'circle') {
      const c = sketch.point(e.c)
      const [cx, cy] = worldToScreen(v, c.x, c.y)
      const d = Math.abs(Math.hypot(sx - cx, sy - cy) - e.r * v.scale)
      if (d < bestD) {
        bestD = d
        best = e.id
      }
    } else if (e.kind === 'arc') {
      // Sample the arc into screen points (matching the renderer) and take the
      // minimum distance to that polyline — correct for any sweep and the y-flip.
      const g = sketch.arcGeom(e)
      const rpx = g.r * v.scale
      const segs = Math.max(6, Math.min(160, Math.ceil((rpx * g.sweep) / 6)))
      let prev: [number, number] | null = null
      for (let i = 0; i <= segs; i++) {
        const a = g.a0 + (g.sweep * i) / segs
        const pt = worldToScreen(v, g.cx + Math.cos(a) * g.r, g.cy + Math.sin(a) * g.r)
        if (prev) {
          const d = distToSegment(sx, sy, prev[0], prev[1], pt[0], pt[1])
          if (d < bestD) {
            bestD = d
            best = e.id
          }
        }
        prev = pt
      }
    } else if (e.kind === 'spline') {
      // Sample the cubic into a screen polyline (control points are affine-projected
      // once, then evaluated with the Bernstein basis) and take the min segment
      // distance — matching the rendered curve.
      const p0 = worldToScreen(v, sketch.point(e.p0).x, sketch.point(e.p0).y)
      const c0 = worldToScreen(v, sketch.point(e.c0).x, sketch.point(e.c0).y)
      const c1 = worldToScreen(v, sketch.point(e.c1).x, sketch.point(e.c1).y)
      const p1 = worldToScreen(v, sketch.point(e.p1).x, sketch.point(e.p1).y)
      const segs = 24
      let prev: [number, number] | null = null
      for (let i = 0; i <= segs; i++) {
        const t = i / segs
        const u = 1 - t
        const b0 = u * u * u
        const b1 = 3 * u * u * t
        const b2 = 3 * u * t * t
        const b3 = t * t * t
        const x = b0 * p0[0] + b1 * c0[0] + b2 * c1[0] + b3 * p1[0]
        const y = b0 * p0[1] + b1 * c0[1] + b2 * c1[1] + b3 * p1[1]
        if (prev) {
          const d = distToSegment(sx, sy, prev[0], prev[1], x, y)
          if (d < bestD) {
            bestD = d
            best = e.id
          }
        }
        prev = [x, y]
      }
    }
  }
  return best
}
