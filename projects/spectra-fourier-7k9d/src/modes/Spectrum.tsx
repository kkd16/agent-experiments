import { useEffect, useMemo, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Segmented, Toggle, Readout, Button } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import {
  SIGNALS,
  WINDOWS,
  generateSignal,
  additiveSignal,
  windowFn,
  applyWindow,
  peak,
} from '../lib/dsp'
import type { SignalName, WindowName, Partial } from '../lib/dsp'
import { rfft } from '../lib/fft'
import { magnitude, phase } from '../lib/complex'
import { fillPlotBg, grid, zeroLine, linePlot, areaPlot, axisLabel } from '../lib/draw'
import { audio } from '../lib/audio'
import { readHashParams, shareLink, readNum, readStr, readBool } from '../lib/urlState'

// Playback sample rate lifts the abstract bin-frequency into the audible band
// (bin k ≈ k·AUDIO_SR/N Hz), so dragging Frequency tracks an audible pitch.
const AUDIO_SR = 8000

const N = 1024
const FS = 1024 // sample rate; makes bin k ≈ k Hz
const HALF = N / 2
type SigSource = 'test' | 'additive'

const DEFAULT_PARTIALS: number[] = [1, 0, 0.5, 0, 0.33, 0, 0.25, 0]

export default function Spectrum() {
  const sp = useMemo(() => readHashParams(), [])
  const [sigSource, setSigSource] = useState<SigSource>(() =>
    readStr<SigSource>(sp, 'src', 'test', ['test', 'additive']),
  )
  const [signal, setSignal] = useState<SignalName>(() =>
    readStr<SignalName>(sp, 'sig', 'square', SIGNALS.map((s) => s.id)),
  )
  const [freq, setFreq] = useState(() => readNum(sp, 'freq', 24))
  const [noise, setNoise] = useState(() => readNum(sp, 'noise', 0))
  const [win, setWin] = useState<WindowName>(() =>
    readStr<WindowName>(sp, 'win', 'hann', WINDOWS.map((w) => w.id)),
  )
  const [db, setDb] = useState(() => readBool(sp, 'db', false))
  const [amps, setAmps] = useState<number[]>(() => {
    const a = sp.get('amps')
    if (!a) return DEFAULT_PARTIALS
    const arr = a.split(',').map(Number).filter((x) => Number.isFinite(x))
    return arr.length >= 4 ? arr : DEFAULT_PARTIALS
  })
  const [playing, setPlaying] = useState(false)
  const [copied, setCopied] = useState(false)

  const { ref: timeRef, size: timeSize } = useDprCanvas()
  const { ref: magRef, size: magSize } = useDprCanvas()
  const { ref: phRef, size: phSize } = useDprCanvas()

  // Build the raw signal.
  const raw = useMemo(() => {
    if (sigSource === 'additive') {
      const partials: Partial[] = amps
        .map((a, i) => ({ harmonic: i + 1, amp: a, phase: 0 }))
        .filter((p) => p.amp > 0.001)
      return additiveSignal(partials, N, freq, FS)
    }
    return generateSignal(signal, N, { freq, fs: FS, amp: 1, noise, seed: 1337 })
  }, [sigSource, signal, freq, noise, amps])

  // Audition the signal. The effect owns playback so retriggering on a parameter
  // change stays seamless; toggling the button only flips `playing`.
  useEffect(() => {
    if (!playing) {
      audio.stop()
      return
    }
    audio.playSignal(raw, { sampleRate: AUDIO_SR, gain: 0.85 })
  }, [playing, raw])
  useEffect(() => () => audio.stop(), [])

  const onShare = () => {
    shareLink('spectrum', {
      src: sigSource,
      sig: signal,
      freq,
      noise: noise.toFixed(2),
      win,
      db,
      amps: amps.map((a) => a.toFixed(2)).join(','),
    }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  // Analyze.
  const result = useMemo(() => {
    const w = windowFn(win, N)
    let sumW = 0
    for (let i = 0; i < N; i++) sumW += w[i]
    const windowed = applyWindow(raw, w)
    const spec = rfft(windowed)
    const rawMag = magnitude(spec)
    const rawPh = phase(spec)
    const mags = new Float64Array(HALF)
    const phs = new Float64Array(HALF)
    for (let k = 0; k < HALF; k++) {
      mags[k] = (2 * rawMag[k]) / sumW
      phs[k] = rawPh[k]
    }
    let peakBin = 1
    for (let k = 1; k < HALF; k++) if (mags[k] > mags[peakBin]) peakBin = k
    let maxMag = 1e-9
    for (let k = 0; k < HALF; k++) maxMag = Math.max(maxMag, mags[k])
    return { windowed, w, mags, phs, peakBin, maxMag, peakFreq: (peakBin * FS) / N }
  }, [raw, win])

  // Draw time domain.
  useEffect(() => {
    const ctx = prepareContext(timeRef.current, timeSize)
    if (!ctx) return
    const { width: w, height: h } = timeSize
    const r = { x: 0, y: 0, w, h }
    fillPlotBg(ctx, r)
    grid(ctx, r, 8, 4)
    zeroLine(ctx, r)
    const range = Math.max(peak(raw), 1e-3) * 1.1
    // window envelope
    const env = new Float64Array(N)
    for (let i = 0; i < N; i++) env[i] = result.w[i] * range
    linePlot(ctx, r, env, range, 'rgba(167,139,250,0.35)', 1.2)
    const negEnv = new Float64Array(N)
    for (let i = 0; i < N; i++) negEnv[i] = -result.w[i] * range
    linePlot(ctx, r, negEnv, range, 'rgba(167,139,250,0.35)', 1.2)
    // raw (faint) + windowed (bright)
    linePlot(ctx, r, raw, range, 'rgba(154,166,212,0.35)', 1.2)
    linePlot(ctx, r, result.windowed, range, '#5eead4', 2)
    axisLabel(ctx, 'time →', w - 8, h - 8, 'right')
  }, [raw, result, timeSize, timeRef])

  // Draw magnitude spectrum.
  useEffect(() => {
    const ctx = prepareContext(magRef.current, magSize)
    if (!ctx) return
    const { width: w, height: h } = magSize
    const r = { x: 0, y: 0, w, h }
    fillPlotBg(ctx, r)
    grid(ctx, r, 8, 4)
    if (db) {
      const dbData = new Float64Array(HALF)
      const floor = -80
      for (let k = 0; k < HALF; k++) {
        const d = 20 * Math.log10(result.mags[k] + 1e-9)
        dbData[k] = Math.max(0, (d - floor) / -floor) // 0..1
      }
      areaPlot(ctx, r, dbData, 1, '#38bdf8', 'rgba(56,189,248,0.18)')
      axisLabel(ctx, '0 dB', 6, 14, 'left')
      axisLabel(ctx, `${floor} dB`, 6, h - 8, 'left')
    } else {
      areaPlot(ctx, r, result.mags, result.maxMag * 1.08, '#38bdf8', 'rgba(56,189,248,0.18)')
      axisLabel(ctx, result.maxMag.toFixed(2), 6, 14, 'left')
    }
    // frequency ticks
    for (const f of [0, 128, 256, 384, 512]) {
      const x = (f / (FS / 2)) * w
      axisLabel(ctx, `${f}`, Math.min(w - 4, Math.max(12, x)), h - 8, 'center')
    }
    axisLabel(ctx, 'Hz →', w - 8, 14, 'right')
  }, [result, magSize, db, magRef])

  // Draw phase spectrum.
  useEffect(() => {
    const ctx = prepareContext(phRef.current, phSize)
    if (!ctx) return
    const { width: w, height: h } = phSize
    const r = { x: 0, y: 0, w, h }
    fillPlotBg(ctx, r)
    grid(ctx, r, 8, 4)
    zeroLine(ctx, r)
    const thresh = result.maxMag * 0.02
    ctx.fillStyle = '#a78bfa'
    for (let k = 1; k < HALF; k++) {
      if (result.mags[k] < thresh) continue
      const x = (k / HALF) * w
      const y = h / 2 - (result.phs[k] / Math.PI) * (h / 2) * 0.9
      ctx.beginPath()
      ctx.arc(x, y, 2, 0, Math.PI * 2)
      ctx.fill()
    }
    axisLabel(ctx, '+π', 6, 14, 'left')
    axisLabel(ctx, '−π', 6, h - 8, 'left')
    axisLabel(ctx, 'phase (significant bins)', w - 8, h - 8, 'right')
  }, [result, phSize, phRef])

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Signal">
          <Segmented
            value={sigSource}
            options={[
              { id: 'test', label: 'Test signal' },
              { id: 'additive', label: 'Additive' },
            ]}
            onChange={setSigSource}
          />
          {sigSource === 'test' ? (
            <>
              <Field label="Waveform">
                <Select value={signal} options={SIGNALS} onChange={setSignal} />
              </Field>
              <Field label="Noise" value={noise.toFixed(2)}>
                <Slider min={0} max={0.5} step={0.01} value={noise} onChange={setNoise} />
              </Field>
            </>
          ) : (
            <div className="field">
              <span className="field-head">
                <span className="field-label">Harmonic amplitudes</span>
              </span>
              {amps.map((a, i) => (
                <Field key={i} label={`h${i + 1}`} value={a.toFixed(2)}>
                  <Slider
                    min={0}
                    max={1}
                    step={0.01}
                    value={a}
                    onChange={(v) =>
                      setAmps((prev) => prev.map((x, j) => (j === i ? v : x)))
                    }
                  />
                </Field>
              ))}
              <div className="btn-row">
                <Button variant="ghost" onClick={() => setAmps(DEFAULT_PARTIALS)}>
                  Reset
                </Button>
                <Button variant="ghost" onClick={() => setAmps(amps.map(() => 0))}>
                  Clear
                </Button>
              </div>
            </div>
          )}
          <Field label="Frequency" value={`${freq} Hz`}>
            <Slider min={4} max={128} step={1} value={freq} onChange={(v) => setFreq(Math.round(v))} />
          </Field>
        </Panel>

        <Panel title="Analysis">
          <Field label="Window">
            <Select value={win} options={WINDOWS} onChange={setWin} />
          </Field>
          <Toggle label="Decibel magnitude scale" checked={db} onChange={setDb} />
          <Readout
            items={[
              { label: 'Peak', value: `${result.peakFreq.toFixed(0)} Hz` },
              { label: 'FFT size', value: String(N) },
              { label: 'Bins', value: String(HALF) },
            ]}
          />
        </Panel>

        <Panel title="Listen &amp; share">
          <div className="btn-row">
            <Button variant={playing ? 'default' : 'primary'} onClick={() => setPlaying((p) => !p)}>
              {playing ? '◼ Stop' : '► Play'}
            </Button>
            <Button variant="ghost" onClick={onShare}>
              {copied ? 'Link copied ✓' : 'Copy link'}
            </Button>
          </div>
          <p className="hint">
            Hear the timbre change as you drag the harmonic sliders — same math, now audible.
          </p>
        </Panel>
      </div>

      <div className="mode-main">
        <p className="mode-intro">
          The <strong>Fourier transform</strong> reports how much of each frequency lives in a
          signal. Build a waveform, pick a <strong>window</strong>, and read its spectrum. Try a
          square wave — you'll see only <em>odd</em> harmonics. Switch the window to see how it
          tames <em>spectral leakage</em> from frequencies that don't fit a whole number of cycles.
        </p>
        <CanvasCard title="Time domain" note="raw · windowed · window envelope" height={200}>
          <canvas ref={timeRef} />
        </CanvasCard>
        <CanvasCard title="Magnitude spectrum" note="one-sided, amplitude-calibrated" height={240}>
          <canvas ref={magRef} />
        </CanvasCard>
        <CanvasCard title="Phase spectrum" note="only bins above 2% of peak" height={170}>
          <canvas ref={phRef} />
        </CanvasCard>
      </div>
    </div>
  )
}
