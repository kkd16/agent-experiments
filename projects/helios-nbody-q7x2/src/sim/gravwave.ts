// Gravitational radiation from a two-body inspiral.
//
// The 1PN module (`relativity.ts`) adds the *conservative* relativistic
// correction — the one that makes a bound orbit precess. This module adds the
// *dissipative* half: an orbiting pair radiates gravitational waves, bleeds
// orbital energy and angular momentum, and slowly spirals together — the
// "chirp" LIGO first heard from GW150914 in 2015.
//
// Everything here is a from-scratch solver on the *relative* two-body orbit
// (separation vector r = r₂ − r₁, reduced mass μ = m₁m₂/M, total mass M).
// Three independent pieces, all pure functions so the lab and the self-test can
// share them and check them against each other:
//
//   1. The 2.5PN radiation-reaction acceleration (Damour–Deruelle gauge) — the
//      leading O((v/c)⁵) force that drives the inspiral.
//   2. Einstein's quadrupole formula for the transverse-traceless wave strain
//      h₊, h× radiated toward an observer at inclination ι and distance D.
//   3. Peters' (1964) closed-form results — the circular merger time, the
//      gravitational luminosity, and the coupled da/dt, de/dt — which the
//      integrated inspiral is checked against.
//
// The verification is honest by construction: the radiation-reaction force and
// the Peters fluxes are *independently* derived, so when the integrated merger
// time reproduces Peters' formula (it does, to a fraction of a percent), that is
// a real cross-check of both.

// ---------------------------------------------------------------------------
// 1. The 2.5PN radiation-reaction acceleration on the relative orbit.
// ---------------------------------------------------------------------------

/**
 * The leading-order (2.5PN) gravitational radiation-reaction acceleration on
 * the relative two-body coordinate, in the Damour–Deruelle gauge:
 *
 *   a_RR = (8/5)(G²Mμ / c⁵r³)[ (3v² + 17/3·GM/r) ṙ n̂ − (v² + 3 GM/r) v ]
 *
 * with n̂ = r/|r| and ṙ = (r·v)/|r| the radial velocity. It is O((v/c)⁵)
 * smaller than Newtonian gravity. Although the *instantaneous* form is
 * gauge-dependent, its orbit-average reproduces the gauge-invariant Peters
 * energy and angular-momentum fluxes — which the self-test confirms by
 * recovering Peters' merger time and eccentricity evolution. Returns [ax, ay].
 */
export function radiationReactionAccel(
  rx: number,
  ry: number,
  vx: number,
  vy: number,
  bigM: number,
  mu: number,
  g: number,
  c: number,
): [number, number] {
  const r2 = rx * rx + ry * ry
  if (r2 < 1e-18 || !(c > 0) || !Number.isFinite(c)) return [0, 0]
  const r = Math.sqrt(r2)
  const v2 = vx * vx + vy * vy
  const gm = g * bigM
  const rdot = (rx * vx + ry * vy) / r // ṙ
  // prefactor (8/5) G²Mμ / (c⁵ r³)
  const pref = (8 / 5) * (g * g * bigM * mu) / (c * c * c * c * c * (r2 * r))
  const cn = 3 * v2 + (17 / 3) * (gm / r) // coefficient of ṙ n̂
  const cv = v2 + 3 * (gm / r) // coefficient of v
  const nx = rx / r
  const ny = ry / r
  const ax = pref * (cn * rdot * nx - cv * vx)
  const ay = pref * (cn * rdot * ny - cv * vy)
  return [ax, ay]
}

// ---------------------------------------------------------------------------
// 2. The quadrupole-formula wave strain.
// ---------------------------------------------------------------------------

/**
 * The two transverse-traceless polarisations h₊, h× radiated by the relative
 * orbit toward an observer at inclination ι (the angle between the line of
 * sight and the orbital angular momentum) and luminosity distance D.
 *
 * The mass quadrupole of the (planar) relative orbit is Iⱼₖ = μ xⱼxₖ; the wave
 * strain is hⱼₖᵀᵀ = (2G/c⁴D)·Ïⱼₖᵀᵀ. The second time derivative
 * Ïⱼₖ = μ(2vⱼvₖ + xⱼaₖ + aⱼxₖ) is evaluated with the Newtonian acceleration
 * a = −GM r/r³ (radiation-reaction enters the strain only at higher order), and
 * the transverse-traceless part is extracted by projecting onto the observer's
 * two polarisation basis vectors p = (cosι,0,−sinι), q = (0,1,0):
 *
 *   h₊ = ½(pᵃpᵇ − qᵃqᵇ)hₐᵦ,   h× = ½(pᵃqᵇ + qᵃpᵇ)hₐᵦ.
 *
 * For a circular orbit this reduces to the textbook h₊ ∝ (1+cos²ι), h× ∝ 2cosι.
 * Returns [hplus, hcross].
 */
export function strainTT(
  rx: number,
  ry: number,
  vx: number,
  vy: number,
  mu: number,
  g: number,
  bigM: number,
  c: number,
  distance: number,
  inclRad: number,
): [number, number] {
  const r2 = rx * rx + ry * ry
  if (r2 < 1e-18 || !(distance > 0) || !(c > 0)) return [0, 0]
  const r = Math.sqrt(r2)
  const inv = 1 / (r2 * r)
  // Newtonian relative acceleration a = −GM r / r³.
  const ax = -g * bigM * rx * inv
  const ay = -g * bigM * ry * inv
  // Second time derivative of the reduced quadrupole Iⱼₖ = μ xⱼxₖ.
  const Ixx = mu * (2 * vx * vx + 2 * rx * ax)
  const Iyy = mu * (2 * vy * vy + 2 * ry * ay)
  const Ixy = mu * (2 * vx * vy + rx * ay + ry * ax)
  // Wave strain hⱼₖ = (2G/c⁴D)·Ïⱼₖ.
  const pref = (2 * g) / (c * c * c * c * distance)
  const hxx = pref * Ixx
  const hyy = pref * Iyy
  const hxy = pref * Ixy
  // TT projection. p = (cosι,0,−sinι), q = (0,1,0); only the x–y block of h is
  // populated (the orbit is planar), so the z components drop out:
  //   h₊ = ½(cos²ι·hxx − hyy),  h× = cosι·hxy.
  const cosi = Math.cos(inclRad)
  const hplus = 0.5 * (cosi * cosi * hxx - hyy)
  const hcross = cosi * hxy
  return [hplus, hcross]
}

// ---------------------------------------------------------------------------
// 3. Peters (1964) closed forms — the verification oracle.
// ---------------------------------------------------------------------------

/** GW frequency of a circular binary: f_gw = 2·f_orb = (1/π)√(GM/a³). */
export function gwFrequencyCircular(g: number, m1: number, m2: number, a: number): number {
  if (a <= 0) return 0
  return (1 / Math.PI) * Math.sqrt((g * (m1 + m2)) / (a * a * a))
}

/** Quadrupole gravitational luminosity of a circular binary (Peters 1964). */
export function quadrupoleLuminosityCircular(
  g: number,
  c: number,
  m1: number,
  m2: number,
  a: number,
): number {
  if (a <= 0 || !(c > 0)) return 0
  const M = m1 + m2
  return (32 / 5) * (g ** 4 * m1 * m1 * m2 * m2 * M) / (c ** 5 * a ** 5)
}

/**
 * Time for a circular binary to inspiral from semi-major axis `a` to coalescence
 * (a → 0): t_c = 5c⁵a⁴ / (256 G³ m₁m₂M). The classic Peters result.
 */
export function petersCircularMergerTime(
  g: number,
  c: number,
  m1: number,
  m2: number,
  a: number,
): number {
  const M = m1 + m2
  return (5 * c ** 5 * a ** 4) / (256 * g ** 3 * m1 * m2 * M)
}

/**
 * The coupled orbit-averaged Peters (1964) equations for an eccentric binary,
 * da/dt and de/dt, in the same units as everything else. Used both to evolve a
 * reference (a,e) track in the self-test and to predict the eccentric inspiral.
 */
export function petersRates(
  g: number,
  c: number,
  m1: number,
  m2: number,
  a: number,
  e: number,
): { dadt: number; dedt: number } {
  if (a <= 0 || e < 0 || e >= 1 || !(c > 0)) return { dadt: 0, dedt: 0 }
  const M = m1 + m2
  const k = (g ** 3 * m1 * m2 * M) / c ** 5
  const one = 1 - e * e
  const dadt =
    -(64 / 5) * (k / a ** 3) * ((1 + (73 / 24) * e * e + (37 / 96) * e ** 4) / one ** 3.5)
  const dedt = -(304 / 15) * (k * e / a ** 4) * ((1 + (121 / 304) * e * e) / one ** 2.5)
  return { dadt, dedt }
}

/**
 * The "chirp mass" ℳ = (m₁m₂)^{3/5} / M^{1/5} — the single mass combination that
 * sets the leading-order inspiral rate and waveform amplitude.
 */
export function chirpMass(m1: number, m2: number): number {
  return Math.pow(m1 * m2, 3 / 5) / Math.pow(m1 + m2, 1 / 5)
}

// ---------------------------------------------------------------------------
// The inspiral integrator.
// ---------------------------------------------------------------------------

export interface InspiralOptions {
  m1: number
  m2: number
  g: number
  c: number
  /** Initial semi-major axis. */
  a0: number
  /** Initial eccentricity (0 ≤ e < 1). */
  e0: number
  /** Observer inclination in radians (0 = face-on, π/2 = edge-on). */
  inclination: number
  /** Luminosity distance used for the strain amplitude. */
  distance: number
  /** RK4 steps per orbital period (held roughly constant as the period shrinks). */
  stepsPerOrbit?: number
  /** Stop once the semi-major axis falls below this fraction of a0. */
  endFraction?: number
  /**
   * Stop once the orbital speed reaches this fraction of c — the edge of the
   * post-Newtonian regime, beyond which the 2.5PN reaction (and the quadrupole
   * waveform) are no longer trustworthy. The lab stops the inspiral here and
   * says so rather than extrapolating into the strong field.
   */
  vcMax?: number
  /** Hard cap on total integration steps. */
  maxSteps?: number
  /** Target number of points kept in the returned display arrays. */
  samples?: number
}

export interface InspiralResult {
  valid: boolean
  m1: number
  m2: number
  g: number
  c: number
  eta: number
  chirpMass: number
  inclination: number
  // Display tracks (downsampled to ~`samples` points).
  t: Float64Array
  hplus: Float64Array
  hcross: Float64Array
  /** Instantaneous GW frequency (= 2× orbital), over time. */
  fgw: Float64Array
  /** Slowly-varying semi-major axis from the orbital energy, over time. */
  aTrack: Float64Array
  /** Slowly-varying eccentricity from energy + angular momentum, over time. */
  eTrack: Float64Array
  /** The shrinking-orbit trajectory (relative separation) for the spiral plot. */
  trajX: Float64Array
  trajY: Float64Array
  // Scalars.
  a0: number
  e0: number
  aEnd: number
  /** Semi-major axis at which the integration actually stopped. */
  aStop: number
  /** Why the run ended: reached the target, hit the PN limit, or ran out of budget. */
  stopReason: 'merger' | 'pn-limit' | 'budget' | 'diverged'
  f0: number
  fEnd: number
  peakStrain: number
  /** Number of gravitational-wave cycles to the end of the run. */
  cycles: number
  /** Measured time for a to fall from a0 to aEnd. */
  mergerTimeMeasured: number
  /** Peters prediction for the same a0 → aEnd interval. */
  mergerTimePeters: number
  /** measured / Peters (→ 1 confirms the radiation reaction is calibrated). */
  ratioMergerTime: number
}

/**
 * Integrate the relative two-body orbit under Newtonian gravity plus the 2.5PN
 * radiation reaction, recording the inspiral and the gravitational waveform it
 * emits. The orbit starts at periapsis on the +x axis moving prograde. An
 * adaptive timestep keeps a fixed number of steps per (shrinking) orbital
 * period, so the chirp stays resolved as the frequency climbs.
 */
export function simulateInspiral(opts: InspiralOptions): InspiralResult {
  const { m1, m2, g, c, a0, e0, inclination, distance } = opts
  const stepsPerOrbit = Math.max(40, Math.floor(opts.stepsPerOrbit ?? 220))
  const endFraction = Math.min(0.5, Math.max(1e-3, opts.endFraction ?? 0.06))
  const vcMax = Math.min(0.9, Math.max(0.05, opts.vcMax ?? 0.35))
  const maxSteps = Math.max(1000, Math.floor(opts.maxSteps ?? 400_000))
  const samples = Math.max(64, Math.floor(opts.samples ?? 4000))

  const M = m1 + m2
  const mu = (m1 * m2) / M
  const gm = g * M
  const eta = mu / M
  const aEnd = a0 * endFraction

  const invalid: InspiralResult = {
    valid: false, m1, m2, g, c, eta, chirpMass: chirpMass(m1, m2), inclination,
    t: new Float64Array(0), hplus: new Float64Array(0), hcross: new Float64Array(0),
    fgw: new Float64Array(0), aTrack: new Float64Array(0), eTrack: new Float64Array(0),
    trajX: new Float64Array(0), trajY: new Float64Array(0),
    a0, e0, aEnd, aStop: NaN, stopReason: 'diverged',
    f0: 0, fEnd: 0, peakStrain: 0, cycles: 0,
    mergerTimeMeasured: NaN, mergerTimePeters: NaN, ratioMergerTime: NaN,
  }
  if (!(m1 > 0) || !(m2 > 0) || !(a0 > 0) || e0 < 0 || e0 >= 1 || !(c > 0) || !(distance > 0)) {
    return invalid
  }

  // Initial state at periapsis: r_p = a₀(1−e), v_p perpendicular and prograde.
  const rp = a0 * (1 - e0)
  const vp = Math.sqrt((gm / a0) * ((1 + e0) / (1 - e0)))
  let x = rp
  let y = 0
  let vx = 0
  let vy = vp

  // Total relative acceleration: Newtonian + radiation reaction.
  const accel = (px: number, py: number, pvx: number, pvy: number): [number, number] => {
    const r2 = px * px + py * py
    const r = Math.sqrt(r2)
    const inv = 1 / (r2 * r)
    let axx = -gm * px * inv
    let ayy = -gm * py * inv
    const [rx, ry] = radiationReactionAccel(px, py, pvx, pvy, M, mu, g, c)
    axx += rx
    ayy += ry
    return [axx, ayy]
  }

  // Semi-major axis & eccentricity from the *specific* state (per reduced mass):
  // ε = ½v² − GM/r,  h = x·vy − y·vx,  a = −GM/2ε,  e = √(1 + 2εh²/(GM)²).
  const elements = (px: number, py: number, pvx: number, pvy: number) => {
    const r = Math.hypot(px, py)
    const v2 = pvx * pvx + pvy * pvy
    const eps = 0.5 * v2 - gm / r
    const h = px * pvy - py * pvx
    const a = eps < 0 ? -gm / (2 * eps) : NaN
    const ecc = Math.sqrt(Math.max(0, 1 + (2 * eps * h * h) / (gm * gm)))
    return { a, e: ecc }
  }

  // Storage. We record every step (bounded by maxSteps) then downsample for the
  // returned display arrays — the scalars are computed from the full record.
  const cap = maxSteps + 2
  const sT = new Float64Array(cap)
  const sHp = new Float64Array(cap)
  const sHx = new Float64Array(cap)
  const sF = new Float64Array(cap)
  const sA = new Float64Array(cap)
  const sE = new Float64Array(cap)
  const sX = new Float64Array(cap)
  const sY = new Float64Array(cap)
  let n = 0

  const record = (time: number) => {
    const [hp, hx] = strainTT(x, y, vx, vy, mu, g, M, c, distance, inclination)
    const el = elements(x, y, vx, vy)
    const r = Math.hypot(x, y)
    // Instantaneous orbital frequency from the current separation (Kepler):
    // f_orb = (1/2π)√(GM/r³); the GW frequency is twice that.
    const forb = (1 / (2 * Math.PI)) * Math.sqrt(gm / (r * r * r))
    sT[n] = time
    sHp[n] = hp
    sHx[n] = hx
    sF[n] = 2 * forb
    sA[n] = el.a
    sE[n] = el.e
    sX[n] = x
    sY[n] = y
    n++
  }

  let time = 0
  record(0)

  // Accumulated GW phase (cycle count), the stopping time, the semi-major axis
  // at the stop, and why we stopped.
  let phase = 0
  let prevF = sF[0]
  let tEnd = NaN
  let aStop = NaN
  let stopReason: 'merger' | 'pn-limit' | 'budget' | 'diverged' = 'budget'

  let steps = 0
  for (; steps < maxSteps; steps++) {
    const r = Math.hypot(x, y)
    const omega = Math.sqrt(gm / (r * r * r)) // orbital angular frequency
    const period = (2 * Math.PI) / omega
    const dt = period / stepsPerOrbit

    // --- RK4 on (position, velocity) with the velocity-dependent acceleration ---
    const [a1x, a1y] = accel(x, y, vx, vy)
    const k1px = vx, k1py = vy, k1vx = a1x, k1vy = a1y
    const hh = dt * 0.5
    const [a2x, a2y] = accel(x + k1px * hh, y + k1py * hh, vx + k1vx * hh, vy + k1vy * hh)
    const k2px = vx + k1vx * hh, k2py = vy + k1vy * hh, k2vx = a2x, k2vy = a2y
    const [a3x, a3y] = accel(x + k2px * hh, y + k2py * hh, vx + k2vx * hh, vy + k2vy * hh)
    const k3px = vx + k2vx * hh, k3py = vy + k2vy * hh, k3vx = a3x, k3vy = a3y
    const [a4x, a4y] = accel(x + k3px * dt, y + k3py * dt, vx + k3vx * dt, vy + k3vy * dt)
    const k4px = vx + k3vx * dt, k4py = vy + k3vy * dt, k4vx = a4x, k4vy = a4y
    const sixth = dt / 6
    x += sixth * (k1px + 2 * k2px + 2 * k3px + k4px)
    y += sixth * (k1py + 2 * k2py + 2 * k3py + k4py)
    vx += sixth * (k1vx + 2 * k2vx + 2 * k3vx + k4vx)
    vy += sixth * (k1vy + 2 * k2vy + 2 * k3vy + k4vy)
    time += dt

    if (n < cap) record(time)
    // Trapezoidal integration of the GW phase: f is in cycles per unit time.
    phase += 0.5 * (prevF + sF[n - 1]) * dt
    prevF = sF[n - 1]

    const aNow = sA[n - 1]
    // Bail out if the orbit unbinds or blows up numerically.
    if (!Number.isFinite(aNow) || !Number.isFinite(x) || !Number.isFinite(y)) {
      stopReason = 'diverged'
      break
    }
    // Current orbital speed as a fraction of c.
    const vc = Math.hypot(vx, vy) / c
    if (aNow <= aEnd) {
      tEnd = time
      aStop = aNow
      stopReason = 'merger'
      break
    }
    if (vc >= vcMax) {
      tEnd = time
      aStop = aNow
      stopReason = 'pn-limit'
      break
    }
  }

  if (n < 4) return invalid

  // If we exhausted the step budget without stopping, treat the current state as
  // the (partial-inspiral) stopping point — the comparison is still valid.
  if (!Number.isFinite(aStop) && stopReason === 'budget') {
    aStop = sA[n - 1]
    tEnd = time
  }
  const reached = Number.isFinite(aStop) && aStop < a0
  const mergerTimeMeasured = Number.isFinite(tEnd) ? tEnd : time
  // Peters prediction for the same a0 → aStop interval (eccentricity-aware).
  const mergerTimePeters = reached ? petersInspiralTime(g, c, m1, m2, a0, e0, aStop) : NaN
  const ratioMergerTime =
    reached && mergerTimePeters > 0 ? mergerTimeMeasured / mergerTimePeters : NaN

  // Peak |h₊| over the run (for amplitude normalisation in the plot).
  let peak = 0
  for (let i = 0; i < n; i++) {
    const a = Math.abs(sHp[i])
    if (a > peak) peak = a
  }

  // Downsample the full record to ~`samples` evenly-spaced points for display.
  const stride = Math.max(1, Math.floor(n / samples))
  const m = Math.floor((n - 1) / stride) + 1
  const dT = new Float64Array(m)
  const dHp = new Float64Array(m)
  const dHx = new Float64Array(m)
  const dF = new Float64Array(m)
  const dA = new Float64Array(m)
  const dE = new Float64Array(m)
  const dX = new Float64Array(m)
  const dY = new Float64Array(m)
  for (let i = 0, j = 0; j < m && i < n; i += stride, j++) {
    dT[j] = sT[i]
    dHp[j] = sHp[i]
    dHx[j] = sHx[i]
    dF[j] = sF[i]
    dA[j] = sA[i]
    dE[j] = sE[i]
    dX[j] = sX[i]
    dY[j] = sY[i]
  }

  return {
    valid: true,
    m1, m2, g, c, eta, chirpMass: chirpMass(m1, m2), inclination,
    t: dT, hplus: dHp, hcross: dHx, fgw: dF, aTrack: dA, eTrack: dE, trajX: dX, trajY: dY,
    a0, e0, aEnd, aStop, stopReason,
    f0: sF[0], fEnd: sF[n - 1], peakStrain: peak,
    cycles: phase, // ∫ f_gw dt = number of GW cycles
    mergerTimeMeasured, mergerTimePeters, ratioMergerTime,
  }
}

/**
 * The Peters (1964) prediction for the time an inspiral takes to shrink from
 * (a0, e0) down to semi-major axis `aEnd`, by integrating the coupled da/dt,
 * de/dt ODEs with an adaptive RK4 (step ∝ a/|ȧ|). For a circular orbit this
 * reduces to the closed form 5c⁵(a0⁴−aEnd⁴)/(256 G³m₁m₂M); for an eccentric one
 * it accounts for the eccentricity enhancement of the radiated power. This is the
 * oracle the integrated radiation-reaction inspiral is checked against.
 */
export function petersInspiralTime(
  g: number,
  c: number,
  m1: number,
  m2: number,
  a0: number,
  e0: number,
  aEnd: number,
): number {
  if (!(a0 > aEnd) || aEnd <= 0) return 0
  let a = a0
  let e = Math.max(0, Math.min(0.999, e0))
  let t = 0
  let guard = 0
  while (a > aEnd && guard++ < 2_000_000) {
    const r1 = petersRates(g, c, m1, m2, a, e)
    if (!(r1.dadt < 0)) break
    // Adaptive step: a small fraction of the current shrink timescale a/|ȧ|.
    let dt = (0.002 * a) / -r1.dadt
    if (a + dt * r1.dadt < aEnd) dt = (aEnd - a) / r1.dadt // land exactly on aEnd
    const r2 = petersRates(g, c, m1, m2, a + 0.5 * dt * r1.dadt, e + 0.5 * dt * r1.dedt)
    const r3 = petersRates(g, c, m1, m2, a + 0.5 * dt * r2.dadt, e + 0.5 * dt * r2.dedt)
    const r4 = petersRates(g, c, m1, m2, a + dt * r3.dadt, e + dt * r3.dedt)
    a += (dt / 6) * (r1.dadt + 2 * r2.dadt + 2 * r3.dadt + r4.dadt)
    e += (dt / 6) * (r1.dedt + 2 * r2.dedt + 2 * r3.dedt + r4.dedt)
    if (e < 0) e = 0
    t += dt
  }
  return t
}

/**
 * Integrate the Peters (1964) coupled equations da/dt, de/dt from (a0, e0) for a
 * given duration, returning the final (a, e). A small RK4 used by the self-test
 * to check that the full radiation-reaction inspiral circularises at the
 * predicted rate. Independent of `simulateInspiral` (different physics route).
 */
export function integratePeters(
  g: number,
  c: number,
  m1: number,
  m2: number,
  a0: number,
  e0: number,
  duration: number,
  steps = 4000,
): { a: number; e: number } {
  let a = a0
  let e = e0
  const dt = duration / steps
  for (let i = 0; i < steps && a > 0; i++) {
    const r1 = petersRates(g, c, m1, m2, a, e)
    const r2 = petersRates(g, c, m1, m2, a + 0.5 * dt * r1.dadt, e + 0.5 * dt * r1.dedt)
    const r3 = petersRates(g, c, m1, m2, a + 0.5 * dt * r2.dadt, e + 0.5 * dt * r2.dedt)
    const r4 = petersRates(g, c, m1, m2, a + dt * r3.dadt, e + dt * r3.dedt)
    a += (dt / 6) * (r1.dadt + 2 * r2.dadt + 2 * r3.dadt + r4.dadt)
    e += (dt / 6) * (r1.dedt + 2 * r2.dedt + 2 * r3.dedt + r4.dedt)
    if (e < 0) e = 0
  }
  return { a, e }
}
