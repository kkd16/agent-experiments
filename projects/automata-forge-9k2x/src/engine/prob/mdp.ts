// The MDP model-checking engine. An MDP adds *choice* on top of a Markov chain: at each state a
// scheduler (a.k.a. policy/adversary) picks one action, and only then does chance act. The two
// questions that matter are the extremal ones — over ALL schedulers, what is the maximum (or minimum)
// probability of reaching the goal? Pmax answers "is there a controller that succeeds w.p. ≥ p?";
// Pmin answers "can every controller be forced to fail?", the adversary's view used for guarantees.
//
// Reachability objectives are positionally determined: a single memoryless deterministic policy
// attains the optimum. So the engine iterates the Bellman optimality operator to the value, then reads
// off the optimal action per state — and the induced DTMC gives an EXACT rational certificate of that
// value, cross-checked in the Verify tab against a brute-force scan of every deterministic policy.

import type { MDP, DTMC, Dist } from './types.ts'
import type { Frac } from './frac.ts'
import { ftoNumber } from './frac.ts'
import { untilExact } from './dtmc.ts'

export type Opt = 'max' | 'min'

const ALL = (n: number): boolean[] => new Array<boolean>(n).fill(true)

/** The DTMC induced by fixing one action per state (`policy[s]` indexes `mdp.actions[s]`). */
export function inducedDTMC(m: MDP, policy: number[]): DTMC {
  const trans: Dist[] = []
  for (let s = 0; s < m.n; s++) {
    const menu = m.actions[s]
    const a = menu[Math.max(0, Math.min(menu.length - 1, policy[s]))]
    trans[s] = a.dist.map((e) => ({ ...e }))
  }
  return {
    kind: 'dtmc',
    n: m.n,
    labels: [...m.labels],
    init: m.init,
    props: [...m.props],
    label: m.label.map((l) => new Set(l)),
    trans,
    pos: m.pos.map((p) => ({ ...p })),
  }
}

/**
 * Value iteration for the extremal probability of φ U ψ. Returns the value per state and an optimal
 * memoryless policy (the action attaining the extremum). ψ-states are 1, states outside φ (and not ψ)
 * are 0; everywhere else the value is opt_a Σ P(s,·|a)·x, iterated from 0 to the least fixed point.
 */
export function optimalUntilFloat(
  m: MDP,
  phi: boolean[],
  psi: boolean[],
  opt: Opt,
  maxIter = 200000,
  tol = 1e-12,
): { value: number[]; policy: number[]; iters: number } {
  // Pre-convert probabilities to floats once.
  const P: { to: number; p: number }[][][] = m.actions.map((menu) => menu.map((a) => a.dist.map((e) => ({ to: e.to, p: ftoNumber(e.p) }))))
  let x = new Array<number>(m.n).fill(0)
  for (let s = 0; s < m.n; s++) if (psi[s]) x[s] = 1
  const policy = new Array<number>(m.n).fill(0)
  let iters = 0
  for (; iters < maxIter; iters++) {
    const next = new Array<number>(m.n)
    let delta = 0
    for (let s = 0; s < m.n; s++) {
      if (psi[s]) {
        next[s] = 1
        continue
      }
      if (!phi[s]) {
        next[s] = 0
        continue
      }
      let best = opt === 'max' ? -Infinity : Infinity
      let bestA = 0
      const menu = P[s]
      for (let ai = 0; ai < menu.length; ai++) {
        let v = 0
        for (const e of menu[ai]) v += e.p * x[e.to]
        if (opt === 'max' ? v > best + 1e-15 : v < best - 1e-15) {
          best = v
          bestA = ai
        }
      }
      next[s] = best
      policy[s] = bestA
    }
    for (let s = 0; s < m.n; s++) {
      const d = Math.abs(next[s] - x[s])
      if (d > delta) delta = d
    }
    x = next
    if (delta < tol) {
      iters++
      break
    }
  }
  return { value: x, policy, iters }
}

export function optimalReachFloat(m: MDP, psi: boolean[], opt: Opt): { value: number[]; policy: number[]; iters: number } {
  return optimalUntilFloat(m, ALL(m.n), psi, opt)
}

/** Extremal Pr(X ψ): opt over actions of the one-step probability of landing in ψ. */
export function optimalNextFloat(m: MDP, psi: boolean[], opt: Opt): number[] {
  const out = new Array<number>(m.n).fill(0)
  for (let s = 0; s < m.n; s++) {
    let best = opt === 'max' ? -Infinity : Infinity
    for (const a of m.actions[s]) {
      let v = 0
      for (const e of a.dist) if (psi[e.to]) v += ftoNumber(e.p)
      if (opt === 'max' ? v > best : v < best) best = v
    }
    out[s] = best
  }
  return out
}

/** Extremal step-bounded Pr(φ U^{≤k} ψ) by k rounds of Bellman optimality iteration. */
export function optimalBoundedUntilFloat(m: MDP, phi: boolean[], psi: boolean[], opt: Opt, k: number): number[] {
  const P = m.actions.map((menu) => menu.map((a) => a.dist.map((e) => ({ to: e.to, p: ftoNumber(e.p) }))))
  let x = new Array<number>(m.n).fill(0)
  for (let s = 0; s < m.n; s++) if (psi[s]) x[s] = 1
  for (let step = 0; step < k; step++) {
    const next = new Array<number>(m.n)
    for (let s = 0; s < m.n; s++) {
      if (psi[s]) {
        next[s] = 1
        continue
      }
      if (!phi[s]) {
        next[s] = 0
        continue
      }
      let best = opt === 'max' ? -Infinity : Infinity
      for (const menu of P[s]) {
        let v = 0
        for (const e of menu) v += e.p * x[e.to]
        if (opt === 'max' ? v > best : v < best) best = v
      }
      next[s] = best
    }
    x = next
  }
  return x
}

/**
 * The EXACT value of the optimal policy VI extracted, computed by solving the induced DTMC's linear
 * system in rationals. For an optimal reachability policy this equals the true extremal probability —
 * so it is a rational certificate for a float value iteration.
 */
export function policyValueExact(m: MDP, policy: number[], phi: boolean[], psi: boolean[]): Frac[] {
  return untilExact(inducedDTMC(m, policy), phi, psi)
}

/**
 * Exact optimal reachability by Howard's POLICY ITERATION, entirely in rationals: evaluate the current
 * policy exactly (a linear solve on its induced DTMC), then switch each state to the action whose exact
 * one-step look-ahead strictly improves it, and repeat until no state changes. It returns the EXACT
 * optimal value vector and an optimal memoryless policy — the rational ground truth the float value
 * iteration is graded against, and the strategy the UI displays.
 *
 * The policy is SEEDED from the value-iteration greedy policy rather than an arbitrary one: that seed
 * already routes toward (or away from) the goal wherever it should, so exact improvement only has to
 * polish float tie-breaks — it never has to bootstrap out of a zero-probability trap, the failure mode
 * of reachability policy iteration started cold.
 */
export function policyIterationExact(
  m: MDP,
  phi: boolean[],
  psi: boolean[],
  opt: Opt,
): { value: Frac[]; policy: number[] } {
  const policy = optimalUntilFloat(m, phi, psi, opt).policy.slice()
  const cap = 8 * m.n * m.actions.reduce((mx, a) => Math.max(mx, a.length), 1) + 100
  let value = untilExact(inducedDTMC(m, policy), phi, psi)
  for (let iter = 0; iter < cap; iter++) {
    let improved = false
    for (let s = 0; s < m.n; s++) {
      if (psi[s] || !phi[s]) continue
      let bestA = policy[s]
      let bestVal = lookahead(m, s, policy[s], value)
      for (let ai = 0; ai < m.actions[s].length; ai++) {
        const val = lookahead(m, s, ai, value)
        const c = cmpFrac(val, bestVal)
        if (opt === 'max' ? c > 0 : c < 0) {
          bestVal = val
          bestA = ai
        }
      }
      if (bestA !== policy[s]) {
        policy[s] = bestA
        improved = true
      }
    }
    if (!improved) break
    value = untilExact(inducedDTMC(m, policy), phi, psi)
  }
  return { value, policy }
}

function lookahead(m: MDP, s: number, ai: number, v: Frac[]): Frac {
  // Σ_t P(s,t|a) · v[t], exact.
  let nAcc = 0n
  let dAcc = 1n
  for (const e of m.actions[s][ai].dist) {
    // add e.p * v[e.to]
    const tn = e.p.n * v[e.to].n
    const td = e.p.d * v[e.to].d
    nAcc = nAcc * td + tn * dAcc
    dAcc = dAcc * td
    const g = gcdB(nAcc < 0n ? -nAcc : nAcc, dAcc) || 1n
    nAcc /= g
    dAcc /= g
  }
  return { n: nAcc, d: dAcc }
}
function gcdB(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b]
  return a
}
function cmpFrac(a: Frac, b: Frac): number {
  const l = a.n * b.d
  const r = b.n * a.d
  return l < r ? -1 : l > r ? 1 : 0
}

/**
 * Brute-force oracle: enumerate every memoryless deterministic policy, solve each induced DTMC
 * exactly, and take the pointwise max/min. Exact and structurally independent of value iteration —
 * the Verify tab's referee — but only tractable for small MDPs, so it caps the policy count.
 */
export function bruteForceOptimal(
  m: MDP,
  phi: boolean[],
  psi: boolean[],
  opt: Opt,
  cap = 20000,
): { value: Frac[]; policy: number[] } | null {
  const counts = m.actions.map((a) => a.length)
  let total = 1
  for (const c of counts) {
    total *= c
    if (total > cap) return null
  }
  // Pointwise extremal value over all policies, plus one policy attaining the extremum at init.
  const best: Frac[] = new Array(m.n)
  let bestPolicy: number[] = []
  let haveBest = false
  const policy = new Array<number>(m.n).fill(0)
  for (let p = 0; p < total; p++) {
    let rem = p // decode p into a mixed-radix policy
    for (let s = 0; s < m.n; s++) {
      policy[s] = rem % counts[s]
      rem = Math.floor(rem / counts[s])
    }
    const val = untilExact(inducedDTMC(m, policy), phi, psi)
    if (!haveBest) {
      for (let s = 0; s < m.n; s++) best[s] = val[s]
      bestPolicy = policy.slice()
      haveBest = true
      continue
    }
    // Does this policy strictly beat the incumbent at init? Track it for the displayed strategy.
    const li = val[m.init].n * best[m.init].d
    const ri = best[m.init].n * val[m.init].d
    if (opt === 'max' ? li > ri : li < ri) bestPolicy = policy.slice()
    for (let s = 0; s < m.n; s++) {
      const l = val[s].n * best[s].d
      const r = best[s].n * val[s].d
      if (opt === 'max' ? l > r : l < r) best[s] = val[s]
    }
  }
  return haveBest ? { value: best, policy: bestPolicy } : null
}

export function bruteForceReach(m: MDP, psi: boolean[], opt: Opt, cap = 20000): { value: Frac[]; policy: number[] } | null {
  return bruteForceOptimal(m, ALL(m.n), psi, opt, cap)
}
