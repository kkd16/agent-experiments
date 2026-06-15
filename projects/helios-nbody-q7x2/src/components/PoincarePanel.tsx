// The Poincaré Lab: render a test particle's surface-of-section in the co-rotating
// frame of the two heaviest bodies. A regular orbit's crossings trace a smooth
// closed curve (an invariant torus); a chaotic orbit's scatter to fill an area.

import { useEffect, useRef } from 'react'
import type { PoincareResult } from '../sim/poincare'
import { POINCARE_BODY_LIMIT } from '../sim/poincare'

interface Props {
  result: PoincareResult | null
  running: boolean
  onRun: () => void
  targetLabel: string
  bodyCount: number
}

function fmt(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a !== 0 && (a >= 1e4 || a < 1e-3)) return v.toExponential(digits - 1)
  return v.toFixed(digits)
}

export function PoincarePanel({ result, running, onRun, targetLabel, bodyCount }: Props) {
  const tooBig = bodyCount > POINCARE_BODY_LIMIT
  const tooSmall = bodyCount < 3
  const disabled = running || tooBig || tooSmall

  const cleanFrame = result && Number.isFinite(result.jacobiSpread) && result.jacobiSpread < 1e-2

  return (
    <div className="chaos-panel">
      <p className="integrator-blurb">
        Stamps a point each time the selected body crosses η = 0 (η̇ &gt; 0) in the{' '}
        <strong>co-rotating frame</strong> of the two heaviest bodies, plotting (ξ, ξ̇). A smooth
        <strong> closed curve</strong> ⇒ a regular torus; a <strong>scattered cloud</strong> ⇒ chaos.
        Cleanest with a dominant binary (Solar System, Three-Body Waltz, Horseshoe).
      </p>
      <div className="spectral-target">
        Test particle: <strong>{targetLabel}</strong>
      </div>
      <button type="button" className="btn primary chaos-run" onClick={onRun} disabled={disabled}>
        {running ? 'Integrating…' : '⊕ Map section'}
      </button>
      {tooBig && (
        <p className="chaos-note">
          System too large (N = {bodyCount.toLocaleString()} &gt; {POINCARE_BODY_LIMIT}). The section
          needs a long shadow integration — pick a smaller scenario.
        </p>
      )}
      {tooSmall && <p className="chaos-note">Need at least three bodies (two primaries + a particle).</p>}

      {result && result.valid && (
        <div className="chaos-result">
          <SectionPlot points={result.points} count={result.count} />
          <div className="diag-readout">
            <Stat label="Crossings" value={result.count.toLocaleString()} />
            <Stat label="Steps" value={result.steps.toLocaleString()} />
            <Stat label="Jacobi C" value={fmt(result.jacobiMean, 3)} />
            <Stat
              label="C spread"
              value={fmt(result.jacobiSpread, 2)}
              cls={cleanFrame ? 'good' : 'warn'}
            />
          </div>
          {!cleanFrame && (
            <p className="chaos-note">
              The two heaviest bodies are not a clean binary here (Jacobi not conserved), so the
              co-rotating frame is only approximate — read the portrait qualitatively.
            </p>
          )}
        </div>
      )}
      {result && !result.valid && (
        <p className="chaos-note">No crossings recorded — the particle never cut the section plane.</p>
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

/** Scatter the section points, time-coloured (early → blue, late → amber). */
function SectionPlot({ points, count }: { points: Float64Array; count: number }) {
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
    if (count < 1) return

    let xmin = Infinity
    let xmax = -Infinity
    let ymin = Infinity
    let ymax = -Infinity
    for (let i = 0; i < count; i++) {
      const x = points[i * 2]
      const y = points[i * 2 + 1]
      if (x < xmin) xmin = x
      if (x > xmax) xmax = x
      if (y < ymin) ymin = y
      if (y > ymax) ymax = y
    }
    // Guard against a degenerate (zero-width) range.
    if (xmax - xmin < 1e-12) { xmin -= 1; xmax += 1 }
    if (ymax - ymin < 1e-12) { ymin -= 1; ymax += 1 }
    const padX = (xmax - xmin) * 0.08
    const padY = (ymax - ymin) * 0.08
    xmin -= padX; xmax += padX; ymin -= padY; ymax += padY
    const pad = 4
    const xOf = (x: number) => pad + ((x - xmin) / (xmax - xmin)) * (w - 2 * pad)
    const yOf = (y: number) => h - pad - ((y - ymin) / (ymax - ymin)) * (h - 2 * pad)

    // Zero axes, if in range.
    ctx.strokeStyle = 'rgba(255,255,255,0.1)'
    ctx.lineWidth = 1
    if (xmin < 0 && xmax > 0) {
      ctx.beginPath(); ctx.moveTo(xOf(0), pad); ctx.lineTo(xOf(0), h - pad); ctx.stroke()
    }
    if (ymin < 0 && ymax > 0) {
      ctx.beginPath(); ctx.moveTo(pad, yOf(0)); ctx.lineTo(w - pad, yOf(0)); ctx.stroke()
    }

    for (let i = 0; i < count; i++) {
      const t = count > 1 ? i / (count - 1) : 0
      const r = Math.round(95 + t * 160)
      const g = Math.round(170 - t * 30)
      const b = Math.round(255 - t * 145)
      ctx.fillStyle = `rgba(${r},${g},${b},0.85)`
      ctx.beginPath()
      ctx.arc(xOf(points[i * 2]), yOf(points[i * 2 + 1]), 1.6, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.font = '10px ui-monospace, monospace'
    ctx.fillText('ξ →', w - 26, h - 4)
    ctx.save()
    ctx.translate(9, 16)
    ctx.fillText('ξ̇ →', 0, 0)
    ctx.restore()
  }, [points, count])

  return <canvas className="plot" ref={ref} style={{ width: '100%', height: 150 }} />
}
