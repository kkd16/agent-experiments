// Space-aware color interpolation. Mixing two colors at parameter t means: convert both into the
// chosen working space, lerp the coordinates (treating hue specially in cylindrical spaces), then
// convert back to sRGB and clamp into gamut. This is what makes "interpolate in Oklch vs sRGB"
// produce visibly different ramps from the same two endpoints.

import {
  clamp01,
  clampRgb,
  hslToRgb,
  lchToRgb,
  labToRgb,
  oklabToRgb,
  oklchToRgb,
  rgbToHsl,
  rgbToLab,
  rgbToLch,
  rgbToLinear,
  rgbToOklab,
  rgbToOklch,
  linearToRgb,
  wrapHue,
} from './convert'
import type { Gradient, HueMode, InterpSpace, RGBA, Stop } from './types'

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** Interpolate a hue angle (degrees) the way `mode` dictates. */
export function lerpHue(h0: number, h1: number, t: number, mode: HueMode): number {
  const a = wrapHue(h0)
  const b = wrapHue(h1)
  let d = b - a
  switch (mode) {
    case 'shorter':
      if (d > 180) d -= 360
      else if (d < -180) d += 360
      break
    case 'longer':
      if (d > 0 && d < 180) d -= 360
      else if (d <= 0 && d > -180) d += 360
      break
    case 'increasing':
      if (d < 0) d += 360
      break
    case 'decreasing':
      if (d > 0) d -= 360
      break
  }
  return wrapHue(a + d * t)
}

/** Mix two sRGB colors at t∈[0,1] in the given working space. Alpha is linear. */
export function mix(c0: RGBA, c1: RGBA, t: number, space: InterpSpace, hue: HueMode): RGBA {
  const a = clamp01(lerp(c0.a, c1.a, t))
  let rgb
  switch (space) {
    case 'srgb':
      rgb = { r: lerp(c0.r, c1.r, t), g: lerp(c0.g, c1.g, t), b: lerp(c0.b, c1.b, t) }
      break
    case 'linear': {
      const l0 = rgbToLinear(c0)
      const l1 = rgbToLinear(c1)
      rgb = linearToRgb({ r: lerp(l0.r, l1.r, t), g: lerp(l0.g, l1.g, t), b: lerp(l0.b, l1.b, t) })
      break
    }
    case 'oklab': {
      const a0 = rgbToOklab(c0)
      const a1 = rgbToOklab(c1)
      rgb = oklabToRgb({ L: lerp(a0.L, a1.L, t), a: lerp(a0.a, a1.a, t), b: lerp(a0.b, a1.b, t) })
      break
    }
    case 'oklch': {
      const a0 = rgbToOklch(c0)
      const a1 = rgbToOklch(c1)
      rgb = oklchToRgb({
        L: lerp(a0.L, a1.L, t),
        C: lerp(a0.C, a1.C, t),
        h: lerpHue(a0.h, a1.h, t, hue),
      })
      break
    }
    case 'lab': {
      const a0 = rgbToLab(c0)
      const a1 = rgbToLab(c1)
      rgb = labToRgb({ L: lerp(a0.L, a1.L, t), a: lerp(a0.a, a1.a, t), b: lerp(a0.b, a1.b, t) })
      break
    }
    case 'lch': {
      const a0 = rgbToLch(c0)
      const a1 = rgbToLch(c1)
      rgb = lchToRgb({
        L: lerp(a0.L, a1.L, t),
        C: lerp(a0.C, a1.C, t),
        h: lerpHue(a0.h, a1.h, t, hue),
      })
      break
    }
    case 'hsl': {
      const a0 = rgbToHsl(c0)
      const a1 = rgbToHsl(c1)
      rgb = hslToRgb({
        h: lerpHue(a0.h, a1.h, t, hue),
        s: lerp(a0.s, a1.s, t),
        l: lerp(a0.l, a1.l, t),
      })
      break
    }
  }
  const clamped = clampRgb(rgb)
  return { ...clamped, a }
}

/** Stops sorted by position, with positions clamped to [0,1]. */
export function sortedStops(stops: Stop[]): Stop[] {
  return [...stops].map((s) => ({ ...s, pos: clamp01(s.pos) })).sort((a, b) => a.pos - b.pos)
}

/** Sample the gradient at t∈[0,1], honoring its working space + hue mode. */
export function sampleAt(g: Gradient, t: number): RGBA {
  const stops = sortedStops(g.stops)
  if (stops.length === 0) return { r: 0, g: 0, b: 0, a: 1 }
  if (stops.length === 1) return stops[0].color
  if (t <= stops[0].pos) return stops[0].color
  const last = stops[stops.length - 1]
  if (t >= last.pos) return last.color
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]
    const b = stops[i + 1]
    if (t >= a.pos && t <= b.pos) {
      const span = b.pos - a.pos
      const local = span < 1e-9 ? 0 : (t - a.pos) / span
      return mix(a.color, b.color, local, g.space, g.hue)
    }
  }
  return last.color
}

/** N evenly spaced samples across the gradient. */
export function ramp(g: Gradient, n: number): RGBA[] {
  const out: RGBA[] = []
  for (let i = 0; i < n; i++) out.push(sampleAt(g, n === 1 ? 0 : i / (n - 1)))
  return out
}
