// CPU ports of the exact geodesic integrators the GPU renderer runs, so the shader's physics can
// be *verified* — not just eyeballed. These are line-for-line the same equations of motion that
// live in gl/shaders.ts (Schwarzschild reduced-Cartesian and the full Kerr Hamiltonian); running
// them on the CPU lets us measure conserved quantities, bisect capture boundaries and reproduce
// closed-form GR results to machine tolerances.
//
// Units: rs = 1, so M = 0.5 (matches the shader's `MASS`).

import { M } from '../state'
import { horizons } from './kerr'

const PI = Math.PI

// ============================================================ Schwarzschild (reduced Cartesian)

export interface SchwPhoton {
  captured: boolean
  /** Total light-bending angle (rad), accumulated continuously so it can exceed 2π near b_crit. */
  deflection: number
}

/**
 * Trace a single Schwarzschild photon that comes in from the left (−x) moving +x with impact
 * parameter b (its y-offset). Same acceleration a⃗ = −1.5·|L|²·r⃗/r⁵ (rs = 1) the shader uses,
 * marched with the identical RK4 scheme — but from far away and with a fine step, so the recovered
 * bending angle matches the analytic weak-field 4M/b and diverges logarithmically as b → b_crit.
 */
export function tracePhotonSchw(
  b: number,
  opts: { startX?: number; escapeR?: number; steps?: number; baseStep?: number } = {},
): SchwPhoton {
  const startX = opts.startX ?? -800
  const escapeR = opts.escapeR ?? 820
  const steps = opts.steps ?? 200000
  const baseStep = opts.baseStep ?? 0.02

  let x = startX
  let y = b
  let vx = 1
  let vy = 0
  const Lz = x * vy - y * vx
  const h2 = Lz * Lz

  const accel = (px: number, py: number): [number, number] => {
    const r2 = Math.max(px * px + py * py, 0.09)
    const k = (-1.5 * h2) / (r2 * r2 * Math.sqrt(r2))
    return [k * px, k * py]
  }

  let heading = 0
  let prev = 0
  let captured = false
  for (let i = 0; i < steps; i++) {
    const r = Math.hypot(x, y)
    if (r < 1.0) {
      captured = true
      break
    }
    if (r > escapeR && x * vx + y * vy > 0) break

    const dt = baseStep * (0.4 + 0.22 * r)
    const [a1x, a1y] = accel(x, y)
    const v2x = vx + 0.5 * dt * a1x
    const v2y = vy + 0.5 * dt * a1y
    const [a2x, a2y] = accel(x + 0.5 * dt * vx, y + 0.5 * dt * vy)
    const v3x = vx + 0.5 * dt * a2x
    const v3y = vy + 0.5 * dt * a2y
    const [a3x, a3y] = accel(x + 0.5 * dt * v2x, y + 0.5 * dt * v2y)
    const v4x = vx + dt * a3x
    const v4y = vy + dt * a3y
    const [a4x, a4y] = accel(x + dt * v3x, y + dt * v3y)

    x += (dt / 6) * (vx + 2 * v2x + 2 * v3x + v4x)
    y += (dt / 6) * (vy + 2 * v2y + 2 * v3y + v4y)
    vx += (dt / 6) * (a1x + 2 * a2x + 2 * a3x + a4x)
    vy += (dt / 6) * (a1y + 2 * a2y + 2 * a3y + a4y)

    const hd = Math.atan2(vy, vx)
    let d = hd - prev
    d -= 2 * PI * Math.floor((d + PI) / (2 * PI)) // unwrap into (−π, π]
    heading += d
    prev = hd
  }
  // A photon coming in along +x is bent toward the hole; report the magnitude of the total turn.
  return { captured, deflection: captured ? NaN : -heading }
}

/**
 * Critical impact parameter b_crit for Schwarzschild, found by bisecting the capture boundary with
 * the real integrator above. Converges to the closed-form 3√3·M without ever being told it.
 */
export function bisectSchwCritical(): number {
  let lo = 2.0 // captured
  let hi = 3.2 // escapes
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi)
    if (tracePhotonSchw(mid, { steps: 120000, baseStep: 0.03 }).captured) lo = mid
    else hi = mid
  }
  return 0.5 * (lo + hi)
}

// ============================================================ Kerr (full Hamiltonian, 3-D)

interface KerrInv {
  gtt: number
  gtp: number
  grr: number
  gthth: number
  gpp: number
}

function kerrInv(r: number, th: number, a: number): KerrInv {
  const a2 = a * a
  const ct = Math.cos(th)
  const st = Math.max(Math.sin(th), 2e-2)
  const s2 = st * st
  const Sig = r * r + a2 * ct * ct
  const Del = r * r - 2 * M * r + a2
  const A = (r * r + a2) * (r * r + a2) - a2 * Del * s2
  return {
    gtt: -A / (Sig * Del),
    gtp: (-2 * M * a * r) / (Sig * Del),
    grr: Del / Sig,
    gthth: 1 / Sig,
    gpp: (Del - a2 * s2) / (Sig * Del * s2),
  }
}

function kerrCov(r: number, th: number, a: number): KerrInv {
  const a2 = a * a
  const ct = Math.cos(th)
  const st = Math.max(Math.sin(th), 2e-2)
  const s2 = st * st
  const Sig = r * r + a2 * ct * ct
  const Del = r * r - 2 * M * r + a2
  return {
    gtt: -(1 - (2 * M * r) / Sig),
    gtp: (-2 * M * r * a * s2) / Sig,
    grr: Sig / Del,
    gthth: Sig,
    gpp: (r * r + a2 + (2 * M * r * a2 * s2) / Sig) * s2,
  }
}

/** The null Hamiltonian value 2H = gᵘᵛ p_u p_v (p_t = −E, p_φ = L). Exactly 0 on a null geodesic. */
export function nullValue(r: number, th: number, pr: number, pth: number, E: number, L: number, a: number): number {
  const g = kerrInv(r, th, a)
  return g.gtt * E * E - 2 * g.gtp * E * L + g.grr * pr * pr + g.gthth * pth * pth + g.gpp * L * L
}

/** Carter's constant Q for a null geodesic — the third integral of motion (beyond E and L). */
export function carterConstant(th: number, pth: number, E: number, L: number, a: number): number {
  const ct = Math.cos(th)
  const st = Math.max(Math.sin(th), 1e-9)
  return pth * pth + ct * ct * ((L * L) / (st * st) - a * a * E * E)
}

interface KerrDeriv {
  dr: number
  dth: number
  dphi: number
  dpr: number
  dpth: number
}

function kerrDeriv(r: number, th: number, pr: number, pth: number, E: number, L: number, a: number): KerrDeriv {
  const g = kerrInv(r, th, a)
  const dr = g.grr * pr
  const dth = g.gthth * pth
  const dphi = -g.gtp * E + g.gpp * L
  const h = 1e-3
  const dpr = -0.25 * (nullValue(r + h, th, pr, pth, E, L, a) - nullValue(r - h, th, pr, pth, E, L, a)) / h
  const dpth = -0.25 * (nullValue(r, th + h, pr, pth, E, L, a) - nullValue(r, th - h, pr, pth, E, L, a)) / h
  return { dr, dth, dphi, dpr, dpth }
}

type Vec3 = [number, number, number]

function worldToBL(p: Vec3, a: number): { r: number; th: number; ph: number } {
  const a2 = a * a
  const R2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2]
  const r2 = 0.5 * (R2 - a2 + Math.sqrt(Math.max((R2 - a2) * (R2 - a2) + 4 * a2 * p[1] * p[1], 0)))
  const r = Math.sqrt(Math.max(r2, 1e-8))
  return { r, th: Math.acos(Math.min(Math.max(p[1] / r, -1), 1)), ph: Math.atan2(p[2], p[0]) }
}

export interface KerrState {
  r: number
  th: number
  ph: number
  pr: number
  pth: number
  E: number
  L: number
}

/**
 * Initialise a backwards-traced Kerr photon from a world-space camera position and ray direction,
 * exactly as the shader's traceKerr does: finite-difference the world ray into BL coordinate
 * velocities, lower them with the covariant metric, and solve the null condition for the
 * future-pointing p_t to read off the conserved E and L.
 */
export function initKerrPhoton(camPos: Vec3, dir: Vec3, a: number): KerrState {
  const b0 = worldToBL(camPos, a)
  const eps = 1e-3
  const b1 = worldToBL([camPos[0] + eps * dir[0], camPos[1] + eps * dir[1], camPos[2] + eps * dir[2]], a)
  let dph = b1.ph - b0.ph
  dph -= 2 * PI * Math.floor((dph + PI) / (2 * PI))
  const prCon = (b1.r - b0.r) / eps
  const pthCon = (b1.th - b0.th) / eps
  const pphCon = dph / eps

  const c = kerrCov(b0.r, b0.th, a)
  const spatial = c.grr * prCon * prCon + c.gthth * pthCon * pthCon + c.gpp * pphCon * pphCon
  const bq = 2 * c.gtp * pphCon
  const disc = Math.sqrt(Math.max(bq * bq - 4 * c.gtt * spatial, 0))
  const ptCon = Math.max((-bq + disc) / (2 * c.gtt), (-bq - disc) / (2 * c.gtt))
  const E = -(c.gtt * ptCon + c.gtp * pphCon)
  const L = c.gtp * ptCon + c.gpp * pphCon
  return { r: b0.r, th: b0.th, ph: b0.ph, pr: c.grr * prCon, pth: c.gthth * pthCon, E, L }
}

export interface KerrTrace {
  captured: boolean
  /** Largest fractional drift of Carter's constant Q along the path (0 = perfectly conserved). */
  maxCarterDrift: number
  /** Largest absolute value of the null Hamiltonian 2H along the path (0 = exactly null). */
  maxNull: number
}

/**
 * Integrate a Kerr photon with the exact RK4 Hamiltonian scheme from the shader, tracking how well
 * Carter's constant and the null condition are conserved — a stringent proof that the integrator
 * follows a genuine null geodesic.
 */
export function traceKerr3D(
  init: KerrState,
  a: number,
  opts: { steps?: number; stepSize?: number; escapeR?: number } = {},
): KerrTrace {
  const steps = opts.steps ?? 4000
  const stepSize = opts.stepSize ?? 0.12
  const escapeR = opts.escapeR ?? 60
  let { r, th, pr, pth } = init
  const { E, L } = init
  const { rPlus } = horizons(a)

  const Q0 = carterConstant(th, pth, E, L, a)
  const Qmag = Math.max(Math.abs(Q0), 1e-3)
  let maxCarterDrift = 0
  let maxNull = Math.abs(nullValue(r, th, pr, pth, E, L, a))
  let captured = false

  for (let i = 0; i < steps; i++) {
    if (r < rPlus + 0.06 * rPlus) {
      captured = true
      break
    }
    if (r > escapeR && pr > 0) break

    const prox = Math.min(Math.max((r - rPlus) * 1.6, 0.12), 1)
    const dt = stepSize * (0.35 + 0.22 * r) * prox

    const k1 = kerrDeriv(r, th, pr, pth, E, L, a)
    const k2 = kerrDeriv(r + 0.5 * dt * k1.dr, th + 0.5 * dt * k1.dth, pr + 0.5 * dt * k1.dpr, pth + 0.5 * dt * k1.dpth, E, L, a)
    const k3 = kerrDeriv(r + 0.5 * dt * k2.dr, th + 0.5 * dt * k2.dth, pr + 0.5 * dt * k2.dpr, pth + 0.5 * dt * k2.dpth, E, L, a)
    const k4 = kerrDeriv(r + dt * k3.dr, th + dt * k3.dth, pr + dt * k3.dpr, pth + dt * k3.dpth, E, L, a)

    r += (dt / 6) * (k1.dr + 2 * k2.dr + 2 * k3.dr + k4.dr)
    th += (dt / 6) * (k1.dth + 2 * k2.dth + 2 * k3.dth + k4.dth)
    pr += (dt / 6) * (k1.dpr + 2 * k2.dpr + 2 * k3.dpr + k4.dpr)
    pth += (dt / 6) * (k1.dpth + 2 * k2.dpth + 2 * k3.dpth + k4.dpth)

    // Reflect at the poles (θ ∈ [0, π]); φ would flip by π, but Carter's constant and the null
    // condition are φ-independent, so we don't carry the azimuth in this conservation-only tracer.
    if (th < 0) {
      th = -th
      pth = -pth
    } else if (th > PI) {
      th = 2 * PI - th
      pth = -pth
    }

    maxCarterDrift = Math.max(maxCarterDrift, Math.abs(carterConstant(th, pth, E, L, a) - Q0) / Qmag)
    maxNull = Math.max(maxNull, Math.abs(nullValue(r, th, pr, pth, E, L, a)))
  }
  return { captured, maxCarterDrift, maxNull }
}

// ============================================================ Kerr (equatorial, 2-D)
// A lean capture-only equatorial Kerr tracer (θ = π/2, p_θ = 0) used to bisect the prograde and
// retrograde shadow edges from real integrated geodesics — the same reduced Hamiltonian the
// Geodesic Explorer draws, but without retaining the path.

function traceEquatorialKerrCaptured(b: number, a: number): boolean {
  const startX = -22
  const escapeR = 24
  const maxSteps = 6000
  const baseStep = 0.05
  const rplus = M + Math.sqrt(Math.max(M * M - a * a, 0))

  const w2bl = (x: number, y: number): [number, number] => [Math.sqrt(Math.max(x * x + y * y - a * a, 1e-6)), Math.atan2(y, x)]
  const bl0 = w2bl(startX, b)
  let r = bl0[0]
  const phi = bl0[1]
  const eps = 1e-4
  const [r1] = w2bl(startX + eps, b)
  const [, phiB] = w2bl(startX + eps, b)
  let dphi0 = phiB - phi
  dphi0 -= 2 * PI * Math.floor((dphi0 + PI) / (2 * PI))
  const prCon = (r1 - r) / eps
  const pphCon = dphi0 / eps

  const cov = (rr: number) => {
    const D = rr * rr - 2 * M * rr + a * a
    return { gtt: -(1 - (2 * M) / rr), gtp: (-2 * M * a) / rr, grr: (rr * rr) / D, gpp: rr * rr + a * a + (2 * M * a * a) / rr }
  }
  const c0 = cov(r)
  const spatial = c0.grr * prCon * prCon + c0.gpp * pphCon * pphCon
  const bq = 2 * c0.gtp * pphCon
  const disc = Math.sqrt(Math.max(bq * bq - 4 * c0.gtt * spatial, 0))
  const ptCon = Math.max((-bq + disc) / (2 * c0.gtt), (-bq - disc) / (2 * c0.gtt))
  const E = -(c0.gtt * ptCon + c0.gtp * pphCon)
  const L = c0.gtp * ptCon + c0.gpp * pphCon
  let pr = c0.grr * prCon

  const twoH = (rr: number, prr: number): number => {
    const D = rr * rr - 2 * M * rr + a * a
    const A = (rr * rr + a * a) ** 2 - a * a * D
    const gtt = -A / (rr * rr * D)
    const gtp = (-2 * M * a) / (rr * D)
    const grr = D / (rr * rr)
    const gpp = (D - a * a) / (rr * rr * D)
    return gtt * E * E - 2 * gtp * E * L + grr * prr * prr + gpp * L * L
  }
  const der = (rr: number, prr: number): [number, number] => {
    const D = rr * rr - 2 * M * rr + a * a
    const grr = D / (rr * rr)
    const h = 1e-3
    return [grr * prr, -0.5 * (twoH(rr + h, prr) - twoH(rr - h, prr)) / (2 * h)]
  }

  for (let i = 0; i < maxSteps; i++) {
    if (r < rplus + 0.03 * rplus) return true
    if (r > escapeR && pr > 0) return false
    const prox = Math.min(Math.max((r - rplus) * 1.6, 0.12), 1)
    const dt = baseStep * (0.4 + 0.22 * r) * prox
    const [a1r, a1p] = der(r, pr)
    const [a2r, a2p] = der(r + 0.5 * dt * a1r, pr + 0.5 * dt * a1p)
    const [a3r, a3p] = der(r + 0.5 * dt * a2r, pr + 0.5 * dt * a2p)
    const [a4r, a4p] = der(r + dt * a3r, pr + dt * a3p)
    r += (dt / 6) * (a1r + 2 * a2r + 2 * a3r + a4r)
    pr += (dt / 6) * (a1p + 2 * a2p + 2 * a3p + a4p)
  }
  return false
}

/**
 * Bisect the two equatorial capture edges of the shadow (|b| for the positive- and negative-offset
 * incoming photons) from real integrated Kerr geodesics. Returned as magnitudes, ascending — to be
 * matched against the analytic |ξ| at the prograde/retrograde light rings.
 */
export function bisectEquatorialShadowEdges(aStar: number): [number, number] {
  const a = Math.min(Math.max(aStar, 0), 0.9995) * M
  const edge = (sign: number): number => {
    let lo = sign * 1.0 // near the hole → captured
    let hi = sign * 6.0 // far → escapes
    for (let i = 0; i < 46; i++) {
      const mid = 0.5 * (lo + hi)
      if (traceEquatorialKerrCaptured(mid, a)) lo = mid
      else hi = mid
    }
    return Math.abs(hi)
  }
  const a0 = edge(1)
  const a1 = edge(-1)
  return a0 <= a1 ? [a0, a1] : [a1, a0]
}
