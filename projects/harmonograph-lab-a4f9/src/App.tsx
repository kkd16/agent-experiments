import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import './App.css'
import {
  cloneParams,
  defaultDensity,
  defaultStyle,
  makeId,
  makeLayer,
  randomParams,
  type LayerData,
} from './harmonograph'
import {
  CURVE_KINDS,
  breatheLayer,
  computeLayerData,
  loopLayer,
  default3D,
  defaultAttractor,
  defaultFourier,
  defaultLSystem,
  defaultLiss,
  defaultRose,
  defaultSf,
  defaultSpiro,
  getLayerData,
  is3dKind,
  layerCamera,
  patchLayerCamera,
  random3D,
  random3DHarmonograph,
  default3DHarmonograph,
  randomAttractor,
  randomLSystem,
  randomLissajous,
  randomRose,
  randomSpiro,
  randomSuperformula,
} from './curves'
import { BACKGROUNDS, PALETTES, randomPalette } from './palettes'
import { PRESETS, loadPreset } from './presets'
import { generateProject } from './generate'
import { computeTransform, drawProject, toSvg, type Transform } from './render'
import { canRecord, recordWebm } from './record'
import { canGif, recordGif } from './gif'
import { AudioReactor, canAudio } from './audio'
import {
  deleteFromGallery,
  loadGallery,
  readHashProject,
  saveToGallery,
  shareUrl,
  writeHashProject,
  type GalleryItem,
} from './share'
import type {
  Attractor3DParams,
  AttractorParams,
  BackgroundMode,
  BlendMode,
  ColorMode,
  CurveKind,
  DensityStyle,
  FourierParams,
  Harmonograph3DParams,
  Layer,
  LissajousParams,
  LSystemParams,
  Project,
  RenderStyle,
  RoseParams,
  SpirographParams,
  StereoMode,
  SuperformulaParams,
  WidthMode,
} from './types'
import { Slider } from './components/Slider'
import { Segmented } from './components/Segmented'
import { LayerList } from './components/LayerList'
import {
  CurveAttractor,
  CurveAttractor3D,
  CurveFourier,
  CurveHarmonograph,
  CurveHarmonograph3D,
  CurveLSystem,
  CurveLissajous,
  CurveRose,
  CurveSpirograph,
  CurveSuperformula,
} from './components/CurveControls'

const RENDER = 1100 // canvas backing resolution (square)

type Tab = 'compose' | 'curve' | 'style' | 'scene' | 'save'
type PendKey = 'x1' | 'x2' | 'y1' | 'y2'

const COLOR_MODES: { value: ColorMode; label: string }[] = [
  { value: 'path', label: 'Path' },
  { value: 'velocity', label: 'Speed' },
  { value: 'curvature', label: 'Curve' },
  { value: 'angle', label: 'Angle' },
]
const WIDTH_MODES: { value: WidthMode; label: string }[] = [
  { value: 'uniform', label: 'Uniform' },
  { value: 'speed', label: 'By speed' },
]
const BLEND_MODES: { value: BlendMode; label: string }[] = [
  { value: 'source-over', label: 'Normal' },
  { value: 'lighter', label: 'Add' },
  { value: 'screen', label: 'Screen' },
]
const BG_MODES: { value: BackgroundMode; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'linear', label: 'Linear' },
  { value: 'radial', label: 'Radial' },
]
const RENDER_STYLES: { value: RenderStyle; label: string }[] = [
  { value: 'line', label: 'Stroke' },
  { value: 'density', label: 'Density' },
]
const STEREO_MODES: { value: StereoMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'anaglyph', label: 'Anaglyph' },
  { value: 'sbs', label: 'Side-by-side' },
  { value: 'crosseye', label: 'Cross-eye' },
]

function initialProject(): Project {
  return readHashProject() ?? loadPreset(PRESETS[0])
}

// Fresh random source matching a layer's current kind.
function withRandomSource(l: Layer): Layer {
  switch (l.kind) {
    case 'spirograph':
      return { ...l, spiro: randomSpiro() }
    case 'rose':
      return { ...l, rose: randomRose() }
    case 'lissajous':
      return { ...l, liss: randomLissajous() }
    case 'superformula':
      return { ...l, sf: randomSuperformula() }
    case 'attractor':
      return { ...l, attractor: randomAttractor() }
    case 'attractor3d':
      return { ...l, a3d: random3D() }
    case 'harmonograph3d':
      return { ...l, h3d: random3DHarmonograph() }
    case 'lsystem':
      return { ...l, lsystem: randomLSystem() }
    case 'harmonograph':
    default:
      return { ...l, params: randomParams() }
  }
}

// Audio-reactive view modulation: pulse glow with the overall level and swell
// line width with the bass. Purely a draw-time effect on a throwaway project
// copy — it never mutates or persists the figure.
function pulseProject(project: Project, level: number, bass: number, gain: number): Project {
  const g = Math.max(0, gain)
  const glowBoost = level * 0.6 * g
  const widthBoost = 1 + bass * 1.1 * g
  return {
    ...project,
    layers: project.layers.map((l) => ({
      ...l,
      style: {
        ...l.style,
        glow: Math.min(1, l.style.glow + glowBoost),
        lineWidth: l.style.lineWidth * widthBoost,
      },
    })),
  }
}

export default function App() {
  const [project, setProject] = useState<Project>(initialProject)
  const [selectedId, setSelectedId] = useState<string>(
    () => project.layers[0]?.id ?? '',
  )
  const [tab, setTab] = useState<Tab>('compose')
  const [trace, setTrace] = useState(1)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [live, setLive] = useState(false)
  const [liveSpeed, setLiveSpeed] = useState(1)
  const [recording, setRecording] = useState(false)
  const [gifBusy, setGifBusy] = useState(false)
  const [audioOn, setAudioOn] = useState(false)
  const [audioGain, setAudioGain] = useState(1)
  const [beatReseed, setBeatReseed] = useState(false)
  const [exportScale, setExportScale] = useState(2)
  const [gallery, setGallery] = useState<GalleryItem[]>(() => loadGallery())
  const [galleryName, setGalleryName] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [showHelp, setShowHelp] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const traceRef = useRef(1)
  const audioRef = useRef<AudioReactor | null>(null)
  const audioGainRef = useRef(1)
  useEffect(() => {
    audioGainRef.current = audioGain
  }, [audioGain])
  const beatReseedRef = useRef(false)
  useEffect(() => {
    beatReseedRef.current = beatReseed
  }, [beatReseed])
  // A stable handle to the current "randomize everything" action, so the audio
  // loop can fire it on a detected beat without being torn down each render.
  const reseedRef = useRef<() => void>(() => {})

  // Build render data per layer. `getLayerData` caches by params identity, so a
  // style edit (which keeps the params object) is essentially free here.
  const datas = useMemo(() => {
    const map = new Map<string, LayerData>()
    for (const layer of project.layers) {
      map.set(layer.id, getLayerData(layer))
    }
    return map
  }, [project.layers])

  const selected = useMemo(
    () => project.layers.find((l) => l.id === selectedId) ?? project.layers[0],
    [project.layers, selectedId],
  )
  const scene3dCount = useMemo(
    () => project.layers.filter((l) => is3dKind(l.kind)).length,
    [project.layers],
  )

  // Draw the static figure. While Live mode or a recording is running, those
  // own the canvas, so this effect stands down.
  useEffect(() => {
    if (live || recording || audioOn) return
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    drawProject(ctx, project, datas, RENDER, { trace })
  }, [project, datas, trace, live, recording, audioOn])

  // Live "breathe" loop: drift each layer's phases over time and redraw, with
  // framing frozen so the evolving figure doesn't jitter as its extent shifts.
  useEffect(() => {
    if (!live) return
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    const tf: Transform = computeTransform(project.layers, datas, RENDER)
    let raf = 0
    const t0 = performance.now()
    const loop = (now: number) => {
      const t = ((now - t0) / 1000) * liveSpeed
      const map = new Map<string, LayerData>()
      const drifted = project.layers.map((l) => {
        const dl = breatheLayer(l, t)
        map.set(dl.id, computeLayerData(dl))
        return dl
      })
      drawProject(ctx, { ...project, layers: drifted }, map, RENDER, {
        transform: tf,
        densityQuality: 0.35,
      })
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [live, liveSpeed, project, datas])

  // Audio-reactive loop: sample the mic each frame and redraw the figure with
  // glow / width pulsing to the sound. Framing is frozen (like Live) so the beat
  // doesn't make the whole piece breathe in and out of frame.
  useEffect(() => {
    if (!audioOn) return
    const reactor = audioRef.current
    const ctx = canvasRef.current?.getContext('2d')
    if (!reactor || !ctx) return
    const tf: Transform = computeTransform(project.layers, datas, RENDER)
    let raf = 0
    const loop = () => {
      reactor.sample()
      if (beatReseedRef.current && reactor.consumeOnset()) reseedRef.current()
      const pulsed = pulseProject(project, reactor.getLevel(), reactor.getBass(), audioGainRef.current)
      drawProject(ctx, pulsed, datas, RENDER, { transform: tf, densityQuality: 0.5 })
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [audioOn, project, datas])

  // Keep the URL hash in sync so the current piece is always shareable.
  useEffect(() => {
    writeHashProject(project)
  }, [project])

  // Animated drawing pass. The play handler resets the trace before starting, so
  // the effect body only schedules frames (no synchronous state updates here).
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      traceRef.current = Math.min(1, traceRef.current + dt * 0.3 * speed)
      setTrace(traceRef.current)
      if (traceRef.current >= 1) {
        setPlaying(false)
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed])

  const flash = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 1900)
  }, [])

  // ---- project mutations --------------------------------------------------

  const setLayers = useCallback((fn: (ls: Layer[]) => Layer[]) => {
    setProject((p) => ({ ...p, layers: fn(p.layers) }))
  }, [])

  const updateLayer = useCallback(
    (id: string, fn: (l: Layer) => Layer) => {
      setLayers((ls) => ls.map((l) => (l.id === id ? fn(l) : l)))
    },
    [setLayers],
  )

  const updateStyle = (patch: Partial<Layer['style']>) => {
    if (!selected) return
    updateLayer(selected.id, (l) => ({ ...l, style: { ...l.style, ...patch } }))
  }
  const updateDensity = (patch: Partial<DensityStyle>) => {
    if (!selected) return
    updateLayer(selected.id, (l) => ({
      ...l,
      style: { ...l.style, density: { ...(l.style.density ?? defaultDensity()), ...patch } },
    }))
  }
  const updateParams = (patch: Partial<Layer['params']>) => {
    if (!selected) return
    updateLayer(selected.id, (l) => ({ ...l, params: { ...l.params, ...patch } }))
  }
  const updatePend = (key: PendKey, field: 'freq' | 'phase' | 'amp' | 'damp', v: number) => {
    if (!selected) return
    updateLayer(selected.id, (l) => ({
      ...l,
      params: { ...l.params, [key]: { ...l.params[key], [field]: v } },
    }))
  }

  // ---- curve-source editing (per kind) ------------------------------------

  const setKind = (kind: CurveKind) => {
    if (!selected) return
    updateLayer(selected.id, (l) => {
      const next: Layer = { ...l, kind }
      if (kind === 'spirograph' && !next.spiro) next.spiro = defaultSpiro()
      if (kind === 'rose' && !next.rose) next.rose = defaultRose()
      if (kind === 'lissajous' && !next.liss) next.liss = defaultLiss()
      if (kind === 'superformula' && !next.sf) next.sf = defaultSf()
      if (kind === 'attractor' && !next.attractor) next.attractor = defaultAttractor()
      if (kind === 'attractor3d' && !next.a3d) next.a3d = default3D()
      if (kind === 'harmonograph3d' && !next.h3d) next.h3d = default3DHarmonograph()
      if (kind === 'lsystem' && !next.lsystem) next.lsystem = defaultLSystem()
      if (kind === 'fourier' && !next.fourier) next.fourier = defaultFourier()
      return next
    })
  }
  const updateSpiro = (patch: Partial<SpirographParams>) => {
    if (!selected) return
    updateLayer(selected.id, (l) => ({ ...l, spiro: { ...(l.spiro ?? defaultSpiro()), ...patch } }))
  }
  const updateRose = (patch: Partial<RoseParams>) => {
    if (!selected) return
    updateLayer(selected.id, (l) => ({ ...l, rose: { ...(l.rose ?? defaultRose()), ...patch } }))
  }
  const updateLiss = (patch: Partial<LissajousParams>) => {
    if (!selected) return
    updateLayer(selected.id, (l) => ({ ...l, liss: { ...(l.liss ?? defaultLiss()), ...patch } }))
  }
  const updateSf = (patch: Partial<SuperformulaParams>) => {
    if (!selected) return
    updateLayer(selected.id, (l) => ({ ...l, sf: { ...(l.sf ?? defaultSf()), ...patch } }))
  }
  const updateAttractor = (patch: Partial<AttractorParams>) => {
    if (!selected) return
    updateLayer(selected.id, (l) => ({
      ...l,
      attractor: { ...(l.attractor ?? defaultAttractor()), ...patch },
    }))
  }
  const updateA3d = (patch: Partial<Attractor3DParams>) => {
    if (!selected) return
    updateLayer(selected.id, (l) => ({
      ...l,
      a3d: { ...(l.a3d ?? default3D()), ...patch },
    }))
  }
  const updateH3d = (patch: Partial<Harmonograph3DParams>) => {
    if (!selected) return
    updateLayer(selected.id, (l) => ({
      ...l,
      h3d: { ...(l.h3d ?? default3DHarmonograph()), ...patch },
    }))
  }
  const updateLSystem = (patch: Partial<LSystemParams>) => {
    if (!selected) return
    updateLayer(selected.id, (l) => ({
      ...l,
      lsystem: { ...(l.lsystem ?? defaultLSystem()), ...patch },
    }))
  }
  const updateFourier = (patch: Partial<FourierParams>) => {
    if (!selected) return
    updateLayer(selected.id, (l) => ({
      ...l,
      fourier: { ...(l.fourier ?? defaultFourier()), ...patch },
    }))
  }
  const updateDrift = (rate: number) => {
    if (!selected) return
    updateLayer(selected.id, (l) => ({ ...l, drift: { rate } }))
  }

  // ---- orbit + dolly camera gestures (any 3D layer) -----------------------
  // When the selected layer is a 3D family (a strange-attractor flow or the
  // spatial harmonograph) the canvas becomes a turntable: one-finger drag orbits
  // the camera (yaw/pitch), the scroll wheel or a two-finger pinch dollies it in
  // and out. Both 3D families share one camera through `patchLayerCamera`, so the
  // gestures don't care which one they're driving. Deltas are taken from the
  // gesture start (absolute, not incremental) so there's no drift.
  const DIST_MIN = 1.7
  const DIST_MAX = 6
  const clampDist = (v: number) => Math.max(DIST_MIN, Math.min(DIST_MAX, v))
  const orbitDrag = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null)
  // Active pointers + the pinch gesture baseline (two-finger dolly).
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinch = useRef<{ dist0: number; camDist: number } | null>(null)
  const isOrbitable = !!selected && is3dKind(selected.kind)
  const patchCam = (patch: Partial<Attractor3DParams>) => {
    if (!selected) return
    updateLayer(selected.id, (l) => patchLayerCamera(l, patch))
  }
  const twoFingerDist = () => {
    const pts = [...pointers.current.values()]
    if (pts.length < 2) return 0
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
  }
  const onCanvasPointerDown = (e: ReactPointerEvent) => {
    if (!selected || !is3dKind(selected.kind)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    e.currentTarget.setPointerCapture?.(e.pointerId)
    if (pointers.current.size === 2) {
      // Second finger down → start a pinch dolly; suspend the orbit drag.
      orbitDrag.current = null
      const cam = layerCamera(selected)
      pinch.current = { dist0: twoFingerDist(), camDist: cam?.dist ?? 2.6 }
    } else if (pointers.current.size === 1) {
      const cam = layerCamera(selected)
      orbitDrag.current = { x: e.clientX, y: e.clientY, yaw: cam?.yaw ?? 0, pitch: cam?.pitch ?? 0 }
    }
  }
  const onCanvasPointerMove = (e: ReactPointerEvent) => {
    if (!selected || !is3dKind(selected.kind)) return
    if (pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    }
    const p = pinch.current
    if (p && pointers.current.size >= 2) {
      const d = twoFingerDist()
      if (p.dist0 > 0 && d > 0) {
        // Fingers apart → zoom in (smaller distance), together → zoom out.
        patchCam({ dist: clampDist(p.camDist * (p.dist0 / d)) })
      }
      return
    }
    const d = orbitDrag.current
    if (!d) return
    const w = canvasRef.current?.getBoundingClientRect().width || 600
    const dx = ((e.clientX - d.x) / w) * Math.PI * 2
    const dy = ((e.clientY - d.y) / w) * Math.PI * 2
    const pitch = Math.max(-1.4, Math.min(1.4, d.pitch - dy))
    patchCam({ yaw: d.yaw + dx, pitch })
  }
  const onCanvasPointerUp = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId)
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (pointers.current.size === 0) orbitDrag.current = null
  }
  const onCanvasWheel = (e: ReactWheelEvent) => {
    if (!selected || !is3dKind(selected.kind)) return
    e.preventDefault()
    const cam = layerCamera(selected)
    const base = cam?.dist ?? 2.6
    // Exponential so each notch feels the same regardless of current distance.
    patchCam({ dist: clampDist(base * Math.exp(e.deltaY * 0.0012)) })
  }
  const resetCamera = () => {
    patchCam({ yaw: 0.7, pitch: 0.42, dist: 2.6, fov: 1.0 })
  }


  const addLayer = useCallback(() => {
    const layer = makeLayer(
      `Layer ${project.layers.length + 1}`,
      randomParams(),
      defaultStyle(randomPalette().colors),
    )
    setLayers((ls) => [...ls, layer])
    setSelectedId(layer.id)
    setTab('curve')
  }, [project.layers.length, setLayers])

  const duplicateLayer = (id: string) => {
    setLayers((ls) => {
      const i = ls.findIndex((l) => l.id === id)
      if (i < 0) return ls
      const src = ls[i]
      const copy: Layer = {
        id: makeId(),
        name: `${src.name} copy`,
        visible: true,
        kind: src.kind,
        params: cloneParams(src.params),
        style: { ...src.style, colors: [...src.style.colors] },
      }
      // Clone the active source for non-harmonograph kinds so edits don't share.
      if (src.spiro) copy.spiro = { ...src.spiro }
      if (src.rose) copy.rose = { ...src.rose }
      if (src.liss) copy.liss = { ...src.liss }
      if (src.sf) copy.sf = { ...src.sf }
      if (src.attractor) copy.attractor = { ...src.attractor }
      if (src.a3d) copy.a3d = { ...src.a3d }
      if (src.h3d) copy.h3d = { ...src.h3d }
      if (src.lsystem) copy.lsystem = { ...src.lsystem }
      if (src.drift) copy.drift = { ...src.drift }
      const next = [...ls]
      next.splice(i + 1, 0, copy)
      return next
    })
  }

  const deleteLayer = (id: string) => {
    if (project.layers.length <= 1) return
    const i = project.layers.findIndex((l) => l.id === id)
    const layers = project.layers.filter((l) => l.id !== id)
    if (id === selectedId) {
      const neighbour = layers[Math.min(i, layers.length - 1)]
      if (neighbour) setSelectedId(neighbour.id)
    }
    setProject((p) => ({ ...p, layers: p.layers.filter((l) => l.id !== id) }))
  }

  const moveLayer = (id: string, dir: -1 | 1) => {
    setLayers((ls) => {
      const i = ls.findIndex((l) => l.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= ls.length) return ls
      const next = [...ls]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  const renameLayer = (id: string, name: string) =>
    updateLayer(id, (l) => ({ ...l, name }))

  const randomizeSelected = useCallback(() => {
    if (!selected) return
    updateLayer(selected.id, (l) => withRandomSource(l))
  }, [selected, updateLayer])

  const randomizeAll = useCallback(() => {
    setLayers((ls) =>
      ls.map((l) => ({
        ...withRandomSource(l),
        style: { ...l.style, colors: randomPalette().colors },
      })),
    )
  }, [setLayers])
  useEffect(() => {
    reseedRef.current = randomizeAll
  }, [randomizeAll])

  const generate = useCallback(() => {
    const proj = generateProject()
    setProject(proj)
    setSelectedId(proj.layers[0].id)
    traceRef.current = 1
    setTrace(1)
  }, [])

  const applyPreset = (i: number) => {
    const proj = loadPreset(PRESETS[i])
    setProject(proj)
    setSelectedId(proj.layers[0].id)
    traceRef.current = 1
    setTrace(1)
    flash(`Loaded “${PRESETS[i].name}”`)
  }

  // ---- palette editing ----------------------------------------------------

  const setColor = (i: number, hex: string) => {
    if (!selected) return
    updateLayer(selected.id, (l) => {
      const colors = [...l.style.colors]
      colors[i] = hex
      return { ...l, style: { ...l.style, colors } }
    })
  }
  const addColor = () => {
    if (!selected) return
    updateStyle({ colors: [...selected.style.colors, '#ffffff'] })
  }
  const removeColor = (i: number) => {
    if (!selected || selected.style.colors.length <= 1) return
    updateStyle({ colors: selected.style.colors.filter((_, k) => k !== i) })
  }

  // ---- export / share / gallery -------------------------------------------

  const renderToCanvas = useCallback(
    (size: number): HTMLCanvasElement | null => {
      const c = document.createElement('canvas')
      c.width = size
      c.height = size
      const ctx = c.getContext('2d')
      if (!ctx) return null
      // No epicycle overlay in the still export — the art should stand alone.
      drawProject(ctx, project, datas, size, { trace: 1, overlays: false })
      return c
    },
    [project, datas],
  )

  const downloadPng = useCallback(() => {
    const c = renderToCanvas(RENDER * exportScale)
    if (!c) return
    const a = document.createElement('a')
    a.href = c.toDataURL('image/png')
    a.download = 'harmonograph.png'
    a.click()
    flash(`Saved PNG (${RENDER * exportScale}px)`)
  }, [renderToCanvas, exportScale, flash])

  const downloadSvg = () => {
    const svg = toSvg(project, datas, RENDER, { trace: 1 })
    const blob = new Blob([svg], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'harmonograph.svg'
    a.click()
    URL.revokeObjectURL(url)
    flash('Saved SVG')
  }

  const doShare = useCallback(() => {
    const url = shareUrl(project)
    try {
      navigator.clipboard?.writeText(url).then(
        () => flash('Link copied to clipboard'),
        () => flash('Link is in the address bar'),
      )
    } catch {
      flash('Link is in the address bar')
    }
  }, [project, flash])

  const saveCurrent = () => {
    const c = renderToCanvas(360)
    const thumb = c?.toDataURL('image/png') ?? ''
    const item: GalleryItem = {
      id: makeId(),
      name: galleryName.trim() || `Piece ${gallery.length + 1}`,
      thumb,
      project: JSON.parse(JSON.stringify(project)) as Project,
      createdAt: Date.now(),
    }
    setGallery(saveToGallery(item))
    setGalleryName('')
    flash('Saved to gallery')
  }

  const loadFromGallery = (item: GalleryItem) => {
    const proj = JSON.parse(JSON.stringify(item.project)) as Project
    setProject(proj)
    setSelectedId(proj.layers[0]?.id ?? '')
    traceRef.current = 1
    setTrace(1)
    flash(`Loaded “${item.name}”`)
  }

  const removeFromGallery = (id: string) => setGallery(deleteFromGallery(id))

  // ---- animation controls -------------------------------------------------

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.stop()
      audioRef.current = null
    }
    setAudioOn(false)
  }, [])

  const togglePlay = useCallback(() => {
    if (recording) return
    setLive(false)
    stopAudio()
    if (!playing && traceRef.current >= 1) {
      traceRef.current = 0
      setTrace(0)
    }
    setPlaying((p) => !p)
  }, [playing, recording, stopAudio])
  const scrub = (v: number) => {
    setPlaying(false)
    traceRef.current = v
    setTrace(v)
  }

  const toggleLive = useCallback(() => {
    if (recording) return
    setPlaying(false)
    stopAudio()
    // entering Live: make sure the full figure is showing first
    if (!live) {
      traceRef.current = 1
      setTrace(1)
    }
    setLive((v) => !v)
  }, [live, recording, stopAudio])

  // ---- video capture ------------------------------------------------------

  // Render one frame of the seamless evolution loop at phase u ∈ [0,1). Framing
  // is computed from the *base* figure so it never jitters as the loop breathes.
  const renderLoopFrame = useCallback(
    (ctx2: CanvasRenderingContext2D, size: number, u: number, quality: number) => {
      const tf = computeTransform(project.layers, datas, size)
      const phase = u * Math.PI * 2
      const map = new Map<string, LayerData>()
      const looped = project.layers.map((l) => {
        const dl = loopLayer(l, phase)
        map.set(dl.id, computeLayerData(dl))
        return dl
      })
      drawProject(ctx2, { ...project, layers: looped }, map, size, {
        transform: tf,
        densityQuality: quality,
      })
    },
    [project, datas],
  )

  const recordVideo = useCallback(async () => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    if (!canRecord()) {
      flash('Video capture is not supported in this browser')
      return
    }
    const loopMode = live
    setLive(false)
    setPlaying(false)
    if (audioRef.current) {
      audioRef.current.stop()
      audioRef.current = null
      setAudioOn(false)
    }
    setRecording(true)
    try {
      const blob = await recordWebm(
        canvas,
        (tr) =>
          loopMode
            ? renderLoopFrame(ctx, RENDER, tr, 0.6)
            : drawProject(ctx, project, datas, RENDER, { trace: tr }),
        loopMode ? { duration: 6, fps: 60, hold: 0 } : { duration: 7, fps: 60, hold: 1.4 },
      )
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'harmonograph.webm'
      a.click()
      URL.revokeObjectURL(url)
      flash(loopMode ? 'Saved looping WebM' : 'Saved WebM video')
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Recording failed')
    } finally {
      setRecording(false)
      traceRef.current = 1
      setTrace(1)
    }
  }, [project, datas, live, renderLoopFrame, flash])

  // ---- animated GIF (universal) -------------------------------------------

  const downloadGif = useCallback(async () => {
    if (!canGif()) {
      flash('GIF export is not supported here')
      return
    }
    const loopMode = live
    setLive(false)
    setPlaying(false)
    if (audioRef.current) {
      audioRef.current.stop()
      audioRef.current = null
      setAudioOn(false)
    }
    setGifBusy(true)
    flash(loopMode ? 'Rendering looping GIF…' : 'Rendering GIF…')
    try {
      const blob = await recordGif(
        (ctx, size, tr) =>
          loopMode
            ? renderLoopFrame(ctx, size, tr, 0.5)
            : drawProject(ctx, project, datas, size, { trace: tr }),
        loopMode
          ? { size: 420, frames: 48, delayMs: 55, holdMs: 0 }
          : { size: 420, frames: 36, delayMs: 60, holdMs: 900 },
      )
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'harmonograph.gif'
      a.click()
      URL.revokeObjectURL(url)
      flash(`Saved GIF (${(blob.size / 1024).toFixed(0)} KB)`)
    } catch (err) {
      flash(err instanceof Error ? err.message : 'GIF export failed')
    } finally {
      setGifBusy(false)
    }
  }, [project, datas, live, renderLoopFrame, flash])

  // ---- audio-reactive mode -------------------------------------------------

  const toggleAudio = useCallback(async () => {
    if (recording || gifBusy) return
    if (audioOn) {
      audioRef.current?.stop()
      audioRef.current = null
      setAudioOn(false)
      return
    }
    if (!canAudio()) {
      flash('Microphone / audio is not available here')
      return
    }
    setPlaying(false)
    setLive(false)
    const reactor = new AudioReactor()
    const ok = await reactor.start()
    if (!ok) {
      reactor.stop()
      flash('Could not access the microphone')
      return
    }
    audioRef.current = reactor
    traceRef.current = 1
    setTrace(1)
    setAudioOn(true)
    flash('Audio-reactive — make some noise 🎙')
  }, [audioOn, recording, gifBusy, flash])

  // Always release the mic when the component unmounts.
  useEffect(() => () => audioRef.current?.stop(), [])

  // ---- keyboard shortcuts -------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      if (e.key === 'Escape') {
        setShowHelp(false)
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      switch (e.key) {
        case 'g':
          generate()
          break
        case 'r':
          randomizeSelected()
          break
        case ' ':
          e.preventDefault()
          togglePlay()
          break
        case 'l':
          toggleLive()
          break
        case 'a':
          void toggleAudio()
          break
        case 'i':
          void downloadGif()
          break
        case 'n':
          addLayer()
          break
        case 'e':
          downloadPng()
          break
        case 's':
          doShare()
          break
        case '?':
          setShowHelp((s) => !s)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    generate,
    randomizeSelected,
    togglePlay,
    toggleLive,
    toggleAudio,
    downloadGif,
    addLayer,
    doShare,
    downloadPng,
  ])

  const theme = selected
  const visibleCount = project.layers.filter((l) => l.visible).length

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <h1>Harmonograph Lab</h1>
          <p className="sub">
            A studio for layered damped-pendulum art — {project.layers.length}{' '}
            layer{project.layers.length === 1 ? '' : 's'}, {visibleCount} visible
          </p>
        </div>
        <div className="topbar-actions">
          <button className="primary" onClick={generate} title="Generate a new composition (g)">
            ✨ Generate
          </button>
          <button className="ghost" onClick={randomizeSelected} title="Randomize layer (r)">
            🎲 Randomize
          </button>
          <button className="ghost" onClick={togglePlay} title="Play / pause (space)">
            {playing ? '⏸ Pause' : '▶ Animate'}
          </button>
          <button
            className={live ? 'ghost active-toggle' : 'ghost'}
            onClick={toggleLive}
            title="Live evolving figure (l)"
          >
            {live ? '🌀 Live ✓' : '🌀 Live'}
          </button>
          <button
            className={audioOn ? 'ghost active-toggle' : 'ghost'}
            onClick={toggleAudio}
            title="Audio-reactive — pulse to the mic (a)"
          >
            {audioOn ? '🎙 Audio ✓' : '🎙 Audio'}
          </button>
          <button className="primary" onClick={doShare} title="Copy share link (s)">
            🔗 Share
          </button>
          <button className="ghost" onClick={() => setShowHelp(true)} title="Help (?)">
            ?
          </button>
        </div>
      </header>

      <div className="stage">
        <div className="canvas-col">
          <div className="canvas-wrap" style={{ background: project.background }}>
            <canvas
              ref={canvasRef}
              width={RENDER}
              height={RENDER}
              className="canvas"
              style={isOrbitable ? { cursor: 'grab', touchAction: 'none' } : undefined}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              onPointerCancel={onCanvasPointerUp}
              onWheel={onCanvasWheel}
            />
          </div>
          <div className="transport">
            {audioOn ? (
              <>
                <button className="play" onClick={toggleAudio} title="Stop audio mode">
                  ⏹
                </button>
                <span className="live-tag">🎙 AUDIO · reactive</span>
                <label className="speed">
                  sensitivity
                  <input
                    type="range"
                    min={0.2}
                    max={3}
                    step={0.1}
                    value={audioGain}
                    onChange={(e) => setAudioGain(parseFloat(e.target.value))}
                  />
                </label>
                <label className="beat-check" title="Re-randomize the whole piece on each detected beat">
                  <input
                    type="checkbox"
                    checked={beatReseed}
                    onChange={(e) => setBeatReseed(e.target.checked)}
                  />
                  beat reseed
                </label>
              </>
            ) : live ? (
              <>
                <button className="play" onClick={toggleLive} title="Stop Live">
                  ⏹
                </button>
                <span className="live-tag">LIVE · evolving</span>
                <label className="speed">
                  evolve
                  <input
                    type="range"
                    min={0.1}
                    max={3}
                    step={0.1}
                    value={liveSpeed}
                    onChange={(e) => setLiveSpeed(parseFloat(e.target.value))}
                  />
                </label>
              </>
            ) : (
              <>
                <button className="play" onClick={togglePlay} disabled={recording}>
                  {playing ? '⏸' : '▶'}
                </button>
                <input
                  className="scrub"
                  type="range"
                  min={0}
                  max={1}
                  step={0.001}
                  value={trace}
                  disabled={recording}
                  onChange={(e) => scrub(parseFloat(e.target.value))}
                />
                <span className="trace-pct">
                  {recording ? 'REC' : `${Math.round(trace * 100)}%`}
                </span>
                <label className="speed">
                  speed
                  <input
                    type="range"
                    min={0.2}
                    max={3}
                    step={0.1}
                    value={speed}
                    onChange={(e) => setSpeed(parseFloat(e.target.value))}
                  />
                </label>
              </>
            )}
          </div>
        </div>

        <aside className="panel">
          <nav className="tabs">
            {(['compose', 'curve', 'style', 'scene', 'save'] as Tab[]).map((t) => (
              <button
                key={t}
                className={tab === t ? 'active' : ''}
                onClick={() => setTab(t)}
              >
                {t === 'compose'
                  ? 'Layers'
                  : t === 'curve'
                    ? 'Curve'
                    : t === 'style'
                      ? 'Color'
                      : t === 'scene'
                        ? 'Scene'
                        : 'Save'}
              </button>
            ))}
          </nav>

          <div className="panel-body">
            {tab === 'compose' && (
              <section className="group">
                <div className="group-title">
                  Layers
                  <button className="mini" onClick={addLayer} title="Add layer (n)">
                    + Add
                  </button>
                </div>
                <LayerList
                  layers={project.layers}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onToggleVisible={(id) =>
                    updateLayer(id, (l) => ({ ...l, visible: !l.visible }))
                  }
                  onMove={moveLayer}
                  onDuplicate={duplicateLayer}
                  onDelete={deleteLayer}
                  onRename={renameLayer}
                />
                <div className="row-buttons">
                  <button onClick={randomizeAll}>🎲 Randomize all</button>
                  <button onClick={() => applyPreset(0)}>↺ Reset</button>
                </div>
                <p className="hint">
                  Double-click a name to rename. Layers draw bottom→top; use Add /
                  Screen blends for glowing overlaps.
                </p>
              </section>
            )}

            {tab === 'curve' && theme && (
              <>
                <section className="group">
                  <div className="group-title">
                    Editing <span className="tag">{theme.name}</span>
                    <button className="mini" onClick={randomizeSelected}>
                      🎲
                    </button>
                  </div>
                  <div className="seg-label">Curve type</div>
                  <Segmented
                    value={theme.kind}
                    options={CURVE_KINDS}
                    onChange={setKind}
                    wrap
                  />
                </section>

                {theme.kind === 'harmonograph' && (
                  <CurveHarmonograph
                    theme={theme}
                    updateParams={updateParams}
                    updatePend={updatePend}
                  />
                )}
                {theme.kind === 'spirograph' && (
                  <CurveSpirograph spiro={theme.spiro ?? defaultSpiro()} update={updateSpiro} />
                )}
                {theme.kind === 'rose' && (
                  <CurveRose rose={theme.rose ?? defaultRose()} update={updateRose} />
                )}
                {theme.kind === 'lissajous' && (
                  <CurveLissajous liss={theme.liss ?? defaultLiss()} update={updateLiss} />
                )}
                {theme.kind === 'superformula' && (
                  <CurveSuperformula sf={theme.sf ?? defaultSf()} update={updateSf} />
                )}
                {theme.kind === 'attractor' && (
                  <CurveAttractor
                    attractor={theme.attractor ?? defaultAttractor()}
                    update={updateAttractor}
                  />
                )}
                {theme.kind === 'attractor3d' && (
                  <CurveAttractor3D a3d={theme.a3d ?? default3D()} update={updateA3d} onResetCamera={resetCamera} />
                )}
                {theme.kind === 'harmonograph3d' && (
                  <CurveHarmonograph3D
                    h3d={theme.h3d ?? default3DHarmonograph()}
                    update={updateH3d}
                    onResetCamera={resetCamera}
                  />
                )}
                {theme.kind === 'lsystem' && (
                  <CurveLSystem lsystem={theme.lsystem ?? defaultLSystem()} update={updateLSystem} />
                )}
                {theme.kind === 'fourier' && (
                  <CurveFourier fourier={theme.fourier ?? defaultFourier()} update={updateFourier} />
                )}

                <section className="group">
                  <div className="group-title">Live evolution</div>
                  <Slider
                    label="Drift rate"
                    value={theme.drift?.rate ?? 1}
                    min={0}
                    max={2.5}
                    step={0.05}
                    onChange={updateDrift}
                    fmt={(v) => (v <= 0 ? 'still' : `${v.toFixed(2)}×`)}
                  />
                  <p className="hint">
                    How fast this layer evolves in <strong>Live</strong> mode (🌀). Set
                    different rates per layer so they drift out of, and back into, phase.
                  </p>
                </section>
              </>
            )}

            {tab === 'style' && theme && (
              <>
                <section className="group">
                  <div className="group-title">Render style</div>
                  <Segmented
                    value={theme.style.renderStyle ?? 'line'}
                    options={RENDER_STYLES}
                    onChange={(v) => updateStyle({ renderStyle: v })}
                  />
                  {(theme.style.renderStyle ?? 'line') === 'density' ? (
                    <>
                      <Slider
                        label="Quality"
                        value={(theme.style.density ?? defaultDensity()).iterations}
                        min={20}
                        max={1500}
                        step={10}
                        onChange={(v) => updateDensity({ iterations: v })}
                        fmt={(v) => `${(v / 1000).toFixed(2)}M pts`}
                      />
                      <Slider
                        label="Exposure"
                        value={(theme.style.density ?? defaultDensity()).exposure}
                        min={0.1}
                        max={6}
                        step={0.05}
                        onChange={(v) => updateDensity({ exposure: v })}
                        fmt={(v) => `${v.toFixed(2)}×`}
                      />
                      <Slider
                        label="Tone (gamma)"
                        value={(theme.style.density ?? defaultDensity()).gamma}
                        min={0.2}
                        max={1.6}
                        step={0.02}
                        onChange={(v) => updateDensity({ gamma: v })}
                        fmt={(v) => v.toFixed(2)}
                      />
                      <p className="hint">
                        Millions of orbit points splatted into a glowing histogram,
                        tone-mapped through the palette. Lower <em>tone</em> reveals faint
                        filaments; higher <em>exposure</em> brightens. Pairs beautifully
                        with the <strong>Attractor</strong> curve type and an{' '}
                        <em>Add</em> blend.
                      </p>
                    </>
                  ) : (
                    <p className="hint">
                      Draws the curve as a connected stroke. Switch to{' '}
                      <strong>Density</strong> for luminous attractor nebulae.
                    </p>
                  )}
                </section>

                <section className="group">
                  <div className="group-title">Palette</div>
                  <div className="palette-grid">
                    {PALETTES.map((p) => (
                      <button
                        key={p.id}
                        className="palette-swatch"
                        title={p.name}
                        style={{
                          background: `linear-gradient(90deg, ${p.colors.join(', ')})`,
                        }}
                        onClick={() => updateStyle({ colors: [...p.colors] })}
                      />
                    ))}
                  </div>
                  <div className="color-editor">
                    {theme.style.colors.map((c, i) => (
                      <div className="color-cell" key={i}>
                        <input
                          type="color"
                          value={c}
                          onChange={(e) => setColor(i, e.target.value)}
                        />
                        <button
                          className="x"
                          onClick={() => removeColor(i)}
                          disabled={theme.style.colors.length <= 1}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    <button className="add-color" onClick={addColor}>
                      +
                    </button>
                  </div>
                </section>

                <section className="group">
                  <div className="group-title">Color along</div>
                  <Segmented
                    value={theme.style.colorMode}
                    options={COLOR_MODES}
                    onChange={(v) => updateStyle({ colorMode: v })}
                  />
                </section>

                <section className="group">
                  <div className="group-title">Stroke</div>
                  <Slider
                    label="Line width"
                    value={theme.style.lineWidth}
                    min={0.3}
                    max={5}
                    step={0.1}
                    onChange={(v) => updateStyle({ lineWidth: v })}
                    fmt={(v) => v.toFixed(1)}
                  />
                  <Segmented
                    value={theme.style.widthMode}
                    options={WIDTH_MODES}
                    onChange={(v) => updateStyle({ widthMode: v })}
                  />
                  <Slider
                    label="Glow"
                    value={theme.style.glow}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(v) => updateStyle({ glow: v })}
                  />
                  <Slider
                    label="Opacity"
                    value={theme.style.opacity}
                    min={0.05}
                    max={1}
                    step={0.01}
                    onChange={(v) => updateStyle({ opacity: v })}
                  />
                </section>

                <section className="group">
                  <div className="group-title">Blend</div>
                  <Segmented
                    value={theme.style.blend}
                    options={BLEND_MODES}
                    onChange={(v) => updateStyle({ blend: v })}
                  />
                </section>

                <section className="group">
                  <div className="group-title">Kaleidoscope</div>
                  <Slider
                    label="Symmetry"
                    value={theme.style.symmetry ?? 1}
                    min={1}
                    max={12}
                    step={1}
                    onChange={(v) => updateStyle({ symmetry: v })}
                    fmt={(v) => (v <= 1 ? 'off' : `${v.toFixed(0)}×`)}
                  />
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={theme.style.mirror ?? false}
                      onChange={(e) => updateStyle({ mirror: e.target.checked })}
                    />
                    Mirror each wedge
                  </label>
                </section>
              </>
            )}

            {tab === 'scene' && (
              <>
                <section className="group">
                  <div className="group-title">Background</div>
                  <div className="bg-grid">
                    {BACKGROUNDS.map((b) => (
                      <button
                        key={b.id}
                        className={`bg-swatch ${project.background === b.color ? 'active' : ''}`}
                        title={b.name}
                        style={{ background: b.color }}
                        onClick={() => setProject((p) => ({ ...p, background: b.color }))}
                      />
                    ))}
                    <input
                      className="bg-custom"
                      type="color"
                      value={project.background}
                      onChange={(e) =>
                        setProject((p) => ({ ...p, background: e.target.value }))
                      }
                      title="Custom background"
                    />
                  </div>
                  <div className="seg-label">Fill</div>
                  <Segmented
                    value={project.bgMode ?? 'solid'}
                    options={BG_MODES}
                    onChange={(v) => setProject((p) => ({ ...p, bgMode: v }))}
                  />
                  {(project.bgMode ?? 'solid') !== 'solid' && (
                    <label className="check" style={{ marginTop: 8 }}>
                      <input
                        type="color"
                        value={project.bg2 ?? '#000000'}
                        onChange={(e) => setProject((p) => ({ ...p, bg2: e.target.value }))}
                      />
                      Gradient end color
                    </label>
                  )}
                  <Slider
                    label="Vignette"
                    value={project.vignette}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(v) => setProject((p) => ({ ...p, vignette: v }))}
                  />
                </section>

                <section className="group">
                  <div className="group-title">Stereoscopic 3D</div>
                  <Segmented
                    value={project.stereo ?? 'off'}
                    options={STEREO_MODES}
                    onChange={(v) => setProject((p) => ({ ...p, stereo: v }))}
                    wrap
                  />
                  {(project.stereo ?? 'off') !== 'off' && (
                    <Slider
                      label="Eye separation"
                      value={project.stereoBaseline ?? 0.08}
                      min={0.01}
                      max={0.3}
                      step={0.005}
                      onChange={(v) => setProject((p) => ({ ...p, stereoBaseline: v }))}
                      fmt={(v) => v.toFixed(3)}
                    />
                  )}
                  <p className="hint">
                    {scene3dCount > 0 ? (
                      <>
                        Renders the scene from two eye viewpoints for genuine depth.{' '}
                        <strong>Anaglyph</strong> needs red-cyan glasses;{' '}
                        <strong>side-by-side</strong> suits a cardboard/VR viewer;{' '}
                        <strong>cross-eye</strong> is for free-viewing. Bigger eye
                        separation = stronger depth (and more ghosting).
                      </>
                    ) : (
                      <>Add a <strong>3D Attractor</strong> or <strong>3D Harmonograph</strong> layer to use stereoscopy.</>
                    )}
                  </p>
                </section>

                <section className="group">
                  <div className="group-title">Presets</div>
                  <div className="preset-grid">
                    {PRESETS.map((p, i) => (
                      <button key={p.name} className="preset" onClick={() => applyPreset(i)}>
                        {p.name}
                      </button>
                    ))}
                  </div>
                </section>
              </>
            )}

            {tab === 'save' && (
              <>
                <section className="group">
                  <div className="group-title">Export</div>
                  <div className="seg-label">Resolution</div>
                  <Segmented
                    value={String(exportScale)}
                    options={[
                      { value: '1', label: `1× (${RENDER})` },
                      { value: '2', label: `2× (${RENDER * 2})` },
                      { value: '4', label: `4× (${RENDER * 4})` },
                    ]}
                    onChange={(v) => setExportScale(parseInt(v, 10))}
                  />
                  <div className="row-buttons">
                    <button onClick={downloadPng}>⬇ PNG</button>
                    <button onClick={downloadSvg}>⬇ SVG</button>
                  </div>
                  <button className="wide" onClick={downloadGif} disabled={gifBusy || recording}>
                    {gifBusy
                      ? '● Rendering GIF…'
                      : live
                        ? '🖼 Export looping GIF (evolution)'
                        : '🖼 Export animated GIF (drawing pass)'}
                  </button>
                  <button className="wide" onClick={recordVideo} disabled={recording || gifBusy}>
                    {recording
                      ? '● Recording…'
                      : live
                        ? '🎬 Record looping WebM (evolution)'
                        : '🎬 Record WebM (drawing pass)'}
                  </button>
                  <p className="hint">
                    Tip: turn on <strong>🌀 Live</strong> first and these capture a{' '}
                    <em>seamless loop</em> of the figure evolving, instead of the drawing pass.
                  </p>
                  <button className="wide" onClick={doShare}>
                    🔗 Copy share link
                  </button>
                </section>

                <section className="group">
                  <div className="group-title">Gallery</div>
                  <div className="save-row">
                    <input
                      type="text"
                      placeholder="Name this piece…"
                      value={galleryName}
                      onChange={(e) => setGalleryName(e.target.value)}
                    />
                    <button onClick={saveCurrent}>Save</button>
                  </div>
                  {gallery.length === 0 ? (
                    <p className="hint">
                      Saved pieces live in your browser. Save one to build a
                      personal gallery.
                    </p>
                  ) : (
                    <div className="gallery-grid">
                      {gallery.map((item) => (
                        <div className="gallery-item" key={item.id}>
                          <button
                            className="gallery-thumb"
                            onClick={() => loadFromGallery(item)}
                            title={`Load “${item.name}”`}
                          >
                            {item.thumb ? (
                              <img src={item.thumb} alt={item.name} />
                            ) : (
                              <span>{item.name}</span>
                            )}
                          </button>
                          <div className="gallery-meta">
                            <span>{item.name}</span>
                            <button onClick={() => removeFromGallery(item.id)}>✕</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}
          </div>
        </aside>
      </div>

      {toast && <div className="toast">{toast}</div>}

      {showHelp && (
        <div className="modal-backdrop" onClick={() => setShowHelp(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Harmonograph Lab</h2>
              <button onClick={() => setShowHelp(false)}>✕</button>
            </div>
            <p>
              A harmonograph is a Victorian drawing machine: damped pendulums swing
              against each other and a pen traces their interference. Two pendulums
              drive <strong>X</strong>, two drive <strong>Y</strong>, and an optional{' '}
              <strong>rotary</strong> frame slowly turns the paper. Frequencies near
              small whole-number ratios make the most coherent figures.
            </p>
            <p className="hint">
              Build a piece by stacking <strong>layers</strong>, and pick each layer's{' '}
              <strong>curve type</strong> in the Curve tab: a harmonograph, a{' '}
              <strong>spirograph</strong> (hypo/epitrochoid), a <strong>rose</strong>,
              a <strong>Lissajous</strong> figure, the wildly versatile{' '}
              <strong>superformula</strong>, a chaotic{' '}
              <strong>strange attractor</strong> (de Jong, Clifford, Svensson, Dream,
              Hopalong, Gumowski–Mira, Bedhead, Tinkerbell), a real{' '}
              <strong>3D strange attractor</strong> (fourteen real flows — Lorenz, Rössler,
              Aizawa, Thomas, Halvorsen, Chen, Dadras, Sprott, Lorenz-84, Sprott-B,
              Nosé–Hoover, Rikitake, Chen–Lee, Burke–Shaw) or a{' '}
              <strong>3D harmonograph</strong> (a spatial pendulum tracing a knotted
              3-D Lissajous figure) — flown through an orbit camera you{' '}
              <strong>drag to rotate and scroll/pinch to zoom</strong> — or an{' '}
              <strong>L-system</strong> fractal — both classic single-stroke curves
              (dragon, Koch, Hilbert, Gosper…) and <strong>branching plants &amp; trees</strong>.
              In the Color tab, switch any layer to the <strong>Density</strong> render
              style to splat millions of points into a glowing nebula — the way strange
              attractors are meant to be seen — with optional <strong>depth fog</strong> for
              real front-to-back volume. Render any 3-D scene in{' '}
              <strong>stereoscopic 3D</strong> (Scene tab): a red-cyan <strong>anaglyph</strong>,
              or a side-by-side / cross-eye pair. Use <em>Add</em> / <em>Screen</em> blends with
              glow for luminous overlaps, color along path / speed / curvature / direction,
              and turn up <strong>kaleidoscope symmetry</strong> for mandalas.
              Hit <strong>Animate</strong> to watch the pen draw, <strong>Live</strong> to
              let the figure slowly evolve (per-layer <em>drift rate</em>), and{' '}
              <strong>🎙 Audio</strong> to pulse glow and stroke to your microphone — tick{' '}
              <em>beat reseed</em> to re-roll the whole piece on every beat. Export a{' '}
              <strong>seamless looping GIF/WebM</strong> of the evolution (turn on Live first),
              an animated drawing-pass GIF, or a high-res <strong>PNG/SVG</strong>.
              Everything lives in the URL, so the <strong>Share</strong> link reproduces
              your exact piece.
            </p>
            <div className="shortcuts">
              <div><kbd>G</kbd> generate a piece</div>
              <div><kbd>Space</kbd> play / pause</div>
              <div><kbd>L</kbd> live evolve</div>
              <div><kbd>A</kbd> audio-reactive</div>
              <div><kbd>R</kbd> randomize layer</div>
              <div><kbd>N</kbd> new layer</div>
              <div><kbd>E</kbd> export PNG</div>
              <div><kbd>I</kbd> export GIF</div>
              <div><kbd>S</kbd> copy share link</div>
              <div><kbd>?</kbd> this help</div>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
