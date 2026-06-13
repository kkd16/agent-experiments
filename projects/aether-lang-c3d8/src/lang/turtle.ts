// Aether — turtle interpreter
//
// Folds the VM's stream of side-effecting turtle commands into concrete line
// segments plus a bounding box, so the canvas can auto-fit any drawing. The
// turtle starts facing up; `turn` is counter-clockwise (left) in degrees.

import type { TurtleCmd } from './values.ts'

export interface Segment {
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  width: number
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface TurtleResult {
  segments: Segment[]
  bounds: Bounds
}

interface TurtleState {
  x: number
  y: number
  heading: number
  color: string
  width: number
  pen: boolean
}

function rgb(r: number, g: number, b: number): string {
  const clamp = (n: number): number => Math.max(0, Math.min(255, n | 0))
  return `rgb(${clamp(r)}, ${clamp(g)}, ${clamp(b)})`
}

export function interpretTurtle(cmds: TurtleCmd[]): TurtleResult {
  let st: TurtleState = { x: 0, y: 0, heading: 90, color: 'rgb(124, 156, 255)', width: 2, pen: true }
  const stack: TurtleState[] = []
  const segments: Segment[] = []
  const bounds: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 }

  const grow = (x: number, y: number): void => {
    if (x < bounds.minX) bounds.minX = x
    if (y < bounds.minY) bounds.minY = y
    if (x > bounds.maxX) bounds.maxX = x
    if (y > bounds.maxY) bounds.maxY = y
  }

  const move = (dist: number): void => {
    const rad = (st.heading * Math.PI) / 180
    const nx = st.x + Math.cos(rad) * dist
    const ny = st.y - Math.sin(rad) * dist
    if (st.pen) {
      segments.push({ x1: st.x, y1: st.y, x2: nx, y2: ny, color: st.color, width: st.width })
    }
    st.x = nx
    st.y = ny
    grow(nx, ny)
  }

  for (const cmd of cmds) {
    switch (cmd.op) {
      case 'forward':
        move(cmd.dist)
        break
      case 'back':
        move(-cmd.dist)
        break
      case 'turn':
        st.heading += cmd.deg
        break
      case 'penUp':
        st.pen = false
        break
      case 'penDown':
        st.pen = true
        break
      case 'push':
        stack.push({ ...st })
        break
      case 'pop': {
        const prev = stack.pop()
        if (prev) st = prev
        break
      }
      case 'color':
        st.color = rgb(cmd.r, cmd.g, cmd.b)
        break
      case 'width':
        st.width = Math.max(0.1, cmd.w)
        break
      case 'clear':
        segments.length = 0
        stack.length = 0
        st = { x: 0, y: 0, heading: 90, color: st.color, width: st.width, pen: true }
        bounds.minX = 0
        bounds.minY = 0
        bounds.maxX = 0
        bounds.maxY = 0
        break
    }
  }

  return { segments, bounds }
}
