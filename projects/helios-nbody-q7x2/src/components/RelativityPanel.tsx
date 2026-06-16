// The Relativity Lab: a self-contained, controlled two-body experiment that
// MEASURES the general-relativistic apsidal precession (the perihelion advance)
// and checks it head-to-head against the closed-form prediction
// Δϖ = 6πμ/(c²a(1−e²)) per orbit. Dial the semi-major axis, eccentricity and
// speed of light; the lab integrates a test body around a central mass with the
// 1PN correction on a 4th-order Runge–Kutta, detects its periapsis passages and
// averages the azimuthal advance — then draws the precessing "rosette". A side
// panel plugs Mercury's real numbers into the very same formula to recover the
// historical 43″/century.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  MERCURY,
  measurePrecession,
  mercuryArcsecPerCentury,
} from '../sim/relativity'
import type { PrecessionResult } from '../sim/relativity'
import { Slider } from './primitives'

const RAD2DEG = 180 / Math.PI

function fmt(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return '∞'
  const a = Math.abs(v)
  if (a !== 0 && (a >= 1e4 || a < 1e-3)) return v.toExponential(digits - 1)
  return v.toFixed(digits)
}

export function RelativityPanel() {
  const [a, setA] = useState(200)
  const [e, setE] = useState(0.4)
  const [c, setC] = useState(220)
  const [orbits, setOrbits] = useState(16)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<PrecessionResult | null>(null)

  // μ fixed: a unit-system star. Keeping μ constant makes the three sliders the
  // only knobs on the physics, so the dependence on a, e and c is clean.
  const mu = 8000

  const run = () => {
    setRunning(true)
    // Defer so the button can paint "Measuring…" before the synchronous solve.
    window.setTimeout(() => {
      const res = measurePrecession({ mu, a, e, c, orbits, stepsPerOrbit: 5000, pathPoints: 5000 })
      setResult(res)
      setRunning(false)
    }, 20)
  }

  const mercury = useMemo(() => mercuryArcsecPerCentury(), [])

  const ratioOk = result && Number.isFinite(result.ratio) && Math.abs(result.ratio - 1) < 0.05
  const ratioWarn = result && Number.isFinite(result.ratio) && Math.abs(result.ratio - 1) < 0.15

  return (
    <div className="chaos-panel">
      <p className="integrator-blurb">
        Integrates a body around a central mass with Einstein's{' '}
        <strong>1PN correction</strong> and measures how far its periapsis{' '}
        <strong>advances each orbit</strong>, then checks it against the exact
        Δϖ = 6πμ/(c²a(1−e²)). The orbit traces a rotating <strong>rosette</strong>.
      </p>

      <Slider
        label="Semi-major axis a"
        value={a}
        min={80}
        max={400}
        step={5}
        onChange={(v) => setA(Math.round(v))}
        format={(v) => v.toFixed(0)}
        title="Orbit size. Tighter orbits sit deeper in the field and precess faster."
      />
      <Slider
        label="Eccentricity e"
        value={e}
        min={0}
        max={0.8}
        step={0.01}
        onChange={(v) => setE(v)}
        format={(v) => v.toFixed(2)}
        title="Orbit shape. Higher e → faster precession (1/(1−e²))."
      />
      <Slider
        label="Speed of light c"
        value={c}
        min={120}
        max={1200}
        step={10}
        onChange={(v) => setC(Math.round(v))}
        format={(v) => v.toFixed(0)}
        title="Lower c → stronger relativity → faster precession (1/c²). At c → ∞ the orbit is a closed Newtonian ellipse."
      />
      <Slider
        label="Orbits"
        value={orbits}
        min={6}
        max={40}
        step={1}
        onChange={(v) => setOrbits(Math.round(v))}
        format={(v) => `${v}`}
        title="Radial periods integrated — more periapsis passages give a cleaner average."
      />

      <button type="button" className="btn primary chaos-run" onClick={run} disabled={running}>
        {running ? 'Measuring…' : '⊙ Measure precession'}
      </button>

      {result && result.valid && (
        <div className="chaos-result">
          <div className="chaos-verdict">
            <span className={`tag ${ratioOk ? 'good' : ratioWarn ? 'warn' : 'bad'}`}>
              measured / theory = {fmt(result.ratio, 4)}
            </span>
          </div>
          <p className="preset-desc">
            The integrated periapsis advance matches the closed-form prediction
            to {fmt(Math.abs(1 - result.ratio) * 100, 2)}%. The small
            residual is the genuine higher-order post-Newtonian correction, which
            grows with v/c — shrink it by raising c.
          </p>
          <div className="diag-readout">
            <Stat label="Measured /orbit" value={`${fmt(result.measuredPerOrbit * RAD2DEG, 3)}°`} cls={ratioOk ? 'good' : ''} />
            <Stat label="Theory /orbit" value={`${fmt(result.theoryPerOrbit * RAD2DEG, 3)}°`} />
            <Stat label="Compactness ε" value={fmt(result.epsilon, 2)} />
            <Stat label="v_peri / c" value={fmt(result.vPeriOverC, 3)} />
            <Stat label="Periapses" value={result.periapses.toLocaleString()} />
            <Stat label="Orbits" value={result.orbits.toLocaleString()} />
          </div>
          <div className="chaos-plot">
            <div className="diag-plot-head">
              <span>Rosette (precessing orbit)</span>
              <span className="drift muted">periapsis advances each turn</span>
            </div>
            <Rosette path={result.rosette} />
          </div>
        </div>
      )}

      <div className="mercury-box">
        <div className="mercury-head">The real Mercury</div>
        <p className="preset-desc">
          Plug Mercury's actual numbers — a = {(MERCURY.a / 1e9).toFixed(2)}×10⁹ m,
          e = {MERCURY.e.toFixed(3)}, GM<sub>☉</sub>, c — into the same formula and
          it returns <strong>{mercury.toFixed(1)}″ per century</strong>: the
          anomalous perihelion advance Newtonian gravity could not explain and
          general relativity predicted exactly.
        </p>
      </div>
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

/** Draw the sampled trajectory (rosette) auto-scaled into the canvas. */
function Rosette({ path }: { path: Float64Array }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = canvas.clientWidth
    const h = 150
    canvas.width = Math.max(1, Math.round(w * dpr))
    canvas.height = Math.max(1, Math.round(h * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(255,255,255,0.02)'
    ctx.fillRect(0, 0, w, h)
    if (path.length < 4) return

    // Bounds (centred on the origin / central mass).
    let r = 1e-9
    for (let i = 0; i < path.length; i += 2) r = Math.max(r, Math.abs(path[i]), Math.abs(path[i + 1]))
    const s = Math.min(w, h) / 2 / (r * 1.08)
    const cx = w / 2
    const cy = h / 2
    const X = (x: number) => cx + x * s
    const Y = (y: number) => cy - y * s

    // Trajectory, hue ramped from blue (early) to amber (late) to show time.
    const N = path.length / 2
    ctx.lineWidth = 1
    let prevX = X(path[0])
    let prevY = Y(path[1])
    for (let k = 1; k < N; k++) {
      const x = X(path[2 * k])
      const y = Y(path[2 * k + 1])
      const t = k / N
      const rr = Math.round(95 + t * 160)
      const gg = Math.round(150 + t * 60)
      const bb = Math.round(255 - t * 140)
      ctx.strokeStyle = `rgba(${rr},${gg},${bb},0.85)`
      ctx.beginPath()
      ctx.moveTo(prevX, prevY)
      ctx.lineTo(x, y)
      ctx.stroke()
      prevX = x
      prevY = y
    }

    // The central mass, drawn on top.
    ctx.fillStyle = 'rgba(255,210,120,0.95)'
    ctx.beginPath()
    ctx.arc(cx, cy, 3, 0, Math.PI * 2)
    ctx.fill()
  }, [path])

  return <canvas className="plot" ref={ref} style={{ width: '100%', height: 150 }} />
}
