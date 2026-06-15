// The circular restricted three-body problem (CR3BP).
//
// Given the two heaviest bodies — primaries of mass m1 ≥ m2 — this module solves
// the classic co-rotating-frame structure a massless test particle feels: the
// five Lagrange equilibrium points and the zero-velocity (Hill-region) curves of
// the Jacobi integral. Everything is computed in the dimensionless frame where
// the primaries sit a unit distance apart at (−μ, 0) and (1−μ, 0) with μ = m2/M,
// then mapped back into world coordinates along the live primary–primary axis, so
// the overlay rotates with the binary.
//
// In that frame the effective potential is
//   Ω(x, y) = ½(x² + y²) + (1−μ)/r₁ + μ/r₂,
// the collinear points L1–L3 are the on-axis roots of ∂Ω/∂x = 0 (found by
// bisection between the singularities), and the triangular points L4/L5 sit at
// the apices of the two equilateral triangles, (½−μ, ±√3/2). A zero-velocity
// curve at Jacobi constant C is the level set 2Ω = C; the separatrices through
// L1, L2 and L3 are the ones worth drawing.

export interface Lagrange {
  /** L1…L5 in world coordinates. */
  points: Array<[number, number]>
  /** Zero-velocity contour segments, flat [x0,y0,x1,y1,…] in world coordinates. */
  contours: Float64Array
  primary1: [number, number]
  primary2: [number, number]
  /** Mass ratio μ = m2/(m1+m2). */
  mu: number
  valid: boolean
}

/** Dimensionless effective potential Ω(x,y) for mass ratio μ. */
function omega(xn: number, yn: number, mu: number): number {
  const r1 = Math.hypot(xn + mu, yn)
  const r2 = Math.hypot(xn - (1 - mu), yn)
  const e = 1e-4
  return 0.5 * (xn * xn + yn * yn) + (1 - mu) / Math.max(r1, e) + mu / Math.max(r2, e)
}

/** ∂Ω/∂x along the x-axis (y = 0); its roots are the collinear Lagrange points. */
function dOmegaDx(x: number, mu: number): number {
  const a = x + mu // signed distance to m1
  const b = x - (1 - mu) // signed distance to m2
  const a3 = Math.abs(a) ** 3
  const b3 = Math.abs(b) ** 3
  return x - ((1 - mu) * a) / a3 - (mu * b) / b3
}

/**
 * Gradient of the dimensionless effective potential ∇Ω(x,y). The five Lagrange
 * points are exactly its zeros — exported so the self-test can confirm each
 * solved point is a genuine equilibrium of the co-rotating frame.
 */
export function omegaGradient(xn: number, yn: number, mu: number): [number, number] {
  const ax = xn + mu
  const bx = xn - (1 - mu)
  const r1 = Math.hypot(ax, yn)
  const r2 = Math.hypot(bx, yn)
  const r13 = r1 ** 3
  const r23 = r2 ** 3
  const gx = xn - ((1 - mu) * ax) / r13 - (mu * bx) / r23
  const gy = yn - ((1 - mu) * yn) / r13 - (mu * yn) / r23
  return [gx, gy]
}

/**
 * The five Lagrange points in the dimensionless co-rotating frame (primaries at
 * (−μ,0) and (1−μ,0)): collinear L1–L3 from bisecting ∂Ω/∂x, triangular L4/L5
 * at the equilateral apices. Shared by the overlay and the self-test.
 */
export function solveLagrangeNormalized(mu: number): Array<[number, number]> {
  const eps = 1e-4
  const l1 = bisectCollinear(-mu + eps, 1 - mu - eps, mu)
  const l2 = bisectCollinear(1 - mu + eps, 1 - mu + 3, mu)
  const l3 = bisectCollinear(-mu - 3, -mu - eps, mu)
  const SQRT3_2 = Math.sqrt(3) / 2
  return [
    [l1, 0],
    [l2, 0],
    [l3, 0],
    [0.5 - mu, SQRT3_2],
    [0.5 - mu, -SQRT3_2],
  ]
}

/** Bisect dΩ/dx for a root in (lo, hi); assumes a sign change across the bracket. */
function bisectCollinear(lo: number, hi: number, mu: number): number {
  let flo = dOmegaDx(lo, mu)
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi)
    const fmid = dOmegaDx(mid, mu)
    if (Math.abs(fmid) < 1e-12 || hi - lo < 1e-12) return mid
    if (Math.sign(fmid) === Math.sign(flo)) {
      lo = mid
      flo = fmid
    } else {
      hi = mid
    }
  }
  return 0.5 * (lo + hi)
}

/**
 * The Jacobi constant of a test particle in the co-rotating frame of two
 * primaries — the one integral of motion the restricted three-body problem
 * admits. In physical (un-normalized) units, with the binary's signed angular
 * velocity n, distance ρ from the barycentre and distances r₁, r₂ to the
 * primaries,
 *   C = n²ρ² + 2G(m₁/r₁ + m₂/r₂) − v_rot²,   v_rot = v − ω × r.
 * Every term here is frame- or sign-robust (ρ², r₁, r₂ are rotation-invariant
 * and the rotating-frame speed uses the *signed* n derived from the primaries'
 * own motion), so it is correct whether the binary spins clockwise or counter-
 * clockwise, without any reference-frame alignment. It is (approximately)
 * conserved along a particle's path so long as the primaries stay near-circular.
 */
export function jacobiConstant(
  m1: number,
  p1x: number,
  p1y: number,
  v1x: number,
  v1y: number,
  m2: number,
  p2x: number,
  p2y: number,
  v2x: number,
  v2y: number,
  g: number,
  bx: number,
  by: number,
  bvx: number,
  bvy: number,
): number | null {
  const M = m1 + m2
  const Rx = p2x - p1x
  const Ry = p2y - p1y
  const d2 = Rx * Rx + Ry * Ry
  if (!(M > 0) || !(d2 > 1e-12)) return null
  // Signed angular velocity of the binary from its own relative motion.
  const Vx = v2x - v1x
  const Vy = v2y - v1y
  const n = (Rx * Vy - Ry * Vx) / d2

  const baryX = (m1 * p1x + m2 * p2x) / M
  const baryY = (m1 * p1y + m2 * p2y) / M
  const rxb = bx - baryX
  const ryb = by - baryY
  const rho2 = rxb * rxb + ryb * ryb

  const r1 = Math.hypot(bx - p1x, by - p1y) || 1e-12
  const r2 = Math.hypot(bx - p2x, by - p2y) || 1e-12

  // Rotating-frame velocity: v − ω × r, with ω = n ẑ ⇒ ω × r = n(−ryb, rxb).
  const vrx = bvx + n * ryb
  const vry = bvy - n * rxb
  const vrot2 = vrx * vrx + vry * vry

  return n * n * rho2 + 2 * g * (m1 / r1 + m2 / r2) - vrot2
}

/**
 * Solve the restricted-three-body structure for the two heaviest bodies and
 * return it in world coordinates. `gridN` controls the zero-velocity contour
 * resolution; `gridHalf` is the half-extent of the contour grid in units of the
 * primary separation (≈1.7 captures all five Lagrange points).
 */
export function restrictedThreeBody(
  m1: number,
  p1x: number,
  p1y: number,
  m2: number,
  p2x: number,
  p2y: number,
  gridN = 110,
  gridHalf = 1.75,
): Lagrange {
  // Order so primary 1 is the heavier one.
  if (m2 > m1) {
    ;[m1, m2] = [m2, m1]
    ;[p1x, p2x] = [p2x, p1x]
    ;[p1y, p2y] = [p2y, p1y]
  }
  const M = m1 + m2
  const dx = p2x - p1x
  const dy = p2y - p1y
  const d = Math.hypot(dx, dy)
  const empty: Lagrange = {
    points: [],
    contours: new Float64Array(0),
    primary1: [p1x, p1y],
    primary2: [p2x, p2y],
    mu: 0,
    valid: false,
  }
  if (!(M > 0) || !(d > 1e-9)) return empty
  const mu = m2 / M

  // World mapping: barycentre + d·(xn·û + yn·v̂).
  const ux = dx / d
  const uy = dy / d
  const vx = -uy
  const vy = ux
  const baryX = (m1 * p1x + m2 * p2x) / M
  const baryY = (m1 * p1y + m2 * p2y) / M
  const toWorld = (xn: number, yn: number): [number, number] => [
    baryX + d * (xn * ux + yn * vx),
    baryY + d * (xn * uy + yn * vy),
  ]

  // The five Lagrange points (normalized), then mapped into the world frame.
  const normPts = solveLagrangeNormalized(mu)
  const points: Array<[number, number]> = normPts.map(([xn, yn]) => toWorld(xn, yn))

  // Zero-velocity curves at the Jacobi separatrices through L1, L2, L3.
  const levels = [
    omega(normPts[0][0], 0, mu),
    omega(normPts[1][0], 0, mu),
    omega(normPts[2][0], 0, mu),
  ]
  const contours = marchingSquares(mu, gridN, gridHalf, levels, toWorld)

  return { points, contours, primary1: [p1x, p1y], primary2: [p2x, p2y], mu, valid: true }
}

/**
 * Extract zero-velocity contour segments at the given Ω levels via marching
 * squares over a normalized grid, mapping each vertex into world coordinates.
 * Returns a flat [x0,y0,x1,y1,…] segment list (world coords).
 */
function marchingSquares(
  mu: number,
  n: number,
  half: number,
  levels: number[],
  toWorld: (xn: number, yn: number) => [number, number],
): Float64Array {
  const coord = (i: number) => -half + (2 * half * i) / n
  // Pre-evaluate Ω on the (n+1)² grid once; reused for every level.
  const Z = new Float64Array((n + 1) * (n + 1))
  for (let j = 0; j <= n; j++) {
    const y = coord(j)
    for (let i = 0; i <= n; i++) {
      Z[j * (n + 1) + i] = omega(coord(i), y, mu)
    }
  }

  const out: number[] = []
  const MAX = 60000 // cap on emitted floats
  const stride = n + 1

  // Linear edge crossing between grid nodes a and b (in normalized coords).
  const cross = (
    xa: number,
    ya: number,
    va: number,
    xb: number,
    yb: number,
    vb: number,
    level: number,
  ): [number, number] => {
    const t = (level - va) / (vb - va || 1e-30)
    return [xa + (xb - xa) * t, ya + (yb - ya) * t]
  }

  for (const level of levels) {
    for (let j = 0; j < n && out.length < MAX; j++) {
      const y0 = coord(j)
      const y1 = coord(j + 1)
      for (let i = 0; i < n; i++) {
        const x0 = coord(i)
        const x1 = coord(i + 1)
        const v00 = Z[j * stride + i]
        const v10 = Z[j * stride + i + 1]
        const v11 = Z[(j + 1) * stride + i + 1]
        const v01 = Z[(j + 1) * stride + i]

        // Collect edge crossings (bottom, right, top, left).
        const cuts: Array<[number, number]> = []
        if (v00 < level !== v10 < level) cuts.push(cross(x0, y0, v00, x1, y0, v10, level))
        if (v10 < level !== v11 < level) cuts.push(cross(x1, y0, v10, x1, y1, v11, level))
        if (v01 < level !== v11 < level) cuts.push(cross(x0, y1, v01, x1, y1, v11, level))
        if (v00 < level !== v01 < level) cuts.push(cross(x0, y0, v00, x0, y1, v01, level))

        if (cuts.length === 2) {
          emit(out, toWorld, cuts[0], cuts[1])
        } else if (cuts.length === 4) {
          // Saddle: connect into two non-crossing segments.
          emit(out, toWorld, cuts[0], cuts[3])
          emit(out, toWorld, cuts[1], cuts[2])
        }
      }
    }
  }
  return new Float64Array(out)
}

function emit(
  out: number[],
  toWorld: (xn: number, yn: number) => [number, number],
  a: [number, number],
  b: [number, number],
): void {
  const wa = toWorld(a[0], a[1])
  const wb = toWorld(b[0], b[1])
  out.push(wa[0], wa[1], wb[0], wb[1])
}
