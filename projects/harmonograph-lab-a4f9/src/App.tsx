import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  cloneParams,
  defaultStyle,
  getLayerData,
  makeId,
  makeLayer,
  randomParams,
  type LayerData,
} from './harmonograph'
import { BACKGROUNDS, PALETTES, randomPalette } from './palettes'
import { PRESETS, loadPreset } from './presets'
import { generateProject } from './generate'
import { drawProject, toSvg } from './render'
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
  BlendMode,
  ColorMode,
  Layer,
  Project,
  WidthMode,
} from './types'
import { Slider } from './components/Slider'
import { Segmented } from './components/Segmented'
import { LayerList } from './components/LayerList'

const RENDER = 1100 // canvas backing resolution (square)

type Tab = 'compose' | 'curve' | 'style' | 'scene' | 'save'
type PendKey = 'x1' | 'x2' | 'y1' | 'y2'
const PEND_KEYS: PendKey[] = ['x1', 'x2', 'y1', 'y2']

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

function initialProject(): Project {
  return readHashProject() ?? loadPreset(PRESETS[0])
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
  const [exportScale, setExportScale] = useState(2)
  const [gallery, setGallery] = useState<GalleryItem[]>(() => loadGallery())
  const [galleryName, setGalleryName] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [showHelp, setShowHelp] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const traceRef = useRef(1)

  // Build render data per layer. `getLayerData` caches by params identity, so a
  // style edit (which keeps the params object) is essentially free here.
  const datas = useMemo(() => {
    const map = new Map<string, LayerData>()
    for (const layer of project.layers) {
      map.set(layer.id, getLayerData(layer.params))
    }
    return map
  }, [project.layers])

  const selected = useMemo(
    () => project.layers.find((l) => l.id === selectedId) ?? project.layers[0],
    [project.layers, selectedId],
  )

  // Draw.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    drawProject(ctx, project, datas, RENDER, { trace })
  }, [project, datas, trace])

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
        params: cloneParams(src.params),
        style: { ...src.style, colors: [...src.style.colors] },
      }
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
    updateLayer(selected.id, (l) => ({ ...l, params: randomParams() }))
  }, [selected, updateLayer])

  const randomizeAll = () => {
    setLayers((ls) =>
      ls.map((l) => ({
        ...l,
        params: randomParams(),
        style: { ...l.style, colors: randomPalette().colors },
      })),
    )
  }

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
      drawProject(ctx, project, datas, size, { trace: 1 })
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

  const togglePlay = useCallback(() => {
    if (!playing && traceRef.current >= 1) {
      traceRef.current = 0
      setTrace(0)
    }
    setPlaying((p) => !p)
  }, [playing])
  const scrub = (v: number) => {
    setPlaying(false)
    traceRef.current = v
    setTrace(v)
  }

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
  }, [generate, randomizeSelected, togglePlay, addLayer, doShare, downloadPng])

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
            <canvas ref={canvasRef} width={RENDER} height={RENDER} className="canvas" />
          </div>
          <div className="transport">
            <button className="play" onClick={togglePlay}>
              {playing ? '⏸' : '▶'}
            </button>
            <input
              className="scrub"
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={trace}
              onChange={(e) => scrub(parseFloat(e.target.value))}
            />
            <span className="trace-pct">{Math.round(trace * 100)}%</span>
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
                  <Slider
                    label="Trace length"
                    value={theme.params.duration}
                    min={40}
                    max={420}
                    step={1}
                    onChange={(v) => updateParams({ duration: v })}
                    fmt={(v) => v.toFixed(0)}
                  />
                </section>

                {PEND_KEYS.map((key) => (
                  <section className="group" key={key}>
                    <div className="group-title">
                      Pendulum <span className="tag">{key.toUpperCase()}</span>
                    </div>
                    <Slider
                      label="Frequency"
                      value={theme.params[key].freq}
                      min={0.5}
                      max={8}
                      step={0.001}
                      onChange={(v) => updatePend(key, 'freq', v)}
                    />
                    <Slider
                      label="Phase"
                      value={theme.params[key].phase}
                      min={0}
                      max={Math.PI * 2}
                      step={0.01}
                      onChange={(v) => updatePend(key, 'phase', v)}
                      fmt={(v) => `${((v / Math.PI) * 180).toFixed(0)}°`}
                    />
                    <Slider
                      label="Amplitude"
                      value={theme.params[key].amp}
                      min={0}
                      max={1}
                      step={0.01}
                      onChange={(v) => updatePend(key, 'amp', v)}
                    />
                    <Slider
                      label="Damping"
                      value={theme.params[key].damp}
                      min={0}
                      max={0.05}
                      step={0.0005}
                      onChange={(v) => updatePend(key, 'damp', v)}
                      fmt={(v) => v.toFixed(4)}
                    />
                  </section>
                ))}

                <section className="group">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={theme.params.rotary.enabled}
                      onChange={(e) =>
                        updateParams({
                          rotary: { ...theme.params.rotary, enabled: e.target.checked },
                        })
                      }
                    />
                    Rotary frame (rotating paper)
                  </label>
                  {theme.params.rotary.enabled && (
                    <>
                      <Slider
                        label="Rot. frequency"
                        value={theme.params.rotary.freq}
                        min={0.2}
                        max={6}
                        step={0.001}
                        onChange={(v) =>
                          updateParams({ rotary: { ...theme.params.rotary, freq: v } })
                        }
                      />
                      <Slider
                        label="Rot. amplitude"
                        value={theme.params.rotary.amp}
                        min={0}
                        max={3}
                        step={0.01}
                        onChange={(v) =>
                          updateParams({ rotary: { ...theme.params.rotary, amp: v } })
                        }
                      />
                      <Slider
                        label="Rot. phase"
                        value={theme.params.rotary.phase}
                        min={0}
                        max={Math.PI * 2}
                        step={0.01}
                        onChange={(v) =>
                          updateParams({ rotary: { ...theme.params.rotary, phase: v } })
                        }
                        fmt={(v) => `${((v / Math.PI) * 180).toFixed(0)}°`}
                      />
                      <Slider
                        label="Rot. damping"
                        value={theme.params.rotary.damp}
                        min={0}
                        max={0.03}
                        step={0.0005}
                        onChange={(v) =>
                          updateParams({ rotary: { ...theme.params.rotary, damp: v } })
                        }
                        fmt={(v) => v.toFixed(4)}
                      />
                    </>
                  )}
                </section>
              </>
            )}

            {tab === 'style' && theme && (
              <>
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
              Build a piece by stacking <strong>layers</strong> — each its own curve,
              palette and blend. Use <em>Add</em> / <em>Screen</em> blends with glow
              for luminous overlaps, color along path / speed / curvature / direction,
              and turn up <strong>kaleidoscope symmetry</strong> for mandalas. Hit
              Animate to watch the pen draw. Everything lives in the URL, so the{' '}
              <strong>Share</strong> link reproduces your exact piece.
            </p>
            <div className="shortcuts">
              <div><kbd>G</kbd> generate a piece</div>
              <div><kbd>Space</kbd> play / pause</div>
              <div><kbd>R</kbd> randomize layer</div>
              <div><kbd>N</kbd> new layer</div>
              <div><kbd>E</kbd> export PNG</div>
              <div><kbd>S</kbd> copy share link</div>
              <div><kbd>?</kbd> this help</div>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
