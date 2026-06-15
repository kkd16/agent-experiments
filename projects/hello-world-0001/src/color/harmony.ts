// Palette harmonies. We rotate hue in Oklch (keeping perceptual lightness & chroma constant), so a
// "triad" really is three equally-spaced, equally-vivid colors — not the lopsided set you get from
// rotating an HSL wheel.

import { clampRgb, oklchToRgb, rgbToOklch, wrapHue } from './convert'
import type { RGBA } from './types'

export type HarmonyKind =
  | 'complementary'
  | 'analogous'
  | 'triadic'
  | 'tetradic'
  | 'split'
  | 'monochrome'

export const HARMONY_LABELS: Record<HarmonyKind, string> = {
  complementary: 'Complementary',
  analogous: 'Analogous',
  triadic: 'Triadic',
  tetradic: 'Tetradic',
  split: 'Split-complementary',
  monochrome: 'Monochromatic',
}

const HUE_OFFSETS: Record<Exclude<HarmonyKind, 'monochrome'>, number[]> = {
  complementary: [0, 180],
  analogous: [-30, 0, 30],
  triadic: [0, 120, 240],
  tetradic: [0, 90, 180, 270],
  split: [0, 150, 210],
}

export function harmony(base: RGBA, kind: HarmonyKind): RGBA[] {
  const { L, C, h } = rgbToOklch(base)
  if (kind === 'monochrome') {
    // vary lightness while holding hue + chroma
    return [0.85, 0.68, 0.5, 0.34, 0.2].map((L2) => ({
      ...clampRgb(oklchToRgb({ L: L2, C: Math.min(C, 0.12), h })),
      a: base.a,
    }))
  }
  return HUE_OFFSETS[kind].map((off) => ({
    ...clampRgb(oklchToRgb({ L, C, h: wrapHue(h + off) })),
    a: base.a,
  }))
}
