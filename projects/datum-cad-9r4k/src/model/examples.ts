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

// The Peaucellier–Lipkin linkage (1864): the first planar mechanism proven to
// draw an EXACT straight line from rotary input. O and F are fixed. The bars
// O–M and O–N (long, equal) plus the rhombus M–P–N–Q (four equal short bars)
// form an inversor: O, P, Q stay collinear with OP·OQ = OM² − MP² held constant
// by the bar lengths. Constraining P to a circle through O (bar F–P with |OF| =
// |FP|) inverts that circle to a line — so Q traces a perfect straight segment.
// The driver sweeps the F–P crank; Q's trace is dead straight to machine
// precision (see the self-test). The 40°→72° range keeps the rhombus on its
// convex assembly branch (past ~77° it would flip to the crossed one).
function peaucellier(): BuiltExample {
  const s = new Sketch()
  const O = s.addPoint(0, 0, { fixed: true })
  const F = s.addPoint(-60, 0, { fixed: true })
  // Initial coordinates are the exact 40° assembly, so the solve starts on-branch.
  const P = s.addPoint(-14, 38.6)
  const M = s.addPoint(-44.5, 78.2)
  const N = s.addPoint(-16.2, 88.6)
  const Q = s.addPoint(-46.7, 128.2)

  const ref = s.addLine(F.id, O.id, true) // fixed reference for the driver angle
  const fp = s.addLine(F.id, P.id) // driving crank: P rides a circle through O
  s.addLine(O.id, M.id)
  s.addLine(O.id, N.id)
  s.addLine(M.id, P.id)
  s.addLine(P.id, N.id)
  s.addLine(N.id, Q.id)
  s.addLine(Q.id, M.id)

  s.addConstraint('distance', [F.id, P.id], 60) // |FP| = |OF| ⇒ circle through O
  s.addConstraint('distance', [O.id, M.id], 90) // long links
  s.addConstraint('distance', [O.id, N.id], 90)
  s.addConstraint('distance', [M.id, P.id], 50) // rhombus sides
  s.addConstraint('distance', [P.id, N.id], 50)
  s.addConstraint('distance', [N.id, Q.id], 50)
  s.addConstraint('distance', [Q.id, M.id], 50)

  const drv = s.addConstraint('angle', [ref.id, fp.id], 40, true)
  return {
    sketch: s,
    driver: { constraintId: drv.id, min: 40, max: 72, period: 5, wrap: false, label: 'Crank angle', unit: '°' },
    tracePoints: [Q.id],
  }
}

// Hoeken's linkage: a single crank-rocker four-bar whose coupler point traces an
// APPROXIMATE straight line over half its rotation — the practical workhorse
// (exact straight-line linkages need many bars). Classic 2 : 1 : 2.5 : 2.5
// proportions with the tracer at twice the coupler length. Drive it a full turn
// and watch the coupler point run nearly dead flat along the bottom, then loop
// back over the top — the contrast with Peaucellier's exactness is the point.
function hoeken(): BuiltExample {
  const s = new Sketch()
  const O1 = s.addPoint(-40, 0, { fixed: true })
  const O2 = s.addPoint(40, 0, { fixed: true })
  const A = s.addPoint(-60, 35)
  const B = s.addPoint(50, 90)
  const C = s.addPoint(160, 145) // coupler tracer, collinear with A–B

  const ground = s.addLine(O1.id, O2.id, true)
  const crank = s.addLine(O1.id, A.id)
  const coupler = s.addLine(A.id, B.id)
  s.addLine(O2.id, B.id) // rocker
  s.addLine(B.id, C.id, true) // coupler extension to the tracer

  s.addConstraint('distance', [O1.id, A.id], 40) // crank
  s.addConstraint('distance', [A.id, B.id], 100) // coupler
  s.addConstraint('distance', [O2.id, B.id], 100) // rocker
  s.addConstraint('pointOnLine', [C.id, coupler.id]) // tracer on the coupler line
  s.addConstraint('distance', [A.id, C.id], 200) // …at twice the coupler length

  const drv = s.addConstraint('angle', [ground.id, crank.id], 120, true)
  return {
    sketch: s,
    driver: { constraintId: drv.id, min: 0, max: 360, period: 6, wrap: true, label: 'Crank angle', unit: '°' },
    tracePoints: [C.id],
  }
}

// A rounded slot (obround): two parallel straight flanks capped by two semicircular
// arcs of equal radius. The flanks are held tangent to both end-caps and level, and
// the two centers are pinned — so the whole thing is fully determined by one radius
// dimension. It exercises arcs end-to-end: the intrinsic endpoint-on-circle residual
// keeps each cap's endpoints on its circle, and tangent-line-to-arc + equal-radius
// (the very same relations circles use) do the rest. Drag nothing — change the
// radius dimension and the slot rebuilds.
function roundedSlot(): BuiltExample {
  const s = new Sketch()
  const R = 32
  const CL = s.addPoint(-55, 0, { fixed: true, construction: true }) // left cap center
  const CR = s.addPoint(55, 0, { fixed: true, construction: true }) // right cap center

  // Endpoints, started roughly at the tangent points so the solve begins on-branch.
  const TL = s.addPoint(-55, R)
  const TR = s.addPoint(55, R)
  const BR = s.addPoint(55, -R)
  const BL = s.addPoint(-55, -R)

  const top = s.addLine(TL.id, TR.id)
  const bot = s.addLine(BR.id, BL.id)
  const leftCap = s.addArc(CL.id, TL.id, BL.id, R) // CCW TL(90°)→BL(270°), bulging left
  const rightCap = s.addArc(CR.id, BR.id, TR.id, R) // CCW BR(270°)→TR(90°), bulging right

  s.addConstraint('horizontal', [top.id])
  s.addConstraint('horizontal', [bot.id])
  s.addConstraint('tangentLineCircle', [top.id, leftCap.id])
  s.addConstraint('tangentLineCircle', [bot.id, rightCap.id])
  s.addConstraint('equalRadius', [leftCap.id, rightCap.id])
  s.addConstraint('radius', [leftCap.id], R)
  return { sketch: s }
}

// A tangent-arc fillet rounding a right-angle corner: a horizontal leg and a
// vertical leg, with an arc held tangent to both and joined to their inner ends.
// The arc's center floats free — tangency to the two legs plus the radius pins it,
// and the intrinsic endpoint residuals keep the tangent points on the arc. This is
// the bread-and-butter fillet of real CAD sketching, fully solved from relations.
function tangentFillet(): BuiltExample {
  const s = new Sketch()
  const R = 34
  const A = s.addPoint(-95, -40, { fixed: true }) // horizontal leg's outer end
  const B = s.addPoint(60, 60, { fixed: true }) // vertical leg's outer end
  const T1 = s.addPoint(26, -40) // tangent point on the horizontal leg
  const T2 = s.addPoint(60, -6) // tangent point on the vertical leg
  const C = s.addPoint(26, -6, { construction: true }) // fillet center (floats free)

  const legH = s.addLine(A.id, T1.id)
  const legV = s.addLine(B.id, T2.id)
  const arc = s.addArc(C.id, T1.id, T2.id, R) // CCW T1→T2, rounding the corner

  s.addConstraint('horizontal', [legH.id])
  s.addConstraint('vertical', [legV.id])
  s.addConstraint('tangentLineCircle', [legH.id, arc.id])
  s.addConstraint('tangentLineCircle', [legV.id, arc.id])
  s.addConstraint('radius', [arc.id], R)
  return { sketch: s }
}

// A rounded rectangle (stadium of four corner fillets): four straight sides — two
// horizontal, two vertical — and four quarter-arcs, every arc tangent to the two
// sides it joins and all four sharing one radius. The four corner centers are
// pinned to a clean rectangle; a single radius dimension rounds every corner at
// once. It is the four-fold version of the rounded slot, and a torture test for the
// arc machinery: eight tangent points, each held on its arc by the intrinsic
// endpoint residual, with tangent-line-to-arc and equal-radius doing the rest.
function roundedRect(): BuiltExample {
  const s = new Sketch()
  const hw = 100
  const hh = 66
  const R = 30
  const cx = hw - R
  const cy = hh - R
  // Corner centers, pinned to the rectangle.
  const CTL = s.addPoint(-cx, cy, { fixed: true, construction: true })
  const CTR = s.addPoint(cx, cy, { fixed: true, construction: true })
  const CBR = s.addPoint(cx, -cy, { fixed: true, construction: true })
  const CBL = s.addPoint(-cx, -cy, { fixed: true, construction: true })

  // Tangent points (top/bottom on the horizontal sides, L/R on the vertical sides),
  // started exactly at the tangent locations so the solve opens on-branch.
  const TLt = s.addPoint(-cx, hh)
  const TRt = s.addPoint(cx, hh)
  const BRt = s.addPoint(cx, -hh)
  const BLt = s.addPoint(-cx, -hh)
  const LTt = s.addPoint(-hw, cy)
  const LBt = s.addPoint(-hw, -cy)
  const RTt = s.addPoint(hw, cy)
  const RBt = s.addPoint(hw, -cy)

  const top = s.addLine(TLt.id, TRt.id)
  const bottom = s.addLine(BRt.id, BLt.id)
  const left = s.addLine(LBt.id, LTt.id)
  const right = s.addLine(RTt.id, RBt.id)

  // Each quarter-arc sweeps CCW through its outward corner.
  const aTL = s.addArc(CTL.id, TLt.id, LTt.id, R) // quadrant II: 90°→180°
  const aBL = s.addArc(CBL.id, LBt.id, BLt.id, R) // quadrant III: 180°→270°
  const aBR = s.addArc(CBR.id, BRt.id, RBt.id, R) // quadrant IV: 270°→360°
  const aTR = s.addArc(CTR.id, RTt.id, TRt.id, R) // quadrant I: 0°→90°

  s.addConstraint('horizontal', [top.id])
  s.addConstraint('horizontal', [bottom.id])
  s.addConstraint('vertical', [left.id])
  s.addConstraint('vertical', [right.id])
  // One tangency per side is enough: the far endpoint, held on its own arc's circle
  // by the intrinsic residual, makes that corner tangent for free (as in the slot).
  s.addConstraint('tangentLineCircle', [top.id, aTL.id])
  s.addConstraint('tangentLineCircle', [bottom.id, aBR.id])
  s.addConstraint('tangentLineCircle', [left.id, aBL.id])
  s.addConstraint('tangentLineCircle', [right.id, aTR.id])
  s.addConstraint('equalRadius', [aTL.id, aTR.id])
  s.addConstraint('equalRadius', [aTR.id, aBR.id])
  s.addConstraint('equalRadius', [aBR.id, aBL.id])
  s.addConstraint('radius', [aTL.id], R)
  return { sketch: s }
}

// A tangent S-curve: two cubic Bézier segments meeting at a shared middle point
// with a smooth (G1) join, both far ends held tangent to the horizontal ground.
// This is the spline showcase — the smooth-join and spline-to-line tangencies keep
// the curve fair as you drag any control handle. Splines carry no parameter of
// their own (they reduce to their four control points), so the whole thing is just
// points and three direction constraints.
function splineSCurve(): BuiltExample {
  const s = new Sketch()
  const G0 = s.addPoint(-110, -70, { fixed: true, construction: true })
  const G1p = s.addPoint(110, -70, { fixed: true, construction: true })
  const ground = s.addLine(G0.id, G1p.id, true)

  const P0 = s.addPoint(-90, 0, { fixed: true }) // start (on the left)
  const H0 = s.addPoint(-50, 40) // start handle
  const H1 = s.addPoint(-20, -40) // handle into the join
  const M = s.addPoint(0, 0) // the smooth join
  const H2 = s.addPoint(20, 40) // handle out of the join
  const H3 = s.addPoint(50, -40) // end handle
  const P1 = s.addPoint(90, 0, { fixed: true }) // end (on the right)

  const A = s.addSpline(P0.id, H0.id, H1.id, M.id)
  const B = s.addSpline(M.id, H2.id, H3.id, P1.id)

  s.addConstraint('splineTangentSpline', [M.id, A.id, B.id]) // smooth G1 join
  s.addConstraint('splineTangentLine', [P0.id, A.id, ground.id]) // start tangent horizontal
  s.addConstraint('splineTangentLine', [P1.id, B.id, ground.id]) // end tangent horizontal
  return { sketch: s }
}

// A tangent blend: a single cubic spline fairs a straight line into a circle,
// held tangent to the line at one end (a horizontal leg) and tangent to the circle
// at the other, with that end riding on the circle. The classic "blend" fillet of
// industrial design, expressed purely as relations — spline-to-line and spline-to-
// arc tangency, the direct analogues of the line/arc tangent constraints.
function splineBlend(): BuiltExample {
  const s = new Sketch()
  const A = s.addPoint(-110, -25, { fixed: true }) // leg's outer end
  const J0 = s.addPoint(-30, -25) // blend start, on the leg
  const legH = s.addLine(A.id, J0.id)

  const Cc = s.addPoint(70, 25, { fixed: true, construction: true }) // circle center
  const circle = s.addCircle(Cc.id, 32)
  // Blend end on the lower-left of the circle, started with its handle already
  // roughly perpendicular to the radius there (the well-conditioned side of the
  // tangency residual — a handle started *parallel* to the radius sits on the
  // zero-gradient ridge of cos θ and the solver cannot rotate it off).
  const J1 = s.addPoint(55, 0)

  const H0 = s.addPoint(30, -25) // start handle (drawn out along the leg)
  const H1 = s.addPoint(35, 12) // end handle (≈ perpendicular to the start radius)
  const sp = s.addSpline(J0.id, H0.id, H1.id, J1.id)

  s.addConstraint('horizontal', [legH.id])
  s.addConstraint('radius', [circle.id], 32)
  s.addConstraint('pointOnCircle', [J1.id, circle.id]) // blend end rides the circle
  s.addConstraint('splineTangentLine', [J0.id, sp.id, legH.id]) // tangent to the leg
  s.addConstraint('splineTangentArc', [J1.id, sp.id, circle.id]) // tangent to the circle
  return { sketch: s }
}

// A symmetric petal: two cubic splines sharing a base and a tip point, their control
// handles mirrored across the vertical axis by symmetry constraints — so it stays a
// perfect leaf as you drag one side and the other follows. Shows splines composing
// with the existing `symmetric` relation, no spline-specific machinery required.
function splinePetal(): BuiltExample {
  const s = new Sketch()
  const AX0 = s.addPoint(0, -75, { fixed: true, construction: true })
  const AX1 = s.addPoint(0, 75, { fixed: true, construction: true })
  const axis = s.addLine(AX0.id, AX1.id, true) // vertical mirror axis

  const B = s.addPoint(0, -55, { fixed: true }) // base tip
  const T = s.addPoint(0, 55, { fixed: true }) // top tip
  const L0 = s.addPoint(-48, -28)
  const L1 = s.addPoint(-48, 28)
  const R0 = s.addPoint(48, -28)
  const R1 = s.addPoint(48, 28)

  s.addSpline(B.id, L0.id, L1.id, T.id) // left flank
  s.addSpline(B.id, R0.id, R1.id, T.id) // right flank

  s.addConstraint('symmetric', [L0.id, R0.id, axis.id])
  s.addConstraint('symmetric', [L1.id, R1.id, axis.id])
  return { sketch: s }
}

// Bead on a Curve: a follower reads a fixed spline profile from a pivot below it. The
// bead F is pinned to the curve (pointOnSpline, carrying the curve parameter t as an
// auxiliary DOF) and the reader arm O→F is held at a driven angle, so as the angle
// sweeps the bead is the ray∩curve intersection — it slides along the profile and
// traces it. The first driven mechanism whose motion runs partly through an aux DOF,
// so the exact velocity/acceleration kinematics exercise dt/dθ.
function beadOnCurve(): BuiltExample {
  const s = new Sketch()
  const O = s.addPoint(0, -60, { fixed: true }) // reader pivot
  const R = s.addPoint(60, -60, { fixed: true }) // fixed reference (0° direction)
  // A fixed arch profile.
  const P0 = s.addPoint(-90, 20, { fixed: true })
  const C0 = s.addPoint(-30, 90, { fixed: true })
  const C1 = s.addPoint(30, 90, { fixed: true })
  const P1 = s.addPoint(90, 20, { fixed: true })
  const prof = s.addSpline(P0.id, C0.id, C1.id, P1.id)
  const F = s.addPoint(0, 72) // the bead (rides the curve)

  const refLine = s.addLine(O.id, R.id, true) // construction reference
  const arm = s.addLine(O.id, F.id) // the reader arm

  s.addConstraint('pointOnSpline', [F.id, prof.id])
  const drv = s.addConstraint('angle', [refLine.id, arm.id], 90, true)
  return {
    sketch: s,
    driver: { constraintId: drv.id, min: 50, max: 130, period: 5, wrap: false, label: 'Reader angle', unit: '°' },
    tracePoints: [F.id],
  }
}

// Ribbon of Fixed Length: a cubic whose endpoints are pinned to a baseline and whose
// true arc length is dimensioned longer than the chord, so it bows into an arch. Drag
// either handle and the ribbon re-fairs while keeping its length — an inextensible
// strip. The splineLength constraint measures ∫₀¹|B′| by Gauss–Legendre quadrature.
function fixedLengthRibbon(): BuiltExample {
  const s = new Sketch()
  const p0 = s.addPoint(-80, 0, { fixed: true })
  const p1 = s.addPoint(80, 0, { fixed: true })
  const c0 = s.addPoint(-40, 60)
  const c1 = s.addPoint(40, 60)
  const sp = s.addSpline(p0.id, c0.id, c1.id, p1.id)
  s.addConstraint('splineLength', [sp.id], 210)
  return { sketch: s }
}

// --- Session 9: free-body (multi-DOF) dynamics showcases -------------------
// These carry no driver: they are meant to be released into the multi-DOF
// Lagrange-multiplier dynamics (Free-body run), where gravity — or, for the
// dumbbell, sheer inertia — drives every degree of freedom at once.

// Double pendulum: a pivot and two equal rigid links. The canonical 2-DOF chaotic
// system. Released from both links horizontal, it swings wildly while conserving
// energy exactly (the constraint solver holds each link rigid).
function doublePendulum(): BuiltExample {
  const s = new Sketch()
  const L = 78
  const A = s.addPoint(0, 40, { fixed: true }) // pivot (up high so it has room to fall)
  const B = s.addPoint(L, 40)
  const C = s.addPoint(2 * L, 40)
  s.addLine(A.id, B.id)
  s.addLine(B.id, C.id)
  s.addConstraint('distance', [A.id, B.id], L)
  s.addConstraint('distance', [B.id, C.id], L)
  return { sketch: s, tracePoints: [C.id] }
}

// Triple-pendulum chain: three links off a pivot, a 3-DOF open chain — the reach of
// the DAE beyond anything a single generalized coordinate could describe.
function triplePendulum(): BuiltExample {
  const s = new Sketch()
  const L = 58
  const A = s.addPoint(0, 60, { fixed: true })
  const B = s.addPoint(L, 60)
  const C = s.addPoint(2 * L, 60)
  const D = s.addPoint(3 * L, 60)
  s.addLine(A.id, B.id)
  s.addLine(B.id, C.id)
  s.addLine(C.id, D.id)
  s.addConstraint('distance', [A.id, B.id], L)
  s.addConstraint('distance', [B.id, C.id], L)
  s.addConstraint('distance', [C.id, D.id], L)
  return { sketch: s, tracePoints: [D.id] }
}

// Free-floating dumbbell / spinner: two masses on a rigid link, no anchor. With
// gravity off it drifts and spins forever, conserving linear AND angular momentum;
// with gravity on it tumbles as it falls (the whole body is unconstrained — a 3-DOF
// floating rigid body). The showcase Datum could not run before Session 9.
function freeDumbbell(): BuiltExample {
  const s = new Sketch()
  const L = 120
  const P = s.addPoint(-L / 2, 30)
  const Q = s.addPoint(L / 2, 30)
  s.addLine(P.id, Q.id)
  s.addConstraint('distance', [P.id, Q.id], L)
  return { sketch: s, tracePoints: [P.id, Q.id] }
}

export const EXAMPLES: Example[] = [
  { id: 'four-bar', name: 'Four-Bar Linkage', blurb: 'Grashof crank-rocker tracing a coupler curve.', build: fourBar },
  { id: 'peaucellier', name: 'Peaucellier (exact line)', blurb: 'An inversor that draws a perfect straight line.', build: peaucellier },
  { id: 'hoeken', name: 'Hoeken (approx. line)', blurb: 'A four-bar whose coupler runs nearly straight.', build: hoeken },
  { id: 'slider-crank', name: 'Slider-Crank', blurb: 'Rotary motion into linear — the piston engine.', build: sliderCrank },
  { id: 'square', name: 'Parametric Square', blurb: 'Right angles + equal sides. Drag to resize.', build: parametricSquare },
  { id: 'triangle', name: 'Rigid Triangle', blurb: 'Three bars make a rigid body. Drag it around.', build: rigidTriangle },
  { id: 'tangent', name: 'Tangent Circles', blurb: 'Two circles kept kissing as you drag.', build: tangentCircles },
  { id: 'slot', name: 'Rounded Slot', blurb: 'Arcs + tangent flanks — one radius drives it all.', build: roundedSlot },
  { id: 'fillet', name: 'Tangent Fillet', blurb: 'An arc rounding a corner, tangent to both legs.', build: tangentFillet },
  { id: 'rounded-rect', name: 'Rounded Rectangle', blurb: 'Four tangent corner arcs; one radius rounds them all.', build: roundedRect },
  { id: 'spline-s', name: 'Tangent S-Curve', blurb: 'Two cubic Béziers with a smooth join; ends tangent to level.', build: splineSCurve },
  { id: 'spline-blend', name: 'Spline Blend', blurb: 'A cubic fairing a line into a circle, tangent to both.', build: splineBlend },
  { id: 'spline-petal', name: 'Symmetric Petal', blurb: 'Two mirrored splines make a leaf. Drag one side.', build: splinePetal },
  { id: 'bead-on-curve', name: 'Bead on a Curve', blurb: 'A follower rides a spline profile at a solved parameter — driven to slide.', build: beadOnCurve },
  { id: 'ribbon', name: 'Ribbon of Fixed Length', blurb: 'A cubic dimensioned by its true arc length. Drag a handle; it keeps its length.', build: fixedLengthRibbon },
  { id: 'hexagon', name: 'Regular Hexagon', blurb: 'Equal edges on a circle snap to regular.', build: regularHexagon },
  { id: 'double-pendulum', name: 'Double Pendulum', blurb: 'Two rigid links, 2-DOF chaos. Free-body run it under gravity.', build: doublePendulum },
  { id: 'triple-pendulum', name: 'Triple Pendulum', blurb: 'A 3-DOF open chain. Release it and watch it thrash.', build: triplePendulum },
  { id: 'free-dumbbell', name: 'Floating Dumbbell', blurb: 'Two masses, one rigid link, no anchor — it drifts and spins.', build: freeDumbbell },
  { id: 'blank', name: 'Blank Sketch', blurb: 'An empty canvas to draw your own.', build: blank },
]

export function exampleById(id: string): Example {
  return EXAMPLES.find((e) => e.id === id) ?? EXAMPLES[0]
}
