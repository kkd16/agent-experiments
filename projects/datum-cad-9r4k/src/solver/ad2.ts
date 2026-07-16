import type { Alg } from './residualsCore'
import { wrapAngle } from './residualsCore'

// Second-order forward-mode automatic differentiation along a *single* seed
// direction — "hyper-dual" numbers.
//
// The first-order backend (ad.ts) carries a *sparse gradient* so one residual
// pass recovers a whole Jacobian row. Kinematics needs something different: the
// second directional derivative of each residual along one specific direction —
// the motion direction q̇ of the mechanism. Tracking a full dense Hessian would be
// wasteful; instead a `HyperDual` carries just three numbers:
//
//   v   — the value                       f
//   d1  — first directional derivative     D_t f  = ∇f · t
//   d2  — second directional derivative    D²_t f = tᵀ (∇²f) t
//
// where `t` is a fixed seed direction assigned to each free variable (see
// h_seed). Running a residual through this algebra therefore yields, in one pass
// and to full machine precision, exactly the two quantities the acceleration
// solve needs — (J q̇)_i in `d1` and (q̇ᵀ H_i q̇)_i in `d2` — with no per-parameter
// bookkeeping. It is the *same* residual code (residualsCore.ts) instantiated a
// third time, so it can never drift from the value or the first-order Jacobian.
//
// Every rule below is the ordinary second-derivative chain rule; the identities
// are checked live in selftest.ts against the sparse-AD Jacobian (for d1) and a
// central finite difference of d1 along the seed (for d2).
export type HyperDual = { v: number; d1: number; d2: number }

// A constant: no dependence on the seed, so both derivatives vanish.
export function h_konst(n: number): HyperDual {
  return { v: n, d1: 0, d2: 0 }
}

// A free variable of current value `v` whose assigned seed component is `t`:
// its first directional derivative is `t`, its second is 0 (a coordinate is a
// linear function of itself).
export function h_seed(v: number, t: number): HyperDual {
  return { v, d1: t, d2: 0 }
}

// A floor mirroring ad.ts, so √ / hypot near a degenerate configuration stay
// finite instead of dividing by zero mid-evaluation.
const EPS = 1e-12

// (√a)'  = a'/(2√a)
// (√a)'' = a''/(2√a) − (a')²/(4 a^{3/2})   — the standard second derivative.
function h_sqrt(a: HyperDual): HyperDual {
  const r = Math.sqrt(a.v)
  const inv = 1 / (2 * Math.max(r, EPS))
  const d1 = a.d1 * inv
  const d2 = inv * a.d2 - (a.d1 * a.d1) / (4 * Math.max(a.v, EPS) * Math.max(r, EPS))
  return { v: r, d1, d2 }
}

function h_add(a: HyperDual, b: HyperDual): HyperDual {
  return { v: a.v + b.v, d1: a.d1 + b.d1, d2: a.d2 + b.d2 }
}
function h_mul(a: HyperDual, b: HyperDual): HyperDual {
  // (ab)'  = a'b + ab'
  // (ab)'' = a''b + 2a'b' + ab''
  return { v: a.v * b.v, d1: a.d1 * b.v + a.v * b.d1, d2: a.d2 * b.v + 2 * a.d1 * b.d1 + a.v * b.d2 }
}

export const AD2: Alg<HyperDual> = {
  konst: h_konst,
  add: h_add,
  sub: (a, b) => ({ v: a.v - b.v, d1: a.d1 - b.d1, d2: a.d2 - b.d2 }),
  mul: h_mul,
  // f = a/b. From a = f·b: f' = (a' − f b')/b, then f'' = (a'' − 2 f' b' − f b'')/b.
  div: (a, b) => {
    const f = a.v / b.v
    const f1 = (a.d1 - f * b.d1) / b.v
    const f2 = (a.d2 - 2 * f1 * b.d1 - f * b.d2) / b.v
    return { v: f, d1: f1, d2: f2 }
  },
  neg: (a) => ({ v: -a.v, d1: -a.d1, d2: -a.d2 }),
  // Away from the kink at 0, |a| = s·a with s = sign(a) locally constant, so both
  // directional derivatives simply carry that sign.
  abs: (a) => {
    const s = a.v < 0 ? -1 : 1
    return { v: Math.abs(a.v), d1: s * a.d1, d2: s * a.d2 }
  },
  sqrt: h_sqrt,
  // hypot(a,b) = √(a² + b²) — composed from the verified primitives so its two
  // derivatives are correct by construction (matching Math.hypot in value).
  hypot: (a, b) => h_sqrt(h_add(h_mul(a, a), h_mul(b, b))),
  // φ = atan2(y, x). With N = x y' − y x' and D = x² + y²: φ' = N/D. Differentiating
  // once more, N' = x y'' − y x'' (the x'y'−y'x' terms cancel) and D' = 2(x x' + y y'),
  // so φ'' = (N'D − N D')/D². Same first-order value as ad.ts, extended to second order.
  atan2: (y, x) => {
    const D = Math.max(x.v * x.v + y.v * y.v, EPS)
    const N = x.v * y.d1 - y.v * x.d1
    const phi1 = N / D
    const Np = x.v * y.d2 - y.v * x.d2
    const Dp = 2 * (x.v * x.d1 + y.v * y.d1)
    const phi2 = (Np * D - N * Dp) / (D * D)
    return { v: Math.atan2(y.v, x.v), d1: phi1, d2: phi2 }
  },
  // Wrapping shifts only the value by 2π multiples; both derivatives are unchanged.
  wrap: (a) => ({ v: wrapAngle(a.v), d1: a.d1, d2: a.d2 }),
  // Matches ad.ts / PLAIN: an exactly-zero denominator collapses to the constant 1.
  guardDenom: (a) => (a.v === 0 ? h_konst(1) : a),
}
