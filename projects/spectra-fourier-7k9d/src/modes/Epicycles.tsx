import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { CanvasCard } from '../components/CanvasCard'
import { Panel, Field, Slider, Select, Segmented, Toggle, Button, Readout } from '../components/Controls'
import { useDprCanvas, prepareContext } from '../hooks/useDprCanvas'
import { useAnimationFrame } from '../hooks/useAnimationFrame'
import {
  PRESETS,
  presetPath,
  normalizePath,
  computeEpicycles,
  epicyclePositions,
} from '../lib/paths'
import type { Point, PresetName } from '../lib/paths'

type Source = 'preset' | 'draw'

export default function Epicycles() {
  const [source, setSource] = useState<Source>('preset')
  const [preset, setPreset] = useState<PresetName>('treble')
  const [drawn, setDrawn] = useState<Point[] | null>(null)
  const [harmonics, setHarmonics] = useState(60)
  const [speed, setSpeed] = useState(0.18)
  const [running, setRunning] = useState(true)
  const [showCircles, setShowCircles] = useState(true)
  const [showOriginal, setShowOriginal] = useState(true)

  const { ref, size } = useDprCanvas()

  // The active path in normalized path-space (~[-1,1]).
  const path = useMemo<Point[]>(() => {
    if (source === 'draw') return drawn ?? []
    return presetPath(preset, 720)
  }, [source, preset, drawn])

  const cycles = useMemo(() => computeEpicycles(path), [path])
  const maxHarmonics = cycles.length

  // The count is clamped at render time, so switching to a simpler shape never
  // requests more harmonics than exist (and switching back restores the slider).
  const usedHarmonics = Math.max(1, Math.min(harmonics, maxHarmonics))

  // Animation state kept in refs so the RAF loop doesn't re-subscribe.
  const tRef = useRef(0)
  const trailRef = useRef<Point[]>([])
  const drawingRef = useRef(false)
  const rawRef = useRef<Point[]>([])

  // Reset the traced trail when the shape or resolution changes.
  useEffect(() => {
    trailRef.current = []
    tRef.current = 0
  }, [path, usedHarmonics])

  const toPathSpace = useCallback(
    (clientX: number, clientY: number): Point => {
      const canvas = ref.current
      if (!canvas) return { x: 0, y: 0 }
      const rect = canvas.getBoundingClientRect()
      const scale = Math.min(rect.width, rect.height) * 0.33
      return {
        x: (clientX - rect.left - rect.width / 2) / scale,
        y: (clientY - rect.top - rect.height / 2) / scale,
      }
    },
    [ref],
  )

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (source !== 'draw') return
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
      drawingRef.current = true
      rawRef.current = [toPathSpace(e.clientX, e.clientY)]
    },
    [source, toPathSpace],
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!drawingRef.current) return
      rawRef.current.push(toPathSpace(e.clientX, e.clientY))
    },
    [toPathSpace],
  )

  const onPointerUp = useCallback(() => {
    if (!drawingRef.current) return
    drawingRef.current = false
    if (rawRef.current.length > 8) {
      setDrawn(normalizePath(rawRef.current))
    }
  }, [])

  // ----- rendering -----
  useAnimationFrame(
    (dt) => {
      const ctx = prepareContext(ref.current, size)
      if (!ctx) return
      const { width: w, height: h } = size
      const cx = w / 2
      const cy = h / 2
      const scale = Math.min(w, h) * 0.33

      // subtle backdrop grid
      ctx.strokeStyle = 'rgba(120,140,220,0.06)'
      ctx.lineWidth = 1
      const step = 40
      for (let x = (cx % step); x < w; x += step) {
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
        ctx.stroke()
      }
      for (let y = (cy % step); y < h; y += step) {
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
        ctx.stroke()
      }

      // While actively drawing, show the raw stroke and skip the machine.
      if (source === 'draw' && drawingRef.current) {
        const raw = rawRef.current
        ctx.strokeStyle = '#5eead4'
        ctx.lineWidth = 2.5
        ctx.beginPath()
        raw.forEach((p, i) => {
          const sx = cx + p.x * scale
          const sy = cy + p.y * scale
          if (i === 0) ctx.moveTo(sx, sy)
          else ctx.lineTo(sx, sy)
        })
        ctx.stroke()
        return
      }

      if (source === 'draw' && !drawn) {
        ctx.fillStyle = 'rgba(154,166,212,0.7)'
        ctx.font = '15px Inter, sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('Draw a closed shape with your mouse or finger', cx, cy)
        return
      }

      if (cycles.length === 0) return

      // original path (faint)
      if (showOriginal) {
        ctx.strokeStyle = 'rgba(167,139,250,0.35)'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        path.forEach((p, i) => {
          const sx = cx + p.x * scale
          const sy = cy + p.y * scale
          if (i === 0) ctx.moveTo(sx, sy)
          else ctx.lineTo(sx, sy)
        })
        ctx.closePath()
        ctx.stroke()
      }

      // advance time
      if (running) {
        const prev = tRef.current
        let t = prev + speed * dt
        if (t >= 1) {
          t -= 1
          trailRef.current = []
        }
        tRef.current = t
      }
      const t = tRef.current

      const { tips, end } = epicyclePositions(cycles, t, usedHarmonics)

      // epicycle circles + arms
      if (showCircles) {
        let px = cx
        let py = cy
        for (let i = 0; i < tips.length; i++) {
          const tipX = cx + tips[i].x * scale
          const tipY = cy + tips[i].y * scale
          const r = Math.hypot(tipX - px, tipY - py)
          // fade smaller epicycles out
          const alpha = Math.max(0.08, 0.5 - i * 0.012)
          ctx.strokeStyle = `rgba(120,140,220,${alpha})`
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.arc(px, py, r, 0, Math.PI * 2)
          ctx.stroke()
          ctx.strokeStyle = `rgba(94,234,212,${Math.max(0.12, alpha)})`
          ctx.beginPath()
          ctx.moveTo(px, py)
          ctx.lineTo(tipX, tipY)
          ctx.stroke()
          px = tipX
          py = tipY
        }
      }

      // trail (the reconstruction being traced)
      const endX = cx + end.x * scale
      const endY = cy + end.y * scale
      trailRef.current.push({ x: endX, y: endY })
      const trail = trailRef.current
      if (trail.length > 1) {
        ctx.strokeStyle = '#38bdf8'
        ctx.lineWidth = 2.5
        ctx.shadowColor = 'rgba(56,189,248,0.8)'
        ctx.shadowBlur = 10
        ctx.beginPath()
        trail.forEach((p, i) => {
          if (i === 0) ctx.moveTo(p.x, p.y)
          else ctx.lineTo(p.x, p.y)
        })
        ctx.stroke()
        ctx.shadowBlur = 0
      }

      // pen tip
      ctx.fillStyle = '#eef1ff'
      ctx.beginPath()
      ctx.arc(endX, endY, 3.5, 0, Math.PI * 2)
      ctx.fill()
    },
    true,
  )

  return (
    <div className="mode">
      <div className="mode-side">
        <Panel title="Shape">
          <Segmented
            value={source}
            options={[
              { id: 'preset', label: 'Preset' },
              { id: 'draw', label: 'Draw' },
            ]}
            onChange={(s) => setSource(s)}
          />
          {source === 'preset' ? (
            <Field label="Preset curve">
              <Select value={preset} options={PRESETS} onChange={(p) => setPreset(p)} />
            </Field>
          ) : (
            <div className="btn-row">
              <Button variant="ghost" onClick={() => setDrawn(null)}>
                Clear drawing
              </Button>
            </div>
          )}
        </Panel>

        <Panel title="Fourier series">
          <Field label="Harmonics" value={`${usedHarmonics} / ${maxHarmonics}`}>
            <Slider
              min={1}
              max={Math.max(1, maxHarmonics)}
              step={1}
              value={usedHarmonics}
              onChange={(v) => setHarmonics(Math.round(v))}
            />
          </Field>
          <Field label="Speed" value={`${(speed * 100).toFixed(0)}%`}>
            <Slider min={0.02} max={0.6} step={0.01} value={speed} onChange={setSpeed} />
          </Field>
          <div className="btn-row">
            <Button variant={running ? 'default' : 'primary'} onClick={() => setRunning((r) => !r)}>
              {running ? 'Pause' : 'Play'}
            </Button>
          </div>
          <Toggle label="Show epicycle circles" checked={showCircles} onChange={setShowCircles} />
          <Toggle label="Show original outline" checked={showOriginal} onChange={setShowOriginal} />
        </Panel>

        <Panel title="Decomposition">
          <Readout
            items={[
              { label: 'Vectors', value: String(usedHarmonics) },
              { label: 'Coeffs', value: String(maxHarmonics) },
              { label: 'Points', value: String(path.length) },
            ]}
          />
        </Panel>
      </div>

      <div className="mode-main">
        <p className="mode-intro">
          Every closed curve is a sum of <strong>rotating vectors</strong>. We treat each point of
          the path as a complex number <code>x + iy</code>, run an <strong>FFT</strong>, and turn
          each coefficient into an epicycle with its own frequency, radius, and phase. Chained
          largest-first, they redraw the shape. Slide <em>Harmonics</em> to add detail — or switch
          to <em>Draw</em> and watch the machine reproduce your own scribble.
        </p>
        <CanvasCard
          title="Epicycle machine"
          note={`${usedHarmonics} rotating vectors`}
          aspect={1.35}
        >
          <canvas
            ref={ref}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          />
        </CanvasCard>
      </div>
    </div>
  )
}
