// World ↔ screen mapping for the canvas. World coordinates are engineering
// metres with y pointing up; screen coordinates are CSS pixels with y down.

export interface View {
  scale: number // pixels per metre
  ox: number // screen x of world origin
  oy: number // screen y of world origin
}

export interface Bounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export function worldToScreen(v: View, wx: number, wy: number): [number, number] {
  return [v.ox + wx * v.scale, v.oy - wy * v.scale]
}

export function screenToWorld(v: View, sx: number, sy: number): [number, number] {
  return [(sx - v.ox) / v.scale, (v.oy - sy) / v.scale]
}

/** Fit `bounds` into a `w`×`h` viewport with `pad` pixels of margin. */
export function fitView(bounds: Bounds, w: number, h: number, pad = 60): View {
  const bw = Math.max(bounds.maxX - bounds.minX, 1e-6)
  const bh = Math.max(bounds.maxY - bounds.minY, 1e-6)
  const scale = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh)
  const cx = (bounds.minX + bounds.maxX) / 2
  const cy = (bounds.minY + bounds.maxY) / 2
  return {
    scale,
    ox: w / 2 - cx * scale,
    oy: h / 2 + cy * scale,
  }
}

/** Zoom by `factor` about screen point (sx, sy), keeping that point fixed. */
export function zoomAt(v: View, sx: number, sy: number, factor: number): View {
  const [wx, wy] = screenToWorld(v, sx, sy)
  const scale = Math.max(1e-3, v.scale * factor)
  return {
    scale,
    ox: sx - wx * scale,
    oy: sy + wy * scale,
  }
}

export function pan(v: View, dx: number, dy: number): View {
  return { ...v, ox: v.ox + dx, oy: v.oy + dy }
}
