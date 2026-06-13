import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { Simulation } from './sim/Simulation'
import { Camera } from './render/Camera'
import { Renderer } from './render/Renderer'
import type { RenderOptions } from './render/Renderer'
import type { Diagnostics, SimParams } from './sim/types'
import { presetById } from './sim/presets'
import { Ring } from './util/ring'
import { Sidebar } from './components/Sidebar'
import type { Series } from './components/Plot'
import { DiagnosticsDock } from './components/Diagnostics'
import { About } from './components/About'
import {
  DEFAULT_PARAMS,
  DEFAULT_RENDER,
  EXACT_ENERGY_MAX,
  loadSettings,
  saveSettings,
} from './state'

interface Hud {
  fps: number
  n: number
  time: number
  steps: number
  exact: boolean
}

interface Sling {
  x0: number
  y0: number
  x1: number
  y1: number
}

const persisted = loadSettings()
const EMPTY_SERIES: Series = { color: '#888', data: new Float64Array(0), length: 0, start: 0 }

export default function App() {
  // ----- imperative engine singletons (live in refs, never re-created) -----
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const simRef = useRef<Simulation | null>(null)
  if (simRef.current === null) simRef.current = new Simulation(30000)
  const cameraRef = useRef<Camera>(new Camera())
  const rendererRef = useRef<Renderer | null>(null)

  const energyRing = useRef(new Ring(240))
  const momentumRing = useRef(new Ring(240))

  // Misc refs that must stay current inside the rAF loop / event handlers.
  const dprRef = useRef(1)
  const firstSizedRef = useRef(false)
  const fitExtentRef = useRef(450)
  const dragRef = useRef<{
    active: boolean
    mode: 'pan' | 'slingshot'
    lastX: number
    lastY: number
    startWX: number
    startWY: number
  } | null>(null)

  // ----- React state (UI) -----
  const [presetId, setPresetId] = useState('spiral-galaxy')
  const [count, setCount] = useState(() => presetById('spiral-galaxy').defaultCount)
  const [seed, setSeed] = useState(1)
  const [params, setParams] = useState<SimParams>({ ...DEFAULT_PARAMS })
  const [subSteps, setSubSteps] = useState<number>(persisted?.subSteps ?? 1)
  const [renderOpts, setRenderOpts] = useState<RenderOptions>({
    ...DEFAULT_RENDER,
    ...(persisted?.render ?? {}),
  })
  const [running, setRunning] = useState(true)
  const [mode, setMode] = useState<'pan' | 'slingshot'>('pan')
  const [slingMass, setSlingMass] = useState(800)
  const [followCom, setFollowCom] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [diagCollapsed, setDiagCollapsed] = useState(false)
  const [sling, setSling] = useState<Sling | null>(null)

  const [diag, setDiag] = useState<Diagnostics | null>(null)
  const [series, setSeries] = useState<{ energy: Series; momentum: Series } | null>(null)
  const [hud, setHud] = useState<Hud>({ fps: 0, n: 0, time: 0, steps: 0, exact: true })

  // Live-control mirror read by the animation loop and pointer handlers. Synced
  // from React state inside an effect (never written during render).
  const liveRef = useRef({ running, subSteps, renderOpts, followCom, mode, slingMass })
  useEffect(() => {
    liveRef.current = { running, subSteps, renderOpts, followCom, mode, slingMass }
  }, [running, subSteps, renderOpts, followCom, mode, slingMass])

  const preset = presetById(presetId)

  // ----- build / rebuild a scenario into the simulation (imperative only) -----
  // Returns the preset's recommended params so callers (event handlers) can sync
  // them into React state; this function itself never calls setState.
  const loadScenario = useCallback((id: string, n: number, sd: number) => {
    const sim = simRef.current!
    const def = presetById(id)
    const clamped = Math.max(def.minCount, Math.min(def.maxCount, n))
    const res = def.build(clamped, sd)
    sim.setBodies(res.n, res.posX, res.posY, res.velX, res.velY, res.mass)
    fitExtentRef.current = res.viewExtent
    cameraRef.current.centerX = 0
    cameraRef.current.centerY = 0
    cameraRef.current.fitExtent(res.viewExtent)
    energyRing.current.clear()
    momentumRing.current.clear()
    return res.params
  }, [])

  // Initial build (once). The default scenario's recommended params already match
  // DEFAULT_PARAMS, so no state update is needed here.
  useEffect(() => {
    loadScenario(presetId, count, seed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ----- push UI params into the engine -----
  useEffect(() => {
    const sim = simRef.current!
    const prev = sim.params
    const energyChanged = prev.g !== params.g || prev.softening !== params.softening
    sim.params = { ...params }
    sim.invalidateAccel()
    if (energyChanged) {
      sim.resetEnergyBaseline()
      energyRing.current.clear()
    }
  }, [params])

  // ----- the render / step loop -----
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    rendererRef.current = new Renderer(canvas)

    let raf = 0
    let lastT = performance.now()
    let frame = 0
    let fpsAccum = 0
    let fpsCount = 0

    const loop = (t: number) => {
      raf = requestAnimationFrame(loop)
      const sim = simRef.current!
      const cam = cameraRef.current
      const ctrl = liveRef.current

      const dtMs = t - lastT
      lastT = t
      if (dtMs > 0 && dtMs < 1000) {
        fpsAccum += dtMs
        fpsCount++
      }

      if (ctrl.running) {
        for (let s = 0; s < ctrl.subSteps; s++) sim.step()
      }
      if (ctrl.followCom) {
        const [cx, cy] = sim.centerOfMass()
        cam.centerX = cx
        cam.centerY = cy
      }
      rendererRef.current!.render(sim, cam, ctrl.renderOpts)

      frame++
      if (frame % 7 === 0) {
        const exact = sim.count <= EXACT_ENERGY_MAX
        const d = sim.diagnostics(exact)
        if (exact && Number.isFinite(d.energyDrift)) energyRing.current.push(d.energyDrift * 100)
        momentumRing.current.push(Math.hypot(d.momentumX, d.momentumY))
        const fps = fpsCount > 0 ? 1000 / (fpsAccum / fpsCount) : 0
        fpsAccum = 0
        fpsCount = 0
        setDiag(d)
        setSeries({
          energy: energyRing.current.series('#ff7847'),
          momentum: momentumRing.current.series('#5fd0ff'),
        })
        setHud({ fps, n: sim.count, time: sim.time, steps: sim.steps, exact })
      }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ----- resize handling -----
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      dprRef.current = dpr
      rendererRef.current?.resize(rect.width, rect.height, dpr)
      cameraRef.current.setViewport(Math.round(rect.width * dpr), Math.round(rect.height * dpr))
      if (!firstSizedRef.current) {
        firstSizedRef.current = true
        cameraRef.current.fitExtent(fitExtentRef.current)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ----- wheel zoom (native listener so we can preventDefault) -----
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const dpr = dprRef.current
      const sx = (e.clientX - rect.left) * dpr
      const sy = (e.clientY - rect.top) * dpr
      const factor = Math.exp(-e.deltaY * 0.0015)
      cameraRef.current.zoomAt(factor, sx, sy)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

  // ----- persist render settings -----
  useEffect(() => {
    const id = setTimeout(() => saveSettings({ render: renderOpts, subSteps }), 400)
    return () => clearTimeout(id)
  }, [renderOpts, subSteps])

  // ----- camera helpers -----
  const fitView = useCallback(() => {
    const sim = simRef.current!
    const cam = cameraRef.current
    const [cx, cy] = sim.centerOfMass()
    cam.centerX = cx
    cam.centerY = cy
    const ext = sim.quadtree.rootHalf || fitExtentRef.current
    cam.fitExtent(ext * 1.1)
  }, [])

  // ----- keyboard shortcuts -----
  const stepOnce = useCallback(() => {
    simRef.current?.step()
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (e.code === 'Space') {
        e.preventDefault()
        setRunning((r) => !r)
      } else if (e.key === '.') {
        stepOnce()
      } else if (e.key === 'f') {
        fitView()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stepOnce, fitView])

  // ----- pointer interaction (pan / slingshot) -----
  const deviceCoords = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect()
    const dpr = dprRef.current
    return {
      sx: (e.clientX - rect.left) * dpr,
      sy: (e.clientY - rect.top) * dpr,
      cssX: e.clientX - rect.left,
      cssY: e.clientY - rect.top,
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    ;(e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId)
    const { sx, sy, cssX, cssY } = deviceCoords(e)
    const cam = cameraRef.current
    if (liveRef.current.mode === 'pan') {
      dragRef.current = { active: true, mode: 'pan', lastX: sx, lastY: sy, startWX: 0, startWY: 0 }
      if (followCom) setFollowCom(false)
    } else {
      dragRef.current = {
        active: true,
        mode: 'slingshot',
        lastX: sx,
        lastY: sy,
        startWX: cam.screenToWorldX(sx),
        startWY: cam.screenToWorldY(sy),
      }
      setSling({ x0: cssX, y0: cssY, x1: cssX, y1: cssY })
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag?.active) return
    const { sx, sy, cssX, cssY } = deviceCoords(e)
    if (drag.mode === 'pan') {
      cameraRef.current.panByPixels(sx - drag.lastX, sy - drag.lastY)
      drag.lastX = sx
      drag.lastY = sy
    } else {
      setSling((s) => (s ? { ...s, x1: cssX, y1: cssY } : s))
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag?.active) return
    if (drag.mode === 'slingshot') {
      const { sx, sy } = deviceCoords(e)
      const cam = cameraRef.current
      const endWX = cam.screenToWorldX(sx)
      const endWY = cam.screenToWorldY(sy)
      const vx = (endWX - drag.startWX) * 0.5
      const vy = (endWY - drag.startWY) * 0.5
      simRef.current!.addBody(drag.startWX, drag.startWY, vx, vy, liveRef.current.slingMass)
      setSling(null)
    }
    dragRef.current = null
  }

  // ----- UI event handlers -----
  const applyParams = (patch: Partial<SimParams> | undefined) => {
    if (patch) setParams((prev) => ({ ...prev, ...patch }))
  }
  const handlePreset = (id: string) => {
    const def = presetById(id)
    const n = def.defaultCount
    setPresetId(id)
    setCount(n)
    firstSizedRef.current = true // keep current viewport; just refit
    applyParams(loadScenario(id, n, seed))
  }
  const handleCount = (n: number) => {
    setCount(n)
    applyParams(loadScenario(presetId, n, seed))
  }
  const handleReseed = () => {
    const sd = (Math.random() * 2 ** 31) | 0
    setSeed(sd)
    applyParams(loadScenario(presetId, count, sd))
  }
  const handleReset = () => applyParams(loadScenario(presetId, count, seed))

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">✷</span>
          <div>
            <h1>Helios</h1>
            <span className="brand-sub">Gravitational N-Body Studio</span>
          </div>
        </div>

        <div className="transport">
          <button
            type="button"
            className={`btn primary ${running ? '' : 'paused'}`}
            onClick={() => setRunning((r) => !r)}
            title="Play / Pause (Space)"
          >
            {running ? '❚❚ Pause' : '► Play'}
          </button>
          <button type="button" className="btn" onClick={stepOnce} title="Single step (.)">
            ⏭ Step
          </button>
          <button type="button" className="btn" onClick={fitView} title="Fit view (f)">
            ⊡ Fit
          </button>
        </div>

        <div className="hud">
          <HudStat label="FPS" value={hud.fps.toFixed(0)} />
          <HudStat label="Bodies" value={hud.n.toLocaleString()} />
          <HudStat label="Steps" value={hud.steps.toLocaleString()} />
          <HudStat label="Sim time" value={hud.time.toFixed(1)} />
          <button type="button" className="btn ghost" onClick={() => setShowAbout(true)} title="About">
            ?
          </button>
        </div>
      </header>

      <div className="body">
        <Sidebar
          presetId={presetId}
          presetDescription={preset.description}
          onPreset={handlePreset}
          count={count}
          countBounds={{ min: preset.minCount, max: preset.maxCount }}
          onCount={handleCount}
          onReseed={handleReseed}
          onReset={handleReset}
          params={params}
          onParams={(patch: Partial<SimParams>) => setParams((p) => ({ ...p, ...patch }))}
          subSteps={subSteps}
          onSubSteps={setSubSteps}
          render={renderOpts}
          onRender={(patch: Partial<RenderOptions>) => setRenderOpts((r) => ({ ...r, ...patch }))}
          mode={mode}
          onMode={setMode}
          slingMass={slingMass}
          onSlingMass={setSlingMass}
          followCom={followCom}
          onFollowCom={setFollowCom}
        />

        <main className="stage" ref={containerRef}>
          <canvas
            ref={canvasRef}
            className={`view ${mode === 'pan' ? 'grab' : 'cross'}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {sling && (
            <svg className="sling-overlay" aria-hidden>
              <defs>
                <marker id="arrow" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L7,3 L0,6 Z" fill="#ffd479" />
                </marker>
              </defs>
              <line
                x1={sling.x0}
                y1={sling.y0}
                x2={sling.x1}
                y2={sling.y1}
                stroke="#ffd479"
                strokeWidth={2}
                markerEnd="url(#arrow)"
              />
              <circle cx={sling.x0} cy={sling.y0} r={4} fill="#ffd479" />
            </svg>
          )}
          <DiagnosticsDock
            diag={diag}
            energySeries={series?.energy ?? EMPTY_SERIES}
            momentumSeries={series?.momentum ?? EMPTY_SERIES}
            exactEnergy={hud.exact}
            collapsed={diagCollapsed}
            onToggle={() => setDiagCollapsed((c) => !c)}
          />
        </main>
      </div>

      {showAbout && <About onClose={() => setShowAbout(false)} />}
    </div>
  )
}

function HudStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="hud-stat">
      <span className="hud-label">{label}</span>
      <span className="hud-value">{value}</span>
    </div>
  )
}
