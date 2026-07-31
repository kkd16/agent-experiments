import type { ArcEntity, Constraint, EntityId, LineEntity } from '../model/types'
import type { Sketch } from '../model/sketch'
import { GL } from './curve'

// The residual math, written *once* against an abstract arithmetic `Alg<T>`.
//
// Datum's design principle is that every constraint's residual equation is the
// single source of truth for its geometry. Historically the solver paid for that
// honesty with a forward-difference Jacobian (noisy, and O(params) extra residual
// evaluations per step). This module keeps the single-source-of-truth property
// *and* recovers exact derivatives: the same code is instantiated twice —
//
//   • with `T = number`      → plain residual values (the readable reference), and
//   • with `T = Dual`        → the value **and** its exact gradient (see ad.ts),
//
// so the analytic Jacobian is literally the residual code differentiated by the
// compiler of forward-mode automatic differentiation. There is no second, hand-
// derived derivative to fall out of sync — a class of bug simply cannot exist.

export interface Alg<T> {
  konst(n: number): T
  add(a: T, b: T): T
  sub(a: T, b: T): T
  mul(a: T, b: T): T
  div(a: T, b: T): T
  neg(a: T): T
  abs(a: T): T
  sqrt(a: T): T
  hypot(a: T, b: T): T
  atan2(y: T, x: T): T
  // Wrap an angle residual into (-π, π]. Only the *value* moves (by 2π multiples);
  // the derivative of an angle is unaffected, so implementations keep the gradient.
  wrap(a: T): T
  // Guard a quantity used as a denominator: a value of exactly 0 becomes the
  // constant 1 (matching the original `len || 1` guards), so a momentarily zero-
  // length line yields a finite residual instead of a NaN during the solve.
  guardDenom(a: T): T
}

const DEG = Math.PI / 180

// Wrap an angle into (-π, π]. Shared by the plain algebra and re-exported.
export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI
  while (a <= -Math.PI) a += 2 * Math.PI
  return a
}

// The plain-number instantiation — the human-readable reference semantics.
export const PLAIN: Alg<number> = {
  konst: (n) => n,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  neg: (a) => -a,
  abs: Math.abs,
  sqrt: Math.sqrt,
  hypot: Math.hypot,
  atan2: Math.atan2,
  wrap: wrapAngle,
  guardDenom: (a) => a || 1,
}

// Coordinate accessors: given an entity id, return its solvable scalar as a T.
// The AD backend hands back a dual carrying a unit gradient in the parameter's
// column; the plain backend hands back the raw number.
export type Vars<T> = {
  px: (pointId: EntityId) => T // point x
  py: (pointId: EntityId) => T // point y
  cr: (circleId: EntityId) => T // circle radius
  // An auxiliary parameter owned by a constraint (e.g. a curve parameter t). The AD
  // backends hand back a dual/hyper-dual carrying the seed in that column; the plain
  // backend hands back the raw stored value.
  aux: (constraintId: EntityId, index: number) => T
}

// A cubic Bézier component B(t) = (1−t)³·p0 + 3(1−t)²t·c0 + 3(1−t)t²·c1 + t³·p1, in the
// algebra A. Applied once per axis. A Bézier is a polynomial, so this — and every one
// of its derivatives — is exact in each of Datum's four backends.
export function bezierComponent<T>(A: Alg<T>, t: T, p0: T, c0: T, c1: T, p1: T): T {
  const { add, sub, mul, konst } = A
  const u = sub(konst(1), t)
  const uu = mul(u, u)
  const tt = mul(t, t)
  const b0 = mul(uu, u) // (1−t)³
  const b1 = mul(konst(3), mul(uu, t)) // 3(1−t)²t
  const b2 = mul(konst(3), mul(u, tt)) // 3(1−t)t²
  const b3 = mul(tt, t) // t³
  return add(add(mul(b0, p0), mul(b1, c0)), add(mul(b2, c1), mul(b3, p1)))
}

// The derivative component B′(t) = 3[(1−t)²(c0−p0) + 2(1−t)t(c1−c0) + t²(p1−c1)].
export function bezierDerivComponent<T>(A: Alg<T>, t: T, p0: T, c0: T, c1: T, p1: T): T {
  const { add, sub, mul, konst } = A
  const u = sub(konst(1), t)
  const a = mul(konst(3), mul(u, u)) // 3(1−t)²
  const b = mul(konst(6), mul(u, t)) // 6(1−t)t
  const c = mul(konst(3), mul(t, t)) // 3t²
  return add(add(mul(a, sub(c0, p0)), mul(b, sub(c1, c0))), mul(c, sub(p1, c1)))
}

// Append this constraint's residual(s) to `out`, expressed in the algebra `A`.
// Structure (which point a line references, etc.) is read from the sketch and is
// never differentiated; only coordinates and radii flow through `vars`.
export function pushResidualsG<T>(
  sketch: Sketch,
  A: Alg<T>,
  vars: Vars<T>,
  c: Constraint,
  out: T[],
): void {
  const { add, sub, mul, div, abs, hypot, atan2, konst, wrap, guardDenom } = A
  const { px, py, cr, aux } = vars

  const P = (i: number): EntityId => c.entities[i]
  const lineOf = (i: number): LineEntity => sketch.line(c.entities[i])
  // A circle *or* an arc — both expose the (center point `c`, radius `id→cr`) pair
  // the circular residuals below read, so every one of them applies to arcs too.
  const circleOf = (i: number) => sketch.circleLike(c.entities[i])

  // Direction vector p1→p2 of a line, plus its length, in the algebra.
  const dir = (l: LineEntity) => {
    const dx = sub(px(l.p2), px(l.p1))
    const dy = sub(py(l.p2), py(l.p1))
    return { dx, dy, len: hypot(dx, dy) }
  }

  // The tangent handle of the spline at entity slot `i`, evaluated at endpoint
  // `pointId`: the direction (control − endpoint) and its length, in the algebra.
  const spline = {
    handle: (i: number, pointId: EntityId) => {
      const h = sketch.splineHandleAt(c.entities[i], pointId)
      const dx = sub(px(h.to), px(h.from))
      const dy = sub(py(h.to), py(h.from))
      return { dx, dy, len: hypot(dx, dy) }
    },
  }

  switch (c.kind) {
    case 'coincident': {
      out.push(sub(px(P(0)), px(P(1))), sub(py(P(0)), py(P(1))))
      return
    }
    case 'horizontal': {
      const l = lineOf(0)
      out.push(sub(py(l.p1), py(l.p2)))
      return
    }
    case 'vertical': {
      const l = lineOf(0)
      out.push(sub(px(l.p1), px(l.p2)))
      return
    }
    case 'parallel': {
      const a = dir(lineOf(0))
      const b = dir(lineOf(1))
      const denom = guardDenom(mul(a.len, b.len))
      const cross = sub(mul(a.dx, b.dy), mul(a.dy, b.dx))
      out.push(div(cross, denom))
      return
    }
    case 'perpendicular': {
      const a = dir(lineOf(0))
      const b = dir(lineOf(1))
      const denom = guardDenom(mul(a.len, b.len))
      const dot = add(mul(a.dx, b.dx), mul(a.dy, b.dy))
      out.push(div(dot, denom))
      return
    }
    case 'equalLength': {
      out.push(sub(dir(lineOf(0)).len, dir(lineOf(1)).len))
      return
    }
    case 'equalRadius': {
      out.push(sub(cr(circleOf(0).id), cr(circleOf(1).id)))
      return
    }
    case 'distance': {
      const dx = sub(px(P(0)), px(P(1)))
      const dy = sub(py(P(0)), py(P(1)))
      out.push(sub(hypot(dx, dy), konst(c.value ?? 0)))
      return
    }
    case 'pointOnLine': {
      const p = P(0)
      const l = lineOf(1)
      const a = l.p1
      const { dx, dy, len } = dir(l)
      const num = sub(mul(sub(px(p), px(a)), dy), mul(sub(py(p), py(a)), dx))
      out.push(div(num, guardDenom(len)))
      return
    }
    case 'pointOnCircle': {
      const p = P(0)
      const circ = circleOf(1)
      const dx = sub(px(p), px(circ.c))
      const dy = sub(py(p), py(circ.c))
      out.push(sub(hypot(dx, dy), cr(circ.id)))
      return
    }
    case 'radius': {
      out.push(sub(cr(circleOf(0).id), konst(c.value ?? 0)))
      return
    }
    case 'diameter': {
      out.push(sub(mul(konst(2), cr(circleOf(0).id)), konst(c.value ?? 0)))
      return
    }
    case 'tangentLineCircle': {
      const l = lineOf(0)
      const circ = circleOf(1)
      const a = l.p1
      const { dx, dy, len } = dir(l)
      const signed = sub(mul(sub(px(circ.c), px(a)), dy), mul(sub(py(circ.c), py(a)), dx))
      const dist = div(abs(signed), guardDenom(len))
      out.push(sub(dist, cr(circ.id)))
      return
    }
    case 'tangentCircles': {
      const c0 = circleOf(0)
      const c1 = circleOf(1)
      const dx = sub(px(c0.c), px(c1.c))
      const dy = sub(py(c0.c), py(c1.c))
      out.push(sub(hypot(dx, dy), add(cr(c0.id), cr(c1.id))))
      return
    }
    case 'concentric': {
      const a = circleOf(0).c
      const b = circleOf(1).c
      out.push(sub(px(a), px(b)), sub(py(a), py(b)))
      return
    }
    case 'angle': {
      const a = dir(lineOf(0))
      const b = dir(lineOf(1))
      const cross = sub(mul(a.dx, b.dy), mul(a.dy, b.dx))
      const dot = add(mul(a.dx, b.dx), mul(a.dy, b.dy))
      out.push(wrap(sub(atan2(cross, dot), konst((c.value ?? 0) * DEG))))
      return
    }
    case 'midpoint': {
      const p = P(0)
      const l = lineOf(1)
      out.push(
        sub(px(p), div(add(px(l.p1), px(l.p2)), konst(2))),
        sub(py(p), div(add(py(l.p1), py(l.p2)), konst(2))),
      )
      return
    }
    case 'symmetric': {
      const pa = P(0)
      const pb = P(1)
      const l = lineOf(2)
      const a = l.p1
      const { dx, dy, len } = dir(l)
      const g = guardDenom(len)
      const ux = div(dx, g)
      const uy = div(dy, g)
      const rx = sub(px(pa), px(a))
      const ry = sub(py(pa), py(a))
      const t = add(mul(rx, ux), mul(ry, uy)) // projection onto the axis
      const perpX = sub(rx, mul(t, ux))
      const perpY = sub(ry, mul(t, uy))
      const reflX = sub(add(px(a), mul(t, ux)), perpX)
      const reflY = sub(add(py(a), mul(t, uy)), perpY)
      out.push(sub(px(pb), reflX), sub(py(pb), reflY))
      return
    }
    case 'colinear': {
      const l0 = lineOf(0)
      const l1 = lineOf(1)
      const d0 = dir(l0)
      const d1 = dir(l1)
      const denom = guardDenom(mul(d0.len, d1.len))
      out.push(div(sub(mul(d0.dx, d1.dy), mul(d0.dy, d1.dx)), denom))
      const a = l0.p1
      const q = l1.p1
      const num = sub(mul(sub(px(q), px(a)), d0.dy), mul(sub(py(q), py(a)), d0.dx))
      out.push(div(num, guardDenom(d0.len)))
      return
    }
    // --- spline tangency ---------------------------------------------------
    // All three read a spline endpoint's tangent handle as an ordered point pair
    // [from, to] (see Sketch.splineHandleAt) and constrain that direction, exactly
    // reusing the line-direction algebra above. The chosen endpoint is entities[0]
    // (a point), which also anchors the on-canvas glyph.
    case 'splineTangentLine': {
      // The spline's endpoint tangent is parallel to a line — cross product = 0,
      // scaled by the two lengths like the plain `parallel` residual.
      const h = spline.handle(1, P(0))
      const l = dir(lineOf(2))
      const denom = guardDenom(mul(h.len, l.len))
      out.push(div(sub(mul(h.dx, l.dy), mul(h.dy, l.dx)), denom))
      return
    }
    case 'splineTangentSpline': {
      // Two splines share the endpoint P(0); their handles there are collinear —
      // a smooth (G1) join. Collinearity (cross = 0) admits either sense, so the
      // curve continues smoothly whether the handles point the same or opposite way.
      const a = spline.handle(1, P(0))
      const b = spline.handle(2, P(0))
      const denom = guardDenom(mul(a.len, b.len))
      out.push(div(sub(mul(a.dx, b.dy), mul(a.dy, b.dx)), denom))
      return
    }
    case 'splineTangentArc': {
      // The spline's endpoint tangent is perpendicular to the circle/arc radius at
      // that endpoint (the tangent line of a circle is ⟂ its radius) — dot = 0.
      const h = spline.handle(1, P(0))
      const circ = circleOf(2)
      const rx = sub(px(P(0)), px(circ.c))
      const ry = sub(py(P(0)), py(circ.c))
      const rlen = hypot(rx, ry)
      out.push(div(add(mul(h.dx, rx), mul(h.dy, ry)), guardDenom(mul(h.len, rlen))))
      return
    }
    // --- curve-parameter constraints (auxiliary DOF) -----------------------
    case 'pointOnSpline': {
      // The point P(0) rides the cubic spline entities[1] at the solved parameter
      // t = aux(c.id, 0): two residuals B(t) − P = 0. Because B(t) is a polynomial,
      // its value and its ∂/∂t column are exact in every backend.
      const p = P(0)
      const s = sketch.spline(c.entities[1])
      const t = aux(c.id, 0)
      const bx = bezierComponent(A, t, px(s.p0), px(s.c0), px(s.c1), px(s.p1))
      const by = bezierComponent(A, t, py(s.p0), py(s.c0), py(s.c1), py(s.p1))
      out.push(sub(bx, px(p)), sub(by, py(p)))
      return
    }
    case 'splineLength': {
      // The spline entities[0]'s true arc length L = ∫₀¹ |B′(t)| dt, evaluated by the
      // fixed Gauss–Legendre rule (a constant-weighted sum of hypot(B′ₓ, B′_y) at fixed
      // nodes — all differentiable), driven to the target value.
      const s = sketch.spline(c.entities[0])
      const x0 = px(s.p0)
      const x1 = px(s.c0)
      const x2 = px(s.c1)
      const x3 = px(s.p1)
      const y0 = py(s.p0)
      const y1 = py(s.c0)
      const y2 = py(s.c1)
      const y3 = py(s.p1)
      let len = konst(0)
      for (let k = 0; k < GL.t.length; k++) {
        const tk = konst(GL.t[k])
        const dx = bezierDerivComponent(A, tk, x0, x1, x2, x3)
        const dy = bezierDerivComponent(A, tk, y0, y1, y2, y3)
        len = add(len, mul(konst(GL.w[k]), hypot(dx, dy)))
      }
      out.push(sub(len, konst(c.value ?? 0)))
      return
    }
  }
}

// The *intrinsic* residuals every arc always carries: both endpoints lie on the
// arc's circle, |p1 − c| = r and |p2 − c| = r. These are not user constraints —
// they are what makes an arc a rigid circular arc rather than three loose points,
// and are appended (in entity order, after all user constraints) wherever the
// residual vector or its Jacobian is assembled. Written over the same abstract
// algebra `A`, so the plain and automatic-differentiation backends share the code
// and the differential self-test proves the two agree for arcs as well.
export function pushArcResidualsG<T>(A: Alg<T>, vars: Vars<T>, arc: ArcEntity, out: T[]): void {
  const { sub, hypot } = A
  const { px, py, cr } = vars
  const r = cr(arc.id)
  const cx = px(arc.c)
  const cy = py(arc.c)
  for (const pid of [arc.p1, arc.p2]) {
    const dx = sub(px(pid), cx)
    const dy = sub(py(pid), cy)
    out.push(sub(hypot(dx, dy), r))
  }
}

// How many intrinsic residuals a single arc contributes (both endpoints on the
// circle). Used for degree-of-freedom / residual-count bookkeeping.
export const ARC_RESIDUALS = 2
