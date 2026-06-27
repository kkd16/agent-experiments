import { useEffect, useMemo, useState } from 'react'
import type { Point, Rect } from '../geometry/types'
import { convexHullSteps, type HullStep } from '../geometry/convexHull'
import { delaunaySteps, type DelaunaySnapshot } from '../geometry/delaunay'
import { mulberry32, poissonDisk } from '../geometry/random'
import { useCanvas } from '../hooks/useCanvas'
import { Button, Panel, Segmented, Slider } from '../components/Controls'

type Algo = 'hull' | 'delaunay'
const PAD = 28
const GEN_RECT: Rect = { minX: 0.08, minY: 0.1, maxX: 0.92, maxY: 0.92 }

function makePoints(algo: Algo, seed: number): Point[] {
  const rng = mulberry32(seed)
  return poissonDisk(algo === 'hull' ? 14 : 18, GEN_RECT, rng)
}

export default function Algorithms() {
  const { ref, size } = useCanvas()
  const [algo, setAlgo] = useState<Algo>('hull')
  const [seed, setSeed] = useState(3)
  const [points, setPoints] = useState<Point[]>(() => makePoints('hull', 3))
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1.4)

  const hullSteps = useMemo<HullStep[]>(() => (algo === 'hull' ? convexHullSteps(points) : []), [algo, points])
  const delSteps = useMemo<DelaunaySnapshot[]>(
    () => (algo === 'delaunay' ? delaunaySteps(points) : []),
    [algo, points],
  )
  const total = algo === 'hull' ? hullSteps.length : delSteps.length
  const clamped = Math.min(step, Math.max(0, total - 1))

  // Playback timer.
  useEffect(() => {
    if (!playing) return
    const id = window.setInterval(() => {
      setStep((s) => {
        if (s >= total - 1) {
          setPlaying(false)
          return s
        }
        return s + 1
      })
    }, 900 / speed)
    return () => window.clearInterval(id)
  }, [playing, speed, total])

  // ── Rendering ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || size.width === 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { width, height, dpr } = size
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const bg = ctx.createLinearGradient(0, 0, 0, height)
    bg.addColorStop(0, '#0e1525')
    bg.addColorStop(1, '#070a12')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, width, height)

    const w = width - PAD * 2
    const h = height - PAD * 2
    const toPx = (p: Point) => ({ x: PAD + p.x * w, y: PAD + p.y * h })

    if (algo === 'hull') drawHullStep(ctx, hullSteps[clamped], points, toPx)
    else drawDelaunayStep(ctx, delSteps[clamped], toPx)
  }, [ref, size, algo, hullSteps, delSteps, clamped, points])

  const note = algo === 'hull' ? hullSteps[clamped]?.note : delSteps[clamped]?.note
  const phase = algo === 'hull' ? hullSteps[clamped]?.phase : undefined
  const changeAlgo = (a: Algo) => {
    setAlgo(a)
    setStep(0)
    setPlaying(false)
    setPoints(makePoints(a, seed))
  }
  const regen = () => {
    const next = seed + 1
    setSeed(next)
    setStep(0)
    setPlaying(false)
    setPoints(makePoints(algo, next))
  }

  return (
    <div className="studio">
      <div className="stage">
        <canvas ref={ref} className="stage__canvas" />
        <div className="stage__chips">
          <span className="chip">
            step <strong>{total ? clamped + 1 : 0}</strong> / {total}
          </span>
          {phase && <span className="chip">phase: {phase}</span>}
        </div>
        <p className="stage__hint stage__hint--note">{note}</p>
      </div>

      <aside className="sidebar">
        <Panel title="Algorithm">
          <Segmented<Algo>
            options={[
              { id: 'hull', label: 'Convex hull' },
              { id: 'delaunay', label: 'Delaunay' },
            ]}
            value={algo}
            onChange={changeAlgo}
          />
          <p className="muted">
            {algo === 'hull'
              ? "Andrew's monotone chain: sort by x, then sweep building lower and upper hulls, popping any point that would make a right turn."
              : 'Bowyer-Watson: insert points into a super-triangle one by one, carve out the triangles whose circumcircle is violated, and retriangulate the cavity.'}
          </p>
          <Button variant="ghost" onClick={regen}>
            New points
          </Button>
        </Panel>

        <Panel title="Playback">
          <div className="row">
            <Button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={clamped === 0}>
              ‹ Back
            </Button>
            <Button variant="primary" onClick={() => setPlaying((p) => !p)} disabled={clamped >= total - 1 && !playing}>
              {playing ? 'Pause' : 'Play'}
            </Button>
            <Button
              onClick={() => setStep((s) => Math.min(total - 1, s + 1))}
              disabled={clamped >= total - 1}
            >
              Next ›
            </Button>
          </div>
          <Button variant="ghost" onClick={() => { setStep(0); setPlaying(false) }}>
            Restart
          </Button>
          <Slider label="Speed" value={speed} min={0.4} max={4} step={0.1} onChange={setSpeed} format={(v) => `${v.toFixed(1)}×`} />
          <Slider label="Scrub" value={clamped} min={0} max={Math.max(0, total - 1)} step={1} onChange={(v) => { setPlaying(false); setStep(v) }} />
        </Panel>

        <Panel title="Legend">
          <ul className="legend">
            {algo === 'hull' ? (
              <>
                <li><i className="dot dot--hull" /> current hull chain</li>
                <li><i className="dot dot--active" /> point being considered</li>
                <li><i className="dot dot--pop" /> point popped (right turn)</li>
              </>
            ) : (
              <>
                <li><i className="dot dot--mesh" /> current triangulation</li>
                <li><i className="dot dot--active" /> inserted point</li>
                <li><i className="dot dot--cavity" /> cavity (circumcircle violated)</li>
              </>
            )}
          </ul>
        </Panel>
      </aside>
    </div>
  )
}

// ── Step painters ────────────────────────────────────────────────────────────

function drawHullStep(
  ctx: CanvasRenderingContext2D,
  s: HullStep | undefined,
  pts: Point[],
  toPx: (p: Point) => Point,
) {
  if (!s) return
  // Faint sweep order.
  ctx.fillStyle = 'rgba(150,160,200,0.35)'
  ctx.font = '11px ui-monospace, monospace'
  s.order.forEach((idx, k) => {
    const q = toPx(pts[idx])
    ctx.fillText(String(k + 1), q.x + 7, q.y - 7)
  })

  // Current hull chain (open polyline of the stack).
  if (s.hull.length >= 2) {
    ctx.beginPath()
    s.hull.forEach((idx, k) => {
      const q = toPx(pts[idx])
      if (k === 0) ctx.moveTo(q.x, q.y)
      else ctx.lineTo(q.x, q.y)
    })
    if (s.phase === 'done') ctx.closePath()
    ctx.strokeStyle = 'rgba(150,190,255,0.9)'
    ctx.lineWidth = 2
    ctx.stroke()
  }

  // Points.
  for (let i = 0; i < pts.length; i++) {
    const q = toPx(pts[i])
    const onHull = s.hull.includes(i)
    ctx.beginPath()
    ctx.arc(q.x, q.y, i === s.considering ? 7 : 4, 0, Math.PI * 2)
    ctx.fillStyle = i === s.considering ? '#7cf6c0' : onHull ? '#9cc0ff' : '#f4f7ff'
    ctx.fill()
  }
  if (s.popped >= 0) {
    const q = toPx(pts[s.popped])
    ctx.beginPath()
    ctx.arc(q.x, q.y, 9, 0, Math.PI * 2)
    ctx.strokeStyle = '#ff6b6b'
    ctx.lineWidth = 2
    ctx.stroke()
  }
}

function drawDelaunayStep(
  ctx: CanvasRenderingContext2D,
  s: DelaunaySnapshot | undefined,
  toPx: (p: Point) => Point,
) {
  if (!s) return
  const tri = (t: { a: number; b: number; c: number }) => {
    const a = toPx(s.pts[t.a])
    const b = toPx(s.pts[t.b])
    const c = toPx(s.pts[t.c])
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.lineTo(c.x, c.y)
    ctx.closePath()
  }

  // Cavity fill.
  ctx.fillStyle = 'rgba(255,107,107,0.18)'
  for (const t of s.cavity) {
    tri(t)
    ctx.fill()
  }
  // Mesh edges.
  ctx.strokeStyle = 'rgba(120,170,255,0.55)'
  ctx.lineWidth = 1.2
  for (const t of s.tris) {
    tri(t)
    ctx.stroke()
  }
  // Real points.
  for (let i = 0; i < s.nReal; i++) {
    const q = toPx(s.pts[i])
    ctx.beginPath()
    ctx.arc(q.x, q.y, i === s.inserted ? 7 : 4, 0, Math.PI * 2)
    ctx.fillStyle = i === s.inserted ? '#7cf6c0' : '#f4f7ff'
    ctx.fill()
  }
}
