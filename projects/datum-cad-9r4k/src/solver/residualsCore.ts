import type { ArcEntity, Constraint, EntityId, LineEntity } from '../model/types'
import type { Sketch } from '../model/sketch'

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
  const { px, py, cr } = vars

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
