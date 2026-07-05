import { useEffect, useRef, useState } from 'react'
import type { Params } from '../types'
import { BlackHoleRenderer, RendererError } from '../gl/renderer'

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

    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      const p = paramsRef.current
      if (p.autoRotate) autoPhase += dt * 6 // degrees per second

      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.max(1, Math.round(container.clientWidth * dpr * p.renderScale))
      const h = Math.max(1, Math.round(container.clientHeight * dpr * p.renderScale))

      rendererRef.current?.render({ ...p, azimuth: p.azimuth + autoPhase }, (now - start) / 1000, w, h)

      frames += 1
      acc += dt
      if (acc >= 0.5) {
        setFps(Math.round(frames / acc))
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

  return (
    <div className="stage" ref={containerRef}>
      <canvas ref={canvasRef} className="stage__canvas" />
      <div className="hud" aria-hidden="true">
        <span className="hud__fps">{fps} fps</span>
        <button className="hud__btn" onClick={savePng} title="Download the current frame as a PNG">
          Save PNG
        </button>
      </div>
      <div className="hud hud--hint" aria-hidden="true">
        drag to orbit · scroll to zoom
      </div>
    </div>
  )
}
