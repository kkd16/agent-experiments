// Per-segment easing for gradient stops. Between two stops the parameter t∈[0,1] normally walks
// linearly; an easing curve re-times it so a color can ramp slowly then rush, ease in/out, or step.
//
// The smooth curves are real cubic Béziers solved the WebKit way (UnitBezier): given the x of a
// CSS cubic-bezier(x1,y1,x2,y2), find the parameter s with x(s)=t by Newton–Raphson (falling back
// to bisection), then read y(s). This is exactly how browsers evaluate `transition-timing-function`.

import type { Easing } from './types'
export type { Easing }

export const EASINGS: Easing[] = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'smoothstep', 'step']

export const EASING_LABELS: Record<Easing, string> = {
  linear: 'Linear',
  ease: 'Ease',
  'ease-in': 'Ease in',
  'ease-out': 'Ease out',
  'ease-in-out': 'Ease in-out',
  smoothstep: 'Smoothstep',
  step: 'Step (middle)',
}

// CSS keyword → cubic-bezier control points.
const BEZIER: Partial<Record<Easing, [number, number, number, number]>> = {
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
}

/** Build a cubic-bezier easing function y(x) from its four control coordinates (UnitBezier). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  // Polynomial coefficients (B(0)=0, B(1)=1 endpoints implied).
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by

  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s
  const sampleDX = (s: number) => (3 * ax * s + 2 * bx) * s + cx

  const solveX = (x: number): number => {
    // Newton–Raphson first.
    let s = x
    for (let i = 0; i < 8; i++) {
      const xs = sampleX(s) - x
      if (Math.abs(xs) < 1e-7) return s
      const d = sampleDX(s)
      if (Math.abs(d) < 1e-7) break
      s -= xs / d
    }
    // Bisection fallback (guaranteed within [0,1]).
    let lo = 0
    let hi = 1
    s = x
    while (lo < hi) {
      const xs = sampleX(s)
      if (Math.abs(xs - x) < 1e-7) return s
      if (x > xs) lo = s
      else hi = s
      s = (lo + hi) / 2
    }
    return s
  }

  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    return sampleY(solveX(x))
  }
}

// Pre-built solvers for the keyword curves (so we don't rebuild per sample).
const SOLVERS: Partial<Record<Easing, (x: number) => number>> = {}
for (const [k, pts] of Object.entries(BEZIER)) {
  SOLVERS[k as Easing] = cubicBezier(pts[0], pts[1], pts[2], pts[3])
}

/** Re-time a linear parameter t∈[0,1] through an easing curve. */
export function ease(t: number, e: Easing | undefined): number {
  if (!e || e === 'linear') return t
  if (e === 'smoothstep') {
    const x = t < 0 ? 0 : t > 1 ? 1 : t
    return x * x * (3 - 2 * x)
  }
  if (e === 'step') return t < 0.5 ? 0 : 1
  const solver = SOLVERS[e]
  return solver ? solver(t) : t
}
