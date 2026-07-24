// Nesterov dual-averaging step-size adaptation — the warmup scheme that lets
// HMC and NUTS tune their own leapfrog step size ε instead of making you hunt
// for it by hand. This is the primal-dual method of Hoffman & Gelman (2014),
// "The No-U-Turn Sampler", Algorithm 5 (which itself follows Nesterov 2009).
//
// The idea: we want the average Metropolis acceptance probability to sit at a
// target δ (0.8 is the NUTS sweet spot; ~0.65 is optimal for plain HMC). Each
// warmup iteration produces an acceptance statistic α; the shortfall (δ − α)
// drives a Robbins–Monro-style stochastic optimisation of log ε, with a slowly
// vanishing step that guarantees convergence. We adapt for a fixed warmup
// window and then FREEZE ε at the dual-averaged running estimate ε̄ — after
// which the chain is a proper, time-homogeneous Markov chain again.

export class DualAveraging {
  /** The step size to use *right now* (moves every warmup iteration). */
  eps: number
  /** Whether we're still in the warmup window. */
  adapting = true

  private readonly mu: number // log(10·ε₀): shrink toward a larger step
  private readonly gamma = 0.05 // adaptation regularisation
  private readonly t0 = 10 // stabilises early, high-variance iterations
  private readonly kappa = 0.75 // Robbins–Monro decay exponent
  private readonly delta: number // target acceptance δ
  private readonly warmup: number // iterations to adapt before freezing
  private logEpsBar = 0 // log of the averaged estimate ε̄
  private hBar = 0 // running average of (δ − α)
  private m = 0 // warmup iteration counter

  constructor(eps0: number, delta: number, warmup: number) {
    this.eps = clampEps(eps0)
    this.delta = delta
    this.warmup = warmup
    this.mu = Math.log(10 * this.eps)
  }

  /**
   * Feed one warmup iteration's acceptance statistic α ∈ [0,1] and get the
   * step size to use next. Once the warmup window is exhausted this freezes ε
   * at the dual-averaged estimate and returns it unchanged thereafter.
   */
  update(alpha: number): number {
    if (!this.adapting) return this.eps
    const a = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 0
    this.m += 1
    const m = this.m
    const w = 1 / (m + this.t0)
    this.hBar = (1 - w) * this.hBar + w * (this.delta - a)
    const logEps = this.mu - (Math.sqrt(m) / this.gamma) * this.hBar
    const eta = Math.pow(m, -this.kappa)
    this.logEpsBar = eta * logEps + (1 - eta) * this.logEpsBar
    this.eps = clampEps(Math.exp(logEps))
    if (m >= this.warmup) {
      // Warmup done: settle on the averaged step and stop moving.
      this.eps = clampEps(Math.exp(this.logEpsBar))
      this.adapting = false
    }
    return this.eps
  }
}

/** Keep ε in a numerically sane band so a bad start can't blow up or freeze. */
function clampEps(eps: number): number {
  if (!Number.isFinite(eps) || eps <= 0) return 1e-3
  return Math.max(1e-4, Math.min(3, eps))
}
