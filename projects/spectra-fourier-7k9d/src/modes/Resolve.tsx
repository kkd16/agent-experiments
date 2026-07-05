import { useEffect, useMemo, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Segmented, Toggle, Button, Readout } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import { fillPlotBg, grid, axisLabel, type Rect } from '../lib/draw'
import {
  generateSignal,
  analyze,
  type SignalConfig,
  type AnalyzeOptions,
  type Analysis,
  type MethodId,
} from '../lib/spectral'
import { readHashParams, shareLink, readNum, readStr, readBool } from '../lib/urlState'

const TEAL = '#5eead4'
const BLUE = '#38bdf8'
const VIOLET = '#a78bfa'
const AMBER = '#fbbf24'
const GRAY = 'rgba(148,163,184,0.9)'

type PresetId = 'twoClose' | 'closePlusFar' | 'threeTones'
const PRESETS: { id: PresetId; label: string }[] = [
  { id: 'twoClose', label: 'Two tones (sub-Rayleigh)' },
  { id: 'closePlusFar', label: 'Two close + one far' },
  { id: 'threeTones', label: 'Three separated tones' },
]

type ModelId = 'complex' | 'real'
const MODELS: { id: ModelId; label: string }[] = [
  { id: 'complex', label: 'Complex' },
  { id: 'real', label: 'Real' },
]

type SizeStr = '48' | '64' | '96' | '128'
const SIZES: { id: SizeStr; label: string }[] = [
  { id: '48', label: 'N = 48' },
  { id: '64', label: 'N = 64' },
  { id: '96', label: 'N = 96' },
  { id: '128', label: 'N = 128' },
]

interface MethodStyle {
  id: MethodId
  label: string
  color: string
  filled: boolean
}
const METHOD_STYLES: MethodStyle[] = [
  { id: 'periodogram', label: 'Periodogram (FFT)', color: GRAY, filled: true },
  { id: 'welch', label: 'Welch', color: BLUE, filled: false },
  { id: 'capon', label: 'Capon / MVDR', color: TEAL, filled: false },
  { id: 'burg', label: 'Burg (max-entropy)', color: AMBER, filled: false },
  { id: 'music', label: 'MUSIC', color: VIOLET, filled: false },
]

const DB_FLOOR = -45

// --- tone construction from a preset -----------------------------------------

function buildTones(
  preset: PresetId,
  N: number,
  base: number,
  sepBins: number,
): { freq: number; amp: number }[] {
  const fs = N // Hz == bin index; Rayleigh = 1 Hz
  const rayleigh = fs / N // = 1
  const nyq = fs / 2
  const clamp = (f: number) => Math.max(2, Math.min(nyq - 2, f))
  const sep = sepBins * rayleigh
  if (preset === 'twoClose') {
    return [
      { freq: clamp(base - sep / 2), amp: 1 },
      { freq: clamp(base + sep / 2), amp: 1 },
    ]
  }
  if (preset === 'closePlusFar') {
    return [
      { freq: clamp(base - sep / 2), amp: 1 },
      { freq: clamp(base + sep / 2), amp: 0.9 },
      { freq: clamp(nyq * 0.82), amp: 1.05 },
    ]
  }
  // threeTones: fixed, well-separated
  return [
    { freq: clamp(nyq * 0.24), amp: 1 },
    { freq: clamp(nyq * 0.5), amp: 0.85 },
    { freq: clamp(nyq * 0.78), amp: 1.1 },
  ]
}

// --- discrete peak-picking for the scoreboard --------------------------------

function pickPeaks(gridHz: Float64Array, curve: Float64Array, count: number, real: boolean): number[] {
  const peaks: { f: number; v: number }[] = []
  for (let i = 1; i < curve.length - 1; i++) {
    const hz = gridHz[i]
    if (real && hz < 0) continue
    if (curve[i] > curve[i - 1] && curve[i] >= curve[i + 1]) peaks.push({ f: hz, v: curve[i] })
  }
  peaks.sort((a, b) => b.v - a.v)
  const out: number[] = []
  for (const p of peaks) {
    if (out.length >= count) break
    // Dedup only near-coincident grid maxima of a single lobe; keep genuinely
    // distinct tones even when separated by well under one bin.
    if (out.every((f) => Math.abs(f - p.f) > 0.2)) out.push(real ? Math.abs(p.f) : p.f)
  }
  return out.sort((a, b) => a - b)
}

function matchError(estHz: number[], truthHz: number[]): { matched: number[]; maxErr: number } {
  const matched = truthHz.map((t) => {
    if (estHz.length === 0) return NaN
    let best = Infinity
    let bestF = NaN
    for (const e of estHz) {
      const d = Math.abs(e - t)
      if (d < best) {
        best = d
        bestF = e
      }
    }
    return bestF
  })
  let maxErr = 0
  matched.forEach((m, i) => {
    if (Number.isNaN(m)) maxErr = Infinity
    else maxErr = Math.max(maxErr, Math.abs(m - truthHz[i]))
  })
  return { matched, maxErr }
}

// --- canvas painters ---------------------------------------------------------

function drawSpectra(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  res: Analysis,
  selected: Set<MethodId>,
  truthHz: number[],
  real: boolean,
) {
  fillPlotBg(ctx, r)
  grid(ctx, r, 8, 5)
  const fs = res.fs
  const xmin = real ? 0 : -fs / 2
  const xmax = fs / 2
  const gx = (hz: number) => r.x + ((hz - xmin) / (xmax - xmin)) * r.w
  const gy = (db: number) => {
    const t = (db - DB_FLOOR) / (0 - DB_FLOOR)
    return r.y + r.h - (0.06 + 0.9 * Math.max(0, Math.min(1, t))) * r.h
  }
  const toDb = (pow: Float64Array) => {
    let mx = 1e-30
    for (let i = 0; i < pow.length; i++) if (pow[i] > mx) mx = pow[i]
    const out = new Float64Array(pow.length)
    for (let i = 0; i < pow.length; i++) out[i] = 10 * Math.log10(Math.max(pow[i], 1e-30) / mx)
    return out
  }

  // Rayleigh band: shade one DFT bin's width around the first true tone.
  if (truthHz.length >= 1) {
    const c = truthHz[0]
    const x0 = gx(Math.max(xmin, c - 0.5))
    const x1 = gx(Math.min(xmax, c + 0.5))
    ctx.fillStyle = 'rgba(251,113,133,0.10)'
    ctx.fillRect(x0, r.y, x1 - x0, r.h)
    ctx.strokeStyle = 'rgba(251,113,133,0.35)'
    ctx.setLineDash([3, 3])
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x0, r.y)
    ctx.lineTo(x0, r.y + r.h)
    ctx.moveTo(x1, r.y)
    ctx.lineTo(x1, r.y + r.h)
    ctx.stroke()
    ctx.setLineDash([])
  }

  const plot = (pow: Float64Array, color: string, filled: boolean, width: number) => {
    const db = toDb(pow)
    const pts: { x: number; y: number }[] = []
    for (let i = 0; i < db.length; i++) {
      const hz = res.gridHz[i]
      if (hz < xmin - 1e-9 || hz > xmax + 1e-9) continue
      pts.push({ x: gx(hz), y: gy(Math.max(db[i], DB_FLOOR)) })
    }
    if (pts.length === 0) return
    if (filled) {
      ctx.beginPath()
      ctx.moveTo(pts[0].x, r.y + r.h)
      for (const p of pts) ctx.lineTo(p.x, p.y)
      ctx.lineTo(pts[pts.length - 1].x, r.y + r.h)
      ctx.closePath()
      ctx.fillStyle = 'rgba(148,163,184,0.22)'
      ctx.fill()
    }
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.lineJoin = 'round'
    ctx.beginPath()
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
    ctx.stroke()
  }

  // Baselines (filled) first, then parametric lines on top.
  for (const st of METHOD_STYLES) {
    if (!selected.has(st.id) || !res.curves[st.id] || !st.filled) continue
    plot(res.curves[st.id]!, st.color, true, 1.8)
  }
  for (const st of METHOD_STYLES) {
    if (!selected.has(st.id) || !res.curves[st.id] || st.filled) continue
    plot(res.curves[st.id]!, st.color, false, 2)
  }

  // True-frequency markers.
  ctx.setLineDash([2, 4])
  ctx.strokeStyle = 'rgba(238,241,255,0.7)'
  ctx.lineWidth = 1.2
  for (const t of truthHz) {
    const x = gx(t)
    ctx.beginPath()
    ctx.moveTo(x, r.y + 2)
    ctx.lineTo(x, r.y + r.h - 2)
    ctx.stroke()
  }
  ctx.setLineDash([])

  // Axes.
  axisLabel(ctx, `${xmin.toFixed(0)} Hz`, r.x + 4, r.y + r.h - 6)
  axisLabel(ctx, `${xmax.toFixed(0)} Hz`, r.x + r.w - 4, r.y + r.h - 6, 'right')
  axisLabel(ctx, '0 dB', r.x + 4, r.y + 12)
  axisLabel(ctx, `${DB_FLOOR} dB`, r.x + 4, r.y + r.h - 20)
}

function drawEigen(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  eigvals: number[],
  p: number,
  kMDL: number,
) {
  fillPlotBg(ctx, r)
  grid(ctx, r, 8, 4)
  const M = eigvals.length
  let mx = 1e-30
  for (const v of eigvals) if (v > mx) mx = v
  const db = eigvals.map((v) => 10 * Math.log10(Math.max(v, 1e-30) / mx))
  const floor = Math.min(-60, Math.min(...db) - 3)
  const gy = (d: number) => r.y + r.h - ((d - floor) / (0 - floor)) * r.h * 0.9 - r.h * 0.05
  const bw = (r.w * 0.94) / M
  for (let i = 0; i < M; i++) {
    const x = r.x + r.w * 0.03 + i * bw
    const y = gy(db[i])
    ctx.fillStyle = i < p ? 'rgba(94,234,212,0.85)' : 'rgba(148,163,184,0.5)'
    ctx.fillRect(x, y, Math.max(1, bw * 0.8), r.y + r.h - y - r.h * 0.05)
  }
  // signal/noise split line at p
  const splitX = r.x + r.w * 0.03 + p * bw - bw * 0.1
  ctx.strokeStyle = 'rgba(167,139,250,0.9)'
  ctx.setLineDash([4, 3])
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.moveTo(splitX, r.y + 2)
  ctx.lineTo(splitX, r.y + r.h - 2)
  ctx.stroke()
  ctx.setLineDash([])
  axisLabel(ctx, `p = ${p}`, splitX + 4, r.y + 14)
  axisLabel(ctx, `MDL: ${kMDL}`, r.x + r.w - 4, r.y + 14, 'right')
  axisLabel(ctx, 'signal', r.x + 4, r.y + 14)
  axisLabel(ctx, 'noise floor →', r.x + r.w - 4, r.y + r.h - 6, 'right')
}

function drawZPlane(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  rmRoots: { re: number; im: number }[],
  esRoots: { re: number; im: number }[],
  trueOmegas: number[],
) {
  fillPlotBg(ctx, r)
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const rad = Math.min(r.w, r.h) * 0.4
  // axes
  ctx.strokeStyle = 'rgba(120,140,220,0.28)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(r.x + 8, cy)
  ctx.lineTo(r.x + r.w - 8, cy)
  ctx.moveTo(cx, r.y + 8)
  ctx.lineTo(cx, r.y + r.h - 8)
  ctx.stroke()
  // unit circle
  ctx.strokeStyle = 'rgba(120,140,220,0.5)'
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.arc(cx, cy, rad, 0, 2 * Math.PI)
  ctx.stroke()
  // true-angle rays
  ctx.strokeStyle = 'rgba(238,241,255,0.45)'
  ctx.setLineDash([2, 4])
  ctx.lineWidth = 1
  for (const w of trueOmegas) {
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + Math.cos(w) * rad * 1.12, cy - Math.sin(w) * rad * 1.12)
    ctx.stroke()
  }
  ctx.setLineDash([])
  const plotRoot = (z: { re: number; im: number }, fill: string, stroke: string, ring: boolean) => {
    const x = cx + z.re * rad
    const y = cy - z.im * rad
    ctx.beginPath()
    ctx.arc(x, y, ring ? 5 : 3.4, 0, 2 * Math.PI)
    if (ring) {
      ctx.strokeStyle = stroke
      ctx.lineWidth = 1.8
      ctx.stroke()
    } else {
      ctx.fillStyle = fill
      ctx.fill()
    }
  }
  for (const z of rmRoots) plotRoot(z, TEAL, TEAL, false)
  for (const z of esRoots) plotRoot(z, VIOLET, VIOLET, true)
  axisLabel(ctx, 'Re', r.x + r.w - 6, cy - 6, 'right')
  axisLabel(ctx, 'Im', cx + 6, r.y + 14)
  axisLabel(ctx, '● root-MUSIC', r.x + 6, r.y + r.h - 20)
  axisLabel(ctx, '○ ESPRIT', r.x + 6, r.y + r.h - 6)
}

// --- component ---------------------------------------------------------------

export default function Resolve() {
  const sp = useMemo(() => readHashParams(), [])
  const [preset, setPreset] = useState<PresetId>(() =>
    readStr<PresetId>(sp, 'p', 'twoClose', PRESETS.map((x) => x.id)),
  )
  const [model, setModel] = useState<ModelId>(() => readStr<ModelId>(sp, 'm', 'complex', ['complex', 'real']))
  const [sizeStr, setSizeStr] = useState<SizeStr>(() => readStr<SizeStr>(sp, 'n', '64', ['48', '64', '96', '128']))
  const [sepBins, setSepBins] = useState(() => readNum(sp, 'sep', 0.4))
  const [base, setBase] = useState(() => readNum(sp, 'f0', 0))
  const [snr, setSnr] = useState(() => readNum(sp, 'snr', 20))
  const [order, setOrder] = useState(() => Math.round(readNum(sp, 'M', 0)))
  const [fb, setFb] = useState(() => readBool(sp, 'fb', true))
  const [sources, setSources] = useState(() => Math.round(readNum(sp, 'src', 0)))
  const [autoOrder, setAutoOrder] = useState(() => readBool(sp, 'auto', false))
  const [burgOrder, setBurgOrder] = useState(() => Math.round(readNum(sp, 'burg', 0)))
  const [seedBump, setSeedBump] = useState(0)
  const [sel, setSel] = useState<Set<MethodId>>(() => {
    const s = sp.get('sel')
    if (s) return new Set(s.split(',').filter(Boolean) as MethodId[])
    return new Set<MethodId>(['periodogram', 'capon', 'burg', 'music'])
  })
  const [copied, setCopied] = useState(false)

  const N = parseInt(sizeStr, 10)
  const fs = N // Rayleigh = 1 Hz
  const nyq = fs / 2
  const seed = 2000 + seedBump

  // Default center frequency lands mid-band; base slider shifts it.
  const baseHz = Math.max(4, Math.min(nyq - 4, nyq * 0.45 + base))
  const tones = useMemo(() => buildTones(preset, N, baseHz, sepBins), [preset, N, baseHz, sepBins])
  const nTones = tones.length
  const complex = model === 'complex'

  // Sensible default estimator sizes derived from N and the tone count.
  const defaultM = Math.max(6, Math.min(Math.floor(N / 2), 28))
  const M = order > 0 ? Math.max(4, Math.min(order, Math.floor(N / 2))) : defaultM
  const defaultSources = complex ? nTones : nTones * 2
  const p = sources > 0 ? Math.min(sources, M - 1) : Math.min(defaultSources, M - 1)
  const defaultBurg = Math.max(8, Math.min(Math.floor(N / 3), 24))
  const burg = burgOrder > 0 ? Math.min(burgOrder, N - 1) : defaultBurg

  const cfg = useMemo<SignalConfig>(
    () => ({ N, fs, tones, snrDb: snr, complex, seed }),
    [N, fs, tones, snr, complex, seed],
  )
  const sig = useMemo(() => generateSignal(cfg), [cfg])

  const opts = useMemo<AnalyzeOptions>(
    () => ({
      M,
      p,
      autoOrder,
      forwardBackward: fb,
      burgOrder: burg,
      gridSize: 1600,
      methods: Array.from(sel),
    }),
    [M, p, autoOrder, fb, burg, sel],
  )
  const res = useMemo(() => analyze(sig, cfg, opts), [sig, cfg, opts])

  const truthHz = tones.map((t) => t.freq)
  const trueOmegas = useMemo(() => {
    const ws: number[] = []
    for (const t of tones) {
      const w = (2 * Math.PI * t.freq) / fs
      ws.push(w)
      if (!complex) ws.push(-w)
    }
    return ws
  }, [tones, fs, complex])

  // scoreboard rows
  const rows = useMemo(() => {
    const real = !complex
    const per = res.curves.periodogram
    const mus = res.curves.music
    const bur = res.curves.burg
    const list: { name: string; est: number[]; err: number }[] = []
    if (per) {
      const est = pickPeaks(res.gridHz, per, nTones, real)
      list.push({ name: 'Periodogram (FFT)', est, err: matchError(est, truthHz).maxErr })
    }
    list.push({ name: 'Root-MUSIC', est: res.rootMusic.freqsHz, err: matchError(res.rootMusic.freqsHz, truthHz).maxErr })
    list.push({ name: 'ESPRIT', est: res.esprit.freqsHz, err: matchError(res.esprit.freqsHz, truthHz).maxErr })
    if (mus) {
      const est = pickPeaks(res.gridHz, mus, nTones, real)
      list.push({ name: 'MUSIC (peak)', est, err: matchError(est, truthHz).maxErr })
    }
    if (bur) {
      const est = pickPeaks(res.gridHz, bur, nTones, real)
      list.push({ name: 'Burg (peak)', est, err: matchError(est, truthHz).maxErr })
    }
    return list
  }, [res, complex, nTones, truthHz])

  // canvases
  const { ref: specRef, size: specSize } = useDprCanvas()
  const { ref: eigRef, size: eigSize } = useDprCanvas()
  const { ref: zRef, size: zSize } = useDprCanvas()

  useEffect(() => {
    const ctx = prepareContext(specRef.current, specSize)
    if (ctx) drawSpectra(ctx, { x: 0, y: 0, w: specSize.width, h: specSize.height }, res, sel, truthHz, !complex)
  }, [res, specSize, specRef, sel, truthHz, complex])

  useEffect(() => {
    const ctx = prepareContext(eigRef.current, eigSize)
    if (ctx) drawEigen(ctx, { x: 0, y: 0, w: eigSize.width, h: eigSize.height }, res.eigenvalues, res.usedP, res.order.kMDL)
  }, [res, eigSize, eigRef])

  useEffect(() => {
    const ctx = prepareContext(zRef.current, zSize)
    if (ctx) drawZPlane(ctx, { x: 0, y: 0, w: zSize.width, h: zSize.height }, res.rootMusic.roots, res.esprit.roots, trueOmegas)
  }, [res, zSize, zRef, trueOmegas])

  const toggleMethod = (id: MethodId) => {
    setSel((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const onShare = () => {
    shareLink('resolve', {
      p: preset,
      m: model,
      n: sizeStr,
      sep: sepBins.toFixed(2),
      f0: base.toFixed(1),
      snr: snr.toFixed(0),
      M: order,
      fb,
      src: sources,
      auto: autoOrder,
      burg: burgOrder,
      sel: Array.from(sel).join(','),
    }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  const showSep = preset !== 'threeTones'
  const rmErr = rows.find((r) => r.name === 'Root-MUSIC')?.err ?? Infinity
  const perErr = rows.find((r) => r.name === 'Periodogram (FFT)')?.err ?? Infinity
  const resolved = Number.isFinite(rmErr) && rmErr < 0.4 && (res.rootMusic.freqsHz.length >= nTones)

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Signal">
          <Field label="Scenario">
            <Select value={preset} options={PRESETS} onChange={setPreset} />
          </Field>
          <Field label="Model">
            <Segmented value={model} options={MODELS} onChange={setModel} />
          </Field>
          <Field label="Length N">
            <Select value={sizeStr} options={SIZES} onChange={setSizeStr} />
          </Field>
          {showSep && (
            <Field label="Separation" value={`${sepBins.toFixed(2)} bins`}>
              <Slider min={0.1} max={4} step={0.05} value={sepBins} onChange={setSepBins} />
            </Field>
          )}
          {showSep && (
            <Field label="Center shift" value={`${base >= 0 ? '+' : ''}${base.toFixed(0)} Hz`}>
              <Slider min={-nyq * 0.35} max={nyq * 0.35} step={1} value={base} onChange={setBase} />
            </Field>
          )}
          <Field label="SNR" value={`${snr.toFixed(0)} dB`}>
            <Slider min={-5} max={40} step={1} value={snr} onChange={setSnr} />
          </Field>
          <div className="btn-row">
            <Button variant="ghost" onClick={() => setSeedBump((s) => s + 1)}>
              New noise
            </Button>
          </div>
        </Panel>

        <Panel title="Estimator">
          <Field label="Snapshot order M" value={String(M)}>
            <Slider min={4} max={Math.floor(N / 2)} step={1} value={M} onChange={(v) => setOrder(Math.round(v))} />
          </Field>
          <Toggle label="Forward–backward averaging" checked={fb} onChange={setFb} />
          <Toggle label="Auto order (MDL)" checked={autoOrder} onChange={setAutoOrder} />
          {!autoOrder && (
            <Field label="Sources p" value={String(p)}>
              <Slider min={1} max={Math.max(2, M - 1)} step={1} value={p} onChange={(v) => setSources(Math.round(v))} />
            </Field>
          )}
          <Field label="Burg AR order" value={String(burg)}>
            <Slider min={2} max={Math.min(N - 1, 40)} step={1} value={burg} onChange={(v) => setBurgOrder(Math.round(v))} />
          </Field>
        </Panel>

        <Panel title="Overlay">
          {METHOD_STYLES.map((s) => (
            <Toggle key={s.id} label={s.label} checked={sel.has(s.id)} onChange={() => toggleMethod(s.id)} />
          ))}
        </Panel>

        <Panel title="Verdict">
          <Readout
            items={[
              { label: 'Rayleigh', value: `${res.rayleighHz.toFixed(2)} Hz` },
              { label: 'Separation', value: showSep ? `${sepBins.toFixed(2)} bin` : 'wide' },
              { label: 'MDL sources', value: String(res.order.kMDL) },
              { label: 'Root-MUSIC err', value: Number.isFinite(rmErr) ? `${(rmErr * 1000).toFixed(0)} mHz` : '—' },
            ]}
          />
          <div className={`resolve-badge ${resolved ? 'ok' : 'no'}`}>
            {resolved ? 'subspace resolves ✓' : 'not resolved'}
          </div>
          <div className="btn-row">
            <Button variant="ghost" onClick={onShare}>
              {copied ? 'Link copied ✓' : 'Copy link'}
            </Button>
          </div>
        </Panel>
      </div>

      <div className="mode-main">
        <p className="mode-intro">
          The FFT has a wall the rest of the lab respects: the <strong>Rayleigh limit</strong>. Two
          tones closer than one bin (<code>Δf = fs/N = {res.rayleighHz.toFixed(2)} Hz</code>) merge into
          a single blurry lobe, and zero-padding buys resolution you cannot actually have. The{' '}
          <strong>subspace</strong> estimators here model the signal as a few sinusoids and read the
          frequencies straight out of the <strong>eigenstructure of the covariance matrix</strong> —
          placing tones far below the bin. Watch the grey <em>periodogram</em> fail to split the two
          markers while <span style={{ color: VIOLET }}>MUSIC</span>,{' '}
          <span style={{ color: TEAL }}>Capon</span> and <span style={{ color: AMBER }}>Burg</span>{' '}
          resolve them — and <strong>Root-MUSIC</strong> / <strong>ESPRIT</strong> land grid-free on
          the unit circle. Every eigenvalue and eigenvector is computed by a from-scratch Hermitian
          Jacobi solver; no math libraries.
        </p>

        <CanvasCard
          title="Spectra — the resolution gap"
          note={`${complex ? 'complex' : 'real'} · N=${N} · shaded band = one DFT bin`}
          height={340}
        >
          <canvas ref={specRef} />
        </CanvasCard>

        <div className="tomo-grid">
          <CanvasCard title="Eigenvalue profile" note={`signal / noise split · L=${res.L} snapshots`} aspect={1.7}>
            <canvas ref={eigRef} />
          </CanvasCard>
          <CanvasCard title="z-plane — grid-free estimates" note="roots on the unit circle at the true angles" aspect={1.7}>
            <canvas ref={zRef} />
          </CanvasCard>
        </div>

        <div className="resolve-board">
          <div className="resolve-board-head">
            <span>Method</span>
            <span>Estimated frequencies (Hz)</span>
            <span>Max error</span>
            <span>Resolved</span>
          </div>
          {rows.map((row) => {
            const ok = Number.isFinite(row.err) && row.err < 0.4 && row.est.length >= nTones
            return (
              <div className="resolve-board-row" key={row.name}>
                <span className="rb-name">{row.name}</span>
                <span className="rb-est">{row.est.length ? row.est.map((f) => f.toFixed(2)).join(' · ') : '—'}</span>
                <span className="rb-err">{Number.isFinite(row.err) ? `${(row.err * 1000).toFixed(0)} mHz` : '—'}</span>
                <span className={ok ? 'rb-ok' : 'rb-no'}>{ok ? '✓' : '✗'}</span>
              </div>
            )
          })}
          <p className="resolve-truth">
            true: {truthHz.map((f) => f.toFixed(2)).join(' · ')} Hz
            {'  ·  '}
            FFT peak-picks {Number.isFinite(perErr) ? `${(perErr * 1000).toFixed(0)} mHz off` : 'a single lobe'}.
          </p>
        </div>
      </div>
    </div>
  )
}
