import { hpFromNumber, type HP } from './hp'

export type FractalMode = 'mandelbrot' | 'julia'

// The camera. `span` is the world-space width covered by the canvas, so it is
// independent of resolution — the per-pixel scale is derived at render time. The
// centre is stored in high precision (see `hp.ts`) so it can carry the 30+
// significant digits a deep zoom needs; a plain double would cap zoom at ~1e-13.
export type Viewport = {
  cx: HP
  cy: HP
  span: number
}

// Which rendering engine produced the current frame.
export type Engine = 'df64' | 'perturb'

// How a pixel's colour is derived from its orbit.
//   smooth    — classic smooth escape-time bands
//   stripe    — Stripe Average Colouring (running sin-of-argument mean)
//   trapPoint — orbit trap: min |z| over the orbit
//   trapCross — orbit trap: min distance to the coordinate axes
export type ColorMode = 'smooth' | 'stripe' | 'trapPoint' | 'trapCross'

export const COLOR_MODE_INDEX: Record<ColorMode, number> = {
  smooth: 0,
  stripe: 1,
  trapPoint: 2,
  trapCross: 3,
}

// Everything the user tweaks that isn't the camera itself.
export type RenderParams = {
  maxIter: number
  autoIter: boolean
  mode: FractalMode
  juliaX: number
  juliaY: number
  paletteId: string
  colorScale: number
  colorOffset: number
  cycleSpeed: number
  aa: number
  de: boolean // distance-estimation outline shading
  deStrength: number
  colorMode: ColorMode
  featureFreq: number // stripe density / orbit-trap scale
  interior: boolean // paint the set's interior instead of leaving it black
  relief: boolean // normal-map (Lambert) relief lighting
  lightAngle: number // light azimuth in radians
  lightHeight: number // light elevation
}

export type HudInfo = {
  re: string // high-precision decimal strings (may exceed double precision)
  im: string
  span: number
  magnification: number
  maxIter: number
  mode: FractalMode
  fps: number
  engine: Engine
  colorMode: ColorMode
}

export type Bookmark = {
  name: string
  blurb: string
  mode: FractalMode
  centerX: string // decimal strings so deep coordinates keep all their digits
  centerY: string
  span: number
  juliaX?: number
  juliaY?: number
  paletteId?: string
  de?: boolean
  colorMode?: ColorMode
  featureFreq?: number
  interior?: boolean
  relief?: boolean
}

export const HOME: Viewport = { cx: hpFromNumber(-0.5), cy: hpFromNumber(0), span: 3.4 }
export const JULIA_HOME: Viewport = { cx: hpFromNumber(0), cy: hpFromNumber(0), span: 3.2 }
export const INITIAL_SPAN = HOME.span
