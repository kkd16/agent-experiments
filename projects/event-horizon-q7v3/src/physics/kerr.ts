// Closed-form Kerr observables and the analytic black-hole *shadow* (the critical curve).
//
// Everything here is exact general relativity written out in the app's rs = 1 unit system
// (so M = 0.5). These are the numbers a real observer would measure — horizon radii, the
// light-ring positions, the ISCO, and above all the outline of the shadow the Event Horizon
// Telescope actually photographs. The renderer *paints* the shadow one traced photon at a time;
// this module gives the exact curve it should draw, so the two can be checked against each other.
//
// The centrepiece is the **spherical photon orbit** family. A Kerr shadow's edge is the set of
// directions on the observer's sky along which a backwards-traced photon asymptotes onto an
// unstable spherical photon orbit at some Boyer–Lindquist radius r ∈ [r_ph⁻, r_ph⁺]. Each such
// orbit fixes two conserved ratios,
//
//     ξ(r) = L/E  and  η(r) = Q/E²   (Q = Carter's constant),
//
// and Bardeen's projection turns (ξ, η) into celestial coordinates (α, β) on the sky:
//
//     α = −ξ / sinθ_o ,   β² = η + a²cos²θ_o − ξ² cot²θ_o .
//
// At a = 0 this collapses to a circle of radius b_crit = 3√3·M — the Schwarzschild shadow.

import { M } from '../state'

export const A_STAR_MAX = 0.9995

/** Physical spin a = a*·M in rs units, clamped to the sub-extremal range. */
export function spinA(aStar: number): number {
  return Math.min(Math.max(Math.abs(aStar), 0), A_STAR_MAX) * M
}

/** Δ(r) = r² − 2Mr + a²  (the horizon function; a = physical spin in rs units). */
export function delta(r: number, a: number): number {
  return r * r - 2 * M * r + a * a
}

/** Outer / inner horizons r± = M ± √(M² − a²), in rs units. */
export function horizons(a: number): { rPlus: number; rMinus: number } {
  const root = Math.sqrt(Math.max(M * M - a * a, 0))
  return { rPlus: M + root, rMinus: M - root }
}

/**
 * Radius of an equatorial circular photon orbit, closed form (Bardeen 1972), in rs units:
 *   r/M = 2·[1 + cos(⅔·arccos(∓a*))],   − = prograde (tighter),  + = retrograde (wider).
 * Both collapse to the 1.5 rs photon sphere at a* = 0.
 */
export function photonRingRadius(aStar: number, prograde: boolean): number {
  const s = Math.min(Math.max(Math.abs(aStar), 0), A_STAR_MAX)
  const sign = prograde ? -1 : 1
  return 2 * (1 + Math.cos((2 / 3) * Math.acos(sign * s))) * M
}

/**
 * ξ(r) = L/E for the spherical photon orbit at Boyer–Lindquist radius r.
 * Derived from R(r) = R'(r) = 0 for the Kerr radial potential (see radialPotential):
 *   ξ = −(r³ − 3Mr² + a²r + a²M) / [a(r − M)].
 */
export function xiOfR(r: number, a: number): number {
  return -(r ** 3 - 3 * M * r * r + a * a * r + a * a * M) / (a * (r - M))
}

/**
 * η(r) = Q/E² for the spherical photon orbit at radius r:
 *   η = r³·[4a²M − r(r − 3M)²] / [a²(r − M)²].
 * η ≥ 0 selects the range of orbit radii that actually contribute to the shadow edge;
 * η = 0 exactly at the two equatorial (prograde/retrograde) light rings.
 */
export function etaOfR(r: number, a: number): number {
  return (r ** 3 * (4 * a * a * M - r * (r - 3 * M) ** 2)) / (a * a * (r - M) ** 2)
}

/**
 * Kerr radial potential for a null geodesic with energy E = 1, ξ = L, η = Q:
 *   R(r) = [(r²+a²) − aξ]² − Δ·[(ξ − a)² + η].
 * A backwards-traced photon from infinity is *captured* iff R(r) never vanishes between the
 * outer horizon and the observer (no radial turning point), so R governs the shadow directly.
 */
export function radialPotential(r: number, a: number, xi: number, eta: number): number {
  const P = r * r + a * a - a * xi
  return P * P - delta(r, a) * ((xi - a) ** 2 + eta)
}

/**
 * Does a photon with celestial impact parameters (α, β), seen by an observer at polar angle
 * θ_o (radians), fall into the hole? Exact test via the radial potential: capture ⇔ R(r) > 0
 * for every r between the outer horizon and the observer (the photon reaches the horizon without
 * a turning point). This is independent of the (ξ,η)-parametrised critical curve, so the two
 * agreeing is a real cross-check of the shadow algebra.
 */
export function isCaptured(alpha: number, beta: number, a: number, thetaO: number): boolean {
  const st = Math.sin(thetaO)
  const ct = Math.cos(thetaO)
  const xi = -alpha * st
  const eta = beta * beta + (alpha * alpha - a * a) * ct * ct
  if (eta < 0) return true // no allowed θ-motion here → the ray is trapped in the polar throat
  const { rPlus } = horizons(a)
  const rStart = rPlus + 1e-4
  const rEnd = 60
  const N = 500
  // Quadratic spacing packs samples near the horizon, where near-extremal turning points crowd in.
  for (let i = 0; i <= N; i++) {
    const f = i / N
    const r = rStart + (rEnd - rStart) * f * f
    if (radialPotential(r, a, xi, eta) <= 0) return false // turning point → escapes
  }
  return true
}

export interface ShadowPoint {
  alpha: number
  beta: number
  r: number
}

/**
 * The analytic critical curve — the exact outline of the Kerr shadow on the observer's sky, in
 * rs units. Traces the spherical-photon-orbit family over the radii where η ≥ 0 and projects each
 * to (α, β). Returns the upper (β ≥ 0) branch ordered in r; the shadow is symmetric under β → −β.
 * θ_o is the observer's polar angle from the spin axis (π/2 = equatorial / edge-on).
 */
export function shadowCurve(aStar: number, thetaO: number, samples = 400): ShadowPoint[] {
  const a = spinA(aStar)
  const st = Math.max(Math.sin(thetaO), 1e-3)
  const ct = Math.cos(thetaO)
  if (a < 1e-4) {
    // Schwarzschild: an exact circle of radius b_crit = 3√3·M.
    const bc = 3 * Math.sqrt(3) * M
    const out: ShadowPoint[] = []
    for (let i = 0; i <= samples; i++) {
      const phi = -Math.PI / 2 + Math.PI * (i / samples)
      out.push({ alpha: bc * Math.sin(phi), beta: bc * Math.cos(phi), r: 3 * M })
    }
    return out
  }
  const rPro = photonRingRadius(aStar, true)
  const rRet = photonRingRadius(aStar, false)
  const out: ShadowPoint[] = []
  for (let i = 0; i <= samples; i++) {
    const r = rPro + (rRet - rPro) * (i / samples)
    const xi = xiOfR(r, a)
    const eta = etaOfR(r, a)
    const beta2 = eta + a * a * ct * ct - (xi * xi * ct * ct) / (st * st)
    if (beta2 < 0) continue
    out.push({ alpha: -xi / st, beta: Math.sqrt(beta2), r })
  }
  return out
}

export interface ShadowMetrics {
  /** Horizontal extent (along the projected spin axis), in rs. */
  width: number
  /** Vertical extent, in rs. */
  height: number
  /** Enclosed area, in rs². */
  area: number
  /** Displacement of the shadow centroid from the line-of-sight origin, along α, in rs. */
  displacement: number
  /** EHT-style fractional asymmetry of the boundary about its centroid (0 = perfect circle). */
  asymmetry: number
  /** α of the left and right extremes. */
  alphaMin: number
  alphaMax: number
}

/** Geometric observables of the shadow outline, computed from the full (upper+lower) boundary. */
export function shadowMetrics(curve: ShadowPoint[]): ShadowMetrics {
  if (curve.length < 2) {
    return { width: 0, height: 0, area: 0, displacement: 0, asymmetry: 0, alphaMin: 0, alphaMax: 0 }
  }
  // Full closed boundary: upper branch forward, lower branch (β → −β) back.
  const pts: [number, number][] = []
  for (const p of curve) pts.push([p.alpha, p.beta])
  for (let i = curve.length - 1; i >= 0; i--) pts.push([curve[i].alpha, -curve[i].beta])

  let alphaMin = Infinity
  let alphaMax = -Infinity
  let betaMax = 0
  for (const [al, be] of pts) {
    alphaMin = Math.min(alphaMin, al)
    alphaMax = Math.max(alphaMax, al)
    betaMax = Math.max(betaMax, Math.abs(be))
  }
  // Shoelace area + centroid.
  let area2 = 0
  let cx = 0
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % pts.length]
    const cr = x0 * y1 - x1 * y0
    area2 += cr
    cx += (x0 + x1) * cr
  }
  const area = Math.abs(area2) / 2
  const centroidAlpha = area2 !== 0 ? cx / (3 * area2) : 0
  // Asymmetry: RMS fractional deviation of the boundary radius (from centroid) about its mean.
  let sum = 0
  let sum2 = 0
  let n = 0
  for (const [al, be] of pts) {
    const rr = Math.hypot(al - centroidAlpha, be)
    sum += rr
    sum2 += rr * rr
    n++
  }
  const mean = sum / n
  const asymmetry = mean > 0 ? Math.sqrt(Math.max(sum2 / n - mean * mean, 0)) / mean : 0
  return {
    width: alphaMax - alphaMin,
    height: 2 * betaMax,
    area,
    displacement: centroidAlpha,
    asymmetry,
    alphaMin,
    alphaMax,
  }
}

/**
 * Prograde ISCO radius (Bardeen–Press–Teukolsky), in rs units. 6M at a* = 0, → M as a* → 1.
 * Duplicated here from state.ts's kerrISCO so the physics package is self-contained and testable
 * without pulling the UI's helpers; the two must agree (checked in the self-test suite).
 */
export function iscoRadius(aStar: number): number {
  const a = Math.min(Math.max(aStar, 0), A_STAR_MAX)
  const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a))
  const z2 = Math.sqrt(3 * a * a + z1 * z1)
  return (3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2))) * M
}

/**
 * Exact relativistic frequency-shift factor g = ν_obs/ν_emit for a photon of impact parameter
 * b = L/E emitted by the equatorial disk material orbiting at radius r (prograde Ω). This is the
 * same g the Kerr renderer applies to the disk; exposed here for verification and read-outs.
 */
export function gFactor(aStar: number, r: number, b: number): number {
  const a = spinA(aStar)
  const sqrtM = Math.sqrt(M)
  const Om = sqrtM / (r ** 1.5 + a * sqrtM)
  const Sig = r * r
  const gtt = -(1 - (2 * M * r) / Sig)
  const gtp = (-2 * M * r * a) / Sig
  const gpp = r * r + a * a + (2 * M * r * a * a) / Sig
  const denom = -(gtt + 2 * Om * gtp + Om * Om * gpp)
  return Math.sqrt(Math.max(denom, 1e-9)) / Math.max(1 - Om * b, 1e-3)
}
