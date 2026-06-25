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

// ---- AgX (Troy Sobotka) — a modern filmic display transform -----------------
// Unlike the per-channel operators above, AgX works on the whole RGB triple. It
// rotates colour into a desaturated "inset" working space, compresses scene
// luminance over a fixed log2 window, applies a sigmoidal contrast curve, then
// rotates back ("outset"). The point is its *hue handling*: where ACES/Reinhard
// let a bright saturated colour clip to a single primary (the infamous blue-light
// → magenta, fire → pure red), AgX desaturates highlights gracefully toward white,
// keeping the look photographic. We use the widely-adopted minimal AgX: Benjamin
// Wrensch's 6th-order fit of Sobotka's contrast curve with the standard inset/
// outset matrices, returning a *linear* value (the trailing 2.2 de-gamma) so it
// composes with the shared sRGB encode below — matching the three.js implementation.
const AGX_MIN_EV = -12.47393
const AGX_MAX_EV = 4.026069

// 3×3 multiply by the AgX inset matrix. The coefficients are row-stochastic (each
// row sums to 1), so a neutral grey maps to neutral grey — the matrix only rotates
// chroma into the desaturated working space, never shifts the white point.
function agxInset(r: number, g: number, b: number): [number, number, number] {
  return [
    0.856627153315983 * r + 0.0951212405381588 * g + 0.0482516061458583 * b,
    0.137318972929847 * r + 0.761241990602591 * g + 0.101439036467562 * b,
    0.11189821299995 * r + 0.0767994186031903 * g + 0.811302368396859 * b,
  ]
}

// 3×3 multiply by the AgX outset matrix (the inverse rotation; also row-stochastic).
function agxOutset(r: number, g: number, b: number): [number, number, number] {
  return [
    1.1271005818144368 * r - 0.11060664309660323 * g - 0.016493938717834573 * b,
    -0.1413297634984383 * r + 1.157823702216272 * g - 0.016493938717834257 * b,
    -0.14132976349843826 * r - 0.11060664309660294 * g + 1.2519364065950405 * b,
  ]
}

// Wrensch's 6th-order polynomial fit to the AgX contrast sigmoid, on a [0,1] input.
export function agxContrast(x: number): number {
  const x2 = x * x
  const x4 = x2 * x2
  return (
    15.5 * x4 * x2 -
    40.14 * x4 * x +
    31.96 * x4 -
    6.868 * x2 * x +
    0.4298 * x2 +
    0.1191 * x -
    0.00232
  )
}

// AgX a single linear-RGB pixel, returning a *linear* RGB triple (apply the sRGB
// OETF afterwards). Exported for the verify suite.
export function agx(r: number, g: number, b: number): [number, number, number] {
  let [ir, ig, ib] = agxInset(Math.max(0, r), Math.max(0, g), Math.max(0, b))
  const enc = (x: number): number => {
    const l = Math.log2(Math.max(x, 1e-10))
    return clamp01((l - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV))
  }
  ir = agxContrast(enc(ir))
  ig = agxContrast(enc(ig))
  ib = agxContrast(enc(ib))
  const [or_, og, ob] = agxOutset(ir, ig, ib)
  // The contrast curve targets a ~2.2-gamma display space; de-gamma back to linear
  // so the shared sRGB encode produces the final display value (the three.js path).
  return [Math.pow(Math.max(0, or_), 2.2), Math.pow(Math.max(0, og), 2.2), Math.pow(Math.max(0, ob), 2.2)]
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
    case 'agx': {
      // AgX is RGB-coupled and handled in tonemapToBytes; this per-channel fallback
      // (gray in ⇒ gray out) is here only to keep the switch exhaustive.
      const [a] = agx(x, x, x)
      return encodeSrgb(a) * 255
    }
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
    if (op === 'agx') {
      // AgX couples the channels (highlight desaturation), so it maps the triple at
      // once and the result is linear → encode through the shared sRGB curve.
      const [ar, ag, ab] = agx(r, g, b)
      out[i * 4] = encodeSrgb(ar) * 255
      out[i * 4 + 1] = encodeSrgb(ag) * 255
      out[i * 4 + 2] = encodeSrgb(ab) * 255
    } else {
      out[i * 4] = mapChannel(r, op)
      out[i * 4 + 1] = mapChannel(g, op)
      out[i * 4 + 2] = mapChannel(b, op)
    }
    out[i * 4 + 3] = 255
  }
}
