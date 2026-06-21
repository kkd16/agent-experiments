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

// ---- alternative curve sources -------------------------------------------
// Each layer draws from one *source* family. Harmonographs are the historical
// default; the others are classic parametric curve generators that share the
// same render pipeline (a list of points + per-point speed/curvature/angle).

export type CurveKind =
  | 'harmonograph'
  | 'spirograph'
  | 'rose'
  | 'lissajous'
  | 'superformula'
  | 'attractor'
  | 'lsystem'

// Hypotrochoid / epitrochoid — a pen offset `d` on a circle of radius `r`
// rolling inside (hypo) or outside (epi) a fixed circle of radius `R`. `decay`
// optionally winds the figure inward into a spiral.
export interface SpirographParams {
  R: number
  r: number
  d: number
  outer: boolean // true = epitrochoid (rolls outside), false = hypotrochoid
  turns: number // revolutions of the rolling circle's centre angle
  phase: number
  decay: number // inward spiral rate (0 = none)
  steps: number
}

// Rhodonea (rose) curve r(θ) = cos(k·θ), k = n/d, optionally summed with a
// second harmonic for richer petals.
export interface RoseParams {
  n: number
  d: number
  amp: number
  c2: number // weight of the second harmonic
  k2: number // frequency of the second harmonic
  phase: number
  cycles: number // θ spans cycles·2π
  steps: number
}

// Pure (undamped) Lissajous figure: x = sin(a·t + δ), y = sin(b·t).
export interface LissajousParams {
  a: number
  b: number
  delta: number
  ampX: number
  ampY: number
  decay: number
  cycles: number
  steps: number
}

// Gielis superformula — an astonishingly versatile shape generator. `twist`
// rotates each successive loop so multi-cycle figures nest into rosettes.
export interface SuperformulaParams {
  m: number
  n1: number
  n2: number
  n3: number
  a: number
  b: number
  amp: number
  cycles: number
  twist: number
  steps: number
}

// Strange attractors — chaotic iterated maps. Unlike the parametric families
// above (a smooth function of one angle), these feed each point back into the
// map to produce the next, tracing the dense, web-like orbit of a 2D dynamical
// system. The first four maps are bounded by construction, so the orbit never
// escapes; the last four (Hopalong / Gumowski–Mira / Bedhead / Tinkerbell) are
// *not* bounded by construction, so they are framed by robust percentile bounds
// that clip the handful of outlier iterates. The `a..d` constants reshape every
// map completely. The renderer can connect the iterates into a polyline, or —
// far more beautifully — splat millions of them into a density field (see the
// `density` render style), which is where these chaotic maps truly come alive.
export type AttractorKind =
  | 'dejong'
  | 'clifford'
  | 'svensson'
  | 'fractaldream'
  | 'hopalong'
  | 'gumowski'
  | 'bedhead'
  | 'tinkerbell'

export interface AttractorParams {
  type: AttractorKind
  a: number
  b: number
  c: number
  d: number
  steps: number
}

// L-system (Lindenmayer) fractal curve. `system` selects one of the classic
// single-stroke rule sets in `lsystem.ts`; `iterations` is the rewriting depth
// (clamped per-system so the full curve always renders); `angle` is the turtle's
// turn angle in radians — overridable, which is what lets Live sweep it to morph
// the fractal continuously. The expanded string depends only on system+iterations
// (never the angle), so the turn can animate almost for free.
export interface LSystemParams {
  system: string
  iterations: number
  angle: number
}

// Per-layer "breathe" animation: how fast and how far the source phases drift
// when Live mode is running. Purely a view-time effect — never persisted into
// the figure itself.
export interface LayerDrift {
  rate: number // 0..1 relative speed of phase evolution
}

// How stroke color is chosen along the curve.
export type ColorMode = 'path' | 'velocity' | 'curvature' | 'angle'

// How stroke width varies along the curve.
export type WidthMode = 'uniform' | 'speed'

// Canvas composite operations we expose (also valid CSS mix-blend-mode values).
export type BlendMode = 'source-over' | 'lighter' | 'screen'

// How a layer is drawn: as a connected stroke (the historical default), or as a
// density field — millions of sample points splatted into a per-pixel histogram
// and tone-mapped through the palette. Density is what makes strange attractors
// look like the famous luminous nebulae rather than a tangle of line segments.
export type RenderStyle = 'line' | 'density'

// Parameters for the density-field renderer.
export interface DensityStyle {
  iterations: number // points splatted, in thousands (so 350 ⇒ 350 000)
  exposure: number // brightness lift applied before the tone curve
  gamma: number // tone-curve shaping; < 1 lifts faint, sparse regions into view
}

export interface LayerStyle {
  colors: string[] // multi-stop palette ramp (>= 1 hex color)
  colorMode: ColorMode
  lineWidth: number // base width, in canvas units (~720px field)
  widthMode: WidthMode
  opacity: number // 0..1
  blend: BlendMode
  glow: number // 0..1 soft-glow strength
  symmetry: number // radial copies, 1 = none (kaleidoscope)
  mirror: boolean // also draw a mirrored copy of each radial wedge
  renderStyle?: RenderStyle // defaults to 'line'
  density?: DensityStyle // density-field settings (used when renderStyle === 'density')
}

export interface Layer {
  id: string
  name: string
  visible: boolean
  kind: CurveKind
  params: HarmonographParams // harmonograph source (always present)
  spiro?: SpirographParams
  rose?: RoseParams
  liss?: LissajousParams
  sf?: SuperformulaParams
  attractor?: AttractorParams
  lsystem?: LSystemParams
  drift?: LayerDrift
  style: LayerStyle
}

export type BackgroundMode = 'solid' | 'linear' | 'radial'

export interface Project {
  background: string
  bg2?: string // second stop for gradient backgrounds
  bgMode?: BackgroundMode // defaults to 'solid'
  vignette: number // 0..1 darkening at the frame edges
  layers: Layer[]
}
