// pssmlt.ts — Primary-Sample-Space Metropolis Light Transport, Lumen's third
// light-transport integrator (alongside the unidirectional path tracer and
// BDPT). Where those two solve the rendering equation by *averaging* independent
// estimates, PSSMLT (Kelemen et al. 2002) explores the space of light paths with
// a **Markov chain**: it mutates the very stream of random numbers a path tracer
// consumes and accepts/rejects each mutation with the Metropolis–Hastings rule,
// so the chain spends time in each region of path space in proportion to that
// region's contribution to the image. The result locks onto the bright, hard-to-
// find transport (a caustic, a sliver of an indirectly lit room) and refines it
// far faster than blind sampling — yet it still converges to the *same* image,
// which is exactly what the verification suite proves.
//
// The elegant part: we reuse the existing path tracer **verbatim** as the
// contribution function F(U). A path tracer is a deterministic map from a vector
// of uniform random numbers U ∈ [0,1)^d to a radiance value; all we do is feed it
// its randoms from a replayable, mutatable vector instead of the bare RNG. Since
// `PssmltSampler` *is-a* `Rng` (it overrides `next()`), every sampler, BSDF and
// light routine in the engine works through it unchanged.
//
// References: Kelemen, Szirmay-Kalos, Antal & Csonka, "A Simple and Robust
// Mutation Strategy for the Metropolis Light Transport Algorithm" (EG 2002); the
// expected-value ("splat L/I weighted by the accept probability") estimator and
// the bootstrap normalisation follow PBRT's MLT integrator.

import type { Vec3 } from './vec3'
import { luminance } from './vec3'
import { Rng } from './rng'
import { radiance } from './integrator'
import type { RayStats } from './integrator'
import { Camera } from './camera'
import type { Scene } from './scene'
import type { IntegratorSettings } from './types'

// One coordinate of the primary sample space. `value` ∈ [0,1) is what the path
// tracer reads; the *Backup fields snapshot it so a rejected mutation can be
// rolled back, and `modify` records the iteration at which it last changed, which
// drives Kelemen's lazy "many small steps collapsed into one" reconstruction.
interface PrimarySample {
  value: number
  valueBackup: number
  modify: number
  modifyBackup: number
}

export interface MltOptions {
  nChains: number // independent Markov chains run in parallel (decorrelation)
  nBootstrap: number // uniform samples used to estimate brightness b + seed chains
  largeStepProb: number // probability a mutation is a global (large) step
  sigma: number // standard deviation of a small (local) coordinate perturbation
}

export const DEFAULT_MLT: MltOptions = {
  nChains: 6,
  nBootstrap: 20000,
  largeStepProb: 0.3,
  sigma: 0.02,
}

// ---------------------------------------------------------------------------
// The Metropolis sampler. It looks like an `Rng` to the rest of the engine but
// returns coordinates of a mutatable primary-sample-space vector, lazily grown
// and perturbed on demand. The *base* class RNG (reached via `super`) is its
// private source of fresh uniforms and Gaussian perturbations.
// ---------------------------------------------------------------------------
export class PssmltSampler extends Rng {
  private xs: PrimarySample[] = []
  private currentIteration = 0
  private largeStepNow = true
  private lastLargeStep = 0
  private sampleIndex = 0
  private readonly largeStepProb: number
  private readonly sigma: number
  private gaussCache: number | null = null

  constructor(seed: number, stream = 1, largeStepProb = 0.3, sigma = 0.02) {
    super(seed, stream)
    this.largeStepProb = largeStepProb
    this.sigma = sigma
  }

  // A fresh uniform from the *internal* pseudo-random generator (the base class).
  private uniform(): number {
    return super.next()
  }

  // A standard-normal sample via Box–Muller (one of the pair is cached).
  private gauss(): number {
    if (this.gaussCache !== null) {
      const g = this.gaussCache
      this.gaussCache = null
      return g
    }
    let u1 = this.uniform()
    const u2 = this.uniform()
    u1 = Math.max(u1, 1e-12)
    const r = Math.sqrt(-2 * Math.log(u1))
    const a = 2 * Math.PI * u2
    this.gaussCache = r * Math.sin(a)
    return r * Math.cos(a)
  }

  // Begin a proposed mutation: decide its kind and rewind the read cursor. The
  // very first iteration is forced to be a large step so a brand-new sampler (or
  // a freshly re-seeded chain) is initialised to a clean uniform sample.
  startIteration(): void {
    this.currentIteration++
    this.largeStepNow =
      this.currentIteration === 1 ? true : this.uniform() < this.largeStepProb
    this.sampleIndex = 0
    this.gaussCache = null
  }

  get isLargeStep(): boolean {
    return this.largeStepNow
  }

  // Bring coordinate i up to date for the current iteration (Kelemen lazy
  // mutation): re-randomise it if a large step has happened since it was last
  // touched, snapshot it, then either replace it (large step) or perturb it by a
  // wrapped Gaussian whose variance accounts for every small step it slept
  // through.
  private ensureReady(i: number): void {
    while (this.xs.length <= i) {
      this.xs.push({ value: 0, valueBackup: 0, modify: 0, modifyBackup: 0 })
    }
    const xi = this.xs[i]
    if (xi.modify < this.lastLargeStep) {
      xi.value = this.uniform()
      xi.modify = this.lastLargeStep
    }
    xi.valueBackup = xi.value
    xi.modifyBackup = xi.modify
    if (this.largeStepNow) {
      xi.value = this.uniform()
    } else {
      const nSmall = Math.max(1, this.currentIteration - xi.modify)
      const effSigma = this.sigma * Math.sqrt(nSmall)
      let val = xi.value + this.gauss() * effSigma
      val -= Math.floor(val) // wrap onto the torus [0,1) — a symmetric proposal
      // Guard the rare exact-1.0 after rounding.
      if (val >= 1) val = 0
      if (val < 0) val = 0
      xi.value = val
    }
    xi.modify = this.currentIteration
  }

  // The single method the whole engine pulls its randomness through.
  override next(): number {
    const i = this.sampleIndex++
    this.ensureReady(i)
    return this.xs[i].value
  }

  // Commit the proposed mutation: only a large step advances the "last large
  // step" watermark that ensureReady uses to know which coords are stale.
  accept(): void {
    if (this.largeStepNow) this.lastLargeStep = this.currentIteration
  }

  // Roll back the proposed mutation: every coordinate touched this iteration is
  // restored, and the iteration counter is rewound.
  reject(): void {
    for (const xi of this.xs) {
      if (xi.modify === this.currentIteration) {
        xi.value = xi.valueBackup
        xi.modify = xi.modifyBackup
      }
    }
    this.currentIteration--
  }
}

// ---------------------------------------------------------------------------
// The contribution function F(U): turn the sampler's primary-sample-space vector
// into a radiance and the film location it lands on. The first two coordinates
// choose the film point (so the chain can *move across the image*), the rest are
// consumed by the camera lens (if any) and the path tracer.
// ---------------------------------------------------------------------------
export interface MltSample {
  L: Vec3
  x: number
  y: number
  I: number // scalar importance = luminance(L), the chain's target density
}

export function mltContribution(
  scene: Scene,
  camera: Camera,
  sampler: PssmltSampler,
  settings: IntegratorSettings,
  W: number,
  H: number,
  stats: RayStats,
): MltSample {
  const s = sampler.next() // film u ∈ [0,1)
  const t = sampler.next() // film v ∈ [0,1), origin bottom-left
  const ray = camera.generateRay(s, t, sampler)
  const L = radiance(scene, ray, settings, sampler, stats)
  let x = Math.floor(s * W)
  if (x < 0) x = 0
  else if (x >= W) x = W - 1
  let y = Math.floor((1 - t) * H) // flip so +v is up, matching the worker
  if (y < 0) y = 0
  else if (y >= H) y = H - 1
  const I = luminance(L)
  return { L, x, y, I: Number.isFinite(I) && I > 0 ? I : 0 }
}

function upperBound(cdf: Float64Array, target: number): number {
  // First index whose cumulative weight strictly exceeds `target`.
  let lo = 0
  let hi = cdf.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cdf[mid] <= target) lo = mid + 1
    else hi = mid
  }
  return lo
}

// ---------------------------------------------------------------------------
// A running Metropolis renderer. It owns the splat buffer and a set of chains,
// and `step(n)` advances the render by n mutations; `image()` reads back the
// normalised HDR estimate at any time (progressive). The worker and the single-
// thread fallback both drive an `MltState`, so the live render and the in-app
// proof share one implementation.
// ---------------------------------------------------------------------------
export class MltState {
  readonly W: number
  readonly H: number
  readonly stats: RayStats = { rays: 0 }
  private readonly nPixels: number
  private readonly splat: Float32Array
  private b = 0
  private mutations = 0
  private readonly chains: { sampler: PssmltSampler; L: Vec3; I: number; x: number; y: number }[] = []
  private readonly acceptRng: Rng
  private nextChain = 0
  private readonly opts: MltOptions
  private readonly scene: Scene
  private readonly camera: Camera
  private readonly settings: IntegratorSettings

  constructor(
    scene: Scene,
    camera: Camera,
    settings: IntegratorSettings,
    W: number,
    H: number,
    seed: number,
    opts: MltOptions = DEFAULT_MLT,
  ) {
    this.scene = scene
    this.camera = camera
    this.settings = settings
    this.W = W
    this.H = H
    this.nPixels = W * H
    this.splat = new Float32Array(this.nPixels * 3)
    this.opts = opts
    this.acceptRng = new Rng((seed ^ 0x9e3779b9) >>> 0, 17)
    this.bootstrap(seed >>> 0)
  }

  // Estimate the image brightness b = E[I] over uniform samples (this is exactly
  // the average image luminance, and it is what re-establishes absolute scale
  // after the chain — which only knows *relative* contributions). The same
  // bootstrap samples seed the chains, drawn in proportion to their contribution
  // so the chain starts in a relevant, non-zero state (no startup bias).
  private bootstrap(seed: number): void {
    const N = Math.max(1, this.opts.nBootstrap)
    const weights = new Float64Array(N)
    let sum = 0
    for (let k = 0; k < N; k++) {
      const smp = this.freshSampler(seed, k)
      smp.startIteration()
      const c = mltContribution(this.scene, this.camera, smp, this.settings, this.W, this.H, this.stats)
      weights[k] = c.I
      sum += c.I
    }
    this.b = sum / N
    const cdf = new Float64Array(N + 1)
    for (let k = 0; k < N; k++) cdf[k + 1] = cdf[k] + weights[k]
    const total = cdf[N]
    for (let c = 0; c < this.opts.nChains; c++) {
      let k: number
      if (total > 0) {
        k = upperBound(cdf, this.acceptRng.next() * total) - 1
        if (k < 0) k = 0
        else if (k >= N) k = N - 1
      } else {
        k = Math.min(N - 1, (this.acceptRng.next() * N) | 0)
      }
      const smp = this.freshSampler(seed, k)
      smp.startIteration()
      const start = mltContribution(this.scene, this.camera, smp, this.settings, this.W, this.H, this.stats)
      smp.accept()
      this.chains.push({ sampler: smp, L: start.L, I: start.I, x: start.x, y: start.y })
    }
  }

  // A sampler whose stream is a deterministic function of (seed, k), so a chain
  // can be re-seeded to *exactly* reproduce bootstrap sample k as its start.
  private freshSampler(seed: number, k: number): PssmltSampler {
    const s = (seed + Math.imul(k, 0x9e3779b1) + 1) >>> 0
    return new PssmltSampler(s, (k % 1023) + 1, this.opts.largeStepProb, this.opts.sigma)
  }

  private addSplat(x: number, y: number, c: Vec3, w: number): void {
    if (w === 0 || !Number.isFinite(w)) return
    const idx = (y * this.W + x) * 3
    this.splat[idx] += c.x * w
    this.splat[idx + 1] += c.y * w
    this.splat[idx + 2] += c.z * w
  }

  // Advance the render by `numMutations` Metropolis steps, round-robined across
  // the chains. Each step proposes a mutation, splats the expected-value
  // contribution of both the proposed and the current state, then accepts the
  // proposal with the Metropolis probability min(1, I'/I).
  step(numMutations: number): void {
    const nC = this.chains.length
    if (nC === 0) return
    for (let m = 0; m < numMutations; m++) {
      const ch = this.chains[this.nextChain]
      this.nextChain = (this.nextChain + 1) % nC
      ch.sampler.startIteration()
      const prop = mltContribution(this.scene, this.camera, ch.sampler, this.settings, this.W, this.H, this.stats)
      const a = ch.I > 0 ? Math.min(1, prop.I / ch.I) : 1
      // Expected-value splatting: a sample's contribution to the image is L/I
      // (radiance per unit target density); we deposit the proposed state's share
      // a·L'/I' at its pixel and the current state's complementary share at its
      // pixel, which drives the variance of the accept/reject decision to zero.
      if (prop.I > 0) this.addSplat(prop.x, prop.y, prop.L, a / prop.I)
      if (ch.I > 0) this.addSplat(ch.x, ch.y, ch.L, (1 - a) / ch.I)
      if (this.acceptRng.next() < a) {
        ch.L = prop.L
        ch.I = prop.I
        ch.x = prop.x
        ch.y = prop.y
        ch.sampler.accept()
      } else {
        ch.sampler.reject()
      }
      this.mutations++
    }
  }

  get mutationCount(): number {
    return this.mutations
  }
  get brightness(): number {
    return this.b
  }
  get mutationsPerPixel(): number {
    return this.mutations / this.nPixels
  }

  // The normalised HDR image. The chain accumulates Σ (L/I)·weight; multiplying
  // by b/mutationsPerPixel = b·nPixels/mutations restores absolute radiance — a
  // constant-radiance field comes back as itself, and the per-pixel estimate is
  // unbiased.
  image(out?: Float32Array): Float32Array {
    const dst = out ?? new Float32Array(this.nPixels * 3)
    const scale = this.mutations > 0 ? (this.b * this.nPixels) / this.mutations : 0
    const splat = this.splat
    for (let i = 0; i < dst.length; i++) dst[i] = splat[i] * scale
    return dst
  }
}

// One-shot convenience used by the verification suite: render a scene to a
// normalised HDR image with PSSMLT at a given mutations-per-pixel budget.
export function renderMLT(
  scene: Scene,
  camera: Camera,
  settings: IntegratorSettings,
  W: number,
  H: number,
  mpp: number,
  seed: number,
  opts: MltOptions = DEFAULT_MLT,
): Float32Array {
  const state = new MltState(scene, camera, settings, W, H, seed, opts)
  state.step(Math.max(1, Math.round(mpp * W * H)))
  return state.image()
}
