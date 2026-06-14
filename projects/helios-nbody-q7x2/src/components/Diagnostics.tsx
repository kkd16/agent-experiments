// Bottom diagnostics dock: live conservation plots plus numeric readouts. These
// are what let you *see* an integrator's quality — a symplectic scheme keeps the
// energy-drift trace flat; explicit Euler visibly ramps it.

import type { Diagnostics as Diag } from '../sim/types'
import type { Series } from './Plot'
import { Plot } from './Plot'

interface Props {
  diag: Diag | null
  energySeries: Series
  momentumSeries: Series
  exactEnergy: boolean
  collapsed: boolean
  onToggle: () => void
  /** Cumulative merge events (only meaningful when collisions are enabled). */
  mergeCount: number
  collideOn: boolean
}

function fmt(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a !== 0 && (a >= 1e5 || a < 1e-2)) return v.toExponential(digits)
  return v.toFixed(digits)
}

export function DiagnosticsDock({
  diag,
  energySeries,
  momentumSeries,
  exactEnergy,
  collapsed,
  onToggle,
  mergeCount,
  collideOn,
}: Props) {
  const drift = diag?.energyDrift
  const driftPct = drift != null && Number.isFinite(drift) ? drift * 100 : null
  const driftClass =
    driftPct == null ? '' : Math.abs(driftPct) < 0.5 ? 'good' : Math.abs(driftPct) < 5 ? 'warn' : 'bad'

  return (
    <div className={`diag-dock ${collapsed ? 'collapsed' : ''}`}>
      <button type="button" className="diag-handle" onClick={onToggle}>
        {collapsed ? '▴ Diagnostics' : '▾ Diagnostics'}
      </button>
      {!collapsed && (
        <div className="diag-body">
          <div className="diag-plot">
            <div className="diag-plot-head">
              <span>Energy drift</span>
              {exactEnergy ? (
                <span className={`drift ${driftClass}`}>
                  {driftPct == null ? '—' : `${driftPct >= 0 ? '+' : ''}${driftPct.toFixed(3)}%`}
                </span>
              ) : (
                <span className="drift muted" title="Potential energy is O(n²); skipped above the body-count limit.">
                  N too large
                </span>
              )}
            </div>
            {exactEnergy ? (
              <Plot series={[energySeries]} height={60} unit="%" />
            ) : (
              <div className="plot-disabled">exact energy disabled for large N</div>
            )}
          </div>

          <div className="diag-plot">
            <div className="diag-plot-head">
              <span>|Momentum|</span>
              <span className="drift muted">conserved ≈ const</span>
            </div>
            <Plot series={[momentumSeries]} height={60} zeroBaseline />
          </div>

          <div className="diag-readout">
            <Stat label="Kinetic E" value={fmt(diag?.kinetic ?? NaN)} />
            <Stat label="Potential E" value={exactEnergy ? fmt(diag?.potential ?? NaN) : '—'} />
            <Stat label="Total E" value={exactEnergy ? fmt(diag?.total ?? NaN) : '—'} />
            <Stat
              label="|p|"
              value={fmt(
                diag ? Math.hypot(diag.momentumX, diag.momentumY) : NaN,
              )}
            />
            <Stat label="L (ang. mom.)" value={fmt(diag?.angularMomentum ?? NaN)} />
            {collideOn && <Stat label="Merges" value={mergeCount.toLocaleString()} />}
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  )
}
