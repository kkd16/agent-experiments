import { useEffect, useMemo, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Readout, Button } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import { COLORMAPS, colormapLUT } from '../lib/colormap'
import type { ColormapName } from '../lib/colormap'
import { cwtMorlet, reduceTime } from '../lib/wavelet'
import { stft } from '../lib/stft'
import { readHashParams, shareLink, readNum, readStr } from '../lib/urlState'

const FS = 500
const LEN = 1000
const DURATION = LEN / FS // 2 s

type WSignal = 'crossing' | 'transient' | 'steps' | 'chirp' | 'twoTone'

const SIGNALS: { id: WSignal; label: string }[] = [
  { id: 'crossing', label: 'Crossing chirps' },
  { id: 'transient', label: 'Tone + click' },
  { id: 'steps', label: 'Frequency steps' },
  { id: 'chirp', label: 'Chirp (sweep)' },
  { id: 'twoTone', label: 'Two tones' },
]

// Signals chosen to expose the wavelet's adaptive time/frequency resolution.
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
        v =
          0.7 * Math.sin(2 * Math.PI * up * t) +
          0.7 * Math.sin(2 * Math.PI * down * t)
        break
      }
      case 'transient': {
        // A steady mid tone plus a sharp broadband click at the midpoint.
        v = 0.8 * Math.sin(2 * Math.PI * base * 3 * t)
        const tc = dur * 0.5
        const env = Math.exp(-((t - tc) ** 2) / (2 * 0.004 ** 2))
        v += 1.4 * env * Math.sin(2 * Math.PI * base * 14 * t)
        break
      }
      case 'steps': {
        // Three sequential tones (an arpeggio) — frequency changes in time.
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

// Render a [rows][cols] matrix (row 0 = lowest frequency) as a colormapped image,
// flipping so low frequency sits at the bottom. Values are dB-normalized.
function drawMatrix(
  canvas: HTMLCanvasElement | null,
  size: { width: number; height: number; dpr: number },
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
    const y = nRows - 1 - r // low freq at bottom
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

export default function Wavelet() {
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

  // Continuous wavelet transform → time-reduced scalogram.
  const scalogram = useMemo(() => {
    const res = cwtMorlet(raw, { fs: FS, omega0, scalesPerOctave: 14 })
    const reduced = reduceTime(res, 520)
    let max = 1e-12
    for (const row of reduced.cols) for (let i = 0; i < row.length; i++) if (row[i] > max) max = row[i]
    return { ...reduced, max, freqs: res.freqs }
  }, [raw, omega0])

  // A fixed-window STFT of the same signal, for contrast.
  const spectro = useMemo(() => {
    const res = stft(raw, { fftSize: 128, hop: 16, window: 'hann' })
    // Convert dB frames (rows are frames→columns; each frame length = bins).
    const bins = res.bins
    const cols = res.frames.length
    const rows: Float64Array[] = []
    let max = 1e-12
    for (let b = 0; b < bins; b++) {
      const row = new Float64Array(cols)
      for (let c = 0; c < cols; c++) {
        // frames[c][b] holds dB; convert back to power for the shared drawMatrix
        // (which re-logs it against the matrix maximum).
        const p = Math.pow(10, res.frames[c][b] / 10)
        row[c] = p
        if (p > max) max = p
      }
      rows.push(row)
    }
    return { rows, cols, max, bins }
  }, [raw])

  // ---- draw scalogram ----
  useEffect(() => {
    const lut = colormapLUT(cmap)
    const ctx = drawMatrix(
      cwtRef.current,
      cwtSize,
      scalogram.cols,
      scalogram.columns,
      scalogram.max,
      floorDb,
      lut,
    )
    if (!ctx) return
    const { width: w, height: h } = cwtSize
    // Frequency ticks (log axis; freqs[0] = lowest, drawn at the bottom).
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

  // ---- draw STFT comparison ----
  useEffect(() => {
    const lut = colormapLUT(cmap)
    drawMatrix(stftRef.current, stftSize, spectro.rows, spectro.cols, spectro.max, floorDb, lut)
  }, [spectro, stftSize, stftRef, cmap, floorDb])

  const onShare = () => {
    shareLink('wavelet', {
      sig: signal,
      f: base,
      w0: omega0,
      cm: cmap,
      fl: floorDb,
    }).then((ok) => {
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
            Low ω₀ favours <em>time</em> resolution (sharp events); high ω₀ favours{' '}
            <em>frequency</em> resolution (pure tones).
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
          The STFT analyses every frequency with the <strong>same</strong> window, so it must trade
          time sharpness for frequency sharpness once and for all. The <strong>wavelet</strong>{' '}
          transform instead stretches a little wave — the <em>Morlet</em> — to fit each frequency:
          short and punchy up high, long and selective down low. Compare the two views of the same
          signal below. Try <em>Tone + click</em>: the wavelet pins the click to an instant while
          still resolving the tone.
        </p>
        <CanvasCard title="Wavelet scalogram" note={`Morlet CWT · log-frequency`} aspect={2.2}>
          <canvas ref={cwtRef} />
        </CanvasCard>
        <CanvasCard title="STFT spectrogram" note="128-pt fixed window · for contrast" aspect={2.8}>
          <canvas ref={stftRef} />
        </CanvasCard>
      </div>
    </div>
  )
}
