// The Choreography Lab — periodic orbits of the N-body problem.
//
// Almost every gravitational trajectory is chaotic, but a measure-zero skeleton
// of exact *periodic orbits* runs through the chaos. This lab renders that
// skeleton: pick an orbit and watch the bodies chase each other around a closed
// track forever, then read its stability straight off the **Floquet multipliers**
// (the eigenvalues of the monodromy matrix), all computed from scratch in
// `sim/periodic.ts`. The famous figure-eight choreography turns out to be
// linearly stable (every multiplier on the unit circle); the classical central
// configurations — Lagrange's triangle, Euler's line, the Klemperer rosettes —
// are all unstable, their multipliers flung off the circle.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildGallery,
  sampleTrajectory,
  integrateMonodromy,
  floquet,
  conservedWith,
  refineOrbit,
  figureEight,
  DEFAULT_CONFIG,
} from '../sim/periodic'
import type { OrbitSeed, FloquetAnalysis, Complex, TrajectorySample } from '../sim/periodic'

// Distinct body colours (up to the largest rosette we ship).
const BODY_COLORS = ['#ffb27a', '#7ab2ff', '#9ae6a0', '#e08cff', '#ffe066', '#7fe6d8', '#ff7a9c', '#b0b8d8']

export interface ChoreographyPanelProps {
  /** Send the selected periodic orbit into the live N-body studio. */
  onLaunch?: (orbit: OrbitSeed) => void
}

interface Analysis {
  id: string
  traj: TrajectorySample
  floquet: FloquetAnalysis
  residual: number
  energy: number
  angular: number
  bounds: { cx: number; cy: number; span: number }
  steps: number
}

function analysisStepsFor(period: number): number {
  return Math.min(60000, Math.max(6000, Math.round(period * 3200)))
}

function analyze(orbit: OrbitSeed): Analysis {
  const cfg = DEFAULT_CONFIG
  const steps = analysisStepsFor(orbit.period)
  const mono = integrateMonodromy(orbit.psi, orbit.n, orbit.mass, orbit.period, steps, cfg)
  let res = 0
  for (let i = 0; i < 4 * orbit.n; i++) {
    const d = mono.psiT[i] - orbit.psi[i]
    res += d * d
  }
  res = Math.sqrt(res)
  const f = floquet(mono.monodromy, 4 * orbit.n, 3e-3)
  const c = conservedWith(orbit.psi, orbit.n, orbit.mass, cfg)
  // A trajectory over one period for drawing (dense, high sub-step accuracy).
  const traj = sampleTrajectory(orbit.psi, orbit.n, orbit.mass, orbit.period, cfg, 720, 1, Math.max(6, Math.round(steps / 720)))
  // Bounds over the drawn curve.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let b = 0; b < orbit.n; b++) {
    for (let k = 0; k < traj.count; k++) {
      const x = traj.px[b][k], y = traj.py[b][k]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  const span = Math.max(maxX - minX, maxY - minY) * 1.15 || 1
  return {
    id: orbit.id,
    traj,
    floquet: f,
    residual: res,
    energy: c.energy,
    angular: c.angular,
    bounds: { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, span },
    steps,
  }
}

export function ChoreographyPanel({ onLaunch }: ChoreographyPanelProps) {
  const gallery = useMemo(() => buildGallery(), [])
  const [selId, setSelId] = useState(gallery[0].id)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [refineHist, setRefineHist] = useState<number[] | null>(null)

  const orbit = useMemo(() => gallery.find((o) => o.id === selId) ?? gallery[0], [gallery, selId])
  // Derived — no effect needed. The analysis lags the selection by one solve.
  const computing = !analysis || analysis.id !== orbit.id

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const specRef = useRef<HTMLCanvasElement | null>(null)
  const cursorRef = useRef(0)
  const rafRef = useRef(0)
  const playingRef = useRef(playing)
  const speedRef = useRef(speed)
  useEffect(() => {
    playingRef.current = playing
    speedRef.current = speed
  }, [playing, speed])

  // Compute the analysis whenever the selected orbit changes. A short timeout
  // lets the "computing…" overlay paint before the synchronous monodromy solve
  // blocks; all state updates happen inside the async callback (never in the
  // effect body itself).
  useEffect(() => {
    cursorRef.current = 0
    let cancelled = false
    const id = setTimeout(() => {
      const a = analyze(orbit)
      if (!cancelled) {
        setAnalysis(a)
        setRefineHist(null)
      }
    }, 20)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [orbit])

  // The animation loop — advance the cursor around the closed track and redraw.
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const a = analysis
    if (!canvas || !a) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = canvas.width, H = canvas.height
    const { cx, cy, span } = a.bounds
    const scale = Math.min(W, H) / span
    const toX = (x: number) => W / 2 + (x - cx) * scale
    const toY = (y: number) => H / 2 - (y - cy) * scale

    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#05060c'
    ctx.fillRect(0, 0, W, H)

    const N = a.traj.px.length // the analysed orbit's body count (may lag selection)
    const count = a.traj.count
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    // Faint full track(s): one shared curve for a choreography, N circles for a
    // relative equilibrium.
    ctx.lineWidth = Math.max(1, dpr)
    for (let b = 0; b < N; b++) {
      ctx.strokeStyle = `${BODY_COLORS[b % BODY_COLORS.length]}22`
      ctx.beginPath()
      for (let k = 0; k < count; k++) {
        const x = toX(a.traj.px[b][k]), y = toY(a.traj.py[b][k])
        if (k === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }

    const cur = cursorRef.current % count
    // Trails: the last ~140 samples behind each body, brightening toward it.
    const trail = 140
    for (let b = 0; b < N; b++) {
      const col = BODY_COLORS[b % BODY_COLORS.length]
      ctx.lineWidth = Math.max(1.4, 1.6 * dpr)
      for (let s = 1; s < trail; s++) {
        const k0 = (cur - s + count) % count
        const k1 = (cur - s + 1 + count) % count
        // Skip the wrap seam.
        if (k1 === 0) continue
        const alpha = (1 - s / trail) * 0.9
        ctx.strokeStyle = hexA(col, alpha)
        ctx.beginPath()
        ctx.moveTo(toX(a.traj.px[b][k0]), toY(a.traj.py[b][k0]))
        ctx.lineTo(toX(a.traj.px[b][k1]), toY(a.traj.py[b][k1]))
        ctx.stroke()
      }
    }
    // Bodies.
    for (let b = 0; b < N; b++) {
      const col = BODY_COLORS[b % BODY_COLORS.length]
      const x = toX(a.traj.px[b][cur]), y = toY(a.traj.py[b][cur])
      const r = Math.max(3.5, 4 * dpr)
      const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 3)
      glow.addColorStop(0, hexA(col, 0.5))
      glow.addColorStop(1, hexA(col, 0))
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(x, y, r * 3, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = col
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
  }, [analysis])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const cssW = canvas.clientWidth || 280
    const cssH = Math.round(cssW * 0.82)
    canvas.style.height = `${cssH}px`
    canvas.width = Math.max(1, Math.round(cssW * dpr))
    canvas.height = Math.max(1, Math.round(cssH * dpr))

    const loop = () => {
      if (playingRef.current && analysis) {
        cursorRef.current += Math.max(1, Math.round(speedRef.current))
      }
      draw()
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [draw, analysis])

  // Draw the Floquet spectrum on the unit circle.
  useEffect(() => {
    const canvas = specRef.current
    const a = analysis
    if (!canvas || !a) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const cssW = canvas.clientWidth || 280
    const cssH = 150
    canvas.style.height = `${cssH}px`
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = canvas.width, H = canvas.height
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#0a0c14'
    ctx.fillRect(0, 0, W, H)
    const cx = W / 2, cy = H / 2
    // Scale so the largest multiplier (or 1.4) fits.
    const maxR = Math.max(1.4, Math.min(6, a.floquet.maxModulus * 1.1))
    const R = (Math.min(W, H) / 2) * 0.86 / maxR

    // Axes.
    ctx.strokeStyle = '#ffffff14'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke()
    // Unit circle — the stability boundary.
    ctx.strokeStyle = '#6fe6c0aa'
    ctx.lineWidth = Math.max(1, dpr)
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke()

    for (const l of a.floquet.multipliers) {
      const mod = Math.hypot(l.re, l.im)
      const px = cx + l.re * R
      const py = cy - l.im * R
      const onCircle = Math.abs(mod - 1) < 3e-3
      ctx.fillStyle = onCircle ? '#7ab2ff' : '#ff6b6b'
      ctx.beginPath(); ctx.arc(px, py, Math.max(2.6, 3 * dpr), 0, Math.PI * 2); ctx.fill()
    }
  }, [analysis])

  const runRefine = useCallback(() => {
    // Live corrector demo: start from a perturbed figure-eight seed and watch
    // Newton drive the closure residual to machine precision.
    const seed = figureEight()
    const psi = seed.psi.slice()
    for (let i = 0; i < psi.length; i++) psi[i] += (i % 3 === 0 ? 1 : -1) * 4e-3
    const r = refineOrbit(psi, seed.n, seed.mass, seed.period * 1.01, {
      steps: 6000,
      maxIter: 30,
      tol: 1e-13,
      cfg: DEFAULT_CONFIG,
      tBand: 0.2,
    })
    setRefineHist(r.history)
  }, [])

  const choreos = gallery.filter((o) => o.family === 'choreography')
  const equilibria = gallery.filter((o) => o.family === 'relative-equilibrium')

  return (
    <div className="chaos-panel">
      <p className="integrator-blurb">
        <strong>Periodic orbits &amp; choreographies.</strong> Woven through the chaos are exact
        orbits that close on themselves. Pick one to watch it trace its track, then read its stability
        off the <em>Floquet multipliers</em> — the eigenvalues of the monodromy matrix, found from
        scratch. On the unit circle ⇒ stable; flung off it ⇒ unstable.
      </p>

      <div className="anosova-named">
        <span className="anosova-named-label">Choreographies:</span>
        {choreos.map((o) => (
          <button
            key={o.id}
            className={`anosova-chip ${o.id === selId ? 'active' : ''}`}
            title={o.blurb}
            onClick={() => setSelId(o.id)}
          >
            {o.name}
          </button>
        ))}
      </div>
      <div className="anosova-named">
        <span className="anosova-named-label">Central configs:</span>
        {equilibria.map((o) => (
          <button
            key={o.id}
            className={`anosova-chip ${o.id === selId ? 'active' : ''}`}
            title={o.blurb}
            onClick={() => setSelId(o.id)}
          >
            {o.name}
          </button>
        ))}
      </div>

      <div className="atlas-wrap">
        <canvas ref={canvasRef} className="atlas-canvas" style={{ width: '100%' }} />
        {computing && <div className="choreo-computing">analysing monodromy…</div>}
      </div>

      <div className="choreo-controls">
        <button className="anosova-chip" onClick={() => setPlaying((p) => !p)}>
          {playing ? '❚❚ Pause' : '► Play'}
        </button>
        <label className="choreo-speed">
          speed
          <input type="range" min={1} max={8} step={1} value={speed} onChange={(e) => setSpeed(+e.target.value)} />
        </label>
      </div>

      <p className="preset-desc" style={{ margin: '2px 0 6px' }}>{orbit.blurb}</p>

      {analysis && (
        <>
          <div className="anosova-readout">
            <div className="stat"><span className="stat-label">Bodies</span><span className="stat-value">{orbit.n}</span></div>
            <div className="stat"><span className="stat-label">Period T</span><span className="stat-value">{orbit.period.toFixed(4)}</span></div>
            <div className="stat"><span className="stat-label">Energy</span><span className="stat-value">{analysis.energy.toFixed(4)}</span></div>
            <div className="stat"><span className="stat-label">Ang. mom.</span><span className="stat-value">{fmtSmall(analysis.angular)}</span></div>
            <div className="stat"><span className="stat-label">Closure ‖φ_T−id‖</span><span className="stat-value">{analysis.residual.toExponential(1)}</span></div>
            <div className="stat"><span className="stat-label">det M</span><span className="stat-value">{analysis.floquet.determinant.toFixed(4)}</span></div>
          </div>

          <div className="choreo-verdict">
            <span className={`choreo-badge ${analysis.floquet.verdict}`}>
              {analysis.floquet.verdict === 'stable' ? '● linearly stable' : '▲ unstable'}
            </span>
            <span className="choreo-maxmod">
              max |λ| = {analysis.floquet.maxModulus < 100 ? analysis.floquet.maxModulus.toFixed(3) : analysis.floquet.maxModulus.toExponential(2)}
            </span>
          </div>

          <span className="chaos-note" style={{ color: 'var(--muted)' }}>Floquet multipliers on the unit circle</span>
          <canvas ref={specRef} className="atlas-canvas" style={{ width: '100%' }} />
          <p className="preset-desc" style={{ margin: '2px 0' }}>
            det M = {analysis.floquet.determinant.toFixed(6)} (symplectic ⇒ 1); reciprocity error{' '}
            {analysis.floquet.reciprocityError.toExponential(1)} — the multipliers pair up as {'{λ, 1/λ}'}.
          </p>

          {onLaunch && (
            <button className="chaos-run" onClick={() => onLaunch(orbit)}>▶ Launch in Studio</button>
          )}

          {orbit.family === 'choreography' && orbit.period < 8 && (
            <div style={{ marginTop: 8 }}>
              <button className="anosova-chip" onClick={runRefine}>Refine a perturbed seed (Newton)</button>
              {refineHist && <RefineSpark history={refineHist} />}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// A log-scale sparkline of the corrector's residual history — quadratic
// convergence looks like a cliff.
function RefineSpark({ history }: { history: number[] }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const cssW = canvas.clientWidth || 280
    const cssH = 60
    canvas.style.height = `${cssH}px`
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = canvas.width, H = canvas.height
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#0a0c14'
    ctx.fillRect(0, 0, W, H)
    const lo = -14, hi = 0 // log10 residual range
    const N = history.length
    ctx.strokeStyle = '#7ae6b0'
    ctx.lineWidth = Math.max(1.4, dpr)
    ctx.beginPath()
    for (let i = 0; i < N; i++) {
      const l = Math.log10(Math.max(1e-16, history[i]))
      const x = (i / Math.max(1, N - 1)) * W
      const y = H - ((l - lo) / (hi - lo)) * H
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }, [history])
  return (
    <div className="chaos-plot">
      <span className="chaos-note" style={{ color: 'var(--muted)' }}>
        residual → {history.length ? history[history.length - 1].toExponential(1) : '—'} (log scale, {history.length} iters)
      </span>
      <canvas ref={ref} className="atlas-canvas" style={{ width: '100%' }} />
    </div>
  )
}

function hexA(hex: string, alpha: number): string {
  const a = Math.max(0, Math.min(255, Math.round(alpha * 255)))
  return hex + a.toString(16).padStart(2, '0')
}

function fmtSmall(v: number): string {
  return Math.abs(v) < 1e-4 ? v.toExponential(1) : v.toFixed(4)
}

// Re-export for consumers that want the Complex type name in scope.
export type { Complex }
