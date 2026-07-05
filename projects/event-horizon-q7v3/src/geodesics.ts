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
