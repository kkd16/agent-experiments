// Classical (osculating) two-body orbital elements, in 2D.
//
// Given a body's instantaneous position and velocity *relative to a primary*,
// these pure functions reconstruct the Kepler orbit it is momentarily on — the
// "osculating" orbit that it would follow forever if every other perturbing body
// vanished. This is the same machinery a real ephemeris uses, specialised to the
// plane: the eccentricity vector fixes the orbit's shape and orientation, and the
// vis-viva relation fixes its size.
//
// Conventions: the standard gravitational parameter is μ = G·(M + m) so the
// two-body relative motion is exact; the scalar angular momentum h is the
// z-component of r × v (positive = counter-clockwise / prograde). Periapsis lies
// along the eccentricity vector at longitude ϖ; the true anomaly ν is measured
// from periapsis, so the body's position angle is ϖ + ν.

export type OrbitShape = 'circular' | 'elliptical' | 'parabolic' | 'hyperbolic'

export interface OrbitElements {
  /** Standard gravitational parameter μ = G(M+m) used for the reconstruction. */
  mu: number
  /** Current separation |r| from the primary. */
  r: number
  /** Relative speed |v|. */
  speed: number
  /** Specific orbital energy ε = v²/2 − μ/r. */
  energy: number
  /** Specific angular momentum h (signed z-component of r × v). */
  angularMomentum: number
  /** Semi-major axis a (negative for a hyperbola, ∞ flagged via shape). */
  semiMajor: number
  /** Semi-latus rectum p = h²/μ. */
  semiLatus: number
  eccentricity: number
  /** Longitude of periapsis ϖ (radians), direction of the eccentricity vector. */
  argPeriapsis: number
  /** True anomaly ν (radians), measured from periapsis. */
  trueAnomaly: number
  /** Periapsis distance r_p. */
  periapsis: number
  /** Apoapsis distance r_a, or null for unbound (parabolic/hyperbolic) orbits. */
  apoapsis: number | null
  /** Orbital period T (Kepler's third law), or null when unbound. */
  period: number | null
  bound: boolean
  shape: OrbitShape
  /** True when motion is counter-clockwise (h > 0). */
  prograde: boolean
}

const TWO_PI = Math.PI * 2

/**
 * Reconstruct the osculating orbital elements from a relative state vector.
 * `(rx, ry)` is the body's position relative to the primary and `(vx, vy)` the
 * relative velocity; `mu = G·(M + m)`.
 */
export function orbitElements(
  rx: number,
  ry: number,
  vx: number,
  vy: number,
  mu: number,
): OrbitElements {
  const r = Math.hypot(rx, ry) || 1e-12
  const v2 = vx * vx + vy * vy
  const speed = Math.sqrt(v2)
  const rdotv = rx * vx + ry * vy
  const h = rx * vy - ry * vx // scalar angular momentum (z)

  const energy = 0.5 * v2 - mu / r
  const semiLatus = (h * h) / mu

  // Eccentricity vector: e⃗ = ((v² − μ/r)·r⃗ − (r⃗·v⃗)·v⃗) / μ. Its magnitude is e
  // and it points from the focus toward periapsis.
  const k = v2 - mu / r
  const ex = (k * rx - rdotv * vx) / mu
  const ey = (k * ry - rdotv * vy) / mu
  let e = Math.hypot(ex, ey)

  // Argument of periapsis. For a (near-)circular orbit the eccentricity vector is
  // numerically meaningless, so fall back to the current position angle.
  const argPeriapsis = e > 1e-9 ? Math.atan2(ey, ex) : Math.atan2(ry, rx)

  // True anomaly: angle of the position relative to periapsis, signed by ṙ.
  const posAngle = Math.atan2(ry, rx)
  let trueAnomaly = posAngle - argPeriapsis
  // Wrap to (−π, π].
  trueAnomaly = ((trueAnomaly + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI

  const bound = energy < 0
  let shape: OrbitShape
  if (e < 1e-3) shape = 'circular'
  else if (Math.abs(e - 1) < 2e-3) shape = 'parabolic'
  else if (e < 1) shape = 'elliptical'
  else shape = 'hyperbolic'

  // Semi-major axis from vis-viva (energy). Parabolic → effectively infinite.
  const semiMajor = shape === 'parabolic' ? Infinity : -mu / (2 * energy)

  // Periapsis from the conic: r_p = p / (1 + e). Apoapsis only exists when bound.
  if (shape === 'parabolic') e = 1
  const periapsis = semiLatus / (1 + e)
  const apoapsis = bound && e < 1 ? semiLatus / (1 - e) : null
  const period =
    bound && Number.isFinite(semiMajor) && semiMajor > 0
      ? TWO_PI * Math.sqrt((semiMajor * semiMajor * semiMajor) / mu)
      : null

  return {
    mu,
    r,
    speed,
    energy,
    angularMomentum: h,
    semiMajor,
    semiLatus,
    eccentricity: e,
    argPeriapsis,
    trueAnomaly,
    periapsis,
    apoapsis,
    period,
    bound,
    shape,
    prograde: h > 0,
  }
}

/**
 * Sample the osculating conic as a polyline in *world* coordinates, centred on
 * the primary at `(px, py)`. Returns a flat [x0,y0,x1,y1,…] array. For bound
 * orbits the full ellipse is traced; for unbound orbits only the open branch
 * within the true-anomaly asymptotes is drawn (clipped to a few apoapsis-scale
 * radii so a near-parabolic orbit does not shoot off to infinity).
 */
export function sampleOrbitPath(
  el: OrbitElements,
  px: number,
  py: number,
  segments = 256,
): Float64Array {
  const { eccentricity: e, semiLatus: p, argPeriapsis: w } = el
  const cosW = Math.cos(w)
  const sinW = Math.sin(w)

  // True-anomaly sweep. Ellipse: full turn. Hyperbola/parabola: up to the
  // asymptote ν∞ = acos(−1/e), trimmed slightly so r stays finite.
  let nuMax = Math.PI
  if (e >= 1) {
    const asym = e > 1 ? Math.acos(-1 / e) : Math.PI * 0.49
    nuMax = Math.min(asym * 0.985, Math.PI - 1e-3)
  }
  const nuMin = e >= 1 ? -nuMax : -Math.PI
  const span = nuMax - nuMin

  // Clip radius for open orbits so the polyline stays on-screen-scale.
  const rClip = el.bound ? Infinity : Math.max(el.periapsis * 40, el.r * 8)

  const pts = new Float64Array((segments + 1) * 2)
  let w0 = 0
  for (let i = 0; i <= segments; i++) {
    const nu = nuMin + (span * i) / segments
    const denom = 1 + e * Math.cos(nu)
    let r = denom > 1e-6 ? p / denom : rClip
    if (r > rClip) r = rClip
    // Rotate the periapsis-frame point (r·cosν, r·sinν) by the longitude ϖ.
    const cx = r * Math.cos(nu)
    const cy = r * Math.sin(nu)
    pts[w0++] = px + cx * cosW - cy * sinW
    pts[w0++] = py + cx * sinW + cy * cosW
  }
  return pts.subarray(0, w0)
}

/** World-space periapsis point of the orbit (closest approach to the primary). */
export function periapsisPoint(el: OrbitElements, px: number, py: number): [number, number] {
  return [px + el.periapsis * Math.cos(el.argPeriapsis), py + el.periapsis * Math.sin(el.argPeriapsis)]
}

/** World-space apoapsis point, or null for an unbound orbit. */
export function apoapsisPoint(el: OrbitElements, px: number, py: number): [number, number] | null {
  if (el.apoapsis == null) return null
  const a = el.argPeriapsis + Math.PI
  return [px + el.apoapsis * Math.cos(a), py + el.apoapsis * Math.sin(a)]
}
