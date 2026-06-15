// Mesh-gradient studio. Drag colored control points around a canvas; the field is an
// inverse-distance blend computed in Oklab. Add points by clicking empty space, recolor the
// selected point with the same picker the main studio uses, and export the result as a PNG.

import { useCallback, useEffect, useRef, useState } from 'react'
import { oklchToRgb, rgbaToCss } from '../color/convert'
import { renderMesh } from '../color/mesh'
import type { MeshPoint } from '../color/mesh'
import { makeRng, makeStopId, randomPleasantColor } from '../color/random'
import type { RGBA } from '../color/types'
import { randomSeed } from '../state/store'
import { ColorPicker } from './ColorPicker'

const RES_W = 400
const RES_H = 260

function seedPoints(seed: number): MeshPoint[] {
  const rng = makeRng(seed)
  const baseHue = rng() * 360
  const n = 4 + Math.floor(rng() * 3)
  const pts: MeshPoint[] = []
  for (let i = 0; i < n; i++) {
    const h = baseHue + (i / n) * (120 + rng() * 180)
    const rgb = oklchToRgb({ L: 0.55 + rng() * 0.3, C: 0.1 + rng() * 0.12, h })
    pts.push({
      id: makeStopId(),
      x: 0.15 + rng() * 0.7,
      y: 0.15 + rng() * 0.7,
      color: { r: Math.min(1, Math.max(0, rgb.r)), g: Math.min(1, Math.max(0, rgb.g)), b: Math.min(1, Math.max(0, rgb.b)), a: 1 },
    })
  }
  return pts
}

export function Mesh() {
  const [points, setPoints] = useState<MeshPoint[]>(() => seedPoints(7))
  const [power, setPower] = useState(2.4)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const dragId = useRef<string | null>(null)
  const rafPending = useRef(false)

  const draw = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    renderMesh(points, ctx, RES_W, RES_H, power)
  }, [points, power])

  useEffect(() => {
    if (rafPending.current) return
    rafPending.current = true
    requestAnimationFrame(() => {
      rafPending.current = false
      draw()
    })
  }, [draw])

  const selected = points.find((p) => p.id === selectedId) ?? null

  const fractionAt = (clientX: number, clientY: number) => {
    const el = stageRef.current
    if (!el) return { x: 0.5, y: 0.5 }
    const r = el.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)),
    }
  }

  const addPoint = (e: React.PointerEvent) => {
    const { x, y } = fractionAt(e.clientX, e.clientY)
    const p: MeshPoint = { id: makeStopId(), x, y, color: randomPleasantColor() }
    setPoints((ps) => [...ps, p])
    setSelectedId(p.id)
  }

  const onPointDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    dragId.current = id
    setSelectedId(id)
  }
  const onPointMove = (e: React.PointerEvent, id: string) => {
    if (dragId.current !== id || e.buttons !== 1) return
    const { x, y } = fractionAt(e.clientX, e.clientY)
    setPoints((ps) => ps.map((p) => (p.id === id ? { ...p, x, y } : p)))
  }
  const removePoint = (id: string) => {
    if (points.length <= 2) return
    setPoints((ps) => ps.filter((p) => p.id !== id))
    if (selectedId === id) setSelectedId(null)
  }
  const setColor = (color: RGBA) => setPoints((ps) => ps.map((p) => (p.id === selectedId ? { ...p, color } : p)))

  const exportPng = () => {
    const c = document.createElement('canvas')
    c.width = 1600
    c.height = 1040
    const ctx = c.getContext('2d')
    if (!ctx) return
    renderMesh(points, ctx, c.width, c.height, power)
    c.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'mesh-gradient.png'
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    }, 'image/png')
  }

  return (
    <div className="mesh-page">
      <div className="mesh-stage-wrap">
        <div
          className="mesh-stage"
          ref={stageRef}
          onPointerDown={addPoint}
        >
          <canvas ref={canvasRef} width={RES_W} height={RES_H} className="mesh-canvas" />
          {points.map((p) => (
            <button
              key={p.id}
              className={`mesh-point${p.id === selectedId ? ' is-selected' : ''}`}
              style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, background: rgbaToCss(p.color) }}
              onPointerDown={(e) => onPointDown(e, p.id)}
              onPointerMove={(e) => onPointMove(e, p.id)}
              onPointerUp={() => (dragId.current = null)}
              onDoubleClick={(e) => {
                e.stopPropagation()
                removePoint(p.id)
              }}
              title="drag to move · double-click to remove"
              aria-label="mesh control point"
            />
          ))}
        </div>
        <p className="stoptrack-hint">Click to add a point · drag points · double-click to remove · blended in Oklab</p>
      </div>

      <div className="mesh-controls">
        <div className="toolbar">
          <label className="ctrl">
            <span>Falloff</span>
            <input type="range" min={1} max={5} step={0.1} value={power} onChange={(e) => setPower(Number(e.target.value))} />
            <b>{power.toFixed(1)}</b>
          </label>
          <div className="toolbar-spacer" />
          <button className="btn ghost" onClick={() => setPoints(seedPoints(randomSeed()))}>
            ✦ Randomize
          </button>
          <button className="btn" onClick={exportPng}>
            PNG ↓
          </button>
        </div>
        <section className="card">
          <h3>Selected point</h3>
          {selected ? <ColorPicker value={selected.color} onChange={setColor} /> : <p className="muted">Click a point to edit its color.</p>}
        </section>
      </div>
    </div>
  )
}
