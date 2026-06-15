// The Chaos Lab: run a variational-equations analysis on the live system and
// report MEGNO, the maximal Lyapunov exponent and a verdict — is this orbit
// regular (predictable forever) or chaotic (exponentially sensitive)?

import type { ChaosClass, ChaosResult } from '../sim/chaos'
import { CHAOS_BODY_LIMIT } from '../sim/chaos'
import type { Series } from './Plot'
import { Plot } from './Plot'
import { Slider } from './primitives'

interface Props {
  result: ChaosResult | null
  running: boolean
  horizon: number
  onHorizon: (n: number) => void
  onRun: () => void
  bodyCount: number
}

const CLASS_LABEL: Record<ChaosClass, string> = {
  regular: 'Regular',
  'weakly-chaotic': 'Weakly chaotic',
  chaotic: 'Chaotic',
}
const CLASS_TAG: Record<ChaosClass, string> = {
  regular: 'good',
  'weakly-chaotic': 'warn',
  chaotic: 'bad',
}
const CLASS_BLURB: Record<ChaosClass, string> = {
  regular: 'Quasi-periodic — nearby orbits stay nearby. The future is predictable for as long as you like.',
  'weakly-chaotic': 'On the edge — weak exponential divergence over the analysed window. Long-term behaviour is borderline.',
  chaotic: 'Sensitive dependence on initial conditions — nearby orbits diverge exponentially. Prediction has a horizon.',
}

function fmt(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return '∞'
  const a = Math.abs(v)
  if (a !== 0 && (a >= 1e4 || a < 1e-3)) return v.toExponential(digits - 1)
  return v.toFixed(digits)
}

export function ChaosPanel({ result, running, horizon, onHorizon, onRun, bodyCount }: Props) {
  const tooBig = bodyCount > CHAOS_BODY_LIMIT
  const tooSmall = bodyCount < 2
  const disabled = running || tooBig || tooSmall

  // Build the MEGNO history as a Plot series (oldest sample first, start = 0).
  let megnoSeries: Series | null = null
  let lyapSeries: Series | null = null
  if (result && result.samples.length >= 2) {
    const m = new Float64Array(result.samples.length)
    const l = new Float64Array(result.samples.length)
    for (let i = 0; i < result.samples.length; i++) {
      m[i] = result.samples[i].megno
      l[i] = result.samples[i].lyapunov
    }
    megnoSeries = { color: '#ff9d5c', data: m, length: m.length, start: 0 }
    lyapSeries = { color: '#5fd0ff', data: l, length: l.length, start: 0 }
  }

  return (
    <div className="chaos-panel">
      <p className="integrator-blurb">
        Evolves an infinitesimal deviation under the linearised flow to measure{' '}
        <strong>MEGNO ⟨Y⟩</strong> (→ 2 for regular orbits) and the maximal{' '}
        <strong>Lyapunov exponent λ</strong>. Exact O(N²) per step — best on the small systems
        (3-body problems, the solar system).
      </p>
      <Slider
        label="Horizon"
        value={horizon}
        min={2000}
        max={40000}
        step={1000}
        onChange={(v) => onHorizon(Math.round(v))}
        format={(v) => `${(v / 1000).toFixed(0)}k steps`}
        title="How many steps to integrate the variational equations — longer gives a sharper verdict"
      />
      <button type="button" className="btn primary chaos-run" onClick={onRun} disabled={disabled}>
        {running ? 'Analysing…' : '⟿ Analyse chaos'}
      </button>
      {tooBig && (
        <p className="chaos-note">
          System too large (N = {bodyCount.toLocaleString()} &gt; {CHAOS_BODY_LIMIT}). The variational
          solver is O(N²) per step — pick a smaller scenario.
        </p>
      )}
      {tooSmall && <p className="chaos-note">Need at least two bodies to analyse.</p>}

      {result && (
        <div className="chaos-result">
          <div className="chaos-verdict">
            <span className={`tag ${CLASS_TAG[result.classification]}`}>
              {CLASS_LABEL[result.classification]}
            </span>
          </div>
          <p className="preset-desc">{CLASS_BLURB[result.classification]}</p>
          <div className="diag-readout">
            <Stat label="MEGNO ⟨Y⟩" value={fmt(result.megno)} cls={result.classification === 'regular' ? 'good' : ''} />
            <Stat label="Lyapunov λ" value={fmt(result.lyapunov)} />
            <Stat
              label="Lyapunov time"
              value={Number.isFinite(result.lyapunovTime) ? fmt(result.lyapunovTime, 1) : '∞'}
            />
            <Stat label="e-foldings" value={fmt(result.efoldings, 2)} />
            <Stat label="Bodies" value={result.n.toLocaleString()} />
            <Stat label="Steps" value={result.steps.toLocaleString()} />
          </div>
          {megnoSeries && (
            <div className="chaos-plot">
              <div className="diag-plot-head">
                <span>MEGNO ⟨Y⟩ vs time</span>
                <span className="drift muted">regular → 2</span>
              </div>
              <Plot series={[megnoSeries]} height={56} zeroBaseline={false} />
            </div>
          )}
          {lyapSeries && (
            <div className="chaos-plot">
              <div className="diag-plot-head">
                <span>Lyapunov λ(t)</span>
                <span className="drift muted">regular → 0</span>
              </div>
              <Plot series={[lyapSeries]} height={48} zeroBaseline />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${cls ?? ''}`}>{value}</span>
    </div>
  )
}
