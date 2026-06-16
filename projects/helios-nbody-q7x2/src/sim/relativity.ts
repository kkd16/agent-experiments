// General relativity at first post-Newtonian (1PN) order.
//
// Newtonian gravity is exactly Keplerian: a bound orbit is a closed ellipse that
// never moves. Einstein's general relativity adds a tiny correction that makes
// the ellipse slowly *rotate* — the orbit's periapsis (closest approach) advances
// a little every revolution. For Mercury this apsidal precession is the famous
// 43 arc-seconds per century that Newtonian gravity (even after every planetary
// perturbation is accounted for) could not explain, and whose prediction was
// Einstein's first triumph.
//
// This module implements the leading relativistic correction for a body orbiting
// a single dominant mass M (the Schwarzschild / "gr" approximation, Anderson et
// al. 1975). In standard post-Newtonian coordinates the extra acceleration on a
// body at relative position r and relative velocity v is
//
//     a_1PN = (μ / (c² r³)) [ (4μ/r − v²) r + 4 (r·v) v ],      μ = G·M
//
// which is O((v/c)²) smaller than Newtonian gravity. Integrated over an orbit it
// advances the periapsis by exactly
//
//     Δϖ = 6π μ / (c² a (1 − e²))   radians per revolution,
//
// the standard relativistic result. Everything here is a pure function so it can
// be reused by the live simulation, the Relativity Lab and the self-test, and so
// the measured precession can be checked against the closed-form prediction.

/**
 * The 1PN relativistic correction acceleration (Newtonian gravity NOT included)
 * on a body at relative position `(rx, ry)` and relative velocity `(vx, vy)` with
 * respect to a dominant mass of standard gravitational parameter `mu = G·M`, for
 * a finite speed of light `c`. Returns `[ax, ay]`.
 */
export function grAccel(
  rx: number,
  ry: number,
  vx: number,
  vy: number,
  mu: number,
  c: number,
): [number, number] {
  const r2 = rx * rx + ry * ry
  if (r2 < 1e-18 || !(c > 0) || !Number.isFinite(c)) return [0, 0]
  const r = Math.sqrt(r2)
  const v2 = vx * vx + vy * vy
  const rdotv = rx * vx + ry * vy
  // f = μ / (c² r³); the bracket is (4μ/r − v²) r + 4 (r·v) v.
  const f = mu / (c * c * r2 * r)
  const coef = 4 * mu / r - v2
  return [f * (coef * rx + 4 * rdotv * vx), f * (coef * ry + 4 * rdotv * vy)]
}

/**
 * Closed-form relativistic apsidal precession per orbit (radians): the periapsis
 * advances by Δϖ = 6π μ / (c² a (1 − e²)) each revolution.
 */
export function precessionTheory(mu: number, a: number, e: number, c: number): number {
  if (!(c > 0) || !Number.isFinite(c) || a <= 0) return 0
  return (6 * Math.PI * mu) / (c * c * a * (1 - e * e))
}

export interface PrecessionOptions {
  /** Standard gravitational parameter μ = G·M of the central mass. */
  mu: number
  /** Semi-major axis of the (Newtonian) orbit. */
  a: number
  /** Eccentricity (0 ≤ e < 1). */
  e: number
  /** Speed of light in the same units. */
  c: number
  /** Number of radial periods to integrate (more → a cleaner average). */
  orbits?: number
  /** RK4 steps per Newtonian orbit (resolution of the integration). */
  stepsPerOrbit?: number
  /** Target number of points kept for the rosette path overlay. */
  pathPoints?: number
}

export interface PrecessionResult {
  valid: boolean
  mu: number
  a: number
  e: number
  c: number
  /** Compactness ε = μ / (a c²) — the small parameter of the expansion. */
  epsilon: number
  /** Orbital speed at periapsis as a fraction of c. */
  vPeriOverC: number
  /** Number of completed radial periods used in the measurement. */
  orbits: number
  /** Periapsis passages detected. */
  periapses: number
  /** Measured apsidal precession per orbit (radians, + = prograde). */
  measuredPerOrbit: number
  /** Closed-form prediction per orbit (radians). */
  theoryPerOrbit: number
  /** measured / theory (→ 1 when the integration confirms the formula). */
  ratio: number
  /** Sampled trajectory [x0,y0,x1,y1,…] relative to the central mass (the rosette). */
  rosette: Float64Array
}

/**
 * Integrate a test body around a fixed central mass with the 1PN correction and
 * *measure* the apsidal precession by tracking the body's azimuth at successive
 * periapsis passages. The body starts at periapsis on the +x axis moving prograde
 * (+y). Because the integration is a self-contained, exact two-body solve (no
 * Barnes–Hut, no softening) on a 4th-order Runge–Kutta, the measured precession
 * can be compared head-to-head with the closed-form `precessionTheory`.
 */
export function measurePrecession(opts: PrecessionOptions): PrecessionResult {
  const { mu, a, e, c } = opts
  const orbits = Math.max(2, Math.floor(opts.orbits ?? 14))
  const stepsPerOrbit = Math.max(200, Math.floor(opts.stepsPerOrbit ?? 4000))
  const pathPoints = Math.max(64, Math.floor(opts.pathPoints ?? 4000))

  const epsilon = mu > 0 && a > 0 && c > 0 ? mu / (a * c * c) : 0
  const theoryPerOrbit = precessionTheory(mu, a, e, c)

  const invalid: PrecessionResult = {
    valid: false, mu, a, e, c, epsilon, vPeriOverC: 0, orbits: 0, periapses: 0,
    measuredPerOrbit: NaN, theoryPerOrbit, ratio: NaN, rosette: new Float64Array(0),
  }
  if (!(mu > 0) || !(a > 0) || e < 0 || e >= 1 || !(c > 0) || !Number.isFinite(c)) return invalid

  // Initial state at periapsis: r_p = a(1−e), v_p perpendicular and prograde.
  const rp = a * (1 - e)
  const vp = Math.sqrt((mu / a) * ((1 + e) / (1 - e)))
  let x = rp
  let y = 0
  let vx = 0
  let vy = vp

  const period = 2 * Math.PI * Math.sqrt((a * a * a) / mu)
  const dt = period / stepsPerOrbit
  const totalSteps = orbits * stepsPerOrbit

  // Total acceleration: Newtonian + 1PN.
  const accel = (px: number, py: number, pvx: number, pvy: number): [number, number] => {
    const r2 = px * px + py * py
    const r = Math.sqrt(r2)
    const inv = 1 / (r2 * r) // 1/r³ for the −μ r / r³ Newtonian term
    let ax = -mu * px * inv
    let ay = -mu * py * inv
    const [gx, gy] = grAccel(px, py, pvx, pvy, mu, c)
    ax += gx
    ay += gy
    return [ax, ay]
  }

  // Accumulated (unwrapped) azimuth swept by the body, and the azimuth recorded
  // at each periapsis passage. The advance between successive periapses, minus a
  // full 2π turn, is the apsidal precession per radial period.
  let totalPhi = 0
  let prevAngle = Math.atan2(y, x)
  const periPhi: number[] = []

  // Periapsis detection by the sign change of ṙ = (r·v)/r from − to +.
  let prevRdot = x * vx + y * vy // = 0 at the start (launched from periapsis)

  // Rosette sampling.
  const sampleEvery = Math.max(1, Math.floor(totalSteps / pathPoints))
  const path = new Float64Array((Math.floor(totalSteps / sampleEvery) + 2) * 2)
  let pn = 0
  path[pn++] = x
  path[pn++] = y

  for (let s = 0; s < totalSteps; s++) {
    // --- RK4 on (position, velocity) with the velocity-dependent acceleration ---
    const [a1x, a1y] = accel(x, y, vx, vy)
    const k1px = vx, k1py = vy, k1vx = a1x, k1vy = a1y

    const h = dt * 0.5
    const [a2x, a2y] = accel(x + k1px * h, y + k1py * h, vx + k1vx * h, vy + k1vy * h)
    const k2px = vx + k1vx * h, k2py = vy + k1vy * h, k2vx = a2x, k2vy = a2y

    const [a3x, a3y] = accel(x + k2px * h, y + k2py * h, vx + k2vx * h, vy + k2vy * h)
    const k3px = vx + k2vx * h, k3py = vy + k2vy * h, k3vx = a3x, k3vy = a3y

    const [a4x, a4y] = accel(x + k3px * dt, y + k3py * dt, vx + k3vx * dt, vy + k3vy * dt)
    const k4px = vx + k3vx * dt, k4py = vy + k3vy * dt, k4vx = a4x, k4vy = a4y

    const sixth = dt / 6
    x += sixth * (k1px + 2 * k2px + 2 * k3px + k4px)
    y += sixth * (k1py + 2 * k2py + 2 * k3py + k4py)
    vx += sixth * (k1vx + 2 * k2vx + 2 * k3vx + k4vx)
    vy += sixth * (k1vy + 2 * k2vy + 2 * k3vy + k4vy)

    // Accumulate unwrapped azimuth.
    const angle = Math.atan2(y, x)
    let dphi = angle - prevAngle
    if (dphi > Math.PI) dphi -= 2 * Math.PI
    else if (dphi < -Math.PI) dphi += 2 * Math.PI
    totalPhi += dphi
    prevAngle = angle

    // Periapsis passage: ṙ crosses zero from negative to positive. Interpolate
    // the crossing fraction so the recorded azimuth is sub-step accurate.
    const rdot = x * vx + y * vy
    if (prevRdot < 0 && rdot >= 0) {
      const frac = prevRdot / (prevRdot - rdot) // ∈ [0,1): where ṙ = 0
      // Linear back-interpolation of the swept azimuth to the crossing instant.
      periPhi.push(totalPhi - dphi * (1 - frac))
    }
    prevRdot = rdot

    if ((s + 1) % sampleEvery === 0 && pn + 1 < path.length) {
      path[pn++] = x
      path[pn++] = y
    }
  }

  if (periPhi.length < 2) {
    return { ...invalid, valid: false, rosette: path.subarray(0, pn) }
  }

  // Average the per-orbit azimuthal advance beyond a full revolution.
  let sum = 0
  for (let k = 1; k < periPhi.length; k++) sum += periPhi[k] - periPhi[k - 1] - 2 * Math.PI
  const measuredPerOrbit = sum / (periPhi.length - 1)

  return {
    valid: true,
    mu, a, e, c, epsilon,
    vPeriOverC: vp / c,
    orbits: periPhi.length - 1,
    periapses: periPhi.length,
    measuredPerOrbit,
    theoryPerOrbit,
    ratio: theoryPerOrbit !== 0 ? measuredPerOrbit / theoryPerOrbit : NaN,
    rosette: path.subarray(0, pn),
  }
}

// --- The Mercury benchmark ---------------------------------------------------
// Mercury's orbit in SI, used to show that the very same formula reproduces the
// historical 43″/century once the real numbers are plugged in.
export const MERCURY = {
  /** Sun's standard gravitational parameter G·M_sun (m³/s²). */
  muSun: 1.32712440018e20,
  /** Semi-major axis (m). */
  a: 5.790905e10,
  /** Eccentricity. */
  e: 0.205630,
  /** Speed of light (m/s). */
  c: 2.99792458e8,
  /** Orbital period (days). */
  periodDays: 87.9691,
}

/** Mercury's relativistic perihelion advance in arc-seconds per century. */
export function mercuryArcsecPerCentury(): number {
  const radPerOrbit = precessionTheory(MERCURY.muSun, MERCURY.a, MERCURY.e, MERCURY.c)
  const orbitsPerCentury = (100 * 365.25) / MERCURY.periodDays
  const arcsecPerRad = (180 / Math.PI) * 3600
  return radPerOrbit * orbitsPerCentury * arcsecPerRad
}
