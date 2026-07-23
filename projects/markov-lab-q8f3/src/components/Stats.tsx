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

export default function Stats({ s }: { s: LiveStats }) {
  const cells: { label: string; value: string; cls?: string; hint: string }[] = [
    { label: 'iterations', value: s.iters.toLocaleString(), hint: 'chain length so far' },
    {
      label: 'accept rate',
      value: `${(s.acceptRate * 100).toFixed(1)}%`,
      hint: 'fraction of proposals accepted',
    },
    {
      label: 'ESS · x',
      value: fmt(s.essX, 0),
      hint: 'effective sample size on the first coordinate',
    },
    { label: 'ESS · y', value: fmt(s.essY, 0), hint: 'effective sample size on the second coordinate' },
    {
      label: 'R̂ · x',
      value: fmt(s.rhatX, 3),
      cls: rhatClass(s.rhatX),
      hint: 'split-R̂; ≈1 means converged, >1.1 is a warning',
    },
    { label: 'τ · x', value: fmt(s.tauX, 1), hint: 'integrated autocorrelation time (steps per independent draw)' },
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
      label: '95% CI · x',
      value: `[${fmt(s.ci[0])}, ${fmt(s.ci[1])}]`,
      hint: 'central 95% credible interval for x',
    },
    {
      label: 'evals',
      value: `${s.densityEvals.toLocaleString()} π · ${s.gradEvals.toLocaleString()} ∇`,
      hint: 'target density and gradient evaluations',
    },
  ]
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
