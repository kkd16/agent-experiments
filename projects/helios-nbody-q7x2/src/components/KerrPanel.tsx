// The Kerr Lab: a self-contained strong-field experiment that REVERSE RAY-TRACES
// the exact null geodesics of the KERR (rotating) metric per pixel to render a
// SPINNING black hole. Unlike the Schwarzschild Black-Hole Lab — which exploits
// spherical symmetry to collapse the problem to one planar ODE — this integrates
// the genuine 3-D geodesic (Hamilton's equations, with E, L_z and Carter's
// constant conserved), so frame dragging twists the photon's plane around the
// spin axis and the shadow becomes the famous asymmetric D-shape.
//
// All the physics is in `sim/kerr.ts`; this panel is controls + the progressive
// image + the analytic Bardeen rim overlaid on the *integrated* one (they
// coincide — that is the proof). It never touches the live Barnes–Hut engine.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  renderKerrBands,
  kerrHorizonRadius,
  kerrErgosphere,
  kerrHorizonOmega,
  kerrIscoRadius,
  kerrShadowAlphaAtBeta0,
} from '../sim/kerr'
import type { KerrRenderConfig } from '../sim/kerr'
import { kerrShadowRim } from '../sim/geodesic'
import { Segmented, Slider, Toggle } from './primitives'

const DEG = Math.PI / 180

type Quality = 'low' | 'medium' | 'high'
const QUALITY: Record<Quality, { w: number; h: number; maxSteps: number; stepFrac: number }> = {
  low: { w: 170, h: 128, maxSteps: 4000, stepFrac: 0.06 },
  medium: { w: 240, h: 180, maxSteps: 6000, stepFrac: 0.05 },
  high: { w: 340, h: 255, maxSteps: 9000, stepFrac: 0.04 },
}

function fmt(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a !== 0 && (a >= 1e4 || a < 1e-3)) return v.toExponential(digits - 1)
  return v.toFixed(digits)
}

export function KerrPanel() {
  const [spin, setSpin] = useState(0.9)
  const [inclDeg, setInclDeg] = useState(80)
  const [half, setHalf] = useState(9) // image half-width in M
  const [showDisk, setShowDisk] = useState(true)
  const [diskOuter, setDiskOuter] = useState(20)
  const [doppler, setDoppler] = useState(true)
  const [showGrid, setShowGrid] = useState(true)
  const [showRim, setShowRim] = useState(true)
  const [quality, setQuality] = useState<Quality>('medium')

  const [rendering, setRendering] = useState(false)
  const [progress, setProgress] = useState(0)
  const [renderMs, setRenderMs] = useState<number | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number>(0)
  const tokenRef = useRef(0)

  // Live landmarks (cheap closed forms).
  const rPlus = kerrHorizonRadius(spin)
  const rErgoEq = kerrErgosphere(Math.PI / 2, spin)
  const omH = kerrHorizonOmega(spin)
  const iscoPro = kerrIscoRadius(spin, 1, true)
  const iscoRetro = kerrIscoRadius(spin, 1, false)

  const drawRim = useCallback(
    (ctx: CanvasRenderingContext2D, W: number, H: number) => {
      if (!showRim || spin < 0.02) return
      const aspect = W / H
      const k = kerrShadowRim(spin, inclDeg * DEG, 1, 500)
      const rim = k.rim
      if (rim.length < 4) return
      // Same mapping the renderer uses: α ∈ ±half·aspect, β ∈ ±half.
      const X = (al: number) => ((al / (half * aspect) + 1) * W) / 2
      const Y = (be: number) => ((1 - be / half) * H) / 2
      ctx.beginPath()
      ctx.moveTo(X(rim[0]), Y(rim[1]))
      for (let i = 2; i < rim.length; i += 2) ctx.lineTo(X(rim[i]), Y(rim[i + 1]))
      ctx.closePath()
      ctx.strokeStyle = 'rgba(120,200,255,0.9)'
      ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      ctx.stroke()
      ctx.setLineDash([])
    },
    [showRim, spin, inclDeg, half],
  )

  const render = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let ctx: CanvasRenderingContext2D | null
    try {
      ctx = canvas.getContext('2d')
    } catch {
      return
    }
    if (!ctx) return

    cancelAnimationFrame(rafRef.current)
    const token = ++tokenRef.current
    const q = QUALITY[quality]
    const cfg: KerrRenderConfig = {
      M: 1,
      a: spin,
      distance: 30,
      inclination: inclDeg * DEG,
      halfExtentM: half,
      width: q.w,
      height: q.h,
      diskInner: 0, // clamped to the prograde ISCO inside the renderer
      diskOuter,
      doppler,
      showGrid,
      showDisk,
      maxSteps: q.maxSteps,
      stepFrac: q.stepFrac,
    }
    canvas.width = q.w
    canvas.height = q.h
    let image: ImageData
    try {
      image = ctx.createImageData(q.w, q.h)
    } catch {
      return
    }
    const pixels = image.data
    setRendering(true)
    setProgress(0)
    setRenderMs(null)
    const t0 = performance.now()

    const band = Math.max(3, Math.round(q.h / 30))
    let row = 0
    const step = () => {
      if (token !== tokenRef.current) return
      const row1 = Math.min(q.h, row + band)
      try {
        renderKerrBands(cfg, pixels, row, row1)
        ctx!.putImageData(image, 0, 0)
      } catch {
        setRendering(false)
        return
      }
      row = row1
      setProgress(row / q.h)
      if (row < q.h) {
        rafRef.current = requestAnimationFrame(step)
      } else {
        try {
          drawRim(ctx!, q.w, q.h)
        } catch {
          /* overlay is best-effort */
        }
        setRendering(false)
        setRenderMs(performance.now() - t0)
      }
    }
    rafRef.current = requestAnimationFrame(step)
  }, [spin, inclDeg, half, showDisk, diskOuter, doppler, showGrid, quality, drawRim])

  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  // Frame-dragging shadow edges (cheap bisection of the tracer at i = 90°).
  const [edges, setEdges] = useState<{ pro: number; retro: number } | null>(null)
  const measureEdges = useCallback(() => {
    const retro = kerrShadowAlphaAtBeta0(spin, inclDeg * DEG, 1)
    const pro = kerrShadowAlphaAtBeta0(spin, inclDeg * DEG, -1)
    setEdges({ pro, retro })
  }, [spin, inclDeg])

  return (
    <div className="chaos-panel">
      <p className="integrator-blurb">
        A reverse <strong>ray tracer</strong> for a <strong>spinning</strong> (Kerr) black hole.
        Per pixel a photon is integrated along the <em>exact</em> Kerr null geodesic — Hamilton's
        equations with the energy, axial angular momentum and <strong>Carter's constant</strong> all
        conserved. Frame dragging twists each photon's plane around the spin axis, so the shadow is
        not a disc but the famous asymmetric <strong>D-shape</strong>, and the disc's approaching
        side is beamed bright. The dashed curve is the <em>analytic</em> Bardeen rim — it lands right
        on the integrated boundary.
      </p>

      <Slider
        label="Spin a/M"
        value={spin}
        min={0}
        max={0.998}
        step={0.002}
        onChange={(v) => setSpin(v)}
        format={(v) => v.toFixed(3)}
        title="Dimensionless spin. 0 is Schwarzschild (a round shadow); approaching 1 is near-extremal Kerr (maximally lopsided, with the prograde ISCO almost on the horizon)."
      />
      <Slider
        label="Inclination ι"
        value={inclDeg}
        min={5}
        max={90}
        step={1}
        onChange={(v) => setInclDeg(Math.round(v))}
        format={(v) => `${v.toFixed(0)}°`}
        title="Viewing angle from the spin axis. The asymmetry and frame-dragging displacement are strongest edge-on (90°)."
      />
      <Slider
        label="Zoom (frame half-width)"
        value={half}
        min={6}
        max={14}
        step={0.5}
        onChange={(v) => setHalf(v)}
        format={(v) => `${v.toFixed(1)} M`}
        title="Half-width of the image in units of M. The shadow is roughly 5 M across; lower zooms in tight on the rim and photon ring."
      />
      <Toggle
        label="Accretion disc"
        checked={showDisk}
        onChange={setShowDisk}
        title="A thin disc of gas on prograde circular geodesics, from the prograde ISCO outward."
      />
      {showDisk && (
        <Slider
          label="Disc outer radius"
          value={diskOuter}
          min={10}
          max={32}
          step={1}
          onChange={(v) => setDiskOuter(Math.round(v))}
          format={(v) => `${v.toFixed(0)} M`}
          title="Outer edge of the disc. The inner edge tracks the prograde ISCO, which shrinks as the spin rises."
        />
      )}
      {showDisk && (
        <Toggle
          label="Doppler beaming"
          checked={doppler}
          onChange={setDoppler}
          title="Relativistic Doppler + gravitational + frame-dragging shift g = √(−(g_tt+2Ωg_tφ+Ω²g_φφ))/(1−Ωξ): the side rotating toward you is beamed far brighter (I ∝ g⁴)."
        />
      )}
      <Toggle label="Lensed sky grid" checked={showGrid} onChange={setShowGrid} title="A procedural background sky. Watch it warp into an off-centre Einstein ring." />
      <Toggle label="Analytic rim overlay" checked={showRim} onChange={setShowRim} title="Overlay the closed-form Bardeen/Teo shadow rim on the integrated image — they coincide." />
      <Segmented<Quality>
        label="Quality"
        value={quality}
        options={[
          { value: 'low', label: 'Low', title: '170×128 — fast' },
          { value: 'medium', label: 'Med', title: '240×180' },
          { value: 'high', label: 'High', title: '340×255 — slow' },
        ]}
        onChange={setQuality}
      />

      <button type="button" className="btn primary chaos-run" onClick={render} disabled={rendering}>
        {rendering ? `Tracing… ${(progress * 100).toFixed(0)}%` : '◉ Render Kerr black hole'}
      </button>

      <div className="chaos-plot">
        <div className="diag-plot-head">
          <span>Reverse-ray-traced Kerr image</span>
          <span className="drift muted">{renderMs != null ? `${renderMs.toFixed(0)} ms` : 'exact geodesics'}</span>
        </div>
        <canvas
          className="plot"
          ref={canvasRef}
          style={{ width: '100%', height: 200, background: '#05060c', borderRadius: 6 }}
        />
      </div>

      <div className="diag-readout">
        <Stat label="Horizon r₊" value={`${fmt(rPlus, 3)} M`} />
        <Stat label="Ergosphere (eq)" value={`${fmt(rErgoEq, 3)} M`} cls={spin > 0.05 ? 'good' : ''} />
        <Stat label="Ω_H" value={fmt(omH, 4)} />
        <Stat label="ISCO (pro)" value={`${fmt(iscoPro, 3)} M`} cls="good" />
        <Stat label="ISCO (retro)" value={`${fmt(iscoRetro, 3)} M`} />
        <Stat label="Inner horizon r₋" value={`${fmt(2 - rPlus, 3)} M`} />
      </div>

      <div className="chaos-plot" style={{ marginTop: 8 }}>
        <button type="button" className="btn chaos-run" onClick={measureEdges} disabled={rendering}>
          Measure shadow edges (i = ι)
        </button>
        {edges && (
          <div className="diag-readout">
            <Stat label="Prograde edge" value={`${fmt(edges.pro, 3)} M`} />
            <Stat label="Retrograde edge" value={`${fmt(edges.retro, 3)} M`} />
            <Stat label="Width" value={`${fmt(edges.retro - edges.pro, 3)} M`} />
            <Stat label="Displacement" value={`${fmt(0.5 * (edges.pro + edges.retro), 3)} M`} cls={spin > 0.05 ? 'good' : ''} />
          </div>
        )}
        <p className="preset-desc">
          The two β = 0 edges are found by <strong>bisecting the ray tracer</strong> in α — the
          boundary between captured and escaping photons. Frame dragging pushes the prograde edge
          (the side co-rotating toward you) <em>inward</em> and the retrograde edge <em>outward</em>,
          so the shadow's centre is displaced and it flattens into a D.
        </p>
      </div>

      <div className="mercury-box">
        <div className="mercury-head">Exact geodesics, all the way down</div>
        <p className="preset-desc">
          Every pixel integrates a genuine Kerr null geodesic — no post-Newtonian expansion, no
          planar shortcut. Correctness is pinned by three independent self-tests: the null condition{' '}
          <code>H ≈ 0</code> and <strong>Carter's constant Q</strong> stay put along each ray, and
          the bisected shadow boundary reproduces the closed-form Bardeen/Teo rim. The disc is a
          thin-disc emission model with the exact relativistic shift, not a radiative-transfer
          simulation.
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
