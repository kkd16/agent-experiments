import type { LiveStats } from '../engine/simulation'

function fmt(v: number, digits = 2): string {
  if (!isFinite(v)) return '—'
  if (Math.abs(v) >= 1e5) return v.toExponential(1)
  return v.toFixed(digits)
}

function rhatClass(v: number): string {
  if (!isFinite(v)) return ''
  if (v < 1.05) return 'good'
  if (v < 1.15) return 'warn'
  return 'bad'
}

export default function Stats({ s, axes = ['x', 'y'] }: { s: LiveStats; axes?: [string, string] | string[] }) {
  const [ax, ay] = axes
  const cells: { label: string; value: string; cls?: string; hint: string }[] = [
    { label: 'iterations', value: s.iters.toLocaleString(), hint: 'chain length so far' },
    {
      label: 'accept rate',
      value: `${(s.acceptRate * 100).toFixed(1)}%`,
      hint: 'fraction of proposals accepted',
    },
    {
      label: `ESS · ${ax}`,
      value: fmt(s.essX, 0),
      hint: 'effective sample size on the first coordinate',
    },
    { label: `ESS · ${ay}`, value: fmt(s.essY, 0), hint: 'effective sample size on the second coordinate' },
    {
      label: `R̂ · ${ax}`,
      value: fmt(s.rhatX, 3),
      cls: rhatClass(s.rhatX),
      hint: 'split-R̂; ≈1 means converged, >1.1 is a warning',
    },
    { label: `τ · ${ax}`, value: fmt(s.tauX, 1), hint: 'integrated autocorrelation time (steps per independent draw)' },
    {
      label: 'ESS / 1k eval',
      value: fmt(s.essPerKEval, 1),
      hint: 'efficiency: effective samples per 1000 density/gradient evaluations',
    },
    {
      label: 'mean',
      value: `(${fmt(s.meanX)}, ${fmt(s.meanY)})`,
      hint: 'running posterior mean estimate',
    },
    {
      label: 'MCSE',
      value:
        s.mcseX !== undefined && s.mcseY !== undefined
          ? `±(${fmt(s.mcseX, 3)}, ${fmt(s.mcseY, 3)})`
          : '—',
      hint: 'Monte-Carlo standard error sd/√ESS — the actual ± uncertainty on the mean estimate from finitely many effective samples',
    },
    {
      label: `95% CI · ${ax}`,
      value: `[${fmt(s.ci[0])}, ${fmt(s.ci[1])}]`,
      hint: `central 95% credible interval for ${ax}`,
    },
    {
      label: 'evals',
      value: `${s.densityEvals.toLocaleString()} π · ${s.gradEvals.toLocaleString()} ∇`,
      hint: 'target density and gradient evaluations',
    },
  ]
  // Sampler internals, shown only when the active sampler reports them.
  if (s.info?.eps !== undefined) {
    cells.push({
      label: 'ε (step)',
      value: fmt(s.info.eps, 3),
      hint: 'current leapfrog step size — auto-tuned by dual averaging when "adapt ε" is on',
    })
  }
  if (s.info?.depth !== undefined) {
    cells.push({
      label: 'NUTS depth',
      value: fmt(s.info.depth, 1),
      hint: 'mean tree depth (~log₂ of the leapfrog steps NUTS takes per sample)',
    })
  }
  // SVGD internals: the driving force (→0 at convergence) and kernel bandwidth.
  if (s.info?.phi !== undefined) {
    cells.push({
      label: '‖φ‖ force',
      value: fmt(s.info.phi, 3),
      hint: 'mean magnitude of the Stein driving force per particle — it decays toward 0 as the swarm settles into a stationary tiling of the density',
    })
  }
  if (s.info?.hband !== undefined) {
    cells.push({
      label: 'bandwidth h',
      value: fmt(s.info.hband, 2),
      hint: 'RBF kernel bandwidth, set live by the median heuristic — the length-scale of the particles’ mutual repulsion',
    })
  }
  // SMC internals: annealing progress, weight health, and the evidence estimate.
  if (s.info?.beta !== undefined) {
    cells.push({
      label: 'β (anneal)',
      value: fmt(s.info.beta, 3),
      cls: s.info.beta >= 0.999 ? 'good' : 'warn',
      hint: 'inverse temperature of the tempering path: 0 = the Gaussian reference, 1 = the full target. The evidence is final once β reaches 1.',
    })
  }
  if (s.info?.essFrac !== undefined) {
    cells.push({
      label: 'weight ESS',
      value: `${(s.info.essFrac * 100).toFixed(0)}%`,
      hint: 'effective sample size of the importance weights, as a fraction of the population — drops as a rung reweights, resets to 100% after resampling',
    })
  }
  if (s.info?.logZ !== undefined) {
    const err = s.trueLogZ !== undefined ? s.info.logZ - s.trueLogZ : undefined
    cells.push({
      label: 'log Z (evidence)',
      value:
        s.trueLogZ !== undefined
          ? `${fmt(s.info.logZ, 3)} / ${fmt(s.trueLogZ, 3)}`
          : fmt(s.info.logZ, 3),
      cls:
        err === undefined
          ? ''
          : Math.abs(err) < 0.1
            ? 'good'
            : Math.abs(err) < 0.3
              ? 'warn'
              : 'bad',
      hint:
        s.trueLogZ !== undefined
          ? 'SMC estimate of the log normalising constant vs its exact analytic value (est / true) — the one number a single Markov chain cannot produce'
          : 'SMC estimate of the log normalising constant — here the log Bayesian model evidence, which has no closed form',
    })
  }
  if (s.meanErr !== undefined) {
    cells.push({
      label: 'mean err',
      value: fmt(s.meanErr, 3),
      cls: s.meanErr < 0.15 ? 'good' : s.meanErr < 0.5 ? 'warn' : 'bad',
      hint: 'distance of the running mean from the target’s known true mean — the honest accuracy of the estimate (lower is better)',
    })
  }
  if (s.tvDist !== undefined && isFinite(s.tvDist)) {
    cells.push({
      label: 'TV dist',
      value: fmt(s.tvDist, 3),
      cls: s.tvDist < 0.1 ? 'good' : s.tvDist < 0.25 ? 'warn' : 'bad',
      hint: 'total-variation distance from the sampled to the true distribution (½Σ|p̂−p| on a grid) — how well the *whole shape* is captured, not just the mean; lower is better',
    })
  }
  return (
    <div className="stat-grid">
      {cells.map((c) => (
        <div className="stat-cell" key={c.label} title={c.hint}>
          <div className="stat-label">{c.label}</div>
          <div className={`stat-value ${c.cls ?? ''}`}>{c.value}</div>
        </div>
      ))}
    </div>
  )
}
