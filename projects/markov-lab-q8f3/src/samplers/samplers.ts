// Eight Markov-chain Monte Carlo samplers, all written from scratch, all
// driving the *same* Target interface (unnormalised log-density + gradient).
// The whole point of the studio is to watch how differently they move.

import type { Vec } from '../math/linalg'
import { add, cholesky, dot, eigSym2, matVec, norm2, scale, sub, symFromEig } from '../math/linalg'
import type { RNG } from '../math/rng'
import type { Target } from '../targets/targets'
import { DualAveraging } from './adapt'
import type { Sampler, SamplerDef, StepResult } from './types'

/** How many iterations HMC/NUTS spend auto-tuning ε before freezing it. */
const WARMUP = 400

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
  const L = Math.max(1, Math.round(p.leapfrog))
  const da = p.adapt > 0.5 ? new DualAveraging(p.step, p.targetAccept, WARMUP) : null
  let eps = da ? da.eps : p.step

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
      const dH = H0 - H1
      const accProb = Number.isFinite(dH) ? Math.min(1, Math.exp(dH)) : 0
      const accept = Math.log(rng.next()) < dH
      if (accept) {
        this.x = x
        this.logp = lpNew
      }
      // Dual-averaging warmup tunes ε toward the target acceptance δ.
      if (da) eps = da.update(accProb)
      return {
        x: this.x, logp: this.logp, accepted: accept, trajectory: traj,
        info: { eps, acc: accProb },
      }
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
  const MAX_DEPTH = 9
  const da = p.adapt > 0.5 ? new DualAveraging(p.step, p.targetAccept, WARMUP) : null
  let eps = da ? da.eps : p.step

  const s: Sampler = {
    x: target.start.slice(),
    logp: target.logDensity(target.start),
    densityEvals: 1,
    gradEvals: 0,
    step: (): StepResult => {
      const d = s.x.length
      const r0 = rng.normalVec(d)
      const joint0 = s.logp - 0.5 * dot(r0, r0) // initial Hamiltonian (negated)
      const logu = joint0 + Math.log(rng.next() + 1e-300) // slice level

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
        aSum: number; nA: number // for dual-averaging: Σ min(1,e^{ΔH}) and count
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
          const dH = joint - joint0
          const aSum = Number.isFinite(dH) ? Math.min(1, Math.exp(dH)) : 0
          traj.push(x1.slice())
          return {
            xMinus: x1, rMinus: r1, xPlus: x1, rPlus: r1,
            xProp: x1, lpProp: lp1, nValid, keepGoing, aSum, nA: 1,
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
          aSum: t.aSum + t2.aSum, nA: t.nA + t2.nA,
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
      let aSumTot = 0
      let nATot = 0

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
        aSumTot += t.aSum
        nATot += t.nA
        n += t.nValid
        go = t.keepGoing && uTurn(xMinus, xPlus, rMinus, rPlus)
        depth++
      }

      s.x = xSample
      s.logp = lpSample
      // Average Metropolis acceptance over the whole tree drives adaptation.
      const accProb = nATot > 0 ? aSumTot / nATot : 0
      if (da) eps = da.update(accProb)
      return {
        x: s.x, logp: s.logp, accepted, trajectory: traj,
        info: { eps, depth, acc: accProb },
      }
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

// ── Affine-Invariant Ensemble (Goodman & Weare 2010) ────────────────────────
// The engine behind `emcee`. A *population* of K walkers explores together: to
// move walker k, pick another walker j and propose a point on the line through
// them, stretched by z ~ g(z) ∝ 1/√z on [1/a, a]. The Jacobian of that stretch
// puts a z^{d−1} factor in the accept ratio. The whole scheme is invariant to
// any affine transform of the space, so a skewed, correlated target is no
// harder than a spherical one — *without* a gradient or a tuned covariance.
function makeEnsemble(target: Target, rng: RNG, p: Record<string, number>): Sampler {
  const K = Math.max(4, Math.round(p.walkers))
  const a = Math.max(1.2, p.stretch) // stretch scale a > 1
  const d = target.start.length
  // Scatter the walkers so the ensemble spans a volume (a collapsed ensemble
  // can't move — the stretch of a zero-length line is zero).
  const xs: Vec[] = []
  const lps: number[] = []
  let evals = 0
  for (let k = 0; k < K; k++) {
    const x = target.start.map((v) => v + rng.normal(0, 0.75))
    xs.push(x)
    lps.push(target.logDensity(x))
    evals++
  }

  const s: Sampler = {
    x: xs[0].slice(),
    logp: lps[0],
    densityEvals: evals,
    gradEvals: 0,
    step(): StepResult {
      for (let k = 0; k < K; k++) {
        // A partner walker j ≠ k, uniformly.
        let j = Math.floor(rng.next() * (K - 1))
        if (j >= k) j++
        // z from the inverse CDF of g(z) ∝ 1/√z on [1/a, a].
        const u = rng.next()
        const z = ((a - 1) * u + 1) ** 2 / a
        const prop = xs[k].map((v, i) => xs[j][i] + z * (v - xs[j][i]))
        const lp = target.logDensity(prop)
        evals++
        const logAccept = (d - 1) * Math.log(z) + lp - lps[k]
        if (Math.log(rng.next()) < logAccept) {
          xs[k] = prop
          lps[k] = lp
        }
      }
      // Walker 0 is the canonical chain the diagnostics read; the whole
      // ensemble is drawn through the `chains` overlay.
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

// ── Bouncy Particle Sampler (Bouchard-Côté, Vollmer & Doucet 2018) ──────────
// A *non-reversible*, continuous-time PDMP. A particle flies in a straight line
// and *bounces* off the potential U = −log π: at rate max(0, ⟨v, ∇U⟩) it
// reflects its velocity in the gradient hyperplane, v ← v − 2⟨v,∇U⟩∇U/‖∇U‖².
// Independent Poisson "refreshment" events resample v ∼ N(0,I) to guarantee
// ergodicity. This is a time-discretised (thinned) simulation: we march the
// flow in small steps and fire each event with probability 1 − e^{−rate·dt}.
function makeBPS(target: Target, rng: RNG, p: Record<string, number>): Sampler {
  const T = Math.max(0.5, p.pathlen) // flow time simulated per recorded sample
  const lref = Math.max(0, p.refresh) // refreshment rate
  const dtBase = 0.03 // nominal integration step
  // Cap how far the particle may travel per sub-step. Fixed time-stepping lets a
  // fast particle punch deep into a steep wall before its single bounce fires,
  // which over-disperses the samples; capping the *spatial* step keeps the
  // event resolution fine exactly where the gradient is large.
  const maxStep = 0.06
  const d = target.start.length
  let v = rng.normalVec(d)

  const s: Sampler = {
    x: target.start.slice(),
    logp: target.logDensity(target.start),
    densityEvals: 1,
    gradEvals: 0,
    step(): StepResult {
      let x = this.x.slice()
      const traj: Vec[] = [x.slice()]
      let bounces = 0
      let elapsed = 0
      let guard = 0
      while (elapsed < T && guard < 4000) {
        guard++
        const speed = norm2(v) || 1e-9
        const h = Math.min(dtBase, maxStep / speed) // adaptive sub-step
        x = x.map((c, k) => c + v[k] * h) // deterministic drift
        const grad = target.gradLogDensity(x) // ∇log π
        this.gradEvals++
        const gU: Vec = grad.map((g) => -g) // ∇U = −∇log π
        const vU = dot(v, gU)
        const rate = Math.max(0, vU) // bounce intensity
        if (rate > 0 && rng.next() < 1 - Math.exp(-rate * h)) {
          const nn = dot(gU, gU) || 1e-12
          const c = (2 * vU) / nn
          v = v.map((vk, k) => vk - c * gU[k]) // specular reflection (‖v‖ preserved)
          bounces++
        }
        if (lref > 0 && rng.next() < 1 - Math.exp(-lref * h)) {
          v = rng.normalVec(d) // velocity refreshment
        }
        traj.push(x.slice())
        elapsed += h
      }
      this.x = x
      this.logp = target.logDensity(x)
      this.densityEvals++
      return {
        x: this.x,
        logp: this.logp,
        accepted: true,
        trajectory: traj,
        info: { speed: norm2(v), bounces },
      }
    },
  }
  return s
}

// ── Barker proposal (Livingstone & Zanella 2022) ────────────────────────────
// A first-order (gradient) sampler built for *robustness to step-size choice*.
// Per coordinate, draw a symmetric jump z ∼ N(0, σ²), then keep it (+z) with
// probability 1/(1 + e^{−z·∂ᵢlogπ}) and flip it (−z) otherwise — skewing the
// move toward higher density. An exact, numerically-stable Metropolis ratio
// (softplus form) corrects it. Where MALA's acceptance collapses if ε is a
// touch too large, Barker degrades gently — its whole selling point.
function makeBarker(target: Target, rng: RNG, p: Record<string, number>): Sampler {
  const sigma = p.step
  // log(1 + e^t), overflow-safe.
  const softplus = (t: number): number =>
    t > 0 ? t + Math.log1p(Math.exp(-t)) : Math.log1p(Math.exp(t))

  const s: Sampler = {
    x: target.start.slice(),
    logp: target.logDensity(target.start),
    densityEvals: 1,
    gradEvals: 0,
    step(): StepResult {
      const g = target.gradLogDensity(this.x)
      this.gradEvals++
      const d = this.x.length
      const b = new Array<number>(d)
      for (let i = 0; i < d; i++) {
        const z = rng.normal(0, sigma)
        const pKeep = 1 / (1 + Math.exp(-z * g[i]))
        b[i] = rng.next() < pKeep ? z : -z
      }
      const prop = this.x.map((v, i) => v + b[i])
      const lp = target.logDensity(prop)
      const gp = target.gradLogDensity(prop)
      this.densityEvals++
      this.gradEvals++
      // Metropolis correction: Σ softplus(−bᵢgᵢ(x)) − softplus(bᵢgᵢ(y)).
      let corr = 0
      for (let i = 0; i < d; i++) corr += softplus(-b[i] * g[i]) - softplus(b[i] * gp[i])
      const logAccept = lp - this.logp + corr
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

// ── Riemannian-metric MALA (simplified manifold MALA) ───────────────────────
// The cure for Neal's funnel. Ordinary MALA/HMC use one global step size, so a
// step that survives the funnel's narrow neck is uselessly small in its wide
// mouth (and vice-versa). Riemannian MCMC (Girolami & Calderhead 2011) instead
// gives the proposal a *position-dependent* covariance G(x)⁻¹ built from the
// local curvature — big steps where the density is flat, tiny steps where it is
// sharp — so a single ε works everywhere. We use the simplified (drift-only)
// manifold MALA: propose x' ∼ N(x + ½ε²·G⁻¹∇logπ, ε²·G⁻¹) with an exact
// Metropolis–Hastings correction over the state-dependent proposal. The metric
// is a SoftAbs-style regularisation of the potential's Hessian
// A = −∇²logπ: G = Q·√(λ² + λ₀²)·Qᵀ, which stays positive-definite even where A
// is indefinite. The Hessian comes from central differences of the *analytic*
// gradient, so the sampler still only needs logπ and ∇logπ from a target.
function makeRMMALA(target: Target, rng: RNG, p: Record<string, number>): Sampler {
  const eps = p.step
  const floor = Math.max(1e-3, p.floor) // λ₀: caps the largest step in flat regions
  const d = target.start.length
  const hh = 1e-4 // finite-difference spacing for the Hessian

  interface MetricState {
    logp: number
    G: Vec[] // metric (for the reverse-proposal quadratic form)
    Ghalfinv: Vec[] // G^{-1/2} (to shape the proposal noise)
    logdetG: number
    mean: Vec // drift mean of the proposal launched from this state
  }

  let dEvals = 0
  let gEvals = 0

  const metricAt = (x: Vec): MetricState => {
    const logp = target.logDensity(x)
    dEvals++
    const grad = target.gradLogDensity(x)
    gEvals++
    // Hessian of logπ via central differences of the gradient.
    const col: Vec[] = []
    for (let i = 0; i < d; i++) {
      const xp = x.slice()
      const xm = x.slice()
      xp[i] += hh
      xm[i] -= hh
      const gp = target.gradLogDensity(xp)
      const gm = target.gradLogDensity(xm)
      gEvals += 2
      col.push([(gp[0] - gm[0]) / (2 * hh), (gp[1] - gm[1]) / (2 * hh)])
    }
    // Potential curvature A = −∇²logπ, symmetrised.
    const Axx = -col[0][0]
    const Axy = -0.5 * (col[0][1] + col[1][0])
    const Ayy = -col[1][1]
    const { l1, l2, v1, v2 } = eigSym2(Axx, Axy, Ayy)
    const g1 = Math.sqrt(l1 * l1 + floor * floor) // SoftAbs-style PD metric
    const g2 = Math.sqrt(l2 * l2 + floor * floor)
    const Ginv = symFromEig(1 / g1, 1 / g2, v1, v2)
    const Ghalfinv = symFromEig(1 / Math.sqrt(g1), 1 / Math.sqrt(g2), v1, v2)
    const G = symFromEig(g1, g2, v1, v2)
    const mean = add(x, scale(matVec(Ginv, grad), 0.5 * eps * eps))
    return { logp, G, Ghalfinv, logdetG: Math.log(g1) + Math.log(g2), mean }
  }

  const s: Sampler = {
    x: target.start.slice(),
    logp: target.logDensity(target.start),
    densityEvals: 1,
    gradEvals: 0,
    step(): StepResult {
      const A = metricAt(this.x)
      const xi = rng.normalVec(d)
      const prop = add(A.mean, scale(matVec(A.Ghalfinv, xi), eps))
      const B = metricAt(prop)
      // MH correction over the state-dependent Gaussian proposals (constant
      // 2π and ε terms cancel between forward and reverse).
      const dFwd = sub(prop, A.mean)
      const qFwd = dot(matVec(A.G, dFwd), dFwd) / (eps * eps)
      const dRev = sub(this.x, B.mean)
      const qRev = dot(matVec(B.G, dRev), dRev) / (eps * eps)
      const logAccept =
        B.logp - A.logp + 0.5 * (B.logdetG - A.logdetG) - 0.5 * (qRev - qFwd)
      const accept = Number.isFinite(logAccept) && Math.log(rng.next()) < logAccept
      if (accept) {
        this.x = prop
        this.logp = B.logp
      }
      this.densityEvals = dEvals + 1
      this.gradEvals = gEvals
      return { x: this.x, logp: this.logp, accepted: accept, proposal: prop }
    },
  }
  return s
}

// ── Hit-and-Run ─────────────────────────────────────────────────────────────
// A gradient-free sampler that sidesteps the axis-alignment problem: at each
// step it picks a *uniformly random direction*, then draws a new point along
// that whole line from the 1-D conditional (here by slice sampling, so there is
// no proposal scale to tune along the line). Because the direction is isotropic,
// it moves freely along a tilted correlation ridge that trips up coordinate-wise
// Gibbs — a classic, elegant "sample along a line" method.
function makeHitAndRun(target: Target, rng: RNG, p: Record<string, number>): Sampler {
  const w = p.step // initial 1-D bracket width along the line
  const s: Sampler = {
    x: target.start.slice(),
    logp: target.logDensity(target.start),
    densityEvals: 1,
    gradEvals: 0,
    step(): StepResult {
      const ang = rng.next() * 2 * Math.PI
      const u: Vec = [Math.cos(ang), Math.sin(ang)] // isotropic direction
      const x0 = this.x
      const y = this.logp + Math.log(rng.next() + 1e-300) // slice level
      const at = (t: number): number => {
        this.densityEvals++
        return target.logDensity([x0[0] + t * u[0], x0[1] + t * u[1]])
      }
      // Step a bracket [lo, hi] out around t = 0.
      let lo = -w * rng.next()
      let hi = lo + w
      let gl = 24
      while (at(lo) > y && gl-- > 0) lo -= w
      let gr = 24
      while (at(hi) > y && gr-- > 0) hi += w
      // Shrink until a point on the slice is found.
      let t = 0
      let lp = this.logp
      for (let it = 0; it < 40; it++) {
        t = lo + rng.next() * (hi - lo)
        lp = at(t)
        if (lp > y) break
        if (t < 0) lo = t
        else hi = t
      }
      const next: Vec = [x0[0] + t * u[0], x0[1] + t * u[1]]
      const traj: Vec[] = [x0.slice(), next.slice()]
      this.x = next
      this.logp = lp
      return { x: this.x, logp: this.logp, accepted: true, trajectory: traj }
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
      { key: 'adapt', label: 'adapt ε', min: 0, max: 1, step: 1, default: 0, integer: true, toggle: true },
      { key: 'targetAccept', label: 'target δ', min: 0.5, max: 0.95, step: 0.01, default: 0.65 },
    ],
    create: makeHMC,
  },
  {
    id: 'nuts',
    name: 'NUTS',
    blurb: 'HMC that stops itself at the U-turn — no path length to tune. Stan’s workhorse.',
    usesGradient: true,
    params: [
      { key: 'step', label: 'step ε', min: 0.02, max: 0.6, step: 0.005, default: 0.18, log: true },
      { key: 'adapt', label: 'adapt ε', min: 0, max: 1, step: 1, default: 0, integer: true, toggle: true },
      { key: 'targetAccept', label: 'target δ', min: 0.5, max: 0.95, step: 0.01, default: 0.8 },
    ],
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
  {
    id: 'ensemble',
    name: 'Affine-Invariant Ensemble',
    blurb: 'A swarm of walkers stretching along each other — emcee’s move. Gradient-free, immune to skew.',
    usesGradient: false,
    params: [
      { key: 'walkers', label: 'walkers', min: 6, max: 40, step: 1, default: 20, integer: true },
      { key: 'stretch', label: 'stretch a', min: 1.5, max: 4, step: 0.05, default: 2 },
    ],
    create: makeEnsemble,
  },
  {
    id: 'bps',
    name: 'Bouncy Particle',
    blurb: 'A non-reversible particle flying straight and bouncing off the gradient. Continuous-time PDMP.',
    usesGradient: true,
    params: [
      { key: 'pathlen', label: 'flow time', min: 0.5, max: 12, step: 0.1, default: 4 },
      { key: 'refresh', label: 'refresh rate', min: 0, max: 3, step: 0.05, default: 0.4 },
    ],
    create: makeBPS,
  },
  {
    id: 'barker',
    name: 'Barker Proposal',
    blurb: 'A gradient-skewed jump that shrugs off a bad step size where MALA would stall.',
    usesGradient: true,
    params: [{ key: 'step', label: 'jump σ', min: 0.05, max: 2, step: 0.01, default: 0.6, log: true }],
    create: makeBarker,
  },
  {
    id: 'rmmala',
    name: 'Riemannian MALA',
    blurb: 'A curvature-aware metric rescales every step — one ε that survives the funnel neck and its mouth alike.',
    usesGradient: true,
    params: [
      { key: 'step', label: 'step ε', min: 0.1, max: 2.5, step: 0.01, default: 1, log: true },
      { key: 'floor', label: 'metric floor λ₀', min: 0.05, max: 3, step: 0.05, default: 0.5, log: true },
    ],
    create: makeRMMALA,
  },
  {
    id: 'hitrun',
    name: 'Hit-and-Run',
    blurb: 'Pick a random direction, sample the whole line. Isotropic moves glide along tilts that stall Gibbs.',
    usesGradient: false,
    params: [{ key: 'step', label: 'bracket w', min: 0.2, max: 6, step: 0.05, default: 2, log: true }],
    create: makeHitAndRun,
  },
]

export const samplerById = (id: string): SamplerDef =>
  SAMPLERS.find((s) => s.id === id) ?? SAMPLERS[0]
