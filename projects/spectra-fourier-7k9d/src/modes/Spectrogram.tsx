import { useEffect, useMemo, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Readout } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import { SIGNALS, WINDOWS, generateSignal } from '../lib/dsp'
import type { SignalName, WindowName } from '../lib/dsp'
import { stft } from '../lib/stft'
import { COLORMAPS, colormapLUT } from '../lib/colormap'
import type { ColormapName } from '../lib/colormap'

const FS = 8000
const DURATION = 2.6 // seconds
const LEN = Math.round(FS * DURATION)

const FFT_SIZES = [
  { id: '256', label: '256' },
  { id: '512', label: '512' },
  { id: '1024', label: '1024' },
]

export default function Spectrogram() {
  const [signal, setSignal] = useState<SignalName>('chirp')
  const [freq, setFreq] = useState(220)
  const [noise, setNoise] = useState(0.05)
  const [fftSizeStr, setFftSizeStr] = useState('512')
  const [win, setWin] = useState<WindowName>('hann')
  const [cmap, setCmap] = useState<ColormapName>('magma')
  const [floorDb, setFloorDb] = useState(-90)

  const { ref, size } = useDprCanvas()
  const fftSize = parseInt(fftSizeStr, 10)

  const raw = useMemo(
    () => generateSignal(signal, LEN, { freq, fs: FS, amp: 1, noise, seed: 909 }),
    [signal, freq, noise],
  )

  const result = useMemo(
    () => stft(raw, { fftSize, hop: fftSize / 4, window: win }),
    [raw, fftSize, win],
  )

  useEffect(() => {
    const ctx = prepareContext(ref.current, size)
    if (!ctx) return
    const { width: w, height: h } = size
    const { frames, bins } = result
    if (frames.length === 0) return

    // Render the spectrogram to an offscreen buffer at native resolution, then
    // scale it up to the display canvas.
    const off = document.createElement('canvas')
    off.width = frames.length
    off.height = bins
    const octx = off.getContext('2d')
    if (!octx) return
    const img = octx.createImageData(frames.length, bins)
    const lut = colormapLUT(cmap)
    const floor = floorDb
    const top = 0
    const range = top - floor
    for (let x = 0; x < frames.length; x++) {
      const col = frames[x]
      for (let bin = 0; bin < bins; bin++) {
        const db = col[bin]
        let t = (db - floor) / range
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const li = (Math.round(t * 255) & 255) * 4
        // low frequency at the bottom → flip the row
        const y = bins - 1 - bin
        const pi = (y * frames.length + x) * 4
        img.data[pi] = lut[li]
        img.data[pi + 1] = lut[li + 1]
        img.data[pi + 2] = lut[li + 2]
        img.data[pi + 3] = 255
      }
    }
    octx.putImageData(img, 0, 0)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(off, 0, 0, frames.length, bins, 0, 0, w, h)

    // Axis overlays.
    ctx.fillStyle = 'rgba(238,241,255,0.9)'
    ctx.font = '11px JetBrains Mono, ui-monospace, monospace'
    ctx.textAlign = 'left'
    const nyquist = FS / 2
    // Frequency ticks up the left edge (skip DC to keep the corner clear).
    for (const f of [nyquist * 0.25, nyquist * 0.5, nyquist * 0.75, nyquist]) {
      const y = h - (f / nyquist) * h
      const yy = Math.max(12, Math.min(h - 20, y))
      ctx.fillStyle = 'rgba(7,9,18,0.55)'
      ctx.fillRect(2, yy - 11, 60, 13)
      ctx.fillStyle = 'rgba(238,241,255,0.92)'
      ctx.textAlign = 'left'
      ctx.fillText(`${(f / 1000).toFixed(1)}kHz`, 5, yy)
    }
    // Time ticks along the bottom (interior points, clear of the colorbar).
    ctx.textAlign = 'center'
    for (const s of [DURATION * 0.25, DURATION * 0.5, DURATION * 0.75]) {
      const x = (s / DURATION) * w
      ctx.fillStyle = 'rgba(7,9,18,0.55)'
      ctx.fillRect(x - 18, h - 16, 36, 14)
      ctx.fillStyle = 'rgba(238,241,255,0.92)'
      ctx.fillText(`${s.toFixed(1)}s`, x, h - 5)
    }

    // colorbar (right edge)
    const cbW = 10
    const cbX = w - cbW - 4
    for (let i = 0; i < h; i++) {
      const t = 1 - i / h
      const li = (Math.round(t * 255) & 255) * 4
      ctx.fillStyle = `rgb(${lut[li]},${lut[li + 1]},${lut[li + 2]})`
      ctx.fillRect(cbX, i, cbW, 1)
    }
    ctx.fillStyle = 'rgba(238,241,255,0.9)'
    ctx.textAlign = 'right'
    ctx.fillText('0dB', cbX - 3, 12)
    ctx.fillText(`${floorDb}`, cbX - 3, h - 4)
  }, [result, size, cmap, floorDb, ref])

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Signal">
          <Field label="Waveform">
            <Select value={signal} options={SIGNALS} onChange={setSignal} />
          </Field>
          <Field label="Base frequency" value={`${freq} Hz`}>
            <Slider min={40} max={1200} step={10} value={freq} onChange={(v) => setFreq(Math.round(v))} />
          </Field>
          <Field label="Noise" value={noise.toFixed(2)}>
            <Slider min={0} max={0.4} step={0.01} value={noise} onChange={setNoise} />
          </Field>
        </Panel>

        <Panel title="STFT">
          <Field label="FFT size">
            <Select value={fftSizeStr} options={FFT_SIZES} onChange={setFftSizeStr} />
          </Field>
          <Field label="Window">
            <Select value={win} options={WINDOWS} onChange={setWin} />
          </Field>
          <Readout
            items={[
              { label: 'Frames', value: String(result.frames.length) },
              { label: 'Bins', value: String(result.bins) },
              { label: 'Overlap', value: '75%' },
            ]}
          />
        </Panel>

        <Panel title="Display">
          <Field label="Colormap">
            <Select value={cmap} options={COLORMAPS} onChange={setCmap} />
          </Field>
          <Field label="Dynamic range floor" value={`${floorDb} dB`}>
            <Slider min={-140} max={-40} step={5} value={floorDb} onChange={(v) => setFloorDb(Math.round(v))} />
          </Field>
        </Panel>
      </div>

      <div className="mode-main">
        <p className="mode-intro">
          One spectrum is a snapshot; a <strong>spectrogram</strong> is the movie. We slide a
          window across the signal, FFT each short frame, and stack the results into a{' '}
          <strong>time × frequency</strong> image — brightness is energy. A <em>chirp</em> traces a
          diagonal as its pitch sweeps. Trade the <em>FFT size</em> to feel the uncertainty
          principle: bigger windows sharpen frequency but blur time.
        </p>
        <CanvasCard title="Spectrogram" note={`${fftSize}-pt FFT · ${win} window`} aspect={2}>
          <canvas ref={ref} />
        </CanvasCard>
      </div>
    </div>
  )
}
