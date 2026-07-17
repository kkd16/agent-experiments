import { useEffect, useRef, useState } from 'react'
import type { Params } from '../types'
import { BlackHoleRenderer, RendererError } from '../gl/renderer'
import { effectiveDiskInner, kerrISCO } from '../state'
import { lookBasis, orbitPosition } from '../math/vec'
import { cameraRay, tracePhoton, fateLabel, subCritical, observerVelocity } from '../physics/probe'
import type { ProbeResult } from '../physics/probe'
import { drawProbe } from '../ui/probe-overlay'
import type { ProbeCamera } from '../ui/probe-overlay'
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
  const probeCanvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<BlackHoleRenderer | null>(null)
  const paramsRef = useRef(params)

  // The *effective* params the render loop is actually drawing with (auto-orbit + dive folded in),
  // so a probe click reconstructs the exact camera on screen at that instant.
  const renderParamsRef = useRef<Params>(params)
  // The frozen world-space photon path, re-projected every frame; and its read-out for the panel.
  const probeRef = useRef<ProbeResult | null>(null)
  const [probeInfo, setProbeInfo] = useState<ProbeResult | null>(null)

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

      const eff: Params = { ...p, azimuth: p.azimuth + autoPhase, cameraDistance: eDist, freeFall }
      renderParamsRef.current = eff
      rendererRef.current?.render(eff, (now - start) / 1000, w, h)

      // Photon-probe overlay: re-project the frozen world-space path with the live camera so it
      // tracks the orbit. Drawn at display resolution (independent of the render scale).
      const pc = probeCanvasRef.current
      if (pc) {
        const cw = container.clientWidth
        const ch = container.clientHeight
        const ow = Math.max(1, Math.round(cw * dpr))
        const oh = Math.max(1, Math.round(ch * dpr))
        if (pc.width !== ow || pc.height !== oh) {
          pc.width = ow
          pc.height = oh
        }
        const ctx = pc.getContext('2d')
        if (ctx) {
          if (probeRef.current) {
            const eye = orbitPosition(eff.cameraDistance, eff.inclination, eff.azimuth)
            const { right, up, forward } = lookBasis(eye, [0, 0, 0])
            const cam: ProbeCamera = {
              eye,
              right,
              up,
              forward,
              tanHalf: Math.tan((eff.fov * Math.PI) / 180 / 2),
              aspect: cw / Math.max(ch, 1),
              w: ow,
              h: oh,
            }
            drawProbe(ctx, probeRef.current, cam, dpr)
          } else {
            ctx.clearRect(0, 0, pc.width, pc.height)
          }
        }
      }

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
          // True speed of the infalling frame, including the Kerr ZAMO azimuthal drift for a > 0.
          const vv = observerVelocity(renderParamsRef.current)
          const b = Math.min(Math.hypot(vv[0], vv[1], vv[2]), 0.9985)
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

    // Distinguish an orbit-drag from a click: a click (little movement) fires the photon probe.
    let downX = 0
    let downY = 0
    let moved = false

    const down = (e: PointerEvent) => {
      drag.current = { active: true, x: e.clientX, y: e.clientY }
      downX = e.clientX
      downY = e.clientY
      moved = false
      container.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      if (!drag.current.active) return
      const dx = e.clientX - drag.current.x
      const dy = e.clientY - drag.current.y
      drag.current.x = e.clientX
      drag.current.y = e.clientY
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) moved = true
      onOrbitRef.current(dx * 0.35, dy * 0.35)
    }
    const up = (e: PointerEvent) => {
      drag.current.active = false
      try {
        container.releasePointerCapture(e.pointerId)
      } catch {
        /* pointer already released */
      }
      if (!moved && Math.hypot(e.clientX - downX, e.clientY - downY) < 5) probeAt(e.clientX, e.clientY)
    }

    // Reconstruct the clicked pixel's ray with the exact on-screen camera and trace its geodesic.
    const probeAt = (clientX: number, clientY: number) => {
      const rp = renderParamsRef.current
      const rect = container.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      const fx = (clientX - rect.left) / rect.width
      const fy = (clientY - rect.top) / rect.height
      const aspect = rect.width / rect.height
      const ndcX = (fx * 2 - 1) * aspect
      const ndcY = 1 - fy * 2
      const { pos, dir } = cameraRay(rp, ndcX, ndcY)
      const res = tracePhoton(pos, dir, rp)
      probeRef.current = res
      setProbeInfo(res)
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

  const clearProbe = () => {
    probeRef.current = null
    setProbeInfo(null)
  }

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
      else if (e.key === 'Escape') clearProbe()
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
  const charged = params.charge >= 0.002
  const inner = effectiveDiskInner(params)
  // Name the member of the no-hair family currently on screen.
  const holeLabel = spinning
    ? charged
      ? `Kerr–Newman a/M ${params.spin.toFixed(2)} · Q/M ${params.charge.toFixed(2)}`
      : `Kerr a/M ${params.spin.toFixed(2)} · ISCO ${kerrISCO(params.spin).toFixed(2)} rs`
    : charged
      ? `Reissner–Nordström Q/M ${params.charge.toFixed(2)}`
      : ''

  return (
    <div className="stage" ref={containerRef}>
      <canvas ref={canvasRef} className="stage__canvas" />
      <canvas ref={probeCanvasRef} className="stage__probe" aria-hidden="true" />
      {probeInfo && <ProbePanel res={probeInfo} onClear={clearProbe} />}
      <div className="hud" aria-hidden="true">
        <span className="hud__fps">{fps} fps</span>
        <span className="hud__fps">{Math.round(effScale * 100)}%</span>
        {holeLabel && <span className="hud__fps hud__kerr">{holeLabel}</span>}
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
        click a photon · drag orbit · scroll zoom · V volume · F plunge · P light-echo · B bloom
      </div>
    </div>
  )
}

/** Name the black-hole model a probe result was traced in, from its spin and charge. */
function probeModel(res: ProbeResult): string {
  const spinning = res.spin >= 0.0015
  const charged = res.charge >= 0.002
  if (spinning && charged) return `Kerr–Newman a/M ${res.spin.toFixed(2)}, Q/M ${res.charge.toFixed(2)}`
  if (spinning) return `Kerr a/M ${res.spin.toFixed(2)}`
  if (charged) return `Reissner–Nordström Q/M ${res.charge.toFixed(2)}`
  return 'Schwarzschild'
}

/** Live read-out for a traced photon: its conserved quantities, geometry and fate. */
function ProbePanel({ res, onClear }: { res: ProbeResult; onClear: () => void }) {
  const sub = subCritical(res)
  const fateClass =
    res.fate === 'captured' ? 'probe__fate probe__fate--cap' : res.fate === 'disk' ? 'probe__fate probe__fate--disk' : 'probe__fate probe__fate--sky'
  return (
    <div className="probe">
      <div className="probe__head">
        <span className="probe__title">Photon probe</span>
        <button className="probe__close" onClick={onClear} title="Clear the traced photon (Esc)" aria-label="Clear probe">
          ✕
        </button>
      </div>
      <div className={fateClass}>{fateLabel(res)}</div>
      <dl className="probe__grid">
        <div>
          <dt>Impact b</dt>
          <dd>
            {res.b.toFixed(3)} rs <span className={sub ? 'probe__flag probe__flag--sub' : 'probe__flag'}>{sub ? '< b_crit' : '> b_crit'}</span>
          </dd>
        </div>
        <div>
          <dt>Energy E</dt>
          <dd>{res.E.toFixed(3)}</dd>
        </div>
        <div>
          <dt>Ang. mom. L</dt>
          <dd>{res.L.toFixed(3)}</dd>
        </div>
        <div>
          <dt>Carter Q</dt>
          <dd>{res.Q.toFixed(3)}</dd>
        </div>
        <div>
          <dt>Closest r</dt>
          <dd>{res.rMin.toFixed(3)} rs</dd>
        </div>
        <div>
          <dt>Image order</dt>
          <dd>{res.crossings}</dd>
        </div>
        <div>
          <dt>Deflection</dt>
          <dd>{((res.deflection * 180) / Math.PI).toFixed(1)}°</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{probeModel(res)}</dd>
        </div>
      </dl>
    </div>
  )
}
