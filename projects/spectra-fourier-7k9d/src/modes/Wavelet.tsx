import { useEffect, useMemo, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Segmented, Toggle, Readout, Button } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import type { CanvasSize } from '../hooks/useDprCanvas'
import { COLORMAPS, colormapLUT } from '../lib/colormap'
import type { ColormapName } from '../lib/colormap'
import { cwtMorlet, reduceTime } from '../lib/wavelet'
import { stft } from '../lib/stft'
import {
  ALL_WAVELETS,
  getBank,
  maxLevel,
  mra,
  denoise,
  magnitudeResponse,
  snrDb,
  type ShrinkRule,
  type ThresholdMode,
} from '../lib/dwt'
import {
  DWT_SIGNALS,
  dwtSignal,
  mraDemoSignal,
  addNoise,
  type DwtSignalName,
} from '../lib/dwtSignals'
import {
  wpAnalyze,
  bestBasis,
  wpLeafSignal,
  spectralCentroid,
  type CostName,
} from '../lib/wp'
import { compress2, dwt2 } from '../lib/wavelet2d'
import { proceduralImage, IMAGES, type ImageName } from '../lib/images'
import { readHashParams, shareLink, readNum, readStr } from '../lib/urlState'

const FS = 500
const LEN = 1000
const DURATION = LEN / FS // 2 s
const DWT_N = 1024 // power of two for the critically-sampled transform

// Palette shared with the app's brand.
const TEAL = '#5eead4'
const BLUE = '#38bdf8'
const VIOLET = '#a78bfa'
const ROSE = '#fb7185'
const AMBER = '#fbbf24'

type Tab = 'scalogram' | 'mra' | 'denoise' | 'packets' | 'compress2'
const TABS: { id: Tab; label: string }[] = [
  { id: 'scalogram', label: 'Scalogram (CWT)' },
  { id: 'mra', label: 'Multiresolution' },
  { id: 'denoise', label: 'Denoise' },
  { id: 'packets', label: 'Best basis' },
  { id: 'compress2', label: 'Image 2-D' },
]

// ---------------------------------------------------------------------------
// Small canvas plotters
// ---------------------------------------------------------------------------

interface Series {
  data: ArrayLike<number>
  color: string
  width?: number
  alpha?: number
}

function drawLines(
  canvas: HTMLCanvasElement | null,
  size: CanvasSize,
  series: Series[],
  opts?: { symmetric?: boolean; lo?: number; hi?: number; pad?: number },
): CanvasRenderingContext2D | null {
  const ctx = prepareContext(canvas, size)
  if (!ctx) return null
  const { width: w, height: h } = size
  ctx.fillStyle = '#0a0e1a'
  ctx.fillRect(0, 0, w, h)
  let lo = opts?.lo ?? Infinity
  let hi = opts?.hi ?? -Infinity
  if (opts?.lo === undefined || opts?.hi === undefined) {
    for (const s of series) for (let i = 0; i < s.data.length; i++) {
      const v = s.data[i]
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  if (opts?.symmetric) {
    const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1
    lo = -m
    hi = m
  }
  if (!isFinite(lo) || !isFinite(hi) || lo === hi) {
    lo = -1
    hi = 1
  }
  const pad = opts?.pad ?? 8
  const xAt = (i: number, n: number) => pad + (n <= 1 ? 0 : (i / (n - 1)) * (w - 2 * pad))
  const yAt = (v: number) => pad + (1 - (v - lo) / (hi - lo)) * (h - 2 * pad)
  if (lo < 0 && hi > 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(pad, yAt(0))
    ctx.lineTo(w - pad, yAt(0))
    ctx.stroke()
  }
  for (const s of series) {
    const n = s.data.length
    ctx.strokeStyle = s.color
    ctx.lineWidth = s.width ?? 1.5
    ctx.globalAlpha = s.alpha ?? 1
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const px = xAt(i, n)
      const py = yAt(s.data[i])
      if (i) ctx.lineTo(px, py)
      else ctx.moveTo(px, py)
    }
    ctx.stroke()
    ctx.globalAlpha = 1
  }
  return ctx
}

// Render a [rows][cols] matrix (row 0 = lowest frequency) as a colormapped image.
function drawMatrix(
  canvas: HTMLCanvasElement | null,
  size: CanvasSize,
  rows: Float64Array[],
  cols: number,
  maxVal: number,
  floorDb: number,
  lut: Uint8ClampedArray,
): CanvasRenderingContext2D | null {
  const ctx = prepareContext(canvas, size)
  if (!ctx || rows.length === 0) return null
  const nRows = rows.length
  const off = document.createElement('canvas')
  off.width = cols
  off.height = nRows
  const octx = off.getContext('2d')
  if (!octx) return null
  const img = octx.createImageData(cols, nRows)
  const range = -floorDb
  for (let r = 0; r < nRows; r++) {
    const row = rows[r]
    const y = nRows - 1 - r
    for (let c = 0; c < cols; c++) {
      const db = 10 * Math.log10(row[c] / maxVal + 1e-12)
      let tt = (db - floorDb) / range
      tt = tt < 0 ? 0 : tt > 1 ? 1 : tt
      const li = (Math.round(tt * 255) & 255) * 4
      const pi = (y * cols + c) * 4
      img.data[pi] = lut[li]
      img.data[pi + 1] = lut[li + 1]
      img.data[pi + 2] = lut[li + 2]
      img.data[pi + 3] = 255
    }
  }
  octx.putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(off, 0, 0, cols, nRows, 0, 0, size.width, size.height)
  return ctx
}

// ---------------------------------------------------------------------------
// Signals for the CWT scalogram tab (unchanged behaviour)
// ---------------------------------------------------------------------------

type WSignal = 'crossing' | 'transient' | 'steps' | 'chirp' | 'twoTone'
const SIGNALS: { id: WSignal; label: string }[] = [
  { id: 'crossing', label: 'Crossing chirps' },
  { id: 'transient', label: 'Tone + click' },
  { id: 'steps', label: 'Frequency steps' },
  { id: 'chirp', label: 'Chirp (sweep)' },
  { id: 'twoTone', label: 'Two tones' },
]

function waveletSignal(name: WSignal, n: number, fs: number, base: number): Float64Array {
  const out = new Float64Array(n)
  const dur = n / fs
  for (let i = 0; i < n; i++) {
    const t = i / fs
    let v = 0
    switch (name) {
      case 'chirp': {
        const f1 = base * 6
        const rate = (f1 - base) / dur
        v = Math.sin(2 * Math.PI * (base * t + 0.5 * rate * t * t))
        break
      }
      case 'crossing': {
        const up = base + ((base * 5) / dur) * t
        const down = base * 6 - ((base * 5) / dur) * t
        v = 0.7 * Math.sin(2 * Math.PI * up * t) + 0.7 * Math.sin(2 * Math.PI * down * t)
        break
      }
      case 'transient': {
        v = 0.8 * Math.sin(2 * Math.PI * base * 3 * t)
        const tc = dur * 0.5
        const env = Math.exp(-((t - tc) ** 2) / (2 * 0.004 ** 2))
        v += 1.4 * env * Math.sin(2 * Math.PI * base * 14 * t)
        break
      }
      case 'steps': {
        const seg = Math.floor((t / dur) * 3)
        const f = base * [1, 2, 4][Math.min(2, seg)]
        v = Math.sin(2 * Math.PI * f * t)
        break
      }
      case 'twoTone':
        v = 0.6 * Math.sin(2 * Math.PI * base * t) + 0.5 * Math.sin(2 * Math.PI * base * 3 * t)
        break
    }
    out[i] = v
  }
  return out
}

// ===========================================================================
// Tab 1 — CWT scalogram vs STFT
// ===========================================================================

function ScalogramTab() {
  const sp = useMemo(() => readHashParams(), [])
  const [signal, setSignal] = useState<WSignal>(() =>
    readStr<WSignal>(sp, 'sig', 'crossing', SIGNALS.map((s) => s.id)),
  )
  const [base, setBase] = useState(() => readNum(sp, 'f', 12))
  const [omega0, setOmega0] = useState(() => readNum(sp, 'w0', 6))
  const [cmap, setCmap] = useState<ColormapName>(() =>
    readStr<ColormapName>(sp, 'cm', 'magma', COLORMAPS.map((c) => c.id)),
  )
  const [floorDb, setFloorDb] = useState(() => readNum(sp, 'fl', -34))
  const [copied, setCopied] = useState(false)

  const { ref: cwtRef, size: cwtSize } = useDprCanvas()
  const { ref: stftRef, size: stftSize } = useDprCanvas()

  const raw = useMemo(() => waveletSignal(signal, LEN, FS, base), [signal, base])

  const scalogram = useMemo(() => {
    const res = cwtMorlet(raw, { fs: FS, omega0, scalesPerOctave: 14 })
    const reduced = reduceTime(res, 520)
    let max = 1e-12
    for (const row of reduced.cols) for (let i = 0; i < row.length; i++) if (row[i] > max) max = row[i]
    return { ...reduced, max, freqs: res.freqs }
  }, [raw, omega0])

  const spectro = useMemo(() => {
    const res = stft(raw, { fftSize: 128, hop: 16, window: 'hann' })
    const bins = res.bins
    const cols = res.frames.length
    const rows: Float64Array[] = []
    let max = 1e-12
    for (let b = 0; b < bins; b++) {
      const row = new Float64Array(cols)
      for (let c = 0; c < cols; c++) {
        const p = Math.pow(10, res.frames[c][b] / 10)
        row[c] = p
        if (p > max) max = p
      }
      rows.push(row)
    }
    return { rows, cols, max, bins }
  }, [raw])

  useEffect(() => {
    const lut = colormapLUT(cmap)
    const ctx = drawMatrix(cwtRef.current, cwtSize, scalogram.cols, scalogram.columns, scalogram.max, floorDb, lut)
    if (!ctx) return
    const { width: w, height: h } = cwtSize
    const freqs = scalogram.freqs
    const nRows = freqs.length
    ctx.font = '11px JetBrains Mono, ui-monospace, monospace'
    ctx.textAlign = 'left'
    for (const frac of [0.0, 0.33, 0.66, 0.99]) {
      const ri = Math.round(frac * (nRows - 1))
      const y = h - (ri / (nRows - 1)) * h
      const yy = Math.max(12, Math.min(h - 6, y))
      ctx.fillStyle = 'rgba(7,9,18,0.55)'
      ctx.fillRect(2, yy - 11, 58, 13)
      ctx.fillStyle = 'rgba(238,241,255,0.92)'
      ctx.fillText(`${freqs[ri].toFixed(0)} Hz`, 5, yy)
    }
    ctx.textAlign = 'center'
    for (const s of [DURATION * 0.25, DURATION * 0.5, DURATION * 0.75]) {
      const x = (s / DURATION) * w
      ctx.fillStyle = 'rgba(7,9,18,0.55)'
      ctx.fillRect(x - 16, h - 16, 32, 14)
      ctx.fillStyle = 'rgba(238,241,255,0.92)'
      ctx.fillText(`${s.toFixed(1)}s`, x, h - 5)
    }
  }, [scalogram, cwtSize, cwtRef, cmap, floorDb])

  useEffect(() => {
    const lut = colormapLUT(cmap)
    drawMatrix(stftRef.current, stftSize, spectro.rows, spectro.cols, spectro.max, floorDb, lut)
  }, [spectro, stftSize, stftRef, cmap, floorDb])

  const onShare = () => {
    shareLink('wavelet', { tab: 'scalogram', sig: signal, f: base, w0: omega0, cm: cmap, fl: floorDb }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Signal">
          <Field label="Test signal">
            <Select value={signal} options={SIGNALS} onChange={setSignal} />
          </Field>
          <Field label="Base frequency" value={`${base} Hz`}>
            <Slider min={6} max={30} step={1} value={base} onChange={(v) => setBase(Math.round(v))} />
          </Field>
        </Panel>
        <Panel title="Wavelet">
          <Field label="Morlet width ω₀" value={omega0.toFixed(1)}>
            <Slider min={4} max={12} step={0.5} value={omega0} onChange={setOmega0} />
          </Field>
          <p className="hint">
            Low ω₀ favours <em>time</em> resolution (sharp events); high ω₀ favours <em>frequency</em>{' '}
            resolution (pure tones).
          </p>
          <Readout
            items={[
              { label: 'Scales', value: String(scalogram.freqs.length) },
              { label: 'ω₀', value: omega0.toFixed(1) },
              { label: 'Samples', value: String(LEN) },
            ]}
          />
        </Panel>
        <Panel title="Display">
          <Field label="Colormap">
            <Select value={cmap} options={COLORMAPS} onChange={setCmap} />
          </Field>
          <Field label="Dynamic range floor" value={`${floorDb} dB`}>
            <Slider min={-60} max={-12} step={2} value={floorDb} onChange={(v) => setFloorDb(Math.round(v))} />
          </Field>
          <div className="btn-row">
            <Button variant="primary" onClick={onShare}>
              {copied ? 'Link copied ✓' : 'Copy link'}
            </Button>
          </div>
        </Panel>
      </div>
      <div className="mode-main">
        <p className="mode-intro">
          The STFT analyses every frequency with the <strong>same</strong> window, so it trades time
          sharpness for frequency sharpness once and for all. The <strong>continuous wavelet</strong>{' '}
          transform instead stretches a little wave — the <em>Morlet</em> — to fit each frequency:
          short and punchy up high, long and selective down low. Try <em>Tone + click</em>: the
          wavelet pins the click to an instant while still resolving the tone.
        </p>
        <CanvasCard title="Wavelet scalogram" note="Morlet CWT · log-frequency" aspect={2.2}>
          <canvas ref={cwtRef} />
        </CanvasCard>
        <CanvasCard title="STFT spectrogram" note="128-pt fixed window · for contrast" aspect={2.8}>
          <canvas ref={stftRef} />
        </CanvasCard>
      </div>
    </div>
  )
}

// ===========================================================================
// Tab 2 — Multiresolution analysis (DWT)
// ===========================================================================

function MraTab() {
  const sp = useMemo(() => readHashParams(), [])
  const [wavelet, setWavelet] = useState(() => readStr(sp, 'w', 'db4', ALL_WAVELETS.map((w) => w.id)))
  const [levels, setLevels] = useState(() => readNum(sp, 'lv', 5))
  const [copied, setCopied] = useState(false)

  const { ref: sigRef, size: sigSize } = useDprCanvas()
  const { ref: bandsRef, size: bandsSize } = useDprCanvas()
  const { ref: respRef, size: respSize } = useDprCanvas()

  const bank = useMemo(() => getBank(wavelet), [wavelet])
  const signal = useMemo(() => mraDemoSignal(DWT_N), [])
  const maxLv = useMemo(() => maxLevel(DWT_N, bank), [bank])
  const lv = Math.min(levels, maxLv)

  const decomp = useMemo(() => mra(signal, bank, lv), [signal, bank, lv])

  // Reconstruction error + per-band energy.
  const stats = useMemo(() => {
    let err = 0
    const N = signal.length
    for (let i = 0; i < N; i++) {
      let s = decomp.approx[i]
      for (const d of decomp.details) s += d[i]
      err = Math.max(err, Math.abs(s - signal[i]))
    }
    const energyOf = (a: Float64Array) => {
      let e = 0
      for (let i = 0; i < a.length; i++) e += a[i] * a[i]
      return e
    }
    let total = energyOf(decomp.approx)
    for (const d of decomp.details) total += energyOf(d)
    const bandEnergy = [energyOf(decomp.approx) / total, ...decomp.details.map((d) => energyOf(d) / total)]
    return { err, bandEnergy }
  }, [decomp, signal])

  // ---- draw original ----
  useEffect(() => {
    drawLines(sigRef.current, sigSize, [{ data: signal, color: TEAL, width: 1.2 }], { symmetric: true })
  }, [signal, sigSize, sigRef])

  // ---- draw stacked bands ----
  useEffect(() => {
    const ctx = prepareContext(bandsRef.current, bandsSize)
    if (!ctx) return
    const { width: w, height: h } = bandsSize
    ctx.fillStyle = '#0a0e1a'
    ctx.fillRect(0, 0, w, h)
    const bands: { data: Float64Array; label: string; color: string }[] = [
      { data: decomp.approx, label: `A${lv} · approximation`, color: BLUE },
      ...decomp.details
        .map((d, i) => ({ data: d, label: `D${i + 1} · detail`, color: i % 2 ? VIOLET : TEAL }))
        .reverse(),
    ]
    const laneH = h / bands.length
    const N = signal.length
    ctx.font = '10px JetBrains Mono, ui-monospace, monospace'
    bands.forEach((band, li) => {
      const y0 = li * laneH
      // local symmetric scale
      let m = 1e-9
      for (let i = 0; i < N; i++) m = Math.max(m, Math.abs(band.data[i]))
      const mid = y0 + laneH / 2
      // lane separator + baseline
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, y0)
      ctx.lineTo(w, y0)
      ctx.stroke()
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'
      ctx.beginPath()
      ctx.moveTo(0, mid)
      ctx.lineTo(w, mid)
      ctx.stroke()
      // trace
      ctx.strokeStyle = band.color
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let i = 0; i < N; i++) {
        const px = (i / (N - 1)) * w
        const py = mid - (band.data[i] / m) * (laneH * 0.42)
        if (i) ctx.lineTo(px, py)
        else ctx.moveTo(px, py)
      }
      ctx.stroke()
      // label + energy
      const eng = stats.bandEnergy[li === 0 ? 0 : lv - (li - 1)]
      ctx.fillStyle = 'rgba(7,9,18,0.6)'
      ctx.fillRect(4, y0 + 3, 150, 14)
      ctx.fillStyle = band.color
      ctx.textAlign = 'left'
      ctx.fillText(`${band.label}   ${(eng * 100).toFixed(1)}% energy`, 8, y0 + 13)
    })
  }, [decomp, bandsSize, bandsRef, signal, lv, stats])

  // ---- draw filter frequency responses ----
  useEffect(() => {
    const ctx = prepareContext(respRef.current, respSize)
    if (!ctx) return
    const { width: w, height: h } = respSize
    ctx.fillStyle = '#0a0e1a'
    ctx.fillRect(0, 0, w, h)
    const M = 256
    const loR = magnitudeResponse(bank.lo, M)
    const hiR = magnitudeResponse(bank.hi, M)
    const pad = 6
    const xAt = (i: number) => pad + (i / M) * (w - 2 * pad)
    const yAt = (v: number) => h - pad - (v / Math.SQRT2) * (h - 2 * pad)
    // grid at |H|=1
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.moveTo(pad, yAt(1))
    ctx.lineTo(w - pad, yAt(1))
    ctx.stroke()
    const trace = (r: Float64Array, color: string) => {
      ctx.strokeStyle = color
      ctx.lineWidth = 1.6
      ctx.beginPath()
      for (let i = 0; i <= M; i++) {
        const px = xAt(i)
        const py = yAt(r[i])
        if (i) ctx.lineTo(px, py)
        else ctx.moveTo(px, py)
      }
      ctx.stroke()
    }
    trace(loR, BLUE)
    trace(hiR, ROSE)
    ctx.font = '10px JetBrains Mono, ui-monospace, monospace'
    ctx.textAlign = 'left'
    ctx.fillStyle = BLUE
    ctx.fillText('H₀ scaling (low-pass)', 8, 14)
    ctx.fillStyle = ROSE
    ctx.fillText('H₁ wavelet (high-pass)', 8, 28)
    ctx.fillStyle = 'rgba(238,241,255,0.6)'
    ctx.textAlign = 'right'
    ctx.fillText('ω = 0', xAt(0) + 34, h - 8)
    ctx.fillText('π', xAt(M) - 2, h - 8)
  }, [bank, respSize, respRef])

  const onShare = () => {
    shareLink('wavelet', { tab: 'mra', w: wavelet, lv }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  const isBior = bank.family === 'bior'

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Wavelet">
          <Field label="Family">
            <Select value={wavelet} options={ALL_WAVELETS} onChange={setWavelet} />
          </Field>
          <Field label="Decomposition levels" value={`${lv} / ${maxLv}`}>
            <Slider min={1} max={maxLv} step={1} value={lv} onChange={(v) => setLevels(Math.round(v))} />
          </Field>
          <Readout
            items={[
              { label: isBior ? 'Analysis taps' : 'Filter taps', value: String(bank.len) },
              { label: 'Vanishing moments', value: String(bank.vanishing) },
              { label: 'Recon. error', value: stats.err.toExponential(1) },
            ]}
          />
          <p className="hint">
            {isBior ? (
              <>
                A <strong>biorthogonal</strong> pair — symmetric (linear-phase), unlike any orthonormal
                wavelet but Haar — run by the <strong>lifting scheme</strong>. It is the transform
                JPEG-2000 uses; 5/3 is the reversible one.
              </>
            ) : (
              <>
                The scaling &amp; wavelet filters are <strong>derived from scratch</strong> — Daubechies'
                half-band polynomial, factored by the lab's own root finder. No coefficient tables.
              </>
            )}
          </p>
        </Panel>
        <Panel title="Filter bank">
          <CanvasCard title="Analysis QMF pair" note="|H(ω)| over [0, π]" aspect={2.1}>
            <canvas ref={respRef} />
          </CanvasCard>
          <p className="hint">
            {isBior ? (
              <>
                The analysis low-/high-pass split the spectrum near ω = π/2. Their <em>synthesis</em>{' '}
                duals differ (that is what "biorthogonal" means) — lifting keeps the round-trip exact.
              </>
            ) : (
              <>
                The two half-band filters split the spectrum at ω = π/2 and power-complement to a flat
                line — that is exactly what makes the transform lossless.
              </>
            )}
          </p>
          <div className="btn-row">
            <Button variant="primary" onClick={onShare}>
              {copied ? 'Link copied ✓' : 'Copy link'}
            </Button>
          </div>
        </Panel>
      </div>
      <div className="mode-main">
        <p className="mode-intro">
          A <strong>multiresolution analysis</strong> peels a signal apart scale by scale. Each level
          splits what's left into a smooth <em>approximation</em> and a <em>detail</em> band an octave
          wide, then recurses on the approximation. Every band is projected back to full length here,
          and they sum <em>exactly</em> back to the input — reconstruction error{' '}
          <strong>{stats.err.toExponential(1)}</strong>, at the floating-point floor.
        </p>
        <CanvasCard title="Signal" note="carrier + mid burst + steady tone + sharp click" aspect={4.5}>
          <canvas ref={sigRef} />
        </CanvasCard>
        <CanvasCard
          title="Multiresolution bands"
          note="approximation on top, finest detail at the bottom"
          aspect={1.05}
        >
          <canvas ref={bandsRef} />
        </CanvasCard>
      </div>
    </div>
  )
}

// ===========================================================================
// Tab 3 — Wavelet denoising
// ===========================================================================

const RULES: { id: ShrinkRule; label: string }[] = [
  { id: 'universal', label: 'VisuShrink' },
  { id: 'sure', label: 'SureShrink' },
  { id: 'bayes', label: 'BayesShrink' },
]
const MODES: { id: ThresholdMode; label: string }[] = [
  { id: 'soft', label: 'Soft' },
  { id: 'hard', label: 'Hard' },
]

function DenoiseTab() {
  const sp = useMemo(() => readHashParams(), [])
  const [signalName, setSignalName] = useState<DwtSignalName>(() =>
    readStr<DwtSignalName>(sp, 'sig', 'blocks', DWT_SIGNALS.map((s) => s.id)),
  )
  const [wavelet, setWavelet] = useState(() => readStr(sp, 'w', 'sym8', ALL_WAVELETS.map((w) => w.id)))
  const [sigma, setSigma] = useState(() => readNum(sp, 'n', 0.5))
  const [rule, setRule] = useState<ShrinkRule>(() =>
    readStr<ShrinkRule>(sp, 'r', 'sure', RULES.map((r) => r.id)),
  )
  const [mode, setMode] = useState<ThresholdMode>(() =>
    readStr<ThresholdMode>(sp, 'm', 'soft', MODES.map((m) => m.id)),
  )
  const [showClean, setShowClean] = useState(true)
  const [copied, setCopied] = useState(false)

  const { ref: noisyRef, size: noisySize } = useDprCanvas()
  const { ref: cleanRef, size: cleanSize } = useDprCanvas()

  const bank = useMemo(() => getBank(wavelet), [wavelet])
  const clean = useMemo(() => dwtSignal(signalName, DWT_N), [signalName])
  const noisy = useMemo(() => addNoise(clean, sigma, 7), [clean, sigma])
  const lv = useMemo(() => maxLevel(DWT_N, bank), [bank])
  const result = useMemo(() => denoise(noisy, bank, lv, rule, mode), [noisy, bank, lv, rule, mode])

  const snrIn = useMemo(() => snrDb(clean, noisy), [clean, noisy])
  const snrOut = useMemo(() => snrDb(clean, result.clean), [clean, result])

  // shared y-range across both plots for honest comparison
  const range = useMemo(() => {
    let m = 1e-9
    for (let i = 0; i < DWT_N; i++) m = Math.max(m, Math.abs(noisy[i]))
    return m
  }, [noisy])

  useEffect(() => {
    drawLines(
      noisyRef.current,
      noisySize,
      [
        ...(showClean ? [{ data: clean, color: 'rgba(94,234,212,0.35)', width: 1 } as Series] : []),
        { data: noisy, color: ROSE, width: 0.8, alpha: 0.9 },
      ],
      { lo: -range, hi: range },
    )
  }, [noisy, clean, noisySize, noisyRef, range, showClean])

  useEffect(() => {
    drawLines(
      cleanRef.current,
      cleanSize,
      [
        ...(showClean ? [{ data: clean, color: 'rgba(94,234,212,0.4)', width: 1.4 } as Series] : []),
        { data: result.clean, color: AMBER, width: 1.4 },
      ],
      { lo: -range, hi: range },
    )
  }, [result, clean, cleanSize, cleanRef, range, showClean])

  const onShare = () => {
    shareLink('wavelet', { tab: 'denoise', sig: signalName, w: wavelet, n: sigma, r: rule, m: mode }).then(
      (ok) => {
        if (ok) {
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        }
      },
    )
  }

  const gain = snrOut - snrIn

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Signal">
          <Field label="Test signal">
            <Select value={signalName} options={DWT_SIGNALS} onChange={setSignalName} />
          </Field>
          <Field label="Noise σ" value={sigma.toFixed(2)}>
            <Slider min={0.1} max={1.2} step={0.05} value={sigma} onChange={setSigma} />
          </Field>
          <Toggle label="Show clean reference" checked={showClean} onChange={setShowClean} />
        </Panel>
        <Panel title="Shrinkage">
          <Field label="Wavelet">
            <Select value={wavelet} options={ALL_WAVELETS} onChange={setWavelet} />
          </Field>
          <Field label="Threshold rule">
            <Segmented value={rule} options={RULES} onChange={setRule} />
          </Field>
          <Field label="Thresholding">
            <Segmented value={mode} options={MODES} onChange={setMode} />
          </Field>
          <Readout
            items={[
              { label: 'σ̂ (from d₁)', value: result.sigma.toFixed(3) },
              { label: 'Coeffs kept', value: `${(result.kept * 100).toFixed(1)}%` },
              { label: 'Levels', value: String(lv) },
            ]}
          />
          <div className="btn-row">
            <Button variant="primary" onClick={onShare}>
              {copied ? 'Link copied ✓' : 'Copy link'}
            </Button>
          </div>
        </Panel>
        <Panel title="Result">
          <Readout
            items={[
              { label: 'Input SNR', value: `${snrIn.toFixed(1)} dB` },
              { label: 'Output SNR', value: `${snrOut.toFixed(1)} dB` },
              { label: 'Gain', value: `${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB` },
            ]}
          />
        </Panel>
      </div>
      <div className="mode-main">
        <p className="mode-intro">
          Noise spreads its energy across <em>every</em> wavelet coefficient; a signal with edges or
          spikes concentrates its energy into a <em>few</em> large ones. So{' '}
          <strong>threshold the coefficients</strong> — kill the small ones, keep the big ones — and
          the noise falls away while the features survive. The noise level σ̂ is read straight off the
          finest detail band by its median absolute deviation. Here shrinkage keeps only{' '}
          <strong>{(result.kept * 100).toFixed(1)}%</strong> of the detail coefficients and lifts SNR
          by <strong>{gain >= 0 ? '+' : ''}{gain.toFixed(1)} dB</strong>.
        </p>
        <CanvasCard title="Noisy input" note={`${signalName} · σ = ${sigma.toFixed(2)} · ${snrIn.toFixed(1)} dB`} aspect={3.4}>
          <canvas ref={noisyRef} />
        </CanvasCard>
        <CanvasCard
          title="Wavelet-denoised"
          note={`${RULES.find((r) => r.id === rule)!.label} · ${mode} · ${snrOut.toFixed(1)} dB`}
          aspect={3.4}
        >
          <canvas ref={cleanRef} />
        </CanvasCard>
      </div>
    </div>
  )
}

// ===========================================================================
// Tab 4 — Wavelet packet best basis
// ===========================================================================

const COSTS: { id: CostName; label: string }[] = [
  { id: 'shannon', label: 'Shannon entropy' },
  { id: 'l1', label: 'ℓ¹ sparsity' },
]

function PacketsTab() {
  const sp = useMemo(() => readHashParams(), [])
  const [signalName, setSignalName] = useState<DwtSignalName>(() =>
    readStr<DwtSignalName>(sp, 'sig', 'doppler', DWT_SIGNALS.map((s) => s.id)),
  )
  const [wavelet, setWavelet] = useState(() => readStr(sp, 'w', 'sym6', ALL_WAVELETS.map((w) => w.id)))
  const [depth, setDepth] = useState(() => readNum(sp, 'd', 5))
  const [costName, setCostName] = useState<CostName>(() =>
    readStr<CostName>(sp, 'c', 'shannon', COSTS.map((c) => c.id)),
  )
  const [copied, setCopied] = useState(false)

  const { ref: sigRef, size: sigSize } = useDprCanvas()
  const { ref: tileRef, size: tileSize } = useDprCanvas()

  const bank = useMemo(() => getBank(wavelet), [wavelet])
  const signal = useMemo(() => dwtSignal(signalName, DWT_N), [signalName])
  const maxD = useMemo(() => maxLevel(DWT_N, bank), [bank])
  const J = Math.min(depth, maxD)

  // Analyse the packet tree, pick the best basis, and place each leaf on the
  // true frequency axis by the spectral centroid of its band-limited component.
  const basis = useMemo(() => {
    const nodes = wpAnalyze(signal, bank, J)
    const bb = bestBasis(nodes, costName)
    const items = bb.leaves.map((lf) => {
      const band = nodes[lf.j][lf.k]
      let energy = 0
      let localMax = 0
      for (let i = 0; i < band.length; i++) {
        energy += band[i] * band[i]
        const a = Math.abs(band[i])
        if (a > localMax) localMax = a
      }
      const centroid = spectralCentroid(wpLeafSignal(nodes, lf, bank))
      return { lf, band, energy, centroid, localMax, h: 1 / Math.pow(2, lf.j) }
    })
    const gmax = Math.max(1e-12, ...items.map((it) => it.localMax))
    items.sort((a, b) => a.centroid - b.centroid)
    const totalEnergy = items.reduce((s, it) => s + it.energy, 0) || 1
    return { items, gmax, leaves: bb.leaves.length, bb, totalEnergy }
  }, [signal, bank, J, costName])

  useEffect(() => {
    drawLines(sigRef.current, sigSize, [{ data: signal, color: TEAL, width: 1.1 }], { symmetric: true })
  }, [signal, sigSize, sigRef])

  // ---- the adaptive time–frequency tiling ----
  useEffect(() => {
    const ctx = prepareContext(tileRef.current, tileSize)
    if (!ctx) return
    const { width: w, height: h } = tileSize
    ctx.fillStyle = '#0a0e1a'
    ctx.fillRect(0, 0, w, h)
    const lut = colormapLUT('magma')
    const off = document.createElement('canvas')
    off.width = Math.max(2, Math.round(w))
    off.height = Math.max(2, Math.round(h))
    const octx = off.getContext('2d')
    if (!octx) return
    const floorDb = -42
    let yFrac = 0
    // low frequency at the bottom
    for (const it of basis.items) {
      const stripH = it.h * off.height
      const y0 = off.height - (yFrac + it.h) * off.height
      yFrac += it.h
      const M = it.band.length
      const cellW = off.width / M
      for (let t = 0; t < M; t++) {
        const mag = Math.abs(it.band[t]) / basis.gmax
        const db = 20 * Math.log10(mag + 1e-12)
        let tt = (db - floorDb) / -floorDb
        tt = tt < 0 ? 0 : tt > 1 ? 1 : tt
        const li = (Math.round(tt * 255) & 255) * 4
        octx.fillStyle = `rgb(${lut[li]},${lut[li + 1]},${lut[li + 2]})`
        octx.fillRect(t * cellW, y0, Math.ceil(cellW), Math.ceil(stripH))
      }
    }
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(off, 0, 0, w, h)
    // strip separators + level labels
    ctx.font = '10px JetBrains Mono, ui-monospace, monospace'
    yFrac = 0
    for (const it of basis.items) {
      const yTop = h - (yFrac + it.h) * h
      yFrac += it.h
      ctx.strokeStyle = 'rgba(255,255,255,0.14)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, yTop)
      ctx.lineTo(w, yTop)
      ctx.stroke()
      if (it.h > 0.035) {
        ctx.fillStyle = 'rgba(238,241,255,0.72)'
        ctx.fillText(`L${it.lf.j}`, 4, Math.min(h - 4, yTop + it.h * h - 4))
      }
    }
    ctx.fillStyle = 'rgba(238,241,255,0.6)'
    ctx.textAlign = 'right'
    ctx.fillText('high f', w - 6, 12)
    ctx.fillText('low f', w - 6, h - 6)
    ctx.textAlign = 'left'
  }, [basis, tileSize, tileRef])

  const onShare = () => {
    shareLink('wavelet', { tab: 'packets', sig: signalName, w: wavelet, d: J, c: costName }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  // Compression figure: fraction of coefficients holding 99% of the energy in
  // the best basis (all leaves' coefficients concatenated).
  const compaction = useMemo(() => {
    const all: number[] = []
    for (const it of basis.items) for (let i = 0; i < it.band.length; i++) all.push(it.band[i] * it.band[i])
    all.sort((a, b) => b - a)
    const total = all.reduce((s, v) => s + v, 0) || 1
    let acc = 0
    let n = 0
    for (const v of all) {
      acc += v
      n++
      if (acc >= 0.99 * total) break
    }
    return (n / all.length) * 100
  }, [basis])

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Signal">
          <Field label="Test signal">
            <Select value={signalName} options={DWT_SIGNALS} onChange={setSignalName} />
          </Field>
          <Field label="Wavelet">
            <Select value={wavelet} options={ALL_WAVELETS} onChange={setWavelet} />
          </Field>
        </Panel>
        <Panel title="Packet tree">
          <Field label="Tree depth" value={`${J} / ${maxD}`}>
            <Slider min={2} max={Math.min(7, maxD)} step={1} value={J} onChange={(v) => setDepth(Math.round(v))} />
          </Field>
          <Field label="Cost function">
            <Segmented value={costName} options={COSTS} onChange={setCostName} />
          </Field>
          <Readout
            items={[
              { label: 'Best-basis leaves', value: String(basis.leaves) },
              { label: 'Full-tree leaves', value: String(Math.pow(2, J)) },
              { label: '99% energy in', value: `${compaction.toFixed(1)}%` },
            ]}
          />
          <p className="hint">
            The best basis minimises an additive information cost across every possible pruning of the
            packet tree — fine frequency bands where the signal is tonal, coarse where it is transient.
          </p>
          <div className="btn-row">
            <Button variant="primary" onClick={onShare}>
              {copied ? 'Link copied ✓' : 'Copy link'}
            </Button>
          </div>
        </Panel>
      </div>
      <div className="mode-main">
        <p className="mode-intro">
          The DWT always splits the low-pass band — a fixed octave tiling. A <strong>wavelet packet</strong>{' '}
          transform splits <em>both</em> children everywhere, so every pruning of the resulting binary
          tree is a different orthonormal basis. The <strong>best basis</strong> (Coifman–Wickerhauser)
          is the one that represents <em>this</em> signal most sparsely. The tiling below is that basis:
          each horizontal strip is one leaf — its height is its frequency bandwidth, its columns are its
          time cells — and the partition <strong>adapts</strong> to the signal.
        </p>
        <CanvasCard title="Signal" note={signalName} aspect={4.5}>
          <canvas ref={sigRef} />
        </CanvasCard>
        <CanvasCard
          title="Best-basis time–frequency tiling"
          note={`${basis.leaves} leaves · ${COSTS.find((c) => c.id === costName)!.label} · magma = |coefficient|`}
          aspect={1.5}
        >
          <canvas ref={tileRef} />
        </CanvasCard>
      </div>
    </div>
  )
}

// ===========================================================================
// Tab 5 — 2-D wavelet image compression
// ===========================================================================

const IMG_N = 256 // power of two

// Draw a square n×n scalar field as a grayscale image, scaled into the canvas.
function drawImageGray(
  canvas: HTMLCanvasElement | null,
  size: CanvasSize,
  data: Float64Array,
  n: number,
  opts?: { log?: boolean; lo?: number; hi?: number; smooth?: boolean },
) {
  const ctx = prepareContext(canvas, size)
  if (!ctx) return
  const off = document.createElement('canvas')
  off.width = n
  off.height = n
  const octx = off.getContext('2d')
  if (!octx) return
  const img = octx.createImageData(n, n)
  const vals = opts?.log ? Float64Array.from(data, (v) => Math.log(1 + Math.abs(v))) : data
  let mn = opts?.lo ?? Infinity
  let mx = opts?.hi ?? -Infinity
  if (opts?.lo === undefined || opts?.hi === undefined) {
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] < mn) mn = vals[i]
      if (vals[i] > mx) mx = vals[i]
    }
  }
  const range = mx - mn || 1
  for (let i = 0; i < n * n; i++) {
    let t = (vals[i] - mn) / range
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const g = Math.round(t * 255)
    img.data[i * 4] = g
    img.data[i * 4 + 1] = g
    img.data[i * 4 + 2] = g
    img.data[i * 4 + 3] = 255
  }
  octx.putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = opts?.smooth ?? true
  ctx.drawImage(off, 0, 0, n, n, 0, 0, size.width, size.height)
}

// Draw the wavelet coefficient pyramid, normalising each subband to its own
// magnitude so the fine detail bands are visible next to the bright LL image.
function drawPyramid(
  canvas: HTMLCanvasElement | null,
  size: CanvasSize,
  coeffs: Float64Array,
  n: number,
  levels: number,
) {
  const ctx = prepareContext(canvas, size)
  if (!ctx) return
  const off = document.createElement('canvas')
  off.width = n
  off.height = n
  const octx = off.getContext('2d')
  if (!octx) return
  const img = octx.createImageData(n, n)
  const put = (x: number, y: number, g: number) => {
    const i = (y * n + x) * 4
    img.data[i] = img.data[i + 1] = img.data[i + 2] = g
    img.data[i + 3] = 255
  }
  // coarsest approximation (LL) — a downscaled image, normalised to its range
  const ll = n >> levels
  let mn = Infinity
  let mx = -Infinity
  for (let y = 0; y < ll; y++)
    for (let x = 0; x < ll; x++) {
      const v = coeffs[y * n + x]
      if (v < mn) mn = v
      if (v > mx) mx = v
    }
  const llRange = mx - mn || 1
  for (let y = 0; y < ll; y++)
    for (let x = 0; x < ll; x++) put(x, y, Math.round(((coeffs[y * n + x] - mn) / llRange) * 255))
  // detail subbands at every scale, each normalised to its own peak
  for (let j = 1; j <= levels; j++) {
    const bs = n >> (j - 1)
    const half = n >> j
    const regions = [
      [0, half, half, bs],
      [half, bs, 0, half],
      [half, bs, half, bs],
    ]
    for (const [y0, y1, x0, x1] of regions) {
      let peak = 1e-9
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) peak = Math.max(peak, Math.abs(coeffs[y * n + x]))
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const a = Math.abs(coeffs[y * n + x]) / peak
          put(x, y, Math.round(Math.sqrt(a) * 255))
        }
    }
  }
  octx.putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(off, 0, 0, n, n, 0, 0, size.width, size.height)
  // subband boundary lines
  ctx.strokeStyle = 'rgba(94,234,212,0.3)'
  ctx.lineWidth = 1
  for (let j = 1; j <= levels; j++) {
    const p = (n >> j) / n
    ctx.beginPath()
    ctx.moveTo(p * size.width, 0)
    ctx.lineTo(p * size.width, (p * 2 * size.height))
    ctx.moveTo(0, p * size.height)
    ctx.lineTo(p * 2 * size.width, p * size.height)
    ctx.stroke()
  }
}

function Compress2Tab() {
  const sp = useMemo(() => readHashParams(), [])
  const [image, setImage] = useState<ImageName>(() =>
    readStr<ImageName>(sp, 'img', 'portrait', IMAGES.map((i) => i.id)),
  )
  const [wavelet, setWavelet] = useState(() => readStr(sp, 'w', 'cdf97', ALL_WAVELETS.map((w) => w.id)))
  const [levels, setLevels] = useState(() => readNum(sp, 'lv', 4))
  const [keepPct, setKeepPct] = useState(() => readNum(sp, 'k', 5))
  const [copied, setCopied] = useState(false)

  const { ref: origRef, size: origSize } = useDprCanvas()
  const { ref: coefRef, size: coefSize } = useDprCanvas()
  const { ref: recRef, size: recSize } = useDprCanvas()

  const bank = useMemo(() => getBank(wavelet), [wavelet])
  const img = useMemo(() => proceduralImage(image, IMG_N), [image])
  const result = useMemo(
    () => compress2(img, IMG_N, bank, levels, keepPct / 100),
    [img, bank, levels, keepPct],
  )
  // full transform (all coefficients) for the pyramid display
  const coeffs = useMemo(() => dwt2(img, IMG_N, bank, levels), [img, bank, levels])

  useEffect(() => {
    drawImageGray(origRef.current, origSize, img, IMG_N, { lo: 0, hi: 1 })
  }, [img, origSize, origRef])
  useEffect(() => {
    drawPyramid(coefRef.current, coefSize, coeffs, IMG_N, levels)
  }, [coeffs, coefSize, coefRef, levels])
  useEffect(() => {
    drawImageGray(recRef.current, recSize, result.rec, IMG_N, { lo: 0, hi: 1 })
  }, [result, recSize, recRef])

  const onShare = () => {
    shareLink('wavelet', { tab: 'compress2', img: image, w: wavelet, lv: levels, k: keepPct }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  const ratio = 100 / keepPct

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Image">
          <Field label="Test image">
            <Select value={image} options={IMAGES} onChange={setImage} />
          </Field>
          <Field label="Wavelet">
            <Select value={wavelet} options={ALL_WAVELETS} onChange={setWavelet} />
          </Field>
          <Field label="Pyramid levels" value={String(levels)}>
            <Slider min={1} max={6} step={1} value={levels} onChange={(v) => setLevels(Math.round(v))} />
          </Field>
        </Panel>
        <Panel title="Compression">
          <Field label="Coefficients kept" value={`${keepPct}%`}>
            <Slider min={0.5} max={40} step={0.5} value={keepPct} onChange={setKeepPct} />
          </Field>
          <Readout
            items={[
              { label: 'Compression', value: `${ratio.toFixed(ratio < 10 ? 1 : 0)}×` },
              { label: 'PSNR', value: `${result.psnr.toFixed(1)} dB` },
              { label: 'Kept', value: `${(result.keptCount / 1000).toFixed(1)}k coef` },
            ]}
          />
          <p className="hint">
            A natural image packs its energy into a few big wavelet coefficients — keep those, drop the
            rest, and the picture survives. Symmetric <strong>biorthogonal</strong> wavelets (CDF 9/7)
            ring less at edges than orthogonal ones — try both at a low keep %.
          </p>
          <div className="btn-row">
            <Button variant="primary" onClick={onShare}>
              {copied ? 'Link copied ✓' : 'Copy link'}
            </Button>
          </div>
        </Panel>
      </div>
      <div className="mode-main">
        <p className="mode-intro">
          This is <strong>JPEG-2000 in miniature</strong>. The image is transformed by the separable
          2-D wavelet transform into a <em>pyramid</em> of subbands (middle), then all but the largest{' '}
          <strong>{keepPct}%</strong> of coefficients are thrown away and the image is rebuilt from
          what's left — a <strong>{ratio.toFixed(ratio < 10 ? 1 : 0)}×</strong> compression at{' '}
          <strong>{result.psnr.toFixed(1)} dB</strong> PSNR.
        </p>
        <div className="img-grid">
          <CanvasCard title="Original" aspect={1}>
            <canvas ref={origRef} />
          </CanvasCard>
          <CanvasCard title="Wavelet pyramid" note="subbands · |coefficient|" aspect={1}>
            <canvas ref={coefRef} />
          </CanvasCard>
          <CanvasCard title={`Reconstructed · ${keepPct}% kept`} note={`${result.psnr.toFixed(1)} dB`} aspect={1}>
            <canvas ref={recRef} />
          </CanvasCard>
        </div>
      </div>
    </div>
  )
}

// ===========================================================================

export default function Wavelet() {
  const sp = useMemo(() => readHashParams(), [])
  const [tab, setTab] = useState<Tab>(() => readStr<Tab>(sp, 'tab', 'scalogram', TABS.map((t) => t.id)))
  return (
    <div className="mode-wrap">
      <div className="mode-tabs">
        <Segmented value={tab} options={TABS} onChange={setTab} />
      </div>
      {tab === 'scalogram' && <ScalogramTab />}
      {tab === 'mra' && <MraTab />}
      {tab === 'denoise' && <DenoiseTab />}
      {tab === 'packets' && <PacketsTab />}
      {tab === 'compress2' && <Compress2Tab />}
    </div>
  )
}
