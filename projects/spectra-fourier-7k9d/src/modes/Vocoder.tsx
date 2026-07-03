import { useEffect, useMemo, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Segmented, Toggle, Readout, Button } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import { generateSignal } from '../lib/dsp'
import { voicedSignal, VOWELS } from '../lib/synth'
import { pitchTimeShift } from '../lib/phasevocoder'
import { stft } from '../lib/stft'
import { colormapLUT } from '../lib/colormap'
import { fillPlotBg, grid, zeroLine, linePlot, axisLabel, paintColormap } from '../lib/draw'
import type { Rect } from '../lib/draw'
import { audio } from '../lib/audio'
import { readHashParams, shareLink, readNum, readStr, readBool } from '../lib/urlState'

const FS = 8000 // real playback sample rate → pitch is audible in Hz
const DUR = 1.9 // seconds of source
const N = Math.round(FS * DUR)

type SourceId = 'ah' | 'ee' | 'oo' | 'oh' | 'brass' | 'chirp' | 'twoTone'

const SOURCES: { id: SourceId; label: string }[] = [
  { id: 'ah', label: 'Voice “ah”' },
  { id: 'ee', label: 'Voice “ee”' },
  { id: 'oo', label: 'Voice “oo”' },
  { id: 'oh', label: 'Voice “oh”' },
  { id: 'brass', label: 'Brass note' },
  { id: 'chirp', label: 'Rising chirp' },
  { id: 'twoTone', label: 'Two tones' },
]

type FftId = '512' | '1024' | '2048'
type OvId = '4' | '8'

const FFT_SIZES: { id: FftId; label: string }[] = [
  { id: '1024', label: '1024' },
  { id: '2048', label: '2048' },
  { id: '512', label: '512' },
]

const OVERLAPS: { id: OvId; label: string }[] = [
  { id: '4', label: '4× (75%)' },
  { id: '8', label: '8× (87.5%)' },
]

function buildSource(id: SourceId, f0: number, vibrato: boolean): Float64Array {
  const vowel = VOWELS.find((v) => v.id === id)
  if (vowel) {
    return voicedSignal(N, {
      f0,
      fs: FS,
      formants: vowel.formants,
      vibratoHz: vibrato ? 5.5 : 0,
      vibratoCents: vibrato ? 35 : 0,
    })
  }
  if (id === 'chirp') return generateSignal('chirp', N, { freq: f0, fs: FS, amp: 1, noise: 0, seed: 7 })
  return generateSignal('twoTone', N, { freq: f0, fs: FS, amp: 1, noise: 0, seed: 7 })
}

// Render an STFT magnitude matrix as a time × frequency heatmap into `ctx`.
function drawSpectrogram(ctx: CanvasRenderingContext2D, r: Rect, sig: Float64Array, lut: Uint8ClampedArray) {
  const res = stft(sig, { fftSize: 512, hop: 128, window: 'hann' })
  const cols = res.frames.length
  const rows = res.bins
  if (cols === 0) {
    fillPlotBg(ctx, r)
    return
  }
  const field = new Float64Array(cols * rows)
  const span = 70 // fixed dynamic-range window (dB)
  const floor = res.maxDb - span
  for (let x = 0; x < cols; x++) {
    const col = res.frames[x]
    for (let k = 0; k < rows; k++) {
      const y = rows - 1 - k // low frequency at the bottom
      field[y * cols + x] = Math.max(0, Math.min(1, (col[k] - floor) / span))
    }
  }
  paintColormap(ctx, r, field, cols, rows, lut, true)
}

export default function Vocoder() {
  const sp = useMemo(() => readHashParams(), [])
  const [source, setSource] = useState<SourceId>(() => readStr<SourceId>(sp, 'src', 'ah', SOURCES.map((s) => s.id)))
  const [f0, setF0] = useState(() => readNum(sp, 'f0', 150))
  const [vibrato, setVibrato] = useState(() => readBool(sp, 'vib', true))
  const [stretch, setStretch] = useState(() => readNum(sp, 'st', 1.6))
  const [semitones, setSemitones] = useState(() => readNum(sp, 'pit', 4))
  const [fftStr, setFftStr] = useState<FftId>(() =>
    readStr<FftId>(sp, 'fft', '1024', FFT_SIZES.map((s) => s.id)),
  )
  const [ovStr, setOvStr] = useState<OvId>(() =>
    readStr<OvId>(sp, 'ov', '4', OVERLAPS.map((s) => s.id)),
  )
  const [playing, setPlaying] = useState<'orig' | 'proc' | null>(null)
  const [copied, setCopied] = useState(false)

  const fftSize = Number(fftStr)
  const overlap = Number(ovStr)

  const { ref: waveRef, size: waveSize } = useDprCanvas()
  const { ref: origRef, size: origSize } = useDprCanvas()
  const { ref: procRef, size: procSize } = useDprCanvas()

  const src = useMemo(() => buildSource(source, f0, vibrato), [source, f0, vibrato])
  const processed = useMemo(
    () => pitchTimeShift(src, { fftSize, overlap, semitones, stretch }),
    [src, fftSize, overlap, semitones, stretch],
  )

  // Audio A/B: the effect owns playback so a parameter change re-auditions the
  // same channel seamlessly; the buttons just flip which channel is armed.
  useEffect(() => {
    if (!playing) {
      audio.stop()
      return
    }
    audio.playSignal(playing === 'orig' ? src : processed, { sampleRate: FS, gain: 0.9, loop: true })
  }, [playing, src, processed])
  useEffect(() => () => audio.stop(), [])

  const onShare = () => {
    shareLink('vocoder', {
      src: source,
      f0,
      vib: vibrato,
      st: stretch.toFixed(2),
      pit: semitones,
      fft: fftStr,
      ov: ovStr,
    }).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }
    })
  }

  const lut = useMemo(() => colormapLUT('magma'), [])

  // Waveforms: original (top) and processed (bottom), time-normalised so the
  // stretch is visible as a change in how much of the clip fills the width.
  useEffect(() => {
    const ctx = prepareContext(waveRef.current, waveSize)
    if (!ctx) return
    const { width: w, height: h } = waveSize
    const top: Rect = { x: 0, y: 0, w, h: h / 2 }
    const bot: Rect = { x: 0, y: h / 2, w, h: h / 2 }
    fillPlotBg(ctx, top)
    fillPlotBg(ctx, bot)
    grid(ctx, top, 8, 2)
    grid(ctx, bot, 8, 2)
    zeroLine(ctx, top)
    zeroLine(ctx, bot)
    const maxLen = Math.max(src.length, processed.length)
    const drawInto = (r: Rect, sig: Float64Array, color: string) => {
      // Pad-map onto a shared time axis so lengths are comparable.
      const pts = 1400
      const arr = new Float64Array(pts)
      for (let i = 0; i < pts; i++) {
        const t = (i / (pts - 1)) * maxLen
        const idx = Math.round(t)
        arr[i] = idx < sig.length ? sig[idx] : 0
      }
      linePlot(ctx, r, arr, 1.05, color, 1.4)
    }
    drawInto(top, src, '#5eead4')
    drawInto(bot, processed, '#f0a3c8')
    axisLabel(ctx, 'original', 8, 16, 'left')
    axisLabel(ctx, 'processed', 8, h / 2 + 16, 'left')
    axisLabel(ctx, 'shared time axis →', w - 8, h - 8, 'right')
  }, [src, processed, waveSize, waveRef])

  useEffect(() => {
    const ctx = prepareContext(origRef.current, origSize)
    if (!ctx) return
    drawSpectrogram(ctx, { x: 0, y: 0, w: origSize.width, h: origSize.height }, src, lut)
    axisLabel(ctx, 'freq ↑ · time →', origSize.width - 8, origSize.height - 8, 'right')
  }, [src, origSize, lut, origRef])

  useEffect(() => {
    const ctx = prepareContext(procRef.current, procSize)
    if (!ctx) return
    drawSpectrogram(ctx, { x: 0, y: 0, w: procSize.width, h: procSize.height }, processed, lut)
    axisLabel(ctx, 'freq ↑ · time →', procSize.width - 8, procSize.height - 8, 'right')
  }, [processed, procSize, lut, procRef])

  const ratio = Math.pow(2, semitones / 12)
  const isVowel = VOWELS.some((v) => v.id === source)

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Source">
          <Field label="Instrument / vowel">
            <Select value={source} options={SOURCES} onChange={setSource} />
          </Field>
          <Field label="Fundamental (pitch)" value={`${f0} Hz`}>
            <Slider min={80} max={330} step={1} value={f0} onChange={(v) => setF0(Math.round(v))} />
          </Field>
          {isVowel && <Toggle label="Vibrato" checked={vibrato} onChange={setVibrato} />}
        </Panel>

        <Panel title="Transform">
          <Field label="Time-stretch" value={`${stretch.toFixed(2)}×`}>
            <Slider min={0.25} max={4} step={0.05} value={stretch} onChange={setStretch} />
          </Field>
          <Field label="Pitch shift" value={`${semitones > 0 ? '+' : ''}${semitones} st`}>
            <Slider min={-12} max={12} step={1} value={semitones} onChange={(v) => setSemitones(Math.round(v))} />
          </Field>
          <div className="btn-row">
            <Button variant="ghost" onClick={() => { setStretch(1); setSemitones(0) }}>
              Reset (identity)
            </Button>
          </div>
          <Readout
            items={[
              { label: 'Tempo', value: `${(1 / stretch).toFixed(2)}×` },
              { label: 'Pitch', value: `${ratio.toFixed(2)}×` },
              { label: 'Out length', value: `${(processed.length / FS).toFixed(2)} s` },
            ]}
          />
        </Panel>

        <Panel title="STFT settings">
          <Field label="FFT size">
            <Select value={fftStr} options={FFT_SIZES} onChange={setFftStr} />
          </Field>
          <Field label="Overlap">
            <Segmented value={ovStr} options={OVERLAPS} onChange={setOvStr} />
          </Field>
        </Panel>

        <Panel title="Listen &amp; share">
          <div className="btn-row">
            <Button
              variant={playing === 'orig' ? 'default' : 'primary'}
              onClick={() => setPlaying((p) => (p === 'orig' ? null : 'orig'))}
            >
              {playing === 'orig' ? '◼ Original' : '► Original'}
            </Button>
            <Button
              variant={playing === 'proc' ? 'default' : 'primary'}
              onClick={() => setPlaying((p) => (p === 'proc' ? null : 'proc'))}
            >
              {playing === 'proc' ? '◼ Processed' : '► Processed'}
            </Button>
          </div>
          <div className="btn-row">
            <Button variant="ghost" onClick={onShare}>
              {copied ? 'Link copied ✓' : 'Copy link'}
            </Button>
          </div>
          <p className="hint">
            Drag <em>Time-stretch</em> and <em>Pitch shift</em> independently, then A/B the two.
            Stretch changes the tempo without touching the pitch; pitch-shift transposes without
            changing the tempo — the thing a tape recorder <em>cannot</em> do.
          </p>
        </Panel>
      </div>

      <div className="mode-main">
        <p className="mode-intro">
          A <strong>phase vocoder</strong> is the FFT put to work. Chop the sound into overlapping
          frames, transform each, and you can move them <em>closer or further apart in time</em> —
          but only if you first recover how fast each frequency's phase is turning and re-integrate
          it at the new spacing. That one idea decouples <strong>time</strong> from{' '}
          <strong>pitch</strong>: stretch a note without lowering it, or raise it without slowing it
          down. Everything below is computed live on this lab's own FFT.
        </p>
        <CanvasCard title="Waveforms" note="original · processed, on a shared time axis" height={190}>
          <canvas ref={waveRef} />
        </CanvasCard>
        <CanvasCard title="Original spectrogram" note="STFT magnitude · 70 dB window" height={200}>
          <canvas ref={origRef} />
        </CanvasCard>
        <CanvasCard
          title="Processed spectrogram"
          note="wider ⇒ time-stretched · bands shifted ⇒ pitch-shifted"
          height={200}
        >
          <canvas ref={procRef} />
        </CanvasCard>
      </div>
    </div>
  )
}
