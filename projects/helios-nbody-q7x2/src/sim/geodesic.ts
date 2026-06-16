// Strong-field general relativity: exact geodesics of the Schwarzschild (and the
// analytic shadow of the Kerr) metric.
//
// Everything else relativistic in Helios is *weak field*: the 1PN perihelion
// precession (relativity.ts) and the 2.5PN inspiral (gravwave.ts) are
// post-Newtonian expansions valid only for v/c ≪ 1, far outside any horizon.
// This module goes to the strong field — but honestly, by integrating the EXACT
// geodesics of the Schwarzschild metric rather than expanding them. For light in
// a plane the geodesic equation collapses to a single, beautifully simple ODE in
// the inverse radius u = 1/r:
//
//     d²u/dφ² = −u + 3 M u²        (null geodesic; G = c = 1)
//
// The lone nonlinear term 3M u² is general relativity: drop it and you recover
// Newton's straight line u'' = −u. Keep it and light bends, orbits precess, and a
// photon sphere appears at r = 3M. From this one equation fall the photon sphere,
// the critical impact parameter b_c = 3√3 M that sets the apparent size of a
// black hole's shadow, the Einstein deflection 4M/b and its strong-field
// logarithmic divergence, and — integrated per pixel — the lensed image of a
// black hole itself.
//
// Geometric units throughout: G = c = 1, lengths measured in the mass M (so the
// horizon is at r = 2M, the photon sphere at 3M, the ISCO at 6M). Pure functions,
// reused by the Black-Hole Lab and the self-test, so every claim is checkable.

// --- Closed-form landmarks of the Schwarzschild geometry ---------------------

/** Schwarzschild (horizon) radius r_s = 2M. */
export const horizonRadius = (M = 1) => 2 * M
/** Photon sphere — the radius of the unstable circular light orbit, r = 3M. */
export const photonSphereRadius = (M = 1) => 3 * M
/** Innermost stable circular orbit for massive particles, r = 6M. */
export const iscoRadius = (M = 1) => 6 * M
/** Marginally bound circular orbit (the E = 1 orbit), r = 4M. */
export const marginallyBoundRadius = (M = 1) => 4 * M
/**
 * Critical impact parameter b_c = 3√3 M. A photon aimed with b < b_c is captured;
 * b > b_c escapes; b = b_c asymptotes onto the photon sphere. For a distant
 * observer the black hole's shadow is a disc of apparent radius b_c.
 */
export const criticalImpactParameter = (M = 1) => 3 * Math.sqrt(3) * M

/**
 * The squared specific angular momentum of a *massive* circular orbit at radius
 * r: L²(r) = M r² / (r − 3M). Two landmarks fall straight out of this one curve:
 * it diverges at r = 3M (no massive circular orbit can sit on the photon sphere)
 * and it has a minimum at r = 6M (the ISCO — inside it no stable circular orbit
 * exists). The self-test recovers both from this function numerically.
 */
export function circularAngularMomentumSq(r: number, M = 1): number {
  const d = r - 3 * M
  if (d <= 0) return Infinity
  return (M * r * r) / d
}

// --- Light deflection: integrate the exact null orbit equation ----------------

export interface DeflectionResult {
  /** Whether the photon was captured by the black hole. */
  captured: boolean
  /** Total deflection α = (azimuth swept) − π, radians (NaN if captured). */
  deflection: number
  /** Closest approach radius reached (the periapsis), in the same units as b. */
  rMin: number
  /** Azimuth swept from launch to escape (radians). */
  phiSwept: number
}

/**
 * Trace a photon launched from infinity with impact parameter `b` past a mass `M`
 * and measure how far it bends. We integrate the exact orbit equation
 * u'' = −u + 3M u² by RK4 in the azimuth φ, starting from u ≈ 0 (r → ∞) with the
 * straight-line slope u'(0) = 1/b. The photon climbs to a periapsis (u maximal),
 * then either falls through the horizon (u → 1/2M ⇒ captured) or returns to
 * infinity; the azimuth swept minus π is the deflection. For M = 0 this returns 0
 * exactly (a straight line), and for large b it tends to the Einstein value 4M/b.
 */
export function deflectionAngle(b: number, M = 1, opts: { dPhi?: number; maxPhi?: number } = {}): DeflectionResult {
  const dPhi = opts.dPhi ?? 2e-4
  const maxPhi = opts.maxPhi ?? 20 * Math.PI
  const uH = 1 / (2 * M) // horizon
  const f = (u: number) => -u + 3 * M * u * u

  // Start effectively at infinity. u0 must be ≪ 1/b; a small finite value keeps
  // the slope well defined. The straight-line launch has u'(0) = 1/b.
  let u = 1e-9
  let w = 1 / b
  let phi = 0
  let rMin = Infinity
  let prevW = w

  while (phi < maxPhi) {
    // RK4 on (u, w), w = du/dφ.
    const k1u = w, k1w = f(u)
    const k2u = w + 0.5 * dPhi * k1w, k2w = f(u + 0.5 * dPhi * k1u)
    const k3u = w + 0.5 * dPhi * k2w, k3w = f(u + 0.5 * dPhi * k2u)
    const k4u = w + dPhi * k3w, k4w = f(u + dPhi * k3u)
    u += (dPhi / 6) * (k1u + 2 * k2u + 2 * k3u + k4u)
    w += (dPhi / 6) * (k1w + 2 * k2w + 2 * k3w + k4w)
    phi += dPhi

    if (u > 0) rMin = Math.min(rMin, 1 / u)
    if (u >= uH) {
      return { captured: true, deflection: NaN, rMin: 1 / u, phiSwept: phi }
    }
    // Escaped: u has turned around (w < 0) and fallen back to ~0.
    if (prevW > 0 && w <= 0) {
      // passed periapsis; keep going until u returns to near zero
    }
    if (w < 0 && u <= 1e-9) {
      return { captured: false, deflection: phi - Math.PI, rMin, phiSwept: phi }
    }
    prevW = w
  }
  // Wound many times without resolving — effectively on the photon sphere.
  return { captured: true, deflection: NaN, rMin, phiSwept: phi }
}

/**
 * The Bozza (2002) strong-deflection limit: as b → b_c⁺ the Schwarzschild
 * deflection diverges as α(b) ≈ −ā·ln(b/b_c − 1) + b̄, with ā = 1 and
 * b̄ = ln[216(7 − 4√3)] − π for Schwarzschild. Returned for the self-test to
 * compare the integrated α against.
 */
export function bozzaStrongDeflection(b: number, M = 1): number {
  const bc = criticalImpactParameter(M)
  const bBar = Math.log(216 * (7 - 4 * Math.sqrt(3))) - Math.PI
  return -Math.log(b / bc - 1) + bBar
}

/**
 * The exact precession of a *near-circular* timelike orbit at radius r: per
 * revolution the periapsis advances by 2π(1/√(1 − 6M/r) − 1). It reduces to the
 * 1PN value 6πM/r far out and diverges at the ISCO r = 6M (where stable circular
 * orbits cease). This is the strong-field generalisation of relativity.ts's
 * weak-field formula.
 */
export function circularPrecessionPerOrbit(r: number, M = 1): number {
  const x = 1 - (6 * M) / r
  if (x <= 0) return Infinity
  return 2 * Math.PI * (1 / Math.sqrt(x) - 1)
}

/**
 * Measure the periapsis precession of a near-circular timelike orbit at radius
 * `rc` by integrating the exact orbit equation u'' = −u + M/h² + 3M u² (with h
 * fixed by the circular condition) and timing the azimuth between successive
 * radial minima. Independent of `circularPrecessionPerOrbit`, so the self-test
 * can confirm that closed form numerically.
 */
export function integrateCircularPrecession(rc: number, M = 1, eps = 1e-3): number {
  const uc = 1 / rc
  const Mh2 = uc - 3 * M * uc * uc // = M/h² from the circular condition u''=0
  if (Mh2 <= 0) return NaN
  const f = (u: number) => -u + Mh2 + 3 * M * u * u
  let u = uc * (1 + eps) // start just inside periapsis (u maximal, w = 0)
  let w = 0
  let phi = 0
  const dPhi = 5e-4
  const peaks: number[] = [0] // φ at successive radial minima (u maxima)
  let prevW = w
  while (phi < 200 * Math.PI && peaks.length < 6) {
    const k1u = w, k1w = f(u)
    const k2u = w + 0.5 * dPhi * k1w, k2w = f(u + 0.5 * dPhi * k1u)
    const k3u = w + 0.5 * dPhi * k2w, k3w = f(u + 0.5 * dPhi * k2u)
    const k4u = w + dPhi * k3w, k4w = f(u + dPhi * k3u)
    u += (dPhi / 6) * (k1u + 2 * k2u + 2 * k3u + k4u)
    w += (dPhi / 6) * (k1w + 2 * k2w + 2 * k3w + k4w)
    phi += dPhi
    if (prevW > 0 && w <= 0 && phi > dPhi) {
      const frac = prevW / (prevW - w)
      peaks.push(phi - dPhi * (1 - frac))
    }
    prevW = w
  }
  if (peaks.length < 2) return NaN
  let sum = 0
  for (let i = 1; i < peaks.length; i++) sum += peaks[i] - peaks[i - 1]
  const perOrbit = sum / (peaks.length - 1)
  return perOrbit - 2 * Math.PI
}

// --- Accretion-disk redshift --------------------------------------------------

/**
 * The frequency-shift factor g = ν_observed / ν_emitted for light emitted by gas
 * on a circular Keplerian geodesic at radius r and received by a static observer
 * at infinity. Combining the gravitational redshift with the relativistic Doppler
 * of the orbiting matter gives, exactly,
 *
 *     g = √(1 − 3M/r) / (1 − Ω · ℓ),      Ω = √(M/r³),
 *
 * where ℓ = L_z/E is the photon's specific angular momentum about the disc's
 * rotation axis (positive when the photon co-rotates with the gas). The √(1−3M/r)
 * is the circular-orbit time-dilation factor; the (1 − Ωℓ) is the Doppler term
 * that beams the approaching side. Bolometric surface brightness transforms as
 * I_obs = g⁴ I_emit, which is what paints one side of the disc far brighter.
 */
export function diskRedshiftFactor(r: number, lzOverE: number, M = 1): number {
  const x = 1 - (3 * M) / r
  if (x <= 0) return 0
  const omega = Math.sqrt(M / (r * r * r))
  const denom = 1 - omega * lzOverE
  if (denom <= 0) return 0
  return Math.sqrt(x) / denom
}

// --- The Kerr (rotating) black hole's shadow, in closed form ------------------
//
// A rotating black hole's shadow is not a circle — it is a D-shape, flattened on
// the side where space is dragged toward the observer. The boundary is traced by
// the *unstable spherical photon orbits*, whose conserved quantities ξ = L_z/E and
// η = Q/E² are known in closed form (Bardeen 1973; Teo 2003), here with M = 1 and
// r, a in units of M:
//
//     ξ(r) = [r²(3 − r) − a²(r + 1)] / [a(r − 1)]
//     η(r) = [r³(4a² − r(r − 3)²)] / [a²(r − 1)²]
//
// An observer at inclination i sees the rim at celestial coordinates
//     α = −ξ / sin i,   β = ±√(η + a²cos²i − ξ²cot²i).
// As a → 0 this collapses onto the Schwarzschild circle of radius b_c = 3√3 M.

/**
 * Bardeen's equatorial photon-orbit radii for spin a (0 ≤ a ≤ M):
 * r = 2M{1 + cos[⅔ arccos(∓a/M)]}. The minus sign gives the prograde orbit
 * (r → M as a → M), the plus sign the retrograde orbit (r → 4M as a → M); both
 * give 3M at a = 0.
 */
export function kerrEquatorialPhotonRadius(a: number, M = 1, prograde = true): number {
  const s = prograde ? -1 : 1
  return 2 * M * (1 + Math.cos((2 / 3) * Math.acos((s * a) / M)))
}

export interface KerrShadowResult {
  /** Rim points in the observer's sky, in units of M: [α0,β0, α1,β1, …]. */
  rim: Float64Array
  /** Horizontal extent (max α − min α). */
  widthAlpha: number
  /** Vertical extent (max β − min β). */
  heightBeta: number
  /** Centroid α of the rim — the frame-dragging displacement (0 for a = 0). */
  centroidAlpha: number
  /** Photon-orbit radius range [r_min, r_max] that traces the rim. */
  rRange: [number, number]
}

/**
 * Trace the Kerr shadow rim for spin `a` (in units of M) at observer inclination
 * `inclination` (radians; π/2 = equatorial view). Returns the boundary curve in
 * the observer's celestial plane plus a few shape descriptors. Robust for
 * 0 < a ≤ M; the a → 0 limit is better drawn as the exact b_c circle.
 */
export function kerrShadowRim(a: number, inclination: number, M = 1, samples = 400): KerrShadowResult {
  const aa = a / M // dimensionless spin
  const sinI = Math.sin(inclination)
  const cosI = Math.cos(inclination)
  const cot2 = sinI !== 0 ? (cosI * cosI) / (sinI * sinI) : 0

  const xi = (r: number) => (r * r * (3 - r) - aa * aa * (r + 1)) / (aa * (r - 1))
  const eta = (r: number) => (r * r * r * (4 * aa * aa - r * (r - 3) * (r - 3))) / (aa * aa * (r - 1) * (r - 1))
  const beta2 = (r: number) => eta(r) + aa * aa * cosI * cosI - xi(r) * xi(r) * cot2

  // The valid photon-orbit radii lie between the equatorial prograde and
  // retrograde radii; scan that bracket for β² ≥ 0.
  const rLo = kerrEquatorialPhotonRadius(aa, 1, true)
  const rHi = kerrEquatorialPhotonRadius(aa, 1, false)
  const top: number[] = []
  const bot: number[] = []
  let rMinUsed = Infinity
  let rMaxUsed = -Infinity
  let sumA = 0
  let nA = 0
  let minAlpha = Infinity
  let maxAlpha = -Infinity
  let minBeta = Infinity
  let maxBeta = -Infinity

  for (let i = 0; i <= samples; i++) {
    const r = rLo + ((rHi - rLo) * i) / samples
    const b2 = beta2(r)
    if (b2 < 0 || !Number.isFinite(b2)) continue
    const al = -xi(r) / (sinI || 1e-9)
    const be = Math.sqrt(b2)
    top.push(al, be)
    bot.push(al, -be)
    rMinUsed = Math.min(rMinUsed, r)
    rMaxUsed = Math.max(rMaxUsed, r)
    sumA += al
    nA++
    minAlpha = Math.min(minAlpha, al)
    maxAlpha = Math.max(maxAlpha, al)
    minBeta = Math.min(minBeta, -be)
    maxBeta = Math.max(maxBeta, be)
  }

  // Stitch a single closed loop: top edge forward, bottom edge backward.
  const rim = new Float64Array(top.length + bot.length)
  let p = 0
  for (let i = 0; i < top.length; i += 2) {
    rim[p++] = top[i]
    rim[p++] = top[i + 1]
  }
  for (let i = bot.length - 2; i >= 0; i -= 2) {
    rim[p++] = bot[i]
    rim[p++] = bot[i + 1]
  }

  return {
    rim: rim.subarray(0, p),
    widthAlpha: Number.isFinite(maxAlpha) ? maxAlpha - minAlpha : 0,
    heightBeta: Number.isFinite(maxBeta) ? maxBeta - minBeta : 0,
    centroidAlpha: nA > 0 ? sumA / nA : 0,
    rRange: [rMinUsed, rMaxUsed],
  }
}

// --- The reverse ray tracer: an image of a black hole -------------------------
//
// For each pixel we shoot a photon backward from the camera into the curved
// spacetime and integrate its exact null geodesic until it either (a) crosses the
// horizon — that pixel is black, part of the shadow; or (b) escapes to infinity —
// we read off the direction it came from and sample a procedural background sky,
// which is therefore gravitationally LENSED. Along the way we watch for crossings
// of the equatorial plane inside the disc annulus and add the disc's (optionally
// Doppler-beamed) emission. By spherical symmetry every photon stays in the plane
// spanned by the camera position and its initial direction, so the 3-D problem
// reduces to integrating the same u(φ) equation in that plane and reconstructing
// 3-D points from it.

export interface RayTraceConfig {
  M: number
  /** Observer distance from the hole, in units of M. */
  distance: number
  /** Vertical field of view, degrees. */
  fovDeg: number
  /** Observer inclination from the disc axis, radians (0 = face-on, π/2 = edge-on). */
  inclination: number
  width: number
  height: number
  showDisk: boolean
  /** Disc inner / outer radius in units of M. */
  diskInner: number
  diskOuter: number
  /** Apply the relativistic Doppler + gravitational redshift to the disc. */
  doppler: boolean
  /** Draw the lensed background sky grid. */
  showGrid: boolean
  /** Integration step in φ (radians) and the per-ray step budget. */
  dPhi: number
  maxSteps: number
}

export const DEFAULT_RAYTRACE: RayTraceConfig = {
  M: 1,
  distance: 30,
  fovDeg: 25,
  inclination: (80 * Math.PI) / 180,
  width: 260,
  height: 195,
  showDisk: true,
  diskInner: 6,
  diskOuter: 20,
  doppler: true,
  showGrid: true,
  dPhi: 0.01,
  maxSteps: 4000,
}

type V3 = [number, number, number]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a: V3): V3 => {
  const m = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / m, a[1] / m, a[2] / m]
}

/** A deterministic procedural celestial-sphere colour for a viewing direction. */
function backgroundColor(dx: number, dy: number, dz: number, showGrid: boolean, out: V3): void {
  // Spherical coordinates of the sky direction.
  const theta = Math.acos(Math.max(-1, Math.min(1, dz))) // 0..π from +z
  const phi = Math.atan2(dy, dx) // −π..π
  // A two-tone checkerboard in (θ, φ) makes the lensing unmistakable, with thin
  // grid lines and an occasional star. Smooth deep-space gradient underneath.
  const cell = 12 // degrees
  const tDeg = (theta * 180) / Math.PI
  const pDeg = (phi * 180) / Math.PI + 180
  const ti = Math.floor(tDeg / cell)
  const pi = Math.floor(pDeg / cell)
  const checker = (ti + pi) & 1
  // Base gradient: indigo at the poles → teal at the equator.
  const eq = Math.sin(theta)
  let r = 0.04 + 0.05 * (1 - eq)
  let g = 0.05 + 0.10 * eq
  let b = 0.10 + 0.18 * eq
  if (checker) {
    r *= 1.7
    g *= 1.5
    b *= 1.35
  }
  if (showGrid) {
    const tFrac = tDeg / cell - ti
    const pFrac = pDeg / cell - pi
    const line = Math.min(tFrac, 1 - tFrac, pFrac, 1 - pFrac)
    if (line < 0.03) {
      r += 0.18
      g += 0.28
      b += 0.34
    }
  }
  // A sparse starfield, hashed from the cell so it is stable under lensing.
  const h = Math.sin(ti * 127.1 + pi * 311.7) * 43758.5453
  const frac = h - Math.floor(h)
  if (frac > 0.985) {
    const s = 0.6 + 0.4 * (frac - 0.985) * 66
    r += s
    g += s
    b += s
  }
  out[0] = r
  out[1] = g
  out[2] = b
}

/** Map a redshift factor g to an additive emission colour (blue hot → red cold). */
function diskColor(g: number, emis: number, out: V3): void {
  // g > 1 (blueshifted, approaching) → white-blue; g < 1 (redshifted) → orange.
  const t = Math.max(0, Math.min(1, (g - 0.5) / 1.0))
  const r = 1.0
  const gg = 0.55 + 0.4 * t
  const b = 0.25 + 0.7 * t
  out[0] = r * emis
  out[1] = gg * emis
  out[2] = b * emis
}

/**
 * Render rows [row0, row1) of the black-hole image into an RGBA pixel buffer
 * (length width·height·4). Designed to be called band-by-band so the caller can
 * keep the UI responsive and show the image building progressively.
 */
export function renderBlackHoleBands(
  cfg: RayTraceConfig,
  pixels: Uint8ClampedArray,
  row0: number,
  row1: number,
): void {
  const { M, distance: D, width: W, height: H } = cfg
  const uH = 1 / (2 * M)
  const f = (u: number) => -u + 3 * M * u * u

  // Camera frame. Observer on the (x,z) plane at inclination i from the +z disc
  // axis; looking at the origin. worldUp = +z so the disc tips by i.
  const inc = cfg.inclination
  const obs: V3 = [Math.sin(inc) * D, 0, Math.cos(inc) * D]
  const fwd = norm([-obs[0], -obs[1], -obs[2]])
  const worldUp: V3 = [0, 0, 1]
  let right = cross(fwd, worldUp)
  if (Math.hypot(right[0], right[1], right[2]) < 1e-6) right = [1, 0, 0] // face-on
  right = norm(right)
  const up = norm(cross(right, fwd))

  const tanF = Math.tan((cfg.fovDeg * Math.PI) / 180 / 2)
  const aspect = W / H
  const e1Out: V3 = [0, 0, 0]
  const bg: V3 = [0, 0, 0]
  const dc: V3 = [0, 0, 0]
  const diskIn = cfg.diskInner * M
  const diskOut = cfg.diskOuter * M

  for (let py = row0; py < row1; py++) {
    // Normalised device coords; +y up.
    const ndcY = (1 - (2 * (py + 0.5)) / H) * tanF
    for (let px = 0; px < W; px++) {
      const ndcX = ((2 * (px + 0.5)) / W - 1) * tanF * aspect
      // Pixel ray direction.
      const dir = norm([
        fwd[0] + ndcX * right[0] + ndcY * up[0],
        fwd[1] + ndcX * right[1] + ndcY * up[1],
        fwd[2] + ndcX * right[2] + ndcY * up[2],
      ])

      // Angular-momentum vector L = obs × dir; its magnitude is the impact
      // parameter b, and its z-component over E is ℓ for the disc Doppler.
      const Lvec = cross(obs, dir)
      const lzOverE = Lvec[2]

      // In-plane orthonormal basis (e1 radial-out at observer, e2 along motion).
      const e1 = norm(obs)
      const Lhat = norm(Lvec)
      const e2 = norm(cross(Lhat, e1))

      // Initial conditions at the observer: u0 = 1/D, climbing inward. The slope
      // u'(0) = −u0 (d·e1)/(d·e2): negative dot with e1 (inward), positive e2.
      const de1 = dot(dir, e1)
      const de2 = dot(dir, e2)
      let u = 1 / D
      let w = de2 !== 0 ? (-u * de1) / de2 : 0
      let phi = 0

      // 3-D point at azimuth φ in the photon's plane.
      const zAt = (ph: number, uu: number): number => {
        const r = 1 / uu
        return r * (Math.cos(ph) * e1[2] + Math.sin(ph) * e2[2])
      }
      let prevZ = zAt(0, u)
      let prevU = u
      let prevPhi = 0

      bg[0] = 0; bg[1] = 0; bg[2] = 0
      let accR = 0, accG = 0, accB = 0
      let captured = false
      let diskHits = 0

      for (let s = 0; s < cfg.maxSteps; s++) {
        const dPhi = cfg.dPhi
        const k1u = w, k1w = f(u)
        const k2u = w + 0.5 * dPhi * k1w, k2w = f(u + 0.5 * dPhi * k1u)
        const k3u = w + 0.5 * dPhi * k2w, k3w = f(u + 0.5 * dPhi * k2u)
        const k4u = w + dPhi * k3w, k4w = f(u + dPhi * k3u)
        u += (dPhi / 6) * (k1u + 2 * k2u + 2 * k3u + k4u)
        w += (dPhi / 6) * (k1w + 2 * k2w + 2 * k3w + k4w)
        phi += dPhi

        if (u >= uH) { captured = true; break }

        // Equatorial-plane crossing for the disc (z changes sign).
        if (cfg.showDisk && diskHits < 4) {
          const z = zAt(phi, u)
          if ((prevZ < 0 && z >= 0) || (prevZ > 0 && z <= 0)) {
            // Interpolate the crossing radius.
            const t = prevZ / (prevZ - z)
            const uc = prevU + (u - prevU) * t
            const rc = 1 / uc
            if (rc >= diskIn && rc <= diskOut) {
              diskHits++
              // Emissivity profile ∝ (r_in/r)², brighter inner disc.
              let emis = 1.4 * (diskIn / rc) * (diskIn / rc)
              let g = 1
              if (cfg.doppler) {
                g = diskRedshiftFactor(rc, lzOverE, M)
                emis *= g * g * g * g // bolometric beaming I ∝ g⁴
              }
              diskColor(g, emis, dc)
              // Successive (lensed) crossings are dimmer secondary images.
              const atten = diskHits === 1 ? 1 : 0.55 / diskHits
              accR += dc[0] * atten
              accG += dc[1] * atten
              accB += dc[2] * atten
            }
          }
          prevZ = z
        }

        // Escaped back to infinity: read the outgoing direction off the sky.
        if (w < 0 && u <= 1 / D) {
          e1Out[0] = Math.cos(phi) * e1[0] + Math.sin(phi) * e2[0]
          e1Out[1] = Math.cos(phi) * e1[1] + Math.sin(phi) * e2[1]
          e1Out[2] = Math.cos(phi) * e1[2] + Math.sin(phi) * e2[2]
          backgroundColor(e1Out[0], e1Out[1], e1Out[2], cfg.showGrid, bg)
          break
        }
        prevU = u
        prevPhi = phi
      }
      void prevPhi

      let r = captured ? 0 : bg[0]
      let g = captured ? 0 : bg[1]
      let bl = captured ? 0 : bg[2]
      r += accR; g += accG; bl += accB

      // Tone map (Reinhard) and write.
      const idx = (py * W + px) * 4
      pixels[idx] = 255 * (r / (1 + r))
      pixels[idx + 1] = 255 * (g / (1 + g))
      pixels[idx + 2] = 255 * (bl / (1 + bl))
      pixels[idx + 3] = 255
    }
  }
}

/**
 * Find the apparent shadow radius by bisecting on the impact parameter: the
 * boundary between captured and escaping photons. Returns it in impact-parameter
 * units, which for any observer distance equals b_c = 3√3 M.
 */
export function shadowImpactParameter(M = 1): number {
  let lo = 0.1 * M
  let hi = 12 * M
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi)
    if (deflectionAngle(mid, M, { dPhi: 5e-4 }).captured) lo = mid
    else hi = mid
  }
  return 0.5 * (lo + hi)
}

/**
 * Apparent angular radius of the shadow seen by a *static* observer at coordinate
 * radius D: sin θ_sh = b_c √(1 − 2M/D) / D. (For D → ∞ the apparent size in
 * impact-parameter units is just b_c.)
 */
export function shadowAngularRadius(D: number, M = 1): number {
  const bc = criticalImpactParameter(M)
  const s = (bc * Math.sqrt(1 - (2 * M) / D)) / D
  return Math.asin(Math.max(-1, Math.min(1, s)))
}
