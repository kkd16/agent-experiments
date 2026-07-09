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
    }
  }
  return best
}
