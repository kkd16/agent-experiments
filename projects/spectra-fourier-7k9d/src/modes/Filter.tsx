import { useEffect, useMemo, useState } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Segmented, Readout } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import { SIGNALS, generateSignal, peak } from '../lib/dsp'
import type { SignalName } from '../lib/dsp'
import { makeComplex, magnitude } from '../lib/complex'
import { fft, ifft } from '../lib/fft'
import { fillPlotBg, grid, zeroLine, linePlot, areaPlot, axisLabel } from '../lib/draw'

const N = 1024
const FS = 1024
const HALF = N / 2
type FilterKind = 'low' | 'high' | 'band' | 'notch'

const FILTERS: { id: FilterKind; label: string }[] = [
  { id: 'low', label: 'Low-pass' },
  { id: 'high', label: 'High-pass' },
  { id: 'band', label: 'Band-pass' },
  { id: 'notch', label: 'Notch' },
]

export default function FilterMode() {
  const [signal, setSignal] = useState<SignalName>('twoTone')
  const [noise, setNoise] = useState(0.15)
  const [freq, setFreq] = useState(20)
  const [kind, setKind] = useState<FilterKind>('low')
  const [cutoff, setCutoff] = useState(80)
  const [width, setWidth] = useState(60)
  const [trans, setTrans] = useState(14)

  const { ref: timeRef, size: timeSize } = useDprCanvas()
  const { ref: specRef, size: specSize } = useDprCanvas()

  const raw = useMemo(
    () => generateSignal(signal, N, { freq, fs: FS, amp: 1, noise, seed: 4242 }),
    [signal, freq, noise],
  )

  const gainAt = useMemo(() => {
    const k = Math.max(trans, 1) / 2.2
    const lp = (f: number, edge: number) => 0.5 - 0.5 * Math.tanh((f - edge) / k)
    const hp = (f: number, edge: number) => 1 - lp(f, edge)
    return (f: number): number => {
      switch (kind) {
        case 'low':
          return lp(f, cutoff)
        case 'high':
          return hp(f, cutoff)
        case 'band': {
          const lo = Math.max(0, cutoff - width / 2)
          const hi = cutoff + width / 2
          return hp(f, lo) * lp(f, hi)
        }
        case 'notch': {
          const lo = Math.max(0, cutoff - width / 2)
          const hi = cutoff + width / 2
          return 1 - hp(f, lo) * lp(f, hi)
        }
      }
    }
  }, [kind, cutoff, width, trans])

  const result = useMemo(() => {
    const c = makeComplex(N)
    c.re.set(raw)
    const spec = fft(c)
    // Symmetric gain so the output stays real.
    const filtered = makeComplex(N)
    const response = new Float64Array(HALF)
    for (let bin = 0; bin < N; bin++) {
      const foldBin = bin <= HALF ? bin : N - bin
      const f = (foldBin * FS) / N
      const g = gainAt(f)
      filtered.re[bin] = spec.re[bin] * g
      filtered.im[bin] = spec.im[bin] * g
      if (bin < HALF) response[bin] = g
    }
    const out = ifft(filtered)
    const outReal = new Float64Array(N)
    for (let i = 0; i < N; i++) outReal[i] = out.re[i]

    const origMagFull = magnitude(spec)
    const filtMagFull = magnitude(filtered)
    const origMag = new Float64Array(HALF)
    const filtMag = new Float64Array(HALF)
    let maxMag = 1e-9
    for (let k = 0; k < HALF; k++) {
      origMag[k] = (2 * origMagFull[k]) / N
      filtMag[k] = (2 * filtMagFull[k]) / N
      maxMag = Math.max(maxMag, origMag[k])
    }
    return { outReal, origMag, filtMag, response, maxMag }
  }, [raw, gainAt])

  // Time domain overlay.
  useEffect(() => {
    const ctx = prepareContext(timeRef.current, timeSize)
    if (!ctx) return
    const { width: w, height: h } = timeSize
    const r = { x: 0, y: 0, w, h }
    fillPlotBg(ctx, r)
    grid(ctx, r, 8, 4)
    zeroLine(ctx, r)
    const range = Math.max(peak(raw), 1e-3) * 1.1
    linePlot(ctx, r, raw, range, 'rgba(154,166,212,0.4)', 1.3)
    linePlot(ctx, r, result.outReal, range, '#5eead4', 2.2)
    axisLabel(ctx, 'input', 8, 15, 'left')
    axisLabel(ctx, 'filtered output', w - 8, 15, 'right')
  }, [raw, result, timeSize, timeRef])

  // Spectrum overlay with filter response.
  useEffect(() => {
    const ctx = prepareContext(specRef.current, specSize)
    if (!ctx) return
    const { width: w, height: h } = specSize
    const r = { x: 0, y: 0, w, h }
    fillPlotBg(ctx, r)
    grid(ctx, r, 8, 4)
    const scale = result.maxMag * 1.08
    areaPlot(ctx, r, result.origMag, scale, 'rgba(154,166,212,0.5)', 'rgba(154,166,212,0.12)')
    areaPlot(ctx, r, result.filtMag, scale, '#38bdf8', 'rgba(56,189,248,0.2)')
    // filter response curve 0..1 over full height
    ctx.strokeStyle = '#a78bfa'
    ctx.lineWidth = 2
    ctx.setLineDash([5, 4])
    ctx.beginPath()
    for (let k = 0; k < HALF; k++) {
      const x = (k / (HALF - 1)) * w
      const y = r.h - result.response[k] * r.h * 0.96
      if (k === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
    ctx.setLineDash([])
    for (const f of [0, 128, 256, 384, 512]) {
      const x = (f / (FS / 2)) * w
      axisLabel(ctx, `${f}`, Math.min(w - 4, Math.max(12, x)), h - 8, 'center')
    }
    axisLabel(ctx, 'response', w - 8, 15, 'right')
    axisLabel(ctx, 'Hz →', w - 8, h - 8, 'right')
  }, [result, specSize, specRef])

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Source signal">
          <Field label="Waveform">
            <Select value={signal} options={SIGNALS} onChange={setSignal} />
          </Field>
          <Field label="Frequency" value={`${freq} Hz`}>
            <Slider min={4} max={80} step={1} value={freq} onChange={(v) => setFreq(Math.round(v))} />
          </Field>
          <Field label="Added noise" value={noise.toFixed(2)}>
            <Slider min={0} max={0.5} step={0.01} value={noise} onChange={setNoise} />
          </Field>
        </Panel>

        <Panel title="Filter">
          <Segmented value={kind} options={FILTERS} onChange={setKind} />
          <Field label={kind === 'band' || kind === 'notch' ? 'Center' : 'Cutoff'} value={`${cutoff} Hz`}>
            <Slider min={4} max={480} step={1} value={cutoff} onChange={(v) => setCutoff(Math.round(v))} />
          </Field>
          {(kind === 'band' || kind === 'notch') && (
            <Field label="Bandwidth" value={`${width} Hz`}>
              <Slider min={8} max={240} step={1} value={width} onChange={(v) => setWidth(Math.round(v))} />
            </Field>
          )}
          <Field label="Transition" value={`${trans} Hz`}>
            <Slider min={1} max={60} step={1} value={trans} onChange={(v) => setTrans(Math.round(v))} />
          </Field>
          <Readout
            items={[
              { label: 'Type', value: FILTERS.find((f) => f.id === kind)!.label.split('-')[0] },
              { label: 'Cutoff', value: `${cutoff}` },
              { label: 'Steepness', value: trans <= 4 ? 'sharp' : trans <= 20 ? 'med' : 'soft' },
            ]}
          />
        </Panel>
      </div>

      <div className="mode-main">
        <p className="mode-intro">
          Filtering is multiplication in the frequency domain. We take the FFT, multiply every bin
          by the <strong>filter response</strong> (the dashed purple curve), then run the inverse
          FFT back to a signal. Add noise to a tone and watch a <em>low-pass</em> scrub it away, or
          use a <em>notch</em> to surgically remove one frequency.
        </p>
        <CanvasCard title="Time domain" note="input vs filtered output" height={220}>
          <canvas ref={timeRef} />
        </CanvasCard>
        <CanvasCard title="Spectrum & filter response" note="original · filtered · H(f)" height={260}>
          <canvas ref={specRef} />
        </CanvasCard>
      </div>
    </div>
  )
}
