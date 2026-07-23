// The Fracture studio: a self-contained tab that meshes a cracked plate on
// Keystone's own isoparametric machinery, solves it, and extracts the crack-tip
// stress-intensity factor K_I by the J- and interaction integrals — then turns
// that number into an engineering verdict against a material's fracture
// toughness K_Ic (the Griffith criterion K_I = K_Ic).
//
// Two views share one solve: the *field* (the singular stress blooming at the
// tip while the crack opens under a ramping load) and the *K(a/W) sweep* (the
// computed geometry factor traced against the closed-form handbook curve, live).
//
// Hooks discipline mirrors ThermalStudio/TopOptStudio: every live value the rAF
// loop needs is mirrored into one snapshot ref, and all canvas work happens
// inside the requestAnimationFrame callback.

import { useEffect, useMemo, useRef, useState } from 'react'
import { analyzeFracture, sweepGeometryFactor, type FractureResult, type CrackModel } from '../engine/fracture'
import {
  FRACTURE_SCENARIOS,
  FRACTURE_MATERIALS,
  fractureScenarioById,
  fractureMaterialById,
  buildModel,
  FRACTURE_DEFAULTS,
  type FractureParams,
} from '../engine/fracturepresets'
import type { QuadMesh } from '../engine/quadmesh'
import { fieldColor, rgbStr, type Colormap } from './colormap'
import { Legend, Segmented, Slider, StatTile, Toggle } from './components'
import { fmtEng } from './format'

type ViewMode = 'field' | 'sweep'
type FieldKind = 'vm' | 'syy' | 'disp'

interface Snapshot {
  res: FractureResult | null
  view: ViewMode
  field: FieldKind
  colormap: Colormap
  showMesh: boolean
  showRing: boolean
  playing: boolean
  sigma: number
  sweep: { alpha: number; Ycomputed: number; Yhandbook: number }[] | null
  fieldMax: number
}

function fit(mesh: QuadMesh, cw: number, ch: number, margin = 40) {
  const w = mesh.maxX - mesh.minX || 1
  const h = mesh.maxY - mesh.minY || 1
  const s = Math.min((cw - 2 * margin) / w, (ch - 2 * margin) / h)
  const ox = (cw - w * s) / 2 - mesh.minX * s
  const oy = (ch - h * s) / 2 + mesh.maxY * s
  return { s, toX: (x: number) => ox + x * s, toY: (y: number) => oy - y * s }
}

export function FractureStudio() {
  const [params, setParams] = useState<FractureParams>(FRACTURE_DEFAULTS)
  const [view, setView] = useState<ViewMode>('field')
  const [field, setField] = useState<FieldKind>('vm')
  const [colormap, setColormap] = useState<Colormap>('turbo')
  const [showMesh, setShowMesh] = useState(false)
  const [showRing, setShowRing] = useState(true)
  const [playing, setPlaying] = useState(true)

  const material = useMemo(() => fractureMaterialById(params.materialId), [params.materialId])
  const model: CrackModel = useMemo(() => buildModel(params), [params])

  // --- the solve (memoised) ----------------------------------------------
  const res = useMemo<FractureResult | null>(() => {
    try {
      return analyzeFracture(model)
    } catch {
      return null
    }
  }, [model])

  // --- the a/W sweep (only when that view is active; geometry-only) --------
  const sweep = useMemo(() => {
    if (view !== 'sweep') return null
    try {
      return sweepGeometryFactor({ ...model, refine: 0.8 }, 11)
    } catch {
      return null
    }
    // Y is independent of σ and material, so key only on kind/order.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, params.scenarioId, params.order])

  // Field colour scale: cap von-Mises / σyy at a few × the remote stress so the
  // singular tip saturates (physically it is infinite) while the surrounding
  // structure stays legible; displacement uses its own peak.
  const fieldMax = useMemo(() => {
    if (!res) return 1
    if (field === 'disp') {
      let m = 1e-30
      for (let i = 0; i < res.mesh.nodeCount; i++) m = Math.max(m, Math.hypot(res.dispX[i], res.dispY[i]))
      return m
    }
    return 4 * params.sigma
  }, [res, field, params.sigma])

  // --- engineering verdict (K_Ic) ----------------------------------------
  const verdict = useMemo(() => {
    if (!res) return null
    const KIc = material.KIc
    const Y = res.Yref // use the handbook factor for the closed-form critical values
    const a = model.a
    const safety = res.KI > 0 ? KIc / res.KI : Infinity
    const sigmaC = (KIc / (Y * Math.sqrt(Math.PI * a))) // critical remote stress
    const aC = Math.pow(KIc / (Y * params.sigma), 2) / Math.PI // critical crack size
    // Small-scale-yielding (LEFM validity): plastic zone r_p = (1/2π)(K/σy)².
    const rp = (1 / (2 * Math.PI)) * Math.pow(res.KI / material.sigmaY, 2)
    return { KIc, safety, sigmaC, aC, rp, willFracture: res.KI >= KIc }
  }, [res, material, model.a, params.sigma])

  // --- snapshot for the rAF loop -----------------------------------------
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const sizeRef = useRef({ w: 800, h: 520 })
  const snapRef = useRef<Snapshot>({
    res, view, field, colormap, showMesh, showRing, playing, sigma: params.sigma, sweep, fieldMax,
  })
  useEffect(() => {
    snapRef.current = { res, view, field, colormap, showMesh, showRing, playing, sigma: params.sigma, sweep, fieldMax }
  }, [res, view, field, colormap, showMesh, showRing, playing, params.sigma, sweep, fieldMax])

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
    let phase = 0 // load-ramp phase for the "crack opening" animation
    let last = 0
    const loop = (ts: number) => {
      if (!last) last = ts
      const dt = Math.min(0.05, (ts - last) / 1000)
      last = ts
      const snap = snapRef.current
      if (snap.playing) phase += dt * 0.6
      // Smooth 0→1→hold breathing of the load fraction.
      const raw = (Math.sin(phase * 2 * Math.PI - Math.PI / 2) + 1) / 2
      const loadFrac = snap.playing ? 0.15 + 0.85 * raw : 1
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
          if (snap.view === 'sweep') drawSweep(ctx, cw, ch, snap)
          else drawField(ctx, cw, ch, snap, loadFrac)
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const patch = (p: Partial<FractureParams>) => setParams((prev) => ({ ...prev, ...p }))
  const setScenario = (id: string) => {
    const sc = fractureScenarioById(id)
    setParams((prev) => ({ ...prev, scenarioId: id, alpha: sc.alpha }))
    setPlaying(true)
  }

  const fieldLabel = field === 'vm' ? 'von Mises stress' : field === 'syy' ? 'σyy (opening stress)' : 'displacement'
  const fieldUnit = field === 'disp' ? 'm' : 'Pa'

  return (
    <div className="topopt">
      <aside className="rail left">
        <div className="panel">
          <div className="panel-title">Crack configuration</div>
          {FRACTURE_SCENARIOS.map((sc) => (
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
          {FRACTURE_MATERIALS.map((mt) => (
            <button
              key={mt.id}
              className={`preset ${params.materialId === mt.id ? 'active' : ''}`}
              onClick={() => patch({ materialId: mt.id })}
            >
              <div className="preset-name">{mt.name}</div>
              <div className="preset-blurb">
                E = {fmtEng(mt.E, 'Pa')} · K_Ic = {(mt.KIc / 1e6).toFixed(mt.KIc < 1e7 ? 2 : 0)} MPa√m
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main className="stage">
        <div className="topopt-toolbar">
          <Segmented<ViewMode>
            options={[
              { value: 'field', label: '◈ Crack field' },
              { value: 'sweep', label: '↗ K(a/W) sweep' },
            ]}
            value={view}
            onChange={setView}
          />
          {view === 'field' && (
            <Segmented<FieldKind>
              options={[
                { value: 'vm', label: 'von Mises' },
                { value: 'syy', label: 'σyy' },
                { value: 'disp', label: 'Displacement' },
              ]}
              value={field}
              onChange={setField}
            />
          )}
          {view === 'field' && (
            <button className={`tool ${playing ? 'active' : ''}`} onClick={() => setPlaying((p) => !p)}>
              {playing ? '⏸ Pause' : '▶ Open'}
            </button>
          )}
          <div className="tool-hint">
            {view === 'sweep'
              ? 'geometry factor Y = K_I / (σ√πa): FE (dots) vs the closed-form handbook curve (line)'
              : res
                ? `K_I = ${(res.KI / 1e6).toFixed(2)} MPa√m · J = ${fmtEng(res.J, 'J/m²')} · ${res.nodes} nodes`
                : 'meshing…'}
          </div>
        </div>
        <div className="canvas-wrap" ref={wrapRef}>
          <canvas ref={canvasRef} />
          <div className="overlay-legend">
            {view === 'field' && res && (
              <Legend colormap={colormap} min={0} max={fieldMax} unit={fieldUnit} label={fieldLabel} />
            )}
          </div>
        </div>
      </main>

      <aside className="rail right">
        <div className="panel">
          <div className="panel-title">Stress-intensity factor</div>
          <div className="stat-grid">
            <StatTile label="K_I (interaction)" value={res ? `${(res.KI / 1e6).toFixed(2)} MPa√m` : '—'} sub="M-integral" />
            <StatTile label="J-integral" value={res ? fmtEng(res.J, 'J/m²') : '—'} sub="energy release" />
            <StatTile label="Y (computed)" value={res ? res.Y.toFixed(3) : '—'} sub="K_I/(σ√πa)" />
            <StatTile
              label="Y (handbook)"
              value={res ? res.Yref.toFixed(3) : '—'}
              sub={res ? `${(((res.Y - res.Yref) / res.Yref) * 100).toFixed(1)}% error` : ''}
            />
            <StatTile label="K_I (DCM)" value={res ? `${(res.KIdcm / 1e6).toFixed(2)} MPa√m` : '—'} sub="√r opening fit" />
            <StatTile label="J from K" value={res ? fmtEng(res.JfromK, 'J/m²') : '—'} sub="(K_I²+K_II²)/E*" />
          </div>
        </div>

        {verdict && (
          <div className="panel">
            <div className="panel-title">Fracture verdict — {material.name}</div>
            <div className={`fracture-verdict ${verdict.willFracture ? 'fail' : verdict.safety < 1.5 ? 'warn' : 'safe'}`}>
              {verdict.willFracture
                ? `✖ FRACTURES — K_I ≥ K_Ic (${(material.KIc / 1e6).toFixed(1)} MPa√m)`
                : `✓ Stable — safety factor K_Ic/K_I = ${verdict.safety.toFixed(2)}`}
            </div>
            <div className="stat-grid">
              <StatTile label="K_Ic (toughness)" value={`${(material.KIc / 1e6).toFixed(material.KIc < 1e7 ? 2 : 0)} MPa√m`} />
              <StatTile label="Safety factor" value={Number.isFinite(verdict.safety) ? verdict.safety.toFixed(2) : '∞'} sub="K_Ic / K_I" />
              <StatTile label="Critical stress" value={fmtEng(verdict.sigmaC, 'Pa')} sub="σ at K_I = K_Ic" />
              <StatTile label="Critical crack a_c" value={fmtEng(verdict.aC, 'm')} sub="at current σ" />
              <StatTile label="Plastic zone r_p" value={fmtEng(verdict.rp, 'm')} sub="(1/2π)(K/σy)²" />
              <StatTile label="a / r_p" value={verdict.rp > 0 ? (model.a / verdict.rp).toFixed(0) : '∞'} sub="LEFM valid ≫ 1" />
            </div>
          </div>
        )}

        <div className="panel">
          <div className="panel-title">Loading &amp; geometry</div>
          <Slider label="Crack length a/W" min={0.1} max={0.6} step={0.02} value={params.alpha} onChange={(v) => patch({ alpha: v })} format={(v) => v.toFixed(2)} />
          <Slider label="Remote stress σ" min={10e6} max={400e6} step={5e6} value={params.sigma} onChange={(v) => patch({ sigma: v })} format={(v) => fmtEng(v, 'Pa')} />
        </div>

        <div className="panel">
          <div className="panel-title">Display</div>
          <div className="field-label">Element order</div>
          <Segmented
            options={[
              { value: '4', label: 'Q4' },
              { value: '8', label: 'Q8' },
            ]}
            value={String(params.order)}
            onChange={(v) => patch({ order: v === '8' ? 8 : 4 })}
          />
          <div className="field-label">Colour map</div>
          <Segmented<Colormap>
            options={[
              { value: 'turbo', label: 'Turbo' },
              { value: 'viridis', label: 'Viridis' },
              { value: 'grayscale', label: 'Gray' },
            ]}
            value={colormap}
            onChange={setColormap}
          />
          <Toggle label="Mesh edges" checked={showMesh} onChange={setShowMesh} />
          <Toggle label="J-integral ring" checked={showRing} onChange={setShowRing} />
          <Slider label="Mesh refinement" min={0.6} max={1.4} step={0.1} value={params.refine} onChange={(v) => patch({ refine: v })} format={(v) => `${v.toFixed(1)}×`} />
        </div>

        <div className="panel">
          <div className="panel-title">The physics</div>
          <p className="hint-text">
            At a sharp crack the elastic stress is singular — σ ~ K/√(2πr) — so peak stress is
            meaningless and the <b>stress-intensity factor K</b> (units Pa·√m) governs failure
            instead. We never resolve the infinity: K_I is extracted by the mesh-insensitive{' '}
            <b>interaction integral</b> (superposing a unit-K Williams field to isolate the
            singularity coefficient) and cross-checked by the <b>J-integral</b> (energy released per
            unit crack advance, J = K_I²/E*). The crack runs when K_I reaches the material's fracture
            toughness K_Ic — the Griffith criterion. Every number is validated live against the
            Feddersen/Tada handbook factors.
          </p>
        </div>
      </aside>
    </div>
  )
}

// --- canvas rendering -------------------------------------------------------

function drawField(ctx: CanvasRenderingContext2D, cw: number, ch: number, snap: Snapshot, loadFrac: number) {
  ctx.clearRect(0, 0, cw, ch)
  ctx.fillStyle = '#0d0f14'
  ctx.fillRect(0, 0, cw, ch)
  const { res, field, colormap, showMesh, showRing, fieldMax } = snap
  if (!res) return
  const mesh = res.mesh
  const tf = fit(mesh, cw, ch)

  // Deformation scale: open the crack to a visible fraction of the plate.
  const diag = Math.hypot(mesh.maxX - mesh.minX, mesh.maxY - mesh.minY)
  let maxDisp = 1e-30
  for (let i = 0; i < mesh.nodeCount; i++) maxDisp = Math.max(maxDisp, Math.hypot(res.dispX[i], res.dispY[i]))
  const def = (0.12 * diag) / maxDisp * loadFrac

  const nx = new Float64Array(mesh.nodeCount)
  const ny = new Float64Array(mesh.nodeCount)
  for (let i = 0; i < mesh.nodeCount; i++) {
    nx[i] = tf.toX(mesh.x[i] + res.dispX[i] * def)
    ny[i] = tf.toY(mesh.y[i] + res.dispY[i] * def)
  }

  // Nodal field values.
  const val = (n: number): number => {
    if (field === 'vm') return res.nodalVonMises[n] * loadFrac
    if (field === 'syy') return res.nodalSyy[n] * loadFrac
    return Math.hypot(res.dispX[n], res.dispY[n]) * def
  }
  const lo = field === 'syy' ? -fieldMax * 0.25 : 0
  const hi = field === 'disp' ? fieldMax * 0.12 * diag / maxDisp : fieldMax
  const span = hi - lo || 1

  const order = mesh.order
  const tri = (a: number, b: number, c: number) => {
    const t = ((val(a) + val(b) + val(c)) / 3 - lo) / span
    ctx.fillStyle = rgbStr(fieldColor(Math.max(0, Math.min(1, t)), colormap))
    ctx.beginPath()
    ctx.moveTo(nx[a], ny[a])
    ctx.lineTo(nx[b], ny[b])
    ctx.lineTo(nx[c], ny[c])
    ctx.closePath()
    ctx.fill()
  }
  for (let e = 0; e < mesh.elemCount; e++) {
    const base = e * order
    const c0 = mesh.elems[base]
    const c1 = mesh.elems[base + 1]
    const c2 = mesh.elems[base + 2]
    const c3 = mesh.elems[base + 3]
    tri(c0, c1, c2)
    tri(c0, c2, c3)
    if (showMesh) {
      ctx.strokeStyle = 'rgba(0,0,0,0.18)'
      ctx.lineWidth = 0.4
      ctx.beginPath()
      ctx.moveTo(nx[c0], ny[c0])
      ctx.lineTo(nx[c1], ny[c1])
      ctx.lineTo(nx[c2], ny[c2])
      ctx.lineTo(nx[c3], ny[c3])
      ctx.closePath()
      ctx.stroke()
    }
  }

  // Crack faces (deformed): the traction-free lips that open under load.
  ctx.strokeStyle = '#ff4d6d'
  ctx.lineWidth = 2
  ctx.beginPath()
  const faces = res.crackFace.slice().sort((a, b) => mesh.x[a] - mesh.x[b])
  for (let i = 0; i < faces.length; i++) {
    const n = faces[i]
    if (i === 0) ctx.moveTo(nx[n], ny[n])
    else ctx.lineTo(nx[n], ny[n])
  }
  ctx.stroke()

  // Undeformed ghost of the crack plane (the closed crack).
  ctx.strokeStyle = 'rgba(150,170,200,0.35)'
  ctx.lineWidth = 0.8
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(tf.toX(mesh.minX), tf.toY(0))
  ctx.lineTo(tf.toX(res.tipX), tf.toY(0))
  ctx.stroke()
  ctx.setLineDash([])

  // The crack tip.
  const tx = tf.toX(res.tipX + res.dispX[nearestTip(res)] * def)
  const ty = tf.toY(res.tipY + res.dispY[nearestTip(res)] * def)
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(tx, ty, 3.5, 0, 2 * Math.PI)
  ctx.fill()
  ctx.strokeStyle = '#111'
  ctx.lineWidth = 1
  ctx.stroke()

  // The J-integral evaluation ring (the domain where ∇q ≠ 0).
  if (showRing) {
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'
    ctx.lineWidth = 1.2
    for (const r of [res.rin, res.rout]) {
      ctx.beginPath()
      ctx.arc(tf.toX(res.tipX), tf.toY(res.tipY), r * tf.s, 0, 2 * Math.PI)
      ctx.stroke()
    }
    ctx.fillStyle = 'rgba(255,255,255,0.7)'
    ctx.font = '11px system-ui, sans-serif'
    ctx.fillText('J-integral domain', tf.toX(res.tipX) + res.rout * tf.s + 4, tf.toY(res.tipY) - 4)
  }
}

function nearestTip(res: FractureResult): number {
  let best = 0
  let bd = Infinity
  for (let n = 0; n < res.mesh.nodeCount; n++) {
    const d = (res.mesh.x[n] - res.tipX) ** 2 + (res.mesh.y[n] - res.tipY) ** 2
    if (d < bd) {
      bd = d
      best = n
    }
  }
  return best
}

function drawSweep(ctx: CanvasRenderingContext2D, cw: number, ch: number, snap: Snapshot) {
  ctx.clearRect(0, 0, cw, ch)
  ctx.fillStyle = '#0d0f14'
  ctx.fillRect(0, 0, cw, ch)
  const data = snap.sweep
  const padL = 64
  const padR = 24
  const padT = 40
  const padB = 52
  const x0 = padL
  const x1 = cw - padR
  const y0 = ch - padB
  const y1 = padT

  // Axes ranges.
  const aLo = 0.1
  const aHi = 0.6
  let yMax = 1.2
  if (data) for (const d of data) yMax = Math.max(yMax, d.Yhandbook, Number.isFinite(d.Ycomputed) ? d.Ycomputed : 0)
  yMax = Math.ceil(yMax * 1.1 * 2) / 2
  const yLo = 0

  const sx = (a: number) => x0 + ((a - aLo) / (aHi - aLo)) * (x1 - x0)
  const sy = (y: number) => y0 - ((y - yLo) / (yMax - yLo)) * (y0 - y1)

  // Grid + axes.
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'
  ctx.fillStyle = 'rgba(220,230,245,0.75)'
  ctx.lineWidth = 1
  ctx.font = '11px system-ui, sans-serif'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (let i = 0; i <= 4; i++) {
    const y = yLo + ((yMax - yLo) * i) / 4
    const py = sy(y)
    ctx.beginPath()
    ctx.moveTo(x0, py)
    ctx.lineTo(x1, py)
    ctx.stroke()
    ctx.fillText(y.toFixed(1), x0 - 8, py)
  }
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (let i = 0; i <= 5; i++) {
    const a = aLo + ((aHi - aLo) * i) / 5
    const px = sx(a)
    ctx.beginPath()
    ctx.moveTo(px, y0)
    ctx.lineTo(px, y1)
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.stroke()
    ctx.fillStyle = 'rgba(220,230,245,0.75)'
    ctx.fillText(a.toFixed(1), px, y0 + 8)
  }
  ctx.fillStyle = 'rgba(220,230,245,0.9)'
  ctx.textBaseline = 'bottom'
  ctx.fillText('crack length  a / W', (x0 + x1) / 2, ch - 8)
  ctx.save()
  ctx.translate(18, (y0 + y1) / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.fillText('geometry factor  Y = K_I / (σ√πa)', 0, 0)
  ctx.restore()

  if (!data) {
    ctx.fillStyle = 'rgba(220,230,245,0.6)'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('computing sweep…', (x0 + x1) / 2, (y0 + y1) / 2)
    return
  }

  // Handbook line.
  ctx.strokeStyle = '#5aa9ff'
  ctx.lineWidth = 2.2
  ctx.beginPath()
  for (let i = 0; i < data.length; i++) {
    const px = sx(data[i].alpha)
    const py = sy(data[i].Yhandbook)
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.stroke()

  // Computed FE points.
  ctx.fillStyle = '#ffcf3d'
  for (const d of data) {
    if (!Number.isFinite(d.Ycomputed)) continue
    ctx.beginPath()
    ctx.arc(sx(d.alpha), sy(d.Ycomputed), 4, 0, 2 * Math.PI)
    ctx.fill()
  }

  // Legend.
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.strokeStyle = '#5aa9ff'
  ctx.lineWidth = 2.2
  ctx.beginPath()
  ctx.moveTo(x1 - 150, y1 + 6)
  ctx.lineTo(x1 - 128, y1 + 6)
  ctx.stroke()
  ctx.fillStyle = 'rgba(220,230,245,0.9)'
  ctx.fillText('handbook (Feddersen/Tada)', x1 - 122, y1 + 6)
  ctx.fillStyle = '#ffcf3d'
  ctx.beginPath()
  ctx.arc(x1 - 139, y1 + 24, 4, 0, 2 * Math.PI)
  ctx.fill()
  ctx.fillStyle = 'rgba(220,230,245,0.9)'
  ctx.fillText('FE (interaction integral)', x1 - 122, y1 + 24)
}
