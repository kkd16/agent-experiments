import type { Alg } from './residualsCore'
import { wrapAngle } from './residualsCore'

// Forward-mode automatic differentiation over a *sparse* gradient.
//
// A `Dual` carries a value `v` and its gradient `d` — a map from free-parameter
// column index to the partial derivative ∂v/∂xⱼ. Sparse because any single
// residual touches only a handful of parameters (a few points and radii), so its
// gradient has a handful of nonzeros regardless of how many parameters the whole
// sketch has. Evaluating a residual through the `AD` algebra therefore yields
// exactly that residual's Jacobian row, for free and to full machine precision.
export type Dual = { v: number; d: Map<number, number> }

// A constant (no dependence on any parameter): empty gradient.
export function konst(n: number): Dual {
  return { v: n, d: new Map() }
}

// A free parameter living in column `col`: value `v`, gradient = the unit vector.
export function variable(v: number, col: number): Dual {
  return { v, d: new Map([[col, 1]]) }
}

// Linear combination cα·a + cβ·b of two sparse gradients — the one primitive the
// chain rule reduces to for every binary operation below.
function lin(ca: number, a: Map<number, number>, cb: number, b: Map<number, number>): Map<number, number> {
  const out = new Map<number, number>()
  for (const [i, val] of a) out.set(i, ca * val)
  if (cb !== 0) {
    for (const [i, val] of b) out.set(i, (out.get(i) ?? 0) + cb * val)
  }
  return out
}

// A floor so that gradients of √ / hypot near a degenerate (zero-length)
// configuration stay finite instead of exploding to ±∞ mid-solve.
const EPS = 1e-12

export const AD: Alg<Dual> = {
  konst,
  add: (a, b) => ({ v: a.v + b.v, d: lin(1, a.d, 1, b.d) }),
  sub: (a, b) => ({ v: a.v - b.v, d: lin(1, a.d, -1, b.d) }),
  // (ab)' = a'b + ab'
  mul: (a, b) => ({ v: a.v * b.v, d: lin(b.v, a.d, a.v, b.d) }),
  // (a/b)' = (a'b − ab') / b²
  div: (a, b) => ({ v: a.v / b.v, d: lin(1 / b.v, a.d, -a.v / (b.v * b.v), b.d) }),
  neg: (a) => ({ v: -a.v, d: lin(-1, a.d, 0, a.d) }),
  // |a|' = sign(a)·a'
  abs: (a) => {
    const s = a.v < 0 ? -1 : 1
    return { v: Math.abs(a.v), d: lin(s, a.d, 0, a.d) }
  },
  // (√a)' = a' / (2√a)
  sqrt: (a) => {
    const r = Math.sqrt(a.v)
    return { v: r, d: lin(1 / (2 * Math.max(r, EPS)), a.d, 0, a.d) }
  },
  // hypot(a,b)' = (a·a' + b·b') / hypot
  hypot: (a, b) => {
    const r = Math.hypot(a.v, b.v)
    const inv = 1 / Math.max(r, EPS)
    return { v: r, d: lin(a.v * inv, a.d, b.v * inv, b.d) }
  },
  // atan2(y,x)' = (x·y' − y·x') / (x² + y²)
  atan2: (y, x) => {
    const denom = Math.max(x.v * x.v + y.v * y.v, EPS)
    return { v: Math.atan2(y.v, x.v), d: lin(x.v / denom, y.d, -y.v / denom, x.d) }
  },
  // Wrapping shifts the value by 2π multiples; the derivative is unchanged.
  wrap: (a) => ({ v: wrapAngle(a.v), d: a.d }),
  // A zero denominator collapses to the constant 1 (gradient dropped), exactly
  // as the plain backend's `len || 1`. Otherwise the quantity passes through.
  guardDenom: (a) => (a.v === 0 ? konst(1) : a),
}
