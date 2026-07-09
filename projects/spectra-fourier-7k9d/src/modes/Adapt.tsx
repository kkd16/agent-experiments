import { useEffect, useMemo, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Segmented, Button, Readout } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import { fillPlotBg, grid, axisLabel, type Rect } from '../lib/draw'
import { fromReal, magnitude } from '../lib/complex'
import { fft } from '../lib/fft'
import {
  APPLICATIONS,
  ALGORITHMS,
  adaptRun,
  learningCurve,
  wienerSolution,
  makeProblem,
  combinedResponse,
  misalignmentDb,
  isiDb,
  snrDb as adaptSnr,
  symbolErrorRate,
  lmsStabilityBound,
  type Application,
  type Algorithm,
  type ProblemConfig,
  type AdaptParams,
} from '../lib/adaptive'
import { readHashParams, shareLink, readNum, readStr } from '../lib/urlState'

const TEAL = '#5eead4'
const BLUE = '#38bdf8'
const VIOLET = '#a78bfa'
const ROSE = '#fb7185'
const AMBER = '#fbbf24'

const APP_DEFAULTS: Record<Application, { snr: number; M: number; rho?: number }> = {
  sysid: { snr: 30, M: 12, rho: 0 },
  anc: { snr: 3, M: 12 },
  ale: { snr: 0, M: 24 },
  equalizer: { snr: 20, M: 15 },
}

// ---- canvas painters -------------------------------------------------------

interface Curve {
  data: Float64Array
  color: string
  width: number
  label: string
}

/** Learning curves J[n]=E[e²] in dB, ensemble-averaged, with a dashed MMSE floor. */
function drawLearningCurves(ctx: CanvasRenderingContext2D, r: Rect, curves: Curve[], floorDb: number | null) {
  fillPlotBg(ctx, r)
  grid(ctx, r, 8, 5)
  const toDb = (v: number) => 10 * Math.log10(v + 1e-12)
  let hi = -Infinity
  let lo = Infinity
  for (const c of curves) {
    for (let i = 0; i < c.data.length; i++) {
      const db = toDb(c.data[i])
      if (db > hi) hi = db
      if (db < lo) lo = db
    }
  }
  if (floorDb !== null && isFinite(floorDb)) lo = Math.min(lo, floorDb)
  if (!isFinite(hi)) hi = 0
  if (!isFinite(lo)) lo = -60
  lo = Math.max(lo, hi - 90)
  const pad = (hi - lo) * 0.08 + 1e-6
  hi += pad
  lo -= pad
  const span = Math.max(hi - lo, 1e-6)
  const yOf = (db: number) => r.y + (1 - (db - lo) / span) * r.h
  // MMSE floor.
  if (floorDb !== null && isFinite(floorDb)) {
    ctx.strokeStyle = 'rgba(251,191,36,0.85)'
    ctx.lineWidth = 1.6
    ctx.setLineDash([5, 4])
    const y = yOf(floorDb)
    ctx.beginPath()
    ctx.moveTo(r.x, y)
    ctx.lineTo(r.x + r.w, y)
    ctx.stroke()
    ctx.setLineDash([])
  }
  for (const c of curves) {
    const n = c.data.length
    if (n < 2) continue
    ctx.strokeStyle = c.color
    ctx.lineWidth = c.width
    ctx.lineJoin = 'round'
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const x = r.x + (i / (n - 1)) * r.w
      const y = yOf(toDb(c.data[i]))
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  // Legend.
  let ly = r.y + 15
  for (const c of curves) {
    ctx.fillStyle = c.color
    ctx.beginPath()
    ctx.arc(r.x + 14, ly - 4, 3.5, 0, 2 * Math.PI)
    ctx.fill()
    axisLabel(ctx, c.label, r.x + 24, ly)
    ly += 16
  }
  if (floorDb !== null && isFinite(floorDb)) {
    ctx.fillStyle = AMBER
    ctx.beginPath()
    ctx.arc(r.x + 14, ly - 4, 3.5, 0, 2 * Math.PI)
    ctx.fill()
    axisLabel(ctx, 'MMSE floor', r.x + 24, ly)
  }
  axisLabel(ctx, 'iteration →', r.x + r.w - 6, r.y + r.h - 8, 'right')
  axisLabel(ctx, 'MSE ↓ (dB)', r.x + r.w - 6, r.y + 16, 'right')
}

/** Two overlaid tap sets as stems: truth (teal, thick) vs estimate (violet, thin). */
function drawTapStems(ctx: CanvasRenderingContext2D, r: Rect, truth: ArrayLike<number>, est: ArrayLike<number>, labelTruth: string, labelEst: string) {
  fillPlotBg(ctx, r)
  grid(ctx, r, 8, 4)
  const n = Math.max(truth.length, est.length)
  let range = 1e-6
  for (let i = 0; i < n; i++) {
    range = Math.max(range, Math.abs(i < truth.length ? truth[i] : 0), Math.abs(i < est.length ? est[i] : 0))
  }
  const midY = r.y + r.h / 2
  ctx.strokeStyle = 'rgba(120,140,220,0.5)'
  ctx.lineWidth = 1.2
  ctx.beginPath()
  ctx.moveTo(r.x, midY)
  ctx.lineTo(r.x + r.w, midY)
  ctx.stroke()
  const px = (i: number) => r.x + (n === 1 ? 0.5 : i / (n - 1)) * r.w
  const py = (v: number) => midY - (v / range) * (r.h / 2) * 0.9
  for (let i = 0; i < truth.length; i++) {
    const x = px(i)
    ctx.strokeStyle = 'rgba(94,234,212,0.85)'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(x, midY)
    ctx.lineTo(x, py(truth[i]))
    ctx.stroke()
    ctx.fillStyle = TEAL
    ctx.beginPath()
    ctx.arc(x, py(truth[i]), 3, 0, 2 * Math.PI)
    ctx.fill()
  }
  for (let i = 0; i < est.length; i++) {
    const x = px(i)
    ctx.strokeStyle = 'rgba(167,139,250,0.95)'
    ctx.lineWidth = 1.3
    ctx.beginPath()
    ctx.moveTo(x, midY)
    ctx.lineTo(x, py(est[i]))
    ctx.stroke()
    ctx.strokeStyle = VIOLET
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(x, py(est[i]), 2.6, 0, 2 * Math.PI)
    ctx.stroke()
  }
  ctx.fillStyle = TEAL
  ctx.beginPath()
  ctx.arc(r.x + 14, r.y + 11, 3.5, 0, 2 * Math.PI)
  ctx.fill()
  axisLabel(ctx, labelTruth, r.x + 24, r.y + 15)
  ctx.fillStyle = VIOLET
  ctx.beginPath()
  ctx.arc(r.x + 14, r.y + 27, 3.5, 0, 2 * Math.PI)
  ctx.fill()
  axisLabel(ctx, labelEst, r.x + 24, r.y + 31)
}

/** Overlaid time waveforms mapped to a shared symmetric range. */
function drawWaveforms(ctx: CanvasRenderingContext2D, r: Rect, series: { data: ArrayLike<number>; color: string; width: number; label: string }[], start: number, count: number) {
  fillPlotBg(ctx, r)
  grid(ctx, r, 8, 4)
  const midY = r.y + r.h / 2
  ctx.strokeStyle = 'rgba(120,140,220,0.4)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(r.x, midY)
  ctx.lineTo(r.x + r.w, midY)
  ctx.stroke()
  let range = 1e-6
  for (const s of series) for (let i = 0; i < count; i++) range = Math.max(range, Math.abs(s.data[start + i] ?? 0))
  for (const s of series) {
    ctx.strokeStyle = s.color
    ctx.lineWidth = s.width
    ctx.lineJoin = 'round'
    ctx.beginPath()
    for (let i = 0; i < count; i++) {
      const x = r.x + (i / (count - 1)) * r.w
      const v = s.data[start + i] ?? 0
      const y = midY - (v / range) * (r.h / 2) * 0.92
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  let ly = r.y + 15
  for (const s of series) {
    ctx.fillStyle = s.color
    ctx.beginPath()
    ctx.arc(r.x + 14, ly - 4, 3.5, 0, 2 * Math.PI)
    ctx.fill()
    axisLabel(ctx, s.label, r.x + 24, ly)
    ly += 16
  }
}

/** Magnitude spectra (dB) of two signals over the same axis. */
function drawSpectra(ctx: CanvasRenderingContext2D, r: Rect, specs: { data: Float64Array; color: string; width: number; label: string }[]) {
  fillPlotBg(ctx, r)
  grid(ctx, r, 8, 4)
  const toDb = (v: number) => 20 * Math.log10(v + 1e-9)
  let hi = -Infinity
  for (const s of specs) for (let i = 0; i < s.data.length; i++) hi = Math.max(hi, toDb(s.data[i]))
  if (!isFinite(hi)) hi = 0
  const lo = hi - 70
  const span = hi - lo
  for (const s of specs) {
    const n = s.data.length
    ctx.strokeStyle = s.color
    ctx.lineWidth = s.width
    ctx.lineJoin = 'round'
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const x = r.x + (i / (n - 1)) * r.w
      const t = (toDb(s.data[i]) - lo) / span
      const y = r.y + (1 - Math.max(0, Math.min(1, t))) * r.h * 0.94 + r.h * 0.03
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  let ly = r.y + 15
  for (const s of specs) {
    ctx.fillStyle = s.color
    ctx.beginPath()
    ctx.arc(r.x + 14, ly - 4, 3.5, 0, 2 * Math.PI)
    ctx.fill()
    axisLabel(ctx, s.label, r.x + 24, ly)
    ly += 16
  }
  axisLabel(ctx, 'frequency →', r.x + r.w - 6, r.y + r.h - 8, 'right')
}

/** Histograms of soft-decision values, on a shared [-2,2] axis — the eye opening. */
function drawDecisionHist(ctx: CanvasRenderingContext2D, r: Rect, raw: number[], eq: number[]) {
  fillPlotBg(ctx, r)
  grid(ctx, r, 8, 4)
  const bins = 60
  const lo = -2.2
  const hi = 2.2
  const hist = (vals: number[]) => {
    const h = new Float64Array(bins)
    for (const v of vals) {
      const t = (v - lo) / (hi - lo)
      const b = Math.max(0, Math.min(bins - 1, Math.floor(t * bins)))
      h[b] += 1
    }
    let m = 1e-6
    for (let i = 0; i < bins; i++) m = Math.max(m, h[i])
    for (let i = 0; i < bins; i++) h[i] /= m
    return h
  }
  const hRaw = hist(raw)
  const hEq = hist(eq)
  const baseY = r.y + r.h - 4
  const drawHist = (h: Float64Array, fill: string, stroke: string) => {
    ctx.beginPath()
    ctx.moveTo(r.x, baseY)
    for (let i = 0; i < bins; i++) {
      const x = r.x + (i / (bins - 1)) * r.w
      const y = baseY - h[i] * (r.h - 10)
      ctx.lineTo(x, y)
    }
    ctx.lineTo(r.x + r.w, baseY)
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()
    ctx.strokeStyle = stroke
    ctx.lineWidth = 1.6
    ctx.beginPath()
    for (let i = 0; i < bins; i++) {
      const x = r.x + (i / (bins - 1)) * r.w
      const y = baseY - h[i] * (r.h - 10)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  drawHist(hRaw, 'rgba(251,113,133,0.16)', 'rgba(251,113,133,0.7)')
  drawHist(hEq, 'rgba(94,234,212,0.20)', TEAL)
  // Decision threshold at 0 and the ±1 ideal marks.
  const xAt = (v: number) => r.x + ((v - lo) / (hi - lo)) * r.w
  ctx.strokeStyle = 'rgba(230,236,255,0.5)'
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.moveTo(xAt(0), r.y)
  ctx.lineTo(xAt(0), baseY)
  ctx.stroke()
  ctx.setLineDash([3, 3])
  ctx.strokeStyle = 'rgba(230,236,255,0.3)'
  for (const v of [-1, 1]) {
    ctx.beginPath()
    ctx.moveTo(xAt(v), r.y)
    ctx.lineTo(xAt(v), baseY)
    ctx.stroke()
  }
  ctx.setLineDash([])
  ctx.fillStyle = ROSE
  ctx.beginPath()
  ctx.arc(r.x + 14, r.y + 11, 3.5, 0, 2 * Math.PI)
  ctx.fill()
  axisLabel(ctx, 'channel out (ISI)', r.x + 24, r.y + 15)
  ctx.fillStyle = TEAL
  ctx.beginPath()
  ctx.arc(r.x + 14, r.y + 27, 3.5, 0, 2 * Math.PI)
  ctx.fill()
  axisLabel(ctx, 'equalized', r.x + 24, r.y + 31)
}

/** Eigenvalue spectrum of R as bars, ascending, with the LMS μ ceiling annotated. */
function drawEigs(ctx: CanvasRenderingContext2D, r: Rect, eigs: number[], mu: number) {
  fillPlotBg(ctx, r)
  grid(ctx, r, 8, 4)
  const n = eigs.length
  let hi = 1e-9
  for (const e of eigs) hi = Math.max(hi, e)
  const baseY = r.y + r.h - 4
  const bw = (r.w / n) * 0.6
  for (let i = 0; i < n; i++) {
    const x = r.x + ((i + 0.5) / n) * r.w
    const h = (eigs[i] / hi) * (r.h - 12)
    ctx.fillStyle = 'rgba(56,189,248,0.7)'
    ctx.fillRect(x - bw / 2, baseY - h, bw, h)
  }
  const bound = lmsStabilityBound(eigs)
  axisLabel(ctx, `λmax = ${hi.toFixed(3)}`, r.x + 8, r.y + 15)
  axisLabel(ctx, `μ < 2/λmax = ${isFinite(bound) ? bound.toFixed(3) : '∞'}`, r.x + 8, r.y + 31)
  axisLabel(ctx, `your μ = ${mu.toFixed(3)}`, r.x + 8, r.y + 47)
  axisLabel(ctx, 'eigenvalues of R (ascending) →', r.x + r.w - 6, r.y + r.h - 8, 'right')
}

// ---------------------------------------------------------------------------

function magSpectrum(sig: ArrayLike<number>, start: number, size: number): Float64Array {
  const buf = new Float64Array(size)
  for (let i = 0; i < size; i++) {
    const idx = start + i
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)) // Hann
    buf[i] = (idx < sig.length ? sig[idx] : 0) * w
  }
  const mag = magnitude(fft(fromReal(buf)))
  return mag.slice(0, size / 2)
}

export default function Adapt() {
  const sp = useMemo(() => readHashParams(), [])
  const [app, setApp] = useState<Application>(() => readStr<Application>(sp, 'app', 'sysid', APPLICATIONS.map((a) => a.id)))
  const [algo, setAlgo] = useState<Algorithm>(() => readStr<Algorithm>(sp, 'a', 'lms', ALGORITHMS.map((a) => a.id)))
  const [M, setM] = useState(() => Math.round(readNum(sp, 'M', 12)))
  const [rho, setRho] = useState(() => readNum(sp, 'rho', 0))
  const [snr, setSnr] = useState(() => readNum(sp, 'snr', 30))
  const [muLms, setMuLms] = useState(() => readNum(sp, 'mu', 0.02))
  const [muNlms, setMuNlms] = useState(() => readNum(sp, 'mun', 0.5))
  const [lambda, setLambda] = useState(() => readNum(sp, 'lam', 0.995))
  const [trials, setTrials] = useState(() => Math.round(readNum(sp, 'tr', 24)))
  const [seedBump, setSeedBump] = useState(0)
  const [copied, setCopied] = useState(false)

  // Each task shows off in a different regime — noise cancellation and the line
  // enhancer want the noise to dominate; system ID and the equalizer want it modest.
  const changeApp = (a: Application) => {
    setApp(a)
    const d = APP_DEFAULTS[a]
    setSnr(d.snr)
    setM(d.M)
    if (d.rho !== undefined) setRho(d.rho)
  }

  const N = 2000
  const seed = 4200 + seedBump
  // Sensible decorrelation / alignment delay per application.
  const delay = app === 'ale' ? 1 : app === 'equalizer' ? Math.floor((M - 1) / 2) + 1 : 0

  const cfg = useMemo<ProblemConfig>(
    () => ({ app, N, M, rho, snrDb: snr, delay, seed }),
    [app, N, M, rho, snr, delay, seed],
  )

  const params = useMemo<AdaptParams>(
    () => ({ M, mu: algo === 'nlms' ? muNlms : muLms, lambda, delta: 0.01, eps: 1e-6 }),
    [M, algo, muNlms, muLms, lambda],
  )

  // One realisation drives the taps / waveforms / spectra / metrics panels.
  const single = useMemo(() => {
    const prob = makeProblem(cfg, seed)
    const run = adaptRun(prob.x, prob.d, algo, params)
    const wien = wienerSolution(prob.x, prob.d, M)
    return { prob, run, wien }
  }, [cfg, algo, params, M, seed])

  // Ensemble learning curves for all three rules on the identical problem family.
  const curves = useMemo(() => {
    const mk = (s: number) => {
      const p = makeProblem(cfg, s)
      return { x: p.x, d: p.d }
    }
    const jLms = learningCurve(mk, 'lms', { ...params, mu: muLms }, trials, seed)
    const jNlms = learningCurve(mk, 'nlms', { ...params, mu: muNlms }, trials, seed)
    const jRls = learningCurve(mk, 'rls', params, trials, seed)
    return { jLms, jNlms, jRls }
  }, [cfg, params, muLms, muNlms, trials, seed])

  // Metrics.
  const metrics = useMemo(() => {
    const { prob, run, wien } = single
    const startSteady = Math.floor(N * 0.6)
    const out: { label: string; value: string }[] = []
    let headline = ''
    if (app === 'sysid' && prob.hTrue) {
      const mis = misalignmentDb(run.w, prob.hTrue)
      out.push({ label: 'Misalign.', value: `${mis.toFixed(1)} dB` })
      out.push({ label: 'Eig spread', value: isFinite(wien.spread) ? `${wien.spread.toFixed(1)}×` : '∞' })
      out.push({ label: 'MMSE', value: `${(10 * Math.log10(wien.jmin + 1e-12)).toFixed(0)} dB` })
      out.push({ label: 'Taps M', value: String(M) })
      headline = `plant identified to ${mis.toFixed(0)} dB`
    } else if (app === 'anc' && prob.clean) {
      const inSnr = adaptSnr(prob.d, prob.clean)
      const outSnr = adaptSnr(run.e, prob.clean, startSteady)
      out.push({ label: 'SNR in', value: `${inSnr.toFixed(1)} dB` })
      out.push({ label: 'SNR out', value: `${outSnr.toFixed(1)} dB` })
      out.push({ label: 'Gain', value: `+${(outSnr - inSnr).toFixed(1)} dB` })
      out.push({ label: 'Taps M', value: String(M) })
      headline = `noise cut by ${(outSnr - inSnr).toFixed(0)} dB`
    } else if (app === 'ale' && prob.clean) {
      const inSnr = adaptSnr(prob.d, prob.clean)
      const outSnr = adaptSnr(run.y, prob.clean, startSteady)
      out.push({ label: 'SNR in', value: `${inSnr.toFixed(1)} dB` })
      out.push({ label: 'SNR out', value: `${outSnr.toFixed(1)} dB` })
      out.push({ label: 'Gain', value: `+${(outSnr - inSnr).toFixed(1)} dB` })
      out.push({ label: 'Delay Δ', value: String(delay) })
      headline = `lines lifted by ${(outSnr - inSnr).toFixed(0)} dB`
    } else if (app === 'equalizer' && prob.channel && prob.symbols) {
      const comb = combinedResponse(prob.channel, run.w)
      const isiCh = isiDb(prob.channel)
      const isiEq = isiDb(comb)
      const ser = symbolErrorRate(run.y, prob.symbols, delay, startSteady)
      out.push({ label: 'ISI before', value: `${isiCh.toFixed(1)} dB` })
      out.push({ label: 'ISI after', value: `${isiEq.toFixed(1)} dB` })
      out.push({ label: 'Sym err', value: ser === 0 ? '0' : ser.toExponential(1) })
      out.push({ label: 'Delay Δ', value: String(delay) })
      headline = `ISI ${isiCh.toFixed(0)} → ${isiEq.toFixed(0)} dB`
    }
    return { out, headline }
  }, [single, app, M, delay])

  // ---- canvases ----
  const { ref: curveRef, size: curveSize } = useDprCanvas()
  const { ref: aRef, size: aSize } = useDprCanvas()
  const { ref: bRef, size: bSize } = useDprCanvas()

  useEffect(() => {
    const ctx = prepareContext(curveRef.current, curveSize)
    if (!ctx) return
    const rect = { x: 0, y: 0, w: curveSize.width, h: curveSize.height }
    const list: Curve[] = [
      { data: curves.jLms, color: TEAL, width: 2, label: 'LMS' },
      { data: curves.jNlms, color: BLUE, width: 2, label: 'NLMS' },
      { data: curves.jRls, color: VIOLET, width: 2.2, label: 'RLS' },
    ]
    const floorDb = isFinite(single.wien.jmin) ? 10 * Math.log10(single.wien.jmin + 1e-12) : null
    drawLearningCurves(ctx, rect, list, floorDb)
  }, [curves, single, curveSize, curveRef])

  useEffect(() => {
    const ctx = prepareContext(aRef.current, aSize)
    if (!ctx) return
    const rect = { x: 0, y: 0, w: aSize.width, h: aSize.height }
    const { prob, run } = single
    if (app === 'sysid' && prob.hTrue) {
      drawTapStems(ctx, rect, prob.hTrue, run.w, 'true plant h', 'estimated ŵ')
    } else if (app === 'anc' && prob.clean) {
      const start = Math.floor(N * 0.7)
      drawWaveforms(ctx, rect, [
        { data: prob.d, color: 'rgba(251,113,133,0.7)', width: 1.4, label: 'primary (signal+noise)' },
        { data: run.e, color: TEAL, width: 1.8, label: 'recovered e[n]' },
        { data: prob.clean, color: 'rgba(230,236,255,0.35)', width: 2.6, label: 'clean target' },
      ], start, 240)
    } else if (app === 'ale' && prob.clean) {
      const size = 512
      const start = Math.max(0, N - size)
      const inSpec = magSpectrum(prob.d, start, size)
      const outSpec = magSpectrum(run.y, start, size)
      drawSpectra(ctx, rect, [
        { data: inSpec, color: 'rgba(251,113,133,0.65)', width: 1.5, label: 'noisy input' },
        { data: outSpec, color: TEAL, width: 1.8, label: 'enhanced output' },
      ])
    } else if (app === 'equalizer' && prob.channel) {
      const comb = combinedResponse(prob.channel, run.w)
      drawTapStems(ctx, rect, prob.channel, comb, 'channel c', 'channel⊛equalizer')
    }
  }, [single, app, aSize, aRef, delay])

  useEffect(() => {
    const ctx = prepareContext(bRef.current, bSize)
    if (!ctx) return
    const rect = { x: 0, y: 0, w: bSize.width, h: bSize.height }
    const { prob, run, wien } = single
    if (app === 'sysid') {
      drawEigs(ctx, rect, wien.eigs, algo === 'nlms' ? muNlms : muLms)
    } else if (app === 'anc' && prob.clean) {
      const start = Math.floor(N * 0.7)
      drawWaveforms(ctx, rect, [
        { data: prob.clean, color: 'rgba(230,236,255,0.35)', width: 2.6, label: 'clean target' },
        { data: run.e, color: TEAL, width: 1.8, label: 'recovered e[n]' },
      ], start, 240)
    } else if (app === 'ale' && prob.clean) {
      const start = Math.floor(N * 0.7)
      drawWaveforms(ctx, rect, [
        { data: prob.d, color: 'rgba(251,113,133,0.6)', width: 1.2, label: 'noisy input' },
        { data: run.y, color: TEAL, width: 1.8, label: 'enhanced y[n]' },
        { data: prob.clean, color: 'rgba(230,236,255,0.35)', width: 2.4, label: 'true line' },
      ], start, 240)
    } else if (app === 'equalizer' && prob.symbols) {
      const start = Math.floor(N * 0.6)
      const raw: number[] = []
      const eq: number[] = []
      for (let n = start; n < N; n++) {
        raw.push(prob.x[n])
        eq.push(run.y[n])
      }
      drawDecisionHist(ctx, rect, raw, eq)
    }
  }, [single, app, bSize, bRef, algo, muNlms, muLms])

  const onShare = () => {
    shareLink('adapt', {
      app,
      a: algo,
      M,
      rho: rho.toFixed(2),
      snr,
      mu: muLms.toFixed(3),
      mun: muNlms.toFixed(2),
      lam: lambda.toFixed(3),
      tr: trials,
    }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  const cardTitles: Record<Application, [string, string]> = {
    sysid: ['Filter taps — truth vs estimate', 'Correlation eigenvalues of R'],
    anc: ['Noise cancellation (time)', 'Recovered vs clean (zoom)'],
    ale: ['Spectra — input vs enhanced', 'Waveform — line emerging'],
    equalizer: ['Combined response c⊛w → δ', 'Decision histogram (eye)'],
  }
  const [titleA, titleB] = cardTitles[app]

  const intros: Record<Application, string> = {
    sysid: 'Drive an unknown FIR “plant” with noise and let the filter copy it. The estimate ŵ (violet) snaps onto the true taps h (teal). Raise the input coloring ρ and watch the correlation matrix’s eigenvalues spread apart — LMS crawls, while RLS, which whitens internally, is untouched.',
    anc: 'Widrow’s classic: a wanted signal is drowned by noise that leaked through an unknown path, but you also have a reference microphone on the noise alone. The filter learns the path, predicts the noise in the primary, and subtracts it — the error signal e[n] is the recovered signal.',
    ale: 'An Adaptive Line Enhancer separates the predictable from the unpredictable. Feed the filter a delayed copy of a noisy signal: only the periodic lines are correlated across the delay, so the filter predicts (and thus enhances) the tones while the broadband noise averages away.',
    equalizer: 'A dispersive channel smears each symbol into its neighbours (intersymbol interference); the eye slams shut. Train an adaptive equalizer against known symbols and the combined channel⊛equalizer response collapses to a single spike — the eye reopens and the bits come back.',
  }

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Application">
          <Field label="Task">
            <Select value={app} options={APPLICATIONS} onChange={changeApp} />
          </Field>
          <Field label="Filter length M" value={String(M)}>
            <Slider min={4} max={32} step={1} value={M} onChange={(v) => setM(Math.round(v))} />
          </Field>
          {app === 'sysid' && (
            <Field label="Input coloring ρ" value={rho.toFixed(2)}>
              <Slider min={0} max={0.95} step={0.05} value={rho} onChange={setRho} />
            </Field>
          )}
          <Field label={app === 'equalizer' ? 'Channel SNR' : app === 'sysid' ? 'Measurement SNR' : 'Signal-to-noise'} value={`${snr} dB`}>
            <Slider min={app === 'ale' ? -5 : 0} max={40} step={1} value={snr} onChange={(v) => setSnr(Math.round(v))} />
          </Field>
          <div className="btn-row">
            <Button variant="ghost" onClick={() => setSeedBump((s) => s + 1)}>New realisation</Button>
          </div>
        </Panel>

        <Panel title="Adaptive rule">
          <Segmented value={algo} options={ALGORITHMS} onChange={setAlgo} />
          <Field label="LMS step μ" value={muLms.toFixed(3)}>
            <Slider min={0.001} max={0.2} step={0.001} value={muLms} onChange={setMuLms} />
          </Field>
          <Field label="NLMS step μ̃" value={muNlms.toFixed(2)}>
            <Slider min={0.02} max={1.9} step={0.02} value={muNlms} onChange={setMuNlms} />
          </Field>
          <Field label="RLS forgetting λ" value={lambda.toFixed(3)}>
            <Slider min={0.9} max={1} step={0.001} value={lambda} onChange={setLambda} />
          </Field>
          <Field label="Ensemble trials" value={String(trials)}>
            <Slider min={1} max={60} step={1} value={trials} onChange={(v) => setTrials(Math.round(v))} />
          </Field>
        </Panel>

        <Panel title="Result">
          <Readout items={metrics.out} />
          <div className="btn-row">
            <Button variant="ghost" onClick={onShare}>{copied ? 'Link copied ✓' : 'Copy link'}</Button>
          </div>
        </Panel>
      </div>

      <div className="mode-main">
        <p className="mode-intro">{intros[app]}</p>
        <CanvasCard
          title="Learning curves — LMS vs NLMS vs RLS"
          note={`ensemble MSE over ${trials} trials · ${metrics.headline}`}
          height={300}
        >
          <canvas ref={curveRef} />
        </CanvasCard>
        <div className="tomo-grid">
          <CanvasCard title={titleA} aspect={1.7}>
            <canvas ref={aRef} />
          </CanvasCard>
          <CanvasCard title={titleB} aspect={1.7}>
            <canvas ref={bRef} />
          </CanvasCard>
        </div>
      </div>
    </div>
  )
}
