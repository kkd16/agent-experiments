// Gamut mapping — fitting an out-of-sRGB color back into what a screen can show, the *right* way.
//
// The naïve fix is to clamp each RGB channel to [0,1] ("clip"). That's fast but distorts hue and
// can crush detail. The CSS Color 4 approach instead reduces *chroma* in OkLCh (holding lightness
// and hue), binary-searching for the most-saturated color whose clipped version is perceptually
// indistinguishable (ΔE-OK below a just-noticeable-difference). We implement both, plus the tools
// the Gamut studio uses to *draw* the sRGB boundary: the maximum displayable chroma for any
// (lightness, hue), and the hue's cusp (its most saturated point).

import { clamp01, oklchToRgb, rgbToOklch } from './convert'
import { deltaEOkLab } from './difference'
import type { OkLab, OkLCh, RGB } from './types'

/** Is this OkLCh color inside the sRGB gamut (every channel within [0,1])? */
export function inGamut(c: OkLCh, eps = 1e-4): boolean {
  const r = oklchToRgb(c)
  return r.r >= -eps && r.r <= 1 + eps && r.g >= -eps && r.g <= 1 + eps && r.b >= -eps && r.b <= 1 + eps
}

const clip = (r: RGB): RGB => ({ r: clamp01(r.r), g: clamp01(r.g), b: clamp01(r.b) })

// Oklab of an sRGB triple, computed directly from linear light (cheaper than a full round-trip
// when we already have RGB in hand).
function rgbToOklabDirect(r: RGB): OkLab {
  // reuse the canonical pipeline via convert by going rgb→oklch→oklab would lose precision; instead
  // inline the linear→oklab leg.
  const lin = {
    r: srgbToLinear(r.r),
    g: srgbToLinear(r.g),
    b: srgbToLinear(r.b),
  }
  const l = 0.4122214708 * lin.r + 0.5363325363 * lin.g + 0.0514459929 * lin.b
  const m = 0.2119034982 * lin.r + 0.6806995451 * lin.g + 0.1073969566 * lin.b
  const s = 0.0883024619 * lin.r + 0.2817188376 * lin.g + 0.6299787005 * lin.b
  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)
  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  }
}
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

const oklchToOklab = (c: OkLCh): OkLab => {
  const r = (c.h * Math.PI) / 180
  return { L: c.L, a: c.C * Math.cos(r), b: c.C * Math.sin(r) }
}

/**
 * Map an OkLCh color into sRGB using the CSS Color 4 algorithm: reduce chroma (holding L and h)
 * via binary search until the clipped result is within a just-noticeable ΔE-OK of the unclipped
 * target. Returns a displayable sRGB triple. (Lossless if already in gamut.)
 */
export function gamutMapOklch(oklch: OkLCh): RGB {
  if (oklch.L >= 1) return { r: 1, g: 1, b: 1 }
  if (oklch.L <= 0) return { r: 0, g: 0, b: 0 }
  if (inGamut(oklch)) return oklchToRgb(oklch)

  const JND = 0.02
  const EPSILON = 1e-4
  let min = 0
  let max = oklch.C
  let minInGamut = true
  const current: OkLCh = { ...oklch }
  let clipped = clip(oklchToRgb(current))

  // If even the full-chroma clip is already close enough, take it.
  if (deltaEOkLab(rgbToOklabDirect(clipped), oklchToOklab(current)) < JND) return clipped

  while (max - min > EPSILON) {
    const chroma = (min + max) / 2
    current.C = chroma
    if (minInGamut && inGamut(current)) {
      min = chroma
    } else {
      clipped = clip(oklchToRgb(current))
      const E = deltaEOkLab(rgbToOklabDirect(clipped), oklchToOklab(current))
      if (E < JND) {
        if (JND - E < EPSILON) return clipped
        minInGamut = false
        min = chroma
      } else {
        max = chroma
      }
    }
  }
  return clip(oklchToRgb(current))
}

/** Map a (possibly out-of-gamut) sRGB color through its OkLCh into the displayable gamut. */
export function gamutMapRgb(rgb: RGB): RGB {
  return gamutMapOklch(rgbToOklch(rgb))
}

/**
 * The maximum in-gamut chroma for a given OkLCh lightness + hue (binary search). Used to trace
 * the sRGB gamut boundary in an L–C slice.
 */
export function maxChromaForLh(L: number, h: number, hi = 0.5): number {
  if (L <= 0 || L >= 1) return 0
  if (!inGamut({ L, C: 0, h })) return 0 // L itself unreachable (shouldn't happen for grays)
  let lo = 0
  let high = hi
  for (let i = 0; i < 28; i++) {
    const mid = (lo + high) / 2
    if (inGamut({ L, C: mid, h })) lo = mid
    else high = mid
  }
  return lo
}

export interface GamutPoint {
  L: number
  C: number
}

/** Sample the sRGB gamut boundary for a hue as (L, maxChroma) points across lightness. */
export function gamutSlice(h: number, n = 96): GamutPoint[] {
  const out: GamutPoint[] = []
  for (let i = 0; i <= n; i++) {
    const L = i / n
    out.push({ L, C: maxChromaForLh(L, h) })
  }
  return out
}

/** The cusp of a hue — its single most-saturated displayable point (max chroma over all L). */
export function cuspForHue(h: number, n = 128): GamutPoint {
  let best: GamutPoint = { L: 0, C: 0 }
  for (let i = 1; i < n; i++) {
    const L = i / n
    const C = maxChromaForLh(L, h)
    if (C > best.C) best = { L, C }
  }
  return best
}
