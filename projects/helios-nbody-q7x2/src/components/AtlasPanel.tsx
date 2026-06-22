// The Resonance Atlas Lab — Laskar's frequency-map analysis swept across a 2-D
// family of initial conditions, rendered as a live heatmap of the resonance web.
//
// Each pixel is one PCR3BP test particle launched from (a, e); its colour is
// either the measured mean motion n (the *frequency* map — resonance plateaus) or
// the frequency diffusion log₁₀|Δn/n| (the *chaos* map — the Arnold web). The scan
// runs progressively on requestAnimationFrame so the picture fills in without ever
// blocking the main thread, and clicking a cell drills into that orbit's
// time-frequency spectrogram below.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ATLAS_MODELS,
  atlasModelById,
  cellToAE,
  computeCell,
  recordOrbit,
  resonanceLines,
} from '../sim/fma'
import type { AtlasModel, FmaOptions } from '../sim/fma'
import { spectrogram } from '../sim/spectrogram'
import type { SpectrogramResult } from '../sim/spectrogram'
import { sampleColorMap } from '../render/colormap'
import { Segmented, Select, Slider } from './primitives'

type ColorMode = 'diffusion' | 'frequency'

// Diffusion colour range: log₁₀|Δn/ν| from a regular floor to strongly chaotic.
const DIFF_LO = -7
const DIFF_HI = -1.5
// Scan integration budget (kept modest so a Fine grid still finishes in a second
// or two of progressive work).
const SCAN_OPTS: FmaOptions = { samples: 256, periods: 30, minSub: 10 }

interface CellData {
  freq: Float64Array
  logDiff: Float64Array
  state: Uint8Array // 0 = empty, 1 = valid, 2 = escaped/invalid
}

function colorOf(mode: ColorMode, i: number, data: CellData, nMin: number, nMax: number): string {
  const st = data.state[i]
  if (st === 0) return 'rgba(255,255,255,0.015)'
  if (st === 2) return '#0a0c14' // escaped / hit a primary
  if (mode === 'diffusion') {
    const d = data.logDiff[i]
    if (!Number.isFinite(d)) return '#11131c'
    const t = (d - DIFF_LO) / (DIFF_HI - DIFF_LO)
    const [r, g, b] = sampleColorMap('inferno', t)
    return `rgb(${r},${g},${b})`
  }
  const n = data.freq[i]
  if (!Number.isFinite(n)) return '#11131c'
  const t = nMax > nMin ? (n - nMin) / (nMax - nMin) : 0.5
  const [r, g, b] = sampleColorMap('viridis', t)
  return `rgb(${r},${g},${b})`
}

export function AtlasPanel() {
  const [modelId, setModelId] = useState('belt')
  const [resolution, setResolution] = useState(40)
  const [colorMode, setColorMode] = useState<ColorMode>('diffusion')
  const [computing, setComputing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [done, setDone] = useState(false)
  const [hover, setHover] = useState<{ a: number; e: number; n: number; d: number; escaped: boolean } | null>(null)
  const [spectro, setSpectro] = useState<SpectrogramResult | null>(null)
  const [spectroInfo, setSpectroInfo] = useState<{ a: number; e: number } | null>(null)
  const [spectroBusy, setSpectroBusy] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const model = atlasModelById(modelId)
  const cols = resolution
  const rows = Math.round(resolution * 0.78)

  // The scan lives in a ref so the rAF loop mutates it without re-rendering.
  const scan = useRef<{
    running: boolean
    idx: number
    data: CellData
    model: AtlasModel
    cols: number
    rows: number
    raf: number
  } | null>(null)

  // n range across the model's a-band (n = a^{-3/2}; n is largest at aMin).
  const nMax = Math.pow(model.aMin, -1.5)
  const nMin = Math.pow(model.aMax, -1.5)

  const paintCell = useCallback(
    (ctx: CanvasRenderingContext2D, i: number, data: CellData, c: number, r: number, cw: number, ch: number) => {
      ctx.fillStyle = colorOf(colorMode, i, data, nMin, nMax)
      ctx.fillRect(Math.floor(c * cw), Math.floor(r * ch), Math.ceil(cw) + 1, Math.ceil(ch) + 1)
    },
    [colorMode, nMin, nMax],
  )

  // Full repaint from stored cell data (used after a colour-mode flip — no recompute).
  const repaint = useCallback(() => {
    const canvas = canvasRef.current
    const s = scan.current
    if (!canvas || !s) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.width
    const h = canvas.height
    const cw = w / s.cols
    const ch = h / s.rows
    ctx.clearRect(0, 0, w, h)
    for (let r = 0; r < s.rows; r++) {
      for (let c = 0; c < s.cols; c++) {
        const i = r * s.cols + c
        if (s.data.state[i] !== 0) paintCell(ctx, i, s.data, c, r, cw, ch)
      }
    }
    drawResonanceGuides(ctx, s.model, w, h)
  }, [paintCell])

  const stopScan = useCallback(() => {
    const s = scan.current
    if (s) {
      s.running = false
      cancelAnimationFrame(s.raf)
    }
    setComputing(false)
  }, [])

  const startScan = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    stopScan()
    // Size the backing store to the cell grid scaled up for crisp, fast fills.
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const cssW = canvas.clientWidth || 280
    const cssH = Math.round((cssW * rows) / cols)
    canvas.style.height = `${cssH}px`
    canvas.width = Math.max(1, Math.round(cssW * dpr))
    canvas.height = Math.max(1, Math.round(cssH * dpr))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = 'rgba(255,255,255,0.015)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    const total = cols * rows
    const data: CellData = {
      freq: new Float64Array(total),
      logDiff: new Float64Array(total),
      state: new Uint8Array(total),
    }
    const s = { running: true, idx: 0, data, model, cols, rows, raf: 0 }
    scan.current = s
    setComputing(true)
    setDone(false)
    setProgress(0)
    setSpectro(null)
    setSpectroInfo(null)

    const cw = canvas.width / cols
    const ch = canvas.height / rows
    const tick = () => {
      if (!s.running) return
      const t0 = performance.now()
      // Compute cells until the per-frame time budget is spent.
      while (s.idx < total && performance.now() - t0 < 14) {
        const i = s.idx
        const c = i % cols
        const r = (i / cols) | 0
        const { a, e } = cellToAE(s.model, c, r, cols, rows)
        const res = computeCell(a, e, s.model.mu, SCAN_OPTS)
        if (res.valid) {
          data.state[i] = 1
          data.freq[i] = res.freq
          data.logDiff[i] = res.logDiffusion
        } else {
          data.state[i] = 2
        }
        paintCell(ctx, i, data, c, r, cw, ch)
        s.idx++
      }
      setProgress(s.idx / total)
      if (s.idx >= total) {
        s.running = false
        drawResonanceGuides(ctx, s.model, canvas.width, canvas.height)
        setComputing(false)
        setDone(true)
        return
      }
      s.raf = requestAnimationFrame(tick)
    }
    s.raf = requestAnimationFrame(tick)
  }, [cols, rows, model, paintCell, stopScan])

  // Repaint when the colour mode flips on a completed scan.
  useEffect(() => {
    if (done) repaint()
  }, [colorMode, done, repaint])

  // Tear down any running scan on unmount.
  useEffect(() => () => stopScan(), [stopScan])

  const onMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const s = scan.current
    const canvas = canvasRef.current
    if (!s || !canvas) return
    const rect = canvas.getBoundingClientRect()
    const c = Math.floor(((ev.clientX - rect.left) / rect.width) * s.cols)
    const r = Math.floor(((ev.clientY - rect.top) / rect.height) * s.rows)
    if (c < 0 || c >= s.cols || r < 0 || r >= s.rows) { setHover(null); return }
    const i = r * s.cols + c
    if (s.data.state[i] === 0) { setHover(null); return }
    const { a, e } = cellToAE(s.model, c, r, s.cols, s.rows)
    setHover({ a, e, n: s.data.freq[i], d: s.data.logDiff[i], escaped: s.data.state[i] === 2 })
  }

  const onClick = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const s = scan.current
    const canvas = canvasRef.current
    if (!s || !canvas || s.running) return
    const rect = canvas.getBoundingClientRect()
    const c = Math.floor(((ev.clientX - rect.left) / rect.width) * s.cols)
    const r = Math.floor(((ev.clientY - rect.top) / rect.height) * s.rows)
    if (c < 0 || c >= s.cols || r < 0 || r >= s.rows) return
    const { a, e } = cellToAE(s.model, c, r, s.cols, s.rows)
    setSpectroBusy(true)
    setSpectroInfo({ a, e })
    // Defer the (longer) single-orbit integration so the click paints first.
    window.setTimeout(() => {
      const rec = recordOrbit(a, e, s.model.mu, { samples: 2048, periods: 140, minSub: 8 })
      // Even an escaping (chaotic) orbit is worth a spectrogram of its valid prefix —
      // truncated to the largest power of two so the STFT windows tile cleanly.
      let use = rec.re.length
      if (rec.escaped) use = 1 << Math.floor(Math.log2(Math.max(1, rec.filled)))
      if (use >= 512) {
        const sg = spectrogram(rec.re.subarray(0, use), rec.im.subarray(0, use), rec.dt, { window: 256, hop: 64 })
        setSpectro(sg.valid ? sg : null)
      } else {
        setSpectro(null)
      }
      setSpectroBusy(false)
    }, 15)
  }

  return (
    <div className="chaos-panel">
      <p className="integrator-blurb">
        <strong>Laskar's frequency-map analysis</strong> across a whole family of orbits. Every pixel
        is a restricted-three-body test particle launched from (a, e); its colour is the orbit's
        measured mean motion <em>n</em> (the resonance map) or its frequency diffusion log₁₀|Δn/n|
        (the chaos / <strong>Arnold-web</strong> map). Bright threads are the chaotic resonances.
      </p>

      <Select<string>
        label="Model"
        value={modelId}
        options={ATLAS_MODELS.map((m) => ({ value: m.id, label: m.name }))}
        onChange={(v) => { stopScan(); setModelId(v); setDone(false); setSpectro(null) }}
      />
      <p className="preset-desc">{model.blurb}</p>

      <Segmented<ColorMode>
        label="Colour by"
        value={colorMode}
        options={[
          { value: 'diffusion', label: 'Chaos', title: 'Frequency diffusion log₁₀|Δn/n| — the resonance/Arnold web' },
          { value: 'frequency', label: 'Frequency', title: 'Measured mean motion n — resonance plateaus' },
        ]}
        onChange={setColorMode}
      />
      <Slider
        label="Resolution"
        value={resolution}
        min={28}
        max={56}
        step={12}
        onChange={(v) => { stopScan(); setResolution(Math.round(v)); setDone(false) }}
        format={(v) => `${Math.round(v)}×${Math.round(v * 0.78)}`}
        title="Grid resolution — finer is sharper but takes longer to fill in"
      />

      <button
        type="button"
        className="btn primary chaos-run"
        onClick={() => (computing ? stopScan() : startScan())}
      >
        {computing ? `■ Stop (${Math.round(progress * 100)}%)` : done ? '↻ Recompute Atlas' : '▦ Compute Atlas'}
      </button>
      {computing && (
        <div className="atlas-progress">
          <div className="atlas-progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}

      <div className="atlas-wrap">
        <canvas
          ref={canvasRef}
          className="plot atlas-canvas"
          style={{ width: '100%', height: 200, cursor: done ? 'crosshair' : 'default' }}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onPointerDown={onClick}
        />
        <div className="atlas-axes">
          <span className="atlas-ax-x">a = {model.aMin}…{model.aMax} →</span>
          <span className="atlas-ax-y">e = {model.eMin}…{model.eMax} ↑</span>
        </div>
      </div>

      <ColorBar mode={colorMode} nMin={nMin} nMax={nMax} />

      {hover && (
        <div className="diag-readout atlas-readout">
          <Stat label="a" value={hover.a.toFixed(4)} />
          <Stat label="e" value={hover.e.toFixed(3)} />
          {hover.escaped ? (
            <Stat label="orbit" value="escaped" cls="warn" />
          ) : (
            <>
              <Stat label="n" value={Number.isFinite(hover.n) ? hover.n.toFixed(4) : '—'} />
              <Stat
                label="log|Δn/n|"
                value={Number.isFinite(hover.d) ? hover.d.toFixed(2) : '—'}
                cls={hover.d > -2.5 ? 'bad' : hover.d > -4 ? 'warn' : 'good'}
              />
            </>
          )}
        </div>
      )}
      {done && !hover && (
        <p className="chaos-note">Hover a cell to read (a, e, n, diffusion); click one to drill into its spectrogram.</p>
      )}

      {(spectro || spectroBusy) && (
        <div className="chaos-result" style={{ marginTop: 8 }}>
          <div className="diag-plot-head">
            <span>
              Spectrogram {spectroInfo ? `· a=${spectroInfo.a.toFixed(3)} e=${spectroInfo.e.toFixed(2)}` : ''}
            </span>
            <span className="drift muted">time → · ν ↑</span>
          </div>
          {spectroBusy && <p className="chaos-note">Integrating orbit…</p>}
          {spectro && <SpectrogramPlot result={spectro} />}
          {spectro && (
            <p className="preset-desc">
              Each column is a short-time spectrum; the amber line is the NAFF fundamental. Dead-straight
              ⇒ a frozen frequency (regular torus); a wandering, smeared ridge ⇒ the orbit is diffusing
              across resonances (chaos).
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${cls ?? ''}`}>{value}</span>
    </div>
  )
}

/** Vertical resonance-line guides at a where n(a) = p/q (Jupiter's n = 1). */
function drawResonanceGuides(ctx: CanvasRenderingContext2D, model: AtlasModel, w: number, h: number): void {
  const lines = resonanceLines(model.aMin, model.aMax)
  ctx.save()
  ctx.font = `${Math.round(h * 0.05)}px ui-monospace, monospace`
  for (const { a, p, q } of lines) {
    const x = ((a - model.aMin) / (model.aMax - model.aMin)) * w
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.setLineDash([4, 4])
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.fillText(`${p}:${q}`, x + 2, h - 4)
  }
  ctx.restore()
}

/** A small horizontal colour bar legend for the active colour mode. */
function ColorBar({ mode, nMin, nMax }: { mode: ColorMode; nMin: number; nMax: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = canvas.clientWidth
    const h = 12
    canvas.width = Math.max(1, Math.round(w * dpr))
    canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    for (let x = 0; x < w; x++) {
      const t = x / (w - 1)
      const [r, g, b] = sampleColorMap(mode === 'diffusion' ? 'inferno' : 'viridis', t)
      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.fillRect(x, 0, 1, h)
    }
  }, [mode])
  const left = mode === 'diffusion' ? `${DIFF_LO} (regular)` : nMin.toFixed(2)
  const right = mode === 'diffusion' ? `${DIFF_HI} (chaos)` : nMax.toFixed(2)
  return (
    <div className="atlas-colorbar">
      <canvas ref={ref} style={{ width: '100%', height: 12 }} />
      <div className="atlas-colorbar-labels">
        <span>{left}</span>
        <span className="muted">{mode === 'diffusion' ? 'log₁₀|Δn/n|' : 'mean motion n'}</span>
        <span>{right}</span>
      </div>
    </div>
  )
}

/** Render a spectrogram: magnitude heatmap + the amber NAFF ridge. */
function SpectrogramPlot({ result }: { result: SpectrogramResult }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = canvas.clientWidth
    const h = 140
    canvas.width = Math.max(1, Math.round(w * dpr))
    canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const { cols, rows, mag, freqs, ridge, times } = result
    if (cols < 1 || rows < 1) return
    const cw = w / cols
    const ch = h / rows
    // Heatmap (row 0 = lowest frequency at the bottom).
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const t = mag[r * cols + c]
        if (t < 0.04) continue
        const [rr, gg, bb] = sampleColorMap('inferno', t)
        ctx.fillStyle = `rgb(${rr},${gg},${bb})`
        ctx.fillRect(Math.floor(c * cw), Math.floor((rows - 1 - r) * ch), Math.ceil(cw) + 1, Math.ceil(ch) + 1)
      }
    }
    // Frequency → y mapping for the ridge overlay.
    const fLo = freqs[0]
    const fHi = freqs[rows - 1]
    const yOf = (f: number) => h - ((f - fLo) / (fHi - fLo || 1)) * h
    ctx.strokeStyle = 'rgba(255,206,120,0.95)'
    ctx.lineWidth = 1.6
    ctx.beginPath()
    let started = false
    for (let c = 0; c < cols; c++) {
      const f = ridge[c]
      if (!Number.isFinite(f)) { started = false; continue }
      const x = (c + 0.5) * cw
      const y = yOf(f)
      if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
    }
    ctx.stroke()

    // Zero-frequency line if in range.
    if (fLo < 0 && fHi > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, yOf(0))
      ctx.lineTo(w, yOf(0))
      ctx.stroke()
    }
    ctx.fillStyle = 'rgba(255,255,255,0.4)'
    ctx.font = '9px ui-monospace, monospace'
    ctx.fillText(`t=${times[times.length - 1].toFixed(0)}`, w - 42, h - 3)
  }, [result])

  return <canvas className="plot" ref={ref} style={{ width: '100%', height: 140 }} />
}
