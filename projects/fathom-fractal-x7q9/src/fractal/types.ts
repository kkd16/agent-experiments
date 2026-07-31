import { hpFromNumber, type HP } from './hp'

export type FractalMode = 'mandelbrot' | 'julia'

// --- Fractal formulas -------------------------------------------------------
//
// Fathom began as a Mandelbrot/Julia explorer, but the escape-time universe is
// far larger. A *formula* is the iteration map applied every step; the *mode*
// (mandelbrot / julia) chooses whether the pixel seeds `c` (parameter plane) or
// `z0` (dynamical plane). Every formula works in both modes on the df64 engine.
//
// Two properties gate advanced features honestly:
//   * `holomorphic` — the map is complex-analytic, so the escape derivative
//     dz/dc is well-defined. Only then are distance-estimation outlines and
//     normal-map relief lighting mathematically correct, so the UI/shader gate
//     them off for the abs/conjugate formulas rather than draw a wrong picture.
//   * `perturbable` — deep-zoom perturbation theory (BigInt reference orbit +
//     float32 deltas) applies. It's proven glitch-free here for the pure power
//     maps z^p + c, whose critical orbit starts at Z0 = 0 (what Zhuoran rebasing
//     assumes). The abs/conjugate maps stay on the crisp-to-~1e13 df64 engine.
export type FractalFormula =
  | 'mandelbrot'
  | 'cubic'
  | 'quartic'
  | 'burningship'
  | 'tricorn'
  | 'celtic'
  | 'perpendicular'

export type FormulaInfo = {
  id: FractalFormula
  label: string // control-panel button
  short: string // HUD badge
  blurb: string
  glslIndex: number // switch index shared by shader + renderer
  power: number // dominant exponent (used to scale escape colouring / iters)
  holomorphic: boolean // analytic derivative → DE + relief are valid
  perturbable: boolean // deep-zoom reference-orbit engine supported
  homeCX: number
  homeCY: number
  homeSpan: number
  juliaSpan: number
  // A pleasing default Julia constant for the "Julia" tab of this formula.
  juliaCX: number
  juliaCY: number
}

// Order here defines the UI order; `glslIndex` is what the shaders switch on and
// must stay in lockstep with the GLSL `applyFormula` / renderer uniform.
export const FORMULAS: FormulaInfo[] = [
  {
    id: 'mandelbrot',
    label: 'Mandelbrot',
    short: 'z²+c',
    blurb: 'The classic quadratic escape-time set.',
    glslIndex: 0,
    power: 2,
    holomorphic: true,
    perturbable: true,
    homeCX: -0.5,
    homeCY: 0,
    homeSpan: 3.4,
    juliaSpan: 3.2,
    juliaCX: -0.8,
    juliaCY: 0.156,
  },
  {
    id: 'cubic',
    label: 'Cubic',
    short: 'z³+c',
    blurb: 'Multibrot power 3 — a two-fold-symmetric bulb.',
    glslIndex: 1,
    power: 3,
    holomorphic: true,
    perturbable: true,
    homeCX: 0,
    homeCY: 0,
    homeSpan: 3.0,
    juliaSpan: 3.0,
    juliaCX: 0.4,
    juliaCY: 0.0,
  },
  {
    id: 'quartic',
    label: 'Quartic',
    short: 'z⁴+c',
    blurb: 'Multibrot power 4 — three-fold symmetric petals.',
    glslIndex: 2,
    power: 4,
    holomorphic: true,
    perturbable: true,
    homeCX: 0,
    homeCY: 0,
    homeSpan: 3.0,
    juliaSpan: 3.0,
    juliaCX: 0.484,
    juliaCY: 0.0,
  },
  {
    id: 'burningship',
    label: 'Burning Ship',
    short: '(|x|+i|y|)²+c',
    blurb: 'Abs the parts before squaring — riveted hulls and antennae.',
    glslIndex: 3,
    power: 2,
    holomorphic: false,
    perturbable: false,
    homeCX: -0.5,
    homeCY: -0.5,
    homeSpan: 3.6,
    juliaSpan: 3.2,
    juliaCX: -1.75,
    juliaCY: -0.03,
  },
  {
    id: 'tricorn',
    label: 'Tricorn',
    short: 'z̄²+c',
    blurb: 'The Mandelbar — conjugate then square; three-cornered symmetry.',
    glslIndex: 4,
    power: 2,
    holomorphic: false,
    perturbable: false,
    homeCX: -0.25,
    homeCY: 0,
    homeSpan: 3.6,
    juliaSpan: 3.2,
    juliaCX: -0.213,
    juliaCY: 0.6537,
  },
  {
    id: 'celtic',
    label: 'Celtic',
    short: '|Re z²|+c',
    blurb: 'Fold the real part of z² — heart-shaped Celtic knots.',
    glslIndex: 5,
    power: 2,
    holomorphic: false,
    perturbable: false,
    homeCX: -0.5,
    homeCY: 0,
    homeSpan: 3.4,
    juliaSpan: 3.2,
    juliaCX: -0.6,
    juliaCY: 0.0,
  },
  {
    id: 'perpendicular',
    label: 'Perp. Ship',
    short: 'perp',
    blurb: 'Perpendicular Burning Ship — abs the imaginary part only.',
    glslIndex: 6,
    power: 2,
    holomorphic: false,
    perturbable: false,
    homeCX: -0.5,
    homeCY: -0.5,
    homeSpan: 3.6,
    juliaSpan: 3.2,
    juliaCX: -1.35,
    juliaCY: 0.0,
  },
]

export const FORMULA_BY_ID: Record<FractalFormula, FormulaInfo> = Object.fromEntries(
  FORMULAS.map((f) => [f.id, f]),
) as Record<FractalFormula, FormulaInfo>

export function formulaInfo(id: FractalFormula): FormulaInfo {
  return FORMULA_BY_ID[id] ?? FORMULAS[0]
}

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
//   trapCross — orbit trap: min distance to the axes
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
  formula: FractalFormula
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
  formula: FractalFormula
  mode: FractalMode
  fps: number
  engine: Engine
  colorMode: ColorMode
}

export type Bookmark = {
  name: string
  blurb: string
  formula?: FractalFormula // defaults to mandelbrot for the legacy tour entries
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

/** The default camera for a given formula + mode. */
export function homeFor(formula: FractalFormula, mode: FractalMode): Viewport {
  const f = formulaInfo(formula)
  return mode === 'julia'
    ? { cx: hpFromNumber(0), cy: hpFromNumber(0), span: f.juliaSpan }
    : { cx: hpFromNumber(f.homeCX), cy: hpFromNumber(f.homeCY), span: f.homeSpan }
}

export const HOME: Viewport = homeFor('mandelbrot', 'mandelbrot')
export const JULIA_HOME: Viewport = homeFor('mandelbrot', 'julia')
export const INITIAL_SPAN = HOME.span
