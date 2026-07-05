import { useEffect, useRef, useState } from 'react'
import { traceFan } from '../geodesics'
import { B_CRIT, PHOTON_SPHERE } from '../state'

const VIEW_X = 24 // half-width of the world window shown, in rs
const VIEW_Y = 15

export default function GeodesicView() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [rays, setRays] = useState(64)
  const [maxB, setMaxB] = useState(9)
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

    // Critical impact-parameter guide lines.
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

    // Trace and draw photons.
    const fan = traceFan(rays, maxB)
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

    // Photon sphere (unstable circular orbit).
    ctx.strokeStyle = 'rgba(255,230,150,0.7)'
    ctx.setLineDash([4, 5])
    ctx.beginPath()
    ctx.arc(sx(0), sy(0), PHOTON_SPHERE * scale, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])

    // Event horizon (filled shadow with a glowing rim).
    const grad = ctx.createRadialGradient(sx(0), sy(0), 0, sx(0), sy(0), 1 * scale)
    grad.addColorStop(0, '#000000')
    grad.addColorStop(0.82, '#000000')
    grad.addColorStop(1, 'rgba(90,130,255,0.55)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(sx(0), sy(0), 1 * scale, 0, Math.PI * 2)
    ctx.fill()
  }, [rays, maxB, size])

  return (
    <div className="geo">
      <div className="geo__stage" ref={wrapRef}>
        <canvas ref={canvasRef} />
      </div>
      <div className="geo__side">
        <h2>Geodesic Explorer</h2>
        <p className="muted">
          Parallel photons fly in from the left with impact parameter <em>b</em> (their vertical
          offset). Each path is the same null geodesic the 3D renderer integrates — here you can
          watch spacetime bend them.
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

        <ul className="legend">
          <li>
            <span className="swatch swatch--escape" /> escapes to infinity
          </li>
          <li>
            <span className="swatch swatch--capture" /> falls past the horizon
          </li>
          <li>
            <span className="swatch swatch--photon" /> photon sphere · {PHOTON_SPHERE.toFixed(1)} rs
          </li>
          <li>
            <span className="swatch swatch--bcrit" /> critical b = 3√3·M ≈ {B_CRIT.toFixed(2)} rs
          </li>
        </ul>
        <p className="muted small">
          Any photon aimed with <em>|b|</em> below the critical value is swallowed; just above it,
          rays whip around the photon sphere many times before escaping — the source of the thin
          bright ring in the 3D view.
        </p>
      </div>
    </div>
  )
}
