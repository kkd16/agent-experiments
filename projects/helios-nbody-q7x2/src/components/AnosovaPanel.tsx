// The Three-Body Chaos Atlas — the Agekyan–Anosova free-fall map.
//
// Every pixel is one release configuration of three equal masses dropped from rest:
// m₁, m₂ pinned at (∓½, 0) and the third body at (x, y) sweeping the canonical
// region D. Each is integrated to its outcome by the full Hermite three-body engine
// in `sim/threebody.ts`, and coloured by what happened — how long the dance lasted
// (the fractal), which body was flung out, the surviving binary's size, or the count
// of close-encounter "interplays". The scan runs progressively on requestAnimationFrame
// so the picture fills in without ever blocking the main thread, and clicking a pixel
// replays that exact triangle's trajectory — "the dance behind the pixel".

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  anosovaState,
  scatter,
  recordTrajectory,
  cellToXY,
  inRegion,
  REGION,
  MAP_OPTS,
  NAMED_CONFIGS,
} from '../sim/threebody'
import type { ThreeBodyResult, Trajectory } from '../sim/threebody'
import { sampleColorMap } from '../render/colormap'
import { Segmented, Select } from './primitives'

type ColorMode = 'time' | 'escaper' | 'abin' | 'interplays'

const RESOLUTIONS = [
  { value: '40', label: 'Coarse' },
  { value: '60', label: 'Medium' },
  { value: '84', label: 'Fine' },
]

// Cell outcome codes packed into a Uint8Array.
const ST_EMPTY = 0
const ST_ESCAPE = 1
const ST_LONGLIVED = 2 // didn't resolve within the budget (long algebraic-tail lifetime)
const ST_OUTSIDE = 3 // outside region D

// Fixed hues for the three escaper basins (warm / green / blue).
const ESCAPER_RGB: [number, number, number][] = [
  [255, 138, 92],
  [120, 224, 150],
  [120, 178, 255],
]

// Colour ranges.
const T_LO = Math.log(0.8)
const T_HI = Math.log(MAP_OPTS.tMax)
const A_LO = Math.log(0.02)
const A_HI = Math.log(0.8)
const IP_HI = 90

interface CellData {
  state: Uint8Array
  escaper: Int8Array
  tEsc: Float32Array
  aBin: Float32Array
  interplays: Uint16Array
}

function cellColor(mode: ColorMode, i: number, d: CellData): string {
  const st = d.state[i]
  if (st === ST_OUTSIDE || st === ST_EMPTY) return 'rgba(255,255,255,0.012)'
  if (st === ST_LONGLIVED) return '#e9eefc' // bright neutral — the long-lived resonant islands
  // escape
  if (mode === 'escaper') {
    const e = d.escaper[i]
    const [r, g, b] = ESCAPER_RGB[e] ?? [180, 180, 180]
    return `rgb(${r},${g},${b})`
  }
  if (mode === 'time') {
    const t = (Math.log(Math.max(0.8, d.tEsc[i])) - T_LO) / (T_HI - T_LO)
    const [r, g, b] = sampleColorMap('inferno', t)
    return `rgb(${r},${g},${b})`
  }
  if (mode === 'abin') {
    const a = d.aBin[i]
    if (!(a > 0)) return '#11131c'
    const t = (Math.log(a) - A_LO) / (A_HI - A_LO)
    const [r, g, b] = sampleColorMap('viridis', t)
    return `rgb(${r},${g},${b})`
  }
  // interplays
  const t = Math.min(1, d.interplays[i] / IP_HI)
  const [r, g, b] = sampleColorMap('plasma', t)
  return `rgb(${r},${g},${b})`
}

interface Census {
  inRegion: number
  escape: [number, number, number]
  longLived: number
}

export interface AnosovaPanelProps {
  /** Send a release configuration into the live N-body studio. */
  onLaunch?: (x3: number, y3: number) => void
}

export function AnosovaPanel({ onLaunch }: AnosovaPanelProps) {
  const [resolution, setResolution] = useState('40')
  const [colorMode, setColorMode] = useState<ColorMode>('time')
  const [computing, setComputing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [done, setDone] = useState(false)
  const [census, setCensus] = useState<Census | null>(null)
  const [hover, setHover] = useState<{ x: number; y: number; st: number; t: number; e: number; ip: number } | null>(null)
  const [sel, setSel] = useState<{ x: number; y: number; traj: Trajectory } | null>(null)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const miniRef = useRef<HTMLCanvasElement | null>(null)

  const cols = parseInt(resolution, 10)
  const aspect = (REGION.yMax - REGION.yMin) / (REGION.xMax - REGION.xMin)
  const rows = Math.round(cols * aspect)

  const scan = useRef<{
    running: boolean
    idx: number
    data: CellData
    cols: number
    rows: number
    raf: number
  } | null>(null)

  const paintCell = useCallback(
    (ctx: CanvasRenderingContext2D, i: number, d: CellData, c: number, r: number, cw: number, ch: number) => {
      ctx.fillStyle = cellColor(colorMode, i, d)
      ctx.fillRect(Math.floor(c * cw), Math.floor(r * ch), Math.ceil(cw) + 1, Math.ceil(ch) + 1)
    },
    [colorMode],
  )

  const repaint = useCallback(() => {
    const canvas = canvasRef.current
    const s = scan.current
    if (!canvas || !s) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const cw = canvas.width / s.cols
    const ch = canvas.height / s.rows
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    for (let r = 0; r < s.rows; r++) {
      for (let c = 0; c < s.cols; c++) {
        const i = r * s.cols + c
        if (s.data.state[i] !== ST_EMPTY) paintCell(ctx, i, s.data, c, r, cw, ch)
      }
    }
  }, [paintCell])

  const stopScan = useCallback(() => {
    const s = scan.current
    if (s) { s.running = false; cancelAnimationFrame(s.raf) }
    setComputing(false)
  }, [])

  const startScan = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    stopScan()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const cssW = canvas.clientWidth || 280
    const cssH = Math.round((cssW * rows) / cols)
    canvas.style.height = `${cssH}px`
    canvas.width = Math.max(1, Math.round(cssW * dpr))
    canvas.height = Math.max(1, Math.round(cssH * dpr))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    const total = cols * rows
    const data: CellData = {
      state: new Uint8Array(total),
      escaper: new Int8Array(total).fill(-1),
      tEsc: new Float32Array(total),
      aBin: new Float32Array(total),
      interplays: new Uint16Array(total),
    }
    const s = { running: true, idx: 0, data, cols, rows, raf: 0 }
    scan.current = s
    setComputing(true)
    setDone(false)
    setProgress(0)
    setSel(null)
    setCensus(null)

    const cw = canvas.width / cols
    const ch = canvas.height / rows
    const cen: Census = { inRegion: 0, escape: [0, 0, 0], longLived: 0 }

    const tick = () => {
      if (!s.running) return
      const t0 = performance.now()
      while (s.idx < total && performance.now() - t0 < 14) {
        const i = s.idx
        const c = i % cols
        const r = (i / cols) | 0
        const { x, y } = cellToXY(c, r, cols, rows)
        if (!inRegion(x, y)) {
          data.state[i] = ST_OUTSIDE
        } else {
          const res: ThreeBodyResult = scatter(anosovaState(x, y), MAP_OPTS)
          cen.inRegion++
          if (res.outcome === 'escape') {
            data.state[i] = ST_ESCAPE
            data.escaper[i] = res.escaper
            data.tEsc[i] = res.tEscape
            data.aBin[i] = res.aBin
            data.interplays[i] = Math.min(65535, res.interplays)
            if (res.escaper >= 0 && res.escaper < 3) cen.escape[res.escaper]++
          } else {
            data.state[i] = ST_LONGLIVED
            data.tEsc[i] = res.tEscape
            data.interplays[i] = Math.min(65535, res.interplays)
            cen.longLived++
          }
        }
        paintCell(ctx, i, data, c, r, cw, ch)
        s.idx++
      }
      setProgress(s.idx / total)
      if (s.idx >= total) {
        s.running = false
        setComputing(false)
        setDone(true)
        setCensus({ ...cen })
        return
      }
      s.raf = requestAnimationFrame(tick)
    }
    s.raf = requestAnimationFrame(tick)
  }, [cols, rows, paintCell, stopScan])

  // Repaint on a colour-mode flip without recomputing.
  useEffect(() => { if (done) repaint() }, [colorMode, done, repaint])
  // Tear down on unmount.
  useEffect(() => () => stopScan(), [stopScan])

  // ---- click-to-inspect: replay the exact triangle -------------------------
  const inspect = useCallback((x: number, y: number) => {
    const traj = recordTrajectory(anosovaState(x, y), 700, MAP_OPTS)
    setSel({ x, y, traj })
  }, [])

  const onMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const s = scan.current
    const canvas = canvasRef.current
    if (!s || !canvas) return
    const rect = canvas.getBoundingClientRect()
    const c = Math.floor(((ev.clientX - rect.left) / rect.width) * s.cols)
    const r = Math.floor(((ev.clientY - rect.top) / rect.height) * s.rows)
    if (c < 0 || c >= s.cols || r < 0 || r >= s.rows) { setHover(null); return }
    const i = r * s.cols + c
    const st = s.data.state[i]
    if (st === ST_EMPTY || st === ST_OUTSIDE) { setHover(null); return }
    const { x, y } = cellToXY(c, r, s.cols, s.rows)
    setHover({ x, y, st, t: s.data.tEsc[i], e: s.data.escaper[i], ip: s.data.interplays[i] })
  }

  const onClick = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const s = scan.current
    const canvas = canvasRef.current
    if (!s || !canvas) return
    const rect = canvas.getBoundingClientRect()
    const c = Math.floor(((ev.clientX - rect.left) / rect.width) * s.cols)
    const r = Math.floor(((ev.clientY - rect.top) / rect.height) * s.rows)
    if (c < 0 || c >= s.cols || r < 0 || r >= s.rows) return
    const { x, y } = cellToXY(c, r, s.cols, s.rows)
    if (!inRegion(x, y)) return
    inspect(x, y)
  }

  // ---- draw the selected trajectory into the mini-canvas -------------------
  useEffect(() => {
    const canvas = miniRef.current
    if (!canvas || !sel) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const cssW = canvas.clientWidth || 280
    const cssH = 180
    canvas.style.height = `${cssH}px`
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#0a0c14'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    const { traj } = sel
    // bounds over the recorded trajectory
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (let b = 0; b < 3; b++) {
      for (let k = 0; k < traj.px[b].length; k++) {
        const px = traj.px[b][k], py = traj.py[b][k]
        if (px < minX) minX = px; if (px > maxX) maxX = px
        if (py < minY) minY = py; if (py > maxY) maxY = py
      }
    }
    const pad = 0.12
    const spanX = Math.max(maxX - minX, 1e-6), spanY = Math.max(maxY - minY, 1e-6)
    const span = Math.max(spanX, spanY) * (1 + pad)
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
    const W = canvas.width, H = canvas.height
    const scale = Math.min(W, H) / span
    const toX = (x: number) => W / 2 + (x - cx) * scale
    const toY = (y: number) => H / 2 - (y - cy) * scale

    // draw the three trajectories, fading from dim (early) to bright (late)
    for (let b = 0; b < 3; b++) {
      const [r, g, bl] = ESCAPER_RGB[b]
      const N = traj.px[b].length
      ctx.lineWidth = Math.max(1, dpr)
      for (let k = 1; k < N; k++) {
        const a = 0.12 + 0.78 * (k / N)
        ctx.strokeStyle = `rgba(${r},${g},${bl},${a})`
        ctx.beginPath()
        ctx.moveTo(toX(traj.px[b][k - 1]), toY(traj.py[b][k - 1]))
        ctx.lineTo(toX(traj.px[b][k]), toY(traj.py[b][k]))
        ctx.stroke()
      }
      // final position marker
      const lx = toX(traj.px[b][N - 1]), ly = toY(traj.py[b][N - 1])
      ctx.fillStyle = `rgb(${r},${g},${bl})`
      ctx.beginPath()
      ctx.arc(lx, ly, Math.max(2.5, 2 * dpr), 0, Math.PI * 2)
      ctx.fill()
    }
  }, [sel])

  const escName = (e: number) => (e === 0 ? 'm₁' : e === 1 ? 'm₂' : e === 2 ? 'm₃' : '—')

  return (
    <div className="chaos-panel">
      <p className="integrator-blurb">
        <strong>The Agekyan–Anosova map.</strong> Three equal masses dropped from rest from every
        triangle in region D; each pixel's colour is the <em>outcome</em> of the gravitational
        scattering. The boundaries between basins are a genuine fractal — the signature of
        deterministic chaos in the full (unrestricted) three-body problem.
      </p>

      <Select<string>
        label="Resolution"
        value={resolution}
        options={RESOLUTIONS}
        onChange={(v) => { stopScan(); setResolution(v); setDone(false) }}
      />

      <Segmented<ColorMode>
        label="Colour by"
        value={colorMode}
        options={[
          { value: 'time', label: 'Lifetime', title: 'log escape time — the fractal' },
          { value: 'escaper', label: 'Escaper', title: 'which body is ejected (three basins)' },
          { value: 'abin', label: 'Binary a', title: 'surviving binary semimajor axis' },
          { value: 'interplays', label: 'Interplays', title: 'count of close-encounter passages' },
        ]}
        onChange={setColorMode}
      />

      <button className="chaos-run" onClick={startScan} disabled={computing}>
        {computing ? `Scanning… ${(progress * 100).toFixed(0)}%` : done ? 'Re-scan' : 'Scan the map'}
      </button>

      {computing && (
        <div className="atlas-progress"><div className="atlas-progress-bar" style={{ width: `${progress * 100}%` }} /></div>
      )}

      <div className="atlas-wrap">
        <canvas
          ref={canvasRef}
          className="atlas-canvas"
          style={{ width: '100%', cursor: done ? 'crosshair' : 'default' }}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onPointerDown={onClick}
        />
      </div>
      <div className="atlas-axes"><span>x = 0</span><span>region D (m₃ release)</span><span>x = ½</span></div>

      {colorMode === 'escaper' ? (
        <div className="wh-legend">
          {[0, 1, 2].map((b) => (
            <span className="wh-legend-item" key={b}>
              <span className="wh-swatch" style={{ background: `rgb(${ESCAPER_RGB[b].join(',')})` }} />
              {escName(b)} ejected
            </span>
          ))}
          <span className="wh-legend-item"><span className="wh-swatch" style={{ background: '#e9eefc' }} />long-lived</span>
        </div>
      ) : (
        <ColorBar mode={colorMode} />
      )}

      {hover && (
        <p className="anosova-hover">
          (x,y) = ({hover.x.toFixed(3)}, {hover.y.toFixed(3)}) ·{' '}
          {hover.st === ST_LONGLIVED
            ? <>long-lived (t &gt; {MAP_OPTS.tMax}), {hover.ip} interplays</>
            : <>{escName(hover.e)} ejected at t = {hover.t.toFixed(1)}, {hover.ip} interplays</>}
        </p>
      )}

      {census && (
        <div className="anosova-census">
          <CensusBar census={census} />
          <p className="preset-desc" style={{ margin: 0 }}>
            {census.inRegion.toLocaleString()} configurations · m₁ {pct(census.escape[0], census.inRegion)} ·
            m₂ {pct(census.escape[1], census.inRegion)} · m₃ {pct(census.escape[2], census.inRegion)} ·
            long-lived {pct(census.longLived, census.inRegion)}
          </p>
        </div>
      )}

      <div className="anosova-named">
        <span className="anosova-named-label">Special triangles:</span>
        {NAMED_CONFIGS.map((c) => (
          <button key={c.id} className="anosova-chip" title={c.blurb} onClick={() => inspect(c.x, c.y)}>
            {c.name}
          </button>
        ))}
      </div>

      {sel && (
        <div className="chaos-result">
          <div className="anosova-inspect-head">
            <strong>The dance behind ({sel.x.toFixed(3)}, {sel.y.toFixed(3)})</strong>
          </div>
          <canvas ref={miniRef} className="atlas-canvas" style={{ width: '100%' }} />
          <OutcomeReadout result={sel.traj.result} escName={escName} />
          <SeparationSpark traj={sel.traj} />
          {onLaunch && (
            <button className="chaos-run" onClick={() => onLaunch(sel.x, sel.y)}>
              ▶ Launch in Studio
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function pct(n: number, total: number): string {
  if (total <= 0) return '0%'
  return `${((100 * n) / total).toFixed(0)}%`
}

function OutcomeReadout({ result, escName }: { result: ThreeBodyResult; escName: (e: number) => string }) {
  const reliable = result.energyError < 1e-2
  return (
    <div className="anosova-readout">
      <div className="stat"><span className="stat-label">Outcome</span>
        <span className="stat-value">{result.outcome === 'escape' ? `${escName(result.escaper)} ejected` : result.outcome === 'singular' ? 'singular' : 'long-lived'}</span></div>
      <div className="stat"><span className="stat-label">{result.outcome === 'escape' ? 'Escape t' : 'Survived t'}</span>
        <span className="stat-value">{result.tEscape.toFixed(2)}</span></div>
      <div className="stat"><span className="stat-label">Interplays</span><span className="stat-value">{result.interplays}</span></div>
      {result.outcome === 'escape' && Number.isFinite(result.aBin) && (
        <>
          <div className="stat"><span className="stat-label">Binary a</span><span className="stat-value">{result.aBin.toFixed(3)}</span></div>
          <div className="stat"><span className="stat-label">Binary e</span><span className="stat-value">{result.eBin.toFixed(3)}</span></div>
        </>
      )}
      <div className="stat"><span className="stat-label">|ΔE/E|</span>
        <span className="stat-value" style={{ color: reliable ? undefined : 'var(--warn)' }}>{result.energyError.toExponential(1)}</span></div>
    </div>
  )
}

// A tiny log-scale plot of the three pairwise separations over time.
function SeparationSpark({ traj }: { traj: Trajectory }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const cssW = canvas.clientWidth || 280
    const cssH = 64
    canvas.style.height = `${cssH}px`
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = canvas.width, H = canvas.height
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#0a0c14'
    ctx.fillRect(0, 0, W, H)
    // log range over all separations
    let lo = Infinity, hi = -Infinity
    for (let p = 0; p < 3; p++) for (let k = 0; k < traj.sep[p].length; k++) {
      const v = traj.sep[p][k]; if (v > 0) { const l = Math.log10(v); if (l < lo) lo = l; if (l > hi) hi = l }
    }
    if (!Number.isFinite(lo)) return
    if (hi - lo < 0.5) { hi = lo + 0.5 }
    const N = traj.sep[0].length
    const colors = ['#9aa6c8', '#ffb27a', '#7ab2ff']
    for (let p = 0; p < 3; p++) {
      ctx.strokeStyle = colors[p]
      ctx.lineWidth = Math.max(1, dpr)
      ctx.beginPath()
      for (let k = 0; k < N; k++) {
        const v = traj.sep[p][k]
        const l = v > 0 ? Math.log10(v) : lo
        const x = (k / (N - 1)) * W
        const yy = H - ((l - lo) / (hi - lo)) * H
        if (k === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy)
      }
      ctx.stroke()
    }
  }, [traj])
  return (
    <div className="chaos-plot">
      <span className="chaos-note" style={{ color: 'var(--muted)' }}>pairwise separations (log) vs time</span>
      <canvas ref={ref} className="atlas-canvas" style={{ width: '100%' }} />
    </div>
  )
}

function CensusBar({ census }: { census: Census }) {
  const total = Math.max(1, census.inRegion)
  const segs = [
    { v: census.escape[0], c: `rgb(${ESCAPER_RGB[0].join(',')})` },
    { v: census.escape[1], c: `rgb(${ESCAPER_RGB[1].join(',')})` },
    { v: census.escape[2], c: `rgb(${ESCAPER_RGB[2].join(',')})` },
    { v: census.longLived, c: '#e9eefc' },
  ]
  return (
    <div className="anosova-bar">
      {segs.map((s, i) => (
        <span key={i} style={{ width: `${(100 * s.v) / total}%`, background: s.c }} />
      ))}
    </div>
  )
}

function ColorBar({ mode }: { mode: ColorMode }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const w = 256, h = 10
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const map = mode === 'time' ? 'inferno' : mode === 'abin' ? 'viridis' : 'plasma'
    for (let x = 0; x < w; x++) {
      const [r, g, b] = sampleColorMap(map as 'inferno' | 'viridis' | 'plasma', x / (w - 1))
      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.fillRect(x, 0, 1, h)
    }
  }, [mode])
  const labels =
    mode === 'time'
      ? ['fast escape', 'long lived']
      : mode === 'abin'
        ? ['tight binary', 'wide binary']
        : ['few interplays', 'many interplays']
  return (
    <div className="atlas-colorbar">
      <canvas ref={ref} style={{ width: '100%', height: 10 }} />
      <div className="atlas-colorbar-labels"><span>{labels[0]}</span><span>{labels[1]}</span></div>
    </div>
  )
}
