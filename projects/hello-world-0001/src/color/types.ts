// The color & gradient data model. Every numeric channel is stored normalized:
// RGB channels are 0..1 *gamma-encoded* sRGB (the canonical "display" color); alpha is 0..1.

export interface RGB {
  r: number
  g: number
  b: number
}

export interface RGBA extends RGB {
  a: number
}

/** Linear-light sRGB (gamma removed), 0..1 (may exceed for wide values). */
export interface LinearRGB {
  r: number
  g: number
  b: number
}

/** CIE XYZ, D65 white. */
export interface XYZ {
  x: number
  y: number
  z: number
}

/** Oklab (Björn Ottosson). L≈0..1, a/b roughly -0.4..0.4. */
export interface OkLab {
  L: number
  a: number
  b: number
}

/** Oklch — the cylindrical form of Oklab. h in degrees 0..360. */
export interface OkLCh {
  L: number
  C: number
  h: number
}

/** CIELab, D65. L 0..100. */
export interface Lab {
  L: number
  a: number
  b: number
}

/** CIE LCh(ab). h in degrees. */
export interface LCh {
  L: number
  C: number
  h: number
}

/** HSL, all 0..1 except h in degrees 0..360. */
export interface HSL {
  h: number
  s: number
  l: number
}

/** HSV / HSB, h in degrees 0..360, s/v 0..1. */
export interface HSV {
  h: number
  s: number
  v: number
}

export type InterpSpace = 'srgb' | 'linear' | 'oklab' | 'oklch' | 'lab' | 'lch' | 'hsl'

/** How a hue angle is walked when interpolating in a cylindrical space. */
export type HueMode = 'shorter' | 'longer' | 'increasing' | 'decreasing'

export type GradientType = 'linear' | 'radial' | 'conic'

export interface Stop {
  id: string
  color: RGBA
  /** position along the gradient, 0..1 */
  pos: number
}

export interface Gradient {
  type: GradientType
  /** linear: gradient angle (deg). conic: starting angle (deg). */
  angle: number
  /** center for radial/conic, 0..1 of the box. */
  cx: number
  cy: number
  space: InterpSpace
  hue: HueMode
  stops: Stop[]
}

export const SPACE_LABELS: Record<InterpSpace, string> = {
  srgb: 'sRGB',
  linear: 'Linear RGB',
  oklab: 'Oklab',
  oklch: 'Oklch',
  lab: 'CIELab',
  lch: 'CIE LCh',
  hsl: 'HSL',
}

export const SPACE_BLURB: Record<InterpSpace, string> = {
  srgb: 'Naïve gamma-space mix — what plain CSS does. Often muddy through the middle.',
  linear: 'Physically correct light mixing. Bright, but can wash out saturation.',
  oklab: 'Perceptually uniform. Smooth lightness, no dead grey zone. A great default.',
  oklch: 'Perceptual + hue-preserving. Sweeps cleanly around the hue wheel.',
  lab: 'The classic perceptual space (1976). Heavier than Oklab.',
  lch: 'Cylindrical CIELab — vivid hue arcs.',
  hsl: 'Cheap and cheerful, but lightness is uneven and hues can shift oddly.',
}
