import { useEffect, useRef, useState } from 'react'
import type { Params } from '../types'
import { BlackHoleRenderer, RendererError } from '../gl/renderer'
import { effectiveDiskInner, kerrISCO } from '../state'
import Spectrograph from './Spectrograph'

/** Target camera radius (rs) at the bottom of a plunge — just outside the photon sphere. */
const DIVE_R = 1.15

interface Props {
  params: Params
  /** Relative camera nudge from dragging (degrees) — parent clamps & stores. */
  onOrbit: (dAzimuth: number, dInclination: number) => void
  /** Multiplicative dolly from the wheel — parent clamps & stores. */
  onDolly: (factor: number) => void
}

export default function RenderView({ params, onOrbit, onDolly }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<BlackHoleRenderer | null>(null)
  const paramsRef = useRef(params)

  const [error, setError] = useState<string | null>(null)
  const [fps, setFps] = useState(0)
  const [effScale, setEffScale] = useState(1)
  const [showSpectro, setShowSpectro] = useState(true)
  const [diving, setDiving] = useState(false)
  const [obs, setObs] = useState<{ active: boolean; r: number; beta: number; gamma: number }>({
    active: false,
    r: 0,
    beta: 0,
    gamma: 1,
  })

  // Dive state read by the animation loop without re-subscribing it.
  const divingRef = useRef(false)
  const diveEaseRef = useRef(0) // 0 = orbiting, 1 = at the bottom of the plunge
  const obsFrameRef = useRef<{ ff: boolean; r: number }>({ ff: false, r: 0 })
  useEffect(() => {
    divingRef.current = diving
  }, [diving])

  // Drag state kept in refs so it never triggers React re-renders mid-gesture.
  const drag = useRef<{ active: boolean; x: number; y: number }>({ active: false, x: 0, y: 0 })
  const onOrbitRef = useRef(onOrbit)
  const onDollyRef = useRef(onDolly)

  // Keep the loop's view of props/params fresh without re-subscribing the animation frame.
  useEffect(() => {
    paramsRef.current = params
    onOrbitRef.current = onOrbit
    onDollyRef.current = onDolly
  })

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    try {
      rendererRef.current = new BlackHoleRenderer(canvas)
    } catch (e) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- surfacing a hard init failure
      setError(e instanceof RendererError ? e.message : 'Failed to start WebGL renderer.')
      return
    }

    let raf = 0
    let autoPhase = 0
    let last = performance.now()
    const start = last
    let frames = 0
    let acc = 0
    let autoScale = paramsRef.current.renderScale // adaptive-quality working scale

    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      const p = paramsRef.current
      if (p.autoRotate) autoPhase += dt * 6 // degrees per second

      // Plunge animation: ease the effective camera radius toward the horizon and back. The rain
      // frame is forced on while diving so the sky compresses; β follows the radius in the renderer.
      const diveTarget = divingRef.current ? 1 : 0
      diveEaseRef.current += (diveTarget - diveEaseRef.current) * Math.min(1, dt * 1.4)
      const e = diveEaseRef.current
      const eDist = e > 0.001 ? p.cameraDistance * (1 - e) + DIVE_R * e : p.cameraDistance
      const freeFall = p.freeFall || e > 0.002
      obsFrameRef.current = { ff: freeFall, r: eDist }

      // Effective internal scale: auto-tuned when adaptive quality is on, else the slider value.
      const scale = p.adaptiveQuality ? autoScale : p.renderScale
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.max(1, Math.round(container.clientWidth * dpr * scale))
      const h = Math.max(1, Math.round(container.clientHeight * dpr * scale))

      rendererRef.current?.render(
        { ...p, azimuth: p.azimuth + autoPhase, cameraDistance: eDist, freeFall },
        (now - start) / 1000,
        w,
        h,
      )

      frames += 1
      acc += dt
      if (acc >= 0.5) {
        const f = Math.round(frames / acc)
        setFps(f)
        // Adaptive quality: nudge the internal scale toward a comfortable framerate.
        if (p.adaptiveQuality) {
          if (f < 30 && autoScale > 0.4) autoScale = Math.max(0.4, autoScale * 0.85)
          else if (f > 52 && autoScale < 1) autoScale = Math.min(1, autoScale * 1.06)
          setEffScale(autoScale)
        } else {
          autoScale = p.renderScale
          setEffScale(p.renderScale)
        }
        // Observer HUD readout (rain frame): β = √(rs/r), γ = 1/√(1−β²).
        const { ff, r } = obsFrameRef.current
        if (ff) {
          const b = Math.min(Math.sqrt(1 / Math.max(r, 1.0001)), 0.9985)
          setObs({ active: true, r, beta: b, gamma: 1 / Math.sqrt(1 - b * b) })
        } else {
          setObs((o) => (o.active ? { ...o, active: false } : o))
        }
        frames = 0
        acc = 0
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      rendererRef.current?.dispose()
      rendererRef.current = null
    }
  }, [])

  // Pointer + wheel interaction.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const down = (e: PointerEvent) => {
      drag.current = { active: true, x: e.clientX, y: e.clientY }
      container.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      if (!drag.current.active) return
      const dx = e.clientX - drag.current.x
      const dy = e.clientY - drag.current.y
      drag.current.x = e.clientX
      drag.current.y = e.clientY
      onOrbitRef.current(dx * 0.35, dy * 0.35)
    }
    const up = (e: PointerEvent) => {
      drag.current.active = false
      try {
        container.releasePointerCapture(e.pointerId)
      } catch {
        /* pointer already released */
      }
    }
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      onDollyRef.current(Math.exp(e.deltaY * 0.001))
    }

    container.addEventListener('pointerdown', down)
    container.addEventListener('pointermove', move)
    container.addEventListener('pointerup', up)
    container.addEventListener('pointercancel', up)
    container.addEventListener('wheel', wheel, { passive: false })
    return () => {
      container.removeEventListener('pointerdown', down)
      container.removeEventListener('pointermove', move)
      container.removeEventListener('pointerup', up)
      container.removeEventListener('pointercancel', up)
      container.removeEventListener('wheel', wheel)
    }
  }, [])

  const savePng = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    try {
      const url = canvas.toDataURL('image/png')
      const a = document.createElement('a')
      a.href = url
      a.download = 'event-horizon.png'
      a.click()
    } catch {
      /* toDataURL can throw in sandboxed frames — ignore, the live app is unaffected */
    }
  }

  // 'S' saves a PNG, 'F' toggles the plunge (both kept here — they own the canvas / dive state).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 's') savePng()
      else if (k === 'f') setDiving((d) => !d)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (error) {
    return (
      <div className="stage stage--error" ref={containerRef}>
        <div className="fallback">
          <h2>WebGL2 unavailable</h2>
          <p>{error}</p>
          <p className="muted">
            The renderer needs a WebGL2 context. Try a hardware-accelerated browser, or open the
            <strong> Geodesics</strong> and <strong>Physics</strong> tabs — those work anywhere.
          </p>
        </div>
      </div>
    )
  }

  const spinning = params.spin >= 0.0015
  const inner = effectiveDiskInner(params)

  return (
    <div className="stage" ref={containerRef}>
      <canvas ref={canvasRef} className="stage__canvas" />
      <div className="hud" aria-hidden="true">
        <span className="hud__fps">{fps} fps</span>
        <span className="hud__fps">{Math.round(effScale * 100)}%</span>
        {spinning && (
          <span className="hud__fps hud__kerr">
            Kerr a/M {params.spin.toFixed(2)} · ISCO {kerrISCO(params.spin).toFixed(2)} rs
          </span>
        )}
        {obs.active && (
          <span className="hud__fps hud__rain">
            Rain frame · r {obs.r.toFixed(2)} rs · β {obs.beta.toFixed(3)} · γ {obs.gamma.toFixed(2)}
          </span>
        )}
        <button
          className={diving ? 'hud__btn hud__btn--active' : 'hud__btn'}
          onClick={() => setDiving((d) => !d)}
          title="Plunge toward the horizon on an infalling geodesic (F)"
        >
          {diving ? 'Ascend' : 'Plunge'}
        </button>
        <button className="hud__btn" onClick={() => setShowSpectro((s) => !s)} title="Toggle the relativistic line-profile overlay">
          {showSpectro ? 'Hide spectrum' : 'Spectrum'}
        </button>
        <button className="hud__btn" onClick={savePng} title="Download the current frame as a PNG (S)">
          Save PNG
        </button>
      </div>
      {showSpectro && <Spectrograph params={{ ...params, diskInner: inner }} />}
      <div className="hud hud--hint" aria-hidden="true">
        drag orbit · scroll zoom · V volume · F plunge · space auto-orbit · B bloom
      </div>
    </div>
  )
}
