// A guided "about the math" overlay: what MCMC is, what each sampler does, and
// how to read the diagnostics. Plain prose, no external rendering — this is the
// context that turns a pretty animation into an actual lesson.

interface Row {
  name: string
  text: string
}

const SAMPLER_ROWS: Row[] = [
  {
    name: 'Random-Walk Metropolis',
    text: 'Propose x* = x + σ·ξ, accept with probability min(1, π(x*)/π(x)). No gradient, no geometry — it just tries a jump and keeps it if the density there is competitive. Robust and universal, but its steps have to stay small in the narrowest direction, so it mixes slowly through anything long or curved.',
  },
  {
    name: 'Adaptive Metropolis',
    text: 'The same accept/reject, but the proposal covariance is learned online from the chain’s own history (Haario 2001), scaled by the optimal 2.4²/d. Given time it reshapes its jumps to match a Gaussian-ish target — and gives up little when the target is not Gaussian.',
  },
  {
    name: 'MALA (Langevin)',
    text: 'Add a gradient drift: propose x* = x + ½ε²·∇log π(x) + ε·ξ, then Metropolis-correct the discretisation. The drift biases proposals uphill toward mass, so it accepts longer steps than a blind walk — the cheapest way to buy directional information.',
  },
  {
    name: 'Hamiltonian Monte Carlo',
    text: 'Treat −log π as a potential energy, sample a momentum, and roll a frictionless particle along the level sets with a leapfrog integrator for L steps. Because energy is (nearly) conserved, the endpoint is far away yet still accepted — HMC turns geometry into long, low-rejection jumps. Its cost is L gradient evaluations per sample.',
  },
  {
    name: 'NUTS',
    text: 'HMC without the painful choice of L. It doubles the trajectory forward and backward in time until the ends start approaching each other (a U-turn), then samples a state from the whole path. This is the algorithm inside Stan and PyMC.',
  },
  {
    name: 'Metropolis-within-Gibbs',
    text: 'Update one coordinate at a time, each with its own 1-D Metropolis step holding the others fixed. Simple and general, but the axis-aligned moves fight any correlation — watch it grind on the tilted Gaussian.',
  },
  {
    name: 'Slice Sampling',
    text: 'Draw a height y ~ Uniform(0, π(x)), then a new point uniformly along the horizontal “slice” {x : π(x) > y}. It brackets the slice by stepping out and then shrinks until it lands — almost no tuning and no rejections (Neal 2003).',
  },
  {
    name: 'Parallel Tempering',
    text: 'Run a ladder of replicas at temperatures 1 = T₀ < T₁ < … . Hot replicas flatten the landscape and roam across modes; periodic swaps let the cold chain (the one you keep) inherit a jump it could never have made alone. The cure for isolated modes.',
  },
  {
    name: 'Affine-Invariant Ensemble',
    text: 'The move behind emcee (Goodman & Weare 2010). Instead of one chain, evolve a whole ensemble of walkers; to move walker k, pick another walker j and propose a point stretched along the line between them, x* = x_j + z·(x_k − x_j), with z drawn from g(z) ∝ 1/√z and accepted with min(1, z^{d−1}·π(x*)/π(x_k)). The magic is that this is invariant to every affine transform of the space — so a skewed, tightly-correlated target is exactly as easy as a round one, with no gradient and no covariance to tune. The whole swarm is drawn; the diagnostics read walker 0.',
  },
  {
    name: 'Bouncy Particle Sampler',
    text: 'A non-reversible, continuous-time process (Bouchard-Côté, Vollmer & Doucet 2018). A particle flies in a straight line at constant velocity and, at a rate set by how fast it is climbing the potential, reflects off the log-density gradient like light off a mirror: v ← v − 2⟨v,∇U⟩∇U/‖∇U‖². Occasional random velocity refreshments keep it ergodic. Because it never reverses time-symmetrically, it can suppress the diffusive back-tracking that slows reversible MCMC. (Here it is simulated by fine time-stepping, so its evaluation count is not directly comparable to the reversible samplers — read it for the *motion*, not the eval budget.)',
  },
  {
    name: 'Barker Proposal',
    text: 'A gradient sampler engineered for robustness (Livingstone & Zanella 2022). Per coordinate it draws a symmetric jump z and then skews its sign toward the gradient — keeping +z with probability 1/(1+e^{−z·∂ᵢlogπ}) — corrected by an exact Metropolis ratio. Its signature property: where MALA’s acceptance falls off a cliff the moment the step size is a little too big, Barker just degrades gently. A safer default when you cannot babysit ε.',
  },
]

const TUNING_ROWS: Row[] = [
  {
    name: 'Dual-averaging step-size adaptation (HMC / NUTS)',
    text: 'Flip “adapt ε” on and the gradient samplers tune their own leapfrog step size instead of making you guess it. During a short warmup window a Nesterov dual-averaging scheme (Hoffman & Gelman 2014) drives the average Metropolis acceptance toward the target δ — 0.8 is the NUTS sweet spot, ~0.65 is optimal for plain HMC — then freezes ε at the dual-averaged estimate so the chain becomes a proper, time-homogeneous Markov chain again. The stat panel shows the live ε and, for NUTS, the mean tree depth. (Adaptation makes the warmup samples non-stationary, so keep a little burn-in.)',
  },
  {
    name: 'Race mode',
    text: 'Run two samplers in lockstep on the *same* target and *same* seed, each in its own arena, and let the compare bar diff them live. The headline is the efficiency ratio; the bars show ESS, cost-aware ESS/1000-eval, autocorrelation time τ and acceptance. Watch how ESS and ESS/eval can disagree: HMC can carry 20× the effective samples of Random-Walk Metropolis yet tie on ESS/eval, because each HMC draw costs a leapfrog trajectory of gradient evaluations. That tension — raw mixing vs. cost — is the whole engineering story of MCMC in one panel.',
  },
  {
    name: 'Shareable links',
    text: 'The entire configuration — mode, target, seed, burn-in, and every lane’s sampler and parameters — lives in the URL. Hit “Copy link” to grab a permalink that reconstructs the exact experiment for anyone who opens it.',
  },
]

const DIAG_ROWS: Row[] = [
  {
    name: 'ESS — effective sample size',
    text: 'How many *independent* draws your correlated chain is worth. A chain of 10,000 with ESS 200 carries as much information about the mean as 200 i.i.d. samples. Higher is better; it is the honest denominator for Monte-Carlo error.',
  },
  {
    name: 'ESS / 1000 eval',
    text: 'Efficiency that accounts for cost: effective samples per thousand density *and* gradient evaluations. HMC spends many gradients per step, so this metric refuses to flatter it — it is the fair way to compare a cheap-but-sticky sampler against an expensive-but-decorrelating one.',
  },
  {
    name: 'split-R̂',
    text: 'Split the chain in half and compare the variance between halves to the variance within them. If the chain has converged the two halves look alike and R̂ ≈ 1. Values above ~1.1 mean it has not settled — treat those estimates with suspicion.',
  },
  {
    name: 'τ — autocorrelation time',
    text: 'The number of steps the chain takes to forget where it was (τ = N / ESS). The autocorrelation plot shows this directly: bars that fall to zero fast mean quick mixing; a slow decay means neighbouring samples are nearly duplicates.',
  },
  {
    name: 'mean err — accuracy vs. ground truth',
    text: 'For the targets whose mean is known analytically, this is the plain distance between the chain’s running-mean estimate and the true mean — the one number ESS and R̂ are ultimately proxies for. Watch a chain that looks busy but is trapped in one mode: its R̂ climbs and its mean err stays large, because a confident-looking sampler can still be flatly wrong. In Race mode it becomes the tie-breaker: not just who mixes faster, but who is actually closer to the right answer.',
  },
  {
    name: 'convergence — the estimate settling in',
    text: 'The bottom plot tracks the whole-chain running mean of the first coordinate as the chain grows (iterations on a log axis). When the target’s mean is known it is drawn as a dashed line, and you watch the estimate walk onto it — the picture of Monte-Carlo consistency. In Race mode both curves are overlaid, so “which sampler converges first” stops being an abstraction and becomes a footrace you can watch.',
  },
  {
    name: 'TV dist — the whole distribution, not just the mean',
    text: 'Total-variation distance ½·Σ|p̂ − p| between the sampled distribution and the target’s *analytic* density, gridded over the view. Because it needs only the density (which every target here has), it scores accuracy even for the multimodal and heavy-tailed shapes that have no tidy closed-form mean. It is the honest answer to “did you capture the shape?” — a chain trapped in one mode of a mixture reads a large TV even while its local statistics look perfectly healthy. Lower is better; a small residual floor is unavoidable from finite grid and finite samples.',
  },
  {
    name: 'shape error — where the sampler is wrong',
    text: 'The map in the diagnostics rail draws the signed discrepancy (empirical − reference) across the view: red where the sampler over-visits, blue where it under-visits, dark where it matches. It turns the TV number into a picture — the marooned mode of a mixture glows red while the modes the chain never reached sit flatly blue, and a chain that oversamples a tail lights it up. Watch it fade to black as a good sampler fills the density in evenly.',
  },
  {
    name: 'MCSE — the ± on the estimate',
    text: 'Monte-Carlo standard error, sd/√ESS: the actual uncertainty on the running-mean estimate that finitely many *effective* samples buy you. It closes the loop from ESS (“how many independent draws am I worth?”) to the number those draws produce (“…so how tight is my answer?”). Halving MCSE takes four times the effective samples.',
  },
]

export default function About({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>The math behind the motion</h2>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <p className="modal-lead">
            Every sampler here is trying to do one impossible-sounding thing: draw samples from a
            probability distribution you can only evaluate up to a constant. Markov-chain Monte Carlo
            builds a random walk whose <em>long-run visiting frequency</em> is exactly that
            distribution — so a histogram of where the chain has been becomes a picture of the
            density. The art is making that walk explore quickly instead of getting stuck. The
            glowing heatmap is the true target; the moving dot is the chain; the accumulating cloud
            is the distribution it is rebuilding from scratch.
          </p>

          <h3>The samplers</h3>
          {SAMPLER_ROWS.map((r) => (
            <div className="about-row" key={r.name}>
              <div className="about-row-name">{r.name}</div>
              <div className="about-row-text">{r.text}</div>
            </div>
          ))}

          <h3>Tuning &amp; comparison</h3>
          {TUNING_ROWS.map((r) => (
            <div className="about-row" key={r.name}>
              <div className="about-row-name">{r.name}</div>
              <div className="about-row-text">{r.text}</div>
            </div>
          ))}

          <h3>Reading the diagnostics</h3>
          {DIAG_ROWS.map((r) => (
            <div className="about-row" key={r.name}>
              <div className="about-row-name">{r.name}</div>
              <div className="about-row-text">{r.text}</div>
            </div>
          ))}

          <h3>Things to try</h3>
          <ul className="about-list">
            <li>
              Put the <b>Affine-Invariant Ensemble</b> on the tilted <b>correlated Gaussian</b> or the{' '}
              <b>heavy-tailed t</b> and race it against <b>Random-Walk Metropolis</b>: the ensemble nails
              the skew with no tuning and no gradient, because its move is invariant to the very
              correlation that cripples the random walk — watch its <b>TV dist</b> plunge.
            </li>
            <li>
              Select the <b>Bouncy Particle</b> sampler and turn the <b>trajectory</b> overlay on: you
              literally watch a non-reversible particle fly straight and ricochet off the density. Drop
              the <b>refresh rate</b> toward 0 and it glides in long ballistic arcs; raise it and the
              motion turns diffusive.
            </li>
            <li>
              Race <b>Barker Proposal</b> against <b>MALA</b> on the <b>banana</b>, then drag both step
              sizes up together: MALA’s acceptance collapses and its chain freezes, while Barker keeps
              moving — the robustness-to-mistuning it was designed for, seen live.
            </li>
            <li>
              Watch the <b>shape error</b> card while a single <b>Metropolis</b> chain sits in one well
              of the <b>four-mode mixture</b>: its well glows red (over-visited) and the other three stay
              blue (never reached). Switch to <b>Parallel Tempering</b> and watch the map fade to black.
            </li>
            <li>
              Switch to <b>Race mode</b> with <b>HMC</b> vs <b>Random-Walk Metropolis</b> on the{' '}
              <b>Rosenbrock banana</b>: HMC carries an order of magnitude more ESS, yet the two nearly
              tie on <b>ESS / 1000 eval</b> — watch the compare bar make the cost of gradients explicit.
            </li>
            <li>
              On <b>Neal’s funnel</b>, turn on <b>adapt ε</b> for NUTS and push <b>target δ</b> toward
              0.95: the auto-tuned step shrinks to survive the neck, and the mean tree depth climbs to
              pay for it. No hand-tuning required.
            </li>
            <li>
              Open <b>Twin Craters</b> — two facing bananas — and give a single <b>HMC</b> chain a small
              step: it traces one curved crater but can’t cross to the other (R̂ climbs). Race it against{' '}
              <b>Parallel Tempering</b> and watch tempering visit both.
            </li>
            <li>
              Try the <b>Squiggle</b> with <b>Metropolis-within-Gibbs</b>: the axis-aligned sweeps keep
              stepping off the sinusoidal ridge. Switch to <b>MALA</b> or <b>HMC</b> and the gradient
              traces the S cleanly.
            </li>
            <li>
              Configure any experiment and hit <b>Copy link</b> — the URL rebuilds it exactly for whoever
              you send it to.
            </li>
            <li>
              Put <b>Random-Walk Metropolis</b> and then <b>HMC</b> on the <b>Rosenbrock banana</b>{' '}
              and compare ESS / 1000 eval — the whole case for gradients in one number.
            </li>
            <li>
              Give a single <b>Metropolis</b> chain the <b>four-mode mixture</b>; watch it get
              trapped in one well (R̂ climbs). Switch to <b>Parallel Tempering</b> and watch it hop.
            </li>
            <li>
              Crank the HMC step size ε on <b>Neal’s funnel</b> until the chain diverges out of the
              neck — no fixed step can serve both the wide mouth and the narrow throat.
            </li>
            <li>
              Turn off <b>density</b> and leave only the <b>cloud</b> on: watch the sampler paint the
              target back in, one dot at a time.
            </li>
            <li>
              Open the <b>Logistic Posterior</b> — a real Bayesian posterior over the intercept and
              slope of a logistic fit. The <b>running mean</b> in the stat panel <em>is</em> the
              posterior-mean parameter estimate, and the 95% CI is a genuine credible interval.
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}
