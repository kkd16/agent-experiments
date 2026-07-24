// The Buckling studio: a self-contained tab that meshes a prismatic column (or
// panel) on Keystone's isoparametric machinery, solves the linear-buckling
// generalized eigenproblem (K + λK_g)φ = 0, and turns the lowest critical load
// factor into the two pictures engineers actually reason about:
//
//   • the *buckled shape* — the pre-buckling straight column shaded by its axial
//     load path, with the eigenmode animated as a breathing lateral bow, and
//   • the *column curve* — the FE critical stress dropped onto the Euler
//     hyperbola σ_cr = π²E/λ² with its yield cut-off, so you can read at a glance
//     whether the member fails by buckling or by squashing.
//
// Hooks discipline mirrors the other studios: every live value the rAF loop
// needs is mirrored into one snapshot ref, and all canvas work happens inside
// the requestAnimationFrame callback.

import { useEffect, useMemo, useRef, useState } from 'react'
import { solveBuckling, type BucklingResult } from '../engine/buckling'
import {
  BUCKLING_SCENARIOS,
  BUCKLING_MATERIALS,
  bucklingScenarioById,
  buildBuckling,
  BUCKLING_DEFAULTS,
  type BucklingParams,
  type BucklingGeometry,
} from '../engine/bucklingpresets'
import type { QuadMesh } from '../engine/quadmesh'
import { fieldColor, rgbStr, type Colormap } from './colormap'
import { Segmented, Slider, StatTile, Toggle } from './components'
import { fmtEng } from './format'

type ViewMode = 'shape' | 'curve'

interface Snapshot {
  res: BucklingResult | null
  mesh: QuadMesh
  geom: BucklingGeometry
  view: ViewMode
  modeSel: number
  colormap: Colormap
  showMesh: boolean
  playing: boolean
}

function fit(minX: number, maxX: number, minY: number, maxY: number, cw: number, ch: number, margin = 46) {
  const w = maxX - minX || 1
  const h = maxY - minY || 1
  const s = Math.min((cw - 2 * margin) / w, (ch - 2 * margin) / h)
  const ox = (cw - w * s) / 2 - minX * s
  const oy = (ch - h * s) / 2 + maxY * s
  return { s, toX: (x: number) => ox + x * s, toY: (y: number) => oy - y * s }
}

/** Corner-node local indices for a Q4/Q8 element (first four are the corners). */
const CORNERS = [0, 1, 2, 3]

export function BucklingStudio() {
  const [params, setParams] = useState<BucklingParams>(BUCKLING_DEFAULTS)
  const [view, setView] = useState<ViewMode>('shape')
  const [modeSel, setModeSel] = useState(0)
  const [colormap] = useState<Colormap>('viridis')
  const [showMesh, setShowMesh] = useState(true)
  const [playing, setPlaying] = useState(true)

  // The slenderness slider drags continuously, but each solve is a full
  // eigenproblem — debounce the commit so we solve once the drag settles, not
  // 50 times mid-drag.
  const [aspectDraft, setAspectDraft] = useState(params.aspect)
  useEffect(() => {
    if (aspectDraft === params.aspect) return
    const id = setTimeout(() => setParams((prev) => ({ ...prev, aspect: aspectDraft })), 220)
    return () => clearTimeout(id)
  }, [aspectDraft, params.aspect])

  const scenario = useMemo(() => bucklingScenarioById(params.scenarioId), [params.scenarioId])
  const built = useMemo(() => buildBuckling(params), [params])

  const res = useMemo<BucklingResult | null>(() => {
    try {
      return solveBuckling(built.input)
    } catch {
      return null
    }
  }, [built])

  // Clamp the selected mode to what actually came back.
  const effMode = res && res.modes.length ? Math.min(modeSel, res.modes.length - 1) : 0
  const mode = res?.modes[effMode] ?? null

  // --- FE vs Euler numbers ------------------------------------------------
  const stats = useMemo(() => {
    if (!res || !mode) return null
    const g = built.geom
    const Pcr = mode.loadFactor * g.refLoad
    const sigmaCr = Pcr / g.area
    const euler = g.eulerLoad
    const sigmaEuler = euler != null ? euler / g.area : null
    const relErr = euler != null && euler > 0 ? Math.abs(Pcr - euler) / euler : null
    return { Pcr, sigmaCr, euler, sigmaEuler, relErr }
  }, [res, mode, built.geom])

  // --- snapshot for the rAF loop -----------------------------------------
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const sizeRef = useRef({ w: 820, h: 540 })
  const snapRef = useRef<Snapshot>({
    res,
    mesh: built.mesh,
    geom: built.geom,
    view,
    modeSel: effMode,
    colormap,
    showMesh,
    playing,
  })
  useEffect(() => {
    snapRef.current = {
      res,
      mesh: built.mesh,
      geom: built.geom,
      view,
      modeSel: effMode,
      colormap,
      showMesh,
      playing,
    }
  }, [res, built.mesh, built.geom, view, effMode, colormap, showMesh, playing])

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
      if (snap.playing) phase += dt * 0.7
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
          if (snap.view === 'curve') drawCurve(ctx, cw, ch, snap)
          else drawShape(ctx, cw, ch, snap, phase)
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const patch = (p: Partial<BucklingParams>) => setParams((prev) => ({ ...prev, ...p }))
  const setScenario = (id: string) => {
    const sc = bucklingScenarioById(id)
    setModeSel(0)
    setParams((prev) => {
      const aspect = sc.kind === 'panel' ? prev.aspect : Math.max(prev.aspect, 30)
      setAspectDraft(aspect)
      return { ...prev, scenarioId: id, aspect }
    })
    if (sc.kind === 'panel') setView('shape')
    setPlaying(true)
  }

  const nModes = res?.modes.length ?? 0

  return (
    <div className="topopt">
      <aside className="rail left">
        <div className="panel">
          <div className="panel-title">Buckling scenario</div>
          {BUCKLING_SCENARIOS.map((sc) => (
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
          {BUCKLING_MATERIALS.map((mt) => (
            <button
              key={mt.id}
              className={`preset ${params.materialId === mt.id ? 'active' : ''}`}
              onClick={() => patch({ materialId: mt.id })}
            >
              <div className="preset-name">{mt.name}</div>
              <div className="preset-blurb">
                E = {fmtEng(mt.E, 'Pa')} · σ_y = {(mt.sigmaY / 1e6).toFixed(0)} MPa
              </div>
            </button>
          ))}
        </div>
        <div className="panel">
          <div className="panel-title">Geometry &amp; solver</div>
          {scenario.kind === 'column' && (
            <Slider
              label="Slenderness L/b"
              min={12}
              max={70}
              step={1}
              value={aspectDraft}
              onChange={setAspectDraft}
              format={(v) => v.toFixed(0)}
            />
          )}
          <Slider
            label="Modes"
            min={2}
            max={6}
            step={1}
            value={params.nModes}
            onChange={(v) => {
              setModeSel(0)
              patch({ nModes: v })
            }}
            format={(v) => v.toFixed(0)}
          />
          <div className="seg-row">
            <Segmented<'q8' | 'q4'>
              options={[
                { value: 'q8', label: 'Q8 (accurate)' },
                { value: 'q4', label: 'Q4 (locks)' },
              ]}
              value={params.order === 8 ? 'q8' : 'q4'}
              onChange={(v) => patch({ order: v === 'q8' ? 8 : 4 })}
            />
          </div>
          <Toggle label="Show mesh" checked={showMesh} onChange={setShowMesh} />
        </div>
      </aside>

      <main className="stage">
        <div className="topopt-toolbar">
          <Segmented<ViewMode>
            options={[
              { value: 'shape', label: '⟂ Buckled shape' },
              { value: 'curve', label: '↘ Column curve' },
            ]}
            value={view}
            onChange={setView}
          />
          {nModes > 0 && view === 'shape' && (
            <div className="mode-pills">
              {res!.modes.map((m, i) => (
                <button
                  key={i}
                  className={`tool ${effMode === i ? 'active' : ''}`}
                  onClick={() => setModeSel(i)}
                  title={`λ = ${m.loadFactor.toExponential(2)}`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          )}
          {view === 'shape' && (
            <button className={`tool ${playing ? 'active' : ''}`} onClick={() => setPlaying((p) => !p)}>
              {playing ? '⏸ Pause' : '▶ Buckle'}
            </button>
          )}
          <div className="tool-hint">
            {!res
              ? 'solving eigenproblem…'
              : view === 'curve'
                ? 'critical stress vs slenderness — Euler hyperbola, yield cut-off, and this design point'
                : mode
                  ? `mode ${effMode + 1} · λ_cr = ${mode.loadFactor.toExponential(3)} · ${res.freeDofCount} DOF · ${res.eigIterations} subspace iters`
                  : 'no buckling mode found'}
          </div>
        </div>
        <div className="canvas-wrap" ref={wrapRef}>
          <canvas ref={canvasRef} />
        </div>
      </main>

      <aside className="rail right">
        <div className="panel">
          <div className="panel-title">Critical load — mode {effMode + 1}</div>
          <div className="stat-grid">
            <StatTile
              label="Load factor λ_cr"
              value={mode ? mode.loadFactor.toExponential(3) : '—'}
              sub="× reference load"
            />
            <StatTile label="P_cr (FE)" value={stats ? fmtEng(stats.Pcr, 'N') : '—'} sub="critical load" />
            <StatTile
              label="P_cr (Euler)"
              value={stats?.euler != null ? fmtEng(stats.euler, 'N') : 'n/a'}
              sub={built.geom.kEff != null ? `K = ${built.geom.kEff}` : 'no 1-D analogue'}
            />
            <StatTile
              label="FE vs Euler"
              value={stats?.relErr != null ? `${(stats.relErr * 100).toFixed(2)}%` : '—'}
              sub="relative error"
            />
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">Stress &amp; slenderness</div>
          <div className="stat-grid">
            <StatTile
              label="σ_cr (FE)"
              value={stats ? `${(stats.sigmaCr / 1e6).toFixed(1)} MPa` : '—'}
              sub="critical stress"
            />
            <StatTile
              label="Slenderness"
              value={built.geom.slenderness != null ? built.geom.slenderness.toFixed(0) : 'n/a'}
              sub="KL / r"
            />
            <StatTile
              label="Radius of gyr."
              value={fmtEng(built.geom.radiusGyration, 'm')}
              sub="r = √(I/A)"
            />
            <StatTile
              label="Failure mode"
              value={
                stats
                  ? stats.sigmaCr < materialYield(params.materialId)
                    ? 'buckling'
                    : 'squash (yield)'
                  : '—'
              }
              sub={
                stats
                  ? `σ_cr / σ_y = ${(stats.sigmaCr / materialYield(params.materialId)).toFixed(2)}`
                  : ''
              }
            />
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">Higher modes</div>
          <div className="mode-list">
            {res && res.modes.length > 0 ? (
              res.modes.map((m, i) => (
                <div key={i} className={`mode-row ${effMode === i ? 'active' : ''}`}>
                  <span className="mode-idx">#{i + 1}</span>
                  <span className="mode-val">λ = {m.loadFactor.toExponential(3)}</span>
                  <span className="mode-ratio">
                    {i === 0 ? 'base' : `${(m.loadFactor / res.modes[0].loadFactor).toFixed(2)}×`}
                  </span>
                </div>
              ))
            ) : (
              <div className="mode-row">no modes</div>
            )}
          </div>
          <p className="verify-note">
            {built.geom.kEff === 2.0
              ? 'A fixed–free column buckles in the ratios 1 : 9 : 25 (odd² of the quarter-wave). Watch the ladder emerge.'
              : built.geom.kEff != null
                ? 'The subspace solver returns the lowest few eigenpairs of (K + λK_g)φ = 0.'
                : 'A compression panel buckles into a 2-D bulge with no single Euler length.'}
          </p>
        </div>
      </aside>
    </div>
  )
}

function materialYield(id: string): number {
  return BUCKLING_MATERIALS.find((m) => m.id === id)?.sigmaY ?? 250e6
}

// --- drawing ---------------------------------------------------------------

/** Element corner polygons for a deformed configuration. */
function drawMeshPolys(
  ctx: CanvasRenderingContext2D,
  mesh: QuadMesh,
  X: (n: number) => number,
  Y: (n: number) => number,
  fill: (e: number) => string | null,
  stroke: string | null,
  lw: number,
) {
  const order = mesh.order
  for (let e = 0; e < mesh.elemCount; e++) {
    const base = e * order
    ctx.beginPath()
    for (let k = 0; k < CORNERS.length; k++) {
      const n = mesh.elems[base + CORNERS[k]]
      const px = X(n)
      const py = Y(n)
      if (k === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.closePath()
    const f = fill(e)
    if (f) {
      ctx.fillStyle = f
      ctx.fill()
    }
    if (stroke) {
      ctx.strokeStyle = stroke
      ctx.lineWidth = lw
      ctx.stroke()
    }
  }
}

function drawShape(ctx: CanvasRenderingContext2D, cw: number, ch: number, snap: Snapshot, phase: number) {
  ctx.clearRect(0, 0, cw, ch)
  ctx.fillStyle = '#0a0e17'
  ctx.fillRect(0, 0, cw, ch)
  const { mesh, res } = snap
  const md = res?.modes[snap.modeSel] ?? null

  // Amplitude of the animated bow. Scale so the peak lateral deflection is a
  // healthy fraction of the model size; breathe with the animation phase.
  const span = Math.max(mesh.maxX - mesh.minX, mesh.maxY - mesh.minY)
  const amp = md ? Math.sin(phase * 2 * Math.PI) * span * 0.16 : 0

  // Fit the *deformed* extent so the bow never clips.
  const pad = md ? span * 0.18 : 0
  const t = fit(mesh.minX - pad, mesh.maxX + pad, mesh.minY, mesh.maxY, cw, ch)

  const dX = (n: number) => mesh.x[n] + (md ? amp * md.dispX[n] : 0)
  const dY = (n: number) => mesh.y[n] + (md ? amp * md.dispY[n] : 0)

  // Reference axial-stress load path (magnitude of compressive σyy).
  let smax = 1e-30
  if (res) for (let n = 0; n < mesh.nodeCount; n++) smax = Math.max(smax, Math.abs(res.refSyy[n]))

  // Undeformed ghost.
  drawMeshPolys(
    ctx,
    mesh,
    (n) => t.toX(mesh.x[n]),
    (n) => t.toY(mesh.y[n]),
    () => 'rgba(120,140,175,0.05)',
    'rgba(120,140,175,0.14)',
    0.6,
  )

  // Deformed (buckled) shape, shaded by the reference axial load path.
  const order = mesh.order
  drawMeshPolys(
    ctx,
    mesh,
    (n) => t.toX(dX(n)),
    (n) => t.toY(dY(n)),
    (e) => {
      if (!res) return 'rgba(90,150,230,0.5)'
      let s = 0
      for (let k = 0; k < CORNERS.length; k++) s += Math.abs(res.refSyy[mesh.elems[e * order + CORNERS[k]]])
      s /= CORNERS.length
      const c = fieldColor(Math.min(1, s / smax), snap.colormap)
      return rgbStr(c, 0.9)
    },
    snap.showMesh ? 'rgba(10,14,23,0.55)' : null,
    0.5,
  )

  // Load arrows on the loaded (top) edge.
  ctx.fillStyle = '#ff6b6b'
  ctx.strokeStyle = '#ff6b6b'
  ctx.lineWidth = 1.5
  const topY = t.toY(mesh.maxY + pad * 0.15)
  const nArr = 7
  for (let i = 0; i <= nArr; i++) {
    const fx = mesh.minX + ((mesh.maxX - mesh.minX) * i) / nArr
    const sx = t.toX(fx)
    ctx.beginPath()
    ctx.moveTo(sx, topY - 22)
    ctx.lineTo(sx, topY - 4)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(sx - 3, topY - 9)
    ctx.lineTo(sx, topY - 3)
    ctx.lineTo(sx + 3, topY - 9)
    ctx.fill()
  }

  // Support hatching at the base.
  ctx.strokeStyle = 'rgba(200,210,230,0.6)'
  ctx.lineWidth = 1
  const baseY = t.toY(mesh.minY)
  const x0 = t.toX(mesh.minX)
  const x1 = t.toX(mesh.maxX)
  ctx.beginPath()
  ctx.moveTo(x0, baseY)
  ctx.lineTo(x1, baseY)
  ctx.stroke()
  for (let x = x0; x < x1; x += 9) {
    ctx.beginPath()
    ctx.moveTo(x, baseY)
    ctx.lineTo(x - 7, baseY + 7)
    ctx.stroke()
  }

  // Caption.
  ctx.fillStyle = 'rgba(210,220,240,0.85)'
  ctx.font = '12px ui-monospace, monospace'
  ctx.textAlign = 'left'
  if (md) {
    ctx.fillText(
      `buckling mode ${snap.modeSel + 1}   λ_cr = ${md.loadFactor.toExponential(3)}`,
      14,
      22,
    )
  }
}

function drawCurve(ctx: CanvasRenderingContext2D, cw: number, ch: number, snap: Snapshot) {
  ctx.clearRect(0, 0, cw, ch)
  ctx.fillStyle = '#0a0e17'
  ctx.fillRect(0, 0, cw, ch)
  const { geom, res } = snap
  const E = geom.E

  const pad = { l: 64, r: 22, t: 26, b: 46 }
  const plotW = cw - pad.l - pad.r
  const plotH = ch - pad.t - pad.b

  // Axes: slenderness 0..λmax, stress 0..σy·1.18. Stretch the slenderness axis
  // so the current design point always lands inside the plot.
  const sy = materialYieldFromE(geom)
  const lambdaMax = Math.max(220, (geom.slenderness ?? 0) * 1.15)
  const sMax = sy * 1.18

  const xOf = (lam: number) => pad.l + (Math.min(lam, lambdaMax) / lambdaMax) * plotW
  const yOf = (s: number) => pad.t + (1 - Math.min(s, sMax) / sMax) * plotH

  // Grid + axes.
  ctx.strokeStyle = 'rgba(120,140,175,0.16)'
  ctx.lineWidth = 1
  ctx.fillStyle = 'rgba(180,195,220,0.7)'
  ctx.font = '11px ui-monospace, monospace'
  ctx.textAlign = 'right'
  for (let i = 0; i <= 4; i++) {
    const s = (sMax * i) / 4
    const y = yOf(s)
    ctx.beginPath()
    ctx.moveTo(pad.l, y)
    ctx.lineTo(cw - pad.r, y)
    ctx.stroke()
    ctx.fillText(`${(s / 1e6).toFixed(0)}`, pad.l - 8, y + 4)
  }
  ctx.textAlign = 'center'
  for (let i = 0; i <= 4; i++) {
    const lam = (lambdaMax * i) / 4
    const x = xOf(lam)
    ctx.beginPath()
    ctx.moveTo(x, pad.t)
    ctx.lineTo(x, ch - pad.b)
    ctx.stroke()
    ctx.fillText(`${lam.toFixed(0)}`, x, ch - pad.b + 18)
  }
  ctx.fillStyle = 'rgba(210,220,240,0.85)'
  ctx.fillText('slenderness  λ = KL / r', pad.l + plotW / 2, ch - 10)
  ctx.save()
  ctx.translate(16, pad.t + plotH / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.fillText('critical stress  σ_cr  (MPa)', 0, 0)
  ctx.restore()

  // Yield plateau.
  ctx.strokeStyle = 'rgba(255,180,90,0.85)'
  ctx.setLineDash([6, 4])
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(xOf(0), yOf(sy))
  ctx.lineTo(xOf(lambdaMax), yOf(sy))
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = 'rgba(255,180,90,0.9)'
  ctx.textAlign = 'left'
  ctx.fillText('σ_y (squash)', xOf(lambdaMax) - 96, yOf(sy) - 6)

  // Euler hyperbola σ_cr = π²E/λ².
  ctx.strokeStyle = 'rgba(90,180,255,0.95)'
  ctx.lineWidth = 2
  ctx.beginPath()
  let started = false
  for (let lam = 1; lam <= lambdaMax; lam += 1) {
    const s = (Math.PI * Math.PI * E) / (lam * lam)
    if (s > sMax) continue
    const x = xOf(lam)
    const y = yOf(s)
    if (!started) {
      ctx.moveTo(x, y)
      started = true
    } else ctx.lineTo(x, y)
  }
  ctx.stroke()
  ctx.fillStyle = 'rgba(90,180,255,0.95)'
  ctx.fillText('Euler  π²E/λ²', xOf(lambdaMax * 0.5), yOf((Math.PI * Math.PI * E) / (lambdaMax * 0.5) ** 2) - 8)

  // Transition slenderness λ₁ = π√(E/σy).
  const lam1 = Math.PI * Math.sqrt(E / sy)
  ctx.strokeStyle = 'rgba(200,210,230,0.35)'
  ctx.setLineDash([3, 4])
  ctx.beginPath()
  ctx.moveTo(xOf(lam1), pad.t)
  ctx.lineTo(xOf(lam1), ch - pad.b)
  ctx.stroke()
  ctx.setLineDash([])

  // The design point(s).
  if (res && geom.slenderness != null && geom.eulerLoad != null) {
    const lam = geom.slenderness
    const md = res.modes[Math.min(snap.modeSel, res.modes.length - 1)]
    const sigmaFE = md ? (md.loadFactor * geom.refLoad) / geom.area : 0
    const sigmaEuler = geom.eulerLoad / geom.area
    // Euler point (hollow).
    ctx.strokeStyle = 'rgba(90,180,255,1)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(xOf(lam), yOf(sigmaEuler), 6, 0, 2 * Math.PI)
    ctx.stroke()
    // FE point (filled).
    ctx.fillStyle = '#7CFFB2'
    ctx.beginPath()
    ctx.arc(xOf(lam), yOf(sigmaFE), 5, 0, 2 * Math.PI)
    ctx.fill()
    ctx.strokeStyle = 'rgba(10,14,23,0.8)'
    ctx.lineWidth = 1
    ctx.stroke()
    // Callout.
    ctx.fillStyle = 'rgba(220,255,235,0.95)'
    ctx.textAlign = 'left'
    ctx.font = '12px ui-monospace, monospace'
    const lx = Math.min(xOf(lam) + 12, cw - pad.r - 150)
    ctx.fillText(`FE  σ_cr = ${(sigmaFE / 1e6).toFixed(1)} MPa`, lx, yOf(sigmaFE) - 10)
    ctx.fillStyle = 'rgba(150,200,255,0.9)'
    ctx.fillText(`Euler ${(sigmaEuler / 1e6).toFixed(1)} MPa`, lx, yOf(sigmaFE) + 6)
  } else {
    ctx.fillStyle = 'rgba(180,195,220,0.7)'
    ctx.textAlign = 'center'
    ctx.fillText('panel scenario — no single-slenderness column point', pad.l + plotW / 2, pad.t + plotH / 2)
  }
}

/** The yield stress belongs to the material; the curve module only has geometry,
 *  so we recover σ_y from the material via the studio-level lookup embedded in E. */
function materialYieldFromE(geom: BucklingGeometry): number {
  const m = BUCKLING_MATERIALS.find((mm) => Math.abs(mm.E - geom.E) < 1)
  return m?.sigmaY ?? 250e6
}
