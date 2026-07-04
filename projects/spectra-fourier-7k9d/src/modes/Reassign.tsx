import { useEffect, useMemo, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Segmented, Toggle, Button, Readout } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import type { CanvasSize } from '../hooks/useDprCanvas'
import { COLORMAPS, colormapLUT } from '../lib/colormap'
import type { ColormapName } from '../lib/colormap'
import { reassignSpectrogram, makeTfrSignal, TFR_SIGNALS } from '../lib/reassign'
import type { Tfr, TfrSignalName } from '../lib/reassign'
import { readHashParams, shareLink, readNum, readStr, readBool } from '../lib/urlState'

const FS = 4000
const DURATION = 1.6
const LEN = Math.round(FS * DURATION)

const FFT_SIZES = [
  { id: '256', label: '256' },
  { id: '512', label: '512' },
  { id: '1024', label: '1024' },
]

type Sharpened = 'reassigned' | 'synchro'
const SHARPENED: { id: Sharpened; label: string }[] = [
  { id: 'reassigned', label: 'Reassigned' },
  { id: 'synchro', label: 'Synchrosqueezed' },
]

// Draw a time-frequency matrix (dB) onto a canvas: an offscreen native-resolution
// image scaled up, plus frequency/time axes, a colour bar, and an optional ridge.
function drawTfr(
  canvas: HTMLCanvasElement | null,
  size: CanvasSize,
  tfr: Tfr,
  cmap: ColormapName,
  floorDb: number,
  fMax: number,
  binHz: number,
  ridge: Float64Array | null,
) {
  const ctx = prepareContext(canvas, size)
  if (!ctx) return
  const { width: w, height: h } = size
  const { cols, rows, data } = tfr
  if (cols === 0 || rows === 0) return

  const rowsShown = Math.max(2, Math.min(rows, Math.round(fMax / binHz) + 1))

  const off = document.createElement('canvas')
  off.width = cols
  off.height = rowsShown
  const octx = off.getContext('2d')
  if (!octx) return
  const img = octx.createImageData(cols, rowsShown)
  const lut = colormapLUT(cmap)
  const range = 0 - floorDb
  for (let x = 0; x < cols; x++) {
    for (let bin = 0; bin < rowsShown; bin++) {
      const db = data[bin * cols + x]
      let t = (db - floorDb) / range
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const li = (Math.round(t * 255) & 255) * 4
      const y = rowsShown - 1 - bin // low freq at the bottom
      const pi = (y * cols + x) * 4
      img.data[pi] = lut[li]
      img.data[pi + 1] = lut[li + 1]
      img.data[pi + 2] = lut[li + 2]
      img.data[pi + 3] = 255
    }
  }
  octx.putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(off, 0, 0, cols, rowsShown, 0, 0, w, h)

  // Ridge overlay (dominant reassigned frequency per column).
  if (ridge) {
    ctx.beginPath()
    let started = false
    for (let x = 0; x < cols; x++) {
      const f = ridge[x]
      if (!isFinite(f) || f > fMax) {
        started = false
        continue
      }
      const px = (x / Math.max(1, cols - 1)) * w
      const py = h - (f / fMax) * h
      if (!started) {
        ctx.moveTo(px, py)
        started = true
      } else ctx.lineTo(px, py)
    }
    ctx.strokeStyle = 'rgba(94,234,212,0.85)'
    ctx.lineWidth = 1.4
    ctx.stroke()
  }

  // Frequency ticks (left).
  ctx.font = '11px JetBrains Mono, ui-monospace, monospace'
  for (const f of [fMax * 0.25, fMax * 0.5, fMax * 0.75, fMax]) {
    const y = h - (f / fMax) * h
    const yy = Math.max(12, Math.min(h - 20, y))
    ctx.fillStyle = 'rgba(7,9,18,0.55)'
    ctx.fillRect(2, yy - 11, 62, 13)
    ctx.fillStyle = 'rgba(238,241,255,0.92)'
    ctx.textAlign = 'left'
    ctx.fillText(`${(f / 1000).toFixed(2)}kHz`, 5, yy)
  }
  // Time ticks (bottom).
  ctx.textAlign = 'center'
  for (const s of [DURATION * 0.25, DURATION * 0.5, DURATION * 0.75]) {
    const x = (s / DURATION) * w
    ctx.fillStyle = 'rgba(7,9,18,0.55)'
    ctx.fillRect(x - 18, h - 16, 36, 14)
    ctx.fillStyle = 'rgba(238,241,255,0.92)'
    ctx.fillText(`${s.toFixed(2)}s`, x, h - 5)
  }
  // Colour bar (right).
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
}

export default function Reassign() {
  const sp = useMemo(() => readHashParams(), [])
  const [signal, setSignal] = useState<TfrSignalName>(
    readStr<TfrSignalName>(sp, 'sig', 'linearChirp', TFR_SIGNALS.map((s) => s.id) as TfrSignalName[]),
  )
  const [fftSizeStr, setFftSizeStr] = useState(readStr(sp, 'fft', '512', ['256', '512', '1024']))
  const [sigmaFrac, setSigmaFrac] = useState(readNum(sp, 'sig2', 0.14)) // σ as a fraction of the FFT size
  const [method, setMethod] = useState<Sharpened>(
    readStr<Sharpened>(sp, 'm', 'reassigned', ['reassigned', 'synchro']),
  )
  const [cmap, setCmap] = useState<ColormapName>(
    readStr<ColormapName>(sp, 'cmap', 'magma', COLORMAPS.map((c) => c.id) as ColormapName[]),
  )
  const [floorDb, setFloorDb] = useState(readNum(sp, 'floor', -55))
  const [showRidge, setShowRidge] = useState(readBool(sp, 'ridge', true))
  const [copied, setCopied] = useState(false)

  const fftSize = parseInt(fftSizeStr, 10)
  const sigma = Math.max(3, Math.round(sigmaFrac * fftSize))
  const fMax = FS / 2

  const raw = useMemo(() => makeTfrSignal(signal, LEN, FS), [signal])

  const result = useMemo(
    () =>
      reassignSpectrogram(raw, {
        fs: FS,
        fftSize,
        hop: Math.max(1, Math.round(fftSize / 8)),
        sigma,
      }),
    [raw, fftSize, sigma],
  )

  const { ref: baseRef, size: baseSize } = useDprCanvas()
  const { ref: sharpRef, size: sharpSize } = useDprCanvas()

  useEffect(() => {
    drawTfr(baseRef.current, baseSize, result.stft, cmap, floorDb, fMax, result.binHz, null)
  }, [baseRef, baseSize, result, cmap, floorDb, fMax])

  useEffect(() => {
    const tfr = method === 'reassigned' ? result.reassigned : result.synchro
    drawTfr(
      sharpRef.current,
      sharpSize,
      tfr,
      cmap,
      floorDb,
      fMax,
      result.binHz,
      showRidge ? result.ridge : null,
    )
  }, [sharpRef, sharpSize, result, method, cmap, floorDb, fMax, showRidge])

  const sharpenGain = result.entropy.stft - result.entropy.reassigned

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Signal">
          <Field label="Test signal">
            <Select value={signal} options={TFR_SIGNALS} onChange={setSignal} />
          </Field>
          <Field label="FFT size">
            <Select value={fftSizeStr} options={FFT_SIZES} onChange={setFftSizeStr} />
          </Field>
          <Field label="Window width σ" value={`${sigma} smp`}>
            <Slider min={0.05} max={0.28} step={0.01} value={sigmaFrac} onChange={setSigmaFrac} />
          </Field>
        </Panel>

        <Panel title="Sharpening">
          <Field label="Method">
            <Segmented value={method} options={SHARPENED} onChange={setMethod} />
          </Field>
          <Toggle label="Ridge (instantaneous freq)" checked={showRidge} onChange={setShowRidge} />
          <Readout
            items={[
              { label: 'STFT entropy', value: result.entropy.stft.toFixed(1) },
              { label: 'Reassigned', value: result.entropy.reassigned.toFixed(1) },
              { label: 'Sharper by', value: `${sharpenGain.toFixed(1)} bits` },
            ]}
          />
        </Panel>

        <Panel title="Display">
          <Field label="Colormap">
            <Select value={cmap} options={COLORMAPS} onChange={setCmap} />
          </Field>
          <Field label="Dynamic range floor" value={`${floorDb} dB`}>
            <Slider min={-90} max={-20} step={5} value={floorDb} onChange={(v) => setFloorDb(Math.round(v))} />
          </Field>
          <Button
            variant="ghost"
            onClick={() => {
              shareLink('reassign', {
                sig: signal,
                fft: fftSizeStr,
                sig2: sigmaFrac,
                m: method,
                cmap,
                floor: floorDb,
                ridge: showRidge,
              }).then((ok) => {
                setCopied(ok)
                if (ok) window.setTimeout(() => setCopied(false), 1600)
              })
            }}
          >
            {copied ? 'Link copied ✓' : 'Copy link'}
          </Button>
        </Panel>
      </div>

      <div className="mode-main">
        <p className="mode-intro">
          A spectrogram smears every event across the width of its window — a chirp becomes a fuzzy
          band. <strong>Reassignment</strong> asks, for each cell, <em>where did this energy really
          come from?</em> and moves it to the signal's local centre of gravity in the plane. The
          corrections are ratios of STFTs taken with two companion windows (τ·h and h′), so a chirp
          collapses to a razor line tracing its instantaneous frequency. Watch the{' '}
          <strong>Rényi entropy</strong> drop — that number <em>is</em> the sharpening.
        </p>
        <CanvasCard title="Ordinary spectrogram (Gaussian window)" note="the smeared baseline" aspect={2.6}>
          <canvas ref={baseRef} />
        </CanvasCard>
        <CanvasCard
          title={method === 'reassigned' ? 'Reassigned spectrogram' : 'Synchrosqueezed transform'}
          note={
            method === 'reassigned'
              ? 'sharpened in time and frequency'
              : 'sharpened in frequency, invertible'
          }
          aspect={2.6}
        >
          <canvas ref={sharpRef} />
        </CanvasCard>
      </div>
    </div>
  )
}
