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
}

export const HOME: Viewport = { cx: hpFromNumber(-0.5), cy: hpFromNumber(0), span: 3.4 }
export const JULIA_HOME: Viewport = { cx: hpFromNumber(0), cy: hpFromNumber(0), span: 3.2 }
export const INITIAL_SPAN = HOME.span
