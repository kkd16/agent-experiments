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
import { decodeHdr, downsampleEquirect, encodeHdr } from './engine/hdr'
import type { HdrImage } from './engine/hdr'
import { decodePfm, encodePfm, sniffHdrFormat } from './engine/pfm'
import { decodeExr, encodeExr } from './engine/exr'

// (25.0) The largest equirectangular width kept for a loaded HDRI. Real panoramas
// ship at 2K–8K; the importance sampler and the postMessage payload both scale
// with texel count, so a dropped map is box-downsampled to this before use — plenty
// of resolution for lighting (the bright features stay resolved), a fraction of the
// cost. The bilinear lookup keeps the reflected backdrop smooth.
const MAX_HDRI_WIDTH = 1024

interface CustomHdri {
  width: number
  height: number
  pixels: Float32Array
}

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
  envRotation: 0,
  envIntensity: 1,
  apertureBlades: 0, // circular aperture; reset per scene below
  lensDistortion: 0, // rectilinear; reset per scene below
  anamorphic: 1, // round pupil; reset per scene below
  bloomStrength: 0,
  bloomRadius: 3,
  vignette: 0,
  chromAberration: 0,
  filmGrain: 0,
  objText: '',
  customHdriName: '',
  customHdriInfo: '',
  hdriError: '',
  customHdriPreview: '',
}

// (26.0) Tone-map a decoded panorama to a small PNG data-URL for the UI preview
// strip. A quick Reinhard + sRGB gamma (this is cosmetic — the render uses the
// full HDR pixels), nearest-sampled into a ~180-px-wide thumbnail. Returns '' if a
// canvas isn't available (e.g. the sandboxed catalog thumbnail).
// Trigger a browser download of a binary buffer under `name`.
function downloadBytes(bytes: Uint8Array, name: string, mime: string): void {
  const blob = new Blob([bytes as BlobPart], { type: mime })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

function makeEnvPreview(img: HdrImage, targetW = 180): string {
  try {
    const aspect = img.height / img.width
    const w = Math.min(targetW, img.width)
    const h = Math.max(1, Math.round(w * aspect))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return ''
    const out = ctx.createImageData(w, h)
    const enc = (x: number): number => {
      const t = x / (1 + x) // Reinhard
      const s = t <= 0.0031308 ? 12.92 * t : 1.055 * Math.pow(t, 1 / 2.4) - 0.055
      return Math.max(0, Math.min(255, Math.round(s * 255)))
    }
    for (let j = 0; j < h; j++) {
      const sj = Math.min(img.height - 1, Math.floor((j / h) * img.height))
      for (let i = 0; i < w; i++) {
        const si = Math.min(img.width - 1, Math.floor((i / w) * img.width))
        const o3 = (sj * img.width + si) * 3
        const d = (j * w + i) * 4
        out.data[d] = enc(img.pixels[o3])
        out.data[d + 1] = enc(img.pixels[o3 + 1])
        out.data[d + 2] = enc(img.pixels[o3 + 2])
        out.data[d + 3] = 255
      }
    }
    ctx.putImageData(out, 0, 0)
    return canvas.toDataURL('image/png')
  } catch {
    return ''
  }
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

function buildScene(ctrl: ControlState, orbit: Orbit, customHdri: CustomHdri | null): SceneDef {
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
  // (21.0) HDRI scenes: spin and scale the equirectangular environment live.
  if (preset.hdri && def.env.kind === 'hdri') {
    def.env = {
      ...def.env,
      rotation: (ctrl.envRotation * Math.PI) / 180,
      intensity: (def.env.intensity ?? 1) * ctrl.envIntensity,
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
  // (25.0) A user-loaded HDRI overrides whatever environment the scene shipped
  // with — it lights any world you drop it on. The rotation/intensity controls
  // (shared with the preset HDRIs) drive it live; the decoded panorama itself
  // lives in a ref (out of ControlState) so it never bloats the render key.
  if (customHdri) {
    def.env = {
      kind: 'hdriData',
      width: customHdri.width,
      height: customHdri.height,
      pixels: customHdri.pixels,
      rotation: (ctrl.envRotation * Math.PI) / 180,
      intensity: ctrl.envIntensity,
      label: ctrl.customHdriName,
    }
  }
  const eye = orbitEye(orbit.target, orbit.radius, orbit.yaw, orbit.pitch)
  def.camera = {
    ...def.camera,
    eye,
    target: orbit.target,
    aperture: ctrl.aperture,
    focusDist: distance(eye, orbit.target),
    blades: ctrl.apertureBlades,
    bladeRotation: def.camera.bladeRotation ?? 0,
    distortion: ctrl.lensDistortion,
    anamorphic: ctrl.anamorphic,
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
    post: {
      bloomStrength: ctrl.bloomStrength,
      bloomRadius: ctrl.bloomRadius,
      vignette: ctrl.vignette,
      chromatic: ctrl.chromAberration,
      grain: ctrl.filmGrain,
      vfovDeg: sceneCamera(ctrl.sceneId).vfovDeg,
    },
  }
}

function buildAdaptive(ctrl: ControlState): AdaptiveSettings {
  return { enabled: ctrl.adaptive, threshold: ctrl.adaptiveThreshold }
}

export default function App() {
  const [route, navigate] = useHashRoute()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<Renderer | null>(null)
  // The decoded custom HDRI panorama, held outside React state so the (heavy)
  // Float32Array never lands in the render-key JSON. A load bumps ctrl.customHdri*,
  // which is what actually re-triggers the render effect.
  const customHdriRef = useRef<CustomHdri | null>(null)
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
        next.apertureBlades = sceneCamera(value as string).blades ?? 0
        next.lensDistortion = sceneCamera(value as string).distortion ?? 0
        next.anamorphic = sceneCamera(value as string).anamorphic ?? 1
        next.manyLights = SCENES.find((s) => s.id === value)?.manyLights ?? false
        next.sphereLights = SCENES.find((s) => s.id === value)?.sphereLights ?? false
        next.envRotation = 0
        next.envIntensity = 1
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
    const r = new Renderer(canvas, buildScene(ctrl, orbit, customHdriRef.current), buildDisplay(ctrl))
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
    ab: ctrl.apertureBlades,
    ld: ctrl.lensDistortion,
    an: ctrl.anamorphic,
    az: ctrl.sunAzimuth,
    el: ctrl.sunElevation,
    tb: ctrl.turbidity,
    fog: ctrl.fogDensity,
    cc: ctrl.cloudCoverage,
    ml: ctrl.manyLights,
    sl: ctrl.sphereLights,
    erot: ctrl.envRotation,
    eint: ctrl.envIntensity,
    obj: ctrl.objText,
    hdri: ctrl.customHdriName,
    hdriInfo: ctrl.customHdriInfo,
    o: orbit,
  })
  useEffect(() => {
    if (route !== 'render') return
    const r = rendererRef.current
    if (!r) return
    const id = window.setTimeout(() => {
      const res = RES_PRESETS[ctrl.resIndex]
      r.setScene(buildScene(ctrl, orbit, customHdriRef.current))
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
  }, [
    ctrl.exposure,
    ctrl.tonemap,
    ctrl.denoiseEnabled,
    ctrl.denoiseIterations,
    ctrl.denoiseSigma,
    ctrl.showNoise,
    ctrl.bloomStrength,
    ctrl.bloomRadius,
    ctrl.vignette,
    ctrl.chromAberration,
    ctrl.filmGrain,
    ctrl.sceneId,
  ])

  // Adaptive sampling → applied live; the convergence test re-runs every pass.
  useEffect(() => {
    rendererRef.current?.setAdaptive(buildAdaptive(ctrl))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctrl.adaptive, ctrl.adaptiveThreshold])

  const onRender = () => {
    const r = rendererRef.current
    if (!r) return
    const res = RES_PRESETS[ctrl.resIndex]
    r.setScene(buildScene(ctrl, orbit, customHdriRef.current))
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

  // (25.0/26.0/27.0) Decode a dropped/loaded HDR panorama — Radiance `.hdr` (RGBE),
  // a Portable FloatMap `.pfm`, or an OpenEXR `.exr` — downsample it for the
  // sampler, stash the panorama in the ref, build a preview thumbnail, and bump the
  // control state (which re-triggers the render). Any decode failure surfaces as a
  // message in the panel.
  const loadHdri = useCallback(async (file: File) => {
    try {
      const buf = new Uint8Array(await file.arrayBuffer())
      // Sniff by magic bytes, falling back to the file extension.
      const fmt =
        sniffHdrFormat(buf) ??
        (/\.pfm$/i.test(file.name)
          ? 'pfm'
          : /\.exr$/i.test(file.name)
            ? 'exr'
            : /\.(hdr|pic)$/i.test(file.name)
              ? 'hdr'
              : null)
      if (!fmt) throw new Error('unrecognised format (expected a Radiance .hdr, a .pfm, or an .exr)')
      const full = fmt === 'pfm' ? decodePfm(buf) : fmt === 'exr' ? decodeExr(buf) : decodeHdr(buf)
      const img = downsampleEquirect(full, MAX_HDRI_WIDTH)
      customHdriRef.current = { width: img.width, height: img.height, pixels: img.pixels }
      const dims =
        img.width === full.width
          ? `${full.width}×${full.height}`
          : `${full.width}×${full.height} → ${img.width}×${img.height}`
      setCtrl((c) => ({
        ...c,
        customHdriName: file.name,
        customHdriInfo: `${fmt} · ${dims}`,
        hdriError: '',
        customHdriPreview: makeEnvPreview(img),
      }))
    } catch (err) {
      customHdriRef.current = null
      setCtrl((c) => ({
        ...c,
        customHdriName: '',
        customHdriInfo: '',
        customHdriPreview: '',
        hdriError: `Couldn't read "${file.name}": ${(err as Error).message}`,
      }))
    }
  }, [])

  const onClearHdri = useCallback(() => {
    customHdriRef.current = null
    setCtrl((c) => ({ ...c, customHdriName: '', customHdriInfo: '', hdriError: '', customHdriPreview: '' }))
  }, [])

  // Export the current linear HDR frame as a real Radiance .hdr (physical
  // radiance, not tone-mapped) — the same encoder the self-tests round-trip.
  const onSaveHdr = () => {
    const r = rendererRef.current
    if (!r) return
    const { pixels, width, height } = r.hdrImage()
    const bytes = encodeHdr(pixels, width, height)
    downloadBytes(bytes, `lumen-${ctrl.sceneId}-${stats?.samples ?? 0}spp.hdr`, 'image/vnd.radiance')
  }

  // (26.0) Export the linear HDR frame as a LOSSLESS Portable FloatMap (.pfm) —
  // raw float32, the same encoder the suite round-trips bit-for-bit.
  const onSavePfm = () => {
    const r = rendererRef.current
    if (!r) return
    const { pixels, width, height } = r.hdrImage()
    const bytes = encodePfm(pixels, width, height)
    downloadBytes(bytes, `lumen-${ctrl.sceneId}-${stats?.samples ?? 0}spp.pfm`, 'image/x-pfm')
  }

  // (27.0) Export the linear HDR frame as an OpenEXR — the film-industry standard.
  // ZIP-compressed FLOAT: lossless (bit-exact decode) *and* compressed, the format
  // Nuke / After Effects / Blender read natively. Built by the same from-scratch
  // codec the suite round-trips.
  const onSaveExr = () => {
    const r = rendererRef.current
    if (!r) return
    const { pixels, width, height } = r.hdrImage()
    const bytes = encodeExr(pixels, width, height, { compression: 'zip', channelType: 'float' })
    downloadBytes(bytes, `lumen-${ctrl.sceneId}-${stats?.samples ?? 0}spp.exr`, 'image/x-exr')
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

  // ---- Drag-and-drop an .hdr onto the viewport ----
  const [hdriDragOver, setHdriDragOver] = useState(false)
  const onDragOver = (e: React.DragEvent) => {
    if (Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault()
      if (!hdriDragOver) setHdriDragOver(true)
    }
  }
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setHdriDragOver(false)
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setHdriDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f) void loadHdri(f)
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
            <Controls
              state={ctrl}
              set={set}
              running={running}
              onRender={onRender}
              onStop={onStop}
              onSave={onSave}
              onLoadHdri={loadHdri}
              onClearHdri={onClearHdri}
              onSaveHdr={onSaveHdr}
              onSavePfm={onSavePfm}
              onSaveExr={onSaveExr}
            />
          </aside>
          <div className="viewport">
            <div
              className={hdriDragOver ? 'canvas-wrap drag-over' : 'canvas-wrap'}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
            >
              <canvas
                ref={canvasRef}
                className="render-canvas"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onWheel={onWheel}
              />
              {showHint && (
                <div className="hint">drag to orbit · scroll to dolly · drop an .hdr / .pfm / .exr to relight</div>
              )}
              {hdriDragOver && <div className="drop-overlay">⤒ Drop a .hdr / .pfm / .exr to light the scene</div>}
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
        Unidirectional, bidirectional, Metropolis (PSSMLT) & photon-mapping (SPPM) light transport · SAH BVH · smooth meshes · Preetham sky + sun NEE · HDRI image-based lighting (importance sampled, drop your own .hdr / .pfm / .exr) · GGX microfacets · MIS · À-Trous denoise — all in TypeScript on the CPU.
      </footer>
    </div>
  )
}
