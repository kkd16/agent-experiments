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
- **6 target distributions** with exact gradients:
  correlated Gaussian · Rosenbrock banana · ring · four-mode mixture ·
  Neal's funnel · **a real Bayesian logistic-regression posterior** (the two
  coordinates are the intercept & slope; sampling it *is* inference).
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
- [x] "Long-exposure" accumulated sample-cloud overlay (watch the chain repaint
      the density) + keyboard shortcuts (space/s/r)
- [x] Guided "About the math" panel — every sampler, every diagnostic, and a
      "things to try" tour
- [x] **Race mode**: run two samplers side-by-side on the same target/seed and
      diff their ESS/eval — the money shot for "why HMC". *(session 2)*
- [x] **Bayesian inference target**: a logistic-regression posterior over
      (intercept, slope) of 18 data points — every sampler now does real
      inference, running mean = posterior mean, CI = credible interval
- [ ] Make the Bayesian demo interactive: click to drop data points and draw
      posterior-predictive bands in data space alongside the parameter space.
- [x] Dual-averaging step-size adaptation for HMC/NUTS (auto-tune ε). *(session 2)*
- [ ] Riemannian/position-dependent mass matrix to actually beat the funnel.
- [x] Export the chain as CSV (one click; header uses per-target axis names)
- [x] Heavy-tailed correlated Student-t target (ν = 2.5) with exact gradient
- [x] Per-target axis labels (the logistic target now reads intercept / slope
      across the stat panel and every diagnostic)
- [x] Shareable permalink of the full config (target + sampler + params + seed). *(session 2)*
- [x] More targets: a warped bimodal; a 2-D marginal of Neal's funnel in 3-D. *(session 2 — added Squiggle + Twin-Crater bimodal-banana)*

### Session 2 plan (this session) — "compare, adapt, share"

The through-line of session 2 is turning a single-chain visualiser into a
*comparative laboratory*: put two algorithms in the same arena on the same
problem, let the good ones tune themselves, and make any experiment a URL you
can send someone.

- [x] **Sampler `info` channel.** Extend `StepResult` with an optional
      `info` record so a sampler can report per-step internals (adapted ε, NUTS
      tree depth, the Metropolis accept-probability). The engine keeps the live
      value plus a smoothed average; the stat panel surfaces them.
- [x] **Dual-averaging (Nesterov) step-size adaptation** for HMC & NUTS —
      Hoffman & Gelman (2014) Alg. 5. A warmup window auto-tunes ε to hit a
      target acceptance δ, then freezes ε at the dual-averaged running estimate.
      New per-sampler knobs: *adapt δ* (target accept) and *warmup*. The live
      ε and mean tree depth show in the stat panel while it tunes.
- [x] **Two new targets.** A **Squiggle** (sinusoidally sheared Gaussian — an
      S-shaped ridge that punishes axis-aligned proposals) and **Twin Craters**
      (a genuinely *bimodal* pair of facing bananas — curved valleys *and*
      isolated modes at once, the hardest case in the gallery). Both carry
      exact analytic gradients.
- [x] **Race mode** *(flagship)*. A mode toggle runs **two samplers in
      lockstep** on the same target and seed, each in its own panel sharing one
      density field, with independent trails / clouds / trajectories. A live
      **compare bar** diffs ESS, ESS/1k-eval, accept-rate and iterations and
      crowns an efficiency winner — the "why HMC" money shot as a single glance.
      The engine was refactored around N independent *lanes*.
- [x] **Shareable permalink.** The whole config (mode, target, seed, burn-in,
      and every lane's sampler + params) round-trips through the URL hash; a
      "Copy link" button and on-load restore make any run reproducible by link.
- [x] **About panel + polish.** Documented dual averaging, race mode, and the
      two new targets; added new "things to try"; wired the new stat cells.

## Session log

- 2026-07-23 (claude): created the studio from scratch. Built the full core
  (seedable RNG, tiny linalg with Cholesky, 5 targets with analytic gradients,
  8 samplers, from-scratch diagnostics) and a three-column real-time UI —
  controls / animated density canvas / diagnostics rail. Verified the CI gate
  (scope + conformance + lint + build all green) and smoke-tested the running
  build in headless Chromium: the banana heatmap, HMC leapfrog arcs, chain
  trail, and all diagnostic plots render live. Analytic gradients hand-checked
  against each density. Shipped as v1 with a rich backlog above.
- 2026-07-23 (claude): v1.1 — added a "long-exposure" accumulation canvas that
  splats every visited state with additive blending, so the chain visibly
  repaints the target density over time (toggle: cloud); keyboard shortcuts
  (space = run/pause, s = step, r = reset); and a full "About the math" modal
  explaining all eight samplers, the diagnostics (ESS, ESS/eval, R̂, τ), and a
  guided set of experiments. Re-verified the gate green and re-screenshotted the
  running build.
- 2026-07-23 (claude): v1.2 — added a sixth target that is a *real* Bayesian
  logistic-regression posterior (numerically-stable log-likelihood + exact
  gradient, N(0,3²) prior over intercept & slope of 18 near-separable points).
  Because it satisfies the same Target interface, all eight samplers and every
  diagnostic now do genuine posterior inference for free — the running mean is
  the posterior-mean estimate and the 95% CI is a real credible interval.
  Verified by rendering the posterior live in headless Chromium (HMC exploring
  a broad, prior-regularised correlated ridge, as expected for near-separable
  data). Gate green.
- 2026-07-23 (claude): v1.3 — polish + reach. Added a seventh target, a
  heavy-tailed correlated Student-t (ν = 2.5) with exact gradient — its
  polynomial tails visibly fling NUTS into long excursions. Added per-target
  axis names (Target.axes), so the logistic posterior now reads
  intercept / slope everywhere instead of x / y. Added one-click CSV export of
  the full chain. Re-verified the gate green and screenshotted the Student-t +
  NUTS combination (sharp core, long diffuse tails). Now 7 targets × 8 samplers.
- 2026-07-24 (claude): v2.0 — "compare, adapt, share". A big session that turns
  the single-chain visualiser into a comparative laboratory. Five things landed,
  all with the CI gate green (scope + conformance + lint + build) and all
  smoke-tested live in headless Chromium:
  1. **Dual-averaging step-size adaptation** (`samplers/adapt.ts`): Nesterov
     primal-dual scheme (Hoffman & Gelman 2014, Alg. 5) wired into HMC and NUTS
     behind an "adapt ε" toggle + "target δ" knob. A 400-iteration warmup drives
     the average Metropolis acceptance to δ, then freezes ε at the dual-averaged
     estimate. NUTS accumulates the per-tree acceptance stat (Σ min(1,e^ΔH)/n) to
     feed it. Verified in isolation: on a monotone test the scheme converges ε to
     the analytic optimum (0.2163 vs 0.2154; achieved accept 0.649 vs target 0.65).
  2. **Sampler `info` channel**: `StepResult.info` reports internals; the engine
     keeps the live ε (current) and an EMA of the NUTS tree depth, surfaced as new
     stat cells.
  3. **Two new targets** (now 9): a **Squiggle** (sinusoidally-sheared Gaussian,
     an S-ridge) and **Twin Craters** (log-sum-exp of two facing crescents —
     curved valleys *and* two separated modes; the bimodal marginal is visible in
     the histogram). Both gradients checked against finite differences to ~1e-9.
  4. **Race mode** (flagship): the engine was refactored around an opaque `Lane`
     class (`engine/lane.ts`) so the rAF loop drives N lanes uniformly — and so
     every canvas/cloud mutation stays inside a method boundary, satisfying the
     compiler-based react-hooks immutability rules. Two lanes step in lockstep on
     one target+seed, share one density field, keep independent trails/clouds
     (tinted per lane), and feed a `Race` compare bar that diffs ESS, cost-aware
     ESS/eval, τ and accept and crowns an efficiency winner. The diagnostics rail
     overlays both chains. Confirmed the money shot live: HMC vs RWM on the banana
     shows a huge ESS lead but a near-tie on ESS/eval (the honest cost of
     gradients); PT beats Slice 5.2× on Twin Craters by visiting both craters.
  5. **Shareable permalink** (`engine/permalink.ts`): the whole config
     round-trips through a base64url URL hash; "Copy link" + on-load restore.
     Verified a fresh page load rebuilds target + mode + both lanes exactly.
  Also documented all of it in the About modal (new "Tuning & comparison" section
  + new "things to try") and refreshed the card + page metadata.
- 2026-07-24 (claude): v2.1 — **accuracy vs. ground truth**. Added a `meanErr`
  diagnostic: for every target whose mean is known analytically (now including
  the Rosenbrock banana, whose closed-form mean is [1, 11]), the stat panel and
  the Race compare bar show ‖running-mean − true-mean‖ — the honest accuracy the
  whole ESS/R̂ apparatus is a proxy for. It's the tie-breaker Race mode was
  missing: not just who mixes faster, but who is actually *right*. A single
  Metropolis chain trapped in one well of the four-mode mixture now visibly
  reports a large mean err even while it looks busy. Considered (and rejected for
  now) a diagonal mass-matrix metric: isolated tests confirmed the metric
  leapfrog is unbiased and energy-conserving, but with fixed-L HMC a rescaled
  metric can land on a trajectory-length periodicity and mix *worse*, so it isn't
  a clean win to ship. Gate green; documented in the About diagnostics section.
- 2026-07-24 (claude): v2.2 — **live convergence trace**. Added a sixth
  diagnostic card: the whole-chain running mean of coordinate 1 plotted against
  iterations (log x-axis), with a dashed line at the true value when known. The
  engine snapshots the running mean into a self-thinning history (stride doubles
  as it fills, so a chain of any length stays ~1000 points). It's the picture of
  Monte-Carlo consistency — the estimate walking onto the truth line — and in
  Race mode both lanes' curves overlay, turning "which sampler converges first"
  into a literal footrace. Gate green; documented in About.
