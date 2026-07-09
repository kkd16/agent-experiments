// waterfilling.ts — the CONTINUOUS twin of Blahut–Arimoto: capacity and
// rate–distortion for PARALLEL GAUSSIAN channels/sources, both solved by the
// same beautiful "water-filling" geometry.
//
// Blahut–Arimoto (blahutArimoto.ts) handles arbitrary DISCRETE channels and
// sources numerically. The Gaussian case is special: it has a closed-form
// optimum with a vivid picture. Pour a fixed amount of "water" (power, or
// distortion) over a terrain of bins; the water finds one flat level and fills
// the low bins more. That single geometric idea answers two dual questions:
//
//   • FORWARD water-filling — how to split a power budget across independent
//     Gaussian sub-channels of differing noise to MAXIMISE capacity. Noisier
//     sub-channels get less (or no) power; the good ones carry the load.
//   • REVERSE water-filling — how to split a DISTORTION budget across independent
//     Gaussian source components of differing variance to MINIMISE the rate
//     R(D). Low-variance components are dropped entirely (coded to zero bits);
//     the loud ones are described finely.
//
// Reverse water-filling is exactly the theory behind TRANSFORM CODING: the DCT
// in JPEG turns a block into near-independent coefficients of wildly different
// variance, and the quantisation table is a hand-tuned reverse-water-filling of
// bits across them. This module makes that connection literal and testable.

export interface WaterFillResult {
  /** The single water level μ (μ = N_i + p_i on every active sub-channel). */
  level: number
  /** Power allocated to each sub-channel, p_i = max(0, μ − N_i). */
  power: number[]
  /** Total capacity Σ ½·log₂(1 + p_i/N_i) in bits per channel use. */
  capacity: number
  /** Which sub-channels received power (μ > N_i). */
  active: boolean[]
}

/**
 * Forward water-filling: allocate a total power `P` across parallel Gaussian
 * sub-channels with noise powers `noise[i]` to maximise capacity. The optimum
 * (a KKT/Lagrange condition) is p_i = max(0, μ − N_i) with μ set so the powers
 * sum to P — pour water to a flat level μ over the noise-floor terrain.
 */
export function waterFill(noise: number[], P: number): WaterFillResult {
  const n = noise.length
  // Total allocated power is a continuous, non-decreasing function of μ; bisect.
  const totalAt = (mu: number) => {
    let s = 0
    for (let i = 0; i < n; i++) s += Math.max(0, mu - noise[i])
    return s
  }
  let lo = Math.min(...noise)
  let hi = Math.max(...noise) + P + 1
  for (let it = 0; it < 200; it++) {
    const mid = (lo + hi) / 2
    if (totalAt(mid) < P) lo = mid
    else hi = mid
  }
  const level = (lo + hi) / 2
  const power = noise.map((N) => Math.max(0, level - N))
  const active = noise.map((N) => level > N)
  let capacity = 0
  for (let i = 0; i < n; i++) if (power[i] > 0) capacity += 0.5 * Math.log2(1 + power[i] / noise[i])
  return { level, power, capacity, active }
}

export interface ReverseWaterFillResult {
  /** The distortion water level θ (each component's distortion is min(θ, σ_i²)). */
  theta: number
  /** Distortion allocated to each component, d_i = min(θ, σ_i²). */
  dist: number[]
  /** Bits spent on each component, R_i = ½·max(0, log₂(σ_i²/θ)). */
  rate: number[]
  /** Total rate Σ R_i (bits) and total distortion Σ d_i. */
  totalRate: number
  totalDist: number
  /** Which components are coded at all (σ_i² > θ). */
  active: boolean[]
}

/**
 * Reverse water-filling at a fixed distortion level θ for a Gaussian vector
 * source with component variances `variance[i]`. Components below the water line
 * (σ_i² ≤ θ) are not coded at all — you simply report their mean and accept the
 * full variance as distortion. Sweep θ to trace R(D); this is the exact R(D) of
 * an independent Gaussian vector, and the blueprint for transform-coding bit
 * allocation.
 */
export function reverseWaterFillTheta(variance: number[], theta: number): ReverseWaterFillResult {
  const dist = variance.map((v) => Math.min(theta, v))
  const rate = variance.map((v) => (v > theta ? 0.5 * Math.log2(v / theta) : 0))
  const active = variance.map((v) => v > theta)
  const totalRate = rate.reduce((a, b) => a + b, 0)
  const totalDist = dist.reduce((a, b) => a + b, 0)
  return { theta, dist, rate, totalRate, totalDist, active }
}

/**
 * Reverse water-filling to hit a TARGET total distortion D, by bisecting the
 * water level θ (total distortion is monotone increasing in θ).
 */
export function reverseWaterFill(variance: number[], D: number): ReverseWaterFillResult {
  const totalDistAt = (th: number) => variance.reduce((s, v) => s + Math.min(th, v), 0)
  const maxV = Math.max(...variance)
  const Dclamp = Math.min(D, totalDistAt(maxV))
  let lo = 0
  let hi = maxV
  for (let it = 0; it < 200; it++) {
    const mid = (lo + hi) / 2
    if (totalDistAt(mid) < Dclamp) lo = mid
    else hi = mid
  }
  return reverseWaterFillTheta(variance, (lo + hi) / 2)
}

/**
 * The full R(D) curve of an independent Gaussian vector source, swept over the
 * distortion water level θ from 0 (lossless-ish) to max variance (R→0). Each
 * point is (total distortion, total rate). Compared on the page against the flat
 * "scalar" allocation that splits distortion evenly — the gap is the coding gain
 * of allocating bits by variance, i.e. the point of a transform coder.
 */
export function gaussianVectorRD(variance: number[], points = 80): { D: number; R: number }[] {
  const maxV = Math.max(...variance)
  const out: { D: number; R: number }[] = []
  for (let i = 0; i <= points; i++) {
    const theta = (maxV * i) / points
    const r = reverseWaterFillTheta(variance, theta === 0 ? maxV * 1e-4 : theta)
    out.push({ D: r.totalDist, R: r.totalRate })
  }
  return out
}
