// The data model for the studio. A Project is a stack of Layers rendered back to
// front; each Layer is one harmonograph curve plus the style it's drawn with.

export interface Pendulum {
  freq: number // oscillations over the drawing window
  phase: number // radians
  amp: number // 0..1 (fraction of the drawing field)
  damp: number // exponential decay rate; higher = winds inward faster
}

// A rotary harmonograph adds a pendulum that rotates the *paper* as the lateral
// pendulums draw. `amp` here is the peak rotation in radians.
export interface RotaryPendulum extends Pendulum {
  enabled: boolean
}

export interface HarmonographParams {
  x1: Pendulum
  x2: Pendulum
  y1: Pendulum
  y2: Pendulum
  rotary: RotaryPendulum
  duration: number // total "time" traced, in radians of the base oscillation
  steps: number // number of sampled points along the curve
}

// How stroke color is chosen along the curve.
export type ColorMode = 'path' | 'velocity' | 'curvature' | 'angle'

// How stroke width varies along the curve.
export type WidthMode = 'uniform' | 'speed'

// Canvas composite operations we expose (also valid CSS mix-blend-mode values).
export type BlendMode = 'source-over' | 'lighter' | 'screen'

export interface LayerStyle {
  colors: string[] // multi-stop palette ramp (>= 1 hex color)
  colorMode: ColorMode
  lineWidth: number // base width, in canvas units (~720px field)
  widthMode: WidthMode
  opacity: number // 0..1
  blend: BlendMode
  glow: number // 0..1 soft-glow strength
}

export interface Layer {
  id: string
  name: string
  visible: boolean
  params: HarmonographParams
  style: LayerStyle
}

export interface Project {
  background: string
  vignette: number // 0..1 darkening at the frame edges
  layers: Layer[]
}
