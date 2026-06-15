import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { Simulation } from './sim/Simulation'
import { Camera } from './render/Camera'
import { Renderer } from './render/Renderer'
import type { LagrangeOverlay, OrbitOverlay, RenderOptions, RenderOverlay } from './render/Renderer'
import type { Diagnostics, SimParams } from './sim/types'
import { presetById } from './sim/presets'
import { apoapsisPoint, orbitElements, periapsisPoint, sampleOrbitPath } from './sim/orbit'
import type { OrbitElements } from './sim/orbit'
import { restrictedThreeBody } from './sim/restricted3body'
import { Ring } from './util/ring'
import { Sidebar } from './components/Sidebar'
import type { Series } from './components/Plot'
import { DiagnosticsDock } from './components/Diagnostics'
import { Inspector } from './components/Inspector'
import type { InspectInfo } from './components/Inspector'
import { About } from './components/About'
import {
  DEFAULT_PARAMS,
  DEFAULT_RENDER,
  EXACT_ENERGY_MAX,
  decodeScenario,
  encodeScenario,
  loadSettings,
  saveSettings,
} from './state'
import type { ScenarioConfig } from './state'

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
// A scenario can be supplied via the URL hash (a shared permalink). Parse once.
const shared = (() => {
  try {
    return decodeScenario(window.location.hash)
  } catch {
    return null
  }
})()
const sharedPreset = shared?.preset && presetById(shared.preset).id === shared.preset ? shared.preset : null
const EMPTY_SERIES: Series = { color: '#888', data: new Float64Array(0), length: 0, start: 0 }

// Trajectory forecasting: how many frames between shadow re-runs, and a budget on
// total (steps × bodies) so a forecast never blows the frame on a huge system.
const PREDICT_EVERY = 6
const PREDICT_BUDGET = 400_000

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
  // Latest forecast paths, recomputed periodically and drawn every frame.
  const trajRef = useRef<{ paths: Float64Array[]; colors: string[] } | null>(null)
  // Latest restricted-3-body overlay, recomputed periodically (primaries move).
  const lagRef = useRef<LagrangeOverlay | null>(null)
  const lastMergeRef = useRef(0)

  // Misc refs that must stay current inside the rAF loop / event handlers.
  const dprRef = useRef(1)
  const firstSizedRef = useRef(false)
  const fitExtentRef = useRef(450)
  const dragRef = useRef<{
    active: boolean
    mode: 'pan' | 'slingshot'
    lastX: number
    lastY: number
    downX: number
    downY: number
    moved: boolean
    startWX: number
    startWY: number
  } | null>(null)

  // ----- React state (UI) -----
  const [presetId, setPresetId] = useState(sharedPreset ?? 'spiral-galaxy')
  const [count, setCount] = useState(() => shared?.count ?? presetById(sharedPreset ?? 'spiral-galaxy').defaultCount)
  const [seed, setSeed] = useState(shared?.seed ?? 1)
  const [params, setParams] = useState<SimParams>({ ...DEFAULT_PARAMS, ...(shared?.params ?? {}) })
  const [subSteps, setSubSteps] = useState<number>(shared?.subSteps ?? persisted?.subSteps ?? 1)
  const [renderOpts, setRenderOpts] = useState<RenderOptions>({
    ...DEFAULT_RENDER,
    ...(persisted?.render ?? {}),
    ...(shared?.render ?? {}),
  })
  const [running, setRunning] = useState(true)
  const [mode, setMode] = useState<'pan' | 'slingshot'>('pan')
  const [slingMass, setSlingMass] = useState(800)
  const [followCom, setFollowCom] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [diagCollapsed, setDiagCollapsed] = useState(false)
  const [sling, setSling] = useState<Sling | null>(null)
  const [predict, setPredict] = useState(false)
  const [predictHorizon, setPredictHorizon] = useState(600)
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [inspect, setInspect] = useState<InspectInfo | null>(null)
  const [copied, setCopied] = useState(false)

  const [diag, setDiag] = useState<Diagnostics | null>(null)
  const [series, setSeries] = useState<{ energy: Series; momentum: Series } | null>(null)
  const [hud, setHud] = useState<Hud>({ fps: 0, n: 0, time: 0, steps: 0, exact: true })
  const [mergeCount, setMergeCount] = useState(0)

  // Live-control mirror read by the animation loop and pointer handlers. Synced
  // from React state inside an effect (never written during render).
  const liveRef = useRef({ running, subSteps, renderOpts, followCom, mode, slingMass, predict, predictHorizon, selectedIndex })
  useEffect(() => {
    liveRef.current = { running, subSteps, renderOpts, followCom, mode, slingMass, predict, predictHorizon, selectedIndex }
  }, [running, subSteps, renderOpts, followCom, mode, slingMass, predict, predictHorizon, selectedIndex])

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
    trajRef.current = null
    lastMergeRef.current = 0
    return res.params
  }, [])

  // Initial build (once). A shared permalink keeps its own params; otherwise the
  // default scenario's recommended params already match DEFAULT_PARAMS.
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

      // Recompute the orbit forecast periodically (cost-capped for large N).
      if (ctrl.predict && sim.count > 0) {
        if (frame % PREDICT_EVERY === 0) {
          const steps = Math.max(20, Math.min(ctrl.predictHorizon, Math.floor(PREDICT_BUDGET / sim.count)))
          const stride = Math.max(1, Math.floor(steps / 100))
          const heavy = sim.heaviestIndices(8)
          const sel = ctrl.selectedIndex
          const indices = sel >= 0 && sel < sim.count && !heavy.includes(sel) ? [...heavy, sel] : heavy
          const paths = sim.predict(indices, steps, stride)
          const colors = indices.map((idx) =>
            idx === sel ? 'rgba(255,212,121,0.95)' : 'rgba(120,180,255,0.6)',
          )
          trajRef.current = { paths, colors }
        }
      } else if (trajRef.current) {
        trajRef.current = null
      }

      // Restricted-3-body overlay: recompute periodically since the primaries
      // (the two heaviest bodies) move as the binary rotates.
      if (ctrl.renderOpts.showLagrange && sim.count >= 2) {
        if (frame % 3 === 0) lagRef.current = computeLagrange(sim)
      } else if (lagRef.current) {
        lagRef.current = null
      }

      // Osculating orbit of the selected body, recomputed every frame (cheap).
      let orbitOverlay: OrbitOverlay | undefined
      const selIdx = ctrl.selectedIndex
      if (ctrl.renderOpts.showOrbit && selIdx >= 0 && selIdx < sim.count) {
        orbitOverlay = computeOrbitOverlay(sim, selIdx, ctrl.renderOpts.primary) ?? undefined
      }

      const overlay: RenderOverlay = {
        trajectories: trajRef.current ?? undefined,
        selected: ctrl.selectedIndex,
        orbit: orbitOverlay,
        lagrange: lagRef.current ?? undefined,
      }
      rendererRef.current!.render(sim, cam, ctrl.renderOpts, overlay)

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
        if (sim.mergeCount !== lastMergeRef.current) {
          // Merges shuffle body indices — a stale selection would point elsewhere.
          if (ctrl.selectedIndex >= 0) setSelectedIndex(-1)
          lastMergeRef.current = sim.mergeCount
          setMergeCount(sim.mergeCount)
        }
        const sel = ctrl.selectedIndex
        if (sel >= 0 && sel < sim.count) setInspect(computeInspect(sim, sel, ctrl.renderOpts.primary))
        else if (sel < 0) setInspect(null)
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

  const stepOnce = useCallback(() => {
    simRef.current?.step()
  }, [])

  // ----- share / export (kept current via a ref for the keyboard handler) -----
  const doShare = useCallback(() => {
    const cfg: ScenarioConfig = { preset: presetId, count, seed, params, render: renderOpts, subSteps }
    const frag = encodeScenario(cfg)
    try {
      window.history.replaceState(null, '', '#' + frag)
    } catch {
      /* ignore */
    }
    try {
      const url = `${window.location.origin}${window.location.pathname}#${frag}`
      navigator.clipboard?.writeText(url)
    } catch {
      /* clipboard unavailable */
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }, [presetId, count, seed, params, renderOpts, subSteps])

  const doExport = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    try {
      const url = canvas.toDataURL('image/png')
      const a = document.createElement('a')
      a.href = url
      a.download = `helios-${presetId}-${Date.now()}.png`
      a.click()
    } catch {
      /* tainted/sandboxed canvas — ignore */
    }
  }, [presetId])

  const handleReseed = useCallback(() => {
    const sd = (Math.random() * 2 ** 31) | 0
    setSeed(sd)
    setSelectedIndex(-1)
    const p = loadScenario(presetId, count, sd)
    if (p) setParams((prev) => ({ ...prev, ...p }))
  }, [presetId, count, loadScenario])

  // Keep the latest action closures reachable from the (deps-free) key handler.
  const actionsRef = useRef({ doShare, doExport, fitView, stepOnce, reseed: handleReseed })
  useEffect(() => {
    actionsRef.current = { doShare, doExport, fitView, stepOnce, reseed: handleReseed }
  }, [doShare, doExport, fitView, stepOnce, handleReseed])

  // ----- keyboard shortcuts -----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      const a = actionsRef.current
      if (e.code === 'Space') {
        e.preventDefault()
        setRunning((r) => !r)
      } else if (e.key === '.') {
        a.stepOnce()
      } else if (e.key === 'f') {
        a.fitView()
      } else if (e.key === 't') {
        setRenderOpts((r) => ({ ...r, trails: !r.trails }))
      } else if (e.key === 'c') {
        setParams((p) => ({ ...p, collide: !p.collide }))
      } else if (e.key === 'p') {
        setPredict((v) => !v)
      } else if (e.key === 'r') {
        a.reseed()
      } else if (e.key === 's') {
        a.doShare()
      } else if (e.key === 'e') {
        a.doExport()
      } else if (e.key === 'o') {
        setRenderOpts((r) => ({ ...r, showOrbit: !r.showOrbit }))
      } else if (e.key === 'l') {
        setRenderOpts((r) => ({ ...r, showLagrange: !r.showLagrange }))
      } else if (e.key === 'Escape') {
        setSelectedIndex(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ----- pointer interaction (pan / pick / slingshot) -----
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

  const pickBody = (sx: number, sy: number) => {
    const sim = simRef.current!
    const cam = cameraRef.current
    const thresh = 18 * dprRef.current
    const thresh2 = thresh * thresh
    let best = -1
    let bestD2 = Infinity
    for (let i = 0; i < sim.count; i++) {
      const dx = cam.worldToScreenX(sim.posX[i]) - sx
      const dy = cam.worldToScreenY(sim.posY[i]) - sy
      const d2 = dx * dx + dy * dy
      if (d2 < bestD2) {
        bestD2 = d2
        best = i
      }
    }
    setSelectedIndex(best >= 0 && bestD2 <= thresh2 ? best : -1)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    ;(e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId)
    const { sx, sy, cssX, cssY } = deviceCoords(e)
    const cam = cameraRef.current
    if (liveRef.current.mode === 'pan') {
      dragRef.current = {
        active: true,
        mode: 'pan',
        lastX: sx,
        lastY: sy,
        downX: sx,
        downY: sy,
        moved: false,
        startWX: 0,
        startWY: 0,
      }
      if (followCom) setFollowCom(false)
    } else {
      dragRef.current = {
        active: true,
        mode: 'slingshot',
        lastX: sx,
        lastY: sy,
        downX: sx,
        downY: sy,
        moved: false,
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
      if (Math.hypot(sx - drag.downX, sy - drag.downY) > 4 * dprRef.current) drag.moved = true
    } else {
      setSling((s) => (s ? { ...s, x1: cssX, y1: cssY } : s))
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag?.active) return
    const { sx, sy } = deviceCoords(e)
    if (drag.mode === 'slingshot') {
      const cam = cameraRef.current
      const endWX = cam.screenToWorldX(sx)
      const endWY = cam.screenToWorldY(sy)
      const vx = (endWX - drag.startWX) * 0.5
      const vy = (endWY - drag.startWY) * 0.5
      simRef.current!.addBody(drag.startWX, drag.startWY, vx, vy, liveRef.current.slingMass)
      setSling(null)
    } else if (!drag.moved) {
      // A click without a drag selects (or deselects) the nearest body.
      pickBody(sx, sy)
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
    setSelectedIndex(-1)
    firstSizedRef.current = true // keep current viewport; just refit
    applyParams(loadScenario(id, n, seed))
  }
  const handleCount = (n: number) => {
    setCount(n)
    setSelectedIndex(-1)
    applyParams(loadScenario(presetId, n, seed))
  }
  const handleReset = () => {
    setSelectedIndex(-1)
    applyParams(loadScenario(presetId, count, seed))
  }

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
          <button type="button" className="btn" onClick={doShare} title="Copy a permalink to this scenario (s)">
            🔗 Share
          </button>
          <button type="button" className="btn" onClick={doExport} title="Download the current frame as a PNG (e)">
            ⤓ PNG
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
          predict={predict}
          onPredict={setPredict}
          predictHorizon={predictHorizon}
          onPredictHorizon={setPredictHorizon}
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
          {inspect && <Inspector info={inspect} onClose={() => setSelectedIndex(-1)} />}
          {copied && <div className="toast">Permalink copied to clipboard</div>}
          <DiagnosticsDock
            diag={diag}
            energySeries={series?.energy ?? EMPTY_SERIES}
            momentumSeries={series?.momentum ?? EMPTY_SERIES}
            exactEnergy={hud.exact}
            collapsed={diagCollapsed}
            onToggle={() => setDiagCollapsed((c) => !c)}
            mergeCount={mergeCount}
            collideOn={params.collide}
          />
        </main>
      </div>

      {showAbout && <About onClose={() => setShowAbout(false)} />}
    </div>
  )
}

type PrimaryMode = RenderOptions['primary']

interface PrimaryRef {
  px: number
  py: number
  pvx: number
  pvy: number
  mu: number
  label: string
  isSelf: boolean
}

/**
 * Resolve the reference body for orbital elements. In "heaviest" mode the orbit
 * is taken about the most massive body (μ = G(M+m), the exact two-body value);
 * in "barycenter" mode it is taken about the system centre of mass moving with
 * the COM velocity, with μ = G·M_total — the orbit in the mean monopole field.
 */
function resolvePrimary(sim: Simulation, sel: number, mode: PrimaryMode): PrimaryRef {
  const g = sim.params.g
  const m = sim.mass[sel]
  if (mode === 'barycenter') {
    let comX = 0
    let comY = 0
    let comVx = 0
    let comVy = 0
    let tm = 0
    for (let i = 0; i < sim.count; i++) {
      const mi = sim.mass[i]
      comX += mi * sim.posX[i]
      comY += mi * sim.posY[i]
      comVx += mi * sim.velX[i]
      comVy += mi * sim.velY[i]
      tm += mi
    }
    if (tm > 0) {
      comX /= tm
      comY /= tm
      comVx /= tm
      comVy /= tm
    }
    return { px: comX, py: comY, pvx: comVx, pvy: comVy, mu: g * tm, label: 'barycentre', isSelf: false }
  }
  let hi = 0
  let mm = -Infinity
  for (let i = 0; i < sim.count; i++) {
    if (sim.mass[i] > mm) {
      mm = sim.mass[i]
      hi = i
    }
  }
  return {
    px: sim.posX[hi],
    py: sim.posY[hi],
    pvx: sim.velX[hi],
    pvy: sim.velY[hi],
    mu: g * (mm + m),
    label: `#${hi} (heaviest)`,
    isSelf: hi === sel,
  }
}

/** The osculating orbital elements of the selected body about its primary. */
function selectedOrbit(
  sim: Simulation,
  sel: number,
  mode: PrimaryMode,
): { el: OrbitElements; ref: PrimaryRef } | null {
  const ref = resolvePrimary(sim, sel, mode)
  if (ref.isSelf) return null
  const rx = sim.posX[sel] - ref.px
  const ry = sim.posY[sel] - ref.py
  const dvx = sim.velX[sel] - ref.pvx
  const dvy = sim.velY[sel] - ref.pvy
  return { el: orbitElements(rx, ry, dvx, dvy, ref.mu), ref }
}

/** Live orbital readout for the selected body. */
function computeInspect(sim: Simulation, sel: number, mode: PrimaryMode): InspectInfo {
  const m = sim.mass[sel]
  const speed = Math.hypot(sim.velX[sel], sim.velY[sel])
  const [comX, comY] = sim.centerOfMass()
  const distCom = Math.hypot(sim.posX[sel] - comX, sim.posY[sel] - comY)
  const ref = resolvePrimary(sim, sel, mode)
  const orbit = ref.isSelf
    ? null
    : orbitElements(
        sim.posX[sel] - ref.px,
        sim.posY[sel] - ref.py,
        sim.velX[sel] - ref.pvx,
        sim.velY[sel] - ref.pvy,
        ref.mu,
      )
  return { index: sel, mass: m, speed, distCom, primaryLabel: ref.label, orbit }
}

/** Build the on-canvas osculating-orbit overlay for the selected body. */
function computeOrbitOverlay(sim: Simulation, sel: number, mode: PrimaryMode): OrbitOverlay | null {
  const res = selectedOrbit(sim, sel, mode)
  if (!res) return null
  const { el, ref } = res
  // Skip degenerate near-radial orbits where the conic is meaningless.
  if (!Number.isFinite(el.semiLatus) || el.semiLatus < 1e-9) return null
  return {
    path: sampleOrbitPath(el, ref.px, ref.py, 256),
    primary: [ref.px, ref.py],
    periapsis: periapsisPoint(el, ref.px, ref.py),
    apoapsis: apoapsisPoint(el, ref.px, ref.py),
  }
}

/** Build the restricted-3-body overlay from the two heaviest bodies. */
function computeLagrange(sim: Simulation): LagrangeOverlay | null {
  const heavy = sim.heaviestIndices(2)
  if (heavy.length < 2) return null
  const [a, b] = heavy
  const lag = restrictedThreeBody(
    sim.mass[a],
    sim.posX[a],
    sim.posY[a],
    sim.mass[b],
    sim.posX[b],
    sim.posY[b],
  )
  if (!lag.valid) return null
  return {
    points: lag.points,
    contours: lag.contours,
    primary1: lag.primary1,
    primary2: lag.primary2,
  }
}

function HudStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="hud-stat">
      <span className="hud-label">{label}</span>
      <span className="hud-value">{value}</span>
    </div>
  )
}
