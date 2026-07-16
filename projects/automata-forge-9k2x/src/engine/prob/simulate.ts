// Monte-Carlo simulation — the third, structurally-independent way the lab computes a probability.
// Where `dtmc.ts` solves a linear system and value iteration reaches a fixpoint, this just *rolls the
// dice* many times and counts. It powers two things: the Run tab's animated sample path, and the
// Verify tab's law-of-large-numbers check that the empirical frequency lands within a statistical
// tolerance of the exact rational answer. A seeded PRNG keeps every run reproducible (and safe in the
// sandboxed catalog thumbnail, where a real RNG is fine but determinism makes the demo repeatable).

import type { Model, Dist } from './types.ts'
import { ftoNumber } from './frac.ts'

/** Deterministic 32-bit PRNG (mulberry32) — reproducible sample paths from a seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A policy for an MDP: the action index to take at each state. */
export type Policy = number[]

function pickNext(dist: Dist, r: number): number {
  let acc = 0
  for (const e of dist) {
    acc += ftoNumber(e.p)
    if (r < acc) return e.to
  }
  return dist[dist.length - 1].to // guard against float round-off
}

/** One step of the model from state `s`, returning the next state and (for MDPs) the action taken. */
function step(m: Model, s: number, rand: () => number, policy?: Policy): { to: number; action: string | null } {
  if (m.kind === 'dtmc') return { to: pickNext(m.trans[s], rand()), action: null }
  const menu = m.actions[s]
  const ai = policy ? Math.max(0, Math.min(menu.length - 1, policy[s])) : Math.floor(rand() * menu.length)
  const a = menu[ai]
  return { to: pickNext(a.dist, rand()), action: a.name }
}

export interface SamplePath {
  states: number[]
  actions: (string | null)[]
}

/** A single reproducible sample path of up to `steps` transitions from the initial state. */
export function samplePath(m: Model, seed: number, steps: number, policy?: Policy): SamplePath {
  const rand = mulberry32(seed)
  const states: number[] = [m.init]
  const actions: (string | null)[] = []
  let s = m.init
  for (let i = 0; i < steps; i++) {
    const { to, action } = step(m, s, rand, policy)
    states.push(to)
    actions.push(action)
    s = to
  }
  return { states, actions }
}

export interface EstimateResult {
  estimate: number
  hits: number
  trials: number
  /** 95% Wald half-width √(p(1−p)/N), so the UI can print a confidence band. */
  stderr95: number
}

function band(hits: number, trials: number): EstimateResult {
  const p = trials > 0 ? hits / trials : 0
  const stderr95 = 1.96 * Math.sqrt(Math.max(0, p * (1 - p)) / Math.max(1, trials))
  return { estimate: p, hits, trials, stderr95 }
}

/**
 * Estimate Pr(φ U ψ) by simulation: a run succeeds the instant it enters a ψ-state, fails if it
 * leaves the φ-region without ψ, and is counted a failure if it runs `maxSteps` without deciding
 * (rare for the gallery, where the maybe-region is transient). φ defaults to "always true" ⇒ F ψ.
 */
export function estimateUntil(
  m: Model,
  phi: boolean[],
  psi: boolean[],
  seed: number,
  trials: number,
  maxSteps = 2000,
  policy?: Policy,
): EstimateResult {
  const rand = mulberry32(seed)
  let hits = 0
  for (let t = 0; t < trials; t++) {
    let s = m.init
    if (psi[s]) {
      hits++
      continue
    }
    for (let i = 0; i < maxSteps; i++) {
      if (!phi[s] && !psi[s]) break // fell out of φ before ψ ⇒ failure
      const { to } = step(m, s, rand, policy)
      s = to
      if (psi[s]) {
        hits++
        break
      }
      if (!phi[s]) break
    }
  }
  return band(hits, trials)
}

/** Estimate step-bounded Pr(φ U^{≤k} ψ) by simulation. */
export function estimateBoundedUntil(
  m: Model,
  phi: boolean[],
  psi: boolean[],
  k: number,
  seed: number,
  trials: number,
  policy?: Policy,
): EstimateResult {
  const rand = mulberry32(seed)
  let hits = 0
  for (let t = 0; t < trials; t++) {
    let s = m.init
    if (psi[s]) {
      hits++
      continue
    }
    for (let i = 0; i < k; i++) {
      if (!phi[s]) break
      const { to } = step(m, s, rand, policy)
      s = to
      if (psi[s]) {
        hits++
        break
      }
    }
  }
  return band(hits, trials)
}
