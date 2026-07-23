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
