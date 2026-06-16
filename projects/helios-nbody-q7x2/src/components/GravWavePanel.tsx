// The Gravitational-Wave Lab: a self-contained two-body experiment that
// integrates the relative orbit with the 2.5PN radiation reaction, watches it
// INSPIRAL as it radiates gravitational waves, draws the emitted strain "chirp"
// and the frequency sweep, and checks the integrated merger time head-to-head
// against Peters' (1964) closed form. It can also SONIFY the chirp — playing
// the waveform pitch-mapped into the audible band, the way LIGO famously
// rendered GW150914.
//
// All the physics is in `sim/gravwave.ts`; this panel is the controls + the
// three visualisations + the audio. It never touches the live Barnes–Hut engine.

import { useCallback, useEffect, useRef, useState } from 'react'
import { simulateInspiral } from '../sim/gravwave'
import type { InspiralResult } from '../sim/gravwave'
import { Slider } from './primitives'

const DEG = Math.PI / 180

function fmt(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a !== 0 && (a >= 1e4 || a < 1e-3)) return v.toExponential(digits - 1)
  return v.toFixed(digits)
}

const STOP_LABEL: Record<InspiralResult['stopReason'], string> = {
  merger: 'reached the merger target',
  'pn-limit': 'stopped at the edge of the post-Newtonian regime (v/c ≈ 0.42)',
  budget: 'stopped after the step budget (a slow, weak-field inspiral)',
  diverged: 'the orbit left the trusted regime',
}

export function GravWavePanel() {
  const [q, setQ] = useState(0.8) // mass ratio m₂/m₁ (m₁ ≡ 1)
  const [a0, setA0] = useState(36)
  const [e0, setE0] = useState(0)
  const [inclDeg, setInclDeg] = useState(30)
  const [c, setC] = useState(1.5)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<InspiralResult | null>(null)
  const [playing, setPlaying] = useState(false)
  const [audioOk, setAudioOk] = useState(true)
  const audioRef = useRef<AudioContext | null>(null)
  const srcRef = useRef<AudioBufferSourceNode | null>(null)

  const run = () => {
    setRunning(true)
    // Defer so the button can paint "Generating…" before the synchronous solve.
    window.setTimeout(() => {
      const res = simulateInspiral({
        m1: 1, m2: q, g: 1, c, a0, e0,
        inclination: inclDeg * DEG, distance: 100,
        stepsPerOrbit: 110, vcMax: 0.42, endFraction: 0.02, maxSteps: 500_000, samples: 4000,
      })
      setResult(res)
      setRunning(false)
    }, 20)
  }

  const stopAudio = useCallback(() => {
    try { srcRef.current?.stop() } catch { /* already stopped */ }
    srcRef.current = null
    setPlaying(false)
  }, [])

  useEffect(() => () => { stopAudio() }, [stopAudio])

  // Sonify the chirp: synthesise a tone whose pitch follows the GW frequency
  // track (log-mapped into the audible band) with an amplitude that swells toward
  // the merger — the unmistakable rising "whoop". Wrapped in try/catch so a
  // sandboxed/headless context (the catalog thumbnail) just silently no-ops.
  const playChirp = useCallback((res: InspiralResult) => {
    if (playing) { stopAudio(); return }
    try {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) { setAudioOk(false); return }
      let ctx = audioRef.current
      if (!ctx) { ctx = new Ctor(); audioRef.current = ctx }
      if (ctx.state === 'suspended') void ctx.resume()

      const sr = ctx.sampleRate
      const dur = 3.4
      const N = Math.floor(sr * dur)
      const buf = ctx.createBuffer(1, N, sr)
      const ch = buf.getChannelData(0)
      const f = res.fgw
      const L = f.length
      if (L < 2) { setAudioOk(false); return }
      const fmin = Math.max(f[0], 1e-12)
      const fmax = Math.max(f[L - 1], fmin * 1.0001)
      const logLo = Math.log(fmin)
      const logHi = Math.log(fmax)
      const audioLo = 110
      const audioHi = 1500
      let phase = 0
      for (let i = 0; i < N; i++) {
        const u = i / (N - 1) // 0 → 1 over the inspiral
        const idx = Math.min(L - 1, Math.floor(u * (L - 1)))
        const fg = Math.max(f[idx], 1e-12)
        const tNorm = (Math.log(fg) - logLo) / (logHi - logLo + 1e-12)
        const af = audioLo * Math.pow(audioHi / audioLo, Math.max(0, Math.min(1, tNorm)))
        phase += (2 * Math.PI * af) / sr
        // Amplitude swells with frequency, like the real strain envelope.
        let amp = 0.16 * Math.pow(af / audioLo, 0.5)
        if (u < 0.04) amp *= u / 0.04 // fade in
        else if (u > 0.9) amp *= Math.max(0, (1 - u) / 0.1) // fade out
        ch[i] = Math.sin(phase) * amp
      }
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      src.onended = () => { srcRef.current = null; setPlaying(false) }
      srcRef.current = src
      setPlaying(true)
      src.start()
    } catch {
      setAudioOk(false)
      setPlaying(false)
    }
  }, [playing, stopAudio])

  const reached = result?.valid && Number.isFinite(result.ratioMergerTime)
  const ratioOk = reached && Math.abs((result!.ratioMergerTime) - 1) < 0.02
  const ratioWarn = reached && Math.abs((result!.ratioMergerTime) - 1) < 0.08

  return (
    <div className="chaos-panel">
      <p className="integrator-blurb">
        A binary radiates <strong>gravitational waves</strong>, loses orbital energy and{' '}
        <strong>inspirals</strong>. This lab integrates the relative orbit with the{' '}
        <strong>2.5PN radiation reaction</strong>, draws the emitted strain <strong>chirp</strong>,
        and checks the merger time against Peters' (1964){' '}
        <code>t_c = 5c⁵a⁴/256G³m₁m₂M</code> — the physics LIGO detected in 2015.
      </p>

      <Slider
        label="Mass ratio m₂/m₁"
        value={q}
        min={0.15}
        max={1}
        step={0.05}
        onChange={(v) => setQ(v)}
        format={(v) => v.toFixed(2)}
        title="Companion mass relative to the primary. Equal masses (1.0) radiate most strongly and merge fastest."
      />
      <Slider
        label="Initial separation a₀"
        value={a0}
        min={22}
        max={44}
        step={1}
        onChange={(v) => setA0(Math.round(v))}
        format={(v) => v.toFixed(0)}
        title="Starting orbit size. Wider orbits take far longer to inspiral (t_c ∝ a⁴)."
      />
      <Slider
        label="Eccentricity e₀"
        value={e0}
        min={0}
        max={0.7}
        step={0.01}
        onChange={(v) => setE0(v)}
        format={(v) => v.toFixed(2)}
        title="Initial orbit shape. Gravitational radiation bleeds eccentricity fast — watch the orbit circularise."
      />
      <Slider
        label="Inclination ι"
        value={inclDeg}
        min={0}
        max={90}
        step={1}
        onChange={(v) => setInclDeg(Math.round(v))}
        format={(v) => `${v.toFixed(0)}°`}
        title="Viewing angle. Face-on (0°) is purely circular polarisation; edge-on (90°) is linear (h× → 0)."
      />
      <Slider
        label="Speed of light c"
        value={c}
        min={1}
        max={2}
        step={0.05}
        onChange={(v) => setC(v)}
        format={(v) => v.toFixed(2)}
        title="Lower c → stronger gravity → a faster, more relativistic inspiral with fewer cycles."
      />

      <button type="button" className="btn primary chaos-run" onClick={run} disabled={running}>
        {running ? 'Generating…' : '〜 Generate inspiral'}
      </button>

      {result && result.valid && (
        <div className="chaos-result">
          <div className="chaos-verdict">
            <span className={`tag ${ratioOk ? 'good' : ratioWarn ? 'warn' : 'bad'}`}>
              measured / Peters = {fmt(result.ratioMergerTime, 4)}
            </span>
          </div>
          <p className="preset-desc">
            The integrated radiation-reaction inspiral takes the time Peters' formula predicts to{' '}
            {fmt(Math.abs(1 - result.ratioMergerTime) * 100, 2)}% — the radiation-reaction force and
            the closed-form merger time are derived independently, so the agreement validates both.
            The run {STOP_LABEL[result.stopReason]}.
          </p>

          <div className="diag-readout">
            <Stat label="Chirp mass ℳ" value={fmt(result.chirpMass, 3)} />
            <Stat label="Sym. mass ratio η" value={fmt(result.eta, 3)} />
            <Stat label="GW cycles" value={result.cycles.toFixed(0)} />
            <Stat label="f_gw start" value={fmt(result.f0, 3)} />
            <Stat label="f_gw end" value={fmt(result.fEnd, 3)} cls="good" />
            <Stat label="a₀ → a_stop" value={`${fmt(result.a0, 1)}→${fmt(result.aStop, 1)}`} />
          </div>

          <div className="chaos-plot">
            <div className="diag-plot-head">
              <span>Inspiral (relative orbit)</span>
              <span className="drift muted">spiralling in</span>
            </div>
            <Spiral x={result.trajX} y={result.trajY} a0={result.a0} />
          </div>

          <div className="chaos-plot">
            <div className="diag-plot-head">
              <span>Strain h₊(t) — the chirp</span>
              <span className="drift muted">amplitude swells to merger</span>
            </div>
            <WavePlot hp={result.hplus} hx={result.hcross} />
          </div>

          <div className="chaos-plot">
            <div className="diag-plot-head">
              <span>GW frequency f(t)</span>
              <span className="drift muted">sweeping up — the "chirp"</span>
            </div>
            <FreqPlot f={result.fgw} />
          </div>

          {result.stopReason !== 'diverged' && (
            <button
              type="button"
              className={`btn ${playing ? 'paused' : ''} chaos-run`}
              onClick={() => playChirp(result)}
              disabled={!audioOk}
              title="Play the chirp through your speakers — the GW frequency mapped into the audible band"
            >
              {playing ? '■ Stop' : audioOk ? '♪ Hear the chirp' : 'audio unavailable'}
            </button>
          )}
        </div>
      )}

      <div className="mercury-box">
        <div className="mercury-head">Beyond the inspiral</div>
        <p className="preset-desc">
          The lab stops at the edge of the post-Newtonian regime. The final plunge, the{' '}
          <strong>merger</strong> and the black hole's <strong>ringdown</strong> live in the strong
          field, where the quadrupole formula and the 2.5PN expansion break down — those need full
          numerical relativity, beyond what an analytic two-body model can honestly show.
        </p>
      </div>
    </div>
  )
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${cls ?? ''}`}>{value}</span>
    </div>
  )
}

/** The shrinking relative orbit, auto-scaled and hue-ramped over time. */
function Spiral({ x, y, a0 }: { x: Float64Array; y: Float64Array; a0: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = canvas.clientWidth
    const h = 150
    canvas.width = Math.max(1, Math.round(w * dpr))
    canvas.height = Math.max(1, Math.round(h * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(255,255,255,0.02)'
    ctx.fillRect(0, 0, w, h)
    if (x.length < 2) return

    const r = a0 * (1 + 1e-3)
    const s = Math.min(w, h) / 2 / r
    const cx = w / 2
    const cy = h / 2
    const X = (v: number) => cx + v * s
    const Y = (v: number) => cy - v * s

    const N = x.length
    ctx.lineWidth = 1
    let prevX = X(x[0])
    let prevY = Y(y[0])
    for (let k = 1; k < N; k++) {
      const t = k / N
      const rr = Math.round(95 + t * 160)
      const gg = Math.round(160 + t * 50)
      const bb = Math.round(255 - t * 150)
      ctx.strokeStyle = `rgba(${rr},${gg},${bb},0.85)`
      const xx = X(x[k])
      const yy = Y(y[k])
      ctx.beginPath()
      ctx.moveTo(prevX, prevY)
      ctx.lineTo(xx, yy)
      ctx.stroke()
      prevX = xx
      prevY = yy
    }
    // Centre of mass.
    ctx.fillStyle = 'rgba(255,210,120,0.95)'
    ctx.beginPath()
    ctx.arc(cx, cy, 3, 0, Math.PI * 2)
    ctx.fill()
  }, [x, y, a0])
  return <canvas className="plot" ref={ref} style={{ width: '100%', height: 150 }} />
}

/** The strain waveform: h₊ (and faint h×) across the whole inspiral. */
function WavePlot({ hp, hx }: { hp: Float64Array; hx: Float64Array }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = canvas.clientWidth
    const h = 90
    canvas.width = Math.max(1, Math.round(w * dpr))
    canvas.height = Math.max(1, Math.round(h * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(255,255,255,0.02)'
    ctx.fillRect(0, 0, w, h)
    const N = hp.length
    if (N < 2) return
    let peak = 1e-30
    for (let k = 0; k < N; k++) peak = Math.max(peak, Math.abs(hp[k]), Math.abs(hx[k]))
    const mid = h / 2
    const amp = (h / 2) * 0.92
    // mid-line
    ctx.strokeStyle = 'rgba(255,255,255,0.1)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke()
    const draw = (data: Float64Array, color: string, lw: number) => {
      ctx.strokeStyle = color
      ctx.lineWidth = lw
      ctx.beginPath()
      for (let k = 0; k < N; k++) {
        const px = (k / (N - 1)) * w
        const py = mid - (data[k] / peak) * amp
        if (k === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.stroke()
    }
    draw(hx, 'rgba(120,180,255,0.45)', 1)
    draw(hp, 'rgba(122,224,168,0.95)', 1)
  }, [hp, hx])
  return <canvas className="plot" ref={ref} style={{ width: '100%', height: 90 }} />
}

/** The GW frequency sweep f(t) — the chirp, on a log-y axis. */
function FreqPlot({ f }: { f: Float64Array }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = canvas.clientWidth
    const h = 90
    canvas.width = Math.max(1, Math.round(w * dpr))
    canvas.height = Math.max(1, Math.round(h * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(255,255,255,0.02)'
    ctx.fillRect(0, 0, w, h)
    const N = f.length
    if (N < 2) return
    let lo = Infinity
    let hi = -Infinity
    for (let k = 0; k < N; k++) {
      const v = Math.log(Math.max(f[k], 1e-12))
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    if (hi - lo < 1e-9) { hi += 1; lo -= 1 }
    const pad = (hi - lo) * 0.08
    lo -= pad; hi += pad
    ctx.strokeStyle = 'rgba(255,210,120,0.95)'
    ctx.lineWidth = 1.6
    ctx.beginPath()
    for (let k = 0; k < N; k++) {
      const px = (k / (N - 1)) * w
      const v = Math.log(Math.max(f[k], 1e-12))
      const py = h - ((v - lo) / (hi - lo)) * h
      if (k === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.stroke()
    ctx.fillStyle = 'rgba(255,255,255,0.4)'
    ctx.font = '10px ui-monospace, monospace'
    ctx.fillText(`${f[N - 1].toExponential(1)}`, 4, 11)
    ctx.fillText(`${f[0].toExponential(1)}`, 4, h - 4)
  }, [f])
  return <canvas className="plot" ref={ref} style={{ width: '100%', height: 90 }} />
}
