import type { Constraint } from '../model/types'
import type { Sketch } from '../model/sketch'

// Wrap an angle into (-π, π].
export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI
  while (a <= -Math.PI) a += 2 * Math.PI
  return a
}

const DEG = Math.PI / 180

// How many scalar residual equations a constraint contributes. Kept in sync
// with `pushResiduals` below; used for degree-of-freedom accounting.
export function residualCount(c: Constraint): number {
  switch (c.kind) {
    case 'coincident':
    case 'concentric':
    case 'midpoint':
    case 'symmetric':
    case 'colinear':
      return 2
    default:
      return 1
  }
}

// Append this constraint's residuals to `out`. Each residual is a quantity the
// solver drives to zero. Residuals are written in consistent units where
// practical (lengths in world units, orientation as a dimensionless sine/cosine)
// so the least-squares problem stays well scaled.
export function pushResiduals(sketch: Sketch, c: Constraint, out: number[]): void {
  const P = (i: number) => sketch.point(c.entities[i])
  const L = (i: number) => sketch.line(c.entities[i])
  const C = (i: number) => sketch.circle(c.entities[i])

  switch (c.kind) {
    case 'coincident': {
      const a = P(0)
      const b = P(1)
      out.push(a.x - b.x, a.y - b.y)
      return
    }
    case 'horizontal': {
      const l = L(0)
      out.push(sketch.point(l.p1).y - sketch.point(l.p2).y)
      return
    }
    case 'vertical': {
      const l = L(0)
      out.push(sketch.point(l.p1).x - sketch.point(l.p2).x)
      return
    }
    case 'parallel': {
      const a = sketch.lineDir(L(0))
      const b = sketch.lineDir(L(1))
      const denom = a.len * b.len || 1
      // sin(angle between) → zero when parallel.
      out.push((a.dx * b.dy - a.dy * b.dx) / denom)
      return
    }
    case 'perpendicular': {
      const a = sketch.lineDir(L(0))
      const b = sketch.lineDir(L(1))
      const denom = a.len * b.len || 1
      // cos(angle between) → zero when perpendicular.
      out.push((a.dx * b.dx + a.dy * b.dy) / denom)
      return
    }
    case 'equalLength': {
      out.push(sketch.lineDir(L(0)).len - sketch.lineDir(L(1)).len)
      return
    }
    case 'equalRadius': {
      out.push(C(0).r - C(1).r)
      return
    }
    case 'distance': {
      const a = P(0)
      const b = P(1)
      out.push(Math.hypot(a.x - b.x, a.y - b.y) - (c.value ?? 0))
      return
    }
    case 'pointOnLine': {
      const p = P(0)
      const l = L(1)
      const a = sketch.point(l.p1)
      const { dx, dy, len } = sketch.lineDir(l)
      const inv = len || 1
      // Signed perpendicular distance from p to the infinite line.
      out.push(((p.x - a.x) * dy - (p.y - a.y) * dx) / inv)
      return
    }
    case 'pointOnCircle': {
      const p = P(0)
      const circ = C(1)
      const ctr = sketch.point(circ.c)
      out.push(Math.hypot(p.x - ctr.x, p.y - ctr.y) - circ.r)
      return
    }
    case 'radius': {
      out.push(C(0).r - (c.value ?? 0))
      return
    }
    case 'diameter': {
      out.push(2 * C(0).r - (c.value ?? 0))
      return
    }
    case 'tangentLineCircle': {
      const l = L(0)
      const circ = C(1)
      const a = sketch.point(l.p1)
      const ctr = sketch.point(circ.c)
      const { dx, dy, len } = sketch.lineDir(l)
      const inv = len || 1
      const dist = Math.abs((ctr.x - a.x) * dy - (ctr.y - a.y) * dx) / inv
      out.push(dist - circ.r)
      return
    }
    case 'tangentCircles': {
      const c0 = C(0)
      const c1 = C(1)
      const a = sketch.point(c0.c)
      const b = sketch.point(c1.c)
      out.push(Math.hypot(a.x - b.x, a.y - b.y) - (c0.r + c1.r))
      return
    }
    case 'concentric': {
      const a = sketch.point(C(0).c)
      const b = sketch.point(C(1).c)
      out.push(a.x - b.x, a.y - b.y)
      return
    }
    case 'angle': {
      const a = sketch.lineDir(L(0))
      const b = sketch.lineDir(L(1))
      const ang = Math.atan2(a.dx * b.dy - a.dy * b.dx, a.dx * b.dx + a.dy * b.dy)
      out.push(wrapAngle(ang - (c.value ?? 0) * DEG))
      return
    }
    case 'midpoint': {
      const p = P(0)
      const l = L(1)
      const a = sketch.point(l.p1)
      const b = sketch.point(l.p2)
      out.push(p.x - (a.x + b.x) / 2, p.y - (a.y + b.y) / 2)
      return
    }
    case 'symmetric': {
      // pA and pB are mirror images across the axis line.
      const pa = P(0)
      const pb = P(1)
      const l = L(2)
      const a = sketch.point(l.p1)
      const { dx, dy, len } = sketch.lineDir(l)
      const inv = len || 1
      const ux = dx / inv
      const uy = dy / inv
      // Reflect pa across the axis, residual = pb - reflect(pa).
      const rx = pa.x - a.x
      const ry = pa.y - a.y
      const t = rx * ux + ry * uy // projection onto axis
      const perpX = rx - t * ux
      const perpY = ry - t * uy
      const reflX = a.x + t * ux - perpX
      const reflY = a.y + t * uy - perpY
      out.push(pb.x - reflX, pb.y - reflY)
      return
    }
    case 'colinear': {
      // Two lines share the same infinite line: parallel + an endpoint of the
      // second lies on the first.
      const l0 = L(0)
      const l1 = L(1)
      const d0 = sketch.lineDir(l0)
      const d1 = sketch.lineDir(l1)
      const denom = d0.len * d1.len || 1
      out.push((d0.dx * d1.dy - d0.dy * d1.dx) / denom)
      const a = sketch.point(l0.p1)
      const q = sketch.point(l1.p1)
      const inv = d0.len || 1
      out.push(((q.x - a.x) * d0.dy - (q.y - a.y) * d0.dx) / inv)
      return
    }
  }
}

// Assemble the full residual vector for a list of constraints.
export function residualVector(sketch: Sketch, constraints: Constraint[]): number[] {
  const out: number[] = []
  for (const c of constraints) pushResiduals(sketch, c, out)
  return out
}
