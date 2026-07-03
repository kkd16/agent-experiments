import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Segmented, Readout, Button, Toggle } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import { fillPlotBg, grid, axisLabel } from '../lib/draw'
import { generateSignal, SIGNALS } from '../lib/dsp'
import type { SignalName } from '../lib/dsp'
import { audio } from '../lib/audio'
import { readHashParams, shareLink, readNum, readStr } from '../lib/urlState'
import type { Cx } from '../lib/cplx'
import { cx } from '../lib/cplx'
import {
  designFilter,
  designFromZpk,
  freqResponse,
  impulseResponse,
  stepResponse,
  applyFilter,
} from '../lib/filterdesign'
import type { DesignParams, FamilyId, ResponseType, BiquadType, Design } from '../lib/filterdesign'

const FS = 1000
const NYQ = FS / 2
const N_SIG = 2048
const AUDIO_SR = 8000
const RESP_PTS = 512

const FAMILIES: { id: FamilyId; label: string }[] = [
  { id: 'butter', label: 'Butterworth' },
  { id: 'cheby1', label: 'Chebyshev I' },
  { id: 'cheby2', label: 'Chebyshev II' },
  { id: 'fir', label: 'FIR (windowed sinc)' },
  { id: 'biquad', label: 'Biquad (RBJ cookbook)' },
  { id: 'manual', label: 'Manual — drag the z-plane' },
]

const RESPONSES: { id: ResponseType; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'high', label: 'High' },
  { id: 'band', label: 'Band' },
  { id: 'notch', label: 'Stop' },
]

const BIQUAD_TYPES: { id: BiquadType; label: string }[] = [
  { id: 'lowpass', label: 'Low-pass' },
  { id: 'highpass', label: 'High-pass' },
  { id: 'bandpass', label: 'Band-pass' },
  { id: 'notch', label: 'Notch' },
  { id: 'peak', label: 'Peaking EQ' },
  { id: 'lowshelf', label: 'Low shelf' },
  { id: 'highshelf', label: 'High shelf' },
]

const WINDOWS: { id: DesignParams['window']; label: string }[] = [
  { id: 'hamming', label: 'Hamming' },
  { id: 'hann', label: 'Hann' },
  { id: 'blackman', label: 'Blackman' },
  { id: 'rect', label: 'Rectangular' },
]

// ---- manual z-plane handles: each represents a real root or a conjugate pair ----
interface Handle {
  re: number
  im: number // 0 → real root; >0 → conjugate pair (mirror added automatically)
}
type Kind = 'pole' | 'zero'

function handlesToRoots(hs: Handle[]): Cx[] {
  const out: Cx[] = []
  for (const h of hs) {
    if (Math.abs(h.im) < 1e-6) out.push(cx(h.re, 0))
    else {
      out.push(cx(h.re, h.im))
      out.push(cx(h.re, -h.im))
    }
  }
  return out
}

/** Collapse a full conjugate-symmetric root set into upper-half + real handles. */
function rootsToHandles(roots: Cx[]): Handle[] {
  return roots.filter((r) => r.im >= -1e-9).map((r) => ({ re: r.re, im: Math.max(0, r.im) }))
}

// ---- generic labelled line plot over an x-in-[0,1] series with a y range ----
interface PlotRect {
  x: number
  y: number
  w: number
  h: number
}
function seriesPlot(
  ctx: CanvasRenderingContext2D,
  r: PlotRect,
  data: ArrayLike<number>,
  lo: number,
  hi: number,
  color: string,
  width = 2,
  fill?: string,
) {
  const n = data.length
  if (n < 2 || hi <= lo) return
  const yOf = (v: number) => r.y + r.h - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * r.h
  if (fill) {
    ctx.beginPath()
    ctx.moveTo(r.x, r.y + r.h)
    for (let i = 0; i < n; i++) ctx.lineTo(r.x + (i / (n - 1)) * r.w, yOf(data[i]))
    ctx.lineTo(r.x + r.w, r.y + r.h)
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()
  }
  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const px = r.x + (i / (n - 1)) * r.w
    const py = yOf(data[i])
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineJoin = 'round'
  ctx.stroke()
}

function vMarker(ctx: CanvasRenderingContext2D, r: PlotRect, frac: number, color: string, label?: string) {
  const x = r.x + frac * r.w
  ctx.strokeStyle = color
  ctx.lineWidth = 1.4
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(x, r.y)
  ctx.lineTo(x, r.y + r.h)
  ctx.stroke()
  ctx.setLineDash([])
  if (label) axisLabel(ctx, label, Math.min(r.w - 4, x + 4), r.y + 12, 'left')
}

export default function DesignMode() {
  const sp = useMemo(() => readHashParams(), [])
  const [family, setFamily] = useState<FamilyId>(() =>
    readStr<FamilyId>(sp, 'fam', 'butter', FAMILIES.map((f) => f.id)),
  )
  const [response, setResponse] = useState<ResponseType>(() =>
    readStr<ResponseType>(sp, 'resp', 'low', ['low', 'high', 'band', 'notch']),
  )
  const [order, setOrder] = useState(() => readNum(sp, 'ord', 6))
  const [cutoff, setCutoff] = useState(() => readNum(sp, 'fc', 120))
  const [cutoffHi, setCutoffHi] = useState(() => readNum(sp, 'fc2', 240))
  const [rippleDb, setRippleDb] = useState(() => readNum(sp, 'rip', 1))
  const [stopDb, setStopDb] = useState(() => readNum(sp, 'atn', 45))
  const [biquadType, setBiquadType] = useState<BiquadType>(() =>
    readStr<BiquadType>(sp, 'bq', 'peak', BIQUAD_TYPES.map((b) => b.id)),
  )
  const [q, setQ] = useState(() => readNum(sp, 'q', 2))
  const [gainDb, setGainDb] = useState(() => readNum(sp, 'gdb', 9))
  const [taps, setTaps] = useState(() => readNum(sp, 'tap', 65))
  const [win, setWin] = useState<DesignParams['window']>(() =>
    readStr<DesignParams['window']>(sp, 'win', 'hamming', WINDOWS.map((w) => w.id)),
  )

  // manual z-plane state
  const [mPoles, setMPoles] = useState<Handle[]>([{ re: 0.6, im: 0.5 }])
  const [mZeros, setMZeros] = useState<Handle[]>([{ re: -1, im: 0 }])
  const [mGain, setMGain] = useState(1)

  // audio / signal
  const [sig, setSig] = useState<SignalName>(() =>
    readStr<SignalName>(sp, 'sig', 'twoTone', SIGNALS.map((s) => s.id)),
  )
  const [noise, setNoise] = useState(() => readNum(sp, 'nz', 0.12))
  const [playing, setPlaying] = useState<'none' | 'in' | 'out'>('none')
  const [showGD, setShowGD] = useState(true)
  const [copied, setCopied] = useState(false)

  const params: DesignParams = useMemo(
    () => ({
      family,
      response,
      order,
      fs: FS,
      cutoff,
      cutoffHi,
      rippleDb,
      stopDb,
      biquadType,
      q,
      gainDb,
      taps,
      window: win,
    }),
    [family, response, order, cutoff, cutoffHi, rippleDb, stopDb, biquadType, q, gainDb, taps, win],
  )

  const design: Design = useMemo(() => {
    if (family === 'manual') {
      return designFromZpk(handlesToRoots(mZeros), handlesToRoots(mPoles), mGain, FS)
    }
    return designFilter(params)
  }, [family, params, mZeros, mPoles, mGain])

  const fr = useMemo(() => freqResponse(design, RESP_PTS), [design])
  const impulse = useMemo(() => impulseResponse(design, 96), [design])
  const step = useMemo(() => stepResponse(design, 96), [design])

  // Switch into manual mode, seeding the z-plane from the current design.
  const enterManual = useCallback(() => {
    setMPoles(rootsToHandles(design.poles))
    setMZeros(rootsToHandles(design.zeros))
    setMGain(design.gain)
    setFamily('manual')
  }, [design])

  // ---- audio A/B ----
  const filteredSig = useMemo(() => {
    const raw = generateSignal(sig, N_SIG, { freq: 40, fs: FS, amp: 1, noise, seed: 1234 })
    return { raw, out: applyFilter(design, raw) }
  }, [sig, noise, design])

  useEffect(() => {
    if (playing === 'none') {
      audio.stop()
      return
    }
    const buf = playing === 'in' ? filteredSig.raw : filteredSig.out
    audio.playSignal(buf, { sampleRate: AUDIO_SR, gain: 0.8 })
  }, [playing, filteredSig])
  useEffect(() => () => audio.stop(), [])
  const toggle = (w: 'in' | 'out') => setPlaying((p) => (p === w ? 'none' : w))

  const onShare = () => {
    shareLink('design', {
      fam: family,
      resp: response,
      ord: order,
      fc: cutoff,
      fc2: cutoffHi,
      rip: rippleDb,
      atn: stopDb,
      bq: biquadType,
      q,
      gdb: gainDb,
      tap: taps,
      win,
      sig,
      nz: noise.toFixed(2),
    }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  // ------------------------------------------------------------------
  // z-plane canvas (interactive)
  // ------------------------------------------------------------------
  const { ref: zRef, size: zSize } = useDprCanvas()
  const dragRef = useRef<{ kind: Kind; index: number } | null>(null)
  const [hover, setHover] = useState<{ kind: Kind; index: number } | null>(null)

  const geom = useMemo(() => {
    const w = zSize.width
    const h = zSize.height
    const cxp = w / 2
    const cyp = h / 2
    const R = 0.38 * Math.min(w, h)
    return { w, h, cxp, cyp, R }
  }, [zSize])

  const toScreen = useCallback(
    (z: Cx) => ({ x: geom.cxp + z.re * geom.R, y: geom.cyp - z.im * geom.R }),
    [geom],
  )
  const toPlane = useCallback(
    (px: number, py: number): Cx => cx((px - geom.cxp) / geom.R, -(py - geom.cyp) / geom.R),
    [geom],
  )

  // Hit-test against a set of handles. A conjugate-pair handle stores only its
  // upper representative, but *both* marks are drawn — so we also test the
  // mirrored (re, −im) position, making every visible pole/zero grabbable.
  const pickIn = useCallback(
    (poles: Handle[], zeros: Handle[], px: number, py: number): { kind: Kind; index: number } | null => {
      let best: { kind: Kind; index: number } | null = null
      let bestD = 15
      const scan = (hs: Handle[], kind: Kind) => {
        hs.forEach((hn, i) => {
          const cand = Math.abs(hn.im) < 1e-6 ? [cx(hn.re, 0)] : [cx(hn.re, hn.im), cx(hn.re, -hn.im)]
          for (const z of cand) {
            const s = toScreen(z)
            const d = Math.hypot(s.x - px, s.y - py)
            if (d < bestD) {
              bestD = d
              best = { kind, index: i }
            }
          }
        })
      }
      scan(poles, 'pole')
      scan(zeros, 'zero')
      return best
    },
    [toScreen],
  )

  const pickHandle = useCallback(
    (px: number, py: number) => pickIn(mPoles, mZeros, px, py),
    [pickIn, mPoles, mZeros],
  )

  const localPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return { px: e.clientX - rect.left, py: e.clientY - rect.top }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { px, py } = localPointer(e)
    if (family !== 'manual') {
      // Seed manual handles from the current design, then hit-test against them.
      const seededP = rootsToHandles(design.poles)
      const seededZ = rootsToHandles(design.zeros)
      const hit = pickIn(seededP, seededZ, px, py)
      if (!hit) return
      setMPoles(seededP)
      setMZeros(seededZ)
      setMGain(design.gain)
      setFamily('manual')
      dragRef.current = hit
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }
    const hit = pickHandle(px, py)
    if (hit) {
      dragRef.current = hit
      e.currentTarget.setPointerCapture(e.pointerId)
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { px, py } = localPointer(e)
    const drag = dragRef.current
    if (!drag) {
      setHover(pickHandle(px, py))
      return
    }
    const z = toPlane(px, py)
    const wasReal = (drag.kind === 'pole' ? mPoles : mZeros)[drag.index]?.im ?? 0
    const isReal = Math.abs(wasReal) < 1e-6
    const next: Handle = isReal
      ? { re: z.re, im: 0 }
      : { re: z.re, im: Math.max(0.02, Math.abs(z.im)) }
    if (drag.kind === 'pole') {
      setMPoles((prev) => prev.map((hn, i) => (i === drag.index ? next : hn)))
    } else {
      setMZeros((prev) => prev.map((hn, i) => (i === drag.index ? next : hn)))
    }
  }

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      dragRef.current = null
    }
  }

  const onDoubleClick = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (family !== 'manual') return
    const { px, py } = localPointer(e)
    const hit = pickHandle(px, py)
    if (!hit) return
    if (hit.kind === 'pole') setMPoles((prev) => prev.filter((_, i) => i !== hit.index))
    else setMZeros((prev) => prev.filter((_, i) => i !== hit.index))
  }

  // draw z-plane
  useEffect(() => {
    const ctx = prepareContext(zRef.current, zSize)
    if (!ctx) return
    const { w, h, cxp, cyp, R } = geom
    ctx.fillStyle = 'rgba(6,9,20,0.6)'
    ctx.fillRect(0, 0, w, h)

    // stable region (inside unit circle) subtle fill
    ctx.beginPath()
    ctx.arc(cxp, cyp, R, 0, 2 * Math.PI)
    ctx.fillStyle = design.stable ? 'rgba(94,234,212,0.05)' : 'rgba(251,113,133,0.06)'
    ctx.fill()

    // axes
    ctx.strokeStyle = 'rgba(120,140,220,0.25)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, cyp)
    ctx.lineTo(w, cyp)
    ctx.moveTo(cxp, 0)
    ctx.lineTo(cxp, h)
    ctx.stroke()
    // unit circle
    ctx.beginPath()
    ctx.arc(cxp, cyp, R, 0, 2 * Math.PI)
    ctx.strokeStyle = 'rgba(154,166,212,0.55)'
    ctx.lineWidth = 1.6
    ctx.stroke()
    // ticks at ±1
    axisLabel(ctx, 'Re', w - 6, cyp - 6, 'right')
    axisLabel(ctx, 'Im', cxp + 6, 12, 'left')
    axisLabel(ctx, '1', cxp + R - 3, cyp + 14, 'center')
    axisLabel(ctx, '−1', cxp - R + 3, cyp + 14, 'center')

    const drawMark = (z: Cx, kind: Kind, active: boolean) => {
      const s = toScreen(z)
      ctx.lineWidth = active ? 3 : 2
      if (kind === 'zero') {
        ctx.strokeStyle = active ? '#7dd3fc' : '#38bdf8'
        ctx.beginPath()
        ctx.arc(s.x, s.y, 7, 0, 2 * Math.PI)
        ctx.stroke()
      } else {
        ctx.strokeStyle = active ? '#c4b5fd' : '#a78bfa'
        ctx.beginPath()
        ctx.moveTo(s.x - 6, s.y - 6)
        ctx.lineTo(s.x + 6, s.y + 6)
        ctx.moveTo(s.x + 6, s.y - 6)
        ctx.lineTo(s.x - 6, s.y + 6)
        ctx.stroke()
      }
    }

    // draw actual roots (full conjugate set) so mirrors are visible
    design.zeros.forEach((z) => drawMark(z, 'zero', false))
    design.poles.forEach((p) => drawMark(p, 'pole', false))
    // highlight the hovered handle (upper representative)
    if (hover) {
      const hs = hover.kind === 'pole' ? mPoles : mZeros
      const hn = hs[hover.index]
      if (hn) drawMark(cx(hn.re, hn.im), hover.kind, true)
    }
  }, [design, zSize, geom, toScreen, hover, mPoles, mZeros, zRef])

  // ------------------------------------------------------------------
  // response plots
  // ------------------------------------------------------------------
  const { ref: magRef, size: magSize } = useDprCanvas()
  const { ref: phRef, size: phSize } = useDprCanvas()
  const cutFrac = Math.min(1, cutoff / NYQ)
  const cutHiFrac = Math.min(1, cutoffHi / NYQ)

  useEffect(() => {
    const ctx = prepareContext(magRef.current, magSize)
    if (!ctx) return
    const { width: w, height: h } = magSize
    const r = { x: 0, y: 0, w, h }
    fillPlotBg(ctx, r)
    grid(ctx, r, 10, 6)
    const lo = -80
    const hi = 12
    // 0 dB line
    ctx.strokeStyle = 'rgba(154,166,212,0.35)'
    ctx.lineWidth = 1
    const y0 = r.h - ((0 - lo) / (hi - lo)) * r.h
    ctx.beginPath()
    ctx.moveTo(0, y0)
    ctx.lineTo(w, y0)
    ctx.stroke()
    seriesPlot(ctx, r, fr.magDb, lo, hi, '#5eead4', 2.4, 'rgba(94,234,212,0.10)')
    // cutoff markers
    vMarker(ctx, r, cutFrac, 'rgba(167,139,250,0.8)', `${Math.round(cutoff)}Hz`)
    if (response === 'band' || response === 'notch') vMarker(ctx, r, cutHiFrac, 'rgba(167,139,250,0.6)')
    // dB axis labels
    for (const db of [0, -20, -40, -60]) {
      const y = r.h - ((db - lo) / (hi - lo)) * r.h
      axisLabel(ctx, `${db}dB`, 6, y - 3, 'left')
    }
    axisLabel(ctx, `0`, 4, h - 6, 'left')
    axisLabel(ctx, `${NYQ} Hz`, w - 6, h - 6, 'right')
  }, [fr, magSize, magRef, cutFrac, cutHiFrac, response, cutoff])

  useEffect(() => {
    const ctx = prepareContext(phRef.current, phSize)
    if (!ctx) return
    const { width: w, height: h } = phSize
    const r = { x: 0, y: 0, w, h }
    fillPlotBg(ctx, r)
    grid(ctx, r, 10, 6)
    if (showGD) {
      // group delay (samples). Near transfer-function nulls the ratio spikes, so
      // scale from robust percentiles rather than the raw min/max.
      const g = Array.from(fr.groupDelay.slice(1)).sort((a, b) => a - b)
      const pct = (p: number) => g[Math.min(g.length - 1, Math.max(0, Math.floor(p * g.length)))]
      const gdLo = Math.min(0, pct(0.02))
      let gdHi = pct(0.98)
      if (gdHi - gdLo < 1) gdHi = gdLo + 1
      gdHi = gdLo + (gdHi - gdLo) * 1.18
      seriesPlot(ctx, r, fr.groupDelay, gdLo, gdHi, '#fbbf24', 2.2, 'rgba(251,191,36,0.08)')
      axisLabel(ctx, `group delay · ${gdLo.toFixed(0)}…${gdHi.toFixed(0)} samples`, 6, 14, 'left')
    } else {
      // unwrapped phase (radians)
      let lo = Infinity
      let hi = -Infinity
      for (const v of fr.phase) {
        lo = Math.min(lo, v)
        hi = Math.max(hi, v)
      }
      if (hi - lo < 1e-6) {
        hi = lo + 1
        lo -= 1
      }
      const pad = (hi - lo) * 0.08
      seriesPlot(ctx, r, fr.phase, lo - pad, hi + pad, '#f472b6', 2.2, 'rgba(244,114,182,0.08)')
      axisLabel(ctx, `phase · ${lo.toFixed(1)}…${hi.toFixed(1)} rad`, 6, 14, 'left')
    }
    vMarker(ctx, r, cutFrac, 'rgba(167,139,250,0.7)')
    axisLabel(ctx, `${NYQ} Hz`, w - 6, h - 6, 'right')
  }, [fr, phSize, phRef, showGD, cutFrac])

  // impulse + step
  const { ref: impRef, size: impSize } = useDprCanvas()
  useEffect(() => {
    const ctx = prepareContext(impRef.current, impSize)
    if (!ctx) return
    const { width: w, height: h } = impSize
    const r = { x: 0, y: 0, w, h }
    fillPlotBg(ctx, r)
    grid(ctx, r, 8, 4)
    // symmetric range from impulse+step
    let m = 1e-3
    for (const v of impulse) m = Math.max(m, Math.abs(v))
    for (const v of step) m = Math.max(m, Math.abs(v))
    const lo = -m * 1.1
    const hi = m * 1.1
    const y0 = r.h - ((0 - lo) / (hi - lo)) * r.h
    ctx.strokeStyle = 'rgba(154,166,212,0.3)'
    ctx.beginPath()
    ctx.moveTo(0, y0)
    ctx.lineTo(w, y0)
    ctx.stroke()
    // impulse as stems
    ctx.strokeStyle = '#38bdf8'
    ctx.lineWidth = 1.6
    impulse.forEach((v, i) => {
      const x = r.x + (i / (impulse.length - 1)) * r.w
      const y = r.h - ((v - lo) / (hi - lo)) * r.h
      ctx.beginPath()
      ctx.moveTo(x, y0)
      ctx.lineTo(x, y)
      ctx.stroke()
    })
    seriesPlot(ctx, r, step, lo, hi, '#5eead4', 2.2)
    axisLabel(ctx, 'impulse (stems)', 6, 14, 'left')
    axisLabel(ctx, 'step', w - 6, 14, 'right')
  }, [impulse, step, impSize, impRef])

  // ---- readouts ----
  const passN = Math.round(cutoff)
  const isBand = response === 'band' || response === 'notch'
  const rolloff = family === 'fir' ? '—' : `${design.order * 6} dB/oct`

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Design method">
          <Field label="Family">
            <Select value={family} options={FAMILIES} onChange={setFamily} />
          </Field>
          {family !== 'biquad' && family !== 'manual' && (
            <Field label="Response">
              <Segmented value={response} options={RESPONSES} onChange={setResponse} />
            </Field>
          )}
        </Panel>

        {(family === 'butter' || family === 'cheby1' || family === 'cheby2') && (
          <Panel title="Parameters">
            <Field label="Order" value={`${order}`}>
              <Slider min={1} max={10} step={1} value={order} onChange={(v) => setOrder(Math.round(v))} />
            </Field>
            <Field label={isBand ? 'Low edge' : 'Cutoff'} value={`${passN} Hz`}>
              <Slider min={10} max={NYQ - 10} step={1} value={cutoff} onChange={(v) => setCutoff(Math.round(v))} />
            </Field>
            {isBand && (
              <Field label="High edge" value={`${Math.round(cutoffHi)} Hz`}>
                <Slider min={10} max={NYQ - 5} step={1} value={cutoffHi} onChange={(v) => setCutoffHi(Math.round(v))} />
              </Field>
            )}
            {family === 'cheby1' && (
              <Field label="Passband ripple" value={`${rippleDb.toFixed(1)} dB`}>
                <Slider min={0.1} max={6} step={0.1} value={rippleDb} onChange={setRippleDb} />
              </Field>
            )}
            {family === 'cheby2' && (
              <Field label="Stopband atten." value={`${Math.round(stopDb)} dB`}>
                <Slider min={20} max={90} step={1} value={stopDb} onChange={(v) => setStopDb(Math.round(v))} />
              </Field>
            )}
          </Panel>
        )}

        {family === 'fir' && (
          <Panel title="FIR parameters">
            <Field label="Taps" value={`${(taps | 1)}`}>
              <Slider min={7} max={161} step={2} value={taps} onChange={(v) => setTaps(Math.round(v))} />
            </Field>
            <Field label={isBand ? 'Low edge' : 'Cutoff'} value={`${passN} Hz`}>
              <Slider min={10} max={NYQ - 10} step={1} value={cutoff} onChange={(v) => setCutoff(Math.round(v))} />
            </Field>
            {isBand && (
              <Field label="High edge" value={`${Math.round(cutoffHi)} Hz`}>
                <Slider min={10} max={NYQ - 5} step={1} value={cutoffHi} onChange={(v) => setCutoffHi(Math.round(v))} />
              </Field>
            )}
            <Field label="Window">
              <Select value={win} options={WINDOWS} onChange={setWin} />
            </Field>
          </Panel>
        )}

        {family === 'biquad' && (
          <Panel title="Biquad (RBJ)">
            <Field label="Type">
              <Select value={biquadType} options={BIQUAD_TYPES} onChange={setBiquadType} />
            </Field>
            <Field label="Frequency" value={`${passN} Hz`}>
              <Slider min={20} max={NYQ - 10} step={1} value={cutoff} onChange={(v) => setCutoff(Math.round(v))} />
            </Field>
            <Field label="Q" value={q.toFixed(2)}>
              <Slider min={0.2} max={12} step={0.05} value={q} onChange={setQ} />
            </Field>
            {(biquadType === 'peak' || biquadType === 'lowshelf' || biquadType === 'highshelf') && (
              <Field label="Gain" value={`${gainDb > 0 ? '+' : ''}${gainDb.toFixed(1)} dB`}>
                <Slider min={-24} max={24} step={0.5} value={gainDb} onChange={setGainDb} />
              </Field>
            )}
          </Panel>
        )}

        {family === 'manual' && (
          <Panel title="Manual z-plane">
            <p className="hint">
              Drag any <em>×</em> pole or <em>○</em> zero on the plane. Conjugate pairs mirror
              automatically. Double-click a mark to delete it. Keep poles <em>inside</em> the unit
              circle to stay stable.
            </p>
            <div className="btn-row">
              <Button onClick={() => setMPoles((p) => [...p, { re: 0.4, im: 0.4 }])}>+ pole pair</Button>
              <Button onClick={() => setMZeros((z) => [...z, { re: 0, im: 1 }])}>+ zero pair</Button>
            </div>
            <div className="btn-row">
              <Button variant="ghost" onClick={() => setMPoles((p) => [...p, { re: 0.5, im: 0 }])}>
                + real pole
              </Button>
              <Button variant="ghost" onClick={() => setMZeros((z) => [...z, { re: -0.5, im: 0 }])}>
                + real zero
              </Button>
            </div>
            <Field label="Overall gain" value={mGain.toFixed(2)}>
              <Slider min={0.05} max={4} step={0.05} value={mGain} onChange={setMGain} />
            </Field>
          </Panel>
        )}

        <Panel title="Filter">
          <Readout
            items={[
              { label: 'Order', value: `${design.order}` },
              { label: 'Type', value: design.kind.toUpperCase() },
              { label: 'Stable', value: design.stable ? 'yes' : 'NO' },
              { label: 'Poles', value: `${design.poles.length}` },
              { label: 'Zeros', value: `${design.zeros.length}` },
              { label: 'Roll-off', value: rolloff },
            ]}
          />
          {family !== 'manual' && (
            <Button variant="ghost" onClick={enterManual}>
              Edit on z-plane →
            </Button>
          )}
        </Panel>

        <Panel title="Listen (A / B)">
          <Field label="Test signal">
            <Select value={sig} options={SIGNALS} onChange={setSig} />
          </Field>
          <Field label="Added noise" value={noise.toFixed(2)}>
            <Slider min={0} max={0.5} step={0.01} value={noise} onChange={setNoise} />
          </Field>
          <div className="btn-row">
            <Button variant={playing === 'in' ? 'primary' : 'default'} onClick={() => toggle('in')}>
              {playing === 'in' ? '◼ Input' : '► Input'}
            </Button>
            <Button variant={playing === 'out' ? 'primary' : 'default'} onClick={() => toggle('out')}>
              {playing === 'out' ? '◼ Filtered' : '► Filtered'}
            </Button>
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
          A real <strong>digital filter designer</strong>. Pick a classic recipe — a maximally-flat{' '}
          <em>Butterworth</em>, a ripple-trading <em>Chebyshev</em>, a linear-phase <em>FIR</em>, or an
          audio <em>biquad</em> — and watch its poles (<span style={{ color: '#a78bfa' }}>×</span>) and
          zeros (<span style={{ color: '#38bdf8' }}>○</span>) land on the <strong>z-plane</strong>. Then{' '}
          <strong>drag them yourself</strong>: everything downstream — magnitude, phase, group delay,
          the impulse response, even the sound — recomputes live from the from-scratch bilinear
          transform. Poles inside the unit circle keep it stable.
        </p>

        <CanvasCard
          title="z-plane"
          note="drag poles × and zeros ○ · double-click to delete"
          aspect={1.35}
        >
          <canvas
            ref={zRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={onDoubleClick}
            style={{ cursor: hover ? 'grab' : 'crosshair' }}
          />
        </CanvasCard>

        <CanvasCard title="Magnitude response" note="|H(f)| in dB · cutoff marked" height={230}>
          <canvas ref={magRef} />
        </CanvasCard>

        <CanvasCard
          title={showGD ? 'Group delay' : 'Phase response'}
          note={
            <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
              <Toggle label="group delay" checked={showGD} onChange={setShowGD} />
            </span>
          }
          height={200}
        >
          <canvas ref={phRef} />
        </CanvasCard>

        <CanvasCard title="Impulse & step response" note="how the filter reacts in time" height={200}>
          <canvas ref={impRef} />
        </CanvasCard>
      </div>
    </div>
  )
}
