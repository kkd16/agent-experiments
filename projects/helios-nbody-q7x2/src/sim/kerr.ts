// Strong-field general relativity, the rotating case: the EXACT null geodesics of
// the KERR (spinning black hole) metric, integrated per pixel to render the one
// image everybody now knows — a black hole that drags space around with it.
//
// `geodesic.ts` ray-traces the Schwarzschild hole by collapsing its spherical
// symmetry to a single planar ODE u'' = −u + 3M u². A rotating hole has no such
// symmetry: the photon's plane precesses as frame-dragging twists it around the
// spin axis, so the 2-D trick fails. Instead we integrate the genuine 3-D
// geodesic. Kerr is, miraculously, still *integrable* — Carter (1968) found a
// fourth constant of motion beyond E, L_z and the mass — but rather than lean on
// the separated first-order equations (with their awkward turning-point sign
// bookkeeping) we integrate Hamilton's equations for the photon directly:
//
//     H = ½ gᵘᵛ pᵤ pᵥ = 0            (the null condition)
//     ẋᵘ = ∂H/∂pᵤ = gᵘᵛ pᵥ
//     ṗᵤ = −∂H/∂xᵘ = −½ (∂ᵤ gᵃᵇ) pₐ p_b
//
// Because the Kerr metric is independent of t and φ, E = −p_t and L_z = p_φ are
// conserved exactly (we never even evolve them); only (r, p_r, θ, p_θ) move. The
// contravariant metric is written out in closed form below; the two position
// derivatives that drive ṗ_r, ṗ_θ are taken by a careful central finite-difference
// of H — robust through the strong field, with no √R/√Θ sign flips — and that
// choice is pinned honest three ways: the null condition H ≈ 0 stays put, the
// hidden Carter constant Q stays put, and the ray-traced shadow lands exactly on
// the analytic Bardeen/Teo rim (see selftest.ts).
//
// Boyer–Lindquist coordinates, geometric units G = c = 1, lengths in the mass M.
// Spin a is in units of M, 0 ≤ a < M (a = M is the extremal limit).

// --- Closed-form landmarks of the Kerr geometry ------------------------------

/** Outer event horizon r₊ = M + √(M² − a²). (Real for |a| ≤ M.) */
export const kerrHorizonRadius = (a: number, M = 1) => M + Math.sqrt(Math.max(0, M * M - a * a))

/** Inner (Cauchy) horizon r₋ = M − √(M² − a²). */
export const kerrInnerHorizon = (a: number, M = 1) => M - Math.sqrt(Math.max(0, M * M - a * a))

/**
 * Outer boundary of the ergosphere at polar angle θ: r_E(θ) = M + √(M² − a²cos²θ).
 * Equals 2M at the equator (where it bulges farthest out) and meets the horizon at
 * the poles. Inside it no observer can stay still — space itself is dragged around.
 */
export const kerrErgosphere = (theta: number, a: number, M = 1) => {
  const c = Math.cos(theta)
  return M + Math.sqrt(Math.max(0, M * M - a * a * c * c))
}

/**
 * Angular velocity of the horizon, Ω_H = a / (r₊² + a²). The horizon rotates
 * rigidly at this rate; it sets the maximum energy extractable by the Penrose
 * process / Blandford–Znajek. Vanishes for a = 0; → 1/(2M) as a → M.
 */
export const kerrHorizonOmega = (a: number, M = 1) => {
  const rp = kerrHorizonRadius(a, M)
  return a / (rp * rp + a * a)
}

/**
 * Frame-dragging angular velocity ω(r,θ) = −g_tφ/g_φφ — the rate at which a
 * zero-angular-momentum observer (ZAMO/LNRF) is swept around the hole purely by
 * the dragging of inertial frames. Falls off as 2Ma/r³ far out; rises to Ω_H at
 * the horizon.
 */
export function frameDragOmega(r: number, theta: number, a: number, M = 1): number {
  const g = kerrMetricCo(r, theta, a, M)
  return g.gpp !== 0 ? -g.gtp / g.gpp : 0
}

/**
 * Innermost stable circular orbit (ISCO) for a massive particle on an equatorial
 * orbit, by the Bardeen–Press–Teukolsky (1972) closed form. Prograde orbits
 * (co-rotating with the hole) can get closer: r = 6M at a = 0, → M at a = M;
 * retrograde orbits → 9M at a = M. `prograde` picks the sign.
 */
export function kerrIscoRadius(a: number, M = 1, prograde = true): number {
  const a1 = a / M
  const Z1 = 1 + Math.cbrt(1 - a1 * a1) * (Math.cbrt(1 + a1) + Math.cbrt(1 - a1))
  const Z2 = Math.sqrt(3 * a1 * a1 + Z1 * Z1)
  const s = prograde ? -1 : 1
  return M * (3 + Z2 + s * Math.sqrt(Math.max(0, (3 - Z1) * (3 + Z1 + 2 * Z2))))
}

// --- The Kerr metric in Boyer–Lindquist coordinates --------------------------

export interface MetricComponents {
  gtt: number
  gtp: number // g_tφ
  gpp: number // g_φφ
  grr: number
  gthth: number
}

/** Covariant metric g_μν (the t,φ block plus the diagonal r,θ). */
export function kerrMetricCo(r: number, theta: number, a: number, M = 1): MetricComponents {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const s2 = s * s
  const Sigma = r * r + a * a * c * c
  const Delta = r * r - 2 * M * r + a * a
  return {
    gtt: -(1 - (2 * M * r) / Sigma),
    gtp: (-2 * M * a * r * s2) / Sigma,
    gpp: (r * r + a * a + (2 * M * a * a * r * s2) / Sigma) * s2,
    grr: Sigma / Delta,
    gthth: Sigma,
  }
}

/**
 * Contravariant metric gᵘᵛ (the inverse). The t,φ block inverts in closed form;
 * the r,θ part is diagonal. With Σ = r²+a²cos²θ, Δ = r²−2Mr+a², and the
 * Boyer–Lindquist function A = (r²+a²)² − a²Δsin²θ. We floor sin²θ to keep the
 * coordinate singularity on the spin axis (where φ is undefined) from poisoning a
 * ray that grazes the poles — a tiny, localised regularisation.
 */
export function kerrMetricContra(r: number, theta: number, a: number, M = 1): MetricComponents {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const s2 = Math.max(s * s, 1e-8)
  const Sigma = r * r + a * a * c * c
  const Delta = r * r - 2 * M * r + a * a
  const A = (r * r + a * a) * (r * r + a * a) - a * a * Delta * s2
  const SD = Sigma * Delta
  return {
    gtt: -A / SD,
    gtp: (-2 * M * a * r) / SD,
    gpp: (Delta - a * a * s2) / (SD * s2),
    grr: Delta / Sigma,
    gthth: 1 / Sigma,
  }
}

/** Twice the null Hamiltonian, 2H = gᵘᵛ pᵤ pᵥ — zero for a photon. */
export function hamiltonian2(
  r: number,
  theta: number,
  pt: number,
  pr: number,
  pth: number,
  pphi: number,
  a: number,
  M = 1,
): number {
  const g = kerrMetricContra(r, theta, a, M)
  return (
    g.gtt * pt * pt +
    2 * g.gtp * pt * pphi +
    g.gpp * pphi * pphi +
    g.grr * pr * pr +
    g.gthth * pth * pth
  )
}

/**
 * Carter's constant for a *null* geodesic, Q = p_θ² + cos²θ (L_z²/sin²θ − a²E²).
 * The fourth integral of motion that makes Kerr separable — *not* visible in the
 * Hamiltonian, so its constancy along an independently-stepped trajectory is the
 * sharpest possible check on the geodesic integrator.
 */
export function carterConstant(theta: number, pth: number, Lz: number, E: number, a: number): number {
  const c = Math.cos(theta)
  const s2 = Math.max(Math.sin(theta) * Math.sin(theta), 1e-12)
  return pth * pth + c * c * ((Lz * Lz) / s2 - a * a * E * E)
}

// --- The geodesic: Hamilton's equations --------------------------------------

/** Photon phase-space state in Boyer–Lindquist coordinates (t omitted — cyclic). */
export interface PhotonState {
  r: number
  theta: number
  phi: number
  pr: number
  pth: number
}

/**
 * Right-hand side of Hamilton's equations for a null geodesic, given the conserved
 * pt = −E and pphi = L_z. The position derivatives ṗ_r, ṗ_θ are −½ ∂H/∂x, taken by
 * a central finite-difference of 2H at fixed momenta (a relative step in r, an
 * absolute step in θ). Writes the five derivatives (ṙ, θ̇, φ̇, ṗ_r, ṗ_θ) into `out`.
 */
export function geodesicRHS(
  st: PhotonState,
  pt: number,
  pphi: number,
  a: number,
  M: number,
  out: Float64Array,
): void {
  const { r, theta, pr, pth } = st
  const g = kerrMetricContra(r, theta, a, M)
  out[0] = g.grr * pr // ṙ
  out[1] = g.gthth * pth // θ̇
  out[2] = g.gtp * pt + g.gpp * pphi // φ̇

  // ṗ_r = −½ ∂(2H)/∂r , central difference (relative step).
  const hr = 1e-6 * Math.max(1, Math.abs(r))
  const H2rp = hamiltonian2(r + hr, theta, pt, pr, pth, pphi, a, M)
  const H2rm = hamiltonian2(r - hr, theta, pt, pr, pth, pphi, a, M)
  out[3] = -0.5 * (H2rp - H2rm) / (2 * hr)

  // ṗ_θ = −½ ∂(2H)/∂θ , central difference (absolute step).
  const hth = 1e-6
  const H2tp = hamiltonian2(r, theta + hth, pt, pr, pth, pphi, a, M)
  const H2tm = hamiltonian2(r, theta - hth, pt, pr, pth, pphi, a, M)
  out[4] = -0.5 * (H2tp - H2tm) / (2 * hth)
}

/** One classical RK4 step of size dλ in the affine parameter. */
export function rk4Step(st: PhotonState, pt: number, pphi: number, a: number, M: number, dλ: number): void {
  const k1 = new Float64Array(5)
  const k2 = new Float64Array(5)
  const k3 = new Float64Array(5)
  const k4 = new Float64Array(5)
  const tmp: PhotonState = { ...st }

  geodesicRHS(st, pt, pphi, a, M, k1)
  tmp.r = st.r + 0.5 * dλ * k1[0]
  tmp.theta = st.theta + 0.5 * dλ * k1[1]
  tmp.pr = st.pr + 0.5 * dλ * k1[3]
  tmp.pth = st.pth + 0.5 * dλ * k1[4]
  geodesicRHS(tmp, pt, pphi, a, M, k2)
  tmp.r = st.r + 0.5 * dλ * k2[0]
  tmp.theta = st.theta + 0.5 * dλ * k2[1]
  tmp.pr = st.pr + 0.5 * dλ * k2[3]
  tmp.pth = st.pth + 0.5 * dλ * k2[4]
  geodesicRHS(tmp, pt, pphi, a, M, k3)
  tmp.r = st.r + dλ * k3[0]
  tmp.theta = st.theta + dλ * k3[1]
  tmp.pr = st.pr + dλ * k3[3]
  tmp.pth = st.pth + dλ * k3[4]
  geodesicRHS(tmp, pt, pphi, a, M, k4)

  st.r += (dλ / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0])
  st.theta += (dλ / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1])
  st.phi += (dλ / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2])
  st.pr += (dλ / 6) * (k1[3] + 2 * k2[3] + 2 * k3[3] + k4[3])
  st.pth += (dλ / 6) * (k1[4] + 2 * k2[4] + 2 * k3[4] + k4[4])
}

// --- Image plane: (α,β) → initial photon momenta (Bardeen 1973) ---------------

export interface RayInit {
  state: PhotonState
  pt: number
  pphi: number
  /** ξ = L_z/E, the photon's specific axial angular momentum (for disc Doppler). */
  xi: number
  /** Whether a valid ingoing photon could be launched (false if past the ring). */
  ok: boolean
}

/**
 * Build the initial photon state at the observer (r_obs, θ_obs = inclination) for a
 * pixel at celestial coordinates (α, β). We fix E = 1 (pt = −1); Bardeen's relations
 * give L_z = ξ = −α sin i and Q = η = β² + (α² − a²)cos²i, hence p_θ² = β² at the
 * observer; p_r is then fixed by the null condition H = 0, taken ingoing (p_r < 0)
 * so the ray is traced inward toward the hole.
 */
export function initRay(
  alpha: number,
  beta: number,
  rObs: number,
  inclination: number,
  a: number,
  M = 1,
): RayInit {
  const sinI = Math.sin(inclination)
  const cosI = Math.cos(inclination)
  const E = 1
  const pt = -E
  const xi = sinI !== 0 ? -alpha * sinI : 0
  const pphi = xi
  // p_θ² = β² exactly at the observer (Bardeen); sign sets vertical orientation.
  const pth = beta
  // p_r from H = 0: g_rr p_r² = −(g_tt pt² + 2 g_tφ pt pφ + g_φφ pφ² + g_θθ p_θ²).
  const g = kerrMetricContra(rObs, inclination, a, M)
  const rest = g.gtt * pt * pt + 2 * g.gtp * pt * pphi + g.gpp * pphi * pphi + g.gthth * pth * pth
  const pr2 = -rest / g.grr
  const ok = pr2 >= 0 && Number.isFinite(pr2)
  const pr = -Math.sqrt(Math.max(0, pr2))
  void cosI
  return { state: { r: rObs, theta: inclination, phi: 0, pr, pth }, pt, pphi, xi, ok }
}

// --- Disc redshift on a prograde circular Kerr orbit --------------------------

/**
 * The observed/emitted frequency ratio g for light from gas on a prograde circular
 * equatorial geodesic at radius r, received at infinity. With Ω = √M/(r^{3/2}+a√M)
 * the orbital angular velocity (Bardeen 1972) and ξ = L_z/E the photon's axial
 * angular momentum,
 *
 *     g = √(−(g_tt + 2Ω g_tφ + Ω² g_φφ)) / (1 − Ω ξ).
 *
 * The numerator is the orbiting emitter's time-dilation factor (1/u^t); the
 * denominator is the relativistic Doppler term that beams the approaching side.
 * As a → 0 this reduces *exactly* to geodesic.ts's √(1−3M/r)/(1−Ωℓ).
 */
export function diskRedshiftKerr(r: number, xi: number, a: number, M = 1): number {
  const gtt = -(1 - (2 * M) / r)
  const gtp = (-2 * M * a) / r
  const gpp = r * r + a * a + (2 * M * a * a) / r
  const Omega = Math.sqrt(M) / (Math.pow(r, 1.5) + a * Math.sqrt(M))
  const inside = -(gtt + 2 * Omega * gtp + Omega * Omega * gpp)
  if (inside <= 0) return 0
  const denom = 1 - Omega * xi
  if (denom <= 0) return 0
  return Math.sqrt(inside) / denom
}

// --- The reverse ray tracer ---------------------------------------------------

export type RayOutcome = 'captured' | 'escaped' | 'budget'

export interface RayResult {
  outcome: RayOutcome
  /** Sky direction (unit Cartesian) the photon escaped along (valid if escaped). */
  dir: [number, number, number]
  /** Accumulated disc emission [r,g,b] (linear, pre-tonemap). */
  disc: [number, number, number]
}

export interface KerrRayConfig {
  M: number
  a: number
  distance: number
  inclination: number
  diskInner: number
  diskOuter: number
  doppler: boolean
  /** Max RK4 steps before giving up (treated as captured — winding on the shell). */
  maxSteps: number
  /** Step-size control: fractional coordinate change per step. */
  stepFrac: number
}

const tmpRHS = new Float64Array(5)

/**
 * Trace one photon backward from the observer through the pixel (α, β). Integrates
 * the Kerr null geodesic until it crosses the horizon (captured), climbs back past
 * the observer radius (escaped — its asymptotic direction samples the sky), or
 * exhausts the step budget (winding on the photon shell → captured). Accumulates
 * equatorial-disc emission with the exact relativistic redshift along the way.
 */
export function kerrTraceRay(alpha: number, beta: number, cfg: KerrRayConfig): RayResult {
  const { M, a, distance: rObs, inclination, diskInner, diskOuter, doppler, maxSteps, stepFrac } = cfg
  const disc: [number, number, number] = [0, 0, 0]
  const dir: [number, number, number] = [0, 0, 0]
  const ray = initRay(alpha, beta, rObs, inclination, a, M)
  if (!ray.ok) return { outcome: 'captured', dir, disc }
  const st = ray.state
  const { pt, pphi, xi } = ray
  const rPlus = kerrHorizonRadius(a, M)
  const rCapture = rPlus * 1.0008 + 1e-3
  let prevCos = Math.cos(st.theta)
  let prevR = st.r
  let diskHits = 0

  for (let s = 0; s < maxSteps; s++) {
    // RHS at the current state to size the step (bound fractional coord change).
    geodesicRHS(st, pt, pphi, a, M, tmpRHS)
    const rate =
      Math.abs(tmpRHS[0]) / Math.max(1, st.r) + Math.abs(tmpRHS[1]) + Math.abs(tmpRHS[2]) + 1e-3
    const dλ = Math.min(2.0, Math.max(2e-3, stepFrac / rate))

    rk4Step(st, pt, pphi, a, M, dλ)

    // Captured: crossed the outer horizon.
    if (st.r <= rCapture) return { outcome: 'captured', dir, disc }

    // Equatorial-disc crossing (cos θ changes sign), interpolate the radius.
    const cos = Math.cos(st.theta)
    if (diskHits < 3 && ((prevCos < 0 && cos >= 0) || (prevCos > 0 && cos <= 0))) {
      const t = prevCos / (prevCos - cos)
      const rc = prevR + (st.r - prevR) * t
      if (rc >= diskInner && rc <= diskOuter) {
        diskHits++
        let emis = 1.5 * (diskInner / rc) * (diskInner / rc)
        let gshift = 1
        if (doppler) {
          gshift = diskRedshiftKerr(rc, xi, a, M)
          emis *= gshift * gshift * gshift * gshift
        }
        const atten = diskHits === 1 ? 1 : 0.5 / diskHits
        diskColor(gshift, emis * atten, disc)
      }
    }
    prevCos = cos

    // Escaped: climbed back out past the observer radius, heading outward.
    if (st.r > rObs && tmpRHS[0] > 0) {
      escapeDirection(st, tmpRHS, a, dir)
      return { outcome: 'escaped', dir, disc }
    }
    prevR = st.r
  }
  return { outcome: 'budget', dir, disc }
}

/** Cartesian direction of travel at escape (oblate r,θ,φ → x,y,z velocity). */
function escapeDirection(st: PhotonState, rhs: Float64Array, a: number, out: [number, number, number]): void {
  const { r, theta, phi } = st
  const dr = rhs[0]
  const dth = rhs[1]
  const dph = rhs[2]
  const R = Math.sqrt(r * r + a * a)
  const dR = R !== 0 ? (r * dr) / R : 0
  const st_ = Math.sin(theta)
  const ct = Math.cos(theta)
  const cp = Math.cos(phi)
  const sp = Math.sin(phi)
  const dx = dR * st_ * cp + R * ct * dth * cp - R * st_ * sp * dph
  const dy = dR * st_ * sp + R * ct * dth * sp + R * st_ * cp * dph
  const dz = dr * ct - r * st_ * dth
  const m = Math.hypot(dx, dy, dz) || 1
  out[0] = dx / m
  out[1] = dy / m
  out[2] = dz / m
}

/** Procedural lensed sky — a checkerboard + grid + sparse stars in (θ,φ). */
function backgroundColor(d: [number, number, number], showGrid: boolean, out: [number, number, number]): void {
  const theta = Math.acos(Math.max(-1, Math.min(1, d[2])))
  const phi = Math.atan2(d[1], d[0])
  const cell = 12
  const tDeg = (theta * 180) / Math.PI
  const pDeg = (phi * 180) / Math.PI + 180
  const ti = Math.floor(tDeg / cell)
  const pi = Math.floor(pDeg / cell)
  const checker = (ti + pi) & 1
  const eq = Math.sin(theta)
  let r = 0.04 + 0.05 * (1 - eq)
  let g = 0.05 + 0.1 * eq
  let b = 0.1 + 0.18 * eq
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
  const h = Math.sin(ti * 127.1 + pi * 311.7) * 43758.5453
  const frac = h - Math.floor(h)
  if (frac > 0.985) {
    const sstar = 0.6 + 0.4 * (frac - 0.985) * 66
    r += sstar
    g += sstar
    b += sstar
  }
  out[0] = r
  out[1] = g
  out[2] = b
}

/** Redshift factor g → additive disc emission colour (blue hot → red cold). */
function diskColor(g: number, emis: number, out: [number, number, number]): void {
  const t = Math.max(0, Math.min(1, (g - 0.5) / 1.0))
  out[0] += 1.0 * emis
  out[1] += (0.55 + 0.4 * t) * emis
  out[2] += (0.25 + 0.7 * t) * emis
}

export interface KerrRenderConfig extends KerrRayConfig {
  /** Half-width of the image plane in units of M (the celestial-coordinate frame). */
  halfExtentM: number
  width: number
  height: number
  showGrid: boolean
  showDisk: boolean
}

export const DEFAULT_KERR_RENDER: KerrRenderConfig = {
  M: 1,
  a: 0.9,
  distance: 30,
  halfExtentM: 9,
  inclination: (80 * Math.PI) / 180,
  width: 240,
  height: 180,
  diskInner: 0,
  diskOuter: 20,
  doppler: true,
  showGrid: true,
  showDisk: true,
  maxSteps: 6000,
  stepFrac: 0.05,
}

/**
 * Render rows [row0, row1) of the Kerr image into an RGBA buffer (band-by-band so
 * the caller can show the image building progressively). The screen spans ±(fov/2)
 * in celestial (α,β) units of M, mapped through `kerrTraceRay` per pixel.
 */
export function renderKerrBands(cfg: KerrRenderConfig, pixels: Uint8ClampedArray, row0: number, row1: number): void {
  const { width: W, height: H, halfExtentM } = cfg
  const aspect = W / H
  // Half-extent of the image plane in M (the celestial-coordinate frame).
  const half = halfExtentM
  const bg: [number, number, number] = [0, 0, 0]
  const diskInner = cfg.showDisk ? Math.max(cfg.diskInner, kerrIscoRadius(cfg.a, cfg.M, true)) : 1e9
  const traceCfg: KerrRayConfig = { ...cfg, diskInner }

  for (let py = row0; py < row1; py++) {
    const beta = (1 - (2 * (py + 0.5)) / H) * half
    for (let px = 0; px < W; px++) {
      const alpha = ((2 * (px + 0.5)) / W - 1) * half * aspect
      const res = kerrTraceRay(alpha, beta, traceCfg)
      let r = 0
      let g = 0
      let b = 0
      if (res.outcome === 'escaped') {
        backgroundColor(res.dir, cfg.showGrid, bg)
        r = bg[0]
        g = bg[1]
        b = bg[2]
      }
      r += res.disc[0]
      g += res.disc[1]
      b += res.disc[2]
      const idx = (py * W + px) * 4
      pixels[idx] = 255 * (r / (1 + r))
      pixels[idx + 1] = 255 * (g / (1 + g))
      pixels[idx + 2] = 255 * (b / (1 + b))
      pixels[idx + 3] = 255
    }
  }
}

/**
 * Find the apparent shadow edge along the β = 0 line by bisecting the ray tracer in
 * α between a known-captured α and a known-escaping α. The boundary between the two
 * is where the analytic Bardeen/Teo rim crosses β = 0. `side`: −1 scans the
 * negative-α (one edge), +1 the positive-α (the other) — at i = π/2 these are the
 * retrograde and prograde edges, displaced by frame dragging.
 */
export function kerrShadowAlphaAtBeta0(a: number, inclination: number, side: -1 | 1, M = 1): number {
  const cfg: KerrRayConfig = {
    M,
    a,
    distance: 1000,
    inclination,
    diskInner: 1e9,
    diskOuter: 0,
    doppler: false,
    maxSteps: 9000,
    stepFrac: 0.04,
  }
  const captured = (alpha: number) => kerrTraceRay(alpha, 0, cfg).outcome !== 'escaped'
  // Bracket: α = 0 (looking dead-centre) is captured; far out escapes.
  let inA = 0 // captured side
  let outA = side * 12 * M // escaping side
  // Make sure the bracket really straddles the boundary.
  if (!captured(inA)) return NaN
  let guard = 0
  while (captured(outA) && guard++ < 8) outA += side * 4 * M
  for (let i = 0; i < 50; i++) {
    const mid = 0.5 * (inA + outA)
    if (captured(mid)) inA = mid
    else outA = mid
  }
  return 0.5 * (inA + outA)
}
