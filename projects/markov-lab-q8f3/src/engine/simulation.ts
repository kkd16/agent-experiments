// The stateful core that lives across React renders: it owns the active
// sampler, accumulates the chain, and derives the live statistics. The UI
// treats it as a black box it steps and reads.

import {
  effectiveSampleSize,
  iact,
  mean,
  quantile,
  splitRHat,
  std,
} from '../diagnostics/diagnostics'
import { RNG } from '../math/rng'
import type { Vec } from '../math/linalg'
import { samplerById } from '../samplers/samplers'
import type { Sampler, StepResult } from '../samplers/types'
import { targetById } from '../targets/targets'
import type { Target } from '../targets/targets'

const MAX_HISTORY = 400_000 // cap RAM; oldest samples are dropped in blocks
const TRAIL_LEN = 1400 // recent states drawn as the glowing trail
const STAT_WINDOW = 60_000 // most-recent samples the diagnostics run over

export interface SimConfig {
  targetId: string
  samplerId: string
  params: Record<string, number>
  seed: number
  burnInFrac: number
}

export interface LiveStats {
  iters: number
  acceptRate: number
  essX: number
  essY: number
  rhatX: number
  rhatY: number
  tauX: number
  meanX: number
  meanY: number
  sdX: number
  sdY: number
  ci: [number, number] // 95% CI for x0
  densityEvals: number
  gradEvals: number
  essPerKEval: number // effective samples per 1000 target evaluations
  usedForStats: number
  /** Smoothed sampler internals (adapted ε, mean NUTS depth, accept-prob). */
  info?: Record<string, number>
  /** ‖running mean − true mean‖ when the target's mean is known analytically. */
  meanErr?: number
}

export class Simulation {
  readonly target: Target
  readonly config: SimConfig
  private sampler: Sampler
  private rng: RNG

  xs: number[] = []
  ys: number[] = []
  logps: number[] = []
  iters = 0
  accepts = 0

  // Recent state positions for the trail (ring-ish; we just slice the tails).
  trailX: number[] = []
  trailY: number[] = []
  trailAcc: boolean[] = []

  last: StepResult | null = null

  // Sampler-reported internals: the latest raw values plus an EMA for display.
  lastInfo: Record<string, number> | null = null
  private infoEma: Record<string, number> = {}

  // Downsampled convergence history: the whole-chain running mean of each
  // coordinate, snapshotted as the chain grows (the classic Monte-Carlo
  // convergence curve — the estimate settling toward its target value).
  histIter: number[] = []
  histMeanX: number[] = []
  histMeanY: number[] = []
  private cumX = 0
  private cumY = 0
  private hStride = 20 // iterations between snapshots (doubles as history fills)

  constructor(config: SimConfig) {
    this.config = config
    this.target = targetById(config.targetId)
    this.rng = new RNG(config.seed)
    const def = samplerById(config.samplerId)
    this.sampler = def.create(this.target, this.rng, config.params)
    // seed history with the starting point
    this.pushState(this.sampler.x, this.sampler.logp, true)
  }

  private pushState(x: Vec, logp: number, acc: boolean) {
    this.xs.push(x[0])
    this.ys.push(x[1])
    this.logps.push(logp)
    this.trailX.push(x[0])
    this.trailY.push(x[1])
    this.trailAcc.push(acc)
    if (this.trailX.length > TRAIL_LEN) {
      this.trailX.shift()
      this.trailY.shift()
      this.trailAcc.shift()
    }
    if (this.xs.length > MAX_HISTORY) {
      const drop = MAX_HISTORY / 4
      this.xs.splice(0, drop)
      this.ys.splice(0, drop)
      this.logps.splice(0, drop)
    }
  }

  step(n: number) {
    for (let i = 0; i < n; i++) {
      const r = this.sampler.step()
      this.iters++
      if (r.accepted) this.accepts++
      this.last = r
      if (r.info) {
        this.lastInfo = r.info
        for (const k in r.info) {
          const prev = this.infoEma[k]
          this.infoEma[k] = prev === undefined ? r.info[k] : 0.02 * r.info[k] + 0.98 * prev
        }
      }
      this.cumX += r.x[0]
      this.cumY += r.x[1]
      this.pushState(r.x, r.logp, r.accepted)
      if (this.iters % this.hStride === 0) this.snapshot()
    }
  }

  /** Record the current whole-chain running mean; thin the history as it grows. */
  private snapshot() {
    this.histIter.push(this.iters)
    this.histMeanX.push(this.cumX / this.iters)
    this.histMeanY.push(this.cumY / this.iters)
    if (this.histIter.length > 1000) {
      const keep = (a: number[]) => a.filter((_, i) => i % 2 === 0)
      this.histIter = keep(this.histIter)
      this.histMeanX = keep(this.histMeanX)
      this.histMeanY = keep(this.histMeanY)
      this.hStride *= 2 // snapshot half as often from here on
    }
  }

  get lastTrajectory(): Vec[] | null {
    return this.last?.trajectory ?? null
  }
  get lastChains(): Vec[] | null {
    return this.last?.chains ?? null
  }
  get lastProposal(): Vec | null {
    return this.last?.proposal ?? null
  }

  /**
   * Post-burn-in slice used for statistics, capped to the most recent
   * STAT_WINDOW samples so the O(N·lag) diagnostics stay real-time on very
   * long chains. Everything downstream is computed on this same window.
   */
  private statSlice(arr: number[]): number[] {
    const burn = Math.floor(this.iters * this.config.burnInFrac)
    // burn is in *iteration* units; history may have been trimmed, so clamp.
    let start = Math.max(0, arr.length - (this.iters - burn))
    start = Math.max(start, arr.length - STAT_WINDOW)
    return arr.slice(start)
  }

  /**
   * Sampler internals for the UI: smoothed (EMA) values for noisy quantities
   * like the NUTS tree depth, but the *current* step size ε (it converges, and
   * you want to see where it settled, not a lagging average).
   */
  private liveInfo(): Record<string, number> | undefined {
    if (!this.lastInfo) return undefined
    const out = { ...this.infoEma }
    if (this.lastInfo.eps !== undefined) out.eps = this.lastInfo.eps
    return out
  }

  stats(): LiveStats {
    const sx = this.statSlice(this.xs)
    const sy = this.statSlice(this.ys)
    const n = sx.length
    if (n < 4) {
      return {
        iters: this.iters,
        acceptRate: this.iters ? this.accepts / this.iters : 0,
        essX: 0, essY: 0, rhatX: NaN, rhatY: NaN, tauX: NaN,
        meanX: mean(sx || [0]), meanY: mean(sy || [0]),
        sdX: 0, sdY: 0, ci: [NaN, NaN],
        densityEvals: this.sampler.densityEvals,
        gradEvals: this.sampler.gradEvals,
        essPerKEval: 0, usedForStats: n,
        info: this.liveInfo(),
      }
    }
    const essX = effectiveSampleSize(sx)
    const essY = effectiveSampleSize(sy)
    const totalEval = this.sampler.densityEvals + this.sampler.gradEvals
    return {
      iters: this.iters,
      acceptRate: this.accepts / this.iters,
      essX,
      essY,
      rhatX: splitRHat(sx),
      rhatY: splitRHat(sy),
      tauX: iact(sx),
      meanX: mean(sx),
      meanY: mean(sy),
      sdX: std(sx),
      sdY: std(sy),
      ci: [quantile(sx, 0.025), quantile(sx, 0.975)],
      densityEvals: this.sampler.densityEvals,
      gradEvals: this.sampler.gradEvals,
      essPerKEval: totalEval ? (1000 * Math.min(essX, essY)) / totalEval : 0,
      usedForStats: n,
      info: this.liveInfo(),
      meanErr: this.meanError(mean(sx), mean(sy)),
    }
  }

  /** Distance of the running mean estimate from the target's known true mean. */
  private meanError(mx: number, my: number): number | undefined {
    const tm = this.target.trueMean
    if (!tm) return undefined
    return Math.hypot(mx - tm[0], my - tm[1])
  }

  /** Column of post-burn-in samples for a given dimension. */
  column(dim: 0 | 1): number[] {
    return this.statSlice(dim === 0 ? this.xs : this.ys)
  }
}
