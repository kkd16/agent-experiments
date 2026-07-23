// The Thermal & Multiphysics studio: a self-contained tab that solves heat
// conduction on Keystone's own isoparametric mesh and then couples the
// temperature field into elasticity to show the stress a part builds up with no
// external load at all. Like the topology-optimization tab it owns its canvas,
// animation loop and controls, and never touches the frame/continuum viewport.
//
// Two views share one solve: the *temperature* field (steady or an animated
// transient warm-up) and the *thermal stress* it induces (deformed shape shaded
// by von Mises). The material and boundary-condition sliders reshape the physics
// live; the scenario picker on the left swaps the geometry + BC topology.
//
// Hooks discipline mirrors TopOptStudio: every live value the rAF loop needs is
// mirrored into a single snapshot ref inside an after-render effect, and all
// canvas work happens inside the requestAnimationFrame callback.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  solveThermalSteady,
  solveThermalTransient,
  type ThermalInput,
  type ThermalResult,
  type ThermalTransientResult,
} from '../engine/thermal'
import { solveThermoelastic, type ThermoelasticResult } from '../engine/thermoelastic'
import { solveTransientThermoelastic, type TransientTeResult, type TeFrame } from '../engine/coupled'
import {
  THERMAL_SCENARIOS,
  thermalScenarioById,
  type ThermalParams,
} from '../engine/thermalpresets'
import type { QuadMesh, EdgeName } from '../engine/quadmesh'
import { boundaryElementEdges } from '../engine/quadmesh'
import { fieldColor, rgbStr, type Colormap } from './colormap'
import { Legend, Segmented, Slider, StatTile, Toggle } from './components'
import { fmtEng } from './format'

type Mode = 'steady' | 'transient'
type ViewField = 'temperature' | 'stress'

interface Params extends ThermalParams {
  scenarioId: string
  order: 4 | 8
  density: number
}

const DEFAULTS: Params = {
  scenarioId: THERMAL_SCENARIOS[0].id,
  order: 4,
  density: 1,
  k: 45, // ~ carbon steel W/m·K
  rhoc: 3.6e6, // ρc for steel J/m³·K
  alpha: 12e-6, // 1/K
  E: 200e9, // Pa
  Thot: 200,
  Tcold: 25,
  h: 60,
  Tinf: 25,
  gen: 4e6,
  Tref: 25,
  T0: 25,
}

const buildKeyOf = (p: Params, nonce: number) =>
  `${p.scenarioId}|${p.order}|${p.density}|${p.k}|${p.rhoc}|${p.Thot}|${p.Tcold}|${p.h}|${p.Tinf}|${p.gen}|${nonce}`

interface Solved {
  input: ThermalInput
  teFix: ReturnType<(typeof THERMAL_SCENARIOS)[number]['build']>['teFix']
  steady: ThermalResult | null
  transient: ThermalTransientResult | null
  te: ThermoelasticResult | null
  teTransient: TransientTeResult | null
}

interface Snapshot {
  solved: Solved
  mode: Mode
  view: ViewField
  showFlux: boolean
  showMesh: boolean
  colormap: Colormap
  playing: boolean
  tRange: [number, number]
}

function fit(mesh: QuadMesh, cw: number, ch: number, margin = 34) {
  const w = mesh.maxX - mesh.minX || 1
  const h = mesh.maxY - mesh.minY || 1
  const s = Math.min((cw - 2 * margin) / w, (ch - 2 * margin) / h)
  const ox = (cw - w * s) / 2 - mesh.minX * s
  const oy = (ch - h * s) / 2 + mesh.maxY * s // flip y (screen down)
  return {
    s,
    toX: (x: number) => ox + x * s,
    toY: (y: number) => oy - y * s,
  }
}

export function ThermalStudio() {
  const [params, setParams] = useState<Params>(DEFAULTS)
  const [nonce, setNonce] = useState(0)
  const [mode, setMode] = useState<Mode>('steady')
  const [view, setView] = useState<ViewField>('temperature')
  const [showFlux, setShowFlux] = useState(true)
  const [showMesh, setShowMesh] = useState(false)
  const [colormap, setColormap] = useState<Colormap>('turbo')
  const [playing, setPlaying] = useState(true)
  const [clock, setClock] = useState({ t: 0, dur: 1 }) // for the transient readout

  const scenario = useMemo(() => thermalScenarioById(params.scenarioId), [params.scenarioId])
  const buildKey = buildKeyOf(params, nonce)

  // --- solve (memoised) ---------------------------------------------------
  const solved: Solved = useMemo(() => {
    const { input, teFix } = scenario.build(params.order, params.density, params)
    let steady: ThermalResult | null
    let transient: ThermalTransientResult | null = null
    let te: ThermoelasticResult | null = null
    let teTransient: TransientTeResult | null = null
    try {
      steady = solveThermalSteady(input)
    } catch {
      steady = null
    }
    if (mode === 'transient') {
      try {
        transient = solveThermalTransient(input)
      } catch {
        transient = null
      }
    }
    const mech = {
      E: params.E,
      nu: 0.3,
      alpha: params.alpha,
      thickness: input.thickness,
      Tref: params.Tref,
      fix: teFix,
    }
    if (view === 'stress' && steady) {
      try {
        te = solveThermoelastic({ mesh: input.mesh, T: steady.T, ...mech })
      } catch {
        te = null
      }
      if (mode === 'transient') {
        try {
          teTransient = solveTransientThermoelastic(input, mech, { stressFrames: 28 })
        } catch {
          teTransient = null
        }
      }
    }
    return { input, teFix, steady, transient, te, teTransient }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildKey, mode, view, params.E, params.alpha, params.Tref, scenario])

  const tRange = useMemo<[number, number]>(() => {
    const s = solved.steady
    const lo = Math.min(params.T0, params.Tinf, s?.minT ?? params.Tcold)
    const hi = Math.max(params.T0, s?.maxT ?? params.Thot)
    return [lo, hi === lo ? lo + 1 : hi]
  }, [solved.steady, params.T0, params.Tinf, params.Tcold, params.Thot])

  // Von-Mises colour/legend scale for the stress view: the whole-movie peak for a
  // transient, else the steady field's own nodal maximum.
  const stressMax = useMemo(() => {
    if (mode === 'transient' && solved.teTransient?.ok) return solved.teTransient.maxVonMisesOverall
    if (solved.te) {
      let m = 0
      for (const v of solved.te.nodalVonMises) if (v > m) m = v
      return m
    }
    return 0
  }, [mode, solved.teTransient, solved.te])

  // --- snapshot for the rAF loop ------------------------------------------
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const sizeRef = useRef({ w: 800, h: 520 })
  const snapRef = useRef<Snapshot>({
    solved, mode, view, showFlux, showMesh, colormap, playing, tRange,
  })
  useEffect(() => {
    snapRef.current = { solved, mode, view, showFlux, showMesh, colormap, playing, tRange }
  }, [solved, mode, view, showFlux, showMesh, colormap, playing, tRange])

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

  // --- draw + animate (single rAF) ----------------------------------------
  useEffect(() => {
    let raf = 0
    let tClock = 0 // seconds into the transient record
    let last = 0
    let lastReadout = 0
    const loop = (ts: number) => {
      if (!last) last = ts
      const dt = Math.min(0.05, (ts - last) / 1000)
      last = ts
      const snap = snapRef.current
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

          // Advance the transient clock — either the temperature warm-up or the
          // coupled thermal-stress "movie", depending on the active view.
          const tr = snap.solved.transient
          const tt = snap.solved.teTransient
          const stressMovie = snap.mode === 'transient' && snap.view === 'stress' && !!tt?.ok
          const tempMovie = snap.mode === 'transient' && snap.view === 'temperature' && !!tr && tr.frames.length > 0
          let frameT: Float64Array | null = null
          let teFrame: TeFrame | null = null
          let tNow = 0
          let dur = 1
          if (stressMovie) {
            const frames = tt!.frames
            dur = frames[frames.length - 1].t || 1
            if (snap.playing) {
              tClock += dt * (dur / 6)
              if (tClock > dur) tClock = 0
            }
            tNow = tClock
            let idx = 0
            for (let i = 0; i < frames.length; i++) if (frames[i].t <= tNow) idx = i
            teFrame = frames[idx]
          } else if (tempMovie) {
            dur = tr!.times[tr!.times.length - 1] || 1
            if (snap.playing) {
              // Play the whole record in ~6 s of wall time, then loop.
              tClock += dt * (dur / 6)
              if (tClock > dur) tClock = 0
            }
            tNow = tClock
            let idx = 0
            for (let i = 0; i < tr!.times.length; i++) if (tr!.times[i] <= tNow) idx = i
            frameT = tr!.frames[idx]
          }
          drawThermal(ctx, cw, ch, snap, frameT, teFrame)
          if (ts - lastReadout > 120) {
            lastReadout = ts
            setClock({ t: tNow, dur })
          }
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  // --- handlers -----------------------------------------------------------
  const patch = (p: Partial<Params>) => setParams((prev) => ({ ...prev, ...p }))
  const setScenario = (id: string) => {
    setParams((prev) => ({ ...prev, scenarioId: id }))
    setNonce((n) => n + 1)
    setPlaying(true)
  }
  const restart = () => {
    setNonce((n) => n + 1)
    setPlaying(true)
  }

  const s = solved.steady
  const te = solved.te
  const isGen = scenario.id === 'chip-sink' || scenario.id === 'gen-bar'
  const hasConv =
    scenario.id === 'chip-sink' || scenario.id === 'convective-fin'

  return (
    <div className="topopt">
      <aside className="rail left">
        <div className="panel">
          <div className="panel-title">Scenario</div>
          {THERMAL_SCENARIOS.map((sc) => (
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
      </aside>

      <main className="stage">
        <div className="topopt-toolbar">
          <Segmented<Mode>
            options={[
              { value: 'steady', label: 'Steady state' },
              { value: 'transient', label: 'Transient' },
            ]}
            value={mode}
            onChange={(v) => {
              setMode(v)
              setPlaying(true)
            }}
          />
          <Segmented<ViewField>
            options={[
              { value: 'temperature', label: '🌡 Temperature' },
              { value: 'stress', label: '◆ Thermal stress' },
            ]}
            value={view}
            onChange={setView}
          />
          {mode === 'transient' && (
            <button className={`tool ${playing ? 'active' : ''}`} onClick={() => setPlaying((p) => !p)}>
              {playing ? '⏸ Pause' : '▶ Play'}
            </button>
          )}
          <button className="tool" onClick={restart}>
            ↺ Restart
          </button>
          <div className="tool-hint">
            {mode === 'transient'
              ? view === 'stress'
                ? `stress movie · t = ${clock.t.toFixed(0)} / ${clock.dur.toFixed(0)} s${
                    solved.teTransient?.ok ? ` · peak σ at ${solved.teTransient.peakTime.toFixed(0)} s` : ''
                  }`
                : `warm-up · t = ${clock.t.toFixed(0)} / ${clock.dur.toFixed(0)} s`
              : view === 'stress'
                ? 'stress induced by the steady temperature field — no external load'
                : 'steady-state conduction'}
          </div>
        </div>
        <div className="canvas-wrap" ref={wrapRef}>
          <canvas ref={canvasRef} />
          <div className="overlay-legend">
            {view === 'temperature' ? (
              <Legend colormap={colormap} min={tRange[0]} max={tRange[1]} unit="°C" label="temperature" />
            ) : (
              stressMax > 0 && (
                <Legend colormap={colormap} min={0} max={stressMax} unit="Pa" label="von Mises (thermal)" />
              )
            )}
          </div>
        </div>
      </main>

      <aside className="rail right">
        <div className="panel">
          <div className="panel-title">{scenario.name}</div>
          <p className="hint-text">{scenario.blurb}</p>
          <div className="stat-grid">
            <StatTile label="Max temp" value={s ? fmtEng(s.maxT, '°C') : '—'} />
            <StatTile label="Min temp" value={s ? fmtEng(s.minT, '°C') : '—'} />
            <StatTile label="Peak flux" value={s ? fmtEng(s.maxFlux, 'W/m²') : '—'} sub="q = −κ∇T" />
            <StatTile
              label="Balance resid"
              value={s ? s.residual.toExponential(1) : '—'}
              sub="‖KT−Q‖ (→0)"
            />
            {view === 'stress' && (
              <>
                <StatTile
                  label={mode === 'transient' ? 'Peak σ (VM)' : 'Max σ (VM)'}
                  value={stressMax > 0 ? fmtEng(stressMax, 'Pa') : '—'}
                  sub={mode === 'transient' ? 'over the warm-up' : 'thermal stress'}
                />
                <StatTile
                  label="Max motion"
                  value={
                    mode === 'transient'
                      ? solved.teTransient?.ok
                        ? fmtEng(solved.teTransient.maxDispOverall, 'm')
                        : '—'
                      : te
                        ? fmtEng(te.maxDisp, 'm')
                        : '—'
                  }
                  sub="thermal growth"
                />
              </>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">Boundary conditions</div>
          <Slider label="Hot / source temp" min={40} max={400} step={5} value={params.Thot} onChange={(v) => patch({ Thot: v })} format={(v) => `${v.toFixed(0)} °C`} />
          <Slider label="Cold / sink temp" min={-20} max={80} step={5} value={params.Tcold} onChange={(v) => patch({ Tcold: v })} format={(v) => `${v.toFixed(0)} °C`} />
          {hasConv && (
            <>
              <Slider label="Film coefficient h" min={5} max={300} step={5} value={params.h} onChange={(v) => patch({ h: v })} format={(v) => `${v.toFixed(0)} W/m²K`} />
              <Slider label="Ambient T∞" min={-10} max={60} step={5} value={params.Tinf} onChange={(v) => patch({ Tinf: v })} format={(v) => `${v.toFixed(0)} °C`} />
            </>
          )}
          {isGen && (
            <Slider label="Heat generation q‴" min={0} max={2e7} step={2e5} value={params.gen} onChange={(v) => patch({ gen: v })} format={(v) => fmtEng(v, 'W/m³')} />
          )}
        </div>

        <div className="panel">
          <div className="panel-title">Material</div>
          <Slider label="Conductivity κ" min={1} max={400} step={1} value={params.k} onChange={(v) => patch({ k: v })} format={(v) => `${v.toFixed(0)} W/mK`} />
          {mode === 'transient' && (
            <Slider label="Heat capacity ρc" min={5e5} max={5e6} step={1e5} value={params.rhoc} onChange={(v) => patch({ rhoc: v })} format={(v) => fmtEng(v, 'J/m³K')} />
          )}
          {view === 'stress' && (
            <>
              <Slider label="Expansion α" min={1e-6} max={30e-6} step={1e-6} value={params.alpha} onChange={(v) => patch({ alpha: v })} format={(v) => `${(v * 1e6).toFixed(0)} µε/K`} />
              <Slider label="Young's modulus E" min={20e9} max={400e9} step={5e9} value={params.E} onChange={(v) => patch({ E: v })} format={(v) => fmtEng(v, 'Pa')} />
            </>
          )}
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
          {view === 'temperature' && (
            <Toggle label="Heat-flux arrows" checked={showFlux} onChange={setShowFlux} />
          )}
          <Toggle label="Mesh edges" checked={showMesh} onChange={setShowMesh} />
          <Slider label="Mesh density" min={0.6} max={1.8} step={0.1} value={params.density} onChange={(v) => patch({ density: v })} format={(v) => `${v.toFixed(1)}×`} />
        </div>

        <div className="panel">
          <div className="panel-title">The physics</div>
          <p className="hint-text">
            {view === 'temperature'
              ? mode === 'transient'
                ? 'C·Ṫ + K_c·T = Q marched by the unconditionally-stable θ-method (Crank–Nicolson) — the part warming from ambient toward its steady field.'
                : '(K_c + H)·T = Q: conductivity ∫(∇N)ᵀκ(∇N), edge convection ∫Nᵀh N, and loads from generation q‴, edge flux and ambient h·T∞. Flux q = −κ∇T.'
              : mode === 'transient'
                ? 'Transient thermal stress: a thermoelastic solve at each conduction time-step, so you watch the self-stress build as the part heats. Because the hot skin grows against a still-cold core, the von-Mises peak can spike *during* the warm-up (thermal shock) before easing toward its steady value.'
                : 'Thermoelastic coupling: the thwarted thermal strain ε₀ = αΔT enters elasticity as a load f_th = ∫Bᵀ D ε₀, and σ = D(Bu − ε₀). The part stresses itself with no external load — bright bands are where expansion is most restrained.'}
          </p>
        </div>
      </aside>
    </div>
  )
}

// --- canvas rendering -------------------------------------------------------

function drawThermal(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  snap: Snapshot,
  frameT: Float64Array | null,
  teFrame: TeFrame | null,
) {
  ctx.clearRect(0, 0, cw, ch)
  ctx.fillStyle = '#0d0f14'
  ctx.fillRect(0, 0, cw, ch)
  const { solved, view, colormap, showFlux, showMesh, tRange } = snap
  const mesh = solved.input.mesh
  const steady = solved.steady
  const te = solved.te
  if (!steady) return

  // Stress source: a transient movie frame if present, else the steady coupling.
  const teField = teFrame
    ? { nodalVonMises: teFrame.nodalVonMises, dispX: teFrame.dispX, dispY: teFrame.dispY }
    : te
      ? { nodalVonMises: te.nodalVonMises, dispX: te.dispX, dispY: te.dispY }
      : null
  const stress = view === 'stress' && !!teField
  const field = stress ? teField!.nodalVonMises : frameT ?? steady.T
  let lo = tRange[0]
  let hi = tRange[1]
  if (stress) {
    lo = 0
    // Stable nodal scale: the whole-movie peak for a transient, else this
    // field's own nodal maximum (so the concentration doesn't clip).
    if (teFrame) hi = solved.teTransient?.maxVonMisesOverall || 1
    else {
      let m = 0
      for (let i = 0; i < field.length; i++) if (field[i] > m) m = field[i]
      hi = m || 1
    }
  }
  const span = hi - lo || 1

  // Deformation for the stress view (auto-scaled to ~10% of the diagonal, using
  // the movie-wide peak so the shape grows smoothly instead of re-normalising).
  let def = 0
  const dispBasis = teFrame ? solved.teTransient?.maxDispOverall ?? 0 : te?.maxDisp ?? 0
  if (stress && dispBasis > 0) {
    const diag = Math.hypot(mesh.maxX - mesh.minX, mesh.maxY - mesh.minY)
    def = (0.1 * diag) / dispBasis
  }

  const tf = fit(mesh, cw, ch)
  const nx = new Float64Array(mesh.nodeCount)
  const ny = new Float64Array(mesh.nodeCount)
  for (let i = 0; i < mesh.nodeCount; i++) {
    let x = mesh.x[i]
    let y = mesh.y[i]
    if (stress && teField) {
      x += teField.dispX[i] * def
      y += teField.dispY[i] * def
    }
    nx[i] = tf.toX(x)
    ny[i] = tf.toY(y)
  }

  const order = mesh.order
  const tri = (a: number, b: number, c: number) => {
    const t = ((field[a] + field[b] + field[c]) / 3 - lo) / span
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
      ctx.strokeStyle = 'rgba(0,0,0,0.22)'
      ctx.lineWidth = 0.5
      ctx.beginPath()
      ctx.moveTo(nx[c0], ny[c0])
      ctx.lineTo(nx[c1], ny[c1])
      ctx.lineTo(nx[c2], ny[c2])
      ctx.lineTo(nx[c3], ny[c3])
      ctx.closePath()
      ctx.stroke()
    }
  }

  // Undeformed ghost outline in the stress view.
  if (stress && def !== 0) {
    ctx.strokeStyle = 'rgba(150,170,200,0.35)'
    ctx.lineWidth = 0.6
    ctx.beginPath()
    for (let e = 0; e < mesh.elemCount; e++) {
      const base = e * order
      const c = [0, 1, 2, 3].map((k) => mesh.elems[base + k])
      ctx.moveTo(tf.toX(mesh.x[c[0]]), tf.toY(mesh.y[c[0]]))
      for (let k = 1; k < 4; k++) ctx.lineTo(tf.toX(mesh.x[c[k]]), tf.toY(mesh.y[c[k]]))
      ctx.closePath()
    }
    ctx.stroke()
  }

  // Heat-flux arrows (temperature view): sub-sample element centroids.
  if (!stress && showFlux) {
    const flux = steady.elementFlux
    let maxMag = 1e-30
    for (const f of flux) maxMag = Math.max(maxMag, f.mag)
    const stepN = Math.max(1, Math.round(Math.sqrt(flux.length) / 14))
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'
    ctx.fillStyle = 'rgba(255,255,255,0.7)'
    ctx.lineWidth = 1
    for (let e = 0; e < flux.length; e += stepN) {
      const f = flux[e]
      if (f.mag < 1e-9) continue
      const len = 8 + 14 * (f.mag / maxMag)
      const ang = Math.atan2(-f.qy, f.qx) // screen y down
      const x0 = tf.toX(f.cx)
      const y0 = tf.toY(f.cy)
      const x1 = x0 + Math.cos(ang) * len
      const y1 = y0 + Math.sin(ang) * len
      ctx.beginPath()
      ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x1 - 4 * Math.cos(ang - 0.4), y1 - 4 * Math.sin(ang - 0.4))
      ctx.lineTo(x1 - 4 * Math.cos(ang + 0.4), y1 - 4 * Math.sin(ang + 0.4))
      ctx.closePath()
      ctx.fill()
    }
  }

  // Boundary-condition glyphs along the edges.
  drawBCGlyphs(ctx, mesh, solved.input, stress ? solved.teFix : null, tf)
}

function drawBCGlyphs(
  ctx: CanvasRenderingContext2D,
  mesh: QuadMesh,
  input: ThermalInput,
  teFix: Solved['teFix'] | null,
  tf: ReturnType<typeof fit>,
) {
  const edges: EdgeName[] = ['left', 'right', 'top', 'bottom']
  for (const edge of edges) {
    const bc = input.bcs[edge]
    if (!bc || bc.kind === 'insulated') continue
    let color = '#8fb0ff'
    let dashed = false
    if (bc.kind === 'temp') color = bc.value >= (input.T0 ?? 25) ? '#ff5d5d' : '#5aa9ff'
    else if (bc.kind === 'convection') {
      color = '#f5b642'
      dashed = true
    } else if (bc.kind === 'flux') color = '#ff8a3d'
    ctx.strokeStyle = color
    ctx.lineWidth = 3
    ctx.setLineDash(dashed ? [5, 4] : [])
    for (const nodes of boundaryElementEdges(mesh, edge)) {
      const a = nodes[0]
      const b = nodes[nodes.length - 1]
      ctx.beginPath()
      ctx.moveTo(tf.toX(mesh.x[a]), tf.toY(mesh.y[a]))
      ctx.lineTo(tf.toX(mesh.x[b]), tf.toY(mesh.y[b]))
      ctx.stroke()
    }
    ctx.setLineDash([])
  }
  // Mechanical restraints (stress view): little green hatched triangles.
  if (teFix) {
    ctx.fillStyle = '#3ddc97'
    for (const g of teFix) {
      const nodes = g.edge
        ? boundaryElementEdges(mesh, g.edge).flatMap((n) => [n[0], n[n.length - 1]])
        : g.nodes ?? []
      const seen = new Set<number>()
      for (const n of nodes) {
        if (seen.has(n)) continue
        seen.add(n)
        const x = tf.toX(mesh.x[n])
        const y = tf.toY(mesh.y[n])
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(x - 4, y + 7)
        ctx.lineTo(x + 4, y + 7)
        ctx.closePath()
        ctx.fill()
      }
    }
  }
}
