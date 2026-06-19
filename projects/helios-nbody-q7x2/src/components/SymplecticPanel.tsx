// The Symplectic Lab: a self-contained planetary-dynamics experiment that pits
// the Wisdom–Holman integrator head-to-head against ordinary velocity Verlet and
// Runge–Kutta 4, all integrating the SAME unsoftened N-body Hamiltonian at the
// SAME (deliberately coarse) step size. The payoff plot is the energy-error
// trace: WH stays flat and bounded, Verlet ripples (also bounded, but far
// larger), and the non-symplectic RK4 drifts secularly away. It is the textbook
// demonstration of why long-term Solar-System integrations are done with WH.
//
// All physics is in `sim/whfast.ts` (the integrator) and `sim/kepler.ts` (the
// exact two-body propagator at its heart); this panel is controls + plots. It
// never touches the live Barnes–Hut engine.

import { useMemo, useState } from 'react'
import { LAB_PRESETS, presetById, runComparison } from '../sim/whfast'
import type { MethodId, MethodTrace, SimResult } from '../sim/whfast'
import { Slider, Select, Toggle } from './primitives'

const METHOD_COLOR: Record<MethodId, string> = {
  wh2: 'rgba(122,224,168,0.95)', // green
  wh4: 'rgba(120,200,255,0.95)', // cyan
  verlet: 'rgba(255,210,120,0.95)', // amber
  rk4: 'rgba(255,122,122,0.95)', // red
}

function fmt(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a !== 0 && (a >= 1e4 || a < 1e-3)) return v.toExponential(digits - 1)
  return v.toFixed(digits)
}

export function SymplecticPanel() {
  const [presetId, setPresetId] = useState(LAB_PRESETS[0].id)
  const preset = useMemo(() => presetById(presetId), [presetId])
  const [dt, setDt] = useState(preset.dt)
  const [orbits, setOrbits] = useState(60)
  const [useWh4, setUseWh4] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<SimResult | null>(null)

  // When the preset changes, adopt its suggested coarse step.
  const onPreset = (id: string) => {
    setPresetId(id)
    setDt(presetById(id).dt)
    setResult(null)
  }

  const run = () => {
    setRunning(true)
    window.setTimeout(() => {
      const bodies = preset.build()
      // Duration is expressed in inner-planet orbits for an intuitive knob.
      const inner = bodies[1]
      const r = Math.hypot(inner.x - bodies[0].x, inner.y - bodies[0].y)
      const mu = preset.G * (bodies[0].m + inner.m)
      const T = 2 * Math.PI * Math.sqrt((r * r * r) / mu)
      const methods: MethodId[] = useWh4 ? ['wh2', 'wh4', 'verlet', 'rk4'] : ['wh2', 'verlet', 'rk4']
      const res = runComparison({
        bodies, G: preset.G, dt, duration: orbits * T, samples: 600, methods,
      })
      setResult(res)
      setRunning(false)
    }, 20)
  }

  const wh = result?.traces.find((t) => t.id === 'wh2')
  const verlet = result?.traces.find((t) => t.id === 'verlet')
  const advantage = wh && verlet ? verlet.maxEnergyErr / Math.max(wh.maxEnergyErr, 1e-30) : NaN

  return (
    <div className="chaos-panel">
      <p className="integrator-blurb">
        A planetary system is <strong>nearly Keplerian</strong>: each planet is ruled by the star,
        with the other planets a tiny perturbation. <strong>Wisdom–Holman</strong> integrates the
        dominant Kepler motion <strong>exactly</strong> (a universal-variable propagator) and only
        the small perturbation numerically — so it holds energy bounded forever, thousands of times
        better than Verlet at the same step. This lab races WH against Verlet and RK4 on the{' '}
        <em>identical</em> Hamiltonian at one coarse Δt.
      </p>

      <Select
        label="System"
        value={presetId}
        options={LAB_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
        onChange={onPreset}
      />
      <p className="preset-desc">{preset.description}</p>

      <Slider
        label="Step size Δt"
        value={dt}
        min={0.05}
        max={0.6}
        step={0.01}
        onChange={(v) => setDt(v)}
        format={(v) => v.toFixed(2)}
        title="The shared step size. Larger Δt punishes Verlet and RK4 dramatically while WH stays remarkably flat — that gap is the whole point."
      />
      <Slider
        label="Duration"
        value={orbits}
        min={10}
        max={200}
        step={5}
        onChange={(v) => setOrbits(Math.round(v))}
        format={(v) => `${v.toFixed(0)} inner orbits`}
        title="How long to integrate, in periods of the innermost planet. RK4's secular energy drift grows with time; the symplectic methods do not."
      />
      <Toggle
        label="Also run WH 4th order"
        checked={useWh4}
        onChange={setUseWh4}
        title="Add the 4th-order Wisdom–Holman map (a Yoshida triple-jump of the 2nd-order map) to the race."
      />

      <button type="button" className="btn primary chaos-run" onClick={run} disabled={running}>
        {running ? 'Integrating…' : '◷ Run the race'}
      </button>

      {result && wh && verlet && (
        <div className="chaos-result">
          <div className="chaos-verdict">
            <span className="tag good">
              WH conserves energy {fmt(advantage, 4)}× better than Verlet
            </span>
          </div>
          <p className="preset-desc">
            Every method took the same {fmt(result.times[result.times.length - 1] / (result.innerPeriod || 1), 0)}-orbit
            journey at Δt={fmt(dt)}. The symplectic methods keep |ΔE/E| <em>bounded</em>; Runge–Kutta,
            though 4th-order accurate per step, has no such guarantee and its energy walks away.
          </p>

          <div className="diag-readout">
            {result.traces.map((t) => (
              <Stat
                key={t.id}
                label={`${t.label}`}
                value={`${fmt(t.maxEnergyErr, 3)}`}
                color={METHOD_COLOR[t.id]}
              />
            ))}
          </div>

          <div className="chaos-plot">
            <div className="diag-plot-head">
              <span>Energy error |ΔE/E₀| vs time (log scale)</span>
              <span className="drift muted">flat = symplectic</span>
            </div>
            <EnergyPlot traces={result.traces} />
            <Legend traces={result.traces} />
          </div>

          <div className="chaos-plot">
            <div className="diag-plot-head">
              <span>Orbits (Wisdom–Holman)</span>
              <span className="drift muted">{wh.paths.length - 1} planets</span>
            </div>
            <OrbitPlot trace={wh} />
          </div>
        </div>
      )}

      <div className="mercury-box">
        <div className="mercury-head">Why it works</div>
        <p className="preset-desc">
          WH splits the Hamiltonian H = H<sub>Kepler</sub> + H<sub>interaction</sub> + H<sub>Sun</sub>,
          advances each planet along its osculating ellipse <em>analytically</em> with a
          universal-variable Kepler solver (good for any eccentricity), and integrates only the faint
          planet–planet tug. Because the approximated piece is tiny, the energy error scales with the
          <em> perturbation</em>, not the full dynamics — the principle behind SWIFT, MERCURY and REBOUND.
        </p>
      </div>
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="stat">
      <span className="stat-label" style={color ? { color } : undefined}>{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  )
}

function Legend({ traces }: { traces: MethodTrace[] }) {
  return (
    <div className="wh-legend">
      {traces.map((t) => (
        <span key={t.id} className="wh-legend-item">
          <span className="wh-swatch" style={{ background: METHOD_COLOR[t.id] }} />
          {t.label}
          {t.symplectic ? '' : ' (drifts)'}
        </span>
      ))}
    </div>
  )
}

/** Multi-series log-y plot of the energy error over time. */
function EnergyPlot({ traces }: { traces: MethodTrace[] }) {
  const canvas = (el: HTMLCanvasElement | null) => {
    if (!el) return
    const ctx = el.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = el.clientWidth
    const h = 150
    el.width = Math.max(1, Math.round(w * dpr))
    el.height = Math.max(1, Math.round(h * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(255,255,255,0.02)'
    ctx.fillRect(0, 0, w, h)

    // Global log-y range across all series (clamped to a sensible floor).
    let lo = Infinity
    let hi = -Infinity
    const FLOOR = 1e-16
    for (const t of traces) {
      for (const e of t.energyErr) {
        const v = Math.log10(Math.max(e, FLOOR))
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return
    lo = Math.floor(lo)
    hi = Math.ceil(hi)
    if (hi - lo < 2) hi = lo + 2

    // Decade gridlines + labels.
    ctx.font = '9px ui-monospace, monospace'
    for (let d = lo; d <= hi; d++) {
      const y = h - ((d - lo) / (hi - lo)) * h
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillText(`1e${d}`, 3, Math.min(h - 2, Math.max(9, y - 2)))
    }

    for (const t of traces) {
      const N = t.energyErr.length
      if (N < 2) continue
      ctx.strokeStyle = METHOD_COLOR[t.id]
      ctx.lineWidth = t.id === 'wh2' || t.id === 'wh4' ? 1.8 : 1.2
      ctx.beginPath()
      for (let k = 0; k < N; k++) {
        const px = (k / (N - 1)) * w
        const v = Math.log10(Math.max(t.energyErr[k], FLOOR))
        const py = h - ((v - lo) / (hi - lo)) * h
        if (k === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.stroke()
    }
  }
  return <canvas className="plot" ref={canvas} style={{ width: '100%', height: 150 }} />
}

/** Top-down view of the planetary orbits, auto-scaled, star at the barycentre. */
function OrbitPlot({ trace }: { trace: MethodTrace }) {
  const canvas = (el: HTMLCanvasElement | null) => {
    if (!el) return
    const ctx = el.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = el.clientWidth
    const h = 170
    el.width = Math.max(1, Math.round(w * dpr))
    el.height = Math.max(1, Math.round(h * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(255,255,255,0.02)'
    ctx.fillRect(0, 0, w, h)

    // Extent over all bodies' paths.
    let R = 1e-9
    for (const p of trace.paths) {
      for (let k = 0; k < p.length; k += 2) R = Math.max(R, Math.abs(p[k]), Math.abs(p[k + 1]))
    }
    const s = (Math.min(w, h) / 2 / R) * 0.92
    const cx = w / 2
    const cy = h / 2
    const X = (v: number) => cx + v * s
    const Y = (v: number) => cy - v * s

    const planetHue = ['rgba(120,200,255,0.85)', 'rgba(122,224,168,0.85)', 'rgba(255,210,120,0.85)', 'rgba(220,160,255,0.85)', 'rgba(255,150,150,0.85)']
    for (let b = 1; b < trace.paths.length; b++) {
      const p = trace.paths[b]
      ctx.strokeStyle = planetHue[(b - 1) % planetHue.length]
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let k = 0; k < p.length; k += 2) {
        const px = X(p[k])
        const py = Y(p[k + 1])
        if (k === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.stroke()
    }
    // Star at the barycentre.
    ctx.fillStyle = 'rgba(255,235,150,0.95)'
    ctx.beginPath()
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2)
    ctx.fill()
  }
  return <canvas className="plot" ref={canvas} style={{ width: '100%', height: 170 }} />
}
