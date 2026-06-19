// A universal-variable Kepler propagator — the exact two-body flow map.
//
// Given a body's state (position + velocity) relative to a point mass and a time
// step Δt, this advances it *exactly* along its Kepler orbit, for ANY conic type
// (ellipse, parabola, hyperbola) and for Δt of either sign, with no branch on the
// eccentricity. It is the heart of the Wisdom–Holman symplectic integrator
// (`whfast.ts`): WH advances each planet along its osculating Kepler orbit about
// the star analytically, and only the small inter-planet perturbations are
// integrated numerically — which is why it conserves energy so much better than a
// brute-force stepper at the same step size.
//
// The method (Goodyear / Stumpff / Vallado, "Fundamentals of Astrodynamics"):
// introduce the universal anomaly χ defined by dχ/dt = √μ / r. Then Kepler's
// equation becomes the single universal form
//
//   √μ·Δt = χ³ S(ψ) + σ₀/√μ · χ² C(ψ) + r₀·χ·(1 − ψ S(ψ)),     ψ = α·χ²,
//
// where α = 1/a is the reciprocal semi-major axis (α>0 ellipse, =0 parabola,
// <0 hyperbola), σ₀ = r₀·v₀, and C, S are the Stumpff functions. Crucially the
// right-hand side is a STRICTLY INCREASING function of χ (its derivative is the
// instantaneous radius r > 0), so the equation has a unique root that a Newton
// iteration safeguarded by bisection finds unconditionally — no divergence, no
// special cases. The Lagrange f, g coefficients then map (r₀, v₀) → (r, v).
//
// Conventions match `orbit.ts`: 2D, μ is the gravitational parameter of the
// fixed centre (for WH that is G·m_star), vectors are plain {x, y}.

export interface Vec2 {
  x: number
  y: number
}

export interface KeplerState {
  r: Vec2
  v: Vec2
}

/**
 * The Stumpff functions C(ψ) and S(ψ).
 *
 *   C(ψ) = (1 − cos√ψ)/ψ           S(ψ) = (√ψ − sin√ψ)/√ψ³        (ψ > 0)
 *   C(ψ) = (cosh√−ψ − 1)/(−ψ)      S(ψ) = (sinh√−ψ − √−ψ)/√−ψ³    (ψ < 0)
 *   C(0) = 1/2                     S(0) = 1/6
 *
 * For |ψ| small the closed forms suffer catastrophic cancellation, so the
 * power series (which both functions share, alternating in ψ) is used instead.
 */
export function stumpff(psi: number): { c2: number; c3: number } {
  if (psi > 1e-6) {
    const s = Math.sqrt(psi)
    return { c2: (1 - Math.cos(s)) / psi, c3: (s - Math.sin(s)) / (s * s * s) }
  }
  if (psi < -1e-6) {
    const s = Math.sqrt(-psi)
    return { c2: (Math.cosh(s) - 1) / -psi, c3: (Math.sinh(s) - s) / (s * s * s) }
  }
  // Series about ψ = 0: C = 1/2 − ψ/24 + ψ²/720 − …, S = 1/6 − ψ/120 + ψ²/5040 − …
  let c2 = 0
  let c3 = 0
  let term2 = 0.5 // ψ^0 / 2!
  let term3 = 1 / 6 // ψ^0 / 3!
  for (let k = 0; k < 8; k++) {
    c2 += term2
    c3 += term3
    // Advance to the next series term: divide by the running factorial growth and flip sign.
    const n2 = (2 * k + 3) * (2 * k + 4)
    const n3 = (2 * k + 4) * (2 * k + 5)
    term2 *= -psi / n2
    term3 *= -psi / n3
  }
  return { c2, c3 }
}

/** √μ·Δt as a function of χ (the universal Kepler equation residual base) and its
 *  derivative r = d(√μ·t)/dχ, the instantaneous radius. Returned together because
 *  the iteration needs both and they share the Stumpff evaluation. */
function timeAndRadius(
  chi: number,
  alpha: number,
  r0: number,
  sigma0OverSqrtMu: number,
): { t: number; r: number } {
  const psi = alpha * chi * chi
  const { c2, c3 } = stumpff(psi)
  const chi2 = chi * chi
  const t =
    chi2 * chi * c3 + sigma0OverSqrtMu * chi2 * c2 + r0 * chi * (1 - psi * c3)
  const r = chi2 * c2 + sigma0OverSqrtMu * chi * (1 - psi * c3) + r0 * (1 - psi * c2)
  return { t, r }
}

/**
 * Advance `state` along its Kepler orbit about a fixed centre of gravitational
 * parameter `mu` by time `dt` (either sign). Returns the new state; the input is
 * not mutated. Pure and allocation-light.
 */
export function keplerStep(state: KeplerState, mu: number, dt: number): KeplerState {
  const { r: r0v, v: v0v } = state
  const r0 = Math.hypot(r0v.x, r0v.y)
  if (r0 === 0 || mu <= 0) return { r: { ...r0v }, v: { ...v0v } }
  if (dt === 0) return { r: { ...r0v }, v: { ...v0v } }

  const sqrtMu = Math.sqrt(mu)
  const v2 = v0v.x * v0v.x + v0v.y * v0v.y
  const sigma0 = r0v.x * v0v.x + r0v.y * v0v.y // r₀·v₀
  const sigma0OverSqrtMu = sigma0 / sqrtMu
  const alpha = 2 / r0 - v2 / mu // = 1/a

  const target = sqrtMu * dt

  // Near χ = 0, √μ·t ≈ r₀·χ, so χ ≈ √μ·Δt / r₀ is a good seed regardless of conic.
  let chi = target / r0
  let f = timeAndRadius(chi, alpha, r0, sigma0OverSqrtMu).t - target

  // Bracket the root using strict monotonicity (d(√μ·t)/dχ = r > 0): expand a
  // bound outward until it straddles the target. Robust for any Δt and any conic,
  // including hyperbolic orbits where the naive Kepler guess would be far off.
  let lo = chi
  let hi = chi
  if (f > 0) {
    do {
      lo -= Math.max(1, Math.abs(lo))
    } while (timeAndRadius(lo, alpha, r0, sigma0OverSqrtMu).t - target > 0 && lo > -1e12)
  } else {
    do {
      hi += Math.max(1, Math.abs(hi))
    } while (timeAndRadius(hi, alpha, r0, sigma0OverSqrtMu).t - target < 0 && hi < 1e12)
  }

  // Safeguarded Newton (Numerical Recipes "rtsafe"): a Newton step when it stays
  // inside the bracket and makes progress, a bisection step otherwise.
  const tol = 1e-13 * (1 + Math.abs(target))
  for (let i = 0; i < 80; i++) {
    const { t, r } = timeAndRadius(chi, alpha, r0, sigma0OverSqrtMu)
    f = t - target
    if (f > 0) hi = chi
    else lo = chi
    if (Math.abs(f) < tol) break
    const newton = chi - f / r // r = d(√μ·t)/dχ
    if (newton > lo && newton < hi && Number.isFinite(newton)) {
      const step = Math.abs(newton - chi)
      chi = newton
      if (step < 1e-14 * (1 + Math.abs(chi))) break
    } else {
      chi = 0.5 * (lo + hi)
    }
  }

  // Lagrange coefficients from the converged anomaly.
  const psi = alpha * chi * chi
  const { c2, c3 } = stumpff(psi)
  const chi2 = chi * chi
  const r = chi2 * c2 + sigma0OverSqrtMu * chi * (1 - psi * c3) + r0 * (1 - psi * c2)

  const fc = 1 - (chi2 / r0) * c2
  const gc = dt - (chi2 * chi / sqrtMu) * c3
  const fdot = (sqrtMu / (r * r0)) * chi * (psi * c3 - 1)
  const gdot = 1 - (chi2 / r) * c2

  return {
    r: { x: fc * r0v.x + gc * v0v.x, y: fc * r0v.y + gc * v0v.y },
    v: { x: fdot * r0v.x + gdot * v0v.x, y: fdot * r0v.y + gdot * v0v.y },
  }
}

/**
 * The Lagrange-coefficient symplectic identity f·ġ − ḟ·g = 1. A Kepler step is
 * an exact symplectic (area-preserving) map iff this holds; the self-test uses it
 * as an independent correctness probe on the propagator's internals.
 */
export function lagrangeIdentityResidual(state: KeplerState, mu: number, dt: number): number {
  const { r: r0v, v: v0v } = state
  const r0 = Math.hypot(r0v.x, r0v.y)
  if (r0 === 0) return 0
  const sqrtMu = Math.sqrt(mu)
  const v2 = v0v.x * v0v.x + v0v.y * v0v.y
  const sigma0 = r0v.x * v0v.x + r0v.y * v0v.y
  const sigma0OverSqrtMu = sigma0 / sqrtMu
  const alpha = 2 / r0 - v2 / mu
  const target = sqrtMu * dt
  // Re-solve χ (compact copy of keplerStep's solver — kept local so the identity
  // probe is fully independent of any cached state).
  let chi = target / r0
  let lo = chi
  let hi = chi
  if (timeAndRadius(chi, alpha, r0, sigma0OverSqrtMu).t - target > 0) {
    do { lo -= Math.max(1, Math.abs(lo)) } while (timeAndRadius(lo, alpha, r0, sigma0OverSqrtMu).t - target > 0 && lo > -1e12)
  } else {
    do { hi += Math.max(1, Math.abs(hi)) } while (timeAndRadius(hi, alpha, r0, sigma0OverSqrtMu).t - target < 0 && hi < 1e12)
  }
  for (let i = 0; i < 80; i++) {
    const { t, r } = timeAndRadius(chi, alpha, r0, sigma0OverSqrtMu)
    const fr = t - target
    if (fr > 0) hi = chi; else lo = chi
    if (Math.abs(fr) < 1e-13 * (1 + Math.abs(target))) break
    const newton = chi - fr / r
    chi = newton > lo && newton < hi && Number.isFinite(newton) ? newton : 0.5 * (lo + hi)
  }
  const psi = alpha * chi * chi
  const { c2, c3 } = stumpff(psi)
  const chi2 = chi * chi
  const r = chi2 * c2 + sigma0OverSqrtMu * chi * (1 - psi * c3) + r0 * (1 - psi * c2)
  const fc = 1 - (chi2 / r0) * c2
  const gc = dt - (chi2 * chi / sqrtMu) * c3
  const fdot = (sqrtMu / (r * r0)) * chi * (psi * c3 - 1)
  const gdot = 1 - (chi2 / r) * c2
  return fc * gdot - fdot * gc - 1
}
