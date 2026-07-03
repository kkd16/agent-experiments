import { useEffect, useMemo, useRef, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Segmented, Readout, Button, Toggle } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import { useAnimationFrame } from '../hooks/useAnimationFrame'
import { fillPlotBg, grid, zeroLine, axisLabel, linePlot } from '../lib/draw'
import { windowFn } from '../lib/dsp'
import { rfft } from '../lib/fft'
import { colormapLUT, COLORMAPS } from '../lib/colormap'
import type { ColormapName } from '../lib/colormap'
import { freqToNote, refinePeak } from '../lib/note'
import type { NoteReading } from '../lib/note'
import { mic } from '../lib/mic'

const FFT_N = 2048
const SYNTH_SR = 44100
const SGRAM_W = 480 // spectrogram history columns
const SGRAM_H = 256 // spectrogram frequency rows

type Source = 'synth' | 'mic'
const MAXHZ_OPTS: { id: string; label: string }[] = [
  { id: '2000', label: '2 kHz' },
  { id: '5000', label: '5 kHz' },
  { id: '11025', label: '11 kHz' },
]

// A deterministic tiny noise source for the synthetic voice (no Math.random).
function noiseAt(i: number, seed: number): number {
  const x = Math.sin((i + 1) * 12.9898 + seed * 78.233) * 43758.5453
  return (x - Math.floor(x)) * 2 - 1
}

export default function Live() {
  const [source, setSource] = useState<Source>('synth')
  const [running, setRunning] = useState(true)
  const [cmap, setCmap] = useState<ColormapName>('magma')
  const [maxHz, setMaxHz] = useState(5000)
  const [floorDb, setFloorDb] = useState(-82)
  const [showWave, setShowWave] = useState(true)
  const [micState, setMicState] = useState<'idle' | 'on' | 'denied'>('idle')
  const [note, setNote] = useState<NoteReading | null>(null)
  const [level, setLevel] = useState(0)

  const win = useMemo(() => windowFn('hann', FFT_N), [])
  const lut = useMemo(() => colormapLUT(cmap), [cmap])

  // reusable buffers
  const timeBuf = useRef(new Float32Array(FFT_N))
  const winBuf = useRef(new Float64Array(FFT_N))
  const smooth = useRef(new Float64Array(FFT_N / 2))
  const noteAcc = useRef(0)

  // spectrogram offscreen surface (persists + scrolls each frame); a mutable ref,
  // lazily created on the first animation frame so it is only ever touched inside
  // the render loop, never during render.
  const sgramSurf = useRef<{ canvas: HTMLCanvasElement; col: ImageData } | null>(null)
  const ensureSurface = () => {
    if (sgramSurf.current || typeof document === 'undefined') return sgramSurf.current
    const canvas = document.createElement('canvas')
    canvas.width = SGRAM_W
    canvas.height = SGRAM_H
    const octx = canvas.getContext('2d')
    if (octx) {
      octx.fillStyle = '#05070f'
      octx.fillRect(0, 0, SGRAM_W, SGRAM_H)
    }
    sgramSurf.current = { canvas, col: new ImageData(1, SGRAM_H) }
    return sgramSurf.current
  }

  const { ref: waveRef, size: waveSize } = useDprCanvas()
  const { ref: specRef, size: specSize } = useDprCanvas()
  const { ref: sgramRef, size: sgramSize } = useDprCanvas()

  // Try the real microphone (needs a user gesture).
  const enableMic = async () => {
    const ok = await mic.start(FFT_N)
    if (ok) {
      setSource('mic')
      setMicState('on')
      setRunning(true)
    } else {
      setMicState('denied')
      setSource('synth')
    }
  }
  const backToSynth = () => {
    mic.stop()
    setSource('synth')
    setMicState('idle')
  }
  useEffect(() => () => mic.stop(), [])

  // Synthesize an evolving voiced tone when there is no microphone.
  const fillSynth = (out: Float32Array, t: number) => {
    // slow glide across roughly G3..G4 with two overlaid vibratos
    const f0 = 196 * Math.pow(2, 0.55 * Math.sin(0.32 * t) + 0.22 * Math.sin(0.11 * t + 1))
    const amps = [1, 0.55, 0.34, 0.2, 0.12, 0.07]
    for (let i = 0; i < out.length; i++) {
      const tt = t + i / SYNTH_SR
      let v = 0
      for (let h = 0; h < amps.length; h++) v += amps[h] * Math.sin(2 * Math.PI * f0 * (h + 1) * tt)
      v += 0.06 * noiseAt(i, Math.floor(t * 30))
      out[i] = 0.42 * v
    }
  }

  useAnimationFrame((dt, t) => {
    const buf = timeBuf.current
    let sr = SYNTH_SR
    if (source === 'mic' && mic.running) {
      if (!mic.read(buf)) fillSynth(buf, t)
      else sr = mic.sampleRate
    } else {
      fillSynth(buf, t)
    }

    // windowed magnitude spectrum via the from-scratch FFT
    const w = winBuf.current
    let rms = 0
    for (let i = 0; i < FFT_N; i++) {
      const s = buf[i]
      rms += s * s
      w[i] = s * win[i]
    }
    rms = Math.sqrt(rms / FFT_N)
    const spec = rfft(w)
    const half = FFT_N / 2
    const sm = smooth.current
    const binHz = sr / FFT_N
    const ref = FFT_N / 4
    const a = 0.55 // temporal smoothing
    let peakK = 0
    let peakV = 0
    for (let k = 0; k < half; k++) {
      const mag = Math.hypot(spec.re[k], spec.im[k]) / ref
      sm[k] = a * sm[k] + (1 - a) * mag
      if (k > 1 && sm[k] > peakV) {
        peakV = sm[k]
        peakK = k
      }
    }

    // note readout (throttled) — only when there's real signal energy
    noteAcc.current += dt
    if (noteAcc.current >= 0.12) {
      noteAcc.current = 0
      setLevel(rms)
      if (rms > 0.004 && peakV > 0.002) {
        const f = refinePeak(sm, peakK, binHz)
        setNote(freqToNote(f))
      } else {
        setNote(null)
      }
    }

    const dbTo01 = (mag: number) => {
      const db = 20 * Math.log10(mag + 1e-9)
      return Math.max(0, Math.min(1, (db - floorDb) / (0 - floorDb)))
    }

    // --- waveform ---
    if (showWave) {
      const ctx = prepareContext(waveRef.current, waveSize)
      if (ctx) {
        const r = { x: 0, y: 0, w: waveSize.width, h: waveSize.height }
        fillPlotBg(ctx, r)
        grid(ctx, r, 8, 4)
        zeroLine(ctx, r)
        const range = Math.max(0.05, rms * 3.2)
        linePlot(ctx, r, buf, range, '#5eead4', 1.8)
        axisLabel(ctx, source === 'mic' ? 'microphone' : 'synthetic voice', 8, 15, 'left')
      }
    }

    // --- spectrum (dB) ---
    {
      const ctx = prepareContext(specRef.current, specSize)
      if (ctx) {
        const W = specSize.width
        const H = specSize.height
        const r = { x: 0, y: 0, w: W, h: H }
        fillPlotBg(ctx, r)
        grid(ctx, r, 10, 5)
        const maxBin = Math.min(half - 1, Math.floor(maxHz / binHz))
        ctx.beginPath()
        ctx.moveTo(0, H)
        for (let k = 1; k <= maxBin; k++) {
          const x = ((k - 1) / (maxBin - 1)) * W
          const y = H - dbTo01(sm[k]) * H * 0.98
          ctx.lineTo(x, y)
        }
        ctx.lineTo(W, H)
        ctx.closePath()
        ctx.fillStyle = 'rgba(56,189,248,0.14)'
        ctx.fill()
        ctx.beginPath()
        for (let k = 1; k <= maxBin; k++) {
          const x = ((k - 1) / (maxBin - 1)) * W
          const y = H - dbTo01(sm[k]) * H * 0.98
          if (k === 1) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.strokeStyle = '#38bdf8'
        ctx.lineWidth = 2
        ctx.stroke()
        // peak marker
        if (peakV > 0.002 && peakK <= maxBin) {
          const px = ((peakK - 1) / (maxBin - 1)) * W
          ctx.strokeStyle = 'rgba(167,139,250,0.85)'
          ctx.setLineDash([4, 4])
          ctx.beginPath()
          ctx.moveTo(px, 0)
          ctx.lineTo(px, H)
          ctx.stroke()
          ctx.setLineDash([])
        }
        for (let f = 0; f <= maxHz; f += maxHz <= 2000 ? 500 : maxHz <= 5000 ? 1000 : 2000) {
          const x = (f / maxHz) * W
          axisLabel(ctx, f >= 1000 ? `${f / 1000}k` : `${f}`, Math.min(W - 4, Math.max(10, x)), H - 6, 'center')
        }
        axisLabel(ctx, 'Hz →', W - 6, 15, 'right')
      }
    }

    // --- spectrogram (scroll + newest column) ---
    {
      const surf = ensureSurface()
      const off = surf?.canvas ?? null
      const col = surf?.col ?? null
      const octx = off?.getContext('2d')
      if (off && col && octx) {
        // scroll left by 1 px (copy avoids alpha blending)
        octx.globalCompositeOperation = 'copy'
        octx.drawImage(off, -1, 0)
        octx.globalCompositeOperation = 'source-over'
        // build newest column: low freq at bottom
        const maxBinF = Math.min(half - 1, Math.floor(maxHz / binHz))
        const data = col.data
        const lutC = lut
        for (let row = 0; row < SGRAM_H; row++) {
          const frac = row / (SGRAM_H - 1) // 0..1
          const bin = frac * maxBinF
          const b0 = Math.floor(bin)
          const b1 = Math.min(maxBinF, b0 + 1)
          const fb = bin - b0
          const mag = sm[b0] * (1 - fb) + sm[b1] * fb
          const li = (Math.max(0, Math.min(255, Math.round(dbTo01(mag) * 255))) & 255) * 4
          const y = (SGRAM_H - 1 - row) * 4 // low freq at bottom
          data[y] = lutC[li]
          data[y + 1] = lutC[li + 1]
          data[y + 2] = lutC[li + 2]
          data[y + 3] = 255
        }
        octx.putImageData(col, SGRAM_W - 1, 0)
        // blit to visible canvas
        const ctx = prepareContext(sgramRef.current, sgramSize)
        if (ctx) {
          ctx.imageSmoothingEnabled = true
          ctx.imageSmoothingQuality = 'high'
          ctx.drawImage(off, 0, 0, SGRAM_W, SGRAM_H, 0, 0, sgramSize.width, sgramSize.height)
          // freq axis on the right
          for (let f = 0; f <= maxHz; f += maxHz <= 2000 ? 500 : maxHz <= 5000 ? 1000 : 2000) {
            const y = sgramSize.height - (f / maxHz) * sgramSize.height
            axisLabel(ctx, f >= 1000 ? `${f / 1000}k` : `${f}`, sgramSize.width - 6, Math.max(12, y - 3), 'right')
          }
          axisLabel(ctx, 'time →', 8, sgramSize.height - 8, 'left')
        }
      }
    }
  }, running)

  const centsBar = note ? Math.max(-50, Math.min(50, note.cents)) : 0

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Source">
          <Segmented
            value={source}
            options={[
              { id: 'synth', label: 'Synthetic' },
              { id: 'mic', label: 'Microphone' },
            ]}
            onChange={(v) => (v === 'mic' ? enableMic() : backToSynth())}
          />
          {source === 'mic' && micState === 'on' && (
            <p className="hint">
              Live from your mic — whistle, sing or play a note and watch its harmonics stack up.
            </p>
          )}
          {micState === 'denied' && (
            <p className="hint">
              <em>Microphone unavailable</em> (blocked or no device). Showing a synthetic voice
              instead — everything below is still your from-scratch FFT running live.
            </p>
          )}
          {source === 'synth' && micState !== 'denied' && (
            <p className="hint">
              A synthetic gliding voice drives the analyser. Switch to <em>Microphone</em> to run it
              on live audio (you'll be asked for permission).
            </p>
          )}
          <div className="btn-row">
            <Button variant={running ? 'primary' : 'default'} onClick={() => setRunning((r) => !r)}>
              {running ? '◼ Pause' : '► Run'}
            </Button>
          </div>
        </Panel>

        <Panel title="Pitch">
          <Readout
            items={[
              { label: 'Note', value: note ? note.name : '—' },
              { label: 'Freq', value: note ? `${note.freq.toFixed(1)} Hz` : '—' },
              { label: 'Cents', value: note ? `${note.cents > 0 ? '+' : ''}${note.cents}` : '—' },
            ]}
          />
          <div className="tuner">
            <div className="tuner-track">
              <div className="tuner-center" />
              <div
                className="tuner-needle"
                style={{
                  left: `calc(50% + ${centsBar}%)`,
                  background: Math.abs(centsBar) < 6 ? 'var(--accent)' : 'var(--accent-2)',
                  opacity: note ? 1 : 0.25,
                }}
              />
            </div>
            <div className="tuner-labels">
              <span>♭</span>
              <span>in tune</span>
              <span>♯</span>
            </div>
          </div>
        </Panel>

        <Panel title="Display">
          <Field label="Max frequency">
            <Segmented
              value={String(maxHz)}
              options={MAXHZ_OPTS}
              onChange={(v) => setMaxHz(Number(v))}
            />
          </Field>
          <Field label="Colormap">
            <Select value={cmap} options={COLORMAPS} onChange={setCmap} />
          </Field>
          <Field label="Noise floor" value={`${floorDb} dB`}>
            <Slider min={-110} max={-40} step={1} value={floorDb} onChange={(v) => setFloorDb(Math.round(v))} />
          </Field>
          <Toggle label="Show waveform" checked={showWave} onChange={setShowWave} />
          <Readout items={[{ label: 'Input level', value: `${(20 * Math.log10(level + 1e-9)).toFixed(0)} dB` }]} />
        </Panel>
      </div>

      <div className="mode-main">
        <p className="mode-intro">
          A <strong>real-time analyser</strong>. Every frame we grab a block of audio — from your{' '}
          <strong>microphone</strong> or a synthetic voice — window it, and run it through the same{' '}
          <strong>from-scratch FFT</strong> that powers the rest of the lab. The result is a live{' '}
          <em>spectrum</em>, a scrolling <em>spectrogram</em>, and a <em>pitch tuner</em> that names
          the note you're hearing. Sing a steady vowel and watch its harmonics line up as evenly
          spaced ridges.
        </p>

        {showWave && (
          <CanvasCard title="Waveform" note="live time-domain signal" height={150}>
            <canvas ref={waveRef} />
          </CanvasCard>
        )}
        <CanvasCard title="Spectrum" note="live magnitude · peak marked" height={210}>
          <canvas ref={specRef} />
        </CanvasCard>
        <CanvasCard title="Spectrogram" note="time × frequency, scrolling" height={300}>
          <canvas ref={sgramRef} />
        </CanvasCard>
      </div>
    </div>
  )
}
