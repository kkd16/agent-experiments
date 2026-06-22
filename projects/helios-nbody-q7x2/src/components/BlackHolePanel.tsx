// The Black-Hole Lab: a self-contained strong-field experiment that REVERSE
// RAY-TRACES exact null geodesics of the Schwarzschild metric to render the one
// image everyone knows — a black hole. Per pixel a photon is shot backward into
// curved spacetime and integrated until it crosses the horizon (the black
// shadow) or escapes to infinity, where the direction it came from samples a
// procedural sky that is therefore gravitationally LENSED. Along the way it
// gathers a relativistically Doppler-beamed accretion disc. A second view draws
// the exact analytic Kerr (rotating) shadow rim — the famous D-shape.
//
// All the physics is in `sim/geodesic.ts`; this panel is controls + the
// progressive image + the Kerr rim. It never touches the live Barnes–Hut engine.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  renderBlackHoleBands,
  kerrShadowRim,
  criticalImpactParameter,
  shadowAngularRadius,
  iscoRadius,
  photonSphereRadius,
  horizonRadius,
  kerrEquatorialPhotonRadius,
} from '../sim/geodesic'
import type { RayTraceConfig } from '../sim/geodesic'
import { Segmented, Slider, Toggle } from './primitives'

const DEG = Math.PI / 180

type Quality = 'low' | 'medium' | 'high'
const QUALITY: Record<Quality, { w: number; h: number; dPhi: number; maxSteps: number }> = {
  low: { w: 180, h: 135, dPhi: 0.02, maxSteps: 2500 },
  medium: { w: 260, h: 195, dPhi: 0.013, maxSteps: 3500 },
  high: { w: 360, h: 270, dPhi: 0.009, maxSteps: 5000 },
}

function fmt(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a !== 0 && (a >= 1e4 || a < 1e-3)) return v.toExponential(digits - 1)
  return v.toFixed(digits)
}

export function BlackHolePanel() {
  // --- image controls ---
  const [distance, setDistance] = useState(30)
  const [zoom, setZoom] = useState(3) // frame half-width in shadow radii
  const [inclDeg, setInclDeg] = useState(80)
  const [showDisk, setShowDisk] = useState(true)
  const [diskOuter, setDiskOuter] = useState(20)
  const [doppler, setDoppler] = useState(true)
  const [showGrid, setShowGrid] = useState(true)
  const [quality, setQuality] = useState<Quality>('medium')

  const [rendering, setRendering] = useState(false)
  const [progress, setProgress] = useState(0)
  const [renderMs, setRenderMs] = useState<number | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number>(0)
  const tokenRef = useRef(0)

  const bc = criticalImpactParameter(1)
  const thetaSh = shadowAngularRadius(distance, 1)

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
    // Frame the shadow: half-FOV = zoom × shadow angular radius.
    const fovDeg = Math.min(80, Math.max(6, (2 * zoom * thetaSh) / DEG))
    const cfg: RayTraceConfig = {
      M: 1,
      distance,
      fovDeg,
      inclination: inclDeg * DEG,
      width: q.w,
      height: q.h,
      showDisk,
      diskInner: 6,
      diskOuter,
      doppler,
      showGrid,
      dPhi: q.dPhi,
      maxSteps: q.maxSteps,
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

    const band = Math.max(4, Math.round(q.h / 28))
    let row = 0
    const step = () => {
      if (token !== tokenRef.current) return
      const row1 = Math.min(q.h, row + band)
      try {
        renderBlackHoleBands(cfg, pixels, row, row1)
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
        setRendering(false)
        setRenderMs(performance.now() - t0)
      }
    }
    rafRef.current = requestAnimationFrame(step)
  }, [distance, zoom, inclDeg, showDisk, diskOuter, doppler, showGrid, quality, thetaSh])

  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  return (
    <div className="chaos-panel">
      <p className="integrator-blurb">
        A reverse <strong>ray tracer</strong> that integrates the exact null geodesic{' '}
        <code>u'' = −u + 3M u²</code> for every pixel: photons that cross the horizon paint the
        black <strong>shadow</strong>; those that escape sample a procedural sky, gravitationally{' '}
        <strong>lensed</strong>. A relativistically Doppler-beamed <strong>accretion disc</strong>{' '}
        and the <strong>photon ring</strong> complete the picture — the Event-Horizon-Telescope view.
      </p>

      <Slider
        label="Observer distance"
        value={distance}
        min={12}
        max={70}
        step={1}
        onChange={(v) => setDistance(Math.round(v))}
        format={(v) => `${v.toFixed(0)} M`}
        title="How far the camera sits from the black hole, in units of its mass M (closer = a larger, more dramatic shadow)."
      />
      <Slider
        label="Inclination ι"
        value={inclDeg}
        min={0}
        max={90}
        step={1}
        onChange={(v) => setInclDeg(Math.round(v))}
        format={(v) => `${v.toFixed(0)}°`}
        title="Viewing angle from the disc axis. 0° looks straight down (face-on); 90° is edge-on, with the far side of the disc lensed up over the top."
      />
      <Slider
        label="Zoom (frame ÷ shadow)"
        value={zoom}
        min={1.5}
        max={6}
        step={0.25}
        onChange={(v) => setZoom(v)}
        format={(v) => `${v.toFixed(2)}×`}
        title="Field of view, in shadow radii. Lower zooms in tight on the shadow and photon ring."
      />
      <Toggle
        label="Accretion disc"
        checked={showDisk}
        onChange={setShowDisk}
        title="A thin disc of glowing gas on circular geodesics, from the ISCO (6M) outward."
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
          title="Outer edge of the disc. The inner edge is fixed at the ISCO, r = 6M."
        />
      )}
      {showDisk && (
        <Toggle
          label="Doppler beaming"
          checked={doppler}
          onChange={setDoppler}
          title="Relativistic Doppler + gravitational redshift g = √(1−3M/r)/(1−Ωℓ): the side rotating toward you is beamed far brighter (I ∝ g⁴)."
        />
      )}
      <Toggle
        label="Lensed sky grid"
        checked={showGrid}
        onChange={setShowGrid}
        title="A procedural background sky. Watch the grid bend around the hole and form an Einstein ring."
      />
      <Segmented<Quality>
        label="Quality"
        value={quality}
        options={[
          { value: 'low', label: 'Low', title: '180×135 — fast' },
          { value: 'medium', label: 'Med', title: '260×195' },
          { value: 'high', label: 'High', title: '360×270 — slow' },
        ]}
        onChange={setQuality}
      />

      <button type="button" className="btn primary chaos-run" onClick={render} disabled={rendering}>
        {rendering ? `Tracing… ${(progress * 100).toFixed(0)}%` : '◉ Render black hole'}
      </button>

      <div className="chaos-plot">
        <div className="diag-plot-head">
          <span>Reverse-ray-traced image</span>
          <span className="drift muted">{renderMs != null ? `${renderMs.toFixed(0)} ms` : 'exact geodesics'}</span>
        </div>
        <canvas
          className="plot"
          ref={canvasRef}
          style={{ width: '100%', height: 200, background: '#05060c', borderRadius: 6 }}
        />
      </div>

      <div className="diag-readout">
        <Stat label="Shadow radius b_c" value={`${fmt(bc, 4)} M`} cls="good" />
        <Stat label="(= 3√3 M)" value={fmt(3 * Math.sqrt(3), 4)} />
        <Stat label="Apparent radius" value={`${fmt(thetaSh / DEG, 2)}°`} />
        <Stat label="Horizon" value={`${horizonRadius(1)} M`} />
        <Stat label="Photon sphere" value={`${photonSphereRadius(1)} M`} />
        <Stat label="ISCO" value={`${iscoRadius(1)} M`} />
      </div>
      <p className="preset-desc">
        The bright ring hugging the shadow is the <strong>photon ring</strong> — light that looped
        the photon sphere (r = 3M) one or more times before escaping. Its radius is fixed at{' '}
        <code>b_c = 3√3 M ≈ 5.196 M</code> for any observer, the sharpest prediction of the theory.
      </p>

      <KerrRim />

      <div className="mercury-box">
        <div className="mercury-head">What's exact, and what isn't</div>
        <p className="preset-desc">
          The Schwarzschild image integrates <em>exact</em> null geodesics — no post-Newtonian
          expansion — so the shadow size, lensing and photon ring are physically faithful. The Kerr
          panel below draws the <em>exact analytic</em> shadow rim; the <strong>Kerr Lab</strong> now
          ray-traces the rotating image for real, integrating Carter-constant geodesics per pixel.
          The disc is a thin-disc emission model with the exact relativistic redshift, not a
          radiative-transfer simulation.
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

/** The analytic Kerr shadow rim: the famous D-shape, exact in closed form. */
function KerrRim() {
  const [spin, setSpin] = useState(0.9)
  const [inclDeg, setInclDeg] = useState(60)
  const ref = useRef<HTMLCanvasElement | null>(null)
  const k = kerrShadowRim(spin, inclDeg * DEG, 1, 600)
  const bc = criticalImpactParameter(1)
  const rPro = kerrEquatorialPhotonRadius(spin, 1, true)
  const rRetro = kerrEquatorialPhotonRadius(spin, 1, false)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    let ctx: CanvasRenderingContext2D | null
    try {
      ctx = canvas.getContext('2d')
    } catch {
      return
    }
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = canvas.clientWidth
    const h = 180
    canvas.width = Math.max(1, Math.round(w * dpr))
    canvas.height = Math.max(1, Math.round(h * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(255,255,255,0.02)'
    ctx.fillRect(0, 0, w, h)

    const scale = Math.min(w, h) / (2 * 7.0) // ±7 M view
    const cx = w / 2
    const cy = h / 2
    const X = (v: number) => cx + v * scale
    const Y = (v: number) => cy - v * scale

    // axes
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke()

    // Schwarzschild reference circle (a → 0), radius b_c.
    ctx.strokeStyle = 'rgba(120,180,255,0.55)'
    ctx.setLineDash([4, 4])
    ctx.beginPath(); ctx.arc(cx, cy, bc * scale, 0, Math.PI * 2); ctx.stroke()
    ctx.setLineDash([])

    // Kerr rim (filled).
    const rim = k.rim
    if (rim.length >= 4) {
      ctx.beginPath()
      ctx.moveTo(X(rim[0]), Y(rim[1]))
      for (let i = 2; i < rim.length; i += 2) ctx.lineTo(X(rim[i]), Y(rim[i + 1]))
      ctx.closePath()
      ctx.fillStyle = 'rgba(8,9,16,0.95)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,170,90,0.95)'
      ctx.lineWidth = 1.8
      ctx.stroke()
    }

    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '10px ui-monospace, monospace'
    ctx.fillText('spin →', X(1) + 4, cy - 4)
  }, [spin, inclDeg, k.rim, bc])

  return (
    <div className="chaos-plot" style={{ marginTop: 12 }}>
      <div className="diag-plot-head">
        <span>Kerr shadow — the D-shape</span>
        <span className="drift muted">analytic, exact</span>
      </div>
      <p className="preset-desc">
        A <strong>rotating</strong> (Kerr) black hole drags space around it, so its shadow is not a
        circle but a <strong>D-shape</strong>, flattened and displaced on the side that co-rotates
        toward you. The rim (orange) is traced by the unstable spherical photon orbits in closed
        form; the dashed circle is the non-spinning <code>3√3 M</code> shadow for comparison.
      </p>
      <Slider
        label="Spin a/M"
        value={spin}
        min={0}
        max={0.998}
        step={0.002}
        onChange={(v) => setSpin(v)}
        format={(v) => v.toFixed(3)}
        title="Dimensionless spin. 0 is Schwarzschild (a circle); approaching 1 is a near-extremal Kerr black hole (maximally lopsided)."
      />
      <Slider
        label="Inclination i"
        value={inclDeg}
        min={1}
        max={90}
        step={1}
        onChange={(v) => setInclDeg(Math.round(v))}
        format={(v) => `${v.toFixed(0)}°`}
        title="Observer inclination to the spin axis. The asymmetry is strongest viewed edge-on (90°)."
      />
      <canvas className="plot" ref={ref} style={{ width: '100%', height: 180 }} />
      <div className="diag-readout">
        <Stat label="Displacement" value={`${fmt(k.centroidAlpha, 3)} M`} cls={spin > 0.05 ? 'good' : ''} />
        <Stat label="Width × Height" value={`${fmt(k.widthAlpha, 2)} × ${fmt(k.heightBeta, 2)}`} />
        <Stat label="Photon orbit (pro)" value={`${fmt(rPro, 3)} M`} />
        <Stat label="Photon orbit (retro)" value={`${fmt(rRetro, 3)} M`} />
      </div>
    </div>
  )
}
