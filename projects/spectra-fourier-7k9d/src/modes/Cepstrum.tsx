import { useEffect, useMemo, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Readout, Button } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import { WINDOWS } from '../lib/dsp'
import type { WindowName } from '../lib/dsp'
import { voicedSignal, pulseTrain, VOWELS } from '../lib/synth'
import { cepstrum, autocorrPitch } from '../lib/cepstrum'
import { fillPlotBg, grid, axisLabel } from '../lib/draw'
import type { Rect } from '../lib/draw'
import { audio } from '../lib/audio'
import { readHashParams, shareLink, readNum, readStr } from '../lib/urlState'

const FS = 8000

type SourceId = 'ah' | 'ee' | 'oo' | 'oh' | 'pulse'

const SOURCES: { id: SourceId; label: string }[] = [
  { id: 'ah', label: 'Voice “ah”' },
  { id: 'ee', label: 'Voice “ee”' },
  { id: 'oo', label: 'Voice “oo”' },
  { id: 'oh', label: 'Voice “oh”' },
  { id: 'pulse', label: 'Pulse train (bare pitch)' },
]

type FftId = '1024' | '2048' | '4096'

const FFT_SIZES: { id: FftId; label: string }[] = [
  { id: '2048', label: '2048' },
  { id: '4096', label: '4096' },
  { id: '1024', label: '1024' },
]

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']

function noteName(freq: number): string {
  if (freq <= 0) return '—'
  const midi = 69 + 12 * Math.log2(freq / 440)
  const rounded = Math.round(midi)
  const cents = Math.round((midi - rounded) * 100)
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12]
  const octave = Math.floor(rounded / 12) - 1
  const sign = cents >= 0 ? '+' : '−'
  return `${name}${octave} ${sign}${Math.abs(cents)}¢`
}

function buildSource(id: SourceId, f0: number, n: number): Float64Array {
  if (id === 'pulse') return pulseTrain(n, Math.round(FS / f0), 40)
  const vowel = VOWELS.find((v) => v.id === id)!
  return voicedSignal(n, { f0, fs: FS, formants: vowel.formants })
}

// A line plot with an explicit [lo,hi] vertical range (log-magnitude can be < 0).
function rangePlot(ctx: CanvasRenderingContext2D, r: Rect, data: ArrayLike<number>, lo: number, hi: number, color: string, lw = 2) {
  const n = data.length
  if (n < 2 || hi <= lo) return
  ctx.strokeStyle = color
  ctx.lineWidth = lw
  ctx.lineJoin = 'round'
  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const x = r.x + (i / (n - 1)) * r.w
    const t = (data[i] - lo) / (hi - lo)
    const y = r.y + r.h - Math.max(0, Math.min(1, t)) * r.h * 0.96 - r.h * 0.02
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
}

export default function Cepstrum() {
  const sp = useMemo(() => readHashParams(), [])
  const [source, setSource] = useState<SourceId>(() => readStr<SourceId>(sp, 'src', 'ah', SOURCES.map((s) => s.id)))
  const [f0, setF0] = useState(() => readNum(sp, 'f0', 140))
  const [fftStr, setFftStr] = useState<FftId>(() =>
    readStr<FftId>(sp, 'fft', '2048', FFT_SIZES.map((s) => s.id)),
  )
  const [lifter, setLifter] = useState(() => readNum(sp, 'lift', 26))
  const [win, setWin] = useState<WindowName>(() => readStr<WindowName>(sp, 'win', 'hann', WINDOWS.map((w) => w.id)))
  const [playing, setPlaying] = useState(false)
  const [copied, setCopied] = useState(false)

  const fftSize = Number(fftStr)

  const { ref: specRef, size: specSize } = useDprCanvas()
  const { ref: cepRef, size: cepSize } = useDprCanvas()

  const frame = useMemo(() => buildSource(source, f0, fftSize), [source, f0, fftSize])
  const result = useMemo(
    () => cepstrum(frame, { fftSize, fs: FS, window: win, lifterCutoff: lifter, minF: 60, maxF: 500 }),
    [frame, fftSize, win, lifter],
  )
  const acPitch = useMemo(() => autocorrPitch(frame, FS, 60, 500), [frame])

  useEffect(() => {
    if (!playing) {
      audio.stop()
      return
    }
    audio.playSignal(frame, { sampleRate: FS, gain: 0.85, loop: true })
  }, [playing, frame])
  useEffect(() => () => audio.stop(), [])

  const onShare = () => {
    shareLink('cepstrum', { src: source, f0, fft: fftStr, lift: lifter, win }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  // Log-magnitude spectrum with the liftered formant envelope overlaid.
  useEffect(() => {
    const ctx = prepareContext(specRef.current, specSize)
    if (!ctx) return
    const { width: w, height: h } = specSize
    const r: Rect = { x: 0, y: 0, w, h }
    fillPlotBg(ctx, r)
    grid(ctx, r, 8, 4)
    // Show the lower ~half of the band (formants live low); Nyquist = FS/2.
    const showBins = Math.floor(result.bins * 0.6)
    const spec = result.logMag.subarray(0, showBins)
    const env = result.envelopeLogMag.subarray(0, showBins)
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < showBins; i++) {
      lo = Math.min(lo, spec[i], env[i])
      hi = Math.max(hi, spec[i], env[i])
    }
    rangePlot(ctx, r, spec, lo, hi, 'rgba(94,234,212,0.55)', 1.3)
    rangePlot(ctx, r, env, lo, hi, '#f0a3c8', 2.4)
    // Frequency ticks.
    const nyq = FS / 2
    for (const f of [0, 500, 1000, 1500, 2000, 2500]) {
      const frac = f / nyq / 0.6
      if (frac > 1) continue
      axisLabel(ctx, `${f}`, Math.min(w - 4, Math.max(12, frac * w)), h - 6, 'center')
    }
    axisLabel(ctx, 'Hz →', w - 8, 14, 'right')
    axisLabel(ctx, 'log |X|', 6, 14, 'left')
    axisLabel(ctx, 'formant envelope', 6, 28, 'left')
  }, [result, specSize, specRef])

  // Cepstrum (quefrency) with the pitch search band + detected peak marked.
  useEffect(() => {
    const ctx = prepareContext(cepRef.current, cepSize)
    if (!ctx) return
    const { width: w, height: h } = cepSize
    const r: Rect = { x: 0, y: 0, w, h }
    fillPlotBg(ctx, r)
    grid(ctx, r, 8, 4)
    // Display quefrency 0..maxQ*1.4 (skip the tall q=0 term which is just overall gain).
    const qMax = Math.min(result.cepstrum.length - 1, Math.floor(result.maxQ * 1.5))
    const disp = result.cepstrum.subarray(1, qMax)
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < disp.length; i++) {
      lo = Math.min(lo, disp[i])
      hi = Math.max(hi, disp[i])
    }
    // Shade the pitch search band.
    const qToX = (q: number) => ((q - 1) / (qMax - 1)) * w
    ctx.fillStyle = 'rgba(56,189,248,0.10)'
    ctx.fillRect(qToX(result.minQ), 0, qToX(result.maxQ) - qToX(result.minQ), h)
    rangePlot(ctx, r, disp, lo, hi, '#a78bfa', 1.6)
    // Mark the detected peak.
    if (result.pitchQuefrency > 0) {
      const x = qToX(result.pitchQuefrency)
      ctx.strokeStyle = '#5eead4'
      ctx.lineWidth = 1.6
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
      ctx.setLineDash([])
      axisLabel(ctx, `q=${result.pitchQuefrency.toFixed(1)} → ${result.pitchHz.toFixed(0)} Hz`, Math.min(w - 6, x + 6), 16, 'left')
    }
    axisLabel(ctx, 'quefrency (samples) →', w - 8, h - 6, 'right')
    axisLabel(ctx, 'search band', qToX(result.minQ) + 4, h - 6, 'left')
  }, [result, cepSize, cepRef])

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Source">
          <Field label="Sound">
            <Select value={source} options={SOURCES} onChange={setSource} />
          </Field>
          <Field label="Fundamental f₀" value={`${f0} Hz`}>
            <Slider min={70} max={330} step={1} value={f0} onChange={(v) => setF0(Math.round(v))} />
          </Field>
          <div className="btn-row">
            <Button variant={playing ? 'default' : 'primary'} onClick={() => setPlaying((p) => !p)}>
              {playing ? '◼ Stop' : '► Play'}
            </Button>
            <Button variant="ghost" onClick={onShare}>
              {copied ? 'Copied ✓' : 'Copy link'}
            </Button>
          </div>
        </Panel>

        <Panel title="Analysis">
          <Field label="FFT size">
            <Select value={fftStr} options={FFT_SIZES} onChange={setFftStr} />
          </Field>
          <Field label="Window">
            <Select value={win} options={WINDOWS} onChange={setWin} />
          </Field>
          <Field label="Lifter cutoff" value={`${lifter} q`}>
            <Slider min={4} max={80} step={1} value={lifter} onChange={(v) => setLifter(Math.round(v))} />
          </Field>
          <p className="hint">
            The lifter cutoff is the quefrency where we cut the cepstrum: keep below it and you get
            the smooth formant envelope; above it lives the pitch ripple.
          </p>
        </Panel>

        <Panel title="Pitch estimate">
          <Readout
            items={[
              { label: 'Cepstral', value: result.pitchHz > 0 ? `${result.pitchHz.toFixed(1)} Hz` : 'unvoiced' },
              { label: 'Autocorr', value: acPitch > 0 ? `${acPitch.toFixed(1)} Hz` : 'unvoiced' },
              { label: 'Note', value: noteName(result.pitchHz) },
            ]}
          />
          <p className="hint">
            Two independent detectors — a peak in the cepstrum and a peak in the autocorrelation —
            should agree. Set f₀ and see both track it.
          </p>
        </Panel>
      </div>

      <div className="mode-main">
        <p className="mode-intro">
          Take the <strong>log</strong> of a spectrum and a voiced sound splits into a sum: a slow,
          smooth <strong>formant envelope</strong> (the vocal tract) plus a fast ripple whose spacing
          <em> is</em> the pitch. Fourier-transform that log-spectrum and the two land at different
          <strong> quefrencies</strong> — the pitch as a sharp peak, the formants near zero. That is
          the <strong>cepstrum</strong>, and it is how a computer hears pitch through timbre.
        </p>
        <CanvasCard title="Log-magnitude spectrum + formant envelope" note="envelope = low-quefrency lifter" height={240}>
          <canvas ref={specRef} />
        </CanvasCard>
        <CanvasCard title="Cepstrum" note="pitch = tallest peak in the search band" height={240}>
          <canvas ref={cepRef} />
        </CanvasCard>
      </div>
    </div>
  )
}
