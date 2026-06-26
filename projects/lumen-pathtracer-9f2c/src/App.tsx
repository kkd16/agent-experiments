// App.tsx — the Lumen path-tracer studio shell. It owns the control state, the
// orbit camera, and the Renderer lifecycle, and routes between the render
// viewport, the verification suite, and the about page.

import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { useHashRoute } from './ui/useHashRoute'
import { Controls } from './ui/components/Controls'
import { RES_PRESETS } from './ui/components/controlConfig'
import type { ControlState } from './ui/components/controlConfig'
import { Stats } from './ui/components/Stats'
import { SelfTests } from './ui/components/SelfTests'
import { About } from './ui/components/About'
import { Renderer } from './render/renderer'
import type { RenderStats, DisplaySettings, AdaptiveSettings } from './render/renderer'
import { SCENES, buildCustomScene, sunFromAzEl } from './engine/scenes'
import { orbitEye } from './engine/camera'
import type { CameraDef } from './engine/camera'
import type { SceneDef } from './engine/types'
import { distance, len, scale, sub, clamp } from './engine/vec3'

interface Orbit {
  target: CameraDef['target']
  radius: number
  yaw: number
  pitch: number
}

const DEFAULTS: ControlState = {
  sceneId: 'weekend',
  resIndex: 1,
  integrator: 'pt',
  spp: 512,
  maxDepth: 8,
  rrStart: 4,
  clampIndirect: 0,
  aperture: 0.1, // matches the Weekend scene's lens; reset per scene below
  adaptive: false,
  adaptiveThreshold: 0.03,
  exposure: 0,
  tonemap: 'aces',
  denoiseEnabled: false,
  denoiseIterations: 4,
  denoiseSigma: 0.5,
  showNoise: false,
  sunAzimuth: 135,
  sunElevation: 24,
  turbidity: 2.6,
  fogDensity: 1,
  cloudCoverage: 0,
  manyLights: false,
  sphereLights: false,
  objText: '',
}

function deriveOrbit(cam: CameraDef): Orbit {
  const dir = sub(cam.eye, cam.target)
  const radius = len(dir)
  const nd = scale(dir, 1 / radius)
  return {
    target: cam.target,
    radius,
    yaw: Math.atan2(nd.x, nd.z),
    pitch: Math.asin(clamp(nd.y, -0.999, 0.999)),
  }
}

function sceneCamera(id: string): CameraDef {
  return SCENES.find((s) => s.id === id)!.build().camera
}

function buildScene(ctrl: ControlState, orbit: Orbit): SceneDef {
  const preset = SCENES.find((s) => s.id === ctrl.sceneId)!
  const def = preset.obj ? buildCustomScene(ctrl.objText) : preset.build()
  // Sky scenes: drive the sun position + turbidity from the live controls.
  if (preset.sky && def.env.kind === 'sky') {
    def.env = {
      ...def.env,
      sunDir: sunFromAzEl(ctrl.sunAzimuth, ctrl.sunElevation),
      turbidity: ctrl.turbidity,
    }
  }
  // Volumetric scenes: scale the medium extinction by the live fog-density knob,
  // and (for heterogeneous fBm clouds) offset the coverage threshold so the cloud
  // can be puffed up or broken apart live. Both are pure data edits to `media`.
  if (preset.fog && def.media && (ctrl.fogDensity !== 1 || (preset.cloud && ctrl.cloudCoverage !== 0))) {
    def.media = def.media.map((m) => {
      let next = ctrl.fogDensity !== 1 ? { ...m, sigmaT: m.sigmaT * ctrl.fogDensity } : { ...m }
      if (preset.cloud && ctrl.cloudCoverage !== 0 && next.density && next.density.kind === 'fbm') {
        const coverage = Math.min(0.95, Math.max(0, next.density.coverage + ctrl.cloudCoverage))
        next = { ...next, density: { ...next.density, coverage } }
      }
      return next
    })
  }
  const eye = orbitEye(orbit.target, orbit.radius, orbit.yaw, orbit.pitch)
  def.camera = {
    ...def.camera,
    eye,
    target: orbit.target,
    aperture: ctrl.aperture,
    focusDist: distance(eye, orbit.target),
  }
  return def
}

function buildDisplay(ctrl: ControlState): DisplaySettings {
  return {
    exposure: ctrl.exposure,
    tonemap: ctrl.tonemap,
    denoiseEnabled: ctrl.denoiseEnabled,
    denoise: {
      iterations: ctrl.denoiseIterations,
      sigmaColor: ctrl.denoiseSigma,
      sigmaNormal: 0.25,
      sigmaAlbedo: 0.1,
    },
    showNoise: ctrl.showNoise,
  }
}

function buildAdaptive(ctrl: ControlState): AdaptiveSettings {
  return { enabled: ctrl.adaptive, threshold: ctrl.adaptiveThreshold }
}

export default function App() {
  const [route, navigate] = useHashRoute()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<Renderer | null>(null)
  const [ctrl, setCtrl] = useState<ControlState>(DEFAULTS)
  const [orbit, setOrbit] = useState<Orbit>(() => deriveOrbit(sceneCamera(DEFAULTS.sceneId)))
  const [stats, setStats] = useState<RenderStats | null>(null)
  const [running, setRunning] = useState(false)
  const [showHint, setShowHint] = useState(true)

  const set = useCallback(<K extends keyof ControlState>(key: K, value: ControlState[K]) => {
    setCtrl((c) => {
      const next = { ...c, [key]: value }
      // Switching scenes adopts that scene's intended depth-of-field aperture and
      // defaults the many-light importance sampler on for scenes that want it.
      if (key === 'sceneId') {
        next.aperture = sceneCamera(value as string).aperture
        next.manyLights = SCENES.find((s) => s.id === value)?.manyLights ?? false
        next.sphereLights = SCENES.find((s) => s.id === value)?.sphereLights ?? false
      }
      return next
    })
    // Switching scenes re-derives the orbit camera from that scene's framing.
    if (key === 'sceneId') setOrbit(deriveOrbit(sceneCamera(value as string)))
  }, [])

  // Create / dispose the Renderer alongside the render viewport.
  useEffect(() => {
    if (route !== 'render') return
    const canvas = canvasRef.current
    if (!canvas) return
    const r = new Renderer(canvas, buildScene(ctrl, orbit), buildDisplay(ctrl))
    r.setAdaptive(buildAdaptive(ctrl))
    r.onStats = (st) => {
      setStats(st)
      if (st.done) setRunning(false)
    }
    rendererRef.current = r
    return () => {
      r.dispose()
      rendererRef.current = null
    }
    // Intentionally only re-create on route change; settings update in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route])

  // Render-affecting settings → debounced restart of the accumulation.
  const renderKey = JSON.stringify({
    s: ctrl.sceneId,
    r: ctrl.resIndex,
    it: ctrl.integrator,
    spp: ctrl.spp,
    d: ctrl.maxDepth,
    rr: ctrl.rrStart,
    c: ctrl.clampIndirect,
    a: ctrl.aperture,
    az: ctrl.sunAzimuth,
    el: ctrl.sunElevation,
    tb: ctrl.turbidity,
    fog: ctrl.fogDensity,
    cc: ctrl.cloudCoverage,
    ml: ctrl.manyLights,
    sl: ctrl.sphereLights,
    obj: ctrl.objText,
    o: orbit,
  })
  useEffect(() => {
    if (route !== 'render') return
    const r = rendererRef.current
    if (!r) return
    const id = window.setTimeout(() => {
      const res = RES_PRESETS[ctrl.resIndex]
      r.setScene(buildScene(ctrl, orbit))
      r.setSettings({ maxDepth: ctrl.maxDepth, rrStart: ctrl.rrStart, clampIndirect: ctrl.clampIndirect, integrator: ctrl.integrator, manyLights: ctrl.manyLights, sphereLights: ctrl.sphereLights })
      r.setResolution(res.w, res.h)
      r.setTarget(ctrl.spp)
      r.start()
      setRunning(true)
    }, 220)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderKey, route])

  // Display-only settings → applied live, no restart.
  useEffect(() => {
    rendererRef.current?.setDisplay(buildDisplay(ctrl))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctrl.exposure, ctrl.tonemap, ctrl.denoiseEnabled, ctrl.denoiseIterations, ctrl.denoiseSigma, ctrl.showNoise])

  // Adaptive sampling → applied live; the convergence test re-runs every pass.
  useEffect(() => {
    rendererRef.current?.setAdaptive(buildAdaptive(ctrl))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctrl.adaptive, ctrl.adaptiveThreshold])

  const onRender = () => {
    const r = rendererRef.current
    if (!r) return
    const res = RES_PRESETS[ctrl.resIndex]
    r.setScene(buildScene(ctrl, orbit))
    r.setSettings({ maxDepth: ctrl.maxDepth, rrStart: ctrl.rrStart, clampIndirect: ctrl.clampIndirect, integrator: ctrl.integrator, manyLights: ctrl.manyLights, sphereLights: ctrl.sphereLights })
    r.setResolution(res.w, res.h)
    r.setTarget(ctrl.spp)
    r.start()
    setRunning(true)
  }
  const onStop = () => {
    rendererRef.current?.stop()
    setRunning(false)
  }
  const onSave = () => {
    const r = rendererRef.current
    if (!r) return
    const a = document.createElement('a')
    a.href = r.toDataURL()
    a.download = `lumen-${ctrl.sceneId}-${stats?.samples ?? 0}spp.png`
    a.click()
  }

  // ---- Orbit camera interaction ----
  const drag = useRef<{ x: number; y: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY }
    ;(e.target as Element).setPointerCapture(e.pointerId)
    setShowHint(false)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    const dx = e.clientX - drag.current.x
    const dy = e.clientY - drag.current.y
    drag.current = { x: e.clientX, y: e.clientY }
    setOrbit((o) => ({
      ...o,
      yaw: o.yaw - dx * 0.006,
      pitch: clamp(o.pitch + dy * 0.006, -1.4, 1.4),
    }))
  }
  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null
    try {
      ;(e.target as Element).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }
  const onWheel = (e: React.WheelEvent) => {
    setOrbit((o) => ({ ...o, radius: clamp(o.radius * Math.exp(e.deltaY * 0.0012), 0.5, 5000) }))
    setShowHint(false)
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◉</span>
          <div>
            <h1>Lumen</h1>
            <span className="tagline">a from-scratch path tracer</span>
          </div>
        </div>
        <nav className="tabs">
          <button className={route === 'render' ? 'tab active' : 'tab'} onClick={() => navigate('render')} type="button">
            Render
          </button>
          <button className={route === 'verify' ? 'tab active' : 'tab'} onClick={() => navigate('verify')} type="button">
            Verify
          </button>
          <button className={route === 'about' ? 'tab active' : 'tab'} onClick={() => navigate('about')} type="button">
            About
          </button>
        </nav>
        <div className="mode-badge">
          {stats ? (stats.mode === 'multithread' ? `${stats.workers} threads` : 'single thread') : ''}
        </div>
      </header>

      {route === 'render' && (
        <main className="studio">
          <aside className="sidebar">
            <Controls state={ctrl} set={set} running={running} onRender={onRender} onStop={onStop} onSave={onSave} />
          </aside>
          <div className="viewport">
            <div className="canvas-wrap">
              <canvas
                ref={canvasRef}
                className="render-canvas"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onWheel={onWheel}
              />
              {showHint && <div className="hint">drag to orbit · scroll to dolly</div>}
            </div>
            <Stats stats={stats} />
          </div>
        </main>
      )}
      {route === 'verify' && (
        <main className="page">
          <SelfTests />
        </main>
      )}
      {route === 'about' && (
        <main className="page">
          <About />
        </main>
      )}

      <footer className="footer">
        Unidirectional, bidirectional, Metropolis (PSSMLT) & photon-mapping (SPPM) light transport · SAH BVH · smooth meshes · Preetham sky + sun NEE · GGX microfacets · MIS · À-Trous denoise — all in TypeScript on the CPU.
      </footer>
    </div>
  )
}
