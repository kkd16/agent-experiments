// A gallery of 2-D target distributions. Each one exposes an *unnormalised*
// log-density and its analytic gradient (for the gradient-based samplers).
// The samplers only ever see these two functions — they never know which
// distribution they are exploring, which is exactly the point of MCMC.

import type { Vec } from '../math/linalg'
import { inv2 } from '../math/linalg'

export interface Target {
  id: string
  name: string
  blurb: string
  /** Unnormalised log density log π̃(x). */
  logDensity: (x: Vec) => number
  /** ∇ log π̃(x). */
  gradLogDensity: (x: Vec) => Vec
  /** A sensible drawing window [xMin, xMax, yMin, yMax]. */
  view: [number, number, number, number]
  /** A reasonable starting point for a chain. */
  start: Vec
  /** True marginal means, when known — used to score sampler accuracy. */
  trueMean?: Vec
}

// ── Correlated bivariate Gaussian ───────────────────────────────────────────
function gaussian(rho: number): Target {
  const Sigma = [
    [1, rho],
    [rho, 1],
  ]
  const P = inv2(Sigma) // precision matrix
  return {
    id: 'gauss',
    name: 'Correlated Gaussian',
    blurb: `A tilted bell, ρ = ${rho}. The textbook case — every sampler should nail it.`,
    logDensity: (x) => {
      const [a, b] = x
      return -0.5 * (P[0][0] * a * a + 2 * P[0][1] * a * b + P[1][1] * b * b)
    },
    gradLogDensity: (x) => {
      const [a, b] = x
      return [-(P[0][0] * a + P[0][1] * b), -(P[1][0] * a + P[1][1] * b)]
    },
    view: [-4, 4, -4, 4],
    start: [0, 0],
    trueMean: [0, 0],
  }
}

// ── Rosenbrock "banana" ─────────────────────────────────────────────────────
// A long, curved, narrow valley. Random-walk samplers crawl; HMC glides.
function banana(a = 1, b = 5): Target {
  return {
    id: 'banana',
    name: 'Rosenbrock Banana',
    blurb: 'A curved, pinched valley. Punishes isotropic proposals — the classic HMC showcase.',
    logDensity: (x) => {
      const [u, v] = x
      return -((a - u) ** 2) / 20 - b * (v - u * u) ** 2
    },
    gradLogDensity: (x) => {
      const [u, v] = x
      const du = (2 * (a - u)) / 20 + b * 2 * (v - u * u) * (2 * u)
      const dv = -b * 2 * (v - u * u)
      return [du, dv]
    },
    view: [-3.5, 4.5, -2, 12],
    start: [0, 0],
  }
}

// ── Ring / donut ────────────────────────────────────────────────────────────
function ring(r0 = 3, sigma = 0.35): Target {
  return {
    id: 'ring',
    name: 'Ring',
    blurb: 'Mass on a circle of radius 3. Multimodal in angle — mixing means going *around*.',
    logDensity: (x) => {
      const r = Math.hypot(x[0], x[1])
      return -((r - r0) ** 2) / (2 * sigma * sigma)
    },
    gradLogDensity: (x) => {
      const r = Math.hypot(x[0], x[1]) + 1e-9
      const c = -(r - r0) / (sigma * sigma) / r
      return [c * x[0], c * x[1]]
    },
    view: [-5, 5, -5, 5],
    start: [3, 0],
    trueMean: [0, 0],
  }
}

// ── Mixture of Gaussians (four wells) ───────────────────────────────────────
function mixture(): Target {
  const centres: Vec[] = [
    [-2.2, -2.2],
    [2.2, -2.2],
    [-2.2, 2.2],
    [2.2, 2.2],
  ]
  const s2 = 0.55
  return {
    id: 'mixture',
    name: 'Four-Mode Mixture',
    blurb: 'Four separated wells. A single chain gets *trapped* — the case for tempering.',
    logDensity: (x) => {
      let sum = 0
      for (const c of centres) {
        const d2 = (x[0] - c[0]) ** 2 + (x[1] - c[1]) ** 2
        sum += Math.exp(-d2 / (2 * s2))
      }
      return Math.log(sum + 1e-300)
    },
    gradLogDensity: (x) => {
      let sum = 1e-300
      let gx = 0
      let gy = 0
      for (const c of centres) {
        const d2 = (x[0] - c[0]) ** 2 + (x[1] - c[1]) ** 2
        const w = Math.exp(-d2 / (2 * s2))
        sum += w
        gx += w * (-(x[0] - c[0]) / s2)
        gy += w * (-(x[1] - c[1]) / s2)
      }
      return [gx / sum, gy / sum]
    },
    view: [-5, 5, -5, 5],
    start: [0, 0],
    trueMean: [0, 0],
  }
}

// ── Neal's funnel ───────────────────────────────────────────────────────────
// v ~ N(0, 3²); x | v ~ N(0, e^{v}). A vertical trumpet whose neck has
// wildly varying scale — the canonical failure mode for fixed step sizes.
function funnel(): Target {
  return {
    id: 'funnel',
    name: "Neal's Funnel",
    blurb: 'A trumpet whose width changes by orders of magnitude. Breaks fixed step sizes.',
    logDensity: (x) => {
      const [v, xx] = x
      return -0.5 * (v * v) / 9 - 0.5 * xx * xx * Math.exp(-v) - 0.5 * v
    },
    gradLogDensity: (x) => {
      const [v, xx] = x
      const dv = -v / 9 + 0.5 * xx * xx * Math.exp(-v) - 0.5
      const dx = -xx * Math.exp(-v)
      return [dv, dx]
    },
    view: [-9, 9, -6, 6],
    start: [0, 0],
    trueMean: [0, 0],
  }
}

export const TARGETS: Target[] = [
  gaussian(0.85),
  banana(),
  ring(),
  mixture(),
  funnel(),
]

export const targetById = (id: string): Target =>
  TARGETS.find((t) => t.id === id) ?? TARGETS[0]
