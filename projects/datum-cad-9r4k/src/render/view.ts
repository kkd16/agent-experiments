// The view transform maps world coordinates (y-up, millimetre-ish units) to
// screen pixels (y-down). One place owns the math so hit-testing and rendering
// never disagree.
export type View = {
  ox: number // screen x of world origin
  oy: number // screen y of world origin
  scale: number // pixels per world unit
}

export function worldToScreen(v: View, x: number, y: number): [number, number] {
  return [v.ox + x * v.scale, v.oy - y * v.scale]
}

export function screenToWorld(v: View, sx: number, sy: number): [number, number] {
  return [(sx - v.ox) / v.scale, (v.oy - sy) / v.scale]
}

// A view that frames the given world bounds inside a w×h viewport with padding.
export function frameBounds(
  b: { minX: number; minY: number; maxX: number; maxY: number },
  w: number,
  h: number,
  pad = 60,
): View {
  const bw = Math.max(b.maxX - b.minX, 1)
  const bh = Math.max(b.maxY - b.minY, 1)
  const scale = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh)
  const cx = (b.minX + b.maxX) / 2
  const cy = (b.minY + b.maxY) / 2
  return { ox: w / 2 - cx * scale, oy: h / 2 + cy * scale, scale: clamp(scale, 0.2, 20) }
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
