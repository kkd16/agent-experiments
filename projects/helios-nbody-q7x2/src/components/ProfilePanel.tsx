// The 1-D Frequency Map — Laskar's frequency-map cross-section.
//
// The Resonance Atlas paints the (a, e) plane; this is its quantitative slice. At
// a fixed eccentricity it sweeps the semimajor axis and plots two curves: the
// measured mean motion n(a) — a monotone *staircase* whose flats are the
// resonance plateaus — and the frequency diffusion log₁₀|Δn/n|(a), whose spikes
// mark exactly the chaotic mean-motion resonances. Reading a resonance straight
// off the graph (a flat in n lining up with a spike in D, at a where n = p/q) is
// the original frequency-map analysis (Laskar 1990).

import { useCallback, useEffect, useRef, useState } from 'react'
import { ATLAS_MODELS, atlasModelById, computeCell, resonanceLines } from '../sim/fma'
import type { ProfilePoint } from '../sim/fma'
import { Select, Slider } from './primitives'

const SCAN_OPTS = { samples: 256, periods: 30, minSub: 10 }

export function ProfilePanel() {
  const [modelId, setModelId] = useState('belt')
  const [ecc, setEcc] = useState(0.1)
  const [count] = useState(160)
  const [computing, setComputing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [done, setDone] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const model = atlasModelById(modelId)
  const scan = useRef<{ running: boolean; idx: number; data: ProfilePoint[]; raf: number } | null>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const s = scan.current
    if (!canvas || !s) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = canvas.clientWidth
    const h = 220
    canvas.width = Math.max(1, Math.round(w * dpr))
    canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const data = s.data
    const aMin = model.aMin
    const aMax = model.aMax
    const xOf = (a: number) => ((a - aMin) / (aMax - aMin)) * w

    // Two stacked panels: n(a) on top, D(a) on the bottom.
    const gap = 18
    const topH = (h - gap) * 0.5
    const botY = topH + gap
    const botH = h - botY

    // n range from the band (n = a^{-3/2}), padded.
    const nHi = Math.pow(aMin, -1.5)
    const nLo = Math.pow(aMax, -1.5)
    const nPad = (nHi - nLo) * 0.08
    const yN = (n: number) => topH - ((n - (nLo - nPad)) / (nHi - nLo + 2 * nPad)) * topH
    const yD = (d: number) => botY + botH - ((d - (-8)) / (-1 - -8)) * botH

    // Backgrounds.
    ctx.fillStyle = 'rgba(255,255,255,0.02)'
    ctx.fillRect(0, 0, w, topH)
    ctx.fillRect(0, botY, w, botH)

    // Resonance vertical guides on both panels.
    ctx.font = '9px ui-monospace, monospace'
    for (const { a, p, q } of resonanceLines(aMin, aMax)) {
      const x = xOf(a)
      ctx.strokeStyle = 'rgba(255,255,255,0.16)'
      ctx.setLineDash([3, 3])
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(255,255,255,0.45)'
      ctx.fillText(`${p}:${q}`, x + 2, 9)
    }

    if (data.length > 1) {
      // n(a) staircase.
      ctx.strokeStyle = 'rgba(95,208,255,0.95)'
      ctx.lineWidth = 1.6
      ctx.beginPath()
      let started = false
      for (const pt of data) {
        if (!Number.isFinite(pt.freq)) { started = false; continue }
        const x = xOf(pt.a); const y = yN(pt.freq)
        if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
      }
      ctx.stroke()

      // D(a) diffusion profile (filled under the curve), coloured by level.
      ctx.lineWidth = 1.4
      ctx.beginPath()
      started = false
      for (const pt of data) {
        if (!Number.isFinite(pt.logDiff)) { started = false; continue }
        const x = xOf(pt.a); const y = yD(Math.max(-8, Math.min(-1, pt.logDiff)))
        if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = 'rgba(255,170,90,0.95)'
      ctx.stroke()
      // Chaos threshold line at D = −2.5.
      ctx.strokeStyle = 'rgba(255,80,80,0.4)'
      ctx.setLineDash([2, 3])
      ctx.beginPath(); ctx.moveTo(0, yD(-2.5)); ctx.lineTo(w, yD(-2.5)); ctx.stroke()
      ctx.setLineDash([])
    }

    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '10px ui-monospace, monospace'
    ctx.fillText('n(a)', 4, 12)
    ctx.fillText('log|Δn/n|(a)', 4, botY + 12)
    ctx.fillText(`a →  ${aMin}…${aMax}`, w - 86, h - 3)
  }, [model])

  const stop = useCallback(() => {
    const s = scan.current
    if (s) { s.running = false; cancelAnimationFrame(s.raf) }
    setComputing(false)
  }, [])

  const start = useCallback(() => {
    stop()
    const data: ProfilePoint[] = []
    const s = { running: true, idx: 0, data, raf: 0 }
    scan.current = s
    setComputing(true)
    setDone(false)
    setProgress(0)
    const tick = () => {
      if (!s.running) return
      const t0 = performance.now()
      while (s.idx < count && performance.now() - t0 < 14) {
        const a = model.aMin + ((s.idx + 0.5) / count) * (model.aMax - model.aMin)
        const c = computeCell(a, ecc, model.mu, SCAN_OPTS)
        data.push({ a, freq: c.valid ? c.freq : NaN, logDiff: c.valid ? c.logDiffusion : NaN, valid: c.valid })
        s.idx++
      }
      draw()
      setProgress(s.idx / count)
      if (s.idx >= count) { s.running = false; setComputing(false); setDone(true); return }
      s.raf = requestAnimationFrame(tick)
    }
    s.raf = requestAnimationFrame(tick)
  }, [count, model, ecc, draw, stop])

  useEffect(() => () => stop(), [stop])

  return (
    <div className="chaos-panel">
      <p className="integrator-blurb">
        The Atlas's quantitative slice. At a fixed eccentricity it sweeps the semimajor axis and plots
        the mean motion <strong>n(a)</strong> — a staircase whose flats are <strong>resonance
        plateaus</strong> — over the diffusion <strong>log₁₀|Δn/n|(a)</strong>, whose spikes mark the
        chaotic resonances. A flat in <em>n</em> lined up with a spike in <em>D</em> at n = p/q is a
        mean-motion resonance, read straight off the graph.
      </p>
      <Select<string>
        label="Model"
        value={modelId}
        options={ATLAS_MODELS.map((m) => ({ value: m.id, label: m.name }))}
        onChange={(v) => { stop(); setModelId(v); setDone(false) }}
      />
      <Slider
        label="Eccentricity e"
        value={ecc}
        min={0}
        max={0.5}
        step={0.02}
        onChange={(v) => { stop(); setEcc(v); setDone(false) }}
        format={(v) => v.toFixed(2)}
        title="The fixed eccentricity of the swept orbits"
      />
      <button type="button" className="btn primary chaos-run" onClick={() => (computing ? stop() : start())}>
        {computing ? `■ Stop (${Math.round(progress * 100)}%)` : done ? '↻ Recompute profile' : '⌁ Compute profile'}
      </button>
      {computing && (
        <div className="atlas-progress">
          <div className="atlas-progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      <div className="atlas-wrap">
        <canvas ref={canvasRef} className="plot" style={{ width: '100%', height: 220 }} />
      </div>
    </div>
  )
}
