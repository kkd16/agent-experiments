// Layout math: component box sizing and pin coordinates in world space.
import type { Kind } from './kinds'
import { kindMeta } from './kinds'

export interface Comp {
  id: string
  kind: Kind
  x: number
  y: number
  label?: string
  // runtime state (mutated by the engine)
  outs: boolean[]
  prevClk: boolean
  clkAccum: number
}

export interface PinRef {
  comp: string
  pin: number
}

export interface Wire {
  id: string
  from: PinRef // an output pin
  to: PinRef // an input pin
}

export const GRID = 20
export const BODY_W = 70
export const PIN_GAP = 26
export const HEADER = 22

export function bodyHeight(kind: Kind): number {
  const m = kindMeta(kind)
  const rows = Math.max(m.numIn, m.numOut, 1)
  return HEADER + rows * PIN_GAP
}

export function bodyWidth(kind: Kind): number {
  return kind === 'SEG7' ? 58 : BODY_W
}

function pinY(kind: Kind, count: number, index: number): number {
  const h = bodyHeight(kind)
  const span = count === 1 ? 0 : (count - 1) * PIN_GAP
  const top = HEADER + (h - HEADER - span) / 2
  return top + index * PIN_GAP
}

export function inputPin(comp: Comp, index: number): { x: number; y: number } {
  const m = kindMeta(comp.kind)
  return { x: comp.x, y: comp.y + pinY(comp.kind, m.numIn, index) }
}

export function outputPin(comp: Comp, index: number): { x: number; y: number } {
  const m = kindMeta(comp.kind)
  return { x: comp.x + bodyWidth(comp.kind), y: comp.y + pinY(comp.kind, m.numOut, index) }
}

export function snap(v: number): number {
  return Math.round(v / GRID) * GRID
}

/** Squared distance from point p to the wire's cubic bezier midpoint region (cheap hit test). */
export function pointNearSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy || 1
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx
  const cy = ay + t * dy
  return (px - cx) ** 2 + (py - cy) ** 2
}
