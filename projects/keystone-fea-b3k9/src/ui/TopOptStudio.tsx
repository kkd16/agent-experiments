// The topology-optimization studio: a self-contained tab that lets the FEA
// engine *design* structures rather than merely analyse them. Pick a load case
// and a material budget, press Run, and watch the SIMP optimizer grow the
// stiffest possible layout — the iconic organic truss — live on a canvas, one
// Optimality-Criteria iteration per frame.
//
// This component owns its own canvas, animation loop, and controls; it does not
// touch the frame/continuum viewport machinery, so the two never interfere.
//
// Hooks discipline: all live control values are mirrored into a single snapshot
// ref inside an after-render effect, and the requestAnimationFrame loop (mounted
// once) reads that snapshot and drives the optimizer + throttled setState from
// inside the rAF callback — never from an effect body or during render.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TopOpt, PROBLEMS, problemById, type FilterKind, type TopOptStep } from '../engine/topopt'
import { fieldColor, type Colormap } from './colormap'
import { Segmented, Slider, StatTile, Toggle } from './components'

type Shade = 'ink' | 'energy'

interface Params {
  problemId: string
  nelx: number
  nely: number
  volfrac: number
  penal: number
  rmin: number
  filter: FilterKind
}

interface Snapshot {
  params: Params
  buildKey: string
  running: boolean
  converged: boolean
  shade: Shade
  colormap: Colormap
  showBC: boolean
  threshold: number
}

const HIST_MAX = 400

/** Extract the loaded / supported node coordinates from a spec, for BC glyphs. */
function bcMarkers(nelx: number, fixedDofs: number[], loads: { dof: number; value: number }[]) {
  const w = nelx + 1
  const supX = new Set<number>()
  const supY = new Set<number>()
  for (const d of fixedDofs) {
    const node = d >> 1
    if (d & 1) supY.add(node)
    else supX.add(node)
  }
  const loadArrows = loads
    .filter((l) => Math.abs(l.value) > 1e-12)
    .map((l) => ({ node: l.dof >> 1, axis: l.dof & 1 ? 'y' : 'x', value: l.value }))
  const nodeXY = (node: number) => ({ i: node % w, j: Math.floor(node / w) })
  return { supX, supY, loadArrows, nodeXY }
}

function initialParams(): Params {
  const p = PROBLEMS[0]
  return {
    problemId: p.id,
    nelx: p.defaults.nelx,
    nely: p.defaults.nely,
    volfrac: p.defaults.volfrac,
    penal: 3,
    rmin: p.defaults.rmin,
    filter: 'density',
  }
}

const buildKeyOf = (p: Params, nonce: number) =>
  `${p.problemId}|${p.nelx}|${p.nely}|${p.volfrac}|${p.penal}|${p.rmin}|${p.filter}|${nonce}`

export function TopOptStudio() {
  const [params, setParams] = useState<Params>(initialParams)
  const [nonce, setNonce] = useState(0)
  const [running, setRunning] = useState(true)
  const [shade, setShade] = useState<Shade>('ink')
  const [colormap, setColormap] = useState<Colormap>('turbo')
  const [showBC, setShowBC] = useState(true)
  const [threshold, setThreshold] = useState(0) // 0 = continuous; >0 = 0/1 preview
  const [diag, setDiag] = useState<TopOptStep>({ iter: 0, compliance: 0, volume: params.volfrac, change: 1, grayness: 1 })
  const [converged, setConverged] = useState(false)

  const problem = useMemo(() => problemById(params.problemId), [params.problemId])
  const buildKey = buildKeyOf(params, nonce)

  const optRef = useRef<TopOpt | null>(null)
  const histRef = useRef<number[]>([])
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sparkRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const sizeRef = useRef({ w: 800, h: 500 })

  // Single control snapshot the rAF loop reads. Written only in an effect.
  const snapRef = useRef<Snapshot>({
    params,
    buildKey,
    running,
    converged,
    shade,
    colormap,
    showBC,
    threshold,
  })
  useEffect(() => {
    snapRef.current = { params, buildKey, running, converged, shade, colormap, showBC, threshold }
  }, [params, buildKey, running, converged, shade, colormap, showBC, threshold])

  // Resize handling (device-pixel-ratio aware).
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      sizeRef.current = { w: Math.max(320, r.width), h: Math.max(240, r.height) }
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  const drawSpark = useCallback(() => {
    const cv = sparkRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = cv.clientWidth
    const h = cv.clientHeight
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const hist = histRef.current
    if (hist.length < 2) return
    // Log-scale the compliance history — it drops by orders of magnitude.
    const logs = hist.map((c) => Math.log10(Math.max(c, 1e-12)))
    let lo = Infinity
    let hi = -Infinity
    for (const v of logs) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    if (hi - lo < 1e-6) hi = lo + 1e-6
    const pad = 4
    ctx.strokeStyle = '#5ac8fa'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let i = 0; i < logs.length; i++) {
      const x = pad + ((w - 2 * pad) * i) / (logs.length - 1)
      const y = pad + (h - 2 * pad) * (1 - (logs[i] - lo) / (hi - lo))
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }, [])

  const draw = useCallback(() => {
    const opt = optRef.current
    const cv = canvasRef.current
    if (!opt || !cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const snap = snapRef.current
    const prob = problemById(snap.params.problemId)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const { w: cw, h: ch } = sizeRef.current
    if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
      cv.width = Math.round(cw * dpr)
      cv.height = Math.round(ch * dpr)
      cv.style.width = `${cw}px`
      cv.style.height = `${ch}px`
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cw, ch)

    const nelx = opt.nelx
    const nely = opt.nely
    const mirror = prob.symmetry === 'left'
    const dispW = mirror ? nelx * 2 : nelx
    const dispH = nely

    // Fit the design domain into the canvas with a margin.
    const margin = 28
    const availW = cw - 2 * margin
    const availH = ch - 2 * margin
    const scale = Math.min(availW / dispW, availH / dispH)
    const drawW = dispW * scale
    const drawH = dispH * scale
    const ox = (cw - drawW) / 2
    const oy = (ch - drawH) / 2

    // Render the element densities into a small offscreen raster, then blit it
    // scaled up (smoothing gives the design its soft, organic edges).
    const off = document.createElement('canvas')
    off.width = dispW
    off.height = dispH
    const octx = off.getContext('2d')
    if (!octx) return
    const img = octx.createImageData(dispW, dispH)
    const shadeMode = snap.shade
    const cmap = snap.colormap
    const thr = snap.threshold
    // For the energy shade, normalize by the max compliance density this frame.
    let emax = 1e-30
    if (shadeMode === 'energy') {
      for (let e = 0; e < opt.nElem; e++) {
        const en = opt.energy[e] * Math.pow(opt.xPhys[e], opt.spec.penal)
        if (en > emax) emax = en
      }
    }
    const putCell = (col: number, row: number, r: number, g: number, b: number) => {
      const o = (row * dispW + col) * 4
      img.data[o] = r
      img.data[o + 1] = g
      img.data[o + 2] = b
      img.data[o + 3] = 255
    }
    for (let ey = 0; ey < nely; ey++) {
      const row = nely - 1 - ey // raster row 0 is the top; domain row 0 is the bottom
      for (let ex = 0; ex < nelx; ex++) {
        const e = ey * nelx + ex
        let rho = opt.xPhys[e]
        if (thr > 0) rho = rho >= thr ? 1 : 0
        let r: number
        let g: number
        let b: number
        if (shadeMode === 'energy') {
          const en = (opt.energy[e] * Math.pow(opt.xPhys[e], opt.spec.penal)) / emax
          const t = Math.pow(Math.max(0, Math.min(1, en)), 0.4)
          const c = fieldColor(t, cmap)
          const a = Math.max(0, Math.min(1, rho))
          r = Math.round(c[0] * a + 24 * (1 - a))
          g = Math.round(c[1] * a + 26 * (1 - a))
          b = Math.round(c[2] * a + 33 * (1 - a))
        } else {
          const ink = Math.max(0, Math.min(1, rho))
          const v = Math.round(245 - 230 * ink)
          r = v
          g = v
          b = Math.round(v + 6 * ink)
        }
        putCell(ex, row, r, g, b)
        if (mirror) putCell(2 * nelx - 1 - ex, row, r, g, b)
      }
    }
    octx.putImageData(img, 0, 0)
    ctx.fillStyle = shadeMode === 'ink' ? '#f5f6fa' : '#181a21'
    ctx.fillRect(ox, oy, drawW, drawH)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(off, ox, oy, drawW, drawH)

    // Domain frame.
    ctx.strokeStyle = 'rgba(120,140,170,0.5)'
    ctx.lineWidth = 1
    ctx.strokeRect(ox + 0.5, oy + 0.5, drawW - 1, drawH - 1)

    // Boundary conditions (drawn in the primary/right half for a symmetric model).
    if (snap.showBC) {
      const spec = opt.spec
      const { supX, supY, loadArrows, nodeXY } = bcMarkers(nelx, spec.fixedDofs, spec.loads)
      const halfOx = mirror ? ox + drawW / 2 : ox
      const px = (i: number) => halfOx + (i / nelx) * (mirror ? drawW / 2 : drawW)
      const py = (j: number) => oy + (1 - j / nely) * drawH
      const allSup = new Set<number>([...supX, ...supY])
      for (const node of allSup) {
        const { i, j } = nodeXY(node)
        const x = px(i)
        const y = py(j)
        const both = supX.has(node) && supY.has(node)
        ctx.fillStyle = both ? '#3ddc97' : '#f5b642'
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(x - 5, y + 9)
        ctx.lineTo(x + 5, y + 9)
        ctx.closePath()
        ctx.fill()
      }
      ctx.strokeStyle = '#ff5d5d'
      ctx.fillStyle = '#ff5d5d'
      ctx.lineWidth = 2
      for (const a of loadArrows) {
        const { i, j } = nodeXY(a.node)
        const x = px(i)
        const y = py(j)
        const len = 22
        const dir = Math.sign(a.value) || 1
        let ex2 = x
        let ey2 = y
        if (a.axis === 'y') ey2 = y - dir * len // screen y is inverted vs. physical up
        else ex2 = x + dir * len
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(ex2, ey2)
        ctx.stroke()
        const ang = Math.atan2(ey2 - y, ex2 - x)
        ctx.beginPath()
        ctx.moveTo(ex2, ey2)
        ctx.lineTo(ex2 - 7 * Math.cos(ang - 0.4), ey2 - 7 * Math.sin(ang - 0.4))
        ctx.lineTo(ex2 - 7 * Math.cos(ang + 0.4), ey2 - 7 * Math.sin(ang + 0.4))
        ctx.closePath()
        ctx.fill()
      }
    }
  }, [])

  // The animation / optimization loop — mounted once, reads the control snapshot.
  useEffect(() => {
    let raf = 0
    let lastStat = 0
    let builtKey = ''
    let lastSig = ''
    const loop = (t: number) => {
      const snap = snapRef.current
      // (Re)build the optimizer when the structural problem changes.
      if (snap.buildKey !== builtKey) {
        const p = problemById(snap.params.problemId)
        const spec = p.build(snap.params.nelx, snap.params.nely, snap.params.volfrac, snap.params.rmin, snap.params.filter)
        spec.penal = snap.params.penal
        // A loose inner solve keeps the live loop smooth; the OC update is itself
        // approximate, and a 3e-4 residual gives a design indistinguishable from a
        // tight solve (verified) at roughly half the CG iterations.
        spec.cgTol = 3e-4
        optRef.current = new TopOpt(spec)
        histRef.current = []
        builtKey = snap.buildKey
        lastStat = t
        setConverged(false)
        setDiag({ iter: 0, compliance: 0, volume: snap.params.volfrac, change: 1, grayness: 1 })
      }
      const opt = optRef.current
      if (opt) {
        let stepped = false
        if (snap.running && !snap.converged) {
          const s = opt.step()
          stepped = true
          const hist = histRef.current
          hist.push(s.compliance)
          if (hist.length > HIST_MAX) hist.shift()
          if (t - lastStat > 110) {
            setDiag(s)
            drawSpark()
            lastStat = t
          }
          if (s.iter > 12 && s.change < 0.01) {
            setDiag(s)
            drawSpark()
            setConverged(true)
          }
        }
        // Redraw only when something changed — no wasteful re-rasterizing the
        // static design 60×/sec while paused or converged.
        const sz = sizeRef.current
        const sig = `${snap.shade}|${snap.colormap}|${snap.threshold}|${snap.showBC}|${snap.buildKey}|${opt.iter}|${sz.w}|${sz.h}`
        if (stepped || sig !== lastSig) {
          draw()
          lastSig = sig
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [draw, drawSpark])

  // --- control handlers ---------------------------------------------------
  const setProblem = (id: string) => {
    const p = problemById(id)
    setParams((prev) => ({
      problemId: id,
      nelx: p.defaults.nelx,
      nely: p.defaults.nely,
      volfrac: p.defaults.volfrac,
      penal: 3,
      rmin: p.defaults.rmin,
      filter: prev.filter,
    }))
    setRunning(true)
  }
  const patch = (p: Partial<Params>) => setParams((prev) => ({ ...prev, ...p }))

  const reset = () => {
    setNonce((n) => n + 1) // bump buildKey → the loop rebuilds fresh
    setRunning(true)
  }

  const stepOnce = () => {
    setRunning(false)
    const opt = optRef.current
    if (!opt) return
    const s = opt.step()
    histRef.current.push(s.compliance)
    if (histRef.current.length > HIST_MAX) histRef.current.shift()
    setDiag(s)
    setConverged(false)
    drawSpark()
  }

  const exportPNG = () => {
    const cv = canvasRef.current
    if (!cv) return
    try {
      const url = cv.toDataURL('image/png')
      const a = document.createElement('a')
      a.href = url
      a.download = `keystone-${params.problemId}-${diag.iter}.png`
      a.click()
    } catch {
      /* tainted canvas / sandbox — ignore */
    }
  }

  const fmt = (v: number, d = 3) => (Number.isFinite(v) ? v.toPrecision(d) : '—')

  return (
    <div className="topopt">
      <aside className="rail left">
        <div className="panel">
          <div className="panel-title">Load case</div>
          {PROBLEMS.map((p) => (
            <button
              key={p.id}
              className={`preset ${params.problemId === p.id ? 'active' : ''}`}
              onClick={() => setProblem(p.id)}
            >
              <div className="preset-name">{p.name}</div>
              <div className="preset-blurb">{p.blurb}</div>
            </button>
          ))}
        </div>
      </aside>

      <main className="stage">
        <div className="topopt-toolbar">
          <button className={`tool ${running && !converged ? 'active' : ''}`} onClick={() => setRunning((r) => !r)}>
            {running && !converged ? '⏸ Pause' : '▶ Run'}
          </button>
          <button className="tool" onClick={stepOnce}>
            ⏭ Step
          </button>
          <button className="tool" onClick={reset}>
            ↺ Restart
          </button>
          <button className="tool" onClick={exportPNG}>
            ⬇ PNG
          </button>
          <div className="tool-hint">
            {converged ? 'Converged — the layout has settled.' : running ? 'Optimizing…' : 'Paused'}
          </div>
        </div>
        <div className="canvas-wrap" ref={wrapRef}>
          <canvas ref={canvasRef} />
          <div className="overlay-legend">
            <div className="legend force-legend">
              <span className="chip" style={{ color: '#cfe0ff' }}>
                {problem.name} · {params.nelx}×{params.nely}
                {problem.symmetry ? ' (½, mirrored)' : ''} · iter {diag.iter}
              </span>
            </div>
          </div>
        </div>
      </main>

      <aside className="rail right">
        <div className="panel">
          <div className="panel-title">{problem.name}</div>
          <p className="hint-text">{problem.blurb}</p>
          <div className="stat-grid">
            <StatTile label="Iteration" value={String(diag.iter)} />
            <StatTile label="Compliance" value={fmt(diag.compliance, 4)} sub="Uᵀ K U — lower is stiffer" />
            <StatTile label="Volume" value={`${(diag.volume * 100).toFixed(1)}%`} sub={`target ${(params.volfrac * 100).toFixed(0)}%`} />
            <StatTile label="Change" value={fmt(diag.change, 2)} sub="‖Δρ‖∞ (→0 at optimum)" />
            <StatTile label="Grayness" value={`${(diag.grayness * 100).toFixed(1)}%`} sub="non-discreteness Mₙd" />
            <StatTile label="Status" value={converged ? 'converged' : running ? 'running' : 'paused'} />
          </div>
          <div className="field-label">Compliance history (log)</div>
          <canvas ref={sparkRef} className="topopt-spark" />
        </div>

        <div className="panel">
          <div className="panel-title">Material budget & solver</div>
          <Slider
            label="Volume fraction"
            min={0.1}
            max={0.8}
            step={0.01}
            value={params.volfrac}
            onChange={(v) => patch({ volfrac: v })}
            format={(v) => `${(v * 100).toFixed(0)}%`}
          />
          <Slider
            label="Penalty p"
            min={1}
            max={5}
            step={0.1}
            value={params.penal}
            onChange={(v) => patch({ penal: v })}
            format={(v) => v.toFixed(1)}
          />
          <Slider
            label="Filter radius"
            min={1.2}
            max={5}
            step={0.1}
            value={params.rmin}
            onChange={(v) => patch({ rmin: v })}
            format={(v) => `${v.toFixed(1)} el`}
          />
          <div className="field-label">Regularization filter</div>
          <Segmented<FilterKind>
            options={[
              { value: 'density', label: 'Density' },
              { value: 'sensitivity', label: 'Sensitivity' },
            ]}
            value={params.filter}
            onChange={(v) => patch({ filter: v })}
          />
        </div>

        <div className="panel">
          <div className="panel-title">Resolution</div>
          <Slider
            label="Elements across"
            min={40}
            max={200}
            step={4}
            value={params.nelx}
            onChange={(v) => patch({ nelx: v })}
            format={(v) => String(v)}
          />
          <Slider
            label="Elements high"
            min={20}
            max={140}
            step={4}
            value={params.nely}
            onChange={(v) => patch({ nely: v })}
            format={(v) => String(v)}
          />
          <p className="hint-text">
            {params.nelx * params.nely} elements · {2 * (params.nelx + 1) * (params.nely + 1)} DOF. Higher
            resolution reveals finer members but each iteration solves a larger system.
          </p>
        </div>

        <div className="panel">
          <div className="panel-title">Display</div>
          <div className="field-label">Shade by</div>
          <Segmented<Shade>
            options={[
              { value: 'ink', label: 'Density' },
              { value: 'energy', label: 'Strain energy' },
            ]}
            value={shade}
            onChange={setShade}
          />
          {shade === 'energy' && (
            <>
              <div className="field-label">Colormap</div>
              <Segmented<Colormap>
                options={[
                  { value: 'turbo', label: 'Turbo' },
                  { value: 'viridis', label: 'Viridis' },
                  { value: 'grayscale', label: 'Gray' },
                ]}
                value={colormap}
                onChange={setColormap}
              />
            </>
          )}
          <Slider
            label="0/1 threshold preview"
            min={0}
            max={0.9}
            step={0.05}
            value={threshold}
            onChange={setThreshold}
            format={(v) => (v === 0 ? 'off' : v.toFixed(2))}
          />
          <Toggle label="Show supports & load" checked={showBC} onChange={setShowBC} />
        </div>
      </aside>
    </div>
  )
}
