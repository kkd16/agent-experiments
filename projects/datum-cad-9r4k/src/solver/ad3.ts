import type { Alg } from './residualsCore'
import { wrapAngle } from './residualsCore'

// Third-order forward-mode automatic differentiation along a *single* seed
// direction — "cubic-dual" numbers, the natural extension of ad2.ts one derivative
// deeper. A `CubicDual` carries four numbers:
//
//   v   — the value                        f
//   d1  — first directional derivative      D_t f   = ∇f · t
//   d2  — second directional derivative     D²_t f  = tᵀ (∇²f) t
//   d3  — third directional derivative      D³_t f  = Σ Tᵢⱼₖ tᵢ tⱼ tₖ
//
// where `t` is a fixed seed direction assigned to each free variable (h3_seed).
// Running a residual through this algebra yields, in one pass, exactly the pure
// third directional derivative each residual contributes to the *jerk* right-hand
// side (the third-order kinematic coefficient x'''(θ) — see kinematics.computeJerk).
//
// It is the SAME residual code (residualsCore.ts) instantiated a fourth time, so it
// can never drift from the value, the Jacobian (ad.ts) or the Hessian (ad2.ts). Each
// rule below is the ordinary chain rule carried to third order; the whole backend is
// checked live in selftest.ts against a finite difference of the acceleration field.
export type CubicDual = { v: number; d1: number; d2: number; d3: number }

export function h3_konst(n: number): CubicDual {
  return { v: n, d1: 0, d2: 0, d3: 0 }
}

// A free variable of value `v` with assigned seed component `t`: a coordinate is a
// linear function of itself, so only its first directional derivative is non-zero.
export function h3_seed(v: number, t: number): CubicDual {
  return { v, d1: t, d2: 0, d3: 0 }
}

const EPS = 1e-12

function add(a: CubicDual, b: CubicDual): CubicDual {
  return { v: a.v + b.v, d1: a.d1 + b.d1, d2: a.d2 + b.d2, d3: a.d3 + b.d3 }
}
function sub(a: CubicDual, b: CubicDual): CubicDual {
  return { v: a.v - b.v, d1: a.d1 - b.d1, d2: a.d2 - b.d2, d3: a.d3 - b.d3 }
}
// (ab) derivatives by the binomial (Leibniz) rule with coefficients 1 / 1,1 / 1,2,1 / 1,3,3,1.
function mul(a: CubicDual, b: CubicDual): CubicDual {
  return {
    v: a.v * b.v,
    d1: a.d1 * b.v + a.v * b.d1,
    d2: a.d2 * b.v + 2 * a.d1 * b.d1 + a.v * b.d2,
    d3: a.d3 * b.v + 3 * a.d2 * b.d1 + 3 * a.d1 * b.d2 + a.v * b.d3,
  }
}
// f = a/b, solved order by order from a = f·b (the Leibniz rule read backwards).
function div(a: CubicDual, b: CubicDual): CubicDual {
  const b0 = b.v
  const f0 = a.v / b0
  const f1 = (a.d1 - f0 * b.d1) / b0
  const f2 = (a.d2 - 2 * f1 * b.d1 - f0 * b.d2) / b0
  const f3 = (a.d3 - 3 * f2 * b.d1 - 3 * f1 * b.d2 - f0 * b.d3) / b0
  return { v: f0, d1: f1, d2: f2, d3: f3 }
}
// f = √a, solved order by order from f·f = a: 2f₀f₁=a₁, 2f₀f₂+2f₁²=a₂, 2f₀f₃+6f₁f₂=a₃.
function sqrt(a: CubicDual): CubicDual {
  const f0 = Math.sqrt(Math.max(a.v, 0))
  const inv = 1 / (2 * Math.max(f0, EPS))
  const f1 = a.d1 * inv
  const f2 = (a.d2 - 2 * f1 * f1) * inv
  const f3 = (a.d3 - 6 * f1 * f2) * inv
  return { v: f0, d1: f1, d2: f2, d3: f3 }
}

export const AD3: Alg<CubicDual> = {
  konst: h3_konst,
  add,
  sub,
  mul,
  div,
  neg: (a) => ({ v: -a.v, d1: -a.d1, d2: -a.d2, d3: -a.d3 }),
  // Away from the kink at 0 the sign is locally constant, so every derivative carries it.
  abs: (a) => {
    const s = a.v < 0 ? -1 : 1
    return { v: Math.abs(a.v), d1: s * a.d1, d2: s * a.d2, d3: s * a.d3 }
  },
  sqrt,
  hypot: (a, b) => sqrt(add(mul(a, a), mul(b, b))),
  // φ = atan2(y, x), carried to third order. With A = x y' − y x' and B = x² + y²,
  // φ' = A/B, and differentiating twice more (using A' = x y'' − y x'', A'' = x' y'' +
  // x y''' − y' x'' − y x''', B' = 2(x x' + y y'), B'' = 2((x')² + x x'' + (y')² + y y'')):
  //   φ'  = A₀/B₀
  //   φ'' = (A₁B₀ − A₀B₁)/B₀²
  //   φ'''= A₂/B₀ − 2A₁B₁/B₀² − A₀B₂/B₀² + 2A₀B₁²/B₀³
  // The value and first two orders coincide with ad2.ts's verified atan2.
  atan2: (y, x) => {
    const x0 = x.v
    const x1 = x.d1
    const x2 = x.d2
    const x3 = x.d3
    const y0 = y.v
    const y1 = y.d1
    const y2 = y.d2
    const y3 = y.d3
    const B0 = Math.max(x0 * x0 + y0 * y0, EPS)
    const A0 = x0 * y1 - y0 * x1
    const A1 = x0 * y2 - y0 * x2
    const A2 = x1 * y2 + x0 * y3 - y1 * x2 - y0 * x3
    const B1 = 2 * (x0 * x1 + y0 * y1)
    const B2 = 2 * (x1 * x1 + x0 * x2 + y1 * y1 + y0 * y2)
    const phi1 = A0 / B0
    const phi2 = (A1 * B0 - A0 * B1) / (B0 * B0)
    const phi3 = A2 / B0 - (2 * A1 * B1) / (B0 * B0) - (A0 * B2) / (B0 * B0) + (2 * A0 * B1 * B1) / (B0 * B0 * B0)
    return { v: Math.atan2(y0, x0), d1: phi1, d2: phi2, d3: phi3 }
  },
  // Wrapping shifts only the value by 2π multiples; every derivative is unchanged.
  wrap: (a) => ({ v: wrapAngle(a.v), d1: a.d1, d2: a.d2, d3: a.d3 }),
  guardDenom: (a) => (a.v === 0 ? h3_konst(1) : a),
}
