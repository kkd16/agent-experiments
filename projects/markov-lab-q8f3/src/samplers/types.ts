import type { Vec } from '../math/linalg'
import type { RNG } from '../math/rng'
import type { Target } from '../targets/targets'

/** One UI-adjustable knob for a sampler. */
export interface ParamSpec {
  key: string
  label: string
  min: number
  max: number
  step: number
  default: number
  /** Render the slider on a log scale (for step sizes spanning decades). */
  log?: boolean
  /** Integer-valued knob (leapfrog steps, chain count …). */
  integer?: boolean
}

/** What a single MCMC iteration produced — enough to draw it. */
export interface StepResult {
  x: Vec
  logp: number
  accepted: boolean
  /** The proposed point, when there is a discrete proposal (RWM/MALA). */
  proposal?: Vec | null
  /** A path to draw — HMC/NUTS leapfrog arcs, or a slice bracket. */
  trajectory?: Vec[] | null
  /** All tempered-chain positions, for parallel tempering. */
  chains?: Vec[] | null
}

export interface Sampler {
  x: Vec
  logp: number
  /** Advance exactly one iteration of the chain. */
  step: () => StepResult
  /** Cumulative work, so we can price a sample in evaluations. */
  densityEvals: number
  gradEvals: number
}

export interface SamplerDef {
  id: string
  name: string
  blurb: string
  usesGradient: boolean
  params: ParamSpec[]
  create: (target: Target, rng: RNG, params: Record<string, number>) => Sampler
}
