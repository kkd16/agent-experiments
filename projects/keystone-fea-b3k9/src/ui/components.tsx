// Presentational building blocks for the studio panels.

import { useMemo, useState } from 'react'
import { COLORMAP_STOPS, type Colormap } from './colormap'
import { runAllBenchmarks, type Check } from '../engine/validate'
import { fmtEng } from './format'

export function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={o.value}
          className={o.value === value ? 'seg active' : 'seg'}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
  format,
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
  onChange: (v: number) => void
  format?: (v: number) => string
}) {
  return (
    <label className="slider">
      <div className="slider-row">
        <span>{label}</span>
        <span className="slider-val">{format ? format(value) : value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </label>
  )
}

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

export function Legend({
  colormap,
  min,
  max,
  unit,
  label,
}: {
  colormap: Colormap
  min: number
  max: number
  unit: string
  label: string
}) {
  const grad = useMemo(() => {
    const stops = COLORMAP_STOPS[colormap]
    return stops.map(([p, c]) => `rgb(${c[0]},${c[1]},${c[2]}) ${(p * 100).toFixed(0)}%`).join(', ')
  }, [colormap])
  return (
    <div className="legend">
      <div className="legend-label">{label}</div>
      <div className="legend-bar" style={{ background: `linear-gradient(90deg, ${grad})` }} />
      <div className="legend-scale">
        <span>{fmtEng(min, unit)}</span>
        <span>{fmtEng((min + max) / 2, unit)}</span>
        <span>{fmtEng(max, unit)}</span>
      </div>
    </div>
  )
}

function CheckRow({ c }: { c: Check }) {
  return (
    <div className={c.pass ? 'check pass' : 'check fail'}>
      <span className="check-mark">{c.pass ? '✓' : '✕'}</span>
      <div className="check-body">
        <div className="check-name">{c.name}</div>
        <div className="check-detail">
          <code>{c.detail}</code>
        </div>
        <div className="check-nums">
          expected {fmtEng(c.expected, c.unit)} · got {fmtEng(c.computed, c.unit)} · err{' '}
          {c.relError.toExponential(1)}
        </div>
      </div>
    </div>
  )
}

export function VerifyBadge() {
  const { frame, dynamics, continuum, allPass } = useMemo(() => runAllBenchmarks(), [])
  const [open, setOpen] = useState(false)
  const all = [...frame, ...dynamics, ...continuum]
  const passCount = all.filter((c) => c.pass).length
  return (
    <div className={`verify ${allPass ? 'ok' : 'bad'}`}>
      <button className="verify-head" onClick={() => setOpen((o) => !o)}>
        <span className="verify-dot" />
        <span className="verify-title">
          {allPass ? 'Verified' : 'Check failed'} — {passCount}/{all.length}
        </span>
        <span className="verify-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="verify-list">
          <p className="verify-note">
            Every result is produced by the same solver that reproduces these closed-form
            benchmarks. Run live in your browser:
          </p>
          <div className="check-group">Frames &amp; trusses</div>
          {frame.map((c, i) => (
            <CheckRow key={`f${i}`} c={c} />
          ))}
          <div className="check-group">Dynamics &amp; stability</div>
          {dynamics.map((c, i) => (
            <CheckRow key={`d${i}`} c={c} />
          ))}
          <div className="check-group">Continuum (plane stress)</div>
          {continuum.map((c, i) => (
            <CheckRow key={`c${i}`} c={c} />
          ))}
        </div>
      )}
    </div>
  )
}
