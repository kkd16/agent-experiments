// The Plate & Shell studio: Keystone's first *out-of-plane* analysis.
//
// Everything else in the app bends in its own plane (membranes, frames, bars).
// A slab, a cover plate or a silicon die bends transversely — the load pushes it
// out of the plane and it resists by bending & twisting moments. This tab meshes
// a rectangular plate on the from-scratch MITC4 Reissner–Mindlin element (which
// defeats shear locking), solves either the static deflection under pressure /
// point load or the free-vibration modes K φ = ω² M φ, and renders the result as
// an orbitable 3-D deflected surface — flat-shaded and draped with whichever
// field you choose (deflection or the Mx / My / Mxy / principal moments) — beside
// a live check against the classical Timoshenko closed-form solution.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  solvePlateStatic,
  solvePlateModal,
  type PlateInput,
  type PlateStatic,
  type PlateModal,
  type PlateLoad,
} from '../engine/platesolve'
import { makePlateMesh, edgeNodes, type PlateMesh } from '../engine/platemesh'
import {
  PLATE_SCENARIOS,
  PLATE_MATERIALS,
  scenarioById,
  plateExact,
  plateModalExact,
  type PlateScenario,
} from '../engine/platepresets'
import { fieldColor, signedColor, rgbStr } from './colormap'
import { Segmented, Slider, StatTile, Toggle } from './components'
import { fmtEng } from './format'

type Analysis = 'static' | 'modal'
type ViewMode = 'surface' | 'contour'
type Field = 'w' | 'Mx' | 'My' | 'Mxy' | 'M1'

interface Params {
  scenarioId: string
  materialId: string
  thickness: number // m
  span: number // m (short side)
  load: number // Pa (uniform/hydrostatic) or N (point) depending on scenario
  density: number
  analysis: Analysis
}

const DEFAULTS: Params = {
  scenarioId: 'ss-square-udl',
  materialId: 'steel',
  thickness: 0.02,
  span: 1,
  load: 5000,
  density: 1,
  analysis: 'static',
}

const FIELDS: { id: Field; label: string; signed: boolean }[] = [
  { id: 'w', label: 'Deflection w', signed: false },
  { id: 'Mx', label: 'Moment Mx', signed: true },
  { id: 'My', label: 'Moment My', signed: true },
  { id: 'Mxy', label: 'Twist Mxy', signed: true },
  { id: 'M1', label: 'Principal M₁', signed: true },
]

interface Built {
  input: PlateInput
  mesh: PlateMesh
  Lx: number
  Ly: number
  sc: PlateScenario
  material: (typeof PLATE_MATERIALS)[number]
  q: number
  P: number
}

function build(params: Params): Built {
  const sc = scenarioById(params.scenarioId)
  const material = PLATE_MATERIALS.find((m) => m.id === params.materialId) ?? PLATE_MATERIALS[0]
  const Lx = params.span
  const Ly = params.span * sc.aspect
  // Mesh: keep the short side well-resolved, scale the long side, cap the total.
  const nBase = Math.round(18 * params.density)
  const nx = Math.max(8, Math.min(30, nBase))
  const ny = Math.max(8, Math.min(48, Math.round(nx * sc.aspect)))
  const mesh = makePlateMesh(Lx, Ly, nx, ny)

  // The corner-supported scenario pins w=0 at the four plate corners.
  const pointSupports = sc.cornerSupports
    ? [
        nearestCorner(mesh, 0, 0),
        nearestCorner(mesh, Lx, 0),
        nearestCorner(mesh, Lx, Ly),
        nearestCorner(mesh, 0, Ly),
      ]
    : undefined

  const q = params.load
  const P = params.load
  let load: PlateLoad
  if (sc.loadKind === 'uniform') load = { type: 'uniform', q }
  else if (sc.loadKind === 'point') load = { type: 'point', P }
  else load = { type: 'hydrostatic', q0: q, q1: 0 } // full at base (y=0), zero at top

  const input: PlateInput = {
    mesh,
    material: { E: material.E, nu: material.nu, rho: material.rho },
    thickness: params.thickness,
    edges: sc.edges,
    load,
    pointSupports,
  }
  return { input, mesh, Lx, Ly, sc, material, q, P }
}

function nearestCorner(mesh: PlateMesh, x: number, y: number): number {
  let best = 0
  let bd = Infinity
  for (let n = 0; n < mesh.nodeCount; n++) {
    const d = (mesh.x[n] - x) ** 2 + (mesh.y[n] - y) ** 2
    if (d < bd) {
      bd = d
      best = n
    }
  }
  return best
}

interface Snapshot {
  built: Built
  stat: PlateStatic | null
  modal: PlateModal | null
  analysis: Analysis
  view: ViewMode
  field: Field
  modeSel: number
  showMesh: boolean
  playing: boolean
}

export function PlateStudio() {
  const [params, setParams] = useState<Params>(DEFAULTS)
  const [view, setView] = useState<ViewMode>('surface')
  const [field, setField] = useState<Field>('w')
  const [modeSel, setModeSel] = useState(0)
  const [showMesh, setShowMesh] = useState(true)
  const [playing, setPlaying] = useState(true)

  // Debounce the continuous sliders so each heavy solve fires once the drag
  // settles, not 50× mid-drag.
  const [draft, setDraft] = useState({ thickness: params.thickness, span: params.span, load: params.load, density: params.density })
  useEffect(() => {
    const changed =
      draft.thickness !== params.thickness ||
      draft.span !== params.span ||
      draft.load !== params.load ||
      draft.density !== params.density
    if (!changed) return
    const id = setTimeout(() => setParams((p) => ({ ...p, ...draft })), 200)
    return () => clearTimeout(id)
  }, [draft, params.thickness, params.span, params.load, params.density])

  const built = useMemo(() => build(params), [params])

  const stat = useMemo<PlateStatic | null>(() => {
    if (params.analysis !== 'static') return null
    try {
      return solvePlateStatic(built.input)
    } catch {
      return null
    }
  }, [built, params.analysis])

  const modal = useMemo<PlateModal | null>(() => {
    if (params.analysis !== 'modal') return null
    try {
      return solvePlateModal(built.input, 6)
    } catch {
      return null
    }
  }, [built, params.analysis])

  const nModes = modal?.modes.length ?? 0
  const effMode = nModes > 0 ? Math.min(modeSel, nModes - 1) : 0
  const mode = modal?.modes[effMode] ?? null

  // Closed-form comparison.
  const exact = useMemo(
    () => plateExact(built.sc, built.input.material, params.thickness, built.Lx, built.Ly, built.q, built.P),
    [built, params.thickness],
  )
  const modalExact = useMemo(
    () => plateModalExact(built.sc, built.input.material, params.thickness, built.Lx, built.Ly),
    [built, params.thickness],
  )

  const wErr =
    stat && exact?.wCenter != null && Math.abs(exact.wCenter) > 0
      ? Math.abs(Math.abs(stat.wCenter) - Math.abs(exact.wCenter)) / Math.abs(exact.wCenter)
      : null
  const fErr =
    mode && modalExact != null && modalExact > 0 ? Math.abs(mode.frequency - modalExact) / modalExact : null

  // --- canvas + orbit --------------------------------------------------------
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const sizeRef = useRef({ w: 820, h: 560 })
  const camRef = useRef({ az: -0.5, el: 0.95, zoom: 1 })
  const dragRef = useRef<{ x: number; y: number } | null>(null)

  const snapRef = useRef<Snapshot>({
    built,
    stat,
    modal,
    analysis: params.analysis,
    view,
    field,
    modeSel: effMode,
    showMesh,
    playing,
  })
  useEffect(() => {
    snapRef.current = {
      built,
      stat,
      modal,
      analysis: params.analysis,
      view,
      field,
      modeSel: effMode,
      showMesh,
      playing,
    }
  }, [built, stat, modal, params.analysis, view, field, effMode, showMesh, playing])

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      sizeRef.current = { w: Math.max(320, r.width), h: Math.max(260, r.height) }
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    let raf = 0
    let phase = 0
    let last = 0
    const loop = (ts: number) => {
      if (!last) last = ts
      const dt = Math.min(0.05, (ts - last) / 1000)
      last = ts
      const snap = snapRef.current
      if (snap.playing && snap.analysis === 'modal') phase += dt * 0.8
      const cv = canvasRef.current
      if (cv) {
        const ctx = cv.getContext('2d')
        if (ctx) {
          const dpr = Math.min(window.devicePixelRatio || 1, 2)
          const { w: cw, h: ch } = sizeRef.current
          if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
            cv.width = Math.round(cw * dpr)
            cv.height = Math.round(ch * dpr)
            cv.style.width = `${cw}px`
            cv.style.height = `${ch}px`
          }
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
          draw(ctx, cw, ch, snap, phase, camRef.current)
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Pointer orbit / zoom (mutating refs — no re-render).
  const onDown = (e: React.PointerEvent) => {
    canvasRef.current?.setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY }
  }
  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const cam = camRef.current
    cam.az += (e.clientX - d.x) * 0.008
    cam.el = Math.max(0.12, Math.min(1.5, cam.el - (e.clientY - d.y) * 0.006))
    dragRef.current = { x: e.clientX, y: e.clientY }
  }
  const onUp = (e: React.PointerEvent) => {
    canvasRef.current?.releasePointerCapture(e.pointerId)
    dragRef.current = null
  }
  const onWheel = (e: React.WheelEvent) => {
    const cam = camRef.current
    cam.zoom = Math.max(0.4, Math.min(3, cam.zoom * Math.exp(-e.deltaY * 0.0012)))
  }

  const patch = (p: Partial<Params>) => setParams((prev) => ({ ...prev, ...p }))
  const setScenario = (id: string) => {
    const sc = scenarioById(id)
    setModeSel(0)
    // Point-load scenarios default to a sensible force; pressure scenarios a pressure.
    setParams((prev) => {
      const load = sc.loadKind === 'point' ? 20000 : prev.load < 100 ? 5000 : prev.load
      const next = { ...prev, scenarioId: id, load }
      setDraft((d) => ({ ...d, load }))
      return next
    })
  }

  const material = built.material
  const loadIsForce = built.sc.loadKind === 'point'

  return (
    <div className="topopt">
      <aside className="rail left">
        <div className="panel">
          <div className="panel-title">Plate scenario</div>
          {PLATE_SCENARIOS.map((sc) => (
            <button
              key={sc.id}
              className={`preset ${params.scenarioId === sc.id ? 'active' : ''}`}
              onClick={() => setScenario(sc.id)}
            >
              <div className="preset-name">{sc.name}</div>
              <div className="preset-blurb">{sc.blurb}</div>
            </button>
          ))}
        </div>
        <div className="panel">
          <div className="panel-title">Material</div>
          {PLATE_MATERIALS.map((m) => (
            <button
              key={m.id}
              className={`preset ${params.materialId === m.id ? 'active' : ''}`}
              onClick={() => patch({ materialId: m.id })}
            >
              <div className="preset-name">{m.name}</div>
              <div className="preset-blurb">{m.blurb}</div>
            </button>
          ))}
        </div>
        <div className="panel">
          <div className="panel-title">Geometry &amp; load</div>
          <Slider
            label="Short span a"
            min={0.4}
            max={3}
            step={0.1}
            value={draft.span}
            onChange={(v) => setDraft((d) => ({ ...d, span: v }))}
            format={(v) => `${v.toFixed(1)} m`}
          />
          <Slider
            label="Thickness t"
            min={0.004}
            max={0.06}
            step={0.002}
            value={draft.thickness}
            onChange={(v) => setDraft((d) => ({ ...d, thickness: v }))}
            format={(v) => `${(v * 1000).toFixed(0)} mm`}
          />
          <Slider
            label={loadIsForce ? 'Point load P' : 'Pressure q'}
            min={loadIsForce ? 1000 : 500}
            max={loadIsForce ? 100000 : 40000}
            step={loadIsForce ? 1000 : 500}
            value={draft.load}
            onChange={(v) => setDraft((d) => ({ ...d, load: v }))}
            format={(v) => (loadIsForce ? fmtEng(v, 'N') : fmtEng(v, 'Pa'))}
          />
          <Slider
            label="Mesh density"
            min={0.6}
            max={1.6}
            step={0.1}
            value={draft.density}
            onChange={(v) => setDraft((d) => ({ ...d, density: v }))}
            format={(v) => `${v.toFixed(1)}×`}
          />
          <Toggle label="Show mesh" checked={showMesh} onChange={setShowMesh} />
        </div>
      </aside>

      <main className="stage">
        <div className="topopt-toolbar">
          <Segmented<Analysis>
            options={[
              { value: 'static', label: 'Static' },
              { value: 'modal', label: 'Modes' },
            ]}
            value={params.analysis}
            onChange={(v) => {
              patch({ analysis: v })
              setModeSel(0)
              if (v === 'modal') setField('w')
              setPlaying(true)
            }}
          />
          <Segmented<ViewMode>
            options={[
              { value: 'surface', label: '◳ Surface' },
              { value: 'contour', label: '▦ Contour' },
            ]}
            value={view}
            onChange={setView}
          />
          {params.analysis === 'static' && (
            <div className="mode-pills">
              {FIELDS.map((f) => (
                <button
                  key={f.id}
                  className={`tool ${field === f.id ? 'active' : ''}`}
                  onClick={() => setField(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}
          {params.analysis === 'modal' && nModes > 0 && (
            <div className="mode-pills">
              {modal!.modes.map((m, i) => (
                <button
                  key={i}
                  className={`tool ${effMode === i ? 'active' : ''}`}
                  onClick={() => setModeSel(i)}
                  title={`${m.frequency.toFixed(2)} Hz`}
                >
                  {i + 1}
                </button>
              ))}
              <button className={`tool ${playing ? 'active' : ''}`} onClick={() => setPlaying((p) => !p)}>
                {playing ? '⏸' : '▶'}
              </button>
            </div>
          )}
          <div className="tool-hint">
            {params.analysis === 'modal'
              ? mode
                ? `mode ${effMode + 1} · ${mode.frequency.toFixed(2)} Hz · drag to orbit`
                : 'solving eigenproblem…'
              : stat
                ? `${stat.freeDofCount} DOF · drag to orbit, scroll to zoom`
                : 'solving…'}
          </div>
        </div>
        <div className="canvas-wrap" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onWheel={onWheel}
            style={{ touchAction: 'none', cursor: 'grab' }}
          />
        </div>
      </main>

      <aside className="rail right">
        <div className="panel">
          <div className="panel-title">
            {params.analysis === 'modal' ? `Free vibration — mode ${effMode + 1}` : 'Response'}
          </div>
          {params.analysis === 'modal' ? (
            <div className="stat-grid">
              <StatTile label="Frequency" value={mode ? `${mode.frequency.toFixed(2)} Hz` : '—'} sub="f = ω/2π" />
              <StatTile
                label="Analytic f (SS)"
                value={modalExact != null ? `${modalExact.toFixed(2)} Hz` : 'n/a'}
                sub={built.sc.modal ? `mode (${built.sc.modal.m},${built.sc.modal.n})` : 'no closed form'}
              />
              <StatTile
                label="FE vs theory"
                value={fErr != null ? `${(fErr * 100).toFixed(2)}%` : '—'}
                sub="relative error"
              />
              <StatTile label="Period" value={mode ? `${(1 / mode.frequency).toFixed(3)} s` : '—'} sub="T = 1/f" />
            </div>
          ) : (
            <div className="stat-grid">
              <StatTile
                label="Centre deflection"
                value={stat ? fmtEng(Math.abs(stat.wCenter), 'm') : '—'}
                sub="w at plate centre"
              />
              <StatTile
                label="Theory (Timoshenko)"
                value={exact?.wCenter != null ? fmtEng(Math.abs(exact.wCenter), 'm') : 'n/a'}
                sub={exact?.label ?? 'no closed form'}
              />
              <StatTile
                label="FE vs theory"
                value={wErr != null ? `${(wErr * 100).toFixed(2)}%` : '—'}
                sub="relative error"
              />
              <StatTile
                label="Peak deflection"
                value={stat ? fmtEng(stat.wMax, 'm') : '—'}
                sub={`t/a = ${(params.thickness / built.Lx).toFixed(3)}`}
              />
            </div>
          )}
        </div>

        {params.analysis === 'static' && (
          <div className="panel">
            <div className="panel-title">Bending moments</div>
            <div className="stat-grid">
              <StatTile label="Peak |M| (principal)" value={stat ? fmtEng(stat.mMax, 'N') : '—'} sub="per unit width" />
              <StatTile
                label="Flexural rigidity D"
                value={fmtEng((material.E * params.thickness ** 3) / (12 * (1 - material.nu ** 2)), 'N·m')}
                sub="D = Et³/12(1−ν²)"
              />
              <StatTile
                label="Span / thickness"
                value={(built.Lx / params.thickness).toFixed(0)}
                sub={built.Lx / params.thickness > 20 ? 'thin plate' : 'thick plate'}
              />
              <StatTile label="Iterations" value={stat ? `${stat.iterations}` : '—'} sub="PCG solve" />
            </div>
          </div>
        )}

        <div className="panel">
          <div className="panel-title">Higher modes</div>
          {params.analysis === 'modal' && modal && modal.modes.length > 0 ? (
            <div className="mode-list">
              {modal.modes.map((m, i) => (
                <div key={i} className={`mode-row ${effMode === i ? 'active' : ''}`}>
                  <span className="mode-idx">#{i + 1}</span>
                  <span className="mode-val">{m.frequency.toFixed(2)} Hz</span>
                  <span className="mode-ratio">{i === 0 ? 'base' : `${(m.frequency / modal.modes[0].frequency).toFixed(2)}×`}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="verify-note">Switch to <b>Modes</b> to see the plate's natural frequencies and shapes.</p>
          )}
          <p className="verify-note">{built.sc.note}</p>
        </div>
      </aside>
    </div>
  )
}

// --- rendering -------------------------------------------------------------

/** Orthographic camera: rotate about z (azimuth), tilt about x (elevation). */
function project(x: number, y: number, z: number, az: number, el: number): [number, number, number] {
  const ca = Math.cos(az)
  const sa = Math.sin(az)
  const x1 = x * ca - y * sa
  const y1 = x * sa + y * ca
  const ce = Math.cos(el)
  const se = Math.sin(el)
  const y2 = y1 * ce - z * se
  const z2 = y1 * se + z * ce
  return [x1, -z2, y2] // screenX, screenY, depth
}

function fieldValues(snap: Snapshot, phase: number): { val: Float64Array; signed: boolean; min: number; max: number } {
  const { built, stat, modal, analysis, field, modeSel } = snap
  const nC = built.mesh.nodeCount
  if (analysis === 'modal') {
    const m = modal?.modes[modeSel]
    const v = new Float64Array(nC)
    if (m) for (let n = 0; n < nC; n++) v[n] = m.w[n]
    return { val: v, signed: true, min: -1, max: 1 }
  }
  if (!stat) return { val: new Float64Array(nC), signed: false, min: 0, max: 1 }
  const pick: Record<Field, Float64Array> = { w: stat.w, Mx: stat.Mx, My: stat.My, Mxy: stat.Mxy, M1: stat.m1 }
  const arr = pick[field]
  const signed = field !== 'w'
  let mn = Infinity
  let mx = -Infinity
  for (let n = 0; n < nC; n++) {
    mn = Math.min(mn, arr[n])
    mx = Math.max(mx, arr[n])
  }
  if (signed) {
    const a = Math.max(Math.abs(mn), Math.abs(mx)) || 1
    return { val: arr, signed, min: -a, max: a }
  }
  void phase
  return { val: arr, signed, min: mn, max: mx === mn ? mn + 1 : mx }
}

function colorFor(t: number, signed: boolean): string {
  if (signed) return rgbStr(signedColor(Math.max(-1, Math.min(1, t))), 1)
  return rgbStr(fieldColor(Math.max(0, Math.min(1, t)), 'turbo'), 1)
}

function draw(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  snap: Snapshot,
  phase: number,
  cam: { az: number; el: number; zoom: number },
) {
  ctx.clearRect(0, 0, cw, ch)
  ctx.fillStyle = '#0a0e17'
  ctx.fillRect(0, 0, cw, ch)
  const { built, stat, modal, analysis, view, modeSel, showMesh } = snap
  const mesh = built.mesh

  // Deflection field driving the surface height.
  let wArr: Float64Array | null = null
  let wPeak = 1e-30
  if (analysis === 'modal') {
    const m = modal?.modes[modeSel]
    if (m) {
      wArr = m.w
      wPeak = 1
    }
  } else if (stat) {
    wArr = stat.w
    wPeak = stat.wMax || 1e-30
  }

  const planSpan = Math.max(built.Lx, built.Ly)
  const cx = built.Lx / 2
  const cy = built.Ly / 2
  // Surface height amplitude: peak deflection → a fixed fraction of the plan span.
  const modeSwing = analysis === 'modal' ? Math.sin(phase * 2 * Math.PI) : 1
  const zAmp = view === 'contour' ? 0 : ((0.28 * planSpan) / wPeak) * modeSwing

  const wAt = (n: number) => (wArr ? wArr[n] : 0)
  // world z: positive deflection (downward load) dips the surface below the plane.
  const worldZ = (n: number) => -wAt(n) * zAmp

  // Project all nodes.
  const px = new Float64Array(mesh.nodeCount)
  const py = new Float64Array(mesh.nodeCount)
  const pd = new Float64Array(mesh.nodeCount)
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let n = 0; n < mesh.nodeCount; n++) {
    const [sx, sy, d] = project(mesh.x[n] - cx, mesh.y[n] - cy, worldZ(n), cam.az, cam.el)
    px[n] = sx
    py[n] = sy
    pd[n] = d
    if (sx < minX) minX = sx
    if (sx > maxX) maxX = sx
    if (sy < minY) minY = sy
    if (sy > maxY) maxY = sy
  }
  const bw = maxX - minX || 1
  const bh = maxY - minY || 1
  const margin = 48
  const s = Math.min((cw - 2 * margin) / bw, (ch - 2 * margin) / bh) * cam.zoom
  const ox = cw / 2 - ((minX + maxX) / 2) * s
  const oy = ch / 2 - ((minY + maxY) / 2) * s
  const X = (n: number) => ox + px[n] * s
  const Y = (n: number) => oy + py[n] * s

  const { val, signed, min, max } = fieldValues(snap, phase)
  const norm = (v: number) => (signed ? v / (max || 1) : (v - min) / (max - min || 1))

  // Light direction for flat shading (in screen-ish space).
  const light = normalize3(0.4, -0.5, 0.75)

  // Painter's order: farthest element first.
  const order = new Int32Array(mesh.elemCount)
  const cdepth = new Float64Array(mesh.elemCount)
  for (let e = 0; e < mesh.elemCount; e++) {
    order[e] = e
    const a = mesh.elems[e * 4]
    const b = mesh.elems[e * 4 + 1]
    const c = mesh.elems[e * 4 + 2]
    const d = mesh.elems[e * 4 + 3]
    cdepth[e] = (pd[a] + pd[b] + pd[c] + pd[d]) / 4
  }
  const ord = Array.from(order).sort((e1, e2) => cdepth[e2] - cdepth[e1])

  const flat = view === 'contour'
  for (const e of ord) {
    const a = mesh.elems[e * 4]
    const b = mesh.elems[e * 4 + 1]
    const c = mesh.elems[e * 4 + 2]
    const d = mesh.elems[e * 4 + 3]
    // Average field over the four corners.
    const fv = (val[a] + val[b] + val[c] + val[d]) / 4
    let shade = 1
    if (!flat) {
      // World-space normal of the (deflected) quad for lighting.
      const n = quadNormal(mesh, a, b, c, worldZ)
      shade = 0.55 + 0.5 * Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2])
      shade = Math.min(1.1, shade)
    }
    const base = colorFor(norm(fv), signed)
    ctx.beginPath()
    ctx.moveTo(X(a), Y(a))
    ctx.lineTo(X(b), Y(b))
    ctx.lineTo(X(c), Y(c))
    ctx.lineTo(X(d), Y(d))
    ctx.closePath()
    ctx.fillStyle = flat ? base : shadeColor(base, shade)
    ctx.fill()
    if (showMesh) {
      ctx.strokeStyle = 'rgba(10,14,23,0.35)'
      ctx.lineWidth = 0.5
      ctx.stroke()
    }
  }

  // Support glyphs (edge hatching) on the undeformed boundary — quick cue.
  drawSupports(ctx, snap, X, Y)

  // Caption + colour scale.
  ctx.fillStyle = 'rgba(210,220,240,0.9)'
  ctx.font = '12px ui-monospace, monospace'
  ctx.textAlign = 'left'
  const title =
    analysis === 'modal'
      ? modal?.modes[modeSel]
        ? `mode ${modeSel + 1}  ·  ${modal.modes[modeSel].frequency.toFixed(2)} Hz`
        : 'no mode'
      : stat
        ? `${FIELDS.find((f) => f.id === snap.field)?.label ?? ''}`
        : ''
  ctx.fillText(title, 14, 22)
  drawColorbar(ctx, cw, ch, min, max, signed, analysis === 'modal' ? '' : unitFor(snap.field))
}

function unitFor(field: Field): string {
  return field === 'w' ? 'm' : 'N'
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z) || 1
  return [x / l, y / l, z / l]
}

/** Outward normal of the deflected quad (in world x,y,z with z = worldZ). */
function quadNormal(mesh: PlateMesh, a: number, b: number, c: number, worldZ: (n: number) => number): [number, number, number] {
  const ax = mesh.x[a]
  const ay = mesh.y[a]
  const az = worldZ(a)
  const bx = mesh.x[b]
  const by = mesh.y[b]
  const bz = worldZ(b)
  const cx = mesh.x[c]
  const cy = mesh.y[c]
  const cz = worldZ(c)
  const ux = bx - ax
  const uy = by - ay
  const uz = bz - az
  const vx = cx - ax
  const vy = cy - ay
  const vz = cz - az
  let nx = uy * vz - uz * vy
  let ny = uz * vx - ux * vz
  let nz = ux * vy - uy * vx
  const l = Math.hypot(nx, ny, nz) || 1
  nx /= l
  ny /= l
  nz /= l
  if (nz < 0) {
    nx = -nx
    ny = -ny
    nz = -nz
  }
  return [nx, ny, nz]
}

function shadeColor(rgb: string, shade: number): string {
  // rgb is "rgba(r,g,b,a)" — scale the channels by shade.
  const m = rgb.match(/rgba?\(([^)]+)\)/)
  if (!m) return rgb
  const parts = m[1].split(',').map((x) => parseFloat(x))
  const r = Math.min(255, parts[0] * shade)
  const g = Math.min(255, parts[1] * shade)
  const b = Math.min(255, parts[2] * shade)
  return `rgb(${r | 0},${g | 0},${b | 0})`
}

function drawSupports(
  ctx: CanvasRenderingContext2D,
  snap: Snapshot,
  X: (n: number) => number,
  Y: (n: number) => number,
) {
  const { built } = snap
  const mesh = built.mesh
  const sc = built.sc
  ctx.lineWidth = 1
  const drawEdgeMarks = (nodes: number[], color: string) => {
    ctx.strokeStyle = color
    for (const n of nodes) {
      const x = X(n)
      const y = Y(n)
      ctx.beginPath()
      ctx.arc(x, y, 2.2, 0, 2 * Math.PI)
      ctx.stroke()
    }
  }
  const edgeColors: Record<string, string> = { clamped: 'rgba(255,150,90,0.7)', ss: 'rgba(120,200,255,0.7)' }
  ;(['left', 'right', 'bottom', 'top'] as const).forEach((ed) => {
    const bc = sc.edges[ed]
    if (bc === 'free') return
    drawEdgeMarks(edgeNodes(mesh, ed), edgeColors[bc])
  })
  if (sc.cornerSupports) {
    ctx.fillStyle = 'rgba(120,200,255,0.9)'
    for (const [xx, yy] of [
      [0, 0],
      [built.Lx, 0],
      [built.Lx, built.Ly],
      [0, built.Ly],
    ]) {
      const n = nearestCorner(mesh, xx, yy)
      ctx.beginPath()
      ctx.arc(X(n), Y(n), 4, 0, 2 * Math.PI)
      ctx.fill()
    }
  }
}

function drawColorbar(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  min: number,
  max: number,
  signed: boolean,
  unit: string,
) {
  const bx = cw - 26
  const by = 40
  const bh = Math.min(180, ch - 120)
  const bwid = 12
  const steps = 40
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1)
    const yy = by + (1 - t) * bh
    const c = signed ? rgbStr(signedColor(t * 2 - 1), 1) : rgbStr(fieldColor(t, 'turbo'), 1)
    ctx.fillStyle = c
    ctx.fillRect(bx, yy - bh / steps, bwid, bh / steps + 1)
  }
  ctx.strokeStyle = 'rgba(200,210,230,0.35)'
  ctx.lineWidth = 1
  ctx.strokeRect(bx, by - bh, bwid, bh + bh / steps)
  ctx.fillStyle = 'rgba(200,210,230,0.8)'
  ctx.font = '10px ui-monospace, monospace'
  ctx.textAlign = 'right'
  const fmt = (v: number) => (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(1) : v.toFixed(2))
  ctx.fillText(`${fmt(max)}`, bx - 3, by - bh + 8)
  ctx.fillText(`${fmt(min)}`, bx - 3, by + 4)
  if (unit) ctx.fillText(unit, bx + bwid, by + 16)
}
