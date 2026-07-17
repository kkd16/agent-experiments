export type FractalMode = 'mandelbrot' | 'julia'

// The camera. `span` is the world-space width covered by the canvas, so it is
// independent of resolution — the per-pixel scale is derived at render time.
export type Viewport = {
  centerX: number
  centerY: number
  span: number
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
}

export type HudInfo = {
  re: number
  im: number
  span: number
  magnification: number
  maxIter: number
  mode: FractalMode
  fps: number
}

export type Bookmark = {
  name: string
  blurb: string
  mode: FractalMode
  centerX: number
  centerY: number
  span: number
  juliaX?: number
  juliaY?: number
  paletteId?: string
}

export const HOME: Viewport = { centerX: -0.5, centerY: 0, span: 3.4 }
export const INITIAL_SPAN = HOME.span
