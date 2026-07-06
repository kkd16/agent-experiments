import { useEffect, useMemo, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Segmented, Toggle, Readout, Button } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import { fillPlotBg, grid, axisLabel } from '../lib/draw'
import type { Rect } from '../lib/draw'
import { readHashParams, shareLink, readNum, readStr, readBool } from '../lib/urlState'
import {
  SCHEMES,
  constellation,
  simulateLink,
  theoryBER,
  theorySER,
  berCurve,
  spectralEfficiency,
  mapBits,
  demapSymbols,
  randomBits,
  mulberry32,
  gaussian,
  ebn0ToSigma,
  type Scheme,
} from '../lib/comms'
import { shapeLink, eyeTraces } from '../lib/pulse'
import { fromReal } from '../lib/complex'
import { fft, nextPow2 } from '../lib/fft'
import {
  activeCarriers,
  modulate,
  demodulate,
  applyChannel,
  channelResponse,
  paprDb,
  addNoise,
  CHANNELS,
} from '../lib/ofdm'

const SCHEME_OPTIONS = SCHEMES.map((s) => ({ id: s.id, label: s.label }))

const TEAL = '#5eead4'
const BLUE = '#38bdf8'
const VIOLET = '#a78bfa'

// ---------------------------------------------------------------------------
// Shared drawing helpers
// ---------------------------------------------------------------------------

/** Draw a square I/Q scatter with axes, given a coordinate half-range. */
function iqFrame(ctx: CanvasRenderingContext2D, w: number, h: number, range: number) {
  const r: Rect = { x: 0, y: 0, w, h }
  fillPlotBg(ctx, r)
  const size = Math.min(w, h)
  const ox = w / 2
  const oy = h / 2
  const sc = (size / 2) * 0.86
  // grid rings
  ctx.strokeStyle = 'rgba(120,140,220,0.12)'
  ctx.lineWidth = 1
  for (let g = 1; g <= 3; g++) {
    ctx.beginPath()
    ctx.arc(ox, oy, (sc * g) / 3, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.strokeStyle = 'rgba(120,140,220,0.28)'
  ctx.beginPath()
  ctx.moveTo(ox - sc, oy)
  ctx.lineTo(ox + sc, oy)
  ctx.moveTo(ox, oy - sc)
  ctx.lineTo(ox, oy + sc)
  ctx.stroke()
  const map = (re: number, im: number): [number, number] => [ox + (re / range) * sc, oy - (im / range) * sc]
  return { map, ox, oy, sc }
}

// ---------------------------------------------------------------------------
// Single-carrier tab
// ---------------------------------------------------------------------------

function SingleCarrier({
  scheme,
  onScheme,
}: {
  scheme: Scheme
  onScheme: (s: Scheme) => void
}) {
  const sp = useMemo(() => readHashParams(), [])
  const [ebn0, setEbn0] = useState(() => readNum(sp, 'ebn0', 12))
  const [beta, setBeta] = useState(() => readNum(sp, 'beta', 0.35))
  const [copied, setCopied] = useState(false)

  const sps = 8
  const span = 6

  const { ref: constRef, size: constSize } = useDprCanvas()
  const { ref: eyeRef, size: eyeSize } = useDprCanvas()
  const { ref: specRef, size: specSize } = useDprCanvas()
  const { ref: berRef, size: berSize } = useDprCanvas()

  const info = useMemo(() => SCHEMES.find((s) => s.id === scheme)!, [scheme])
  const cons = useMemo(() => constellation(scheme), [scheme])

  // The link: symbol-domain AWGN model (matched-filter equivalent), used for the
  // constellation cloud and the measured BER/SER/EVM readouts.
  const link = useMemo(() => simulateLink(scheme, ebn0, 12000, 20250706), [scheme, ebn0])
  const thBer = useMemo(() => theoryBER(scheme, ebn0), [scheme, ebn0])
  const thSer = useMemo(() => theorySER(scheme, ebn0), [scheme, ebn0])

  // The pulse-shaped waveform: used for the eye diagram and the transmit spectrum.
  const shaped = useMemo(() => {
    const rng = mulberry32(99)
    const nSym = 220
    const bits = randomBits(nSym * info.bitsPerSymbol, rng)
    const sym = mapBits(bits, scheme)
    const sigma = ebn0ToSigma(ebn0, info.bitsPerSymbol)
    return { ...shapeLink(sym.re, sym.im, beta, sps, span, sigma, rng, gaussian), nSym }
  }, [scheme, ebn0, beta, info])

  // BER-vs-Eb/N0 sweep (measured + theory).
  const curve = useMemo(() => {
    const list: number[] = []
    for (let db = 0; db <= 16; db += 1) list.push(db)
    return berCurve(scheme, list, 20000, 4242)
  }, [scheme])

  const onShare = () => {
    shareLink('modem', { tab: 'single', scheme, ebn0, beta }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  // --- constellation scatter ---
  useEffect(() => {
    const ctx = prepareContext(constRef.current, constSize)
    if (!ctx) return
    const { width: w, height: h } = constSize
    const range = 1.6
    const { map } = iqFrame(ctx, w, h, range)
    // received cloud (subsample), colored by correctness
    const n = Math.min(link.rxRe.length, 2600)
    const stride = Math.max(1, Math.floor(link.rxRe.length / n))
    for (let i = 0; i < link.rxRe.length; i += stride) {
      const [x, y] = map(link.rxRe[i], link.rxIm[i])
      ctx.fillStyle = link.correct[i] ? 'rgba(94,234,212,0.5)' : 'rgba(251,113,133,0.85)'
      ctx.fillRect(x - 1, y - 1, 2, 2)
    }
    // ideal points
    for (const p of cons.points) {
      const [x, y] = map(p.re, p.im)
      ctx.fillStyle = '#eef1ff'
      ctx.strokeStyle = 'rgba(10,14,30,0.9)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(x, y, 3.4, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
    axisLabel(ctx, 'I', w - 12, h / 2 - 6, 'right')
    axisLabel(ctx, 'Q', w / 2 + 8, 14, 'left')
  }, [link, cons, constSize, constRef])

  // --- eye diagram (in-phase) ---
  useEffect(() => {
    const ctx = prepareContext(eyeRef.current, eyeSize)
    if (!ctx) return
    const { width: w, height: h } = eyeSize
    const r: Rect = { x: 0, y: 0, w, h }
    fillPlotBg(ctx, r)
    grid(ctx, r, 8, 4)
    // matched-filtered I channel, skip filter transient
    const sig = shaped.rx.re
    const traces = eyeTraces(sig, sps, 2, shaped.delay - sps / 2 + sps * 2)
    // vertical scale from robust max
    let amp = 0
    for (const tr of traces) for (const v of tr) amp = Math.max(amp, Math.abs(v))
    amp = amp * 1.1 || 1
    ctx.lineWidth = 1
    for (let t = 0; t < traces.length && t < 400; t++) {
      const tr = traces[t]
      ctx.strokeStyle = 'rgba(94,234,212,0.16)'
      ctx.beginPath()
      for (let i = 0; i < tr.length; i++) {
        const x = r.x + (i / (tr.length - 1)) * r.w
        const y = r.y + r.h / 2 - (tr[i] / amp) * (r.h / 2) * 0.92
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
    // decision instant (center) marker
    ctx.strokeStyle = 'rgba(167,139,250,0.7)'
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(w / 2, 0)
    ctx.lineTo(w / 2, h)
    ctx.stroke()
    ctx.setLineDash([])
    axisLabel(ctx, 'decision instant', w / 2 + 6, 16, 'left')
    axisLabel(ctx, 'one symbol ↔', 8, h - 8, 'left')
  }, [shaped, eyeSize, eyeRef])

  // --- transmit spectrum (PSD of the shaped waveform) ---
  useEffect(() => {
    const ctx = prepareContext(specRef.current, specSize)
    if (!ctx) return
    const { width: w, height: h } = specSize
    const r: Rect = { x: 0, y: 0, w, h }
    fillPlotBg(ctx, r)
    grid(ctx, r, 8, 4)
    const tx = shaped.tx
    const N = nextPow2(Math.min(tx.re.length, 4096))
    const buf = new Float64Array(N)
    // Hann window over the available samples for a clean estimate.
    const avail = Math.min(tx.re.length, N)
    for (let i = 0; i < avail; i++) {
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (avail - 1))
      buf[i] = tx.re[i] * win
    }
    const F = fft(fromReal(buf))
    // fftshift magnitude in dB, x-axis in cycles/symbol (normalized freq × sps).
    const mag = new Float64Array(N)
    let mx = -Infinity
    for (let k = 0; k < N; k++) {
      const p = F.re[k] * F.re[k] + F.im[k] * F.im[k]
      const db = 10 * Math.log10(p + 1e-12)
      mag[k] = db
      if (db > mx) mx = db
    }
    const floor = mx - 60
    ctx.strokeStyle = TEAL
    ctx.lineWidth = 1.6
    ctx.beginPath()
    for (let i = 0; i < N; i++) {
      const k = (i + Math.ceil(N / 2)) % N // fftshift
      // normalized freq f in [-0.5,0.5) cycles/sample → cycles/symbol = f*sps
      const f = (i - N / 2) / N
      const fSym = f * sps
      const x = r.x + ((fSym + sps / 2) / sps) * r.w
      const t = (mag[k] - floor) / (mx - floor)
      const y = r.y + r.h - Math.max(0, Math.min(1, t)) * r.h * 0.94 - r.h * 0.03
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
    // mark the Nyquist band edges ±(1+β)/2 cycles/symbol
    const edge = (1 + beta) / 2
    ctx.strokeStyle = 'rgba(167,139,250,0.65)'
    ctx.setLineDash([5, 4])
    for (const s of [-edge, edge]) {
      const x = r.x + ((s + sps / 2) / sps) * r.w
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
    }
    ctx.setLineDash([])
    axisLabel(ctx, `bandwidth ±(1+β)/2 = ±${edge.toFixed(2)}/T`, 8, 16, 'left')
    axisLabel(ctx, 'frequency (cycles/symbol) →', w - 8, h - 8, 'right')
  }, [shaped, beta, specSize, specRef])

  // --- BER curve ---
  useEffect(() => {
    const ctx = prepareContext(berRef.current, berSize)
    if (!ctx) return
    const { width: w, height: h } = berSize
    const pad = { l: 44, r: 12, t: 14, b: 26 }
    const r: Rect = { x: pad.l, y: pad.t, w: w - pad.l - pad.r, h: h - pad.t - pad.b }
    fillPlotBg(ctx, { x: 0, y: 0, w, h })
    // log-y from 1 to 1e-6
    const topExp = 0
    const botExp = -6
    const xmin = 0
    const xmax = 16
    const X = (db: number) => r.x + ((db - xmin) / (xmax - xmin)) * r.w
    const Y = (ber: number) => {
      const e = Math.log10(Math.max(ber, 1e-7))
      const t = (e - topExp) / (botExp - topExp)
      return r.y + Math.max(0, Math.min(1, t)) * r.h
    }
    // grid + decade labels
    ctx.strokeStyle = 'rgba(120,140,220,0.12)'
    ctx.lineWidth = 1
    for (let e = topExp; e >= botExp; e--) {
      const y = Y(Math.pow(10, e))
      ctx.beginPath()
      ctx.moveTo(r.x, y)
      ctx.lineTo(r.x + r.w, y)
      ctx.stroke()
      axisLabel(ctx, e === 0 ? '1' : `1e${e}`, r.x - 6, y + 3, 'right')
    }
    for (let db = xmin; db <= xmax; db += 4) {
      const x = X(db)
      ctx.beginPath()
      ctx.moveTo(x, r.y)
      ctx.lineTo(x, r.y + r.h)
      ctx.stroke()
      axisLabel(ctx, `${db}`, x, r.y + r.h + 16, 'center')
    }
    // theory line
    ctx.strokeStyle = VIOLET
    ctx.lineWidth = 2
    ctx.beginPath()
    let started = false
    for (let db = xmin; db <= xmax; db += 0.25) {
      const y = Y(theoryBER(scheme, db))
      const x = X(db)
      if (!started) {
        ctx.moveTo(x, y)
        started = true
      } else ctx.lineTo(x, y)
    }
    ctx.stroke()
    // measured points
    ctx.fillStyle = TEAL
    for (const p of curve) {
      if (p.measured <= 0) continue
      const x = X(p.ebn0Db)
      const y = Y(p.measured)
      ctx.beginPath()
      ctx.arc(x, y, 3, 0, Math.PI * 2)
      ctx.fill()
    }
    // current operating point
    const cx = X(ebn0)
    ctx.strokeStyle = 'rgba(56,189,248,0.6)'
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(cx, r.y)
    ctx.lineTo(cx, r.y + r.h)
    ctx.stroke()
    ctx.setLineDash([])
    axisLabel(ctx, 'Eb/N0 (dB) →', r.x + r.w, r.y + r.h + 16, 'right')
    axisLabel(ctx, 'BER', r.x, r.y - 2, 'left')
    // legend
    ctx.fillStyle = VIOLET
    ctx.fillRect(r.x + r.w - 150, r.y + 6, 14, 3)
    axisLabel(ctx, 'theory', r.x + r.w - 132, r.y + 10, 'left')
    ctx.fillStyle = TEAL
    ctx.beginPath()
    ctx.arc(r.x + r.w - 70, r.y + 8, 3, 0, Math.PI * 2)
    ctx.fill()
    axisLabel(ctx, 'measured', r.x + r.w - 62, r.y + 10, 'left')
  }, [curve, scheme, ebn0, berSize, berRef])

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Modulation">
          <Field label="Scheme">
            <Select value={scheme} options={SCHEME_OPTIONS} onChange={onScheme} />
          </Field>
          <Field label="Eb/N0" value={`${ebn0.toFixed(1)} dB`}>
            <Slider min={0} max={20} step={0.5} value={ebn0} onChange={setEbn0} />
          </Field>
          <Field label="Roll-off β" value={beta.toFixed(2)}>
            <Slider min={0.05} max={1} step={0.05} value={beta} onChange={(v) => setBeta(Math.round(v * 100) / 100)} />
          </Field>
          <div className="btn-row">
            <Button variant="ghost" onClick={onShare}>
              {copied ? 'Copied ✓' : 'Copy link'}
            </Button>
          </div>
          <p className="hint">
            <strong>Eb/N0</strong> is energy-per-bit over noise density — the fair way to compare
            schemes. <strong>β</strong> sets the excess bandwidth of the root-raised-cosine pulse.
          </p>
        </Panel>

        <Panel title="Link quality">
          <Readout
            items={[
              { label: 'BER (measured)', value: link.ber > 0 ? link.ber.toExponential(2) : `<${(1 / link.nBits).toExponential(1)}` },
              { label: 'BER (theory)', value: thBer.toExponential(2) },
              { label: 'SER (measured)', value: link.ser > 0 ? link.ser.toExponential(2) : '0' },
              { label: 'SER (theory)', value: thSer.toExponential(2) },
              { label: 'EVM (rms)', value: `${link.evmPct.toFixed(1)}%` },
              { label: 'Efficiency', value: `${spectralEfficiency(scheme, beta).toFixed(2)} b/s/Hz` },
            ]}
          />
          <p className="hint">
            {link.bitErrors} bit errors in {link.nBits.toLocaleString()} bits. The measured cloud and
            error rate should hug the closed-form theory — that agreement <em>is</em> the validation.
          </p>
        </Panel>
      </div>

      <div className="mode-main">
        <p className="mode-intro">
          A digital radio turns bits into complex <strong>symbols</strong> from a constellation, shapes
          them with a bandlimited pulse, and ships them through noise. Here the from-scratch link runs
          live: watch the received cloud tighten as you raise Eb/N0, the <strong>eye</strong> open as the
          root-raised-cosine kills inter-symbol interference, and the measured bit-error rate fall exactly
          along the theoretical curve.
        </p>
        <div className="tomo-grid">
          <CanvasCard title="Constellation (received)" note="green = correct · red = symbol error" aspect={1}>
            <canvas ref={constRef} />
          </CanvasCard>
          <CanvasCard title="Eye diagram (I)" note="matched-filter output, overlaid per symbol" aspect={1}>
            <canvas ref={eyeRef} />
          </CanvasCard>
        </div>
        <CanvasCard title="Transmit spectrum" note="root-raised-cosine bandlimiting" height={200}>
          <canvas ref={specRef} />
        </CanvasCard>
        <CanvasCard title="Bit-error rate vs Eb/N0" note="measured Monte-Carlo vs closed form" height={240}>
          <canvas ref={berRef} />
        </CanvasCard>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// OFDM tab
// ---------------------------------------------------------------------------

function Ofdm({ scheme, onScheme }: { scheme: Scheme; onScheme: (s: Scheme) => void }) {
  const sp = useMemo(() => readHashParams(), [])
  const [nfftStr, setNfft] = useState<'64' | '128' | '256'>(() => readStr(sp, 'nfft', '128', ['64', '128', '256'] as const))
  const [cpLen, setCpLen] = useState(() => readNum(sp, 'cp', 16))
  const [channelId, setChannelId] = useState(() => readStr(sp, 'ch', 'multipath', CHANNELS.map((c) => c.id)))
  const [snr, setSnr] = useState(() => readNum(sp, 'snr', 22))
  const [equalize, setEqualize] = useState(() => readBool(sp, 'eq', true))
  const [copied, setCopied] = useState(false)

  const nfft = Number(nfftStr)
  const guard = Math.max(2, Math.round(nfft / 16))

  const { ref: constRef, size: constSize } = useDprCanvas()
  const { ref: chanRef, size: chanSize } = useDprCanvas()
  const { ref: waveRef, size: waveSize } = useDprCanvas()

  const info = useMemo(() => SCHEMES.find((s) => s.id === scheme)!, [scheme])
  const channel = useMemo(() => CHANNELS.find((c) => c.id === channelId)!, [channelId])

  const result = useMemo(() => {
    const active = activeCarriers(nfft, guard)
    const cfg = { nfft, cpLen, active }
    const nBlocks = 6
    const nActive = active.length
    const rng = mulberry32(20250706)
    const bits = randomBits(nActive * nBlocks * info.bitsPerSymbol, rng)
    const sym = mapBits(bits, scheme)
    const tx = modulate(sym.re, sym.im, cfg)
    const rxClean = applyChannel(tx, channel.hRe, channel.hIm)
    // noise: set σ from the received sample power and the SNR (dB).
    let psig = 0
    for (let i = 0; i < rxClean.length; i++) psig += rxClean.re[i] * rxClean.re[i] + rxClean.im[i] * rxClean.im[i]
    psig /= rxClean.length
    const snrLin = Math.pow(10, snr / 10)
    const sigma = Math.sqrt(psig / (2 * snrLin))
    const rx = sigma > 0 ? addNoise({ re: rxClean.re, im: rxClean.im, length: rxClean.length }, sigma, rng, gaussian) : { re: rxClean.re, im: rxClean.im, length: rxClean.length }
    const H = channelResponse(channel.hRe, channel.hIm, nfft)
    const dem = demodulate(rx, cfg, equalize ? H : undefined)
    // BER on the equalized (or raw) symbols
    const rxBits = demapSymbols(dem.symRe, dem.symIm, scheme)
    let bitErrors = 0
    for (let i = 0; i < bits.length && i < rxBits.length; i++) if (bits[i] !== rxBits[i]) bitErrors++
    // EVM vs sent symbols
    let errPow = 0
    for (let i = 0; i < sym.length; i++) {
      const dr = dem.symRe[i] - sym.re[i]
      const di = dem.symIm[i] - sym.im[i]
      errPow += dr * dr + di * di
    }
    const evmPct = Math.sqrt(errPow / sym.length) * 100
    // one OFDM symbol time-domain magnitude for the wave view
    const symLen = nfft + cpLen
    const waveMag = new Float64Array(symLen)
    for (let i = 0; i < symLen; i++) waveMag[i] = Math.hypot(tx.re[i], tx.im[i])
    return {
      cfg,
      active,
      H,
      dem,
      sym,
      bitErrors,
      nBits: bits.length,
      ber: bitErrors / bits.length,
      evmPct,
      papr: paprDb({ re: tx.re.subarray(0, symLen), im: tx.im.subarray(0, symLen), length: symLen }),
      waveMag,
      symLen,
    }
  }, [nfft, cpLen, snr, equalize, scheme, info, channel, guard])

  const onShare = () => {
    shareLink('modem', { tab: 'ofdm', scheme, nfft: nfftStr, cp: cpLen, ch: channelId, snr, eq: equalize }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  // --- received constellation ---
  useEffect(() => {
    const ctx = prepareContext(constRef.current, constSize)
    if (!ctx) return
    const { width: w, height: h } = constSize
    const cons = constellation(scheme)
    const { map } = iqFrame(ctx, w, h, 1.7)
    const n = result.dem.symRe.length
    for (let i = 0; i < n; i++) {
      const [x, y] = map(result.dem.symRe[i], result.dem.symIm[i])
      ctx.fillStyle = 'rgba(56,189,248,0.6)'
      ctx.fillRect(x - 1.3, y - 1.3, 2.6, 2.6)
    }
    for (const p of cons.points) {
      const [x, y] = map(p.re, p.im)
      ctx.fillStyle = '#eef1ff'
      ctx.strokeStyle = 'rgba(10,14,30,0.9)'
      ctx.lineWidth = 1.3
      ctx.beginPath()
      ctx.arc(x, y, 3, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
    axisLabel(ctx, equalize ? 'equalized' : 'no equalizer', 10, 16, 'left')
  }, [result, scheme, equalize, constSize, constRef])

  // --- channel frequency response ---
  useEffect(() => {
    const ctx = prepareContext(chanRef.current, chanSize)
    if (!ctx) return
    const { width: w, height: h } = chanSize
    const r: Rect = { x: 0, y: 0, w, h }
    fillPlotBg(ctx, r)
    grid(ctx, r, 8, 4)
    const H = result.H
    // |H(k)| over subcarriers (fftshifted so DC is centered)
    let mx = 0
    const mag = new Float64Array(nfft)
    for (let k = 0; k < nfft; k++) {
      mag[k] = Math.hypot(H.re[k], H.im[k])
      if (mag[k] > mx) mx = mx > mag[k] ? mx : mag[k]
    }
    mx = mx * 1.1 || 1
    // active carrier band shading
    const activeSet = new Set(result.active)
    ctx.fillStyle = 'rgba(94,234,212,0.06)'
    for (let i = 0; i < nfft; i++) {
      const k = (i + Math.ceil(nfft / 2)) % nfft
      if (activeSet.has(k)) {
        const x = r.x + (i / nfft) * r.w
        ctx.fillRect(x, 0, r.w / nfft + 1, h)
      }
    }
    ctx.strokeStyle = BLUE
    ctx.lineWidth = 1.8
    ctx.beginPath()
    for (let i = 0; i < nfft; i++) {
      const k = (i + Math.ceil(nfft / 2)) % nfft
      const x = r.x + (i / (nfft - 1)) * r.w
      const y = r.y + r.h - (mag[k] / mx) * r.h * 0.9 - r.h * 0.05
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
    axisLabel(ctx, '|H(f)| across subcarriers', 8, 16, 'left')
    axisLabel(ctx, 'teal band = data carriers', 8, h - 8, 'left')
    axisLabel(ctx, 'frequency →', w - 8, h - 8, 'right')
  }, [result, nfft, chanSize, chanRef])

  // --- time-domain OFDM symbol with CP ---
  useEffect(() => {
    const ctx = prepareContext(waveRef.current, waveSize)
    if (!ctx) return
    const { width: w, height: h } = waveSize
    const r: Rect = { x: 0, y: 0, w, h }
    fillPlotBg(ctx, r)
    grid(ctx, r, 8, 4)
    const mag = result.waveMag
    const symLen = result.symLen
    let mx = 0
    for (let i = 0; i < mag.length; i++) mx = Math.max(mx, mag[i])
    mx = mx * 1.1 || 1
    // highlight the CP region
    const cpFrac = cpLen / symLen
    ctx.fillStyle = 'rgba(251,191,36,0.12)'
    ctx.fillRect(r.x, r.y, r.w * cpFrac, r.h)
    // and the copied tail it duplicates
    ctx.fillStyle = 'rgba(251,191,36,0.06)'
    ctx.fillRect(r.x + r.w * (1 - cpFrac), r.y, r.w * cpFrac, r.h)
    ctx.strokeStyle = TEAL
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let i = 0; i < symLen; i++) {
      const x = r.x + (i / (symLen - 1)) * r.w
      const y = r.y + r.h - (mag[i] / mx) * r.h * 0.9 - r.h * 0.05
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
    axisLabel(ctx, 'cyclic prefix', 6, 16, 'left')
    axisLabel(ctx, '= copy of the tail →', r.x + r.w * (1 - cpFrac) + 4, 16, 'left')
    axisLabel(ctx, `|x[n]|  ·  PAPR ${result.papr.toFixed(1)} dB`, w - 8, h - 8, 'right')
  }, [result, cpLen, waveSize, waveRef])

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="OFDM system">
          <Field label="Scheme (per carrier)">
            <Select value={scheme} options={SCHEME_OPTIONS} onChange={onScheme} />
          </Field>
          <Field label="Subcarriers (FFT)">
            <Select
              value={nfftStr}
              options={[
                { id: '64', label: '64' },
                { id: '128', label: '128' },
                { id: '256', label: '256' },
              ]}
              onChange={setNfft}
            />
          </Field>
          <Field label="Cyclic prefix" value={`${cpLen} samp`}>
            <Slider min={0} max={Math.round(nfft / 2)} step={1} value={Math.min(cpLen, Math.round(nfft / 2))} onChange={(v) => setCpLen(Math.round(v))} />
          </Field>
          <Field label="Channel">
            <Select value={channelId} options={CHANNELS.map((c) => ({ id: c.id, label: c.label }))} onChange={setChannelId} />
          </Field>
          <Field label="SNR" value={`${snr.toFixed(0)} dB`}>
            <Slider min={4} max={40} step={1} value={snr} onChange={(v) => setSnr(Math.round(v))} />
          </Field>
          <Toggle label="Zero-forcing equalizer" checked={equalize} onChange={setEqualize} />
          <div className="btn-row">
            <Button variant="ghost" onClick={onShare}>
              {copied ? 'Copied ✓' : 'Copy link'}
            </Button>
          </div>
        </Panel>

        <Panel title="Link">
          <Readout
            items={[
              { label: 'Data carriers', value: `${result.active.length} / ${nfft}` },
              { label: 'CP overhead', value: `${((cpLen / result.symLen) * 100).toFixed(0)}%` },
              { label: 'PAPR', value: `${result.papr.toFixed(1)} dB` },
              { label: 'BER', value: result.ber > 0 ? result.ber.toExponential(2) : `<${(1 / result.nBits).toExponential(1)}` },
              { label: 'EVM (rms)', value: `${result.evmPct.toFixed(1)}%` },
              { label: 'Channel taps', value: `${channel.hRe.length}` },
            ]}
          />
          <p className="hint">
            Turn the equalizer <strong>off</strong> over a multipath channel and the constellation
            smears — each subcarrier is rotated and scaled by its own <em>H(f)</em>. Turn it back on
            and one complex division per carrier snaps every point home. Shrink the cyclic prefix
            below the channel's delay spread and ISI leaks back in.
          </p>
        </Panel>
      </div>

      <div className="mode-main">
        <p className="mode-intro">
          <strong>OFDM</strong> is why the FFT runs the modern world: Wi-Fi, 4G/5G and DVB all carry data on
          hundreds of orthogonal subcarriers built by an <strong>IFFT</strong>. A <strong>cyclic prefix</strong>{' '}
          turns the channel's messy echoes into a plain circular convolution, so after the receiver's FFT every
          subcarrier is just multiplied by one complex number — trivially undone. Watch a frequency-selective
          channel dissolve into flat, independent tones.
        </p>
        <div className="tomo-grid">
          <CanvasCard title="Received constellation" note="all data subcarriers, one cloud" aspect={1}>
            <canvas ref={constRef} />
          </CanvasCard>
          <CanvasCard title="Channel response |H(f)|" note="the frequency-selective fading" aspect={1}>
            <canvas ref={chanRef} />
          </CanvasCard>
        </div>
        <CanvasCard title="One OFDM symbol in time" note="cyclic prefix guards against echoes" height={200}>
          <canvas ref={waveRef} />
        </CanvasCard>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

export default function Modem() {
  const sp = useMemo(() => readHashParams(), [])
  const [tab, setTab] = useState<'single' | 'ofdm'>(() => readStr(sp, 'tab', 'single', ['single', 'ofdm'] as const))
  const [scheme, setScheme] = useState<Scheme>(() => readStr(sp, 'scheme', 'qam16', SCHEMES.map((s) => s.id)))

  return (
    <div className="mode-wrap">
      <div className="mode-tabs">
        <Segmented
          value={tab}
          options={[
            { id: 'single', label: 'Single-carrier' },
            { id: 'ofdm', label: 'OFDM (multicarrier)' },
          ]}
          onChange={setTab}
        />
      </div>
      {tab === 'single' ? (
        <SingleCarrier scheme={scheme} onScheme={setScheme} />
      ) : (
        <Ofdm scheme={scheme} onScheme={setScheme} />
      )}
    </div>
  )
}
