// The density-field renderer. A strange attractor is an *orbit*: a single point
// hopping chaotically forever, and where it lingers is where the structure is.
// Drawing the iterates as a polyline (the `line` render style) connects hops
// that are nowhere near each other and buries the structure in spurious chords.
// Splatting them instead — accumulating millions of iterates into a per-pixel
// histogram and tone-mapping that field through the palette — is how the famous
// luminous attractor "nebulae" are made. This module owns that path.
//
// It renders into a *capped-resolution* offscreen canvas (the histogram is the
// expensive part, so we never build it bigger than `MAX_RES`) and lets the
// caller blit + scale it onto the real canvas, with the layer's blend, opacity
// and kaleidoscope handled exactly like the line renderer.

import { iterateAttractor } from './curves'
import type { LayerData } from './harmonograph'
import type { Layer } from './types'
import type { Transform } from './render'

const MAX_RES = 1400 // histogram resolution cap (independent of export scale)

type RGB = [number, number, number]

function hexToRgb(hex: string): RGB {
  let h = hex.replace('#', '').trim()
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ]
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// Build a 256-entry lookup table for the palette ramp so the per-pixel tone-map
// loop is a single array read instead of a multiply-add across colour stops.
function rampLUT(colors: string[]): RGB[] {
  const stops = colors.length ? colors.map(hexToRgb) : ([[255, 255, 255]] as RGB[])
  const lut: RGB[] = new Array(256)
  for (let i = 0; i < 256; i++) {
    const t = i / 255
    if (stops.length === 1) {
      lut[i] = stops[0]
      continue
    }
    const x = t * (stops.length - 1)
    const j = Math.min(Math.floor(x), stops.length - 2)
    const f = x - j
    const a = stops[j]
    const b = stops[j + 1]
    lut[i] = [
      Math.round(a[0] + (b[0] - a[0]) * f),
      Math.round(a[1] + (b[1] - a[1]) * f),
      Math.round(a[2] + (b[2] - a[2]) * f),
    ]
  }
  return lut
}

export interface DensityResult {
  canvas: HTMLCanvasElement
  res: number
}

// Render a layer's density field to an offscreen canvas. Returns null if a
// canvas can't be created (e.g. a degraded sandbox) so the caller can skip it.
// `quality` (0..1) scales the iteration budget for cheap live/animation frames;
// `trace` (0..1) reveals the field progressively for the drawing-pass animation
// (the attractor literally materialises out of noise as the trace advances).
export function renderDensity(
  layer: Layer,
  data: LayerData,
  tf: Transform,
  size: number,
  trace: number,
  quality: number,
): DensityResult | null {
  let canvas: HTMLCanvasElement
  try {
    canvas = document.createElement('canvas')
  } catch {
    return null
  }
  const res = Math.min(size, MAX_RES)
  canvas.width = res
  canvas.height = res
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const ds = layer.style.density ?? { iterations: 350, exposure: 1, gamma: 0.5 }
  const hits = new Float32Array(res * res)
  const sc = res / size // model→pixel uses the full-size transform, scaled down

  const tr = trace >= 1 ? 1 : Math.max(0.02, clamp01(trace))
  let maxHit = 0
  const splat = (mx: number, my: number) => {
    const px = ((tf.ox + mx * tf.scale) * sc) | 0
    const py = ((tf.oy + my * tf.scale) * sc) | 0
    if (px < 0 || py < 0 || px >= res || py >= res) return
    const idx = py * res + px
    const v = (hits[idx] += 1)
    if (v > maxHit) maxHit = v
  }

  if (layer.kind === 'attractor' && layer.attractor) {
    let count = Math.round(ds.iterations * 1000 * Math.max(0.05, quality) * tr)
    count = Math.max(2000, Math.min(count, 4_000_000))
    iterateAttractor(layer.attractor, count, splat)
  } else {
    // Any other curve can be density-splatted too — its sampled points become a
    // soft dotted field. Less dramatic than an attractor, but consistent.
    const pts = data.points
    const limit = tr >= 1 ? pts.length : Math.max(2, Math.floor(pts.length * tr))
    for (let i = 0; i < limit; i++) splat(pts[i].x, pts[i].y)
  }

  if (maxHit <= 0) return { canvas, res } // nothing landed on-canvas

  // Tone-map: log compress (so the dynamic range of a chaotic orbit fits), then
  // a gamma to lift faint filaments, then through the palette. Alpha tracks
  // brightness so sparse regions fade into the background instead of fogging it.
  const lut = rampLUT(layer.style.colors)
  const exposure = Math.max(0.05, ds.exposure)
  const gamma = Math.max(0.1, ds.gamma)
  const denom = Math.log1p(maxHit * exposure)
  const img = ctx.createImageData(res, res)
  const out = img.data
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]
    if (h <= 0) continue
    let t = denom > 0 ? Math.log1p(h * exposure) / denom : 0
    t = Math.pow(clamp01(t), gamma)
    const c = lut[Math.min(255, (t * 255) | 0)]
    const o = i * 4
    out[o] = c[0]
    out[o + 1] = c[1]
    out[o + 2] = c[2]
    out[o + 3] = Math.min(255, (t * 255) | 0)
  }
  ctx.putImageData(img, 0, 0)
  return { canvas, res }
}
