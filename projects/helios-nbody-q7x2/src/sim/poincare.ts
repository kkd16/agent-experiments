// Poincaré surface-of-section for a test particle in the co-rotating frame of the
// two heaviest bodies (the restricted three-body problem).
//
// A continuous trajectory is hard to read; its *section* is not. We watch the
// particle in the frame that rotates with the binary — where the primaries sit
// still on the ξ-axis — and stamp a point every time it crosses the line η = 0
// moving upward (η̇ > 0), recording (ξ, ξ̇). The Poincaré–Birkhoff picture then
// reads straight off the scatter:
//
//   • a regular (quasi-periodic) orbit lives on an invariant torus, whose
//     intersection with the section is a smooth closed curve — the dots trace a
//     loop;
//   • a chaotic orbit is confined only by the Jacobi integral, so its dots
//     scatter to fill a two-dimensional patch of the section.
//
// The frame is built from the binary's *instantaneous* state: barycentre B,
// separation axis angle θ = atan2(Δy, Δx) and angular velocity ω = (Δr × Δv)/R².
// The particle's rotating-frame velocity uses the transport theorem
//   v_rot = R(−θ)·(v − v_B) − ω × r_rot,
// which is exact for a circular binary (R, ω constant) and an excellent
// approximation for the near-circular binaries these sections are drawn for. The
// single integral of motion the frame conserves — the Jacobi constant — is
// sampled at every crossing; its spread across the run is reported as an honest
// self-consistency check (it should be ≈ 0).

import { Simulation } from './Simulation'
import { jacobiConstant } from './restricted3body'

export interface RotatingState {
  xi: number
  eta: number
  xidot: number
  etadot: number
  omega: number
  R: number
}

/**
 * Map a test particle into the co-rotating, barycentre-centred frame of a binary
 * (m1 at r1/v1, m2 at r2/v2). World units are kept (no length normalisation), so
 * ξ is a true distance and ξ̇ a true speed in the rotating frame.
 */
export function toRotating(
  m1: number, r1x: number, r1y: number, v1x: number, v1y: number,
  m2: number, r2x: number, r2y: number, v2x: number, v2y: number,
  px: number, py: number, vx: number, vy: number,
): RotatingState {
  const M = m1 + m2
  const bx = (m1 * r1x + m2 * r2x) / M
  const by = (m1 * r1y + m2 * r2y) / M
  const bvx = (m1 * v1x + m2 * v2x) / M
  const bvy = (m1 * v1y + m2 * v2y) / M

  const dx = r2x - r1x
  const dy = r2y - r1y
  const R = Math.hypot(dx, dy) || 1e-12
  const dvx = v2x - v1x
  const dvy = v2y - v1y
  const omega = (dx * dvy - dy * dvx) / (R * R)

  const th = Math.atan2(dy, dx)
  const c = Math.cos(th)
  const s = Math.sin(th)

  // Position relative to the barycentre, rotated into the frame.
  const rx = px - bx
  const ry = py - by
  const xi = c * rx + s * ry
  const eta = -s * rx + c * ry

  // Velocity relative to the barycentre, rotated, minus the frame rotation ω×r.
  const ux = vx - bvx
  const uy = vy - bvy
  const rux = c * ux + s * uy
  const ruy = -s * ux + c * uy
  const xidot = rux + omega * eta
  const etadot = ruy - omega * xi

  return { xi, eta, xidot, etadot, omega, R }
}

/** Above this body count the shadow integration is too costly; the section is a
 *  few-body (restricted-3-body) tool anyway. */
export const POINCARE_BODY_LIMIT = 240

/** Total work budget (steps × bodies); the step count is trimmed to stay under it. */
const POINCARE_WORK_BUDGET = 45_000_000

export interface PoincareOptions {
  /** Stop after this many recorded crossings (default 600). */
  maxCrossings?: number
  /** Hard cap on shadow-integration steps (default 200000; also work-budget capped). */
  maxSteps?: number
}

export interface PoincareResult {
  /** Flat [ξ0, ξ̇0, ξ1, ξ̇1, …] of recorded crossings. */
  points: Float64Array
  /** Number of crossings recorded. */
  count: number
  /** Mean Jacobi constant over the crossings. */
  jacobiMean: number
  /** Relative spread (std/|mean|) of the Jacobi constant — a regularity/quality check. */
  jacobiSpread: number
  /** Steps actually integrated. */
  steps: number
  valid: boolean
}

/**
 * Integrate a shadow copy of the system and collect the Poincaré section of one
 * test particle in the co-rotating frame of the two heaviest bodies. The source
 * simulation is never touched; collisions are disabled in the shadow so body
 * indices (and the two primaries) stay fixed.
 */
export function poincareSection(src: Simulation, index: number, opts: PoincareOptions = {}): PoincareResult {
  const empty: PoincareResult = {
    points: new Float64Array(0), count: 0, jacobiMean: NaN, jacobiSpread: NaN, steps: 0, valid: false,
  }
  if (src.count < 3 || src.count > POINCARE_BODY_LIMIT || index < 0 || index >= src.count) return empty

  const sim = new Simulation(src.capacity)
  sim.setBodies(src.count, src.posX, src.posY, src.velX, src.velY, src.mass)
  sim.params = { ...src.params, collide: false }

  // The two heaviest bodies are the primaries (a is the heavier).
  let a = 0
  let b = 1
  {
    const order = sim.heaviestIndices(2)
    if (order.length < 2) return empty
    a = order[0]
    b = order[1]
  }
  if (index === a || index === b) return empty

  const maxCrossings = Math.max(8, opts.maxCrossings ?? 600)
  // Trim the step count so a larger system never blows the per-shot work budget.
  const budgetSteps = Math.max(2000, Math.floor(POINCARE_WORK_BUDGET / Math.max(1, sim.count)))
  const maxSteps = Math.min(Math.max(1000, opts.maxSteps ?? 200_000), budgetSteps)
  const g = sim.params.g

  const pts = new Float64Array(maxCrossings * 2)
  let count = 0
  let jSum = 0
  let jSum2 = 0

  const rot = () =>
    toRotating(
      sim.mass[a], sim.posX[a], sim.posY[a], sim.velX[a], sim.velY[a],
      sim.mass[b], sim.posX[b], sim.posY[b], sim.velX[b], sim.velY[b],
      sim.posX[index], sim.posY[index], sim.velX[index], sim.velY[index],
    )

  let prev = rot()
  let steps = 0
  for (; steps < maxSteps && count < maxCrossings; steps++) {
    sim.step()
    const cur = rot()
    // Upward crossing of η = 0 (η goes from ≤0 to >0).
    if (prev.eta <= 0 && cur.eta > 0) {
      const denom = cur.eta - prev.eta
      const f = denom !== 0 ? -prev.eta / denom : 0
      const xi = prev.xi + f * (cur.xi - prev.xi)
      const xidot = prev.xidot + f * (cur.xidot - prev.xidot)
      pts[count * 2] = xi
      pts[count * 2 + 1] = xidot
      const jc = jacobiConstant(
        sim.mass[a], sim.posX[a], sim.posY[a], sim.velX[a], sim.velY[a],
        sim.mass[b], sim.posX[b], sim.posY[b], sim.velX[b], sim.velY[b],
        g,
        sim.posX[index], sim.posY[index], sim.velX[index], sim.velY[index],
      )
      if (jc != null && Number.isFinite(jc)) {
        jSum += jc
        jSum2 += jc * jc
      }
      count++
    }
    prev = cur
  }

  if (count === 0) return { ...empty, steps, valid: false }
  const jacobiMean = jSum / count
  const variance = Math.max(0, jSum2 / count - jacobiMean * jacobiMean)
  const jacobiSpread = Math.abs(jacobiMean) > 1e-12 ? Math.sqrt(variance) / Math.abs(jacobiMean) : Math.sqrt(variance)

  return { points: pts.subarray(0, count * 2), count, jacobiMean, jacobiSpread, steps, valid: true }
}
