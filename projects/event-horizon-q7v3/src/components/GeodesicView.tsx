import { useEffect, useRef, useState } from 'react'
import { traceFanKerr } from '../geodesics'
import { B_CRIT, M, PHOTON_SPHERE, kerrHorizon } from '../state'

const VIEW_X = 24 // half-width of the world window shown, in rs
const VIEW_Y = 15

export default function GeodesicView() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [rays, setRays] = useState(64)
  const [maxB, setMaxB] = useState(9)
  const [spin, setSpin] = useState(0.6)
  const [size, setSize] = useState({ w: 800, h: 500 })

  // Track the container size.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, size.w)
    const h = Math.max(1, size.h)
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const scale = Math.min(w / (2 * VIEW_X), h / (2 * VIEW_Y))
    const cx = w / 2
    const cy = h / 2
    const sx = (x: number) => cx + x * scale
    const sy = (y: number) => cy - y * scale

    // Kerr geometry, expressed in equatorial world radius ρ = √(r²+a²).
    const a = spin * M
    const rplus = kerrHorizon(spin)
    const rhoH = Math.sqrt(rplus * rplus + a * a) // horizon in world radius
    const rhoErgo = Math.sqrt(1 + a * a) // ergosphere at the equator sits at BL r = 2M = 1 rs

    // Background.
    ctx.fillStyle = '#05060b'
    ctx.fillRect(0, 0, w, h)

    // Faint grid every 5 rs.
    ctx.strokeStyle = 'rgba(120,140,200,0.08)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let gx = -VIEW_X; gx <= VIEW_X; gx += 5) {
      ctx.moveTo(sx(gx), 0)
      ctx.lineTo(sx(gx), h)
    }
    for (let gy = -VIEW_Y; gy <= VIEW_Y; gy += 5) {
      ctx.moveTo(0, sy(gy))
      ctx.lineTo(w, sy(gy))
    }
    ctx.stroke()

    // Spin sense arrow (the hole rotates counter-clockwise = prograde is +φ).
    if (spin > 0.02) {
      ctx.strokeStyle = 'rgba(150,190,255,0.5)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(sx(0), sy(0), (rhoErgo + 1.1) * scale, -0.9, 0.9)
      ctx.stroke()
      const ax = sx(0) + Math.cos(0.9) * (rhoErgo + 1.1) * scale
      const ay = sy(0) - Math.sin(0.9) * (rhoErgo + 1.1) * scale
      ctx.fillStyle = 'rgba(150,190,255,0.7)'
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.lineTo(ax - 6, ay - 5)
      ctx.lineTo(ax + 1, ay - 9)
      ctx.closePath()
      ctx.fill()
    }

    // Critical impact-parameter guides (Schwarzschild reference; asymmetric once spinning).
    if (spin < 0.02) {
      ctx.strokeStyle = 'rgba(255,190,120,0.35)'
      ctx.setLineDash([5, 6])
      ctx.lineWidth = 1
      for (const yb of [B_CRIT, -B_CRIT]) {
        ctx.beginPath()
        ctx.moveTo(0, sy(yb))
        ctx.lineTo(w, sy(yb))
        ctx.stroke()
      }
      ctx.setLineDash([])
    }

    // Trace and draw photons.
    const fan = traceFanKerr(rays, maxB, spin)
    ctx.lineWidth = 1.1
    for (const g of fan) {
      const captured = g.fate === 'captured'
      ctx.strokeStyle = captured ? 'rgba(255,120,70,0.85)' : 'rgba(120,210,255,0.72)'
      ctx.shadowBlur = captured ? 6 : 4
      ctx.shadowColor = captured ? 'rgba(255,90,40,0.5)' : 'rgba(90,190,255,0.45)'
      ctx.beginPath()
      ctx.moveTo(sx(g.points[0]), sy(g.points[1]))
      for (let i = 1; i < g.count; i++) {
        ctx.lineTo(sx(g.points[i * 2]), sy(g.points[i * 2 + 1]))
      }
      ctx.stroke()
    }
    ctx.shadowBlur = 0

    // Ergosphere (static limit) — inside it, frame dragging forces everything to co-rotate.
    ctx.strokeStyle = 'rgba(150,120,255,0.75)'
    ctx.setLineDash([4, 5])
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.arc(sx(0), sy(0), rhoErgo * scale, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])

    // Schwarzschild photon sphere reference (only meaningful when not spinning).
    if (spin < 0.02) {
      ctx.strokeStyle = 'rgba(255,230,150,0.7)'
      ctx.setLineDash([4, 5])
      ctx.beginPath()
      ctx.arc(sx(0), sy(0), PHOTON_SPHERE * scale, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Event horizon (filled shadow with a glowing rim).
    const grad = ctx.createRadialGradient(sx(0), sy(0), 0, sx(0), sy(0), rhoH * scale)
    grad.addColorStop(0, '#000000')
    grad.addColorStop(0.82, '#000000')
    grad.addColorStop(1, 'rgba(90,130,255,0.55)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(sx(0), sy(0), rhoH * scale, 0, Math.PI * 2)
    ctx.fill()
  }, [rays, maxB, spin, size])

  return (
    <div className="geo">
      <div className="geo__stage" ref={wrapRef}>
        <canvas ref={canvasRef} />
      </div>
      <div className="geo__side">
        <h2>Geodesic Explorer</h2>
        <p className="muted">
          Parallel photons fly in from the left with impact parameter <em>b</em> (their vertical
          offset). Each path is the same null geodesic the 3D renderer integrates — here, in the
          equatorial plane, you can watch spacetime bend them.
        </p>
        <label className="row" title="How many photons to trace">
          <span className="row__label">Rays</span>
          <input type="range" min={8} max={160} step={2} value={rays} onChange={(e) => setRays(Number(e.target.value))} />
          <span className="row__value">{rays}</span>
        </label>
        <label className="row" title="Largest impact parameter in the fan">
          <span className="row__label">Max b</span>
          <input type="range" min={1.5} max={12} step={0.1} value={maxB} onChange={(e) => setMaxB(Number(e.target.value))} />
          <span className="row__value">{maxB.toFixed(1)} rs</span>
        </label>
        <label className="row" title="Black-hole spin a/M — the hole rotates counter-clockwise">
          <span className="row__label">Spin a/M</span>
          <input type="range" min={0} max={0.998} step={0.002} value={spin} onChange={(e) => setSpin(Number(e.target.value))} />
          <span className="row__value">{spin.toFixed(2)}</span>
        </label>

        <ul className="legend">
          <li>
            <span className="swatch swatch--escape" /> escapes to infinity
          </li>
          <li>
            <span className="swatch swatch--capture" /> falls past the horizon
          </li>
          <li>
            <span className="swatch swatch--ergo" /> ergosphere (static limit)
          </li>
        </ul>
        <p className="muted small">
          Turn up the spin and watch the fan go <strong>lopsided</strong>: photons swept along with
          the hole’s rotation (prograde) skim closer and whip around tighter, while retrograde rays
          on the other side are flung wide. That asymmetry is <strong>frame dragging</strong> — the
          hole drags spacetime itself around with it. Inside the purple <strong>ergosphere</strong>,
          the dragging is so strong that <em>nothing</em> can stay still, not even light.
        </p>
        <p className="muted small">
          At zero spin this reduces exactly to Schwarzschild: a symmetric fan, the photon sphere at{' '}
          {PHOTON_SPHERE.toFixed(1)} rs and the critical impact parameter b = 3√3·M ≈{' '}
          {B_CRIT.toFixed(2)} rs.
        </p>
      </div>
    </div>
  )
}
