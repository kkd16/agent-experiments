import { useEffect, useMemo, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Segmented, Toggle, Button, Readout } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import { fillPlotBg, grid, zeroLine, linePlot, axisLabel, type Rect } from '../lib/draw'
import {
  runAdaptive,
  makeScenario,
  learningCurves,
  misalignmentDb,
  snrDbTail,
  runKalman,
  convolve,
  SCENARIOS,
  ALGOS,
  type AlgoKind,
  type AlgoConfig,
  type ScenarioKind,
  type ScenarioConfig,
  type KalmanConfig,
} from '../lib/adaptive'
import { readHashParams, shareLink, readNum, readStr, readBool } from '../lib/urlState'

const TEAL = '#5eead4'
const BLUE = '#38bdf8'
const VIOLET = '#a78bfa'
const ROSE = '#fb7185'
const AMBER = '#fbbf24'
const ALGO_COLOR: Record<AlgoKind, string> = { lms: ROSE, nlms: BLUE, apa: AMBER, rls: TEAL }

type Mode = ScenarioKind | 'kalman'

// Per-scenario knobs that keep every algorithm stable and comparable. LMS uses a
// raw step, so its slider is scaled by a scenario-dependent ceiling (a fraction of
// the 2/(L·P) stability bound); NLMS/APA are power-normalised so µ∈(0,1] is safe.
const SCENARIO_DEFAULTS: Record<
  ScenarioKind,
  { N: number; L: number; lmsMax: number; mu: number; extra: Record<string, number> }
> = {
  sysid: { N: 2200, L: 16, lmsMax: 0.1, mu: 0.5, extra: { plantLen: 8, color: 0, snrDb: 40 } },
  anc: { N: 3200, L: 16, lmsMax: 0.04, mu: 0.4, extra: { freq: 0.02, snrDb: 40 } },
  equalize: { N: 4000, L: 21, lmsMax: 0.03, mu: 0.4, extra: { channel: 0, snrDb: 25, delay: 8 } },
  predict: { N: 3000, L: 8, lmsMax: 0.03, mu: 0.4, extra: { arA1: 1.5, arA2: -0.95 } },
}

function algoConfig(
  algo: AlgoKind,
  mode: ScenarioKind,
  L: number,
  mu01: number,
  apaOrder: number,
  lambda: number,
): AlgoConfig {
  const lmsMax = SCENARIO_DEFAULTS[mode].lmsMax
  const mu = algo === 'lms' ? mu01 * lmsMax : mu01
  return { algo, L, mu, lambda, delta: 0.01, apaOrder, eps: 1e-4 }
}

// ---- canvas painters -------------------------------------------------------

/** Two time-series over a trailing window, auto-ranged, on a shared axis. */
function drawDual(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  a: Float64Array,
  b: Float64Array,
  win: number,
  colA: string,
  colB: string,
  widthA = 2.4,
  widthB = 1.6,
) {
  fillPlotBg(ctx, r)
  grid(ctx, r, 8, 4)
  zeroLine(ctx, r)
  const n = a.length
  const start = Math.max(0, n - win)
  const va = a.subarray(start)
  const vb = b.subarray(start)
  let range = 1e-6
  for (let i = 0; i < va.length; i++) range = Math.max(range, Math.abs(va[i]))
  for (let i = 0; i < vb.length; i++) range = Math.max(range, Math.abs(vb[i]))
  linePlot(ctx, r, va, range, colA, widthA)
  linePlot(ctx, r, vb, range, colB, widthB)
}

/** Learning-curve panel: MSE (dB) vs iteration for each algorithm, selected one bold. */
function drawCurves(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  curves: Float64Array[],
  selected: number,
  onlySelected = false,
) {
  fillPlotBg(ctx, r)
  grid(ctx, r, 8, 5)
  const shown = (i: number) => !onlySelected || i === selected
  let lo = Infinity
  let hi = -Infinity
  curves.forEach((c, i) => {
    if (!shown(i)) return
    for (let k = 0; k < c.length; k++) {
      const v = c[k]
      if (!isFinite(v)) continue
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  })
  if (!isFinite(lo) || !isFinite(hi)) return
  lo = Math.max(lo, hi - 80) // clamp the floor so a −300 dB spike doesn't flatten it
  const span = Math.max(hi - lo, 1e-6)
  const yOf = (v: number) => r.y + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / span) * r.h * 0.9 + r.h * 0.05
  // dB gridline labels.
  ctx.fillStyle = 'rgba(154,166,212,0.7)'
  ctx.font = '10px JetBrains Mono, ui-monospace, monospace'
  ctx.textAlign = 'left'
  for (let g = 0; g <= 4; g++) {
    const v = hi - (g / 4) * span
    ctx.fillText(`${v.toFixed(0)} dB`, r.x + 4, yOf(v) - 2)
  }
  curves.forEach((c, i) => {
    if (!shown(i)) return
    const algo = ALGOS[i].id
    ctx.strokeStyle = ALGO_COLOR[algo]
    ctx.globalAlpha = i === selected ? 1 : 0.5
    ctx.lineWidth = i === selected ? 2.6 : 1.4
    ctx.lineJoin = 'round'
    ctx.beginPath()
    for (let n = 0; n < c.length; n++) {
      const x = r.x + (n / (c.length - 1)) * r.w
      if (n === 0) ctx.moveTo(x, yOf(c[n]))
      else ctx.lineTo(x, yOf(c[n]))
    }
    ctx.stroke()
  })
  ctx.globalAlpha = 1
  // Legend.
  ALGOS.forEach((a, i) => {
    if (!shown(i)) return
    const y = r.y + 14 + i * 15
    ctx.fillStyle = ALGO_COLOR[a.id]
    ctx.beginPath()
    ctx.arc(r.x + r.w - 60, y - 3, 3.5, 0, 2 * Math.PI)
    ctx.fill()
    ctx.fillStyle = i === selected ? '#e6ecff' : 'rgba(154,166,212,0.8)'
    ctx.textAlign = 'left'
    ctx.fillText(a.label, r.x + r.w - 50, y)
  })
  axisLabel(ctx, 'iteration →', r.x + r.w - 6, r.y + r.h - 8, 'right')
  axisLabel(ctx, 'MSE ↓', r.x + 6, r.y + r.h - 8)
}

/** Tap-weight stem comparison: ground truth (teal) vs learned (violet). */
function drawTaps(ctx: CanvasRenderingContext2D, r: Rect, truth: Float64Array | undefined, learned: Float64Array) {
  fillPlotBg(ctx, r)
  grid(ctx, r, 8, 4)
  const n = learned.length
  let range = 1e-6
  for (let i = 0; i < n; i++) range = Math.max(range, Math.abs(learned[i]))
  if (truth) for (let i = 0; i < truth.length; i++) range = Math.max(range, Math.abs(truth[i]))
  const midY = r.y + r.h / 2
  ctx.strokeStyle = 'rgba(120,140,220,0.5)'
  ctx.lineWidth = 1.2
  ctx.beginPath()
  ctx.moveTo(r.x, midY)
  ctx.lineTo(r.x + r.w, midY)
  ctx.stroke()
  const px = (i: number) => r.x + (n === 1 ? 0.5 : i / (n - 1)) * r.w
  const py = (v: number) => midY - (v / range) * (r.h / 2) * 0.9
  if (truth) {
    for (let i = 0; i < truth.length; i++) {
      const x = px(i)
      ctx.strokeStyle = 'rgba(94,234,212,0.8)'
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
  }
  for (let i = 0; i < n; i++) {
    const x = px(i)
    ctx.strokeStyle = 'rgba(167,139,250,0.9)'
    ctx.lineWidth = 1.3
    ctx.beginPath()
    ctx.moveTo(x, midY)
    ctx.lineTo(x, py(learned[i]))
    ctx.stroke()
    ctx.strokeStyle = VIOLET
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.arc(x, py(learned[i]), 2.6, 0, 2 * Math.PI)
    ctx.stroke()
  }
}

/** A 1-D BPSK strip plot: received values (smeared by ISI) vs equalized values,
 *  coloured by the true symbol; two tight clusters at ±1 = an open eye. */
function drawStrip(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  received: number[],
  equalized: number[],
  syms: number[],
) {
  fillPlotBg(ctx, r)
  grid(ctx, r, 8, 4)
  const topH = r.h * 0.5
  const midTop = r.y + topH * 0.5
  const midBot = r.y + topH + (r.h - topH) * 0.5
  let range = 1.2
  for (const v of received) range = Math.max(range, Math.abs(v))
  const xOf = (v: number) => r.x + r.w * 0.5 + (v / range) * r.w * 0.46
  const jitter = (i: number) => ((i * 2654435761) % 1000) / 1000 - 0.5
  // Target lines at ±1.
  ctx.strokeStyle = 'rgba(120,140,220,0.35)'
  ctx.lineWidth = 1
  for (const tv of [-1, 1]) {
    const x = xOf(tv)
    ctx.beginPath()
    ctx.moveTo(x, r.y)
    ctx.lineTo(x, r.y + r.h)
    ctx.stroke()
  }
  const plotRow = (vals: number[], midY: number, h: number) => {
    for (let i = 0; i < vals.length; i++) {
      const x = xOf(vals[i])
      const y = midY + jitter(i + 1) * h * 0.7
      ctx.fillStyle = syms[i] > 0 ? 'rgba(94,234,212,0.7)' : 'rgba(251,113,133,0.7)'
      ctx.beginPath()
      ctx.arc(x, y, 1.7, 0, 2 * Math.PI)
      ctx.fill()
    }
  }
  plotRow(received, midTop, topH)
  plotRow(equalized, midBot, r.h - topH)
  ctx.strokeStyle = 'rgba(120,140,220,0.4)'
  ctx.beginPath()
  ctx.moveTo(r.x, r.y + topH)
  ctx.lineTo(r.x + r.w, r.y + topH)
  ctx.stroke()
  axisLabel(ctx, 'received (ISI)', r.x + 6, r.y + 14)
  axisLabel(ctx, 'equalized', r.x + 6, r.y + topH + 14)
}

/** Kalman trajectory: ±2σ band, noisy measurements, truth, and estimate. */
function drawTrajectory(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  truePos: Float64Array,
  meas: Float64Array,
  estPos: Float64Array,
  posStd: Float64Array,
) {
  fillPlotBg(ctx, r)
  grid(ctx, r, 8, 4)
  const n = truePos.length
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < n; i++) {
    lo = Math.min(lo, truePos[i], meas[i], estPos[i])
    hi = Math.max(hi, truePos[i], meas[i], estPos[i])
  }
  const pad = (hi - lo) * 0.08 + 1e-6
  lo -= pad
  hi += pad
  const yOf = (v: number) => r.y + (1 - (v - lo) / (hi - lo)) * r.h
  const xOf = (i: number) => r.x + (i / (n - 1)) * r.w
  // ±2σ uncertainty band.
  ctx.fillStyle = 'rgba(167,139,250,0.16)'
  ctx.beginPath()
  for (let i = 0; i < n; i++) ctx.lineTo(xOf(i), yOf(estPos[i] + 2 * posStd[i]))
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(xOf(i), yOf(estPos[i] - 2 * posStd[i]))
  ctx.closePath()
  ctx.fill()
  // Measurements as faint dots.
  ctx.fillStyle = 'rgba(148,163,184,0.5)'
  for (let i = 0; i < n; i++) {
    ctx.beginPath()
    ctx.arc(xOf(i), yOf(meas[i]), 1.3, 0, 2 * Math.PI)
    ctx.fill()
  }
  const line = (data: Float64Array, color: string, w: number) => {
    ctx.strokeStyle = color
    ctx.lineWidth = w
    ctx.lineJoin = 'round'
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const x = xOf(i)
      const y = yOf(data[i])
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  line(truePos, 'rgba(94,234,212,0.85)', 2.4) // truth (teal)
  line(estPos, VIOLET, 1.8) // estimate (violet)
  axisLabel(ctx, 'time →', r.x + r.w - 6, r.y + r.h - 8, 'right')
  ctx.fillStyle = TEAL
  ctx.textAlign = 'left'
  ctx.fillText('truth', r.x + 8, r.y + 14)
  ctx.fillStyle = VIOLET
  ctx.fillText('Kalman ±2σ', r.x + 8, r.y + 28)
  ctx.fillStyle = 'rgba(148,163,184,0.9)'
  ctx.fillText('measurements', r.x + 8, r.y + 42)
}

// ---------------------------------------------------------------------------

export default function Adaptive() {
  const sp = useMemo(() => readHashParams(), [])
  const [mode, setMode] = useState<Mode>(() => readStr<Mode>(sp, 'sc', 'sysid', SCENARIOS.map((s) => s.id)))
  const [algo, setAlgo] = useState<AlgoKind>(() => readStr<AlgoKind>(sp, 'algo', 'rls', ALGOS.map((a) => a.id)))
  const [L, setL] = useState(() => Math.round(readNum(sp, 'L', 16)))
  const [mu01, setMu01] = useState(() => readNum(sp, 'mu', 0.4))
  const [lambda, setLambda] = useState(() => readNum(sp, 'lam', 0.999))
  const [apaOrder, setApaOrder] = useState(() => Math.round(readNum(sp, 'K', 4)))
  const [seedBump, setSeedBump] = useState(0)
  const [copied, setCopied] = useState(false)

  // Scenario params (with per-scenario defaults, read from URL where present).
  const [plantLen, setPlantLen] = useState(() => Math.round(readNum(sp, 'pl', 8)))
  const [color, setColor] = useState(() => readNum(sp, 'col', 0))
  const [snrDb, setSnrDb] = useState(() => readNum(sp, 'snr', 40))
  const [freq, setFreq] = useState(() => readNum(sp, 'f', 0.02))
  const [channel, setChannel] = useState(() => Math.round(readNum(sp, 'ch', 0)))
  const [delay, setDelay] = useState(() => Math.round(readNum(sp, 'dl', 8)))
  const [arA1, setArA1] = useState(() => readNum(sp, 'a1', 1.5))
  const [arA2, setArA2] = useState(() => readNum(sp, 'a2', -0.95))

  // Kalman params.
  const [kMotion, setKMotion] = useState<'sine' | 'randomwalk'>(() =>
    readStr<'sine' | 'randomwalk'>(sp, 'km', 'randomwalk', ['sine', 'randomwalk']),
  )
  const [sigmaMeas, setSigmaMeas] = useState(() => readNum(sp, 'sm', 1.5))
  const [sigmaA, setSigmaA] = useState(() => readNum(sp, 'sa', 1.0))
  const [showRace, setShowRace] = useState(() => readBool(sp, 'race', true))

  const isKalman = mode === 'kalman'
  const seed = 4000 + seedBump

  // Build the scenario config for adaptive modes.
  const scfg = useMemo<ScenarioConfig | null>(() => {
    if (isKalman) return null
    const N = SCENARIO_DEFAULTS[mode as ScenarioKind].N
    return {
      scenario: mode as ScenarioKind,
      N,
      plantLen,
      color,
      snrDb,
      freq,
      channel,
      arA1,
      arA2,
      delay,
    }
  }, [isKalman, mode, plantLen, color, snrDb, freq, channel, arA1, arA2, delay])

  const cfg = useMemo(
    () => (isKalman ? null : algoConfig(algo, mode as ScenarioKind, L, mu01, apaOrder, lambda)),
    [isKalman, algo, mode, L, mu01, apaOrder, lambda],
  )

  // The display run: one realisation of the scenario with the selected algorithm.
  const run = useMemo(() => {
    if (!scfg || !cfg) return null
    const sc = makeScenario(scfg, seed)
    const r = runAdaptive(sc.u, sc.d, cfg)
    return { sc, r }
  }, [scfg, cfg, seed])

  // The learning-curve race: all four algorithms, ensemble-averaged.
  const race = useMemo(() => {
    if (!scfg) return null
    const algos = ALGOS.map((a) => algoConfig(a.id, mode as ScenarioKind, L, mu01, apaOrder, lambda))
    const { curvesDb } = learningCurves(scfg, algos, 14, seed)
    return curvesDb
  }, [scfg, mode, L, mu01, apaOrder, lambda, seed])

  const kalman = useMemo(() => {
    if (!isKalman) return null
    const kc: KalmanConfig = {
      N: 500,
      dt: 0.1,
      sigmaA,
      sigmaMeas,
      trueSigmaA: kMotion === 'randomwalk' ? 0.8 : 0.5,
      motion: kMotion,
    }
    return runKalman(kc, seed)
  }, [isKalman, sigmaA, sigmaMeas, kMotion, seed])

  // ---- metrics ----
  const metrics = useMemo(() => {
    if (isKalman && kalman) {
      const factor = kalman.rmseMeas / Math.max(kalman.rmseKalman, 1e-9)
      return [
        { label: 'Meas RMSE', value: kalman.rmseMeas.toFixed(2) },
        { label: 'Kalman RMSE', value: kalman.rmseKalman.toFixed(2) },
        { label: 'Improvement', value: `${factor.toFixed(2)}×` },
        { label: 'σ_pos (end)', value: kalman.posStd[kalman.posStd.length - 1].toFixed(2) },
      ]
    }
    if (!run || !scfg) return []
    const { sc, r } = run
    const tailN = Math.floor(scfg.N * 0.85)
    let mse = 0
    for (let n = tailN; n < scfg.N; n++) mse += r.e[n] * r.e[n]
    mse = mse / (scfg.N - tailN)
    const mseDb = 10 * Math.log10(mse + 1e-30)
    if (mode === 'sysid') {
      return [
        { label: 'Misalignment', value: `${misalignmentDb(r.w, sc.truth!).toFixed(1)} dB` },
        { label: 'Steady MSE', value: `${mseDb.toFixed(1)} dB` },
        { label: 'Taps L', value: String(L) },
        { label: 'Plant', value: String(scfg.plantLen) },
      ]
    }
    if (mode === 'anc') {
      const snrIn = snrDbTail(sc.clean!, sc.d)
      const snrOut = snrDbTail(sc.clean!, r.e)
      return [
        { label: 'SNR in', value: `${snrIn.toFixed(1)} dB` },
        { label: 'SNR out', value: `${snrOut.toFixed(1)} dB` },
        { label: 'SNR gain', value: `${(snrOut - snrIn).toFixed(1)} dB` },
        { label: 'Steady MSE', value: `${mseDb.toFixed(1)} dB` },
      ]
    }
    if (mode === 'equalize') {
      let err = 0
      let cnt = 0
      for (let n = tailN; n < scfg.N; n++) {
        const dec = r.y[n] >= 0 ? 1 : -1
        if (n - scfg.delay >= 0) {
          if (dec !== sc.symbols![n - scfg.delay]) err++
          cnt++
        }
      }
      return [
        { label: 'Tail SER', value: cnt ? (err / cnt).toExponential(1) : '—' },
        { label: 'Errors', value: `${err}/${cnt}` },
        { label: 'Steady MSE', value: `${mseDb.toFixed(1)} dB` },
        { label: 'Delay Δ', value: String(scfg.delay) },
      ]
    }
    // predict
    let varU = 0
    let varE = 0
    for (let n = tailN; n < scfg.N; n++) {
      varU += sc.clean![n] * sc.clean![n]
      varE += r.e[n] * r.e[n]
    }
    const gainDb = 10 * Math.log10(varU / Math.max(varE, 1e-30))
    return [
      { label: 'Pred. gain', value: `${gainDb.toFixed(1)} dB` },
      { label: 'w₁ (a₁)', value: r.w[0].toFixed(2) },
      { label: 'w₂ (a₂)', value: r.w[1].toFixed(2) },
      { label: 'Resid. power', value: (varE / (scfg.N - tailN)).toFixed(2) },
    ]
  }, [isKalman, kalman, run, scfg, mode, L])

  // ---- canvases ----
  const { ref: c1Ref, size: c1Size } = useDprCanvas()
  const { ref: c2Ref, size: c2Size } = useDprCanvas()
  const { ref: c3Ref, size: c3Size } = useDprCanvas()
  const { ref: c4Ref, size: c4Size } = useDprCanvas()

  // Canvas 1 — primary signal comparison / Kalman trajectory.
  useEffect(() => {
    const ctx = prepareContext(c1Ref.current, c1Size)
    if (!ctx) return
    const r: Rect = { x: 0, y: 0, w: c1Size.width, h: c1Size.height }
    if (isKalman && kalman) {
      drawTrajectory(ctx, r, kalman.truePos, kalman.meas, kalman.estPos, kalman.posStd)
    } else if (run) {
      const { sc, r: rr } = run
      if (mode === 'anc') drawDual(ctx, r, sc.clean!, rr.e, 500, 'rgba(94,234,212,0.5)', VIOLET, 3.4, 1.6)
      else if (mode === 'predict') drawDual(ctx, r, sc.d, rr.y, 260, 'rgba(94,234,212,0.5)', VIOLET, 3, 1.6)
      else drawDual(ctx, r, sc.d, rr.y, mode === 'equalize' ? 200 : 400, 'rgba(94,234,212,0.5)', VIOLET, 3, 1.6)
    }
  }, [isKalman, kalman, run, mode, c1Size, c1Ref])

  // Canvas 2 — learning curve race / Kalman velocity.
  useEffect(() => {
    const ctx = prepareContext(c2Ref.current, c2Size)
    if (!ctx) return
    const r: Rect = { x: 0, y: 0, w: c2Size.width, h: c2Size.height }
    if (isKalman && kalman) {
      drawDual(ctx, r, kalman.trueVel, kalman.estVel, kalman.trueVel.length, 'rgba(94,234,212,0.7)', VIOLET, 2.4, 1.6)
    } else if (race) {
      const sel = Math.max(0, ALGOS.findIndex((a) => a.id === algo))
      drawCurves(ctx, r, race, sel, !showRace)
    }
  }, [isKalman, kalman, race, algo, showRace, c2Size, c2Ref])

  // Canvas 3 — taps / combined response / Kalman uncertainty.
  useEffect(() => {
    const ctx = prepareContext(c3Ref.current, c3Size)
    if (!ctx) return
    const r: Rect = { x: 0, y: 0, w: c3Size.width, h: c3Size.height }
    if (isKalman && kalman) {
      // Position uncertainty √P₀₀ converging + innovation.
      drawDual(ctx, r, kalman.posStd, kalman.innov, kalman.posStd.length, AMBER, 'rgba(148,163,184,0.6)', 2.4, 1.2)
    } else if (run) {
      const { sc, r: rr } = run
      if (mode === 'equalize') {
        const comb = convolve(sc.channelTaps!, rr.w)
        drawTaps(ctx, r, undefined, comb)
      } else {
        drawTaps(ctx, r, sc.truth, rr.w)
      }
    }
  }, [isKalman, kalman, run, mode, c3Size, c3Ref])

  // Canvas 4 — scenario extra (equalizer strip / prediction residual / ANC noisy primary).
  useEffect(() => {
    const ctx = prepareContext(c4Ref.current, c4Size)
    if (!ctx) return
    const r: Rect = { x: 0, y: 0, w: c4Size.width, h: c4Size.height }
    if (isKalman && kalman) {
      // Innovation sequence (should look white if the model matches).
      drawDual(ctx, r, kalman.innov, new Float64Array(kalman.innov.length), kalman.innov.length, ROSE, 'rgba(0,0,0,0)', 1.4, 0)
      return
    }
    if (!run) return
    const { sc, r: rr } = run
    if (mode === 'equalize') {
      const N = sc.u.length
      const received: number[] = []
      const equalized: number[] = []
      const syms: number[] = []
      for (let n = N - 700; n < N; n++) {
        if (n - sc.channelTaps!.length + 1 < 0) continue
        received.push(sc.u[n])
        equalized.push(rr.y[n])
        syms.push(sc.symbols![n - delay] > 0 ? 1 : -1)
      }
      drawStrip(ctx, r, received, equalized, syms)
    } else if (mode === 'anc') {
      // Noisy primary (what the mic hears) vs the recovered signal.
      drawDual(ctx, r, sc.d, rr.e, 500, 'rgba(148,163,184,0.55)', TEAL, 1.4, 1.8)
    } else {
      // Error / residual trace over the whole run — watch it shrink then settle.
      drawDual(ctx, r, rr.e, new Float64Array(rr.e.length), rr.e.length, ROSE, 'rgba(0,0,0,0)', 1.2, 0)
    }
  }, [isKalman, kalman, run, mode, delay, c4Size, c4Ref])

  const onShare = () => {
    shareLink('adaptive', {
      sc: mode,
      algo,
      L,
      mu: mu01.toFixed(3),
      lam: lambda.toFixed(3),
      K: apaOrder,
      pl: plantLen,
      col: color.toFixed(2),
      snr: snrDb.toFixed(0),
      f: freq.toFixed(3),
      ch: channel,
      dl: delay,
      a1: arA1.toFixed(2),
      a2: arA2.toFixed(2),
      km: kMotion,
      sm: sigmaMeas.toFixed(2),
      sa: sigmaA.toFixed(2),
      race: showRace,
    }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  // Canvas titles adapt to the scenario.
  const titles = isKalman
    ? {
        c1: 'Position — truth · measurements · Kalman ±2σ',
        c2: 'Velocity — truth vs estimated',
        c3: 'Uncertainty √P₀₀ (amber) & innovation',
        c4: 'Innovation sequence (whiteness check)',
      }
    : mode === 'equalize'
      ? { c1: 'Desired vs equalizer output', c2: 'Learning curve', c3: 'Channel ⊛ equalizer ≈ δ', c4: 'BPSK strip — received vs equalized' }
      : mode === 'anc'
        ? { c1: 'Clean signal vs recovered (error out)', c2: 'Learning curve', c3: 'Room path — true vs learned', c4: 'Noisy primary vs recovered' }
        : mode === 'predict'
          ? { c1: 'Process vs one-step prediction', c2: 'Learning curve', c3: 'Predictor taps vs AR(2)', c4: 'Prediction residual (whitened)' }
          : { c1: 'Desired vs filter output', c2: 'Learning curve', c3: 'Plant — true vs learned taps', c4: 'Error signal e(n)' }

  const introText = isKalman
    ? 'The Kalman filter tracks a hidden state by fusing a motion model with noisy measurements — the same predict/update recursion as RLS, applied to physics instead of taps. A constant-velocity model tracks position from noisy position readings; the shaded band is the filter’s own ±2σ uncertainty, shrinking as it gains confidence.'
    : 'An adaptive filter starts blind and tunes its own taps from the data, chasing a target it only sees through a desired reference d(n). One mechanism — y = wᵀx, then nudge w to shrink e = d − y — solves four classic problems just by rewiring what plays u and d.'

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Scenario">
          <Select value={mode} options={SCENARIOS} onChange={(v) => setMode(v as Mode)} />
        </Panel>

        {!isKalman && (
          <Panel title="Algorithm">
            <Segmented value={algo} options={ALGOS} onChange={setAlgo} />
            <Field label="Filter length L" value={String(L)}>
              <Slider min={2} max={32} step={1} value={L} onChange={(v) => setL(Math.round(v))} />
            </Field>
            {algo !== 'rls' && (
              <Field label={algo === 'lms' ? 'Step µ (× stability bound)' : 'Step µ (normalised)'} value={mu01.toFixed(2)}>
                <Slider min={0.02} max={1} step={0.02} value={mu01} onChange={setMu01} />
              </Field>
            )}
            {algo === 'apa' && (
              <Field label="Projection order K" value={String(apaOrder)}>
                <Slider min={1} max={8} step={1} value={apaOrder} onChange={(v) => setApaOrder(Math.round(v))} />
              </Field>
            )}
            {algo === 'rls' && (
              <Field label="Forgetting λ" value={lambda.toFixed(3)}>
                <Slider min={0.95} max={1} step={0.001} value={lambda} onChange={setLambda} />
              </Field>
            )}
          </Panel>
        )}

        {mode === 'sysid' && (
          <Panel title="Plant & input">
            <Field label="Plant length" value={String(plantLen)}>
              <Slider min={2} max={16} step={1} value={plantLen} onChange={(v) => setPlantLen(Math.round(v))} />
            </Field>
            <Field label="Input colour ρ" value={color === 0 ? 'white' : color.toFixed(2)}>
              <Slider min={0} max={0.92} step={0.02} value={color} onChange={setColor} />
            </Field>
            <Field label="Observation SNR" value={`${snrDb.toFixed(0)} dB`}>
              <Slider min={5} max={60} step={1} value={snrDb} onChange={setSnrDb} />
            </Field>
          </Panel>
        )}

        {mode === 'anc' && (
          <Panel title="Signal & noise">
            <Field label="Tone frequency" value={`${freq.toFixed(3)} cyc/s`}>
              <Slider min={0.005} max={0.1} step={0.005} value={freq} onChange={setFreq} />
            </Field>
            <Field label="Sensor SNR" value={`${snrDb.toFixed(0)} dB`}>
              <Slider min={10} max={60} step={1} value={snrDb} onChange={setSnrDb} />
            </Field>
          </Panel>
        )}

        {mode === 'equalize' && (
          <Panel title="Channel">
            <Field label="ISI channel">
              <Select
                value={String(channel)}
                options={[
                  { id: '0', label: 'Proakis B (mild)' },
                  { id: '1', label: 'Proakis C (hard)' },
                  { id: '2', label: 'Sparse echo' },
                ]}
                onChange={(v) => setChannel(parseInt(v, 10))}
              />
            </Field>
            <Field label="Training delay Δ" value={String(delay)}>
              <Slider min={0} max={20} step={1} value={delay} onChange={(v) => setDelay(Math.round(v))} />
            </Field>
            <Field label="Channel SNR" value={`${snrDb.toFixed(0)} dB`}>
              <Slider min={5} max={40} step={1} value={snrDb} onChange={setSnrDb} />
            </Field>
          </Panel>
        )}

        {mode === 'predict' && (
          <Panel title="AR(2) process">
            <Field label="a₁" value={arA1.toFixed(2)}>
              <Slider min={-1.98} max={1.98} step={0.02} value={arA1} onChange={setArA1} />
            </Field>
            <Field label="a₂" value={arA2.toFixed(2)}>
              <Slider min={-0.98} max={0.98} step={0.02} value={arA2} onChange={setArA2} />
            </Field>
          </Panel>
        )}

        {isKalman && (
          <Panel title="Tracking model">
            <Field label="Target motion">
              <Select
                value={kMotion}
                options={[
                  { id: 'sine', label: 'Smooth (sine)' },
                  { id: 'randomwalk', label: 'Random accel' },
                ]}
                onChange={setKMotion}
              />
            </Field>
            <Field label="Measurement σ" value={sigmaMeas.toFixed(2)}>
              <Slider min={0.2} max={4} step={0.1} value={sigmaMeas} onChange={setSigmaMeas} />
            </Field>
            <Field label="Process σ_a (assumed)" value={sigmaA.toFixed(2)}>
              <Slider min={0.05} max={4} step={0.05} value={sigmaA} onChange={setSigmaA} />
            </Field>
          </Panel>
        )}

        <Panel title="Result">
          <Readout items={metrics} />
          <div className="btn-row">
            <Button variant="ghost" onClick={() => setSeedBump((s) => s + 1)}>
              New draw
            </Button>
            <Button variant="ghost" onClick={onShare}>
              {copied ? 'Copied ✓' : 'Copy link'}
            </Button>
          </div>
        </Panel>

        {!isKalman && (
          <Panel title="Learning curve">
            <Toggle label="Race all four algorithms" checked={showRace} onChange={setShowRace} />
          </Panel>
        )}
      </div>

      <div className="mode-main">
        <p className="mode-intro">{introText}</p>
        <div className="tomo-grid">
          <CanvasCard title={titles.c1} aspect={1.7}>
            <canvas ref={c1Ref} />
          </CanvasCard>
          <CanvasCard title={titles.c2} note={isKalman ? undefined : showRace ? 'ensemble MSE, 14 runs' : algo.toUpperCase()} aspect={1.7}>
            <canvas ref={c2Ref} />
          </CanvasCard>
          <CanvasCard title={titles.c3} aspect={1.7}>
            <canvas ref={c3Ref} />
          </CanvasCard>
          <CanvasCard title={titles.c4} aspect={1.7}>
            <canvas ref={c4Ref} />
          </CanvasCard>
        </div>
        <p className="mode-intro" style={{ marginTop: 12 }}>
          {mode === 'sysid' && (
            <>
              An unknown FIR plant is probed with noise; the filter learns its impulse response
              (violet) onto the truth (teal). Turn up <strong>input colour ρ</strong> to widen the
              correlation-matrix eigenvalue spread — watch plain <strong>LMS</strong> crawl while{' '}
              <strong>RLS</strong> is immune. <strong>RLS</strong> converges in ~2L steps and lands on
              the exact least-squares (Wiener) solution.
            </>
          )}
          {mode === 'anc' && (
            <>
              A tone is buried under noise reaching the mic through an unknown room path; a second mic
              hears the raw noise. The filter predicts the noise from the reference and subtracts it —
              its <em>error</em> output <em>is</em> the recovered signal. Smaller <strong>µ</strong>{' '}
              lowers misadjustment (cleaner) at the cost of speed; <strong>RLS</strong> cancels hardest.
            </>
          )}
          {mode === 'equalize' && (
            <>
              Random ±1 symbols smear through an ISI channel (top strip — the eye is closed). Trained
              against a delayed clean copy, the equalizer inverts the channel so{' '}
              <code>channel ⊛ equalizer ≈ δ</code> and the bottom strip snaps back to two clean
              clusters at ±1. Try the <strong>hard Proakis-C</strong> channel with its deep spectral
              null, where a longer filter and RLS earn their keep.
            </>
          )}
          {mode === 'predict' && (
            <>
              A sharp AR(2) resonance is fed to a one-step predictor. It learns the AR coefficients
              (taps → <code>[a₁, a₂]</code>) and its residual is <em>whitened</em> — the prediction
              gain is exactly how much of the signal was linearly predictable. This is the engine
              behind linear predictive coding of speech.
            </>
          )}
          {isKalman && (
            <>
              The measurements (grey) are noisy; the Kalman estimate (violet) rides the truth (teal)
              inside its own shrinking ±2σ band. Raise <strong>measurement σ</strong> and the filter
              leans on its model; raise <strong>process σ_a</strong> and it trusts the data more. On a
              matched random-acceleration target the innovation sequence is white — the sign of an
              optimally tuned filter.
            </>
          )}
        </p>
      </div>
    </div>
  )
}
