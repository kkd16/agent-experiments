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
