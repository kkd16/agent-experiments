# Markov — a Monte-Carlo sampling studio · journal

A live, from-scratch laboratory for **Markov-chain Monte Carlo**. Pick a nasty
2-D target distribution, pick a sampler, and watch the chain crawl, glide, or
teleport across the density in real time — with the convergence diagnostics a
real Bayesian workflow lives and dies by (ESS, split-R̂, autocorrelation,
efficiency) ticking alongside.

Everything is written by hand in TypeScript: the PRNG, the linear algebra, the
eight samplers, the target densities *and their analytic gradients*, and the
diagnostics. No stats library, no plotting library — every pixel and every
number is ours.

## Why it's interesting

MCMC is the engine under modern Bayesian statistics, and its whole story is
*geometry vs. algorithm*: the same distribution is trivial for one sampler and
a nightmare for another. This studio makes that visible. Watch Random-Walk
Metropolis drown in the Rosenbrock banana while HMC follows the valley in long
graceful arcs. Watch a lone chain get marooned in one well of a four-mode
mixture while parallel tempering hops freely between them. Watch Neal's funnel
break a fixed step size no matter how you tune it.

## What's built (session 1)

- **8 samplers**, all from scratch:
  Random-Walk Metropolis · Adaptive Metropolis (Haario 2001) ·
  MALA (Metropolis-adjusted Langevin) · Hamiltonian Monte Carlo (leapfrog) ·
  NUTS (No-U-Turn, Hoffman & Gelman Alg. 3) · Metropolis-within-Gibbs ·
  Slice sampling (Neal 2003) · Parallel Tempering (replica exchange).
- **5 target distributions** with exact gradients:
  correlated Gaussian · Rosenbrock banana · ring · four-mode mixture ·
  Neal's funnel.
- **Live main view**: inferno density heatmap + fading chain trail + the
  current state, plus per-step overlays — leapfrog/slice trajectories, tempered
  replicas, and accepted/rejected proposal arrows.
- **Diagnostics rail**: trace plots (x, y), marginal histograms, and the
  autocorrelation function, all redrawn live.
- **Stat panel**: iterations, acceptance rate, ESS per coordinate, split-R̂
  (colour-coded), integrated autocorrelation time τ, running mean, 95% CI, and
  **ESS per 1000 evaluations** — an honest, cost-aware efficiency score that
  counts density *and* gradient calls so gradient methods aren't flattered.
- Seedable & reproducible; run / pause / single-step; adjustable speed,
  burn-in, and per-sampler parameters; visualization toggles.

## Ideas / backlog

- [x] Core engine: RNG, linalg, targets+gradients, 8 samplers, diagnostics
- [x] Real-time canvas studio with heatmap + trails + trajectory overlays
- [x] Live diagnostics (trace, histogram, ACF) + stat panel with ESS/R̂/τ
- [x] Cost-aware efficiency metric (ESS per 1000 target evaluations)
- [ ] **Race mode**: run two samplers side-by-side on the same target/seed and
      diff their ESS/eval — the money shot for "why HMC".
- [ ] **Bayesian inference demo**: click to drop data points, sample the
      posterior of a logistic/linear regression, draw posterior-predictive bands.
- [ ] Dual-averaging step-size adaptation for HMC/NUTS (auto-tune ε).
- [ ] Riemannian/position-dependent mass matrix to actually beat the funnel.
- [ ] 2-D KDE overlay of the sampled cloud vs. the true density (error map).
- [ ] Export the chain as CSV and a shareable permalink of the full config.
- [ ] A guided "About the math" panel with the accept-ratio for each sampler.
- [ ] More targets: a warped bimodal, a correlated Student-t with heavy tails.

## Session log

- 2026-07-23 (claude): created the studio from scratch. Built the full core
  (seedable RNG, tiny linalg with Cholesky, 5 targets with analytic gradients,
  8 samplers, from-scratch diagnostics) and a three-column real-time UI —
  controls / animated density canvas / diagnostics rail. Verified the CI gate
  (scope + conformance + lint + build all green) and smoke-tested the running
  build in headless Chromium: the banana heatmap, HMC leapfrog arcs, chain
  trail, and all diagnostic plots render live. Analytic gradients hand-checked
  against each density. Shipped as v1 with a rich backlog above.
