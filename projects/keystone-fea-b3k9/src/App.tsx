import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  solveFrame,
  type FrameModel,
  type FrameResult,
  type SupportKind,
} from './engine/frame'
import { solveContinuum, type ContinuumInput, type ContinuumResult } from './engine/continuum'
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

const WARREN = (PRESETS.find((p) => p.id === 'warren') as FramePreset).model

export default function App() {
  const initial = useMemo<Scene | null>(() => readHash() ?? loadLocal(), [])
  const [tab, setTab] = useState<Tab>(initial?.tab ?? 'frame')
  const [frame, setFrame] = useState<FrameModel>(() => cloneFrame(initial?.frame ?? WARREN))
  const [contId, setContId] = useState(initial?.continuum.presetId ?? 'c-hole')
  const [density, setDensity] = useState(initial?.continuum.density ?? 1)
  const [display, setDisplay] = useState<Display>(initial?.display ?? DEFAULT_DISPLAY)

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
      drawFrame(ctx, size.w, size.h, frame, frameResult, {
        view,
        deformScale: effectiveDeform,
        loadFactor,
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
    pendingNode, loadFactor, effectiveDeform,
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
          {tab === 'frame' && (
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
              {tab === 'frame' ? (
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
              <button className="ghost-btn" onClick={animate} title="Ramp the load from zero">
                ▶ Animate
              </button>
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
            <FrameResults result={frameResult} model={frame} />
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
        <NumberField label="I" value={m.I * 1e8} step={1} suffix="cm⁴" onChange={(v) => onMember(i, { I: v / 1e8 })} />
      )}
      <button className="danger-btn" onClick={() => onDeleteMember(i)}>
        Delete member
      </button>
    </div>
  )
}
