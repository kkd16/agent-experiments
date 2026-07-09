import { Sketch } from './sketch'
import type { EntityId } from './types'

// A driver animates one constraint's target value over time to sweep a
// mechanism through its range of motion.
export type DriverSpec = {
  constraintId: EntityId
  min: number
  max: number
  // Seconds for one full min→max→min cycle (or a full turn for a rotation).
  period: number
  // If true the driver wraps (0→360→0) rather than ping-ponging.
  wrap: boolean
  label: string
  unit: string
}

export type BuiltExample = {
  sketch: Sketch
  driver?: DriverSpec
  tracePoints?: EntityId[] // points whose swept path is drawn during animation
}

export type Example = {
  id: string
  name: string
  blurb: string
  build: () => BuiltExample
}

// --- individual builders ---------------------------------------------------

function blank(): BuiltExample {
  return { sketch: new Sketch() }
}

// The canonical four-bar linkage: a crank and rocker joined by a coupler, with a
// rigid triangle on the coupler whose apex traces the famous coupler curve.
function fourBar(): BuiltExample {
  const s = new Sketch()
  const A = s.addPoint(-70, 0, { fixed: true }) // ground pivot (crank)
  const D = s.addPoint(70, 0, { fixed: true }) // ground pivot (rocker)
  const B = s.addPoint(-45, 45) // crank end
  const C = s.addPoint(55, 70) // rocker end
  const E = s.addPoint(20, 110) // coupler apex (traced)

  const ground = s.addLine(A.id, D.id, true)
  const crank = s.addLine(A.id, B.id)
  s.addLine(B.id, C.id) // coupler
  s.addLine(C.id, D.id) // rocker
  s.addLine(B.id, E.id, true)
  s.addLine(C.id, E.id, true)

  s.addConstraint('distance', [A.id, B.id], 35) // crank (shortest → Grashof)
  s.addConstraint('distance', [B.id, C.id], 100) // coupler
  s.addConstraint('distance', [C.id, D.id], 75) // rocker
  s.addConstraint('distance', [B.id, E.id], 70) // rigid coupler triangle
  s.addConstraint('distance', [C.id, E.id], 80)

  const drv = s.addConstraint('angle', [ground.id, crank.id], 40, true)
  return {
    sketch: s,
    driver: { constraintId: drv.id, min: 0, max: 360, period: 6, wrap: true, label: 'Crank angle', unit: '°' },
    tracePoints: [E.id],
  }
}

// Slider-crank: rotary crank drives a slider along a straight guide — the heart
// of every piston engine.
function sliderCrank(): BuiltExample {
  const s = new Sketch()
  const O = s.addPoint(-90, 0, { fixed: true }) // crank pivot
  const G1 = s.addPoint(-100, -35, { fixed: true }) // guide endpoints (fixed)
  const G2 = s.addPoint(140, -35, { fixed: true })
  const A = s.addPoint(-60, 25) // crank end
  const B = s.addPoint(90, -35) // slider

  const guide = s.addLine(G1.id, G2.id, true)
  const crank = s.addLine(O.id, A.id)
  s.addLine(A.id, B.id) // connecting rod

  s.addConstraint('distance', [O.id, A.id], 40) // crank radius
  s.addConstraint('distance', [A.id, B.id], 150) // rod length
  s.addConstraint('pointOnLine', [B.id, guide.id]) // slider rides the guide

  const drv = s.addConstraint('angle', [guide.id, crank.id], 30, true)
  return {
    sketch: s,
    driver: { constraintId: drv.id, min: 0, max: 360, period: 4, wrap: true, label: 'Crank angle', unit: '°' },
    tracePoints: [A.id],
  }
}

// A rigid triangle: three bars pin every internal shape, so the whole thing
// moves as one body when you drag a corner.
function rigidTriangle(): BuiltExample {
  const s = new Sketch()
  const a = s.addPoint(-60, -35)
  const b = s.addPoint(60, -35)
  const c = s.addPoint(0, 70)
  s.addLine(a.id, b.id)
  s.addLine(b.id, c.id)
  s.addLine(c.id, a.id)
  s.addConstraint('distance', [a.id, b.id], 120)
  s.addConstraint('distance', [b.id, c.id], 122)
  s.addConstraint('distance', [c.id, a.id], 122)
  return { sketch: s }
}

// A parametric square: equal sides, right angles and a level base. Drag any
// corner and it stays a square, resizing to follow.
function parametricSquare(): BuiltExample {
  const s = new Sketch()
  const a = s.addPoint(-55, -55)
  const b = s.addPoint(60, -50)
  const c = s.addPoint(55, 60)
  const d = s.addPoint(-50, 55)
  const ab = s.addLine(a.id, b.id)
  const bc = s.addLine(b.id, c.id)
  const cd = s.addLine(c.id, d.id)
  s.addLine(d.id, a.id) // drawn, but its right angle & length are implied by closure
  s.addConstraint('horizontal', [ab.id])
  s.addConstraint('perpendicular', [ab.id, bc.id])
  s.addConstraint('perpendicular', [bc.id, cd.id])
  s.addConstraint('equalLength', [ab.id, bc.id])
  s.addConstraint('equalLength', [bc.id, cd.id])
  // Five independent constraints on 8 params → a movable, resizable square with
  // 3 residual DOF and no redundant equations (the fourth side closes for free).
  return { sketch: s }
}

// Two circles held externally tangent with fixed radii — drag either center and
// they stay kissing.
function tangentCircles(): BuiltExample {
  const s = new Sketch()
  const c1 = s.addPoint(-45, 0, { construction: true })
  const c2 = s.addPoint(55, 10, { construction: true })
  const A = s.addCircle(c1.id, 45)
  const B = s.addCircle(c2.id, 30)
  s.addConstraint('radius', [A.id], 45)
  s.addConstraint('radius', [B.id], 30)
  s.addConstraint('tangentCircles', [A.id, B.id])
  return { sketch: s }
}

// A regular hexagon assembled from a rough ring: every vertex sits on one
// circle and every edge is the same length, so the only solution is regular.
function regularHexagon(): BuiltExample {
  const s = new Sketch()
  const center = s.addPoint(0, 0, { fixed: true, construction: true })
  const ring = s.addCircle(center.id, 80, true)
  s.addConstraint('radius', [ring.id], 80)

  const N = 6
  const pts: EntityId[] = []
  for (let i = 0; i < N; i++) {
    // Start from a deliberately irregular ring to show the solver regularise it.
    const ang = (i / N) * Math.PI * 2 + 0.15 * Math.sin(i * 2.3)
    const rad = 80 + 18 * Math.sin(i * 1.7)
    const p = s.addPoint(Math.cos(ang) * rad, Math.sin(ang) * rad)
    pts.push(p.id)
  }
  // Pin the first vertex to remove the free rotation about the center.
  s.point(pts[0]).fixed = true
  s.point(pts[0]).x = 80
  s.point(pts[0]).y = 0

  const edges: EntityId[] = []
  for (let i = 0; i < N; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % N]
    edges.push(s.addLine(p, q).id)
    s.addConstraint('pointOnCircle', [p, ring.id])
  }
  for (let i = 1; i < N; i++) s.addConstraint('equalLength', [edges[0], edges[i]])
  return { sketch: s }
}

export const EXAMPLES: Example[] = [
  { id: 'four-bar', name: 'Four-Bar Linkage', blurb: 'Grashof crank-rocker tracing a coupler curve.', build: fourBar },
  { id: 'slider-crank', name: 'Slider-Crank', blurb: 'Rotary motion into linear — the piston engine.', build: sliderCrank },
  { id: 'square', name: 'Parametric Square', blurb: 'Right angles + equal sides. Drag to resize.', build: parametricSquare },
  { id: 'triangle', name: 'Rigid Triangle', blurb: 'Three bars make a rigid body. Drag it around.', build: rigidTriangle },
  { id: 'tangent', name: 'Tangent Circles', blurb: 'Two circles kept kissing as you drag.', build: tangentCircles },
  { id: 'hexagon', name: 'Regular Hexagon', blurb: 'Equal edges on a circle snap to regular.', build: regularHexagon },
  { id: 'blank', name: 'Blank Sketch', blurb: 'An empty canvas to draw your own.', build: blank },
]

export function exampleById(id: string): Example {
  return EXAMPLES.find((e) => e.id === id) ?? EXAMPLES[0]
}
