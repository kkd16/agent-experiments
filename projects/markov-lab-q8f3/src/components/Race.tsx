// The head-to-head "compare bar" for Race mode: two samplers, one target, one
// seed. Every metric that admits a winner is drawn as a split bar so you can
// see at a glance which algorithm is getting more information per unit of work
// — the whole argument for gradients and adaptation in a single panel.

import type { LiveStats } from '../engine/simulation'

export interface LaneMeta {
  name: string
  color: string
}

function fmt(v: number, digits = 1): string {
  if (!isFinite(v)) return '—'
  if (Math.abs(v) >= 1e5) return v.toExponential(1)
  return v.toFixed(digits)
}

interface RowSpec {
  label: string
  a: number
  b: number
  digits?: number
  /** true → bigger is better (ESS); false → smaller is better (τ). */
  moreIsBetter: boolean
  /** context-only metrics have no winner (accept rate, iterations). */
  neutral?: boolean
  hint: string
}

function MetricRow({ spec, meta }: { spec: RowSpec; meta: [LaneMeta, LaneMeta] }) {
  const { a, b, digits = 1, moreIsBetter, neutral } = spec
  // Bar fractions from the raw magnitudes (guard against 0/0 and non-finite).
  const av = isFinite(a) ? Math.max(0, a) : 0
  const bv = isFinite(b) ? Math.max(0, b) : 0
  const tot = av + bv
  const fa = tot > 0 ? av / tot : 0.5
  // Winner: compare on the "goodness" direction.
  let winA = false
  let winB = false
  if (!neutral && isFinite(a) && isFinite(b) && a !== b) {
    const aBetter = moreIsBetter ? a > b : a < b
    winA = aBetter
    winB = !aBetter
  }
  return (
    <div className="cmp-row" title={spec.hint}>
      <div className="cmp-label">{spec.label}</div>
      <div className={`cmp-num a ${winA ? 'win' : ''}`}>{fmt(a, digits)}</div>
      <div className="cmp-bar">
        <span
          className="cmp-fill a"
          style={{ width: `${(fa * 100).toFixed(1)}%`, background: meta[0].color }}
        />
        <span
          className="cmp-fill b"
          style={{ width: `${((1 - fa) * 100).toFixed(1)}%`, background: meta[1].color }}
        />
      </div>
      <div className={`cmp-num b ${winB ? 'win' : ''}`}>{fmt(b, digits)}</div>
    </div>
  )
}

export default function Race({
  stats,
  meta,
  axes,
}: {
  stats: [LiveStats, LiveStats]
  meta: [LaneMeta, LaneMeta]
  axes: [string, string] | string[]
}) {
  const [A, B] = stats
  const [ax, ay] = axes
  const rows: RowSpec[] = [
    { label: `ESS · ${ax}`, a: A.essX, b: B.essX, digits: 0, moreIsBetter: true, hint: 'effective sample size, coordinate 1 — higher is better' },
    { label: `ESS · ${ay}`, a: A.essY, b: B.essY, digits: 0, moreIsBetter: true, hint: 'effective sample size, coordinate 2 — higher is better' },
    { label: 'ESS / 1k eval', a: A.essPerKEval, b: B.essPerKEval, digits: 1, moreIsBetter: true, hint: 'the fair, cost-aware efficiency: effective samples per 1000 density+gradient evaluations' },
    { label: `τ · ${ax}`, a: A.tauX, b: B.tauX, digits: 1, moreIsBetter: false, hint: 'autocorrelation time — steps per independent draw; lower is better' },
    { label: 'accept', a: A.acceptRate * 100, b: B.acceptRate * 100, digits: 1, moreIsBetter: true, neutral: true, hint: 'acceptance rate (context, not a winner)' },
    { label: 'iterations', a: A.iters, b: B.iters, digits: 0, moreIsBetter: true, neutral: true, hint: 'chain length (both step in lockstep)' },
  ]
  // Only meaningful when the target's true mean is known analytically.
  if (A.meanErr !== undefined && B.meanErr !== undefined) {
    rows.splice(3, 0, {
      label: 'mean err',
      a: A.meanErr,
      b: B.meanErr,
      digits: 3,
      moreIsBetter: false,
      hint: 'distance of the running mean from the known true mean — actual accuracy; lower is better',
    })
  }

  // Headline: efficiency ratio, the one number that settles the race.
  const ea = A.essPerKEval
  const eb = B.essPerKEval
  let verdict = 'warming up…'
  let leadColor = 'var(--muted)'
  if (isFinite(ea) && isFinite(eb) && ea > 0 && eb > 0) {
    if (ea >= eb) {
      verdict = `${meta[0].name} leads · ${fmt(ea / eb, 2)}× efficiency`
      leadColor = meta[0].color
    } else {
      verdict = `${meta[1].name} leads · ${fmt(eb / ea, 2)}× efficiency`
      leadColor = meta[1].color
    }
  }

  return (
    <div className="compare">
      <div className="cmp-head">
        <span className="cmp-title">Head to head</span>
        <span className="cmp-verdict" style={{ color: leadColor }}>
          {verdict}
        </span>
      </div>
      <div className="cmp-legend">
        <span className="cmp-key">
          <span className="cmp-dot" style={{ background: meta[0].color }} />
          {meta[0].name}
        </span>
        <span className="cmp-key">
          <span className="cmp-dot" style={{ background: meta[1].color }} />
          {meta[1].name}
        </span>
      </div>
      <div className="cmp-rows">
        {rows.map((r) => (
          <MetricRow key={r.label} spec={r} meta={meta} />
        ))}
      </div>
    </div>
  )
}
