// Timelike geodesics — the orbits of *matter* around a Kerr–Newman black hole.
//
// Everything else in Event Horizon traces *null* geodesics: the paths of light. This module is the
// app's first tracer of **timelike** geodesics — the world-lines of massive test particles (a star,
// a clump of gas, a doomed spaceship). The physics is the same curved-spacetime geometry the photon
// integrators use; the *only* difference is the mass-shell normalisation of the four-momentum:
//
//     null   :  gᵘᵛ p_u p_v = 0
//     matter :  gᵘᵛ p_u p_v = −1     (per unit rest mass, so the affine parameter is proper time τ)
//
// That one sign is the whole story. It is why matter has an **innermost stable circular orbit**
// (the ISCO) where light does not, why bound orbits **precess** instead of closing (Mercury's
// perihelion advance — the first triumph of general relativity), and why a particle that strays
// inside the ISCO **plunges** through the horizon. In the strong field near the light-ring the same
// equations produce **zoom–whirl** orbits that wind several times around the hole between successive
// periapses — orbits with no Newtonian analogue at all.
//
// We work in the equatorial plane (θ = π/2, p_θ = 0), where a timelike geodesic is fixed by two
// conserved quantities — the specific energy E = −p_t and the specific axial angular momentum
// L = p_φ — exactly as the equatorial photon tracer is. Units are the app's rs = 1 system (M = 0.5),
// and the metric is the full **Kerr–Newman** one (spin a and charge Q²), so with a = Q = 0 this is
// Schwarzschild, with Q = 0 it is Kerr, with a = 0 it is Reissner–Nordström, and in general it is
// the most general stationary black hole there is.

import { M } from '../state'

/** Equatorial (θ = π/2) inverse-metric components of the Kerr–Newman geometry, rs = 1 units. */
export interface InvMetricEq {
  /** gᵗᵗ */ gtt: number
  /** gᵗᵠ */ gtp: number
  /** gᵠᵠ */ gpp: number
  /** gʳʳ */ grr: number
}

/**
 * The inverse metric in the equatorial plane. Charge enters through Δ = r² − 2Mr + a² + Q² and by
 * turning the mass function 2Mr into 2Mr − Q² (`MR`), identical to the photon integrators' `kerrInv`
 * evaluated at θ = π/2 (cosθ = 0, sinθ = 1). `a` and `q2` are the *physical* spin and charge² in rs
 * units (a = a*·M, Q² = (Q*·M)²).
 */
export function invMetricEq(r: number, a: number, q2 = 0): InvMetricEq {
  const a2 = a * a
  const Del = r * r - 2 * M * r + a2 + q2
  const MR = 2 * M * r - q2
  const A = (r * r + a2) * (r * r + a2) - a2 * Del
  const r2 = r * r
  return {
    gtt: -A / (r2 * Del),
    gtp: (-MR * a) / (r2 * Del),
    gpp: (Del - a2) / (r2 * Del),
    grr: Del / r2,
  }
}

/**
 * The velocity-independent part of the mass-shell condition,
 *   U(r) = gᵗᵗ E² − 2 gᵗᵠ E L + gᵠᵠ L² ,
 * so that gʳʳ p_r² = −1 − U(r). A radial turning point (p_r = 0) is exactly where U(r) = −1.
 */
export function potentialU(r: number, E: number, L: number, a: number, q2 = 0): number {
  const g = invMetricEq(r, a, q2)
  return g.gtt * E * E - 2 * g.gtp * E * L + g.gpp * L * L
}

/**
 * The radial function R(r) = (dr/dτ)² for a timelike geodesic with conserved (E, L):
 *   R(r) = gʳʳ(r)·(−1 − U(r)).
 * The particle lives where R ≥ 0; its zeros are the periapsis and apoapsis; a double zero is a
 * circular orbit. For Schwarzschild this reduces to the textbook R = E² − (1 − 2M/r)(1 + L²/r²).
 */
export function radialFunction(r: number, E: number, L: number, a: number, q2 = 0): number {
  const g = invMetricEq(r, a, q2)
  return g.grr * (-1 - (g.gtt * E * E - 2 * g.gtp * E * L + g.gpp * L * L))
}

/** dφ/dτ along the geodesic: −gᵗᵠ E + gᵠᵠ L. */
export function dphiDtau(r: number, E: number, L: number, a: number, q2 = 0): number {
  const g = invMetricEq(r, a, q2)
  return -g.gtp * E + g.gpp * L
}

/** dt/dτ along the geodesic: −gᵗᵗ E + gᵗᵠ L. This is the gravitational + motional time dilation. */
export function dtDtau(r: number, E: number, L: number, a: number, q2 = 0): number {
  const g = invMetricEq(r, a, q2)
  return -g.gtt * E + g.gtp * L
}

/** Coordinate angular velocity Ω = dφ/dt = (dφ/dτ)/(dt/dτ) — what a distant observer clocks. */
export function omega(r: number, E: number, L: number, a: number, q2 = 0): number {
  return dphiDtau(r, E, L, a, q2) / dtDtau(r, E, L, a, q2)
}

// ------------------------------------------------------------------ solving for the conserved (E, L)

/**
 * Solve a quadratic c2·x² + c1·x + c0 = 0, returning real roots (0, 1 or 2), ascending. A near-zero
 * leading coefficient degrades gracefully to the linear root.
 */
function quadRoots(c2: number, c1: number, c0: number): number[] {
  if (Math.abs(c2) < 1e-14) {
    if (Math.abs(c1) < 1e-14) return []
    return [-c0 / c1]
  }
  const disc = c1 * c1 - 4 * c2 * c0
  if (disc < 0) return []
  const s = Math.sqrt(disc)
  const r1 = (-c1 - s) / (2 * c2)
  const r2 = (-c1 + s) / (2 * c2)
  return r1 <= r2 ? [r1, r2] : [r2, r1]
}

export interface ELResult {
  E: number
  L: number
  ok: boolean
}

/**
 * Given two coefficient triples (A, B, C) = (gᵗᵗ, gᵗᵠ, gᵠᵠ) evaluated at two radii, together with
 * the constraint A₁E² − 2B₁EL + C₁L² = −1 at the first, find (E, L) of the orbit whose two turning
 * points those radii are. Shared by the apsis solver (two distinct radii) and the circular solver
 * (the radius and its derivative). `prograde` selects the sign of L (co- vs counter-rotating).
 */
function solveEL(
  A1: number, B1: number, C1: number, // constraint row (U = −1 here)
  dA: number, dB: number, dC: number, // the *difference* / derivative row (U equal, or U′ = 0)
  prograde: boolean,
): ELResult {
  // dA·x² − 2 dB·x + dC = 0 with x = E/L.
  const roots = quadRoots(dA, -2 * dB, dC)
  const wantSign = prograde ? 1 : -1
  let best: ELResult | null = null
  for (const x of roots) {
    const den = A1 * x * x - 2 * B1 * x + C1
    if (den >= 0) continue // need L² = −1/den > 0
    const L2 = -1 / den
    const L = wantSign * Math.sqrt(L2)
    const E = x * L
    if (!(E > 0) || !Number.isFinite(E) || !Number.isFinite(L)) continue
    const cand: ELResult = { E, L, ok: true }
    // Prefer the *bound* solution (E < 1); among those prefer the smaller E (deeper well).
    if (!best) best = cand
    else {
      const bBound = best.E < 1
      const cBound = E < 1
      if (cBound && !bBound) best = cand
      else if (cBound === bBound && E < best.E) best = cand
    }
  }
  return best ?? { E: NaN, L: NaN, ok: false }
}

/**
 * The conserved (E, L) of a **bound equatorial orbit** whose periapsis and apoapsis are r_p and r_a.
 * Both radii are radial turning points, so U(r_p) = U(r_a) = −1; subtracting those two equations
 * gives a quadratic in x = E/L whose coefficients are the *differences* of the inverse-metric
 * components, and back-substitution fixes L² (see solveEL). Exact for Kerr–Newman.
 */
export function orbitFromApsides(rPeri: number, rApo: number, aStar: number, prograde: boolean, charge = 0): ELResult {
  const a = aStar * M
  const q2 = (charge * M) * (charge * M)
  const gp = invMetricEq(rPeri, a, q2)
  const ga = invMetricEq(rApo, a, q2)
  return solveEL(gp.gtt, gp.gtp, gp.gpp, gp.gtt - ga.gtt, gp.gtp - ga.gtp, gp.gpp - ga.gpp, prograde)
}

/**
 * The conserved (E, L) of a **circular equatorial orbit** at radius r — the double-root limit of
 * orbitFromApsides. A circular orbit satisfies U(r) = −1 (turning point) *and* U′(r) = 0 (the
 * turning point is stationary), so the ratio E/L is fixed by U′ = 0 (the derivative row, formed here
 * by a symmetric finite difference of the inverse metric) and the magnitude by U = −1. General for
 * Kerr–Newman; reduces to the Bardeen–Press–Teukolsky closed form when uncharged (verified in the
 * self-test suite).
 */
export function circularOrbit(r: number, aStar: number, prograde: boolean, charge = 0): ELResult {
  const a = aStar * M
  const q2 = (charge * M) * (charge * M)
  const g = invMetricEq(r, a, q2)
  const h = 1e-4
  const gp = invMetricEq(r + h, a, q2)
  const gm = invMetricEq(r - h, a, q2)
  const dtt = (gp.gtt - gm.gtt) / (2 * h)
  const dtp = (gp.gtp - gm.gtp) / (2 * h)
  const dpp = (gp.gpp - gm.gpp) / (2 * h)
  return solveEL(g.gtt, g.gtp, g.gpp, dtt, dtp, dpp, prograde)
}

/**
 * Bardeen–Press–Teukolsky closed-form specific energy and angular momentum of an equatorial circular
 * geodesic at radius r (Kerr, uncharged), rs = 1 units. Upper sign = prograde. This is the textbook
 * result the general `circularOrbit` solver must reproduce; kept here as the verification oracle.
 */
export function circularBPT(r: number, aStar: number, prograde: boolean): ELResult {
  const a = aStar * M
  const s = prograde ? 1 : -1
  const sMr = Math.sqrt(M * r)
  const root = Math.sqrt(Math.max(r * r - 3 * M * r + s * 2 * a * sMr, 1e-12))
  const E = (r * r - 2 * M * r + s * a * sMr) / (r * root)
  const L = s * sMr * (r * r - s * 2 * a * sMr + a * a) / (r * root)
  return { E, L, ok: Number.isFinite(E) && Number.isFinite(L) }
}

/**
 * Prograde or retrograde ISCO radius (Bardeen–Press–Teukolsky), rs units. 6M (= 3 rs) at a* = 0;
 * the prograde branch marches down toward M and the retrograde branch out toward 9M as a* → 1.
 */
export function iscoSigned(aStar: number, prograde: boolean): number {
  const a = Math.min(Math.max(Math.abs(aStar), 0), 0.99999)
  const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a))
  const z2 = Math.sqrt(3 * a * a + z1 * z1)
  const s = prograde ? -1 : 1
  return (3 + z2 + s * Math.sqrt((3 - z1) * (3 + z1 + 2 * z2))) * M
}

/**
 * The marginally-bound circular orbit radius r_mb (Kerr, uncharged), rs units, where E = 1 — the
 * boundary between orbits that can escape to infinity and those that are gravitationally bound.
 *   r_mb / M = 2 ∓ a* + 2·√(1 ∓ a*)      (− = prograde). 4M (= 2 rs) at a* = 0.
 * A particle dropped from rest at infinity with just under this angular momentum makes one whirl and
 * plunges — the parabolic capture limit.
 */
export function marginallyBound(aStar: number, prograde: boolean): number {
  const a = Math.min(Math.max(Math.abs(aStar), 0), 0.99999)
  const s = prograde ? -1 : 1
  return (2 + s * a + 2 * Math.sqrt(Math.max(1 + s * a, 0))) * M
}

// ------------------------------------------------------------------------------ the orbit integrator

export type OrbitFate = 'bound' | 'plunge' | 'unbound' | 'invalid'

export interface OrbitTrace {
  /** Flat world-plane polyline [x0, z0, x1, z1, …] using the Kerr horizontal radius ρ = √(r²+a²). */
  points: number[]
  /** Cumulative proper time τ at each sample in `points` (same length as `count`). Drives animation. */
  times: number[]
  /** Number of (x, z) samples in `points`. */
  count: number
  E: number
  L: number
  rPeri: number
  rApo: number
  /** Semi-major axis (r_a + r_p)/2 and eccentricity (r_a − r_p)/(r_a + r_p). */
  semiMajor: number
  eccentricity: number
  /** Advance of periapsis per radial period, in radians (0 = a closed Keplerian ellipse). */
  precession: number
  /** Proper time for one radial period (periapsis → periapsis), rs units. */
  radialPeriodTau: number
  /** Coordinate time for one radial period — what a distant clock reads. */
  radialPeriodT: number
  /** Coordinate time for the azimuth to sweep a full 2π (the orbital/synodic period). */
  azimuthalPeriodT: number
  /** Average clock rate dτ/dt over one orbit (< 1: the orbiting clock runs slow); and its minimum. */
  timeDilationAvg: number
  timeDilationMin: number
  fate: OrbitFate
  /** Max |2H + 1| along the path — the mass-shell conservation error (0 = a perfect geodesic). */
  maxShellDrift: number
  /** True once the integrated orbit has completed at least one radial period. */
  closed: boolean
}

interface IntegrateOpts {
  /** Physical spin a and charge² q2 (rs units). */
  a: number
  q2: number
  E: number
  L: number
  /** Start radius (a turning point for a bound orbit). */
  r0: number
  /** Sign of the initial radial motion: +1 outward (start at periapsis), −1 inward (at apoapsis). */
  outward: number
  /** Max proper-time steps. */
  maxSteps: number
  baseStep: number
  /** Stop after this many radial periods (for a clean rosette). */
  maxPeriods: number
  /** Radius beyond which the orbit is declared unbound and integration stops. */
  rCap: number
  /** Record the world-plane polyline. Verification runs with this off to save memory. */
  recordPath: boolean
}

/** Outer horizon radius r₊ in rs units (physical a, q2). */
function rPlusOf(a: number, q2: number): number {
  return M + Math.sqrt(Math.max(M * M - a * a - q2, 0))
}

/**
 * Integrate an equatorial timelike geodesic with the same RK4 Hamiltonian scheme the equatorial
 * photon tracer uses, but with the timelike (2H = −1) initial data. Records the world-plane path,
 * detects periapsis passages to measure the precession and the radial period, accumulates proper and
 * coordinate time for the time-dilation read-out, and classifies the fate (bound / plunge / unbound).
 */
function integrateOrbit(opts: IntegrateOpts): OrbitTrace {
  const { a, q2, E, L, r0, outward, maxSteps, baseStep, maxPeriods, rCap, recordPath } = opts
  const rPlus = rPlusOf(a, q2)

  // Equations of motion from H = ½ gᵘᵛ p_u p_v: dr/dτ = gʳʳ p_r, dp_r/dτ = −½ ∂_r(2H).
  const twoH = (r: number, pr: number): number => {
    const g = invMetricEq(r, a, q2)
    return g.gtt * E * E - 2 * g.gtp * E * L + g.gpp * L * L + g.grr * pr * pr
  }
  const deriv = (r: number, pr: number): [number, number] => {
    const g = invMetricEq(r, a, q2)
    const h = 1e-4
    const dpr = -0.5 * (twoH(r + h, pr) - twoH(r - h, pr)) / (2 * h)
    return [g.grr * pr, dpr]
  }

  let r = r0
  let phi = 0
  // Seed p_r from the mass shell at the starting turning point (≈ 0), directed by `outward`.
  const g0 = invMetricEq(r, a, q2)
  const pr2 = Math.max((-1 - (g0.gtt * E * E - 2 * g0.gtp * E * L + g0.gpp * L * L)) / g0.grr, 0)
  let pr = outward * Math.sqrt(pr2)

  const points: number[] = []
  const times: number[] = []
  let tau = 0
  const pushPoint = () => {
    if (!recordPath) return
    const rho = Math.sqrt(r * r + a * a)
    points.push(rho * Math.cos(phi), rho * Math.sin(phi))
    times.push(tau)
  }
  pushPoint()

  let tCoord = 0
  let maxShellDrift = Math.abs(twoH(r, pr) + 1)
  let dilSum = 0
  let dilSamples = 0
  let dilMin = Infinity

  // Periapsis bookkeeping for precession + period (a periapsis is a −→+ crossing of dr/dτ).
  let periCount = 0
  let firstPeriPhi = phi
  let firstPeriTau = 0
  let firstPeriT = 0
  let precession = 0
  let radialPeriodTau = 0
  let radialPeriodT = 0
  let closed = false
  let rMinSeen = r
  let rMaxSeen = r
  let fate: OrbitFate = 'bound'
  let prevDr = g0.grr * pr

  for (let i = 0; i < maxSteps; i++) {
    if (r < rPlus + 0.02) {
      fate = 'plunge'
      break
    }
    if (r > rCap) {
      fate = 'unbound'
      break
    }
    const dr0 = invMetricEq(r, a, q2).grr * pr
    const dtau = baseStep * Math.max(0.25, Math.min(1.4, 0.12 * r)) * Math.min(1, Math.max((r - rPlus) * 1.2, 0.15))

    const [k1r, k1p] = deriv(r, pr)
    const [k2r, k2p] = deriv(r + 0.5 * dtau * k1r, pr + 0.5 * dtau * k1p)
    const [k3r, k3p] = deriv(r + 0.5 * dtau * k2r, pr + 0.5 * dtau * k2p)
    const [k4r, k4p] = deriv(r + dtau * k3r, pr + dtau * k3p)

    const rPrev = r
    r += (dtau / 6) * (k1r + 2 * k2r + 2 * k3r + k4r)
    pr += (dtau / 6) * (k1p + 2 * k2p + 2 * k3p + k4p)

    // Azimuth and the two clocks advance at the mid-point radius (2nd-order accurate enough here).
    const rm = 0.5 * (rPrev + r)
    phi += dphiDtau(rm, E, L, a, q2) * dtau
    const dtdt = dtDtau(rm, E, L, a, q2)
    tau += dtau
    tCoord += dtdt * dtau
    const dil = 1 / dtdt
    dilSum += dil
    dilSamples++
    dilMin = Math.min(dilMin, dil)

    rMinSeen = Math.min(rMinSeen, r)
    rMaxSeen = Math.max(rMaxSeen, r)
    maxShellDrift = Math.max(maxShellDrift, Math.abs(twoH(r, pr) + 1))
    pushPoint()

    // Periapsis: dr/dτ crosses from negative to positive.
    const drNow = invMetricEq(r, a, q2).grr * pr
    if (prevDr < 0 && drNow >= 0) {
      // Linear-interpolate the crossing fraction for a sharper period/precession estimate.
      const frac = prevDr / (prevDr - drNow)
      const phiCross = phi - (1 - frac) * dphiDtau(rm, E, L, a, q2) * dtau
      const tauCross = tau - (1 - frac) * dtau
      const tCross = tCoord - (1 - frac) * dtdt * dtau
      periCount++
      if (periCount === 1) {
        firstPeriPhi = phiCross
        firstPeriTau = tauCross
        firstPeriT = tCross
      } else if (periCount === 2) {
        radialPeriodTau = tauCross - firstPeriTau
        radialPeriodT = tCross - firstPeriT
        precession = Math.abs(phiCross - firstPeriPhi) - 2 * Math.PI
        closed = true
        if (maxPeriods <= 1) break
      }
    }
    prevDr = drNow
    void dr0

    if (periCount >= maxPeriods + 1) break
  }

  const rPeri = rMinSeen
  const rApo = fate === 'plunge' || fate === 'unbound' ? rMaxSeen : rMaxSeen
  const semiMajor = 0.5 * (rApo + rPeri)
  const eccentricity = rApo + rPeri > 0 ? (rApo - rPeri) / (rApo + rPeri) : 0
  const azimuthalPeriodT = closed && precession + 2 * Math.PI > 0 ? radialPeriodT * (2 * Math.PI) / (precession + 2 * Math.PI) : 0
  return {
    points,
    times,
    count: points.length / 2,
    E,
    L,
    rPeri,
    rApo,
    semiMajor,
    eccentricity,
    precession,
    radialPeriodTau,
    radialPeriodT,
    azimuthalPeriodT,
    timeDilationAvg: dilSamples ? dilSum / dilSamples : 1,
    timeDilationMin: Number.isFinite(dilMin) ? dilMin : 1,
    fate,
    maxShellDrift,
    closed,
  }
}

export interface OrbitConfig {
  /** Dimensionless spin a* = a/M. */
  spin: number
  /** Dimensionless charge Q* = Q/M. */
  charge: number
  /** Requested periapsis and apoapsis, rs units. */
  rPeri: number
  rApo: number
  /** Co-rotating (with the hole's spin) if true, else counter-rotating. */
  prograde: boolean
  /** Integration budget. */
  maxSteps?: number
  baseStep?: number
  maxPeriods?: number
  /** Record the world-plane polyline (default true). Verification turns it off. */
  recordPath?: boolean
}

/**
 * The public entry point: build the conserved (E, L) for the requested apsides, then integrate the
 * world-line. If the requested orbit has no valid bound solution (e.g. a periapsis inside the ISCO
 * that makes the "apoapsis" illusory), the integrator still runs from the periapsis and reports the
 * true fate — a plunge, most often, which is exactly the strong-field drama we want to show.
 */
export function traceOrbit(cfg: OrbitConfig): OrbitTrace {
  const a = cfg.spin * M
  const q2 = (cfg.charge * M) * (cfg.charge * M)
  const rPeri = Math.min(cfg.rPeri, cfg.rApo)
  const rApo = Math.max(cfg.rPeri, cfg.rApo)
  const el = orbitFromApsides(rPeri, rApo, cfg.spin, cfg.prograde, cfg.charge)
  if (!el.ok) {
    return {
      points: [],
      times: [],
      count: 0,
      E: NaN,
      L: NaN,
      rPeri,
      rApo,
      semiMajor: 0.5 * (rPeri + rApo),
      eccentricity: 0,
      precession: 0,
      radialPeriodTau: 0,
      radialPeriodT: 0,
      azimuthalPeriodT: 0,
      timeDilationAvg: 1,
      timeDilationMin: 1,
      fate: 'invalid',
      maxShellDrift: 0,
      closed: false,
    }
  }
  return integrateOrbit({
    a,
    q2,
    E: el.E,
    L: el.L,
    r0: rPeri,
    outward: 1,
    maxSteps: cfg.maxSteps ?? 260000,
    baseStep: cfg.baseStep ?? 0.9,
    maxPeriods: cfg.maxPeriods ?? 3,
    rCap: Math.max(1200, 4 * rApo),
    recordPath: cfg.recordPath ?? true,
  })
}

/** Human-readable name of the black-hole family member for the given spin/charge. */
export function holeName(spin: number, charge: number): string {
  const spinning = Math.abs(spin) > 1e-3
  const charged = Math.abs(charge) > 1e-3
  if (spinning && charged) return 'Kerr–Newman'
  if (spinning) return 'Kerr'
  if (charged) return 'Reissner–Nordström'
  return 'Schwarzschild'
}
