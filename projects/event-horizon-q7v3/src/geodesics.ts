// CPU photon-geodesic integration used by the 2D Geodesic Explorer.
//
// Same physics as the shader, restricted to a plane: a photon starts far to the left moving in
// +x with impact parameter b (its y offset). Angular momentum L = x·vy − y·vx is conserved, and
// the acceleration is the radial a⃗ = -1.5·L²·r⃗ / r⁵ (rs = 1). We integrate with RK4 until the
// photon either escapes the field or crosses the horizon at r = 1.

export type Fate = 'escaped' | 'captured'

export interface Geodesic {
  b: number
  points: Float32Array // interleaved x,y
  count: number
  fate: Fate
  /** Net deflection angle in radians (final heading − initial heading), only meaningful if escaped. */
  deflection: number
}

interface TraceOpts {
  startX?: number
  escapeR?: number
  maxSteps?: number
  baseStep?: number
}

export function traceGeodesic(b: number, opts: TraceOpts = {}): Geodesic {
  const startX = opts.startX ?? -22
  const escapeR = opts.escapeR ?? 24
  const maxSteps = opts.maxSteps ?? 4000
  const baseStep = opts.baseStep ?? 0.08

  let x = startX
  let y = b
  let vx = 1
  let vy = 0

  const Lz = x * vy - y * vx
  const h2 = Lz * Lz

  const pts: number[] = [x, y]
  let fate: Fate = 'escaped'

  const accel = (px: number, py: number): [number, number] => {
    const r2 = Math.max(px * px + py * py, 0.09)
    const k = (-1.5 * h2) / (r2 * r2 * Math.sqrt(r2))
    return [k * px, k * py]
  }

  for (let i = 0; i < maxSteps; i++) {
    const r = Math.hypot(x, y)
    if (r < 1.0) {
      fate = 'captured'
      break
    }
    if (r > escapeR && x * vx + y * vy > 0) break

    const dt = baseStep * (0.4 + 0.22 * r)

    const [a1x, a1y] = accel(x, y)
    const p2x = x + 0.5 * dt * vx, p2y = y + 0.5 * dt * vy
    const v2x = vx + 0.5 * dt * a1x, v2y = vy + 0.5 * dt * a1y
    const [a2x, a2y] = accel(p2x, p2y)
    const p3x = x + 0.5 * dt * v2x, p3y = y + 0.5 * dt * v2y
    const v3x = vx + 0.5 * dt * a2x, v3y = vy + 0.5 * dt * a2y
    const [a3x, a3y] = accel(p3x, p3y)
    const p4x = x + dt * v3x, p4y = y + dt * v3y
    const v4x = vx + dt * a3x, v4y = vy + dt * a3y
    const [a4x, a4y] = accel(p4x, p4y)

    x += (dt / 6) * (vx + 2 * v2x + 2 * v3x + v4x)
    y += (dt / 6) * (vy + 2 * v2y + 2 * v3y + v4y)
    vx += (dt / 6) * (a1x + 2 * a2x + 2 * a3x + a4x)
    vy += (dt / 6) * (a1y + 2 * a2y + 2 * a3y + a4y)

    pts.push(x, y)
  }

  const deflection = fate === 'escaped' ? Math.atan2(vy, vx) : NaN
  return {
    b,
    points: Float32Array.from(pts),
    count: pts.length / 2,
    fate,
    deflection,
  }
}

/** A fan of photons across a range of impact parameters, for the explorer's default scene. */
export function traceFan(count: number, maxB: number): Geodesic[] {
  const out: Geodesic[] = []
  for (let i = 0; i < count; i++) {
    // symmetric fan skipping exactly zero (head-on) to avoid a degenerate straight line
    const frac = (i + 0.5) / count
    const b = (frac * 2 - 1) * maxB
    out.push(traceGeodesic(b))
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Equatorial Kerr geodesics for the explorer. We integrate the same Hamiltonian the 3D renderer
// uses, reduced to the equatorial plane (θ = π/2, p_θ = 0), so the frame dragging is exact: photons
// on the prograde side (swept along with the spin) and the retrograde side deflect by different
// amounts, and the whole fan is dragged around the hole. Spin `a` is in rs units (a = a*·M).

const MASS = 0.5

/** World ⇄ equatorial Boyer–Lindquist. World radius ρ = √(r²+a²); r is the BL radius. */
function worldToBLeq(x: number, y: number, a: number): [number, number] {
  const rho2 = x * x + y * y
  const r = Math.sqrt(Math.max(rho2 - a * a, 1e-6))
  return [r, Math.atan2(y, x)]
}
function blToWorldEq(r: number, phi: number, a: number): [number, number] {
  const rho = Math.sqrt(r * r + a * a)
  return [rho * Math.cos(phi), rho * Math.sin(phi)]
}

export function traceGeodesicKerr(b: number, spinAM: number, chargeM = 0, opts: TraceOpts = {}): Geodesic {
  const a = Math.min(Math.max(spinAM, 0), 0.9995) * MASS
  const q2 = Math.pow(Math.max(chargeM, 0) * MASS, 2) // electric charge² (Kerr–Newman)
  const startX = opts.startX ?? -22
  const escapeR = opts.escapeR ?? 24
  const maxSteps = opts.maxSteps ?? 5000
  const baseStep = opts.baseStep ?? 0.06
  const rplus = MASS + Math.sqrt(Math.max(MASS * MASS - a * a - q2, 0))

  // initial conditions from a photon coming in along +x with impact parameter b
  let [r, phi] = worldToBLeq(startX, b, a)
  const eps = 1e-4
  const [r1, phi1] = worldToBLeq(startX + eps, b, a) // step along +x
  let dphi0 = phi1 - phi
  dphi0 -= 2 * Math.PI * Math.floor((dphi0 + Math.PI) / (2 * Math.PI))
  const prCon = (r1 - r) / eps
  const pphCon = dphi0 / eps

  // covariant equatorial metric at the start (far away → nearly flat)
  const cov = (rr: number) => {
    const Delta = rr * rr - 2 * MASS * rr + a * a + q2
    const MR = 2 * MASS * rr - q2 // Kerr–Newman mass function
    return {
      gtt: -(1 - MR / (rr * rr)),
      gtp: (-MR * a) / (rr * rr),
      grr: (rr * rr) / Delta,
      gpp: rr * rr + a * a + (MR * a * a) / (rr * rr),
      Delta,
    }
  }
  const c0 = cov(r)
  const spatial = c0.grr * prCon * prCon + c0.gpp * pphCon * pphCon
  const bq = 2 * c0.gtp * pphCon
  const disc = Math.sqrt(Math.max(bq * bq - 4 * c0.gtt * spatial, 0))
  const ptCon = Math.max((-bq + disc) / (2 * c0.gtt), (-bq - disc) / (2 * c0.gtt))
  const E = -(c0.gtt * ptCon + c0.gtp * pphCon)
  const L = c0.gtp * ptCon + c0.gpp * pphCon
  let pr = c0.grr * prCon

  // inverse equatorial metric contraction 2H(r) at fixed pr (for the p_r force via finite diff)
  const twoH = (rr: number, prr: number): number => {
    const Delta = rr * rr - 2 * MASS * rr + a * a + q2
    const MR = 2 * MASS * rr - q2
    const A = (rr * rr + a * a) * (rr * rr + a * a) - a * a * Delta
    const gtt = -A / (rr * rr * Delta)
    const gtp = (-MR * a) / (rr * rr * Delta)
    const grr = Delta / (rr * rr)
    const gpp = (Delta - a * a) / (rr * rr * Delta)
    return gtt * E * E - 2 * gtp * E * L + grr * prr * prr + gpp * L * L
  }
  const invMetric = (rr: number) => {
    const Delta = rr * rr - 2 * MASS * rr + a * a + q2
    const MR = 2 * MASS * rr - q2
    const gtp = (-MR * a) / (rr * rr * Delta)
    const grr = Delta / (rr * rr)
    const gpp = (Delta - a * a) / (rr * rr * Delta)
    return { gtp, grr, gpp }
  }

  const deriv = (rr: number, prr: number): [number, number, number] => {
    const m = invMetric(rr)
    const dr = m.grr * prr
    const dphi = -m.gtp * E + m.gpp * L
    const h = 1e-3
    const dpr = -0.5 * (twoH(rr + h, prr) - twoH(rr - h, prr)) / (2 * h)
    return [dr, dphi, dpr]
  }

  const [x0, y0] = blToWorldEq(r, phi, a)
  const pts: number[] = [x0, y0]
  let fate: Fate = 'escaped'
  let px = x0
  let py = y0

  for (let i = 0; i < maxSteps; i++) {
    if (r < rplus + 0.03 * rplus) {
      fate = 'captured'
      break
    }
    if (r > escapeR && pr > 0) break

    const prox = Math.min(Math.max((r - rplus) * 1.6, 0.12), 1)
    const dt = baseStep * (0.4 + 0.22 * r) * prox

    const [d1r, d1p, d1pr] = deriv(r, pr)
    const [d2r, d2p, d2pr] = deriv(r + 0.5 * dt * d1r, pr + 0.5 * dt * d1pr)
    const [d3r, d3p, d3pr] = deriv(r + 0.5 * dt * d2r, pr + 0.5 * dt * d2pr)
    const [d4r, d4p, d4pr] = deriv(r + dt * d3r, pr + dt * d3pr)

    r += (dt / 6) * (d1r + 2 * d2r + 2 * d3r + d4r)
    phi += (dt / 6) * (d1p + 2 * d2p + 2 * d3p + d4p)
    pr += (dt / 6) * (d1pr + 2 * d2pr + 2 * d3pr + d4pr)

    const [wx, wy] = blToWorldEq(r, phi, a)
    pts.push(wx, wy)
    px = wx
    py = wy
  }

  // net heading for escaped rays (from the final segment)
  const n = pts.length
  const deflection = fate === 'escaped' && n >= 4 ? Math.atan2(py - pts[n - 4], px - pts[n - 3]) : NaN
  return { b, points: Float32Array.from(pts), count: pts.length / 2, fate, deflection }
}

/** A fan of Kerr–Newman photons across a range of impact parameters. */
export function traceFanKerr(count: number, maxB: number, spinAM: number, chargeM = 0): Geodesic[] {
  const out: Geodesic[] = []
  for (let i = 0; i < count; i++) {
    const frac = (i + 0.5) / count
    const b = (frac * 2 - 1) * maxB
    out.push(traceGeodesicKerr(b, spinAM, chargeM))
  }
  return out
}
