# Markov — a Monte-Carlo sampling studio · journal

A live, from-scratch laboratory for **Markov-chain Monte Carlo**. Pick a nasty
2-D target distribution, pick a sampler, and watch the chain crawl, glide, or
teleport across the density in real time — with the convergence diagnostics a
real Bayesian workflow lives and dies by (ESS, split-R̂, autocorrelation,
efficiency) ticking alongside.

Everything is written by hand in TypeScript: the PRNG, the linear algebra, the
eleven samplers (spanning reversible MCMC, an affine-invariant ensemble, and a
non-reversible continuous-time process), the target densities *and their
analytic gradients*, and the diagnostics — down to a total-variation distance to
each target's true distribution. No stats library, no plotting library — every
pixel and every number is ours.

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

### Session 3 plan (this session) — "the whole distribution, and the non-reversible frontier"

Sessions 1–2 built a fast single-chain visualiser and then a comparative
laboratory. Session 3 pushes on two fronts at once: **broaden the algorithm
zoo past the reversible-MCMC canon**, and **stop scoring samplers only by how
fast they mix or how close the *mean* is — start scoring how well they capture
the *entire distribution***. Three new samplers from genuinely different
mathematical families, and a ground-truth accuracy engine that reads the whole
shape, not one moment.

- [x] **Affine-Invariant Ensemble sampler** (Goodman & Weare 2010; the engine
      behind `emcee`). A *population* of walkers proposes moves by "stretching"
      along the line to another walker: `x' = x_j + z·(x_k − x_j)` with the
      stretch `z ∼ g(z) ∝ 1/√z`, accepted with `min(1, z^{d−1}·π(x')/π(x_k))`.
      Gradient-free, yet **invariant to every affine transform** of the space —
      so it nails the correlated Gaussian, the tilted Student-t and the Squiggle
      with *no* tuning, where axis-aligned proposals crawl. The ensemble draws
      through the existing `chains` overlay.
- [x] **Bouncy Particle Sampler** (Bouchard-Côté, Vollmer & Doucet 2018). A
      **non-reversible**, continuous-time piecewise-deterministic Markov process:
      a particle flies in a straight line and *bounces* off the log-density
      gradient (`v ← v − 2⟨v,∇U⟩∇U/‖∇U‖²`), with Poisson velocity refreshments
      for ergodicity. Reuses the trajectory overlay — you literally watch the
      particle ricochet around the density. A time-discretised (thinned)
      implementation; the About panel is explicit that its eval-count isn't
      directly comparable to the reversible samplers.
- [x] **Barker proposal** (Livingstone & Zanella 2022). A gradient sampler
      whose defining property is **robustness to step-size mis-tuning**: it skews
      a symmetric jump toward the gradient with probability
      `1/(1+e^{−z·∂ᵢlogπ})` per coordinate, corrected by an exact,
      numerically-stable (softplus) Metropolis ratio. Where MALA blows up if ε is
      a little too big, Barker just degrades gracefully.
- [x] **Distributional accuracy — total-variation distance to ground truth.**
      A new `diagnostics/distance.ts` normalises each target's *analytic* density
      onto a grid (every target has one, so this works for **all** of them — even
      the multimodal and heavy-tailed ones that have no simple closed-form mean),
      bins the live samples into the same grid, and reports
      `TV = ½·Σ|p̂ − p|`. It's the honest "did you capture the whole shape?"
      score the mean-error metric can't give: a chain trapped in one mode reads a
      large TV even when its per-mode statistics look healthy. Surfaced in the
      stat panel and as a Race tiebreaker.
- [x] **"Shape error" diagnostic card.** Renders the *signed* discrepancy
      (empirical − reference) as a diverging heatmap: red where the sampler
      over-visits, blue where it under-visits, with the TV number in the corner.
      You *see* which region a sampler is getting wrong — the trapped mode glows
      red while the abandoned ones sit blue.
- [x] **Monte-Carlo standard error (MCSE = sd/√ESS).** The actual ± on the
      running-mean estimate, per coordinate, added to the stat panel — closing
      the loop from "how many effective samples" to "how uncertain is the number
      those samples produced."
- [x] **About + metadata.** Documented all three samplers, TV distance, the
      shape-error map and MCSE; added new "things to try"; refreshed tags.

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
- 2026-07-25 (claude): v3.0 — "the whole distribution, and the non-reversible
  frontier". Broadened the algorithm zoo from 8 to 11 samplers and added a
  ground-truth accuracy engine that scores the *entire distribution*, not just
  the mean. All with the CI gate green (scope + conformance + lint + build) and
  smoke-tested live in headless Chromium:
  1. **Affine-Invariant Ensemble** (Goodman & Weare 2010; the `emcee` move): a
     swarm of walkers that propose by stretching along the line to a partner
     walker, accepted with a z^{d−1} Jacobian factor. Gradient-free yet invariant
     to every affine map — it nails the tilted Gaussian and the correlated
     Student-t with no tuning where a random walk crawls. Drawn through the
     existing `chains` overlay (the swarm visibly traces the correlation ridge).
  2. **Bouncy Particle Sampler** (Bouchard-Côté et al. 2018): a *non-reversible*,
     continuous-time PDMP — a particle flies straight and specularly reflects off
     the log-density gradient (an exact, ‖v‖-preserving Householder), with Poisson
     velocity refreshments. Time-discretised with an adaptive spatial step-cap
     (dtBase 0.03, maxStep 0.06) to keep event resolution fine in steep walls.
  3. **Barker proposal** (Livingstone & Zanella 2022): a gradient sampler that
     skews a symmetric jump toward higher density per coordinate, corrected by an
     exact, overflow-safe (softplus) Metropolis ratio. Its selling point —
     graceful degradation when the step size is mis-tuned — is visible against
     MALA. Correctness of all three checked numerically against the *exact*
     shipped code (bundled with vite lib-build, run in Node): on the correlated
     Gaussian each recovers mean (0,0), var (1,1) and corr 0.85 to ≲2%, and the
     tuned BPS recovers the Rosenbrock mean (≈1, ≈10) and variance within
     sampling error of the analytic (10, 240).
  4. **Distributional accuracy — TV distance to ground truth** (`diagnostics/
     distance.ts`): grid-normalises each target's *analytic* density (so it works
     for every target, even the multimodal / heavy-tailed ones with no tidy mean),
     bins the live samples onto the same grid, and reports TV = ½Σ|p̂−p|. Surfaced
     in the stat panel and as a Race tiebreaker — the honest "did you capture the
     shape?" score a trapped chain can't fake.
  5. **"Shape error" diagnostic card**: the signed discrepancy (empirical −
     reference) as a diverging heatmap — red where the sampler over-visits, blue
     where it under-visits — so you *see* which region is wrong, with the TV
     number printed in the corner.
  6. **Monte-Carlo standard error** (sd/√ESS) added to the stat panel — the
     actual ± on the mean estimate, closing the loop from ESS to uncertainty.
  Documented all of it in the About modal (three new sampler entries, three new
  diagnostic entries, four new "things to try") and refreshed the card metadata
  (now advertises eleven samplers + the accuracy suite).
