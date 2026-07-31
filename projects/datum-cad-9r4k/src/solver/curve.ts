// Cubic-Bézier curve calculus, in plain numbers: the geometry helpers Datum needs
// for the curve-parameter constraints (Session 7). The differentiable versions used
// by the solver live over the abstract algebra `Alg<T>` in residualsCore.ts; this
// module is the plain-number reference (curve sampling, a dense reference arc length
// for tests/UI defaults, and nearest-parameter projection to seed a new
// point-on-spline's parameter t).

export type Vec2 = [number, number]

// A cubic Bézier point B(t) = (1−t)³P0 + 3(1−t)²t·C0 + 3(1−t)t²·C1 + t³·P1.
export function cubicPoint(p0: Vec2, c0: Vec2, c1: Vec2, p1: Vec2, t: number): Vec2 {
  const u = 1 - t
  const b0 = u * u * u
  const b1 = 3 * u * u * t
  const b2 = 3 * u * t * t
  const b3 = t * t * t
  return [
    b0 * p0[0] + b1 * c0[0] + b2 * c1[0] + b3 * p1[0],
    b0 * p0[1] + b1 * c0[1] + b2 * c1[1] + b3 * p1[1],
  ]
}

// The derivative B′(t) = 3[(1−t)²(C0−P0) + 2(1−t)t(C1−C0) + t²(P1−C1)]. Its magnitude
// is the speed |B′(t)|, whose integral over [0,1] is the arc length.
export function cubicDeriv(p0: Vec2, c0: Vec2, c1: Vec2, p1: Vec2, t: number): Vec2 {
  const u = 1 - t
  const a = 3 * u * u
  const b = 6 * u * t
  const c = 3 * t * t
  return [
    a * (c0[0] - p0[0]) + b * (c1[0] - c0[0]) + c * (p1[0] - c1[0]),
    a * (c0[1] - p0[1]) + b * (c1[1] - c0[1]) + c * (p1[1] - c1[1]),
  ]
}

// --- Gauss–Legendre quadrature on [0,1] ------------------------------------
//
// Generated once (not transcribed): the nodes are the roots of the degree-n Legendre
// polynomial found by Newton's method on the three-term recurrence, and the weights
// are 2 / ((1−xᵢ²) Pₙ′(xᵢ)²) — both mapped from the standard interval [−1,1] to [0,1].
// A 24-point rule integrates polynomials up to degree 47 exactly, so |B′(t)| (a smooth
// function) is captured to well past machine relevance, and any *constant* integrand
// (the straight-spline case) is exact for every order.

function legendre(n: number, x: number): { p: number; dp: number } {
  // P₀=1, P₁=x, k·Pₖ = (2k−1)x·Pₖ₋₁ − (k−1)·Pₖ₋₂.
  let p0 = 1
  let p1 = x
  for (let k = 2; k <= n; k++) {
    const p2 = ((2 * k - 1) * x * p1 - (k - 1) * p0) / k
    p0 = p1
    p1 = p2
  }
  // Pₙ′(x) = n (x·Pₙ − Pₙ₋₁) / (x² − 1).
  const dp = (n * (x * p1 - p0)) / (x * x - 1)
  return { p: p1, dp }
}

export function gaussLegendre01(n: number): { t: number[]; w: number[] } {
  const t: number[] = []
  const w: number[] = []
  for (let i = 0; i < n; i++) {
    // Chebyshev-style initial guess for the i-th root, refined by Newton.
    let x = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5))
    let ev = legendre(n, x)
    for (let it = 0; it < 100; it++) {
      const dx = -ev.p / ev.dp
      x += dx
      ev = legendre(n, x)
      if (Math.abs(dx) < 1e-15) break
    }
    const wl = 2 / ((1 - x * x) * ev.dp * ev.dp)
    t.push((x + 1) / 2) // map [−1,1] → [0,1]
    w.push(wl / 2) // Jacobian of the map is ½
  }
  return { t, w }
}

// The fixed rule the solver's length residual uses. Kept module-level so it is built
// once; residualsCore.ts imports it to weight the |B′(t)| samples.
export const GL = gaussLegendre01(24)

// The plain-number arc length of a cubic, by the same Gauss–Legendre rule the solver
// residual uses (so the constraint's target and the measured length agree to machine
// precision). This is the value the UI shows as the default when you dimension a
// spline's length, and the reference the self-tests check.
export function cubicLength(p0: Vec2, c0: Vec2, c1: Vec2, p1: Vec2): number {
  let sum = 0
  for (let k = 0; k < GL.t.length; k++) {
    const d = cubicDeriv(p0, c0, c1, p1, GL.t[k])
    sum += GL.w[k] * Math.hypot(d[0], d[1])
  }
  return sum
}

// An independent, dense reference arc length (composite trapezoid at high resolution)
// — deliberately *not* Gauss–Legendre, so a self-test can cross-check the quadrature
// rule against a different method on a genuinely curved spline.
export function cubicLengthDense(p0: Vec2, c0: Vec2, c1: Vec2, p1: Vec2, n = 4000): number {
  let sum = 0
  let prev = Math.hypot(...cubicDeriv(p0, c0, c1, p1, 0))
  for (let i = 1; i <= n; i++) {
    const s = Math.hypot(...cubicDeriv(p0, c0, c1, p1, i / n))
    sum += ((prev + s) / 2) * (1 / n)
    prev = s
  }
  return sum
}

// The parameter t ∈ [0,1] whose curve point is closest to `q` — used to seed a fresh
// point-on-spline constraint so the solver starts near the right place. A coarse scan
// picks the basin; a few Newton steps on d/dt ‖B(t)−q‖² = 2 B′·(B−q) refine it.
export function nearestParam(p0: Vec2, c0: Vec2, c1: Vec2, p1: Vec2, q: Vec2): number {
  let best = 0
  let bestD = Infinity
  const N = 64
  for (let i = 0; i <= N; i++) {
    const t = i / N
    const b = cubicPoint(p0, c0, c1, p1, t)
    const d = (b[0] - q[0]) ** 2 + (b[1] - q[1]) ** 2
    if (d < bestD) {
      bestD = d
      best = t
    }
  }
  let t = best
  for (let it = 0; it < 8; it++) {
    const b = cubicPoint(p0, c0, c1, p1, t)
    const d1 = cubicDeriv(p0, c0, c1, p1, t)
    // f(t) = B′·(B−q); f′(t) = |B′|² + B″·(B−q). Newton step t -= f/f′.
    const rx = b[0] - q[0]
    const ry = b[1] - q[1]
    const f = d1[0] * rx + d1[1] * ry
    const d2 = cubicSecond(p0, c0, c1, p1, t)
    const fp = d1[0] * d1[0] + d1[1] * d1[1] + d2[0] * rx + d2[1] * ry
    if (Math.abs(fp) < 1e-12) break
    t -= f / fp
    if (t < 0) t = 0
    if (t > 1) t = 1
  }
  return t
}

// Split a cubic Bézier at parameter t into two cubics via the de Casteljau
// construction. The two halves together retrace the original curve *exactly* — the
// left one is the original restricted to [0,t] and the right one to [t,1], each
// reparametrised to [0,1] — and they meet with matching tangent (C1) at the split
// point. Returns the two control-point quadruples; the shared split point is
// `left[3] === right[0]` in value.
export function splitCubic(
  p0: Vec2,
  c0: Vec2,
  c1: Vec2,
  p1: Vec2,
  t: number,
): { left: [Vec2, Vec2, Vec2, Vec2]; right: [Vec2, Vec2, Vec2, Vec2] } {
  const lerp = (a: Vec2, b: Vec2): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  const l1 = lerp(p0, c0)
  const h = lerp(c0, c1)
  const r2 = lerp(c1, p1)
  const l2 = lerp(l1, h)
  const r1 = lerp(h, r2)
  const s = lerp(l2, r1) // the point on the curve at t
  return { left: [p0, l1, l2, s], right: [s, r1, r2, p1] }
}

// B″(t) = 6[(1−t)(C1−2C0+P0) + t(P1−2C1+C0)] — only needed for the Newton refinement
// of nearestParam.
function cubicSecond(p0: Vec2, c0: Vec2, c1: Vec2, p1: Vec2, t: number): Vec2 {
  const u = 1 - t
  return [
    6 * (u * (c1[0] - 2 * c0[0] + p0[0]) + t * (p1[0] - 2 * c1[0] + c0[0])),
    6 * (u * (c1[1] - 2 * c0[1] + p0[1]) + t * (p1[1] - 2 * c1[1] + c0[1])),
  ]
}
