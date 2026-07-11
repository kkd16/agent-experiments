import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  solveFrame,
  type FrameModel,
  type FrameResult,
  type SupportKind,
} from './engine/frame'
import { solveContinuum, type ContinuumInput, type ContinuumResult } from './engine/continuum'
import {
  solveModal,
  solveBuckling,
  solveTransient,
  evalTransient,
  type ModalResult,
  type BucklingResult,
  type TransientResult,
} from './engine/dynamics'
import type { NodeDisp } from './engine/frame'
import { PRESETS, type ContinuumPreset, type FramePreset } from './engine/presets'
import { drawFrame, drawContinuum, type Picked } from './ui/draw'
import { fitView, screenToWorld, worldToScreen, zoomAt, pan, type View, type Bounds } from './ui/viewport'
import { Legend, Segmented, Slider, StatTile, Toggle, VerifyBadge } from './ui/components'
import { fmtEng } from './ui/format'
import {
  addMember,
  addNode,
  cycleSupport,
  deleteMember,
  deleteNode,
  getLoad,
  moveNode,
  pickMember,
  pickNode,
  setLoad,
  setSupport,
} from './edit'
import {
  cloneFrame,
  downloadJSON,
  loadLocal,
  readHash,
  saveLocal,
  writeHash,
  type Display,
  type FrameAnalysis,
  type Scene,
} from './state'

type Tab = 'frame' | 'continuum'
type Tool = 'select' | 'node' | 'member' | 'support' | 'load' | 'delete'

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'select', label: '⤢ Select', hint: 'Select & drag nodes; pan on empty space' },
  { id: 'node', label: '• Node', hint: 'Click to place a new joint' },
  { id: 'member', label: '／ Member', hint: 'Click two joints to connect them' },
  { id: 'support', label: '⊿ Support', hint: 'Click a joint to cycle its support' },
  { id: 'load', label: '↓ Load', hint: 'Click a joint to add −10 kN (edit exact value at right)' },
  { id: 'delete', label: '✕ Delete', hint: 'Click a joint or member to remove it' },
]

const SUPPORTS: SupportKind[] = ['free', 'pin', 'roller-x', 'roller-y', 'fixed']

const DEFAULT_DISPLAY: Display = {
  deformScale: 1,
  autoDeform: true,
  colorBy: 'force',
  field: 'vm',
  colormap: 'turbo',
  showUndeformed: true,
  showLoads: true,
  showReactions: true,
  showLabels: false,
  showMesh: true,
  analysis: 'static',
  respZeta: 0.03,
}

function frameBounds(m: FrameModel): Bounds {
  const xs = m.nodes.map((n) => n.x)
  const ys = m.nodes.map((n) => n.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}
function meshBounds(inp: ContinuumInput): Bounds {
  return { minX: inp.mesh.minX, maxX: inp.mesh.maxX, minY: inp.mesh.minY, maxY: inp.mesh.maxY }
}
function boundsDiag(b: Bounds): number {
  return Math.hypot(b.maxX - b.minX, b.maxY - b.minY) || 1
}
const snap = (v: number, g = 0.5) => Math.round(v / g) * g

function safeSolveFrame(m: FrameModel): FrameResult | null {
  try {
    return solveFrame(m)
  } catch {
    return null
  }
}
function safeSolveContinuum(inp: ContinuumInput): ContinuumResult | null {
  try {
    return solveContinuum(inp)
  } catch {
    return null
  }
}
function safeSolveModal(m: FrameModel): ModalResult | null {
  try {
    return solveModal(m)
  } catch {
    return null
  }
}
function safeSolveBuckling(m: FrameModel): BucklingResult | null {
  try {
    return solveBuckling(m)
  } catch {
    return null
  }
}
function safeSolveTransient(m: FrameModel): TransientResult | null {
  try {
    return solveTransient(m)
  } catch {
    return null
  }
}

const WARREN = (PRESETS.find((p) => p.id === 'warren') as FramePreset).model

export default function App() {
  const initial = useMemo<Scene | null>(() => readHash() ?? loadLocal(), [])
  const [tab, setTab] = useState<Tab>(initial?.tab ?? 'frame')
  const [frame, setFrame] = useState<FrameModel>(() => cloneFrame(initial?.frame ?? WARREN))
  const [contId, setContId] = useState(initial?.continuum.presetId ?? 'c-hole')
  const [density, setDensity] = useState(initial?.continuum.density ?? 1)
  const [display, setDisplay] = useState<Display>(initial?.display ?? DEFAULT_DISPLAY)

  const analysis: FrameAnalysis = display.analysis ?? 'static'
  const [modeIndex, setModeIndex] = useState(0)
  const [modeT, setModeT] = useState(0)
  const [respPlaying, setRespPlaying] = useState(true)
  const [respShape, setRespShape] = useState<NodeDisp[] | null>(null)
  const [respElapsed, setRespElapsed] = useState(0)
  const respTimeRef = useRef(0)
  const respZeta = display.respZeta ?? 0.03

  const [tool, setTool] = useState<Tool>('select')
  const [sel, setSel] = useState<Picked | null>(null)
  const [hover, setHover] = useState<Picked | null>(null)
  const [pendingNode, setPendingNode] = useState<number | null>(null)
  const [loadFactor, setLoadFactor] = useState(1)
  const [view, setView] = useState<View | null>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // --- solved results -------------------------------------------------------
  const frameResult = useMemo(() => (tab === 'frame' ? safeSolveFrame(frame) : null), [tab, frame])
  const contPreset = useMemo(
    () => PRESETS.find((p) => p.id === contId) as ContinuumPreset,
    [contId],
  )
  const contInput = useMemo(
    () => (tab === 'continuum' ? contPreset.make(density) : null),
    [tab, contPreset, density],
  )
  const contResult = useMemo(
    () => (contInput ? safeSolveContinuum(contInput) : null),
    [contInput],
  )

  // --- eigen-analysis results (modal / buckling) ---------------------------
  const modalResult = useMemo(
    () => (tab === 'frame' && analysis === 'modal' ? safeSolveModal(frame) : null),
    [tab, analysis, frame],
  )
  const bucklingResult = useMemo(
    () => (tab === 'frame' && analysis === 'buckling' ? safeSolveBuckling(frame) : null),
    [tab, analysis, frame],
  )
  const transientResult = useMemo(
    () => (tab === 'frame' && analysis === 'response' ? safeSolveTransient(frame) : null),
    [tab, analysis, frame],
  )
  const activeEigen = analysis === 'modal' ? modalResult : analysis === 'buckling' ? bucklingResult : null
  const modeCount = activeEigen?.modes.length ?? 0
  const effModeIndex = modeCount > 0 ? Math.min(modeIndex, modeCount - 1) : 0
  const selMode = activeEigen?.modes[effModeIndex] ?? null
  const modeScale = useMemo(() => 0.16 * boundsDiag(frameBounds(frame)), [frame])

  // The shape drawn on the canvas: a swinging eigenmode (modal/buckling) or the
  // live transient response.
  const isSwing = tab === 'frame' && (analysis === 'modal' || analysis === 'buckling') && !!selMode
  const drawShape: NodeDisp[] | null =
    analysis === 'response' ? respShape : isSwing ? selMode!.shape : null
  const drawFactor = analysis === 'response' ? 1 : modeT
  const isMode = tab === 'frame' && analysis !== 'static' && !!drawShape

  // Sinusoidally swing a mode shape (modal/buckling views).
  useEffect(() => {
    if (!isSwing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setModeT(0)
      return
    }
    let raf = 0
    let t0 = 0
    const loop = (t: number) => {
      if (!t0) t0 = t
      setModeT(Math.sin(((t - t0) / 1000) * 2 * Math.PI * 0.5))
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [isSwing, analysis, effModeIndex])

  // Seed the transient shape at t=0 whenever the model / result changes.
  useEffect(() => {
    respTimeRef.current = 0
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRespElapsed(0)
    setRespShape(transientResult?.ok ? evalTransient(transientResult, respZeta, 0) : null)
    // respZeta intentionally excluded — at t=0 the shape is damping-independent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transientResult])

  // Advance the modal-superposition response in real (scaled) time.
  useEffect(() => {
    if (!(tab === 'frame' && analysis === 'response' && transientResult?.ok && respPlaying)) return
    const timeScale = Math.max(0.05, Math.min(2, 1.5 / Math.max(transientResult.dominantHz, 0.5)))
    let raf = 0
    let last = 0
    const loop = (ts: number) => {
      if (!last) last = ts
      const dt = Math.min(0.05, (ts - last) / 1000)
      last = ts
      respTimeRef.current += dt * timeScale
      const t = respTimeRef.current
      setRespShape(evalTransient(transientResult, respZeta, t))
      setRespElapsed(t)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [tab, analysis, transientResult, respPlaying, respZeta])

  const restartResponse = useCallback(() => {
    respTimeRef.current = 0
    setRespElapsed(0)
    if (transientResult?.ok) setRespShape(evalTransient(transientResult, respZeta, 0))
  }, [transientResult, respZeta])

  // --- auto deformation scale ----------------------------------------------
  const autoScale = useMemo(() => {
    if (tab === 'frame' && frameResult && frameResult.maxDisp > 0) {
      return (0.12 * boundsDiag(frameBounds(frame))) / frameResult.maxDisp
    }
    if (tab === 'continuum' && contResult && contInput && contResult.maxDisp > 0) {
      return (0.1 * boundsDiag(meshBounds(contInput))) / contResult.maxDisp
    }
    return 1
  }, [tab, frameResult, contResult, frame, contInput])
  const effectiveDeform = (display.autoDeform ? autoScale : 1) * display.deformScale

  // --- fit view when the model changes -------------------------------------
  const currentBounds = useMemo<Bounds>(() => {
    if (tab === 'frame') return frameBounds(frame)
    return contInput ? meshBounds(contInput) : { minX: 0, maxX: 1, minY: 0, maxY: 1 }
  }, [tab, frame, contInput])

  const fitToModel = useCallback(() => {
    setView(fitView(currentBounds, size.w, size.h))
  }, [currentBounds, size])

  // Re-fit on tab / preset switch and first sizing.
  const fitKey = tab === 'frame' ? 'frame' : `cont:${contId}`
  const lastFitKey = useRef('')
  useEffect(() => {
    if (view === null || lastFitKey.current !== fitKey) {
      if (size.w > 0) {
        // Syncing the camera to the canvas/model size — a legitimate external sync.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setView(fitView(currentBounds, size.w, size.h))
        lastFitKey.current = fitKey
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, size.w, size.h])

  // --- canvas sizing --------------------------------------------------------
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      setSize({ w: Math.max(1, r.width), h: Math.max(1, r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // --- persistence ----------------------------------------------------------
  useEffect(() => {
    const scene: Scene = {
      version: 1,
      tab,
      frame,
      continuum: { presetId: contId, density },
      display,
    }
    saveLocal(scene)
    writeHash(scene)
  }, [tab, frame, contId, density, display])

  // --- draw -----------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !view) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = size.w * dpr
    canvas.height = size.h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (tab === 'frame') {
      drawFrame(ctx, size.w, size.h, frame, isMode ? null : frameResult, {
        view,
        deformScale: isMode ? modeScale : effectiveDeform,
        loadFactor: isMode ? drawFactor : loadFactor,
        showUndeformed: display.showUndeformed,
        colorBy: display.colorBy,
        colormap: display.colormap,
        showLoads: display.showLoads,
        showReactions: display.showReactions,
        showLabels: display.showLabels,
        hover,
        selected: sel,
        editing: tool !== 'select',
        pendingNode,
        modeShape: isMode ? drawShape : null,
      })
    } else if (contInput) {
      drawContinuum(ctx, size.w, size.h, contInput.mesh, contResult, {
        view,
        deformScale: effectiveDeform,
        loadFactor,
        showMesh: display.showMesh,
        showUndeformed: display.showUndeformed,
        colormap: display.colormap,
        field: display.field,
        tractionEdge: contInput.traction?.edge,
        tractionDir: contInput.traction,
        fixedEdges: contInput.fix.map((f) => f.edge).filter((e): e is NonNullable<typeof e> => !!e),
      })
    }
  }, [
    view, size, tab, frame, frameResult, contInput, contResult, display, hover, sel, tool,
    pendingNode, loadFactor, effectiveDeform, isMode, modeScale, drawShape, drawFactor,
  ])

  // --- pointer interaction --------------------------------------------------
  const drag = useRef<{ mode: 'pan' | 'node'; nodeIdx?: number; lastX: number; lastY: number } | null>(
    null,
  )
  const toScreen = useCallback(
    (x: number, y: number): [number, number] => (view ? worldToScreen(view, x, y) : [0, 0]),
    [view],
  )

  const localXY = (e: React.PointerEvent | React.WheelEvent): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!view) return
    canvasRef.current?.setPointerCapture(e.pointerId)
    const [sx, sy] = localXY(e)
    if (tab === 'continuum') {
      drag.current = { mode: 'pan', lastX: sx, lastY: sy }
      return
    }
    const [wx, wy] = screenToWorld(view, sx, sy)
    const nHit = pickNode(frame, toScreen, sx, sy)
    const mHit = nHit === null ? pickMember(frame, toScreen, sx, sy) : null

    // In modal/buckling view the model is read-only — select for inspection, pan.
    if (analysis !== 'static') {
      setSel(nHit !== null ? { type: 'node', index: nHit } : mHit !== null ? { type: 'member', index: mHit } : null)
      drag.current = { mode: 'pan', lastX: sx, lastY: sy }
      return
    }

    switch (tool) {
      case 'select':
        if (nHit !== null) {
          setSel({ type: 'node', index: nHit })
          drag.current = { mode: 'node', nodeIdx: nHit, lastX: sx, lastY: sy }
        } else {
          setSel(mHit !== null ? { type: 'member', index: mHit } : null)
          drag.current = { mode: 'pan', lastX: sx, lastY: sy }
        }
        break
      case 'node': {
        const nm = addNode(frame, snap(wx), snap(wy))
        setFrame(nm)
        setSel({ type: 'node', index: nm.nodes.length - 1 })
        break
      }
      case 'member':
        if (nHit !== null) {
          if (pendingNode === null) setPendingNode(nHit)
          else {
            setFrame(addMember(frame, pendingNode, nHit))
            setPendingNode(null)
          }
        }
        break
      case 'support':
        if (nHit !== null) setFrame(cycleSupport(frame, nHit))
        break
      case 'load':
        if (nHit !== null) {
          const l = getLoad(frame, nHit)
          setFrame(setLoad(frame, nHit, l.fx, l.fy - 10000, l.mz))
          setSel({ type: 'node', index: nHit })
        }
        break
      case 'delete':
        if (nHit !== null) {
          setFrame(deleteNode(frame, nHit))
          setSel(null)
        } else if (mHit !== null) {
          setFrame(deleteMember(frame, mHit))
          setSel(null)
        }
        break
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!view) return
    const [sx, sy] = localXY(e)
    const d = drag.current
    if (d) {
      if (d.mode === 'pan') {
        setView((v) => (v ? pan(v, sx - d.lastX, sy - d.lastY) : v))
      } else if (d.mode === 'node' && d.nodeIdx !== undefined) {
        const [wx, wy] = screenToWorld(view, sx, sy)
        setFrame((f) => moveNode(f, d.nodeIdx!, snap(wx, 0.25), snap(wy, 0.25)))
      }
      d.lastX = sx
      d.lastY = sy
      return
    }
    if (tab === 'frame') {
      const nHit = pickNode(frame, toScreen, sx, sy)
      const mHit = nHit === null ? pickMember(frame, toScreen, sx, sy) : null
      setHover(nHit !== null ? { type: 'node', index: nHit } : mHit !== null ? { type: 'member', index: mHit } : null)
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    canvasRef.current?.releasePointerCapture(e.pointerId)
    drag.current = null
  }

  const onWheel = (e: React.WheelEvent) => {
    if (!view) return
    const [sx, sy] = localXY(e)
    const factor = Math.exp(-e.deltaY * 0.0015)
    setView(zoomAt(view, sx, sy, factor))
  }

  // --- load-factor animation ------------------------------------------------
  const animate = () => {
    setLoadFactor(0)
    const t0 = performance.now()
    const dur = 1100
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / dur)
      const eased = 1 - Math.pow(1 - k, 3)
      setLoadFactor(eased)
      if (k < 1) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  const loadPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id)
    if (!p) return
    setSel(null)
    setPendingNode(null)
    setHover(null)
    if (p.kind === 'frame') {
      setTab('frame')
      setFrame(cloneFrame(p.model))
      lastFitKey.current = '' // force refit
    } else {
      setTab('continuum')
      setContId(id)
    }
    setLoadFactor(1)
  }

  const patchDisplay = (patch: Partial<Display>) => setDisplay((d) => ({ ...d, ...patch }))

  // --- selected-element editors --------------------------------------------
  const updateMember = (i: number, patch: Partial<FrameModel['members'][number]>) => {
    setFrame((f) => {
      const next = cloneFrame(f)
      next.members[i] = { ...next.members[i], ...patch }
      return next
    })
  }

  const framePresets = PRESETS.filter((p): p is FramePreset => p.kind === 'frame')
  const contPresets = PRESETS.filter((p): p is ContinuumPreset => p.kind === 'continuum')

  const activeTool = TOOLS.find((t) => t.id === tool)!

  return (
    <div className="studio">
      <header className="topbar">
        <div className="brand">
          <span className="logo">▚</span>
          <div>
            <div className="title">Keystone</div>
            <div className="subtitle">structural finite-element studio</div>
          </div>
        </div>
        <div className="tabs">
          <Segmented<Tab>
            options={[
              { value: 'frame', label: 'Trusses & Frames' },
              { value: 'continuum', label: '2-D Continuum' },
            ]}
            value={tab}
            onChange={(v) => {
              setTab(v)
              setSel(null)
            }}
          />
        </div>
        <VerifyBadge />
      </header>

      <div className="body">
        {/* ---------------- left rail: presets ---------------- */}
        <aside className="rail left">
          <div className="panel">
            <div className="panel-title">Model library</div>
            <div className="preset-group">Trusses &amp; frames</div>
            {framePresets.map((p) => (
              <button key={p.id} className="preset" onClick={() => loadPreset(p.id)}>
                <div className="preset-name">{p.name}</div>
                <div className="preset-blurb">{p.blurb}</div>
              </button>
            ))}
            <div className="preset-group">2-D continuum parts</div>
            {contPresets.map((p) => (
              <button
                key={p.id}
                className={`preset ${tab === 'continuum' && contId === p.id ? 'active' : ''}`}
                onClick={() => loadPreset(p.id)}
              >
                <div className="preset-name">{p.name}</div>
                <div className="preset-blurb">{p.blurb}</div>
              </button>
            ))}
          </div>
        </aside>

        {/* ---------------- center: canvas ---------------- */}
        <main className="stage">
          {tab === 'frame' && analysis === 'static' && (
            <div className="toolbar">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  className={`tool ${tool === t.id ? 'active' : ''}`}
                  title={t.hint}
                  onClick={() => {
                    setTool(t.id)
                    setPendingNode(null)
                  }}
                >
                  {t.label}
                </button>
              ))}
              <div className="tool-hint">{pendingNode !== null ? 'Pick the second joint…' : activeTool.hint}</div>
            </div>
          )}
          <div className="canvas-wrap" ref={wrapRef}>
            <canvas
              ref={canvasRef}
              style={{ width: size.w, height: size.h }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => setHover(null)}
              onWheel={onWheel}
            />
            <div className="overlay-legend">
              {tab === 'frame' && isMode ? (
                <div className="legend force-legend">
                  <span className="chip" style={{ color: '#cfe0ff' }}>
                    {analysis === 'modal'
                      ? `mode ${effModeIndex + 1} · ${fmtEng(selMode!.hz, 'Hz')}`
                      : analysis === 'buckling'
                        ? `buckling mode ${effModeIndex + 1} · λ = ${selMode!.loadFactor.toFixed(2)}`
                        : `response · ζ = ${(respZeta * 100).toFixed(0)}% · t = ${respElapsed.toFixed(2)} s`}
                  </span>
                </div>
              ) : tab === 'frame' ? (
                display.colorBy === 'force' ? (
                  <div className="legend force-legend">
                    <span className="chip comp">■ compression</span>
                    <span className="chip tens">■ tension</span>
                  </div>
                ) : (
                  frameResult && (
                    <Legend colormap={display.colormap} min={0} max={frameResult.maxStress} unit="Pa" label="fibre stress" />
                  )
                )
              ) : (
                contResult && (
                  <Legend
                    colormap={display.colormap}
                    min={display.field === 'vm' ? contResult.minVonMises : 0}
                    max={display.field === 'vm' ? contResult.maxVonMises : contResult.maxDisp}
                    unit={display.field === 'vm' ? 'Pa' : 'm'}
                    label={display.field === 'vm' ? 'von Mises stress' : 'displacement'}
                  />
                )
              )}
            </div>
            <div className="overlay-controls">
              <button className="ghost-btn" onClick={fitToModel} title="Fit model to view">
                ⤢ Fit
              </button>
              {!isMode && (
                <button className="ghost-btn" onClick={animate} title="Ramp the load from zero">
                  ▶ Animate
                </button>
              )}
            </div>
            <HoverTip
              tab={tab}
              hover={hover}
              frame={frame}
              frameResult={frameResult}
              toScreen={toScreen}
            />
          </div>
        </main>

        {/* ---------------- right rail: controls + results ---------------- */}
        <aside className="rail right">
          {tab === 'frame' && (
            <div className="panel">
              <div className="panel-title">Analysis</div>
              <Segmented<FrameAnalysis>
                options={[
                  { value: 'static', label: 'Static' },
                  { value: 'modal', label: 'Modal' },
                  { value: 'buckling', label: 'Buckling' },
                  { value: 'response', label: 'Response' },
                ]}
                value={analysis}
                onChange={(v) => {
                  patchDisplay({ analysis: v })
                  setModeIndex(0)
                  setSel(null)
                  setTool('select')
                  setRespPlaying(true)
                }}
              />
              <p className="hint-text">
                {analysis === 'static'
                  ? 'Deflections, member forces and reactions under the applied load.'
                  : analysis === 'modal'
                    ? 'Free-vibration natural frequencies and mode shapes: K φ = ω² M φ.'
                    : analysis === 'buckling'
                      ? 'Linearized (Euler) buckling load factors and modes: (K + λ K_g) φ = 0.'
                      : 'Transient response: the structure released from its static deflection, rung down by modal superposition Σ φᵢ qᵢ(t).'}
              </p>
            </div>
          )}
          <div className="panel">
            <div className="panel-title">Display</div>
            <Slider
              label="Deformation ×"
              min={0}
              max={3}
              step={0.05}
              value={display.deformScale}
              onChange={(v) => patchDisplay({ deformScale: v })}
              format={(v) => `${v.toFixed(2)}×`}
            />
            <Toggle
              label="Auto-scale deflection"
              checked={display.autoDeform}
              onChange={(v) => patchDisplay({ autoDeform: v })}
            />
            <Toggle
              label="Show undeformed ghost"
              checked={display.showUndeformed}
              onChange={(v) => patchDisplay({ showUndeformed: v })}
            />
            {tab === 'frame' ? (
              <>
                <div className="field-label">Colour members by</div>
                <Segmented
                  options={[
                    { value: 'force', label: 'Tension / Compression' },
                    { value: 'stress', label: 'Fibre stress' },
                  ]}
                  value={display.colorBy}
                  onChange={(v) => patchDisplay({ colorBy: v })}
                />
                <Toggle label="Load arrows" checked={display.showLoads} onChange={(v) => patchDisplay({ showLoads: v })} />
                <Toggle
                  label="Reaction arrows"
                  checked={display.showReactions}
                  onChange={(v) => patchDisplay({ showReactions: v })}
                />
                <Toggle label="Force labels" checked={display.showLabels} onChange={(v) => patchDisplay({ showLabels: v })} />
              </>
            ) : (
              <>
                <div className="field-label">Field</div>
                <Segmented
                  options={[
                    { value: 'vm', label: 'von Mises' },
                    { value: 'disp', label: 'Displacement' },
                  ]}
                  value={display.field}
                  onChange={(v) => patchDisplay({ field: v })}
                />
                <div className="field-label">Colour map</div>
                <Segmented
                  options={[
                    { value: 'turbo', label: 'Turbo' },
                    { value: 'viridis', label: 'Viridis' },
                    { value: 'grayscale', label: 'Gray' },
                  ]}
                  value={display.colormap}
                  onChange={(v) => patchDisplay({ colormap: v })}
                />
                <Toggle label="Mesh edges" checked={display.showMesh} onChange={(v) => patchDisplay({ showMesh: v })} />
                <Slider
                  label="Mesh density"
                  min={0.5}
                  max={2}
                  step={0.1}
                  value={density}
                  onChange={setDensity}
                  format={(v) => `${v.toFixed(1)}×`}
                />
              </>
            )}
          </div>

          {tab === 'frame' ? (
            analysis === 'static' ? (
              <FrameResults result={frameResult} model={frame} />
            ) : analysis === 'modal' ? (
              <ModalPanel
                result={modalResult}
                model={frame}
                selected={effModeIndex}
                onSelect={setModeIndex}
              />
            ) : analysis === 'buckling' ? (
              <BucklingPanel
                result={bucklingResult}
                selected={effModeIndex}
                onSelect={setModeIndex}
              />
            ) : (
              <ResponsePanel
                result={transientResult}
                zeta={respZeta}
                onZeta={(v) => patchDisplay({ respZeta: v })}
                playing={respPlaying}
                onPlay={setRespPlaying}
                onRestart={restartResponse}
                elapsed={respElapsed}
              />
            )
          ) : (
            <ContinuumResults result={contResult} input={contInput} />
          )}

          {tab === 'frame' && sel && (
            <SelectionEditor
              sel={sel}
              model={frame}
              result={frameResult}
              onSupport={(i, s) => setFrame(setSupport(frame, i, s))}
              onLoad={(i, fx, fy, mz) => setFrame(setLoad(frame, i, fx, fy, mz))}
              onMember={updateMember}
              onDeleteNode={(i) => {
                setFrame(deleteNode(frame, i))
                setSel(null)
              }}
              onDeleteMember={(i) => {
                setFrame(deleteMember(frame, i))
                setSel(null)
              }}
            />
          )}

          <div className="panel">
            <div className="panel-title">Scene</div>
            <div className="btn-row">
              <button className="ghost-btn" onClick={() => downloadJSON({ version: 1, tab, frame, continuum: { presetId: contId, density }, display })}>
                ⭳ Export JSON
              </button>
              <button
                className="ghost-btn"
                onClick={() => {
                  try {
                    navigator.clipboard?.writeText(location.href)
                  } catch {
                    /* ignore */
                  }
                }}
              >
                🔗 Copy link
              </button>
            </div>
            <p className="hint-text">Models autosave locally and encode into the URL — copy the link to share this exact structure.</p>
          </div>
        </aside>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ subpanels

function HoverTip({
  tab,
  hover,
  frame,
  frameResult,
  toScreen,
}: {
  tab: Tab
  hover: Picked | null
  frame: FrameModel
  frameResult: FrameResult | null
  toScreen: (x: number, y: number) => [number, number]
}) {
  if (tab !== 'frame' || !hover || !frameResult) return null
  let x: number
  let y: number
  let body: React.ReactNode
  if (hover.type === 'node') {
    const n = frame.nodes[hover.index]
    const d = frameResult.nodeDisp[hover.index]
    ;[x, y] = toScreen(n.x, n.y)
    body = (
      <>
        <div className="tip-title">Joint {hover.index}</div>
        <div>δ {fmtEng(Math.hypot(d.ux, d.uy), 'm')}</div>
        <div>support: {n.support}</div>
      </>
    )
  } else {
    const m = frame.members[hover.index]
    const r = frameResult.members[hover.index]
    const a = frame.nodes[m.a]
    const b = frame.nodes[m.b]
    ;[x, y] = toScreen((a.x + b.x) / 2, (a.y + b.y) / 2)
    body = (
      <>
        <div className="tip-title">Member {hover.index}</div>
        <div className={r.axial >= 0 ? 'tens' : 'comp'}>
          {r.axial >= 0 ? 'tension' : 'compression'} {fmtEng(Math.abs(r.axial), 'N')}
        </div>
        <div>σ {fmtEng(r.maxFiberStress, 'Pa')}</div>
        {frame.type === 'frame' && <div>M {fmtEng(Math.max(Math.abs(r.momentA), Math.abs(r.momentB)), 'N·m')}</div>}
      </>
    )
  }
  return (
    <div className="hovertip" style={{ left: x + 12, top: y + 12 }}>
      {body}
    </div>
  )
}

function FrameResults({ result, model }: { result: FrameResult | null; model: FrameModel }) {
  if (!result) return null
  const topMembers = model.members
    .map((_, i) => i)
    .sort((a, b) => Math.abs(result.members[b].axial) - Math.abs(result.members[a].axial))
    .slice(0, 6)
  return (
    <div className="panel">
      <div className="panel-title">
        Results
        <span className={result.stable ? 'badge good' : 'badge warn'}>
          {result.stable ? 'stable' : 'unstable / mechanism'}
        </span>
      </div>
      <div className="stat-grid">
        <StatTile label="Max deflection" value={fmtEng(result.maxDisp, 'm')} />
        <StatTile label="Max axial" value={fmtEng(result.maxAxial, 'N')} />
        <StatTile label="Max fibre stress" value={fmtEng(result.maxStress, 'Pa')} />
        <StatTile label="Equilibrium" value={result.equilibriumResidual.toExponential(1)} sub="‖Ku−f‖/‖f‖" />
        <StatTile label="DOF" value={`${model.nodes.length * result.dofPerNode}`} sub={`${result.iterations} CG iters`} />
        <StatTile label="Members" value={`${model.members.length}`} />
      </div>
      <div className="table-title">Reactions</div>
      <div className="mini-table">
        <div className="mt-head">
          <span>joint</span>
          <span>Rx</span>
          <span>Ry</span>
          {result.dofPerNode === 3 && <span>M</span>}
        </div>
        {result.reactions.map((r) => (
          <div className="mt-row" key={r.node}>
            <span>{r.node}</span>
            <span>{fmtEng(r.fx, 'N')}</span>
            <span>{fmtEng(r.fy, 'N')}</span>
            {result.dofPerNode === 3 && <span>{fmtEng(r.mz, 'N·m')}</span>}
          </div>
        ))}
      </div>
      <div className="table-title">Highest-force members</div>
      <div className="mini-table">
        {topMembers.map((i) => {
          const r = result.members[i]
          return (
            <div className="mt-row wide" key={i}>
              <span>#{i}</span>
              <span className={r.axial >= 0 ? 'tens' : 'comp'}>
                {r.axial >= 0 ? '＋' : '－'}
                {fmtEng(Math.abs(r.axial), 'N')}
              </span>
              <span>{fmtEng(r.maxFiberStress, 'Pa')}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ContinuumResults({
  result,
  input,
}: {
  result: ContinuumResult | null
  input: ContinuumInput | null
}) {
  if (!result || !input) return null
  return (
    <div className="panel">
      <div className="panel-title">
        Results
        <span className={result.stable ? 'badge good' : 'badge warn'}>{result.stable ? 'converged' : 'check'}</span>
      </div>
      <div className="stat-grid">
        <StatTile label="Max von Mises" value={fmtEng(result.maxVonMises, 'Pa')} />
        <StatTile label="Max displacement" value={fmtEng(result.maxDisp, 'm')} />
        <StatTile label="Strain energy" value={fmtEng(result.strainEnergy, 'J')} />
        <StatTile label="Elements" value={`${input.mesh.triCount}`} sub={`${input.mesh.nodeCount} nodes`} />
        <StatTile label="Equilibrium" value={result.equilibriumResidual.toExponential(1)} sub="‖Ku−f‖/‖f‖" />
        <StatTile label="Solver" value={`${result.iterations}`} sub="PCG iters" />
      </div>
      <p className="hint-text">
        Constant-strain triangles ⇒ stress is uniform within each element (shown flat). Refine the
        mesh density to sharpen gradients near concentrations.
      </p>
    </div>
  )
}

function ModalPanel({
  result,
  model,
  selected,
  onSelect,
}: {
  result: ModalResult | null
  model: FrameModel
  selected: number
  onSelect: (i: number) => void
}) {
  if (!result) return null
  if (!result.ok || result.modes.length === 0) {
    return (
      <div className="panel">
        <div className="panel-title">Vibration modes</div>
        <p className="hint-text">{result.note ?? 'No modes available.'}</p>
      </div>
    )
  }
  const m0 = result.modes[0]
  return (
    <div className="panel">
      <div className="panel-title">
        Vibration modes
        <span className="badge good">{result.modes.length} found</span>
      </div>
      <div className="stat-grid">
        <StatTile label="Fundamental" value={fmtEng(m0.hz, 'Hz')} sub={`ω = ${fmtEng(m0.omega, 'rad/s')}`} />
        <StatTile label="Period" value={fmtEng(1 / m0.hz, 's')} />
        <StatTile label="DOF" value={`${model.nodes.length * result.dofPerNode}`} />
        <StatTile label="Modal mass" value={fmtEng(result.totalMassX, 'kg')} sub="total" />
      </div>
      <div className="table-title">Modes — click to animate</div>
      <div className="mode-list">
        {result.modes.map((md, i) => (
          <button
            key={i}
            className={`mode-row ${i === selected ? 'active' : ''}`}
            onClick={() => onSelect(i)}
          >
            <span className="mode-idx">#{i + 1}</span>
            <span className="mode-freq">{fmtEng(md.hz, 'Hz')}</span>
            <span className="mode-part">{Math.round(100 * Math.max(md.massX, md.massY))}% mass</span>
          </button>
        ))}
      </div>
      <p className="hint-text">
        Frequencies from the consistent-mass eigenproblem K φ = ω² M φ. The selected mode
        oscillates live on the canvas.
      </p>
    </div>
  )
}

function BucklingPanel({
  result,
  selected,
  onSelect,
}: {
  result: BucklingResult | null
  selected: number
  onSelect: (i: number) => void
}) {
  if (!result) return null
  if (!result.ok || result.modes.length === 0) {
    return (
      <div className="panel">
        <div className="panel-title">Buckling modes</div>
        <p className="hint-text">{result.note ?? 'No buckling modes available.'}</p>
      </div>
    )
  }
  const m0 = result.modes[0]
  const safe = m0.loadFactor > 1
  return (
    <div className="panel">
      <div className="panel-title">
        Buckling modes
        <span className={safe ? 'badge good' : 'badge warn'}>λ₁ = {m0.loadFactor.toFixed(2)}</span>
      </div>
      <div className="stat-grid">
        <StatTile label="Critical factor λ₁" value={m0.loadFactor.toFixed(3)} sub="× applied load" />
        <StatTile label="P_cr (peak member)" value={fmtEng(result.referenceMaxAxial * m0.loadFactor, 'N')} sub="|N|ᵣₑ𝒻·λ₁" />
        <StatTile label="Modes" value={`${result.modes.length}`} />
        <StatTile
          label="Stability"
          value={safe ? 'stable' : 'buckles'}
          sub={safe ? 'λ₁ > 1 under load' : 'λ₁ < 1 — unstable'}
        />
      </div>
      <div className="table-title">Load factors — click to animate</div>
      <div className="mode-list">
        {result.modes.map((md, i) => (
          <button
            key={i}
            className={`mode-row ${i === selected ? 'active' : ''}`}
            onClick={() => onSelect(i)}
          >
            <span className="mode-idx">#{i + 1}</span>
            <span className="mode-freq">λ = {md.loadFactor.toFixed(3)}</span>
            <span className="mode-part">{fmtEng(result.referenceMaxAxial * md.loadFactor, 'N')}</span>
          </button>
        ))}
      </div>
      <p className="hint-text">
        Load factor λ multiplies the applied load to reach instability, from (K + λ K_g) φ = 0
        with K_g built from the static axial-force field.
      </p>
    </div>
  )
}

function ResponsePanel({
  result,
  zeta,
  onZeta,
  playing,
  onPlay,
  onRestart,
  elapsed,
}: {
  result: TransientResult | null
  zeta: number
  onZeta: (v: number) => void
  playing: boolean
  onPlay: (v: boolean) => void
  onRestart: () => void
  elapsed: number
}) {
  if (!result) return null
  if (!result.ok) {
    return (
      <div className="panel">
        <div className="panel-title">Dynamic response</div>
        <p className="hint-text">{result.note ?? 'No response available.'}</p>
      </div>
    )
  }
  const wd = result.modes[0].omega * Math.sqrt(1 - zeta * zeta)
  return (
    <div className="panel">
      <div className="panel-title">
        Dynamic response
        <span className="badge good">{result.modes.length} modes</span>
      </div>
      <div className="stat-grid">
        <StatTile label="Dominant freq" value={fmtEng(result.dominantHz, 'Hz')} />
        <StatTile label="Damped period" value={fmtEng((2 * Math.PI) / wd, 's')} />
        <StatTile label="Elapsed" value={fmtEng(elapsed, 's')} />
        <StatTile label="Damping ζ" value={`${(zeta * 100).toFixed(1)}%`} />
      </div>
      <div className="btn-row">
        <button className="ghost-btn" onClick={() => onPlay(!playing)}>
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <button className="ghost-btn" onClick={onRestart}>
          ↺ Restart
        </button>
      </div>
      <Slider
        label="Damping ratio ζ"
        min={0}
        max={0.2}
        step={0.005}
        value={zeta}
        onChange={onZeta}
        format={(v) => `${(v * 100).toFixed(1)}%`}
      />
      <p className="hint-text">
        Released from the static deflection with zero velocity; each mode decays as e^(−ζωt).
        The motion is the superposition Σ φᵢ qᵢ(t) of all vibration modes.
      </p>
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
  step = 1,
  suffix,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  step?: number
  suffix?: string
}) {
  return (
    <label className="numfield">
      <span>{label}</span>
      <span className="numfield-input">
        <input
          type="number"
          value={Number.isFinite(value) ? value : 0}
          step={step}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        />
        {suffix && <em>{suffix}</em>}
      </span>
    </label>
  )
}

function SelectionEditor({
  sel,
  model,
  result,
  onSupport,
  onLoad,
  onMember,
  onDeleteNode,
  onDeleteMember,
}: {
  sel: Picked
  model: FrameModel
  result: FrameResult | null
  onSupport: (i: number, s: SupportKind) => void
  onLoad: (i: number, fx: number, fy: number, mz: number) => void
  onMember: (i: number, patch: Partial<FrameModel['members'][number]>) => void
  onDeleteNode: (i: number) => void
  onDeleteMember: (i: number) => void
}) {
  if (sel.type === 'node') {
    const i = sel.index
    const n = model.nodes[i]
    if (!n) return null
    const l = getLoad(model, i)
    return (
      <div className="panel">
        <div className="panel-title">Joint {i}</div>
        <div className="field-label">Support</div>
        <select
          className="select"
          value={n.support}
          onChange={(e) => onSupport(i, e.target.value as SupportKind)}
        >
          {SUPPORTS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <div className="field-label">Applied load</div>
        <NumberField label="Fx" value={l.fx / 1000} step={1} suffix="kN" onChange={(v) => onLoad(i, v * 1000, l.fy, l.mz)} />
        <NumberField label="Fy" value={l.fy / 1000} step={1} suffix="kN" onChange={(v) => onLoad(i, l.fx, v * 1000, l.mz)} />
        {model.type === 'frame' && (
          <NumberField label="M" value={l.mz / 1000} step={1} suffix="kN·m" onChange={(v) => onLoad(i, l.fx, l.fy, v * 1000)} />
        )}
        <button className="danger-btn" onClick={() => onDeleteNode(i)}>
          Delete joint
        </button>
      </div>
    )
  }
  const i = sel.index
  const m = model.members[i]
  if (!m) return null
  const r = result?.members[i]
  return (
    <div className="panel">
      <div className="panel-title">Member {i}</div>
      {r && (
        <div className="stat-grid">
          <StatTile label="Axial" value={`${r.axial >= 0 ? '+' : ''}${fmtEng(r.axial, 'N')}`} sub={r.axial >= 0 ? 'tension' : 'compression'} />
          <StatTile label="Fibre stress" value={fmtEng(r.maxFiberStress, 'Pa')} />
          {model.type === 'frame' && <StatTile label="Moment" value={fmtEng(Math.max(Math.abs(r.momentA), Math.abs(r.momentB)), 'N·m')} />}
          <StatTile label="Length" value={fmtEng(r.length, 'm')} />
        </div>
      )}
      <div className="field-label">Section</div>
      <NumberField label="E" value={m.E / 1e9} step={1} suffix="GPa" onChange={(v) => onMember(i, { E: v * 1e9 })} />
      <NumberField label="A" value={m.A * 1e4} step={1} suffix="cm²" onChange={(v) => onMember(i, { A: v / 1e4 })} />
      {model.type === 'frame' && (
        <>
          <NumberField label="I" value={m.I * 1e8} step={1} suffix="cm⁴" onChange={(v) => onMember(i, { I: v / 1e8 })} />
          <NumberField
            label="w"
            value={(m.w ?? 0) / 1000}
            step={1}
            suffix="kN/m"
            onChange={(v) => onMember(i, { w: v * 1000 })}
          />
        </>
      )}
      <NumberField
        label="ρ"
        value={m.rho ?? 7850}
        step={100}
        suffix="kg/m³"
        onChange={(v) => onMember(i, { rho: v })}
      />
      <button className="danger-btn" onClick={() => onDeleteMember(i)}>
        Delete member
      </button>
    </div>
  )
}
