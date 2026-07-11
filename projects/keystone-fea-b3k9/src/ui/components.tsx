// Presentational building blocks for the studio panels.

import { useEffect, useMemo, useRef, useState } from 'react'
import { COLORMAP_STOPS, type Colormap } from './colormap'
import { runAllBenchmarks, type Check } from '../engine/validate'
import type { FrfCurve } from '../engine/harmonic'
import type { PushoverResult } from '../engine/plastic'
import { fmtEng } from './format'

export function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={o.value}
          className={o.value === value ? 'seg active' : 'seg'}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
  format,
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
  onChange: (v: number) => void
  format?: (v: number) => string
}) {
  return (
    <label className="slider">
      <div className="slider-row">
        <span>{label}</span>
        <span className="slider-val">{format ? format(value) : value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </label>
  )
}

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

export function Legend({
  colormap,
  min,
  max,
  unit,
  label,
}: {
  colormap: Colormap
  min: number
  max: number
  unit: string
  label: string
}) {
  const grad = useMemo(() => {
    const stops = COLORMAP_STOPS[colormap]
    return stops.map(([p, c]) => `rgb(${c[0]},${c[1]},${c[2]}) ${(p * 100).toFixed(0)}%`).join(', ')
  }, [colormap])
  return (
    <div className="legend">
      <div className="legend-label">{label}</div>
      <div className="legend-bar" style={{ background: `linear-gradient(90deg, ${grad})` }} />
      <div className="legend-scale">
        <span>{fmtEng(min, unit)}</span>
        <span>{fmtEng((min + max) / 2, unit)}</span>
        <span>{fmtEng(max, unit)}</span>
      </div>
    </div>
  )
}

/**
 * The frequency-response function, drawn as a log–log resonance curve: the
 * output-DOF amplitude against drive frequency, with a dashed marker at every
 * natural frequency and a live cursor at the current drive frequency. This is
 * the signature plot of forced vibration — flat compliance, then a spike at each
 * resonance.
 */
export function FrfPlot({
  curve,
  driveHz,
  onPick,
}: {
  curve: FrfCurve
  driveHz: number
  onPick?: (hz: number) => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const W = 300
  const H = 168
  const box = useMemo(() => {
    const pad = { l: 40, r: 8, t: 10, b: 26 }
    const hzMin = Math.max(curve.omegaMin / (2 * Math.PI), 1e-4)
    const hzMax = curve.omegaMax / (2 * Math.PI)
    // Log-magnitude range, padded a decade below the peak.
    const magMax = Math.max(curve.magMax, 1e-30)
    const magMin = Math.max(magMax / 1e4, curve.refMag / 10, 1e-30)
    return { pad, hzMin, hzMax, magMax, magMin }
  }, [curve])

  const xOf = useMemo(() => {
    const { pad, hzMin, hzMax } = box
    const lx0 = Math.log10(hzMin)
    const lx1 = Math.log10(hzMax)
    return (hz: number) => pad.l + ((Math.log10(Math.max(hz, hzMin)) - lx0) / (lx1 - lx0)) * (W - pad.l - pad.r)
  }, [box])
  const yOf = useMemo(() => {
    const { pad, magMin, magMax } = box
    const ly0 = Math.log10(magMin)
    const ly1 = Math.log10(magMax)
    return (m: number) => pad.t + (1 - (Math.log10(Math.max(m, magMin)) - ly0) / (ly1 - ly0)) * (H - pad.t - pad.b)
  }, [box])

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cv.width = W * dpr
    cv.height = H * dpr
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    const { pad } = box
    // frame
    ctx.strokeStyle = '#2c3346'
    ctx.lineWidth = 1
    ctx.strokeRect(pad.l, pad.t, W - pad.l - pad.r, H - pad.t - pad.b)

    // decade gridlines (x) with labels
    ctx.fillStyle = '#626b81'
    ctx.font = '9px ui-monospace, monospace'
    ctx.textAlign = 'center'
    const decHi = Math.ceil(Math.log10(box.hzMax))
    const decLo = Math.floor(Math.log10(box.hzMin))
    for (let d = decLo; d <= decHi; d++) {
      const hz = Math.pow(10, d)
      if (hz < box.hzMin || hz > box.hzMax) continue
      const x = xOf(hz)
      ctx.strokeStyle = 'rgba(44,51,70,0.6)'
      ctx.beginPath()
      ctx.moveTo(x, pad.t)
      ctx.lineTo(x, H - pad.b)
      ctx.stroke()
      ctx.fillText(hz >= 1 ? `${hz}` : `${hz}`, x, H - pad.b + 12)
    }
    // y decade gridlines
    const lyHi = Math.ceil(Math.log10(box.magMax))
    const lyLo = Math.floor(Math.log10(box.magMin))
    ctx.textAlign = 'right'
    for (let d = lyLo; d <= lyHi; d++) {
      const m = Math.pow(10, d)
      const y = yOf(m)
      if (y < pad.t || y > H - pad.b) continue
      ctx.strokeStyle = 'rgba(44,51,70,0.45)'
      ctx.beginPath()
      ctx.moveTo(pad.l, y)
      ctx.lineTo(W - pad.r, y)
      ctx.stroke()
      ctx.fillText(`1e${d}`, pad.l - 4, y + 3)
    }

    // resonance markers
    for (const p of curve.peaks) {
      const x = xOf(p.hz)
      if (x < pad.l || x > W - pad.r) continue
      ctx.strokeStyle = 'rgba(245,167,66,0.55)'
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(x, pad.t)
      ctx.lineTo(x, H - pad.b)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // the FRF curve
    ctx.strokeStyle = '#6ea8ff'
    ctx.lineWidth = 1.6
    ctx.beginPath()
    curve.samples.forEach((s, i) => {
      const x = xOf(s.hz)
      const y = yOf(s.mag)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()

    // peak dots
    ctx.fillStyle = '#f5a742'
    for (const p of curve.peaks) {
      const x = xOf(p.hz)
      const y = yOf(p.mag)
      if (x < pad.l || x > W - pad.r) continue
      ctx.beginPath()
      ctx.arc(x, y, 2.4, 0, 2 * Math.PI)
      ctx.fill()
    }

    // drive cursor
    const cx = xOf(driveHz)
    if (cx >= pad.l && cx <= W - pad.r) {
      ctx.strokeStyle = '#4ade80'
      ctx.lineWidth = 1.4
      ctx.beginPath()
      ctx.moveTo(cx, pad.t)
      ctx.lineTo(cx, H - pad.b)
      ctx.stroke()
    }

    // axis captions
    ctx.fillStyle = '#8b93a7'
    ctx.textAlign = 'center'
    ctx.fillText('drive frequency (Hz)', (pad.l + W - pad.r) / 2, H - 2)
  }, [curve, driveHz, box, xOf, yOf])

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onPick) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const { pad } = box
    const lx0 = Math.log10(box.hzMin)
    const lx1 = Math.log10(box.hzMax)
    const frac = (x - pad.l) / (W - pad.l - pad.r)
    const hz = Math.pow(10, lx0 + frac * (lx1 - lx0))
    onPick(Math.max(box.hzMin, Math.min(box.hzMax, hz)))
  }

  return (
    <canvas
      ref={ref}
      className="frf-plot"
      style={{ width: W, height: H, cursor: onPick ? 'crosshair' : 'default' }}
      onClick={handleClick}
    />
  )
}

/**
 * The pushover capacity curve: load factor λ against control deflection. It
 * rises elastically, softens (a slope drop) at each plastic hinge — marked with
 * a dot — and flat-tops at the collapse load factor once the mechanism forms.
 * A green cursor tracks the current load state; click to scrub the analysis.
 */
export function CapacityCurvePlot({
  res,
  cursor,
  onScrub,
}: {
  res: PushoverResult
  cursor: { disp: number; lambda: number }
  onScrub?: (s: number) => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const W = 300
  const H = 170
  const box = useMemo(() => {
    const pad = { l: 42, r: 10, t: 12, b: 28 }
    let dMax = 1e-30
    let lMax = 1e-30
    for (const p of res.curve) {
      dMax = Math.max(dMax, Math.abs(p.disp))
      lMax = Math.max(lMax, p.lambda)
    }
    dMax = Math.max(dMax, Math.abs(cursor.disp), 1e-9) * 1.05
    lMax = Math.max(lMax, cursor.lambda, 1e-9) * 1.12
    return { pad, dMax, lMax }
  }, [res, cursor])

  const xOf = useMemo(() => {
    const { pad, dMax } = box
    return (d: number) => pad.l + (Math.abs(d) / dMax) * (W - pad.l - pad.r)
  }, [box])
  const yOf = useMemo(() => {
    const { pad, lMax } = box
    return (l: number) => H - pad.b - (l / lMax) * (H - pad.t - pad.b)
  }, [box])

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cv.width = W * dpr
    cv.height = H * dpr
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    const { pad } = box
    ctx.strokeStyle = '#2c3346'
    ctx.lineWidth = 1
    ctx.strokeRect(pad.l, pad.t, W - pad.l - pad.r, H - pad.t - pad.b)

    // y gridlines + labels (load factor)
    ctx.fillStyle = '#626b81'
    ctx.font = '9px ui-monospace, monospace'
    ctx.textAlign = 'right'
    const ticks = 4
    for (let i = 0; i <= ticks; i++) {
      const l = (box.lMax * i) / ticks
      const y = yOf(l)
      ctx.strokeStyle = 'rgba(44,51,70,0.5)'
      ctx.beginPath()
      ctx.moveTo(pad.l, y)
      ctx.lineTo(W - pad.r, y)
      ctx.stroke()
      ctx.fillStyle = '#626b81'
      ctx.fillText(l.toFixed(l < 10 ? 1 : 0), pad.l - 4, y + 3)
    }

    // first-yield reference line
    const yFirst = yOf(res.firstYieldLambda)
    ctx.strokeStyle = 'rgba(110,168,255,0.4)'
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(pad.l, yFirst)
    ctx.lineTo(W - pad.r, yFirst)
    ctx.stroke()
    ctx.setLineDash([])

    // collapse plateau reference
    const yColl = yOf(res.collapseLambda)
    ctx.strokeStyle = 'rgba(245,167,66,0.45)'
    ctx.setLineDash([2, 3])
    ctx.beginPath()
    ctx.moveTo(pad.l, yColl)
    ctx.lineTo(W - pad.r, yColl)
    ctx.stroke()
    ctx.setLineDash([])

    // filled area under the capacity curve
    ctx.beginPath()
    ctx.moveTo(xOf(0), yOf(0))
    for (const p of res.curve) ctx.lineTo(xOf(p.disp), yOf(p.lambda))
    ctx.lineTo(xOf(res.curve[res.curve.length - 1].disp), yOf(0))
    ctx.closePath()
    ctx.fillStyle = 'rgba(110,168,255,0.10)'
    ctx.fill()

    // the capacity curve
    ctx.strokeStyle = '#6ea8ff'
    ctx.lineWidth = 1.8
    ctx.beginPath()
    ctx.moveTo(xOf(0), yOf(0))
    for (const p of res.curve) ctx.lineTo(xOf(p.disp), yOf(p.lambda))
    ctx.stroke()

    // hinge-event dots
    ctx.fillStyle = '#ff5d3b'
    for (let i = 1; i <= res.events.length && i < res.curve.length; i++) {
      const p = res.curve[i]
      ctx.beginPath()
      ctx.arc(xOf(p.disp), yOf(p.lambda), 2.8, 0, 2 * Math.PI)
      ctx.fill()
    }

    // live cursor
    const cx = xOf(cursor.disp)
    const cy = yOf(cursor.lambda)
    ctx.strokeStyle = 'rgba(74,222,128,0.6)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(cx, pad.t)
    ctx.lineTo(cx, H - pad.b)
    ctx.stroke()
    ctx.fillStyle = '#4ade80'
    ctx.beginPath()
    ctx.arc(cx, cy, 3.4, 0, 2 * Math.PI)
    ctx.fill()

    // captions
    ctx.fillStyle = '#8b93a7'
    ctx.textAlign = 'center'
    ctx.fillText('control deflection', (pad.l + W - pad.r) / 2, H - 3)
    ctx.save()
    ctx.translate(11, (pad.t + H - pad.b) / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.fillText('load factor λ', 0, 0)
    ctx.restore()
  }, [res, cursor, box, xOf, yOf])

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onScrub) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * W
    const { pad } = box
    const frac = Math.max(0, Math.min(1, (x - pad.l) / (W - pad.l - pad.r)))
    const d = frac * box.dMax
    // Map the clicked deflection to a pseudo-time s along the piecewise curve.
    const c = res.curve
    let s = c.length - 1
    for (let i = 0; i < c.length - 1; i++) {
      const d0 = Math.abs(c[i].disp)
      const d1 = Math.abs(c[i + 1].disp)
      if (d <= d1 || i === c.length - 2) {
        const seg = d1 - d0
        s = i + (seg > 1e-30 ? Math.max(0, Math.min(1, (d - d0) / seg)) : 0)
        break
      }
    }
    onScrub(s)
  }

  return (
    <canvas
      ref={ref}
      className="frf-plot"
      style={{ width: W, height: H, cursor: onScrub ? 'crosshair' : 'default' }}
      onClick={handleClick}
    />
  )
}

function CheckRow({ c }: { c: Check }) {
  return (
    <div className={c.pass ? 'check pass' : 'check fail'}>
      <span className="check-mark">{c.pass ? '✓' : '✕'}</span>
      <div className="check-body">
        <div className="check-name">{c.name}</div>
        <div className="check-detail">
          <code>{c.detail}</code>
        </div>
        <div className="check-nums">
          expected {fmtEng(c.expected, c.unit)} · got {fmtEng(c.computed, c.unit)} · err{' '}
          {c.relError.toExponential(1)}
        </div>
      </div>
    </div>
  )
}

export function VerifyBadge() {
  const { frame, dynamics, harmonic, plastic, continuum, allPass } = useMemo(() => runAllBenchmarks(), [])
  const [open, setOpen] = useState(false)
  const all = [...frame, ...dynamics, ...harmonic, ...plastic, ...continuum]
  const passCount = all.filter((c) => c.pass).length
  return (
    <div className={`verify ${allPass ? 'ok' : 'bad'}`}>
      <button className="verify-head" onClick={() => setOpen((o) => !o)}>
        <span className="verify-dot" />
        <span className="verify-title">
          {allPass ? 'Verified' : 'Check failed'} — {passCount}/{all.length}
        </span>
        <span className="verify-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="verify-list">
          <p className="verify-note">
            Every result is produced by the same solver that reproduces these closed-form
            benchmarks. Run live in your browser:
          </p>
          <div className="check-group">Frames &amp; trusses</div>
          {frame.map((c, i) => (
            <CheckRow key={`f${i}`} c={c} />
          ))}
          <div className="check-group">Dynamics &amp; stability</div>
          {dynamics.map((c, i) => (
            <CheckRow key={`d${i}`} c={c} />
          ))}
          <div className="check-group">Harmonic response &amp; sections</div>
          {harmonic.map((c, i) => (
            <CheckRow key={`h${i}`} c={c} />
          ))}
          <div className="check-group">Plastic collapse (pushover)</div>
          {plastic.map((c, i) => (
            <CheckRow key={`p${i}`} c={c} />
          ))}
          <div className="check-group">Continuum (plane stress)</div>
          {continuum.map((c, i) => (
            <CheckRow key={`c${i}`} c={c} />
          ))}
        </div>
      )}
    </div>
  )
}
