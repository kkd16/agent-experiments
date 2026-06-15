// The Spectral Lab: run NAFF (Numerical Analysis of Fundamental Frequencies) on a
// body's orbit, recover its line spectrum and fundamental frequency, and report
// the frequency-map diffusion — an independent, frequency-domain chaos indicator
// that complements the Chaos Lab's time-domain MEGNO/Lyapunov.

import { useEffect, useRef } from 'react'
import type { DiffusionClass, FreqDiffusion, NaffResult, SpectralLine } from '../sim/naff'
import { Segmented, Slider } from './primitives'

export const SPECTRAL_BODY_LIMIT = 3000

interface Props {
  result: NaffResult | null
  diffusion: FreqDiffusion | null
  running: boolean
  terms: number
  onTerms: (n: number) => void
  refMode: 'heaviest' | 'barycenter'
  onRefMode: (m: 'heaviest' | 'barycenter') => void
  onRun: () => void
  targetLabel: string
  bodyCount: number
}

const DIFF_LABEL: Record<DiffusionClass, string> = {
  regular: 'Regular',
  'weakly-chaotic': 'Weakly chaotic',
  chaotic: 'Chaotic',
}
const DIFF_TAG: Record<DiffusionClass, string> = {
  regular: 'good',
  'weakly-chaotic': 'warn',
  chaotic: 'bad',
}

function fmt(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return '∞'
  const a = Math.abs(v)
  if (a !== 0 && (a >= 1e4 || a < 1e-3)) return v.toExponential(digits - 1)
  return v.toFixed(digits)
}

export function SpectralPanel(p: Props) {
  const tooBig = p.bodyCount > SPECTRAL_BODY_LIMIT
  const tooSmall = p.bodyCount < 2
  const disabled = p.running || tooBig || tooSmall

  const r = p.result
  const fund = r && r.fundamental > 0 ? r.fundamental : 0
  const period = fund > 0 ? (2 * Math.PI) / fund : 0
  const trackTime = r ? r.dt * (r.samples - 1) : 0
  const periodsCovered = period > 0 ? trackTime / period : 0

  return (
    <div className="chaos-panel">
      <p className="integrator-blurb">
        Decomposes a body's orbit z(t) = x + i·y into pure tones via{' '}
        <strong>NAFF</strong> (Laskar) — a Hann-windowed correlation refined below
        FFT-bin resolution. Recovers the <strong>fundamental frequency</strong>,
        the harmonic spectrum, and a <strong>frequency-diffusion</strong> chaos
        index. Best on small systems.
      </p>
      <div className="spectral-target">
        Target body: <strong>{p.targetLabel}</strong>
      </div>
      <Segmented<'heaviest' | 'barycenter'>
        label="Frame about"
        value={p.refMode}
        options={[
          { value: 'heaviest', label: 'Heaviest', title: 'Coordinates relative to the most massive body' },
          { value: 'barycenter', label: 'Barycentre', title: 'Coordinates relative to the system centre of mass' },
        ]}
        onChange={p.onRefMode}
      />
      <Slider
        label="Spectral lines"
        value={p.terms}
        min={2}
        max={10}
        step={1}
        onChange={(v) => p.onTerms(Math.round(v))}
        format={(v) => `${v} tones`}
        title="How many frequencies NAFF peels off the signal (more resolves finer harmonics)"
      />
      <button type="button" className="btn primary chaos-run" onClick={p.onRun} disabled={disabled}>
        {p.running ? 'Analysing…' : '⋀ Analyse spectrum'}
      </button>
      {tooBig && (
        <p className="chaos-note">
          System too large (N = {p.bodyCount.toLocaleString()} &gt; {SPECTRAL_BODY_LIMIT}). NAFF
          integrates a long shadow track — pick a smaller scenario.
        </p>
      )}
      {tooSmall && <p className="chaos-note">Need at least two bodies to analyse an orbit.</p>}

      {r && r.terms > 0 && (
        <div className="chaos-result">
          {p.diffusion && p.diffusion.valid && (
            <>
              <div className="chaos-verdict">
                <span className={`tag ${DIFF_TAG[p.diffusion.classification]}`}>
                  {DIFF_LABEL[p.diffusion.classification]}
                </span>
                <span className="muted spectral-diff">
                  log₁₀|Δν/ν| = {fmt(p.diffusion.logDiffusion, 2)}
                </span>
              </div>
              <p className="preset-desc">
                Frequency-map diffusion: the fundamental drifts by {fmt(p.diffusion.diffusion, 3)} between
                the first and second halves of the orbit. Near-zero ⇒ a frozen frequency ⇒ a regular
                torus; a measurable drift ⇒ the orbit is wandering across resonances ⇒ chaos.
              </p>
            </>
          )}
          <div className="diag-readout">
            <Stat label="Fundamental ν" value={fmt(fund, 5)} />
            <Stat label="Period 2π/ν" value={fmt(period, 3)} />
            <Stat label="Direction" value={r.fundamentalSigned >= 0 ? 'prograde' : 'retrograde'} />
            <Stat label="Periods covered" value={periodsCovered > 0 ? periodsCovered.toFixed(1) : '—'} />
            <Stat
              label="Recon. error"
              value={fmt(r.reconError, 2)}
              cls={r.reconError < 0.05 ? 'good' : r.reconError < 0.2 ? '' : 'warn'}
            />
            <Stat label="Lines" value={r.terms.toLocaleString()} />
          </div>

          <div className="chaos-plot">
            <div className="diag-plot-head">
              <span>Line spectrum (amplitude vs ω)</span>
              <span className="drift muted">retro ← 0 → pro</span>
            </div>
            <Spectrum lines={r.lines} />
          </div>

          <div className="spectral-lines">
            {r.lines.slice(0, 6).map((ln, i) => (
              <LineRow key={i} line={ln} rel={ln.amp / (r.lines[0]?.amp || 1)} primary={i === 0} />
            ))}
          </div>
        </div>
      )}
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

function LineRow({ line, rel, primary }: { line: SpectralLine; rel: number; primary: boolean }) {
  return (
    <div className={`spectral-line ${primary ? 'primary' : ''}`}>
      <span className="sl-omega">ω={line.omega.toFixed(4)}</span>
      <div className="sl-bar-track">
        <div className="sl-bar" style={{ width: `${Math.max(2, rel * 100)}%` }} />
      </div>
      <span className="sl-amp">{rel.toFixed(2)}</span>
    </div>
  )
}

/** A stick (stem) spectrum: amplitude bars at each line's signed frequency. */
function Spectrum({ lines }: { lines: SpectralLine[] }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = canvas.clientWidth
    const h = 64
    canvas.width = Math.max(1, Math.round(w * dpr))
    canvas.height = Math.max(1, Math.round(h * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(255,255,255,0.02)'
    ctx.fillRect(0, 0, w, h)

    if (lines.length === 0) return
    let omegaMax = 1e-9
    let ampMax = 1e-30
    for (const ln of lines) {
      omegaMax = Math.max(omegaMax, Math.abs(ln.omega))
      ampMax = Math.max(ampMax, ln.amp)
    }
    omegaMax *= 1.15
    const pad = 6
    const baseY = h - 14
    const xOf = (omega: number) => w / 2 + (omega / omegaMax) * (w / 2 - pad)
    const hOf = (amp: number) => (amp / ampMax) * (baseY - pad)

    // Zero-frequency axis.
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(w / 2, 2)
    ctx.lineTo(w / 2, baseY)
    ctx.moveTo(pad, baseY)
    ctx.lineTo(w - pad, baseY)
    ctx.stroke()

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]
      const x = xOf(ln.omega)
      const barH = hOf(ln.amp)
      ctx.strokeStyle = i === 0 ? 'rgba(255,200,120,0.95)' : 'rgba(95,208,255,0.8)'
      ctx.lineWidth = i === 0 ? 2.4 : 1.6
      ctx.beginPath()
      ctx.moveTo(x, baseY)
      ctx.lineTo(x, baseY - barH)
      ctx.stroke()
      ctx.fillStyle = ctx.strokeStyle
      ctx.beginPath()
      ctx.arc(x, baseY - barH, i === 0 ? 2.6 : 1.8, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.fillStyle = 'rgba(255,255,255,0.4)'
    ctx.font = '10px ui-monospace, monospace'
    ctx.fillText(`±${omegaMax.toFixed(3)}`, w - 52, h - 2)
    ctx.fillText('0', w / 2 - 3, h - 2)
  }, [lines])

  return <canvas className="plot" ref={ref} style={{ width: '100%', height: 64 }} />
}
