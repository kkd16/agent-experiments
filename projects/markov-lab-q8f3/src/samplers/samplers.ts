// Eight Markov-chain Monte Carlo samplers, all written from scratch, all
// driving the *same* Target interface (unnormalised log-density + gradient).
// The whole point of the studio is to watch how differently they move.

import type { Vec } from '../math/linalg'
import { add, cholesky, dot, matVec, scale, sub } from '../math/linalg'
import type { RNG } from '../math/rng'
import type { Target } from '../targets/targets'
import type { Sampler, SamplerDef, StepResult } from './types'

// ── Random-Walk Metropolis ──────────────────────────────────────────────────
function makeRWM(target: Target, rng: RNG, p: Record<string, number>): Sampler {
  const eps = p.step
  const s: Sampler = {
    x: target.start.slice(),
    logp: target.logDensity(target.start),
    densityEvals: 1,
    gradEvals: 0,
    step(): StepResult {
      const prop = this.x.map((v) => v + rng.normal(0, eps))
      const lp = target.logDensity(prop)
      this.densityEvals++
      const accept = Math.log(rng.next()) < lp - this.logp
      if (accept) {
        this.x = prop
        this.logp = lp
      }
      return { x: this.x, logp: this.logp, accepted: accept, proposal: prop }
    },
  }
  return s
}

// ── Adaptive Metropolis (Haario, Saksman & Tamminen 2001) ───────────────────
// The proposal covariance is *learned* from the chain's own history:
// C ← s_d (Cov(samples) + εI), with s_d = 2.4²/d the optimal scaling.
function makeAdaptive(target: Target, rng: RNG, p: Record<string, number>): Sampler {
  const d = target.start.length
  const sd = (2.4 * 2.4) / d
  const eps0 = p.step
  let mean = target.start.slice()
  const cov = Array.from({ length: d }, (_, i) =>
    Array.from({ length: d }, (_, j) => (i === j ? eps0 * eps0 : 0)),
  )
  let n = 1
  const warmup = 25 // iterations before we trust the empirical covariance

  const s: Sampler = {
    x: target.start.slice(),
    logp: target.logDensity(target.start),
    densityEvals: 1,
    gradEvals: 0,
    step(): StepResult {
      // Proposal covariance: empirical once warmed up, else the seed diagonal.
      const scaledCov =
        n > warmup
          ? cov.map((row, i) => row.map((v, j) => sd * (v + (i === j ? 1e-6 : 0))))
          : cov
      const L = cholesky(scaledCov)
      const z = rng.normalVec(d)
      const prop = add(this.x, matVec(L, z))
      const lp = target.logDensity(prop)
      this.densityEvals++
      const accept = Math.log(rng.next()) < lp - this.logp
      if (accept) {
        this.x = prop
        this.logp = lp
      }
      // Online update of running mean + covariance (Welford-style).
      const x = this.x
      n++
      const delta = sub(x, mean)
      mean = add(mean, scale(delta, 1 / n))
      const delta2 = sub(x, mean)
      for (let i = 0; i < d; i++)
        for (let j = 0; j < d; j++)
          cov[i][j] = ((n - 1) * cov[i][j] + delta[i] * delta2[j]) / n
      return { x: this.x, logp: this.logp, accepted: accept, proposal: prop }
    },
  }
  return s
}

// ── Metropolis-Adjusted Langevin (MALA) ─────────────────────────────────────
// A Langevin drift toward higher density plus noise, made exact by an MH
// accept/reject that corrects the discretisation bias.
function makeMALA(target: Target, rng: RNG, p: Record<string, number>): Sampler {
  const eps = p.step
  const tau = eps * eps

  const logQ = (to: Vec, from: Vec, gradFrom: Vec): number => {
    // log N(to; from + 0.5 τ ∇log π(from), τ I)
    const mean = add(from, scale(gradFrom, 0.5 * tau))
    const diff = sub(to, mean)
    return -dot(diff, diff) / (2 * tau)
  }

  const s: Sampler = {
    x: target.start.slice(),
    logp: target.logDensity(target.start),
    densityEvals: 1,
    gradEvals: 0,
    step(): StepResult {
      const grad = target.gradLogDensity(this.x)
      this.gradEvals++
      const mean = add(this.x, scale(grad, 0.5 * tau))
      const prop = add(mean, rng.normalVec(this.x.length, eps))
      const lp = target.logDensity(prop)
      const gradProp = target.gradLogDensity(prop)
      this.densityEvals++
      this.gradEvals++
      const logAccept =
        lp - this.logp + logQ(this.x, prop, gradProp) - logQ(prop, this.x, grad)
      const accept = Math.log(rng.next()) < logAccept
      if (accept) {
        this.x = prop
        this.logp = lp
      }
      return { x: this.x, logp: this.logp, accepted: accept, proposal: prop }
    },
  }
  return s
}

// ── Hamiltonian Monte Carlo ─────────────────────────────────────────────────
// Treat −log π as a potential energy, add a momentum, and roll a frictionless
// ball along the level sets with a leapfrog integrator. Long, low-rejection
// jumps that follow the geometry instead of fighting it.
function makeHMC(target: Target, rng: RNG, p: Record<string, number>): Sampler {
  const eps = p.step
  const L = Math.max(1, Math.round(p.leapfrog))

  const s: Sampler = {
    x: target.start.slice(),
    logp: target.logDensity(target.start),
    densityEvals: 1,
    gradEvals: 0,
    step(): StepResult {
      const d = this.x.length
      const mom0 = rng.normalVec(d)
      let x = this.x.slice()
      let mom = mom0.slice()
      let grad = target.gradLogDensity(x)
      this.gradEvals++
      const traj: Vec[] = [x.slice()]
      // Leapfrog integration.
      for (let i = 0; i < L; i++) {
        mom = add(mom, scale(grad, 0.5 * eps)) // half kick
        x = add(x, scale(mom, eps)) // drift
        grad = target.gradLogDensity(x) // new force
        this.gradEvals++
        mom = add(mom, scale(grad, 0.5 * eps)) // half kick
        traj.push(x.slice())
      }
      const lpNew = target.logDensity(x)
      this.densityEvals++
      // H = U + K = −log π + ½|p|².  Accept on the energy difference.
      const H0 = -this.logp + 0.5 * dot(mom0, mom0)
      const H1 = -lpNew + 0.5 * dot(mom, mom)
      const accept = Math.log(rng.next()) < H0 - H1
      if (accept) {
        this.x = x
        this.logp = lpNew
      }
      return { x: this.x, logp: this.logp, accepted: accept, trajectory: traj }
    },
  }
  return s
}

// ── No-U-Turn Sampler (NUTS) ────────────────────────────────────────────────
// HMC that picks its own trajectory length: it doubles the path until the
// endpoints start heading back toward each other (a "U-turn"), then samples a
// state from the whole tree. Simplified (slice-variable, fixed step) version
// of Hoffman & Gelman (2014), Algorithm 3.
function makeNUTS(target: Target, rng: RNG, p: Record<string, number>): Sampler {
  const eps = p.step
  const MAX_DEPTH = 9

  const s: Sampler = {
    x: target.start.slice(),
    logp: target.logDensity(target.start),
    densityEvals: 1,
    gradEvals: 0,
    step: (): StepResult => {
      const d = s.x.length
      const r0 = rng.normalVec(d)
      const jointLog = s.logp - 0.5 * dot(r0, r0)
      const logu = jointLog + Math.log(rng.next() + 1e-300) // slice level

      const traj: Vec[] = []

      const leapfrog = (x: Vec, r: Vec, dir: number): [Vec, Vec, number] => {
        const g = target.gradLogDensity(x)
        s.gradEvals++
        let rr = add(r, scale(g, (dir * eps) / 2))
        const xx = add(x, scale(rr, dir * eps))
        const g2 = target.gradLogDensity(xx)
        s.gradEvals++
        rr = add(rr, scale(g2, (dir * eps) / 2))
        const lp = target.logDensity(xx)
        s.densityEvals++
        return [xx, rr, lp]
      }

      interface Tree {
        xMinus: Vec; rMinus: Vec
        xPlus: Vec; rPlus: Vec
        xProp: Vec; lpProp: number
        nValid: number; keepGoing: boolean
      }

      const uTurn = (xm: Vec, xp: Vec, rm: Vec, rp: Vec): boolean => {
        const dx = sub(xp, xm)
        return dot(dx, rm) >= 0 && dot(dx, rp) >= 0
      }

      const build = (x: Vec, r: Vec, lp: number, dir: number, depth: number): Tree => {
        if (depth === 0) {
          const [x1, r1, lp1] = leapfrog(x, r, dir)
          const joint = lp1 - 0.5 * dot(r1, r1)
          const nValid = logu <= joint ? 1 : 0
          const keepGoing = joint > logu - 1000 // energy sanity (no divergence)
          traj.push(x1.slice())
          return {
            xMinus: x1, rMinus: r1, xPlus: x1, rPlus: r1,
            xProp: x1, lpProp: lp1, nValid, keepGoing,
          }
        }
        const t = build(x, r, lp, dir, depth - 1)
        if (!t.keepGoing) return t
        let t2: Tree
        if (dir === -1) {
          const inner = build(t.xMinus, t.rMinus, t.lpProp, dir, depth - 1)
          t2 = { ...inner, xPlus: t.xPlus, rPlus: t.rPlus }
        } else {
          const inner = build(t.xPlus, t.rPlus, t.lpProp, dir, depth - 1)
          t2 = { ...inner, xMinus: t.xMinus, rMinus: t.rMinus }
        }
        // Choose the proposal from the two subtrees proportionally to their mass.
        const total = t.nValid + t2.nValid
        let xProp = t.xProp
        let lpProp = t.lpProp
        if (total > 0 && rng.next() < t2.nValid / total) {
          xProp = t2.xProp
          lpProp = t2.lpProp
        }
        const keepGoing =
          t.keepGoing && t2.keepGoing &&
          uTurn(t2.xMinus, t2.xPlus, t2.rMinus, t2.rPlus)
        return {
          xMinus: t2.xMinus, rMinus: t2.rMinus, xPlus: t2.xPlus, rPlus: t2.rPlus,
          xProp, lpProp, nValid: total, keepGoing,
        }
      }

      let xMinus = s.x.slice()
      let xPlus = s.x.slice()
      let rMinus = r0.slice()
      let rPlus = r0.slice()
      let xSample = s.x.slice()
      let lpSample = s.logp
      let n = 1
      let depth = 0
      let go = true
      let accepted = false

      while (go && depth < MAX_DEPTH) {
        const dir = rng.next() < 0.5 ? -1 : 1
        let t: Tree
        if (dir === -1) {
          t = build(xMinus, rMinus, lpSample, dir, depth)
          xMinus = t.xMinus
          rMinus = t.rMinus
        } else {
          t = build(xPlus, rPlus, lpSample, dir, depth)
          xPlus = t.xPlus
          rPlus = t.rPlus
        }
        if (t.keepGoing && t.nValid > 0 && rng.next() < t.nValid / n) {
          xSample = t.xProp
          lpSample = t.lpProp
          accepted = true
        }
        n += t.nValid
        go = t.keepGoing && uTurn(xMinus, xPlus, rMinus, rPlus)
        depth++
      }

      s.x = xSample
      s.logp = lpSample
      return { x: s.x, logp: s.logp, accepted, trajectory: traj }
    },
  }
  return s
}

// ── Componentwise (Metropolis-within-Gibbs) ─────────────────────────────────
// Sweep one coordinate at a time, each with its own 1-D Metropolis update.
function makeGibbs(target: Target, rng: RNG, p: Record<string, number>): Sampler {
  const eps = p.step
  const s: Sampler = {
    x: target.start.slice(),
    logp: target.logDensity(target.start),
    densityEvals: 1,
    gradEvals: 0,
    step(): StepResult {
      const d = this.x.length
      let accAny = false
      for (let k = 0; k < d; k++) {
        const prop = this.x.slice()
        prop[k] += rng.normal(0, eps)
        const lp = target.logDensity(prop)
        this.densityEvals++
        if (Math.log(rng.next()) < lp - this.logp) {
          this.x = prop
          this.logp = lp
          accAny = true
        }
      }
      return { x: this.x, logp: this.logp, accepted: accAny }
    },
  }
  return s
}

// ── Slice sampling (Neal 2003) ──────────────────────────────────────────────
// No tuning of a proposal scale: pick a slice height, step an interval out
// under the density, then shrink until a point on the slice is found.
function makeSlice(target: Target, rng: RNG, p: Record<string, number>): Sampler {
  const w = p.step // initial bracket width
  const s: Sampler = {
    x: target.start.slice(),
    logp: target.logDensity(target.start),
    densityEvals: 1,
    gradEvals: 0,
    step(): StepResult {
      const d = this.x.length
      const traj: Vec[] = [this.x.slice()]
      for (let k = 0; k < d; k++) {
        const y = this.logp + Math.log(rng.next() + 1e-300) // slice level
        // Step out.
        let lo = this.x[k] - w * rng.next()
        let hi = lo + w
        const evalAt = (val: number): number => {
          const q = this.x.slice()
          q[k] = val
          this.densityEvals++
          return target.logDensity(q)
        }
        let guardL = 24
        while (evalAt(lo) > y && guardL-- > 0) lo -= w
        let guardR = 24
        while (evalAt(hi) > y && guardR-- > 0) hi += w
        // Shrink.
        let val = this.x[k]
        let lpNew = this.logp
        for (let it = 0; it < 40; it++) {
          val = lo + rng.next() * (hi - lo)
          lpNew = evalAt(val)
          if (lpNew > y) break
          if (val < this.x[k]) lo = val
          else hi = val
        }
        this.x[k] = val
        this.logp = lpNew
        traj.push(this.x.slice())
      }
      return { x: this.x, logp: this.logp, accepted: true, trajectory: traj }
    },
  }
  return s
}

// ── Parallel Tempering (replica exchange) ───────────────────────────────────
// Run several chains at temperatures 1 = T₀ < T₁ < … . Hot chains roam
// freely across modes; periodic swaps let the cold chain (the one we keep)
// teleport between wells it could never cross on its own.
function makePT(target: Target, rng: RNG, p: Record<string, number>): Sampler {
  const eps = p.step
  const K = Math.max(2, Math.round(p.replicas))
  // Geometric temperature ladder.
  const betas: number[] = []
  for (let k = 0; k < K; k++) betas.push(Math.pow(0.5, k)) // 1, .5, .25, …
  const xs: Vec[] = betas.map(() => target.start.slice())
  const lps: number[] = xs.map((x) => target.logDensity(x))
  let evals = K

  const s: Sampler = {
    x: xs[0].slice(),
    logp: lps[0],
    densityEvals: evals,
    gradEvals: 0,
    step(): StepResult {
      // One RWM step per replica at its own temperature.
      for (let k = 0; k < K; k++) {
        const prop = xs[k].map((v) => v + rng.normal(0, eps / Math.sqrt(betas[k])))
        const lp = target.logDensity(prop)
        evals++
        if (Math.log(rng.next()) < betas[k] * (lp - lps[k])) {
          xs[k] = prop
          lps[k] = lp
        }
      }
      // Propose one adjacent swap.
      const k = Math.floor(rng.next() * (K - 1))
      const logRatio = (betas[k] - betas[k + 1]) * (lps[k + 1] - lps[k])
      if (Math.log(rng.next()) < logRatio) {
        ;[xs[k], xs[k + 1]] = [xs[k + 1], xs[k]]
        ;[lps[k], lps[k + 1]] = [lps[k + 1], lps[k]]
      }
      this.x = xs[0].slice()
      this.logp = lps[0]
      this.densityEvals = evals
      return {
        x: this.x,
        logp: this.logp,
        accepted: true,
        chains: xs.map((x) => x.slice()),
      }
    },
  }
  return s
}

export const SAMPLERS: SamplerDef[] = [
  {
    id: 'rwm',
    name: 'Random-Walk Metropolis',
    blurb: 'Gaussian jumps, accept/reject. The 1953 original — simple, universal, slow.',
    usesGradient: false,
    params: [{ key: 'step', label: 'proposal σ', min: 0.02, max: 4, step: 0.01, default: 0.7, log: true }],
    create: makeRWM,
  },
  {
    id: 'adaptive',
    name: 'Adaptive Metropolis',
    blurb: 'Learns the target’s shape from its own history and reshapes its proposal.',
    usesGradient: false,
    params: [{ key: 'step', label: 'seed σ', min: 0.05, max: 3, step: 0.01, default: 0.5, log: true }],
    create: makeAdaptive,
  },
  {
    id: 'mala',
    name: 'MALA (Langevin)',
    blurb: 'A gradient nudge uphill plus noise, corrected by Metropolis. Directed diffusion.',
    usesGradient: true,
    params: [{ key: 'step', label: 'step ε', min: 0.05, max: 2, step: 0.01, default: 0.55, log: true }],
    create: makeMALA,
  },
  {
    id: 'hmc',
    name: 'Hamiltonian MC',
    blurb: 'Simulate physics: momentum + leapfrog. Long, distant, low-rejection jumps.',
    usesGradient: true,
    params: [
      { key: 'step', label: 'step ε', min: 0.02, max: 0.6, step: 0.005, default: 0.14, log: true },
      { key: 'leapfrog', label: 'leapfrog L', min: 3, max: 60, step: 1, default: 22, integer: true },
    ],
    create: makeHMC,
  },
  {
    id: 'nuts',
    name: 'NUTS',
    blurb: 'HMC that stops itself at the U-turn — no path length to tune. Stan’s workhorse.',
    usesGradient: true,
    params: [{ key: 'step', label: 'step ε', min: 0.02, max: 0.6, step: 0.005, default: 0.18, log: true }],
    create: makeNUTS,
  },
  {
    id: 'gibbs',
    name: 'Metropolis-within-Gibbs',
    blurb: 'Update one coordinate at a time. Axis-aligned sweeps; struggles when tilted.',
    usesGradient: false,
    params: [{ key: 'step', label: 'proposal σ', min: 0.05, max: 3, step: 0.01, default: 0.8, log: true }],
    create: makeGibbs,
  },
  {
    id: 'slice',
    name: 'Slice Sampling',
    blurb: 'No accept/reject and almost no tuning — bracket the slice, then shrink.',
    usesGradient: false,
    params: [{ key: 'step', label: 'bracket w', min: 0.2, max: 6, step: 0.05, default: 2, log: true }],
    create: makeSlice,
  },
  {
    id: 'pt',
    name: 'Parallel Tempering',
    blurb: 'A ladder of hot replicas swapping states — the cure for isolated modes.',
    usesGradient: false,
    params: [
      { key: 'step', label: 'proposal σ', min: 0.1, max: 3, step: 0.01, default: 0.9, log: true },
      { key: 'replicas', label: 'replicas', min: 2, max: 8, step: 1, default: 5, integer: true },
    ],
    create: makePT,
  },
]

export const samplerById = (id: string): SamplerDef =>
  SAMPLERS.find((s) => s.id === id) ?? SAMPLERS[0]
