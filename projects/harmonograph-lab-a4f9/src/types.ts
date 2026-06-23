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
  | 'attractor3d'
  | 'harmonograph3d'
  | 'lsystem'
  | 'fourier'

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

// Three-dimensional strange attractors — continuous flows dx/dt = f(x,y,z)
// integrated with RK4 (`attractors3d.ts`) and projected onto the 2D model plane
// through an orbit camera, so they flow through the exact same line / density /
// SVG / GIF pipeline as every other curve family. `a..d` reshape the vector
// field (per-flow meaning; constants a flow doesn't expose are fixed); the camera
// block (`yaw`/`pitch`/`dist`/`fov`) orbits the figure and `spin` is its Live /
// looping auto-rotation rate. `depthCue` turns on depth-weighted brightness and
// depth→palette colouring in the density renderer for a volumetric look.
export type Flow3DKind =
  | 'lorenz'
  | 'rossler'
  | 'aizawa'
  | 'thomas'
  | 'halvorsen'
  | 'chen'
  | 'dadras'
  | 'sprott'
  | 'lorenz84'
  | 'sprottb'
  | 'nosehoover'
  | 'rikitake'
  | 'chenlee'
  | 'burkeshaw'

export interface Attractor3DParams {
  type: Flow3DKind
  a: number
  b: number
  c: number
  d: number
  dt: number // RK4 integration step
  steps: number // sampled polyline length (line render + auto-fit bounds)
  yaw: number // camera azimuth (radians)
  pitch: number // camera elevation (radians)
  dist: number // camera distance (in normalised radii)
  fov: number // field of view (radians)
  depthCue: boolean // depth-weighted intensity + depth→palette colour (density)
  fog?: number // 0..1 exponential depth fog: far filaments dissolve toward the void
  spin: number // auto-rotation rate for Live / looping capture
}

// Three-dimensional harmonograph — the spatial pendulum. The historical
// harmonograph swings two pendulums in a plane; lift it into space and each of
// the three axes is driven by its own pair of damped sinusoids, so the pen
// traces a knotted 3D Lissajous figure. It is *not* a chaotic flow: it is an
// exact closed-form curve (a sum of decaying sines), sampled smoothly and then
// flown through the very same orbit camera as the strange-attractor flows, so it
// inherits drag-to-orbit, the depth cue, stereo, and the seamless looping export
// for free. Each axis pendulum reuses the planar `Pendulum` shape (freq / phase
// / amp / damp); the camera block mirrors `Attractor3DParams`.
export interface Harmonograph3DParams {
  x1: Pendulum
  x2: Pendulum
  y1: Pendulum
  y2: Pendulum
  z1: Pendulum
  z2: Pendulum
  duration: number // total "time" traced, in radians of the base oscillation
  steps: number // sampled points along the space curve
  yaw: number
  pitch: number
  dist: number
  fov: number
  depthCue: boolean
  fog?: number
  spin: number
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

// Fourier (epicycle) curve. A closed `shape` is decomposed by a from-scratch DFT
// (`fourier.ts`) into rotating vectors; the figure is the inverse transform using
// the `harmonics` (K) largest-amplitude terms — so sliding K is a live tour of
// Fourier convergence. `phase` is a global rotation (every coefficient × e^{iφ}),
// which is what Live / looping drift advances. `epicycles` toggles the nested-
// circles overlay the renderer draws along the Play (pen-drawing) animation.
export interface FourierParams {
  shape: string
  harmonics: number // K: number of epicycles (the approximation order)
  phase: number // global rotation in radians
  epicycles: boolean // draw the rotating-circles overlay during the Play pass
  steps: number // output sample count
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
  a3d?: Attractor3DParams
  h3d?: Harmonograph3DParams
  lsystem?: LSystemParams
  fourier?: FourierParams
  drift?: LayerDrift
  style: LayerStyle
}

export type BackgroundMode = 'solid' | 'linear' | 'radial'

// Stereoscopic 3D output. When any 3D layer is present the scene can be rendered
// from two slightly-rotated eye viewpoints and composited for genuine depth:
// `anaglyph` (red-cyan glasses), `sbs` (parallel side-by-side for cardboard/VR
// viewers) or `crosseye` (side-by-side swapped for free cross-eyed viewing).
export type StereoMode = 'off' | 'anaglyph' | 'sbs' | 'crosseye'

export interface Project {
  background: string
  bg2?: string // second stop for gradient backgrounds
  bgMode?: BackgroundMode // defaults to 'solid'
  vignette: number // 0..1 darkening at the frame edges
  stereo?: StereoMode // defaults to 'off' (only affects scenes with a 3D layer)
  stereoBaseline?: number // eye separation as a yaw offset (radians); defaults to 0.08
  layers: Layer[]
}
