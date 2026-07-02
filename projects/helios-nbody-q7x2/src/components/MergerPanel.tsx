// The Collision Lab: evolve a scattering system *through* physical contact. The hybrid
// (MERCURY) integrator resolves the deep close encounters accurately, so it is finally
// meaningful to let two bodies actually touch and merge. A perfectly-inelastic merger
// conserves total mass, total linear momentum and the centre of mass exactly, removes
// kinetic energy (the inelastic loss μ|v_rel|²/2), and transfers the pair's internal
// orbital angular momentum μ(r_rel×v_rel) into the merged body's spin. This panel runs
// a collision-course system and shows the coalescence plus the exact conservation ledger.
//
// All physics is in `sim/hybrid.ts` (`simulateWithMergers`); this panel is controls + plots.

import { useMemo, useState } from 'react'
import { simulateWithMergers } from '../sim/hybrid'
import type { MassiveBody, MergerResult } from '../sim/hybrid'
import { Slider, Select } from './primitives'

interface CollisionPreset {
  id: string
  label: string
  description: string
  dt: number
  /** Integration span in units where the inner orbit period ≈ 2π. */
  duration: number
  build: (radius: number) => MassiveBody[]
}

/** A planet on a circular orbit of radius `a` about a unit star (CCW), given a nudge. */
function planet(a: number, m: number, radius: number, phase: number, dvx = 0, dvy = 0): MassiveBody {
  const v = Math.sqrt(1 / a)
  return {
    m,
    x: a * Math.cos(phase),
    y: a * Math.sin(phase),
    vx: -v * Math.sin(phase) + dvx,
    vy: v * Math.cos(phase) + dvy,
    radius,
  }
}

const PRESETS: CollisionPreset[] = [
  {
    id: 'head-on',
    label: 'Head-on pair',
    description:
      'Two equal planets share an orbit and shear straight into each other. With finite radii ' +
      'they touch at the deep pass and merge into a single body — momentum and mass conserved, ' +
      'kinetic energy lost to the collision.',
    dt: 0.01,
    duration: 40,
    build: (radius) => [
      { m: 1, x: 0, y: 0, vx: 0, vy: 0, radius: 0.02 },
      { m: 3e-4, x: 0.985, y: 0, vx: 0.055, vy: 1, radius },
      { m: 3e-4, x: 1.015, y: 0, vx: -0.055, vy: 1, radius },
    ],
  },
  {
    id: 'pileup',
    label: 'Three-planet pile-up',
    description:
      'Three close planets on nearly the same orbit cross and collide in sequence — watch the ' +
      'body count fall as they coalesce, each merger conserving mass and momentum exactly.',
    dt: 0.01,
    duration: 60,
    build: (radius) => [
      { m: 1, x: 0, y: 0, vx: 0, vy: 0, radius: 0.02 },
      planet(1.0, 4e-4, radius, 0, 0.05, 0),
      planet(1.0, 4e-4, radius, 0.06, -0.03, 0),
      planet(1.0, 4e-4, radius, -0.06, 0.02, 0.02),
    ],
  },
]

function fmt(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a !== 0 && (a >= 1e4 || a < 1e-3)) return v.toExponential(digits - 1)
  return v.toFixed(digits)
}

export function MergerPanel() {
  const [presetId, setPresetId] = useState(PRESETS[0].id)
  const preset = useMemo(() => PRESETS.find((p) => p.id === presetId) ?? PRESETS[0], [presetId])
  const [radius, setRadius] = useState(0.006)
  const [orbits, setOrbits] = useState(6)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<MergerResult | null>(null)

  const onPreset = (id: string) => {
    setPresetId(id)
    setResult(null)
  }

  const run = () => {
    setRunning(true)
    window.setTimeout(() => {
      const bodies = preset.build(radius)
      const inner = bodies[1]
      const r = Math.hypot(inner.x, inner.y)
      const T = 2 * Math.PI * Math.sqrt((r * r * r) / 1)
      const nSteps = Math.max(1, Math.round((orbits * T) / preset.dt))
      const res = simulateWithMergers(bodies, 1, preset.dt, orbits * T, {}, Math.min(nSteps, 1500))
      setResult(res)
      setRunning(false)
    }, 20)
  }

  const dL = result ? Math.abs(result.angular0 - result.angularF) : NaN
  const keLost = result ? result.events.reduce((s, e) => s + e.keLost, 0) : NaN

  return (
    <div className="chaos-panel">
      <p className="integrator-blurb">
        Once the <strong>hybrid integrator</strong> resolves close encounters, it becomes meaningful
        to let bodies actually <strong>touch</strong>. A perfectly-inelastic merger conserves total
        mass, linear momentum and the centre of mass <em>exactly</em>; it removes kinetic energy (the
        inelastic loss μ|v<sub>rel</sub>|²/2) and hands the pair's internal orbital angular momentum
        μ(r<sub>rel</sub>×v<sub>rel</sub>) to the merged body's <em>spin</em>.
      </p>

      <Select
        label="System"
        value={presetId}
        options={PRESETS.map((p) => ({ value: p.id, label: p.label }))}
        onChange={onPreset}
      />
      <p className="preset-desc">{preset.description}</p>

      <Slider
        label="Collision radius"
        value={radius}
        min={0.003}
        max={0.02}
        step={0.001}
        onChange={setRadius}
        format={(v) => v.toFixed(3)}
        title="The physical radius of each planet. Two bodies merge when their separation drops below the sum of their radii — a bigger radius makes contact easier."
      />
      <Slider
        label="Duration"
        value={orbits}
        min={3}
        max={16}
        step={1}
        onChange={(v) => setOrbits(Math.round(v))}
        format={(v) => `${v.toFixed(0)} inner orbits`}
        title="How long to integrate, in periods of the innermost planet."
      />

      <button type="button" className="btn primary chaos-run" onClick={run} disabled={running}>
        {running ? 'Colliding…' : '◎ Run the collision'}
      </button>

      {result && (
        <div className="chaos-result">
          <div className="chaos-verdict">
            {result.events.length > 0 ? (
              <span className="tag good">
                {result.count0} bodies → {result.countF} after {result.events.length}{' '}
                merger{result.events.length > 1 ? 's' : ''}
              </span>
            ) : (
              <span className="tag">No contact — the planets scattered without touching</span>
            )}
          </div>

          <div className="diag-readout">
            <Stat label="Total mass" value={`${fmt(result.mass0, 4)} → ${fmt(result.massF, 4)}`} />
            <Stat label="Kinetic energy lost" value={fmt(keLost, 3)} />
            <Stat label="L → spin" value={fmt(dL, 3)} />
          </div>

          <p className="preset-desc">
            Mass is conserved to machine precision; the orbital angular momentum lost (
            <strong>{fmt(dL, 3)}</strong>) equals the summed spin transferred at contact (
            {fmt(Math.abs(result.spinTotal), 3)}) — the deficit is not error, it is the pair's
            internal spin that a point-particle model cannot store.
          </p>

          {result.events.length > 0 && (
            <div className="merger-events">
              <div className="diag-plot-head">
                <span>Merger events</span>
                <span className="drift muted">time · separation · KE lost</span>
              </div>
              <ul className="merger-list">
                {result.events.map((e, i) => (
                  <li key={i}>
                    <span className="merger-time">t = {fmt(e.time, 2)}</span>
                    <span className="muted">
                      sep {fmt(e.separation, 4)} · ΔKE {fmt(e.keLost, 2)} · {e.remaining} left
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="chaos-plot">
            <div className="diag-plot-head">
              <span>Trajectories &amp; coalescence</span>
              <span className="drift muted">dashed = merged away</span>
            </div>
            <TrackPlot result={result} />
          </div>
        </div>
      )}

      <div className="mercury-box">
        <div className="mercury-head">The exact ledger</div>
        <p className="preset-desc">
          Each merger sets m = m₁+m₂ with the centre-of-mass position and centre-of-momentum
          velocity, so total mass, linear momentum and the centre of mass are preserved to machine
          precision (radius grows as the cube-root of summed volumes). Kinetic energy strictly
          decreases by μ|v<sub>rel</sub>|²/2, and the tracked orbital angular momentum drops by
          exactly μ(r<sub>rel</sub>×v<sub>rel</sub>) — verified in the self-test battery.
        </p>
      </div>
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="stat">
      <span className="stat-label" style={color ? { color } : undefined}>
        {label}
      </span>
      <span className="stat-value">{value}</span>
    </div>
  )
}

/** Top-down view of every track: solid where it survives, dashed where it merged away. */
function TrackPlot({ result }: { result: MergerResult }) {
  const canvas = (el: HTMLCanvasElement | null) => {
    if (!el) return
    const ctx = el.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = el.clientWidth
    const h = 200
    el.width = Math.max(1, Math.round(w * dpr))
    el.height = Math.max(1, Math.round(h * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(255,255,255,0.02)'
    ctx.fillRect(0, 0, w, h)

    let R = 1e-9
    for (const t of result.tracks) {
      for (let k = 0; k < t.pts.length; k += 2) R = Math.max(R, Math.abs(t.pts[k]), Math.abs(t.pts[k + 1]))
    }
    const s = (Math.min(w, h) / 2 / R) * 0.9
    const cx = w / 2
    const cy = h / 2
    const X = (v: number) => cx + v * s
    const Y = (v: number) => cy - v * s

    // Sort so the massive (star) track draws first/underneath.
    const tracks = [...result.tracks].sort((a, b) => b.mass - a.mass)
    const hues = ['rgba(120,200,255,0.9)', 'rgba(122,224,168,0.9)', 'rgba(255,210,120,0.9)', 'rgba(220,160,255,0.95)', 'rgba(255,150,150,0.9)']
    let ci = 0
    for (const t of tracks) {
      const isStar = t.mass > 0.5
      const color = isStar ? 'rgba(255,235,150,0.5)' : hues[ci++ % hues.length]
      ctx.strokeStyle = color
      ctx.lineWidth = t.merged ? 1 : 1.6
      ctx.setLineDash(t.merged ? [3, 3] : [])
      ctx.beginPath()
      for (let k = 0; k < t.pts.length; k += 2) {
        const px = X(t.pts[k])
        const py = Y(t.pts[k + 1])
        if (k === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.stroke()
      // Mark the endpoint of a merged track (the contact point) with a small ring.
      if (t.merged && t.pts.length >= 2) {
        ctx.setLineDash([])
        ctx.strokeStyle = 'rgba(255,120,120,0.9)'
        ctx.beginPath()
        ctx.arc(X(t.pts[t.pts.length - 2]), Y(t.pts[t.pts.length - 1]), 3, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    ctx.setLineDash([])
    // Star marker at the barycentre.
    ctx.fillStyle = 'rgba(255,235,150,0.95)'
    ctx.beginPath()
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2)
    ctx.fill()
  }
  return <canvas className="plot" ref={canvas} style={{ width: '100%', height: 200 }} />
}
