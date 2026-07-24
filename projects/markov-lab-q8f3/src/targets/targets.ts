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
  /** Human names for the two coordinates (defaults to x / y). */
  axes?: [string, string]
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
    // u-marginal is N(1, 10) (the v integral is constant), and v|u ~ N(u², ·),
    // so E[u] = 1 and E[v] = E[u²] = Var(u) + E[u]² = 10 + 1 = 11.
    trueMean: [1, 11],
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

// ── Bayesian logistic-regression posterior ──────────────────────────────────
// This one isn't a toy shape — it's a *real* posterior. A fixed, partly
// overlapping 1-D dataset {(xᵢ, yᵢ)} with yᵢ ∈ {0,1}; the two coordinates the
// sampler explores are the intercept a and slope b of  p(y=1) = σ(a + b·x).
// With a N(0, 3²) prior the posterior is a correlated, gently banana-ish ridge
// — so exploring it IS Bayesian inference, and the chain's running mean is the
// posterior-mean parameter estimate.
function logisticPosterior(): Target {
  // Deterministic, mostly-separable data with a few boundary flips.
  const N = 18
  const data: { x: number; y: number }[] = []
  for (let i = 0; i < N; i++) {
    const x = -2.2 + (4.4 * i) / (N - 1)
    const score = 0.6 + 1.8 * x + 0.95 * Math.sin(3.3 * i + 1) // fixed pseudo-noise
    data.push({ x, y: score > 0 ? 1 : 0 })
  }
  const tau2 = 9 // prior variance (σ = 3)
  const sig = (z: number) => 1 / (1 + Math.exp(-z))
  return {
    id: 'logistic',
    name: 'Logistic Posterior',
    blurb:
      'A real Bayesian posterior over the (intercept, slope) of a logistic fit to 18 data points. The running mean is your parameter estimate.',
    logDensity: (theta) => {
      const [a, b] = theta
      let ll = 0
      for (const d of data) {
        const z = a + b * d.x
        // numerically-stable log-likelihood: y·z − log(1+e^z)
        ll += d.y * z - (z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z)))
      }
      const lp = -(a * a + b * b) / (2 * tau2)
      return ll + lp
    },
    gradLogDensity: (theta) => {
      const [a, b] = theta
      let ga = -a / tau2
      let gb = -b / tau2
      for (const d of data) {
        const r = d.y - sig(a + b * d.x)
        ga += r
        gb += r * d.x
      }
      return [ga, gb]
    },
    view: [-2.5, 4, -1, 6],
    start: [0, 0],
    axes: ['intercept', 'slope'],
  }
}

// ── Heavy-tailed correlated Student-t ───────────────────────────────────────
// Same elliptical shape as a Gaussian but with ν = 2.5 degrees of freedom, so
// the tails are polynomial, not exponential. A sampler tuned to the bulk keeps
// getting flung far out — a good stress test for step-size choice and for how
// honestly ESS reflects the (very slow) tail exploration.
function studentT(nu = 2.5, rho = 0.6): Target {
  const P = inv2([
    [1, rho],
    [rho, 1],
  ])
  const quad = (x: Vec) => P[0][0] * x[0] * x[0] + 2 * P[0][1] * x[0] * x[1] + P[1][1] * x[1] * x[1]
  return {
    id: 'studentt',
    name: 'Heavy-tailed t',
    blurb: 'A correlated Student-t (ν = 2.5). Polynomial tails fling the chain far out — brutal on a fixed step size.',
    logDensity: (x) => -((nu + 2) / 2) * Math.log1p(quad(x) / nu),
    gradLogDensity: (x) => {
      const c = -((nu + 2) / nu) / (1 + quad(x) / nu)
      return [c * (P[0][0] * x[0] + P[0][1] * x[1]), c * (P[1][0] * x[0] + P[1][1] * x[1])]
    },
    view: [-9, 9, -9, 9],
    start: [0, 0],
    trueMean: [0, 0],
  }
}

// ── Squiggle — a sinusoidally sheared Gaussian ──────────────────────────────
// A Gaussian whose ridge is bent into an S: the conditional mean of y follows
// b·sin(w·x). The mass sits on a thin, non-monotone curve, so any axis-aligned
// or isotropic proposal keeps stepping off the ridge — but the geometry is
// smooth, so a gradient sampler can trace the S cleanly. A gentler cousin of
// the banana that curves *both* ways.
function squiggle(b = 2, w = 1.2, sx = 1.5, sy = 0.45): Target {
  const sx2 = sx * sx
  const sy2 = sy * sy
  return {
    id: 'squiggle',
    name: 'Squiggle',
    blurb: 'A Gaussian bent into an S — mass on a thin sinusoidal ridge. Punishes isotropic proposals, rewards gradients.',
    logDensity: (x) => {
      const [u, v] = x
      const m = b * Math.sin(w * u)
      return -(u * u) / (2 * sx2) - (v - m) ** 2 / (2 * sy2)
    },
    gradLogDensity: (x) => {
      const [u, v] = x
      const m = b * Math.sin(w * u)
      const mp = b * w * Math.cos(w * u) // dm/du
      const du = -u / sx2 + ((v - m) * mp) / sy2
      const dv = -(v - m) / sy2
      return [du, dv]
    },
    view: [-4.5, 4.5, -4, 4],
    start: [0, 0],
    trueMean: [0, 0],
  }
}

// ── Twin Craters — two facing bananas (curved *and* bimodal) ────────────────
// A log-sum-exp of two crescent ridges, one opening up and one opening down,
// offset above and below the origin. It fuses the two hardest features in the
// gallery: each mode is a curved Rosenbrock-style valley (so isotropic
// proposals crawl), *and* the two modes are separated by a real barrier (so a
// single chain gets marooned in one crater — the case for tempering). HMC
// follows one valley beautifully but still can't cross; parallel tempering can.
function twinCraters(): Target {
  const kx = 0.125 // horizontal confinement
  const kr = 2.0 // ridge tightness
  // A crescent whose ridge is v = cx·u² + off; returns [f, ∂f/∂u, ∂f/∂v].
  const crescent = (u: number, v: number, cx: number, off: number): [number, number, number] => {
    const m = cx * u * u + off
    const mp = 2 * cx * u
    const f = -kx * u * u - kr * (v - m) ** 2
    const df_du = -2 * kx * u + 2 * kr * (v - m) * mp
    const df_dv = -2 * kr * (v - m)
    return [f, df_du, df_dv]
  }
  return {
    id: 'twin',
    name: 'Twin Craters',
    blurb: 'Two facing bananas: curved valleys *and* isolated modes at once. The gallery’s hardest — needs geometry and mode-hopping together.',
    logDensity: (x) => {
      const [u, v] = x
      const [f1] = crescent(u, v, 0.4, -2)
      const [f2] = crescent(u, v, -0.4, 2)
      const M = Math.max(f1, f2)
      return M + Math.log(Math.exp(f1 - M) + Math.exp(f2 - M))
    },
    gradLogDensity: (x) => {
      const [u, v] = x
      const [f1, g1u, g1v] = crescent(u, v, 0.4, -2)
      const [f2, g2u, g2v] = crescent(u, v, -0.4, 2)
      const M = Math.max(f1, f2)
      const w1 = Math.exp(f1 - M)
      const w2 = Math.exp(f2 - M)
      const z = w1 + w2
      return [(w1 * g1u + w2 * g2u) / z, (w1 * g1v + w2 * g2v) / z]
    },
    view: [-4.5, 4.5, -5, 5],
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
  studentT(),
  squiggle(),
  twinCraters(),
  logisticPosterior(),
]

export const targetById = (id: string): Target =>
  TARGETS.find((t) => t.id === id) ?? TARGETS[0]
