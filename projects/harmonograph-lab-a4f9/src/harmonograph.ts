// A harmonograph traces the motion of damped pendulums. Two pendulums drive the
// X axis and two drive the Y axis; each swings at its own frequency, phase, and
// amplitude while decaying exponentially. The interference of these sine waves
// produces the characteristic looping, spirograph-like figures. An optional
// rotary pendulum rotates the whole coordinate frame as it draws.

import type {
  HarmonographParams,
  Layer,
  LayerStyle,
  Pendulum,
} from './types'

export interface Point {
  x: number
  y: number
}

// Precomputed per-curve data the renderer and color engine consume. The metric
// arrays are normalised to [0, 1] so any color mode can map straight into a ramp.
export interface LayerData {
  points: Point[]
  speed: number[] // normalised pen speed at each point
  curvature: number[] // normalised local turn rate
  angle: number[] // normalised direction of travel (0..1 ≈ -π..π)
}

const TWO_PI = Math.PI * 2

// Sample the harmonograph into model coordinates (roughly [-1, 1], unframed —
// the renderer auto-fits the result to the canvas).
export function samplePath(p: HarmonographParams): Point[] {
  const pts: Point[] = new Array(p.steps + 1)
  const dt = p.duration / p.steps
  const rot = p.rotary
  for (let i = 0; i <= p.steps; i++) {
    const t = i * dt
    let x =
      p.x1.amp * Math.sin(t * p.x1.freq + p.x1.phase) * Math.exp(-p.x1.damp * t) +
      p.x2.amp * Math.sin(t * p.x2.freq + p.x2.phase) * Math.exp(-p.x2.damp * t)
    let y =
      p.y1.amp * Math.sin(t * p.y1.freq + p.y1.phase) * Math.exp(-p.y1.damp * t) +
      p.y2.amp * Math.sin(t * p.y2.freq + p.y2.phase) * Math.exp(-p.y2.damp * t)
    if (rot.enabled) {
      const theta =
        rot.amp * Math.sin(t * rot.freq + rot.phase) * Math.exp(-rot.damp * t)
      const c = Math.cos(theta)
      const s = Math.sin(theta)
      const rx = x * c - y * s
      const ry = x * s + y * c
      x = rx
      y = ry
    }
    pts[i] = { x, y }
  }
  return pts
}

function normalise(values: number[]): number[] {
  let lo = Infinity
  let hi = -Infinity
  for (const v of values) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  const span = hi - lo
  if (span < 1e-9) return values.map(() => 0.5)
  return values.map((v) => (v - lo) / span)
}

// Build the full render-ready dataset for a curve, including the metric arrays
// used by velocity / curvature / direction coloring and speed-based width.
export function buildLayerData(p: HarmonographParams): LayerData {
  const points = samplePath(p)
  const n = points.length
  const rawSpeed = new Array<number>(n)
  const angle = new Array<number>(n)
  const rawCurv = new Array<number>(n)

  let prevAngle = 0
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(i - 1, 0)]
    const b = points[i]
    const dx = b.x - a.x
    const dy = b.y - a.y
    rawSpeed[i] = Math.hypot(dx, dy)
    const ang = i === 0 ? 0 : Math.atan2(dy, dx)
    angle[i] = ang
    let d = ang - prevAngle
    while (d > Math.PI) d -= TWO_PI
    while (d < -Math.PI) d += TWO_PI
    rawCurv[i] = Math.abs(d)
    prevAngle = ang
  }

  return {
    points,
    speed: normalise(rawSpeed),
    curvature: normalise(rawCurv),
    angle: angle.map((a) => (a + Math.PI) / TWO_PI),
  }
}

// Memoise the (relatively costly) sampling by params identity. Editing a layer's
// *style* keeps its `params` object reference, so this returns instantly then;
// only an actual params change recomputes. A WeakMap lets dropped layers GC.
const dataCache = new WeakMap<HarmonographParams, LayerData>()
export function getLayerData(p: HarmonographParams): LayerData {
  let d = dataCache.get(p)
  if (!d) {
    d = buildLayerData(p)
    dataCache.set(p, d)
  }
  return d
}

const rand = (min: number, max: number) => min + Math.random() * (max - min)
const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]

// Frequencies near small-integer ratios give the prettiest, most coherent
// figures, so snap to a whole number and add a tiny detune for organic drift.
function randomPendulum(maxFreq = 5): Pendulum {
  const base = Math.round(rand(1, maxFreq))
  return {
    freq: base + rand(-0.02, 0.02),
    phase: rand(0, TWO_PI),
    amp: rand(0.6, 1),
    damp: rand(0.002, 0.02),
  }
}

export function randomParams(): HarmonographParams {
  const useRotary = Math.random() < 0.35
  return {
    x1: randomPendulum(),
    x2: randomPendulum(),
    y1: randomPendulum(),
    y2: randomPendulum(),
    rotary: {
      enabled: useRotary,
      freq: pick([1, 1, 2, 3]) + rand(-0.01, 0.01),
      phase: rand(0, TWO_PI),
      amp: rand(0.4, 1.4),
      damp: rand(0.001, 0.01),
    },
    duration: rand(140, 320),
    steps: 6000,
  }
}

export function defaultParams(): HarmonographParams {
  return {
    x1: { freq: 2, phase: 0, amp: 1, damp: 0.004 },
    x2: { freq: 3, phase: Math.PI / 2, amp: 0.7, damp: 0.004 },
    y1: { freq: 3, phase: 0, amp: 1, damp: 0.004 },
    y2: { freq: 2, phase: Math.PI / 4, amp: 0.7, damp: 0.004 },
    rotary: {
      enabled: false,
      freq: 1,
      phase: 0,
      amp: 0.8,
      damp: 0.004,
    },
    duration: 220,
    steps: 6000,
  }
}

let idCounter = 0
export function makeId(): string {
  idCounter += 1
  return `l${Date.now().toString(36)}${idCounter.toString(36)}`
}

export function defaultStyle(colors: string[]): LayerStyle {
  return {
    colors,
    colorMode: 'path',
    lineWidth: 1.1,
    widthMode: 'uniform',
    opacity: 1,
    blend: 'source-over',
    glow: 0,
  }
}

export function makeLayer(
  name: string,
  params: HarmonographParams,
  style: LayerStyle,
): Layer {
  return { id: makeId(), name, visible: true, params, style }
}

// Deep clone so duplicate / preset loads never share mutable nested objects.
export function cloneParams(p: HarmonographParams): HarmonographParams {
  return {
    x1: { ...p.x1 },
    x2: { ...p.x2 },
    y1: { ...p.y1 },
    y2: { ...p.y2 },
    rotary: { ...p.rotary },
    duration: p.duration,
    steps: p.steps,
  }
}
