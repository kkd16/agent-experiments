// Turn a Gradient into the things you can ship: a portable CSS string, an SVG, a PNG, or raw
// ImageData. CSS/SVG gradients only ever interpolate in sRGB between the stops you give them, so
// to make the *perceptual* interpolation portable we "densify": sample the gradient at many points
// and emit those as plain stops. The result is a vanilla CSS gradient that nonetheless follows the
// Oklch (or whichever) curve — paste it anywhere.

import { rgbaToCss, rgbaToHex, round } from './convert'
import { ramp, sampleAt, sortedStops } from './interpolate'
import type { Gradient, RGBA } from './types'

/** Number of samples used to bake perceptual interpolation into CSS/SVG. */
const DENSITY = 24

function densify(g: Gradient, n = DENSITY): { color: RGBA; pos: number }[] {
  // For the perceptual spaces we sample evenly; for plain sRGB we can keep the original stops
  // (no densification needed — CSS already does sRGB). This keeps simple gradients tidy.
  if (g.space === 'srgb') {
    return sortedStops(g.stops).map((s) => ({ color: s.color, pos: s.pos }))
  }
  const colors = ramp(g, n)
  return colors.map((color, i) => ({ color, pos: i / (n - 1) }))
}

function stopList(g: Gradient, fmt: (c: RGBA) => string): string {
  return densify(g)
    .map(({ color, pos }) => `${fmt(color)} ${round(pos * 100, 2)}%`)
    .join(', ')
}

/** A ready-to-paste CSS gradient. */
export function toCSS(g: Gradient): string {
  const stops = stopList(g, rgbaToCss)
  switch (g.type) {
    case 'linear':
      return `linear-gradient(${round(g.angle, 1)}deg, ${stops})`
    case 'radial':
      return `radial-gradient(circle at ${round(g.cx * 100, 1)}% ${round(g.cy * 100, 1)}%, ${stops})`
    case 'conic':
      return `conic-gradient(from ${round(g.angle, 1)}deg at ${round(g.cx * 100, 1)}% ${round(
        g.cy * 100,
        1,
      )}%, ${stops})`
  }
}

/** The `background:` declaration. */
export function toCSSDecl(g: Gradient): string {
  return `background: ${toCSS(g)};`
}

/** Standalone SVG markup (linear + radial). Conic falls back to a fine linear approximation note. */
export function toSVG(g: Gradient, w = 1200, h = 630): string {
  const id = 'grad'
  const stops = densify(g)
    .map(({ color, pos }) => {
      const stop = `<stop offset="${round(pos * 100, 2)}%" stop-color="${rgbaToHex({
        ...color,
        a: 1,
      })}"${color.a < 1 ? ` stop-opacity="${round(color.a, 3)}"` : ''}/>`
      return stop
    })
    .join('\n    ')

  let def: string
  if (g.type === 'radial') {
    def = `<radialGradient id="${id}" cx="${round(g.cx * 100, 1)}%" cy="${round(
      g.cy * 100,
      1,
    )}%" r="75%">\n    ${stops}\n  </radialGradient>`
  } else {
    // express the linear angle as x1,y1 → x2,y2 on the unit box
    const rad = ((g.angle - 90) * Math.PI) / 180
    const dx = Math.cos(rad)
    const dy = Math.sin(rad)
    const x1 = round(50 - dx * 50, 2)
    const y1 = round(50 - dy * 50, 2)
    const x2 = round(50 + dx * 50, 2)
    const y2 = round(50 + dy * 50, 2)
    def = `<linearGradient id="${id}" x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%">\n    ${stops}\n  </linearGradient>`
  }
  const note = g.type === 'conic' ? '\n  <!-- conic gradients have no SVG primitive; approximated as linear -->' : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${note}
  <defs>
  ${def}
  </defs>
  <rect width="${w}" height="${h}" fill="url(#${id})"/>
</svg>`
}

const BAYER8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
]

/**
 * Paint the gradient into a canvas with 8×8 ordered (Bayer) dithering, which breaks up the
 * 8-bit banding you otherwise see across a wide, smooth ramp.
 */
export function paintToCanvas(g: Gradient, ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const img = ctx.createImageData(w, h)
  const data = img.data
  const cx = g.cx * w
  const cy = g.cy * h
  const maxR = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy))
  const angleRad = (g.angle * Math.PI) / 180
  // unit vector for the linear gradient direction (CSS: 0deg points up)
  const dirX = Math.sin(angleRad)
  const dirY = -Math.cos(angleRad)

  // Precompute a fine lookup ramp for speed.
  const LUT_N = 1024
  const lut = ramp(g, LUT_N)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let t: number
      if (g.type === 'linear') {
        // project pixel onto direction, normalize by the box extent along that direction
        const nx = (x - w / 2) / w
        const ny = (y - h / 2) / h
        const proj = nx * dirX + ny * dirY
        const extent = (Math.abs(dirX) + Math.abs(dirY)) / 2
        t = 0.5 + proj / (2 * extent || 1)
      } else if (g.type === 'radial') {
        t = Math.hypot(x - cx, y - cy) / (maxR || 1)
      } else {
        let ang = Math.atan2(y - cy, x - cx) - (g.angle * Math.PI) / 180 + Math.PI / 2
        ang = ((ang % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
        t = ang / (2 * Math.PI)
      }
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const fIdx = t * (LUT_N - 1)
      const i0 = Math.floor(fIdx)
      const i1 = Math.min(LUT_N - 1, i0 + 1)
      const frac = fIdx - i0
      const c0 = lut[i0]
      const c1 = lut[i1]
      // linear blend in the LUT space (already perceptual), then dither
      const d = (BAYER8[y & 7][x & 7] + 0.5) / 64 - 0.5
      const o = (y * w + x) * 4
      data[o] = clampByte((c0.r + (c1.r - c0.r) * frac) * 255 + d)
      data[o + 1] = clampByte((c0.g + (c1.g - c0.g) * frac) * 255 + d)
      data[o + 2] = clampByte((c0.b + (c1.b - c0.b) * frac) * 255 + d)
      data[o + 3] = clampByte((c0.a + (c1.a - c0.a) * frac) * 255)
    }
  }
  ctx.putImageData(img, 0, 0)
}

const clampByte = (x: number) => (x < 0 ? 0 : x > 255 ? 255 : Math.round(x))

/** A compact JSON document for the gradient. */
export function toJSON(g: Gradient): string {
  return JSON.stringify(
    {
      type: g.type,
      angle: g.angle,
      center: [round(g.cx, 4), round(g.cy, 4)],
      space: g.space,
      hue: g.hue,
      stops: sortedStops(g.stops).map((s) => ({ color: rgbaToHex(s.color), pos: round(s.pos, 4) })),
    },
    null,
    2,
  )
}

/** Sample the gradient as a 1-D strip of CSS colors (handy for thumbnails / palettes). */
export function strip(g: Gradient, n: number): string[] {
  return ramp(g, n).map(rgbaToCss)
}

export { sampleAt }
