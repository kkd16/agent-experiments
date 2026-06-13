// A harmonograph traces the motion of damped pendulums. Two pendulums drive the
// X axis and two drive the Y axis; each swings at its own frequency, phase, and
// amplitude while decaying exponentially. The interference of these sine waves
// produces the characteristic looping, spirograph-like figures.

export interface Pendulum {
  freq: number // oscillations over the drawing window
  phase: number // radians
  amp: number // 0..1 (fraction of half-canvas)
  damp: number // decay rate; higher = curve winds inward faster
}

export interface HarmonographParams {
  x1: Pendulum
  x2: Pendulum
  y1: Pendulum
  y2: Pendulum
  duration: number // total "time" traced, in radians of the base oscillation
  steps: number // number of sampled points along the curve
}

export interface Point {
  x: number
  y: number
}

// Sample the harmonograph into normalised coordinates in the range [-1, 1].
export function samplePath(p: HarmonographParams): Point[] {
  const pts: Point[] = []
  const dt = p.duration / p.steps
  for (let i = 0; i <= p.steps; i++) {
    const t = i * dt
    const x =
      p.x1.amp * Math.sin(t * p.x1.freq + p.x1.phase) * Math.exp(-p.x1.damp * t) +
      p.x2.amp * Math.sin(t * p.x2.freq + p.x2.phase) * Math.exp(-p.x2.damp * t)
    const y =
      p.y1.amp * Math.sin(t * p.y1.freq + p.y1.phase) * Math.exp(-p.y1.damp * t) +
      p.y2.amp * Math.sin(t * p.y2.freq + p.y2.phase) * Math.exp(-p.y2.damp * t)
    pts.push({ x: x / 2, y: y / 2 })
  }
  return pts
}

const rand = (min: number, max: number) => min + Math.random() * (max - min)

// Frequencies near small-integer ratios give the prettiest, most coherent
// figures, so snap to a whole number and add a tiny detune for organic drift.
function randomPendulum(): Pendulum {
  const base = Math.round(rand(1, 5))
  return {
    freq: base + rand(-0.02, 0.02),
    phase: rand(0, Math.PI * 2),
    amp: rand(0.6, 1),
    damp: rand(0.002, 0.02),
  }
}

export function randomParams(): HarmonographParams {
  return {
    x1: randomPendulum(),
    x2: randomPendulum(),
    y1: randomPendulum(),
    y2: randomPendulum(),
    duration: rand(120, 320),
    steps: 6000,
  }
}

export function defaultParams(): HarmonographParams {
  return {
    x1: { freq: 2, phase: 0, amp: 1, damp: 0.004 },
    x2: { freq: 3, phase: Math.PI / 2, amp: 0.7, damp: 0.004 },
    y1: { freq: 3, phase: 0, amp: 1, damp: 0.004 },
    y2: { freq: 2, phase: Math.PI / 4, amp: 0.7, damp: 0.004 },
    duration: 220,
    steps: 6000,
  }
}
