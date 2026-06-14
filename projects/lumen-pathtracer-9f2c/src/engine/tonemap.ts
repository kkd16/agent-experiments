// tonemap.ts — convert the linear HDR accumulation buffer into displayable
// 8-bit sRGB. Runs on the UI thread every frame, so it is written to be cheap
// and branch-light over the whole image.

import type { ToneMapping } from './types'

// sRGB opto-electronic transfer function (the real piecewise curve, not a bare
// 1/2.2 power) for operators that output linear values.
function encodeSrgb(c: number): number {
  if (c <= 0) return 0
  if (c >= 1) return 1
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

// ACES filmic (Narkowicz fit) — the default; pleasing highlight roll-off.
function aces(x: number): number {
  const a = 2.51
  const b = 0.03
  const c = 2.43
  const d = 0.59
  const e = 0.14
  return clamp01((x * (a * x + b)) / (x * (c * x + d) + e))
}

// Hejl–Burgess-Dawson filmic — bakes the sRGB gamma into the curve.
function hejl(x: number): number {
  const t = Math.max(0, x - 0.004)
  return (t * (6.2 * t + 0.5)) / (t * (6.2 * t + 1.7) + 0.06)
}

// Map one HDR channel value to a 0..255 byte under the chosen operator.
function mapChannel(x: number, op: ToneMapping): number {
  switch (op) {
    case 'aces':
      return encodeSrgb(aces(x)) * 255
    case 'reinhard':
      return encodeSrgb(clamp01(x / (1 + x))) * 255
    case 'filmic':
      return clamp01(hejl(x)) * 255 // gamma already included
    case 'linear':
      return encodeSrgb(clamp01(x)) * 255
  }
}

// A perceptual "inferno"-style ramp (black → purple → red → orange → yellow →
// white) for visualising scalar fields. `t` is clamped to [0,1]. Returned as
// 0..255 sRGB-ready bytes.
function heat(t: number): [number, number, number] {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  // Polynomial fit to the inferno colormap (Mikhail Matrosov / fitting community).
  const r = Math.sqrt(x) * (0.4 + x * (1.9 - x * 0.9))
  const g = x * x * (x * (2.6 - x * 1.3) - 0.35)
  const b = Math.sin(Math.PI * 0.85 * x) * (0.55 - 0.45 * x) + x * x * x * 0.7
  return [clamp01(r) * 255, clamp01(g) * 255, clamp01(b) * 255]
}

// Render a per-pixel scalar noise field (e.g. relative error) as a heatmap into
// an RGBA byte buffer. `gain` scales the field before the colour ramp so a small
// target noise still spans the palette.
export function noiseToBytes(noise: Float32Array, out: Uint8ClampedArray, gain: number): void {
  const n = noise.length | 0
  for (let i = 0; i < n; i++) {
    const [r, g, b] = heat(noise[i] * gain)
    out[i * 4] = r
    out[i * 4 + 1] = g
    out[i * 4 + 2] = b
    out[i * 4 + 3] = 255
  }
}

// Tone-map an averaged linear-RGB float buffer into an RGBA byte buffer.
// `hdr` holds interleaved rgb already divided by the sample count.
export function tonemapToBytes(
  hdr: Float32Array,
  out: Uint8ClampedArray,
  exposure: number,
  op: ToneMapping,
): void {
  const n = (hdr.length / 3) | 0
  const ev = Math.pow(2, exposure) // exposure in stops
  for (let i = 0; i < n; i++) {
    const r = hdr[i * 3] * ev
    const g = hdr[i * 3 + 1] * ev
    const b = hdr[i * 3 + 2] * ev
    out[i * 4] = mapChannel(r, op)
    out[i * 4 + 1] = mapChannel(g, op)
    out[i * 4 + 2] = mapChannel(b, op)
    out[i * 4 + 3] = 255
  }
}
