// Precompute a target's density field into an offscreen canvas once, so the
// animation loop only has to blit it. Also exposes the world↔pixel transform
// that every overlay (chain trail, trajectories, points) shares.

import { inferno } from './colormap'
import type { Target } from '../targets/targets'

export interface Transform {
  view: [number, number, number, number]
  w: number
  h: number
  toPx: (x: number, y: number) => [number, number]
  toWorld: (px: number, py: number) => [number, number]
}

export function makeTransform(view: [number, number, number, number], w: number, h: number): Transform {
  const [xMin, xMax, yMin, yMax] = view
  return {
    view,
    w,
    h,
    toPx: (x, y) => [((x - xMin) / (xMax - xMin)) * w, h - ((y - yMin) / (yMax - yMin)) * h],
    toWorld: (px, py) => [xMin + (px / w) * (xMax - xMin), yMin + ((h - py) / h) * (yMax - yMin)],
  }
}

/**
 * Render the density onto an offscreen canvas at `res`×`res`, colour-mapped
 * with a mild power stretch so the tails stay visible. Returns the canvas
 * ready to be drawn scaled onto the main view.
 */
export function renderField(target: Target, res = 240): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = res
  cv.height = res
  const ctx = cv.getContext('2d')!
  const img = ctx.createImageData(res, res)
  const [xMin, xMax, yMin, yMax] = target.view

  // First pass: log-densities and their range.
  const vals = new Float64Array(res * res)
  let lo = Infinity
  let hi = -Infinity
  for (let j = 0; j < res; j++) {
    const y = yMin + ((res - 1 - j) / (res - 1)) * (yMax - yMin)
    for (let i = 0; i < res; i++) {
      const x = xMin + (i / (res - 1)) * (xMax - xMin)
      const lp = target.logDensity([x, y])
      vals[j * res + i] = lp
      if (lp < lo) lo = lp
      if (lp > hi) hi = lp
    }
  }
  // Clamp the floor so the near-zero background doesn't wash everything grey.
  const floor = hi - 14
  const span = hi - Math.max(lo, floor) || 1

  for (let k = 0; k < res * res; k++) {
    let t = (vals[k] - Math.max(lo, floor)) / span
    t = Math.max(0, Math.min(1, t))
    t = Math.pow(t, 0.85) // gentle stretch toward the tails
    const [r, g, b] = inferno(t)
    img.data[k * 4] = r
    img.data[k * 4 + 1] = g
    img.data[k * 4 + 2] = b
    img.data[k * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return cv
}
