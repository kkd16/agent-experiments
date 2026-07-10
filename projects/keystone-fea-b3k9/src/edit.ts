// Pure editing operations on a FrameModel. Kept side-effect free so the UI can
// treat models immutably (and so they can be unit-tested in Node).

import type { FrameModel, SupportKind } from './engine/frame'
import { cloneFrame } from './state'

const SUPPORT_CYCLE: SupportKind[] = ['free', 'pin', 'roller-x', 'roller-y', 'fixed']

export function defaultMember(type: FrameModel['type']) {
  return type === 'truss'
    ? { E: 210e9, A: 4e-3, I: 1 }
    : { E: 210e9, A: 1e-2, I: 2e-4 }
}

export function addNode(m: FrameModel, x: number, y: number): FrameModel {
  const next = cloneFrame(m)
  next.nodes.push({ x, y, support: 'free' })
  return next
}

export function moveNode(m: FrameModel, i: number, x: number, y: number): FrameModel {
  const next = cloneFrame(m)
  if (next.nodes[i]) {
    next.nodes[i].x = x
    next.nodes[i].y = y
  }
  return next
}

export function addMember(m: FrameModel, a: number, b: number): FrameModel {
  if (a === b) return m
  // No duplicate members between the same pair.
  if (m.members.some((mm) => (mm.a === a && mm.b === b) || (mm.a === b && mm.b === a))) return m
  const next = cloneFrame(m)
  next.members.push({ a, b, ...defaultMember(m.type) })
  return next
}

export function cycleSupport(m: FrameModel, i: number): FrameModel {
  const next = cloneFrame(m)
  const cur = next.nodes[i].support
  const idx = SUPPORT_CYCLE.indexOf(cur)
  next.nodes[i].support = SUPPORT_CYCLE[(idx + 1) % SUPPORT_CYCLE.length]
  return next
}

export function setSupport(m: FrameModel, i: number, s: SupportKind): FrameModel {
  const next = cloneFrame(m)
  next.nodes[i].support = s
  return next
}

export function setLoad(
  m: FrameModel,
  node: number,
  fx: number,
  fy: number,
  mz: number,
): FrameModel {
  const next = cloneFrame(m)
  next.loads = next.loads.filter((l) => l.node !== node)
  if (fx !== 0 || fy !== 0 || mz !== 0) next.loads.push({ node, fx, fy, mz })
  return next
}

export function getLoad(m: FrameModel, node: number) {
  return m.loads.find((l) => l.node === node) ?? { node, fx: 0, fy: 0, mz: 0 }
}

export function deleteMember(m: FrameModel, i: number): FrameModel {
  const next = cloneFrame(m)
  next.members.splice(i, 1)
  return next
}

export function deleteNode(m: FrameModel, i: number): FrameModel {
  const next = cloneFrame(m)
  next.nodes.splice(i, 1)
  // Drop members touching i; remap indices above i.
  next.members = next.members
    .filter((mm) => mm.a !== i && mm.b !== i)
    .map((mm) => ({ ...mm, a: mm.a > i ? mm.a - 1 : mm.a, b: mm.b > i ? mm.b - 1 : mm.b }))
  next.loads = next.loads
    .filter((l) => l.node !== i)
    .map((l) => ({ ...l, node: l.node > i ? l.node - 1 : l.node }))
  return next
}

/** Screen-space nearest node within `tol` px, using undeformed geometry. */
export function pickNode(
  m: FrameModel,
  toScreen: (x: number, y: number) => [number, number],
  sx: number,
  sy: number,
  tol = 12,
): number | null {
  let best = -1
  let bd = tol * tol
  m.nodes.forEach((n, i) => {
    const [x, y] = toScreen(n.x, n.y)
    const d = (x - sx) ** 2 + (y - sy) ** 2
    if (d < bd) {
      bd = d
      best = i
    }
  })
  return best >= 0 ? best : null
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy || 1
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

export function pickMember(
  m: FrameModel,
  toScreen: (x: number, y: number) => [number, number],
  sx: number,
  sy: number,
  tol = 8,
): number | null {
  let best = -1
  let bd = tol
  m.members.forEach((mm, i) => {
    const [ax, ay] = toScreen(m.nodes[mm.a].x, m.nodes[mm.a].y)
    const [bx, by] = toScreen(m.nodes[mm.b].x, m.nodes[mm.b].y)
    const d = distToSeg(sx, sy, ax, ay, bx, by)
    if (d < bd) {
      bd = d
      best = i
    }
  })
  return best >= 0 ? best : null
}
