import { useEffect, useMemo, useState } from 'react'
import type { Point, Rect } from '../geometry/types'
import {
  curveOrder,
  curvePath,
  tourLength,
  tourPolyline,
  type CurveKind,
} from '../geometry/spaceFilling'
import { jitteredGrid, mulberry32, poissonDisk, uniformPoints } from '../geometry/random'
import { useCanvas } from '../hooks/useCanvas'
import { usePersistentState } from '../hooks/usePersistentState'
import { Button, Panel, Segmented, Slider, Stat, Toggle } from '../components/Controls'

// The Space-Filling Curves studio: watch a Morton (Z-order) or Hilbert curve
// thread every cell of a 2^order grid, then sort a real point cloud along it and
// measure how well the 1-D order preserved 2-D proximity. Hilbert's jump-free path
// keeps neighbours near (short tour); Morton's Z-jumps leak locality (longer tour).

const CLIP: Rect = { minX: 0, minY: 0, maxX: 1, maxY: 1 }
const PAD = 18
const SORT_ORDER = 10 // grid resolution used to rank the point cloud (fine)

type Distribution = 'poisson' | 'uniform' | 'grid'
type ViewMode = 'curve' | 'tour'

function generate(dist: Distribution, count: number, seed: number): Point[] {
  const rng = mulberry32(seed)
  const inset: Rect = { minX: 0.04, minY: 0.04, maxX: 0.96, maxY: 0.96 }
  if (dist === 'uniform') return uniformPoints(count, inset, rng)
  if (dist === 'grid') return jitteredGrid(count, inset, rng)
  return poissonDisk(count, inset, rng)
}

// A cool→warm gradient so progress along the curve reads as a temperature ramp.
function ramp(t: number): string {
  const stops: [number, [number, number, number]][] = [
    [0, [56, 189, 248]],
    [0.5, [167, 139, 250]],
    [1, [251, 191, 36]],
  ]
  let a = stops[0]
  let b = stops[stops.length - 1]
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      a = stops[i]
      b = stops[i + 1]
      break
    }
  }
  const span = b[0] - a[0] || 1
  const u = (t - a[0]) / span
  const c = a[1].map((v, i) => Math.round(v + (b[1][i] - v) * u))
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

export default function Curves() {
  const { ref, size } = useCanvas()
  const [kind, setKind] = usePersistentState<CurveKind>('curves:kind', 'hilbert')
  const [view, setView] = usePersistentState<ViewMode>('curves:view', 'curve')
  const [order, setOrder] = usePersistentState<number>('curves:order', 4)
  const [showGrid, setShowGrid] = usePersistentState<boolean>('curves:grid', true)
  const [showPoints, setShowPoints] = usePersistentState<boolean>('curves:points', true)

  const [dist, setDist] = usePersistentState<Distribution>('curves:dist', 'poisson')
  const [count, setCount] = usePersistentState<number>('curves:count', 220)
  const [seed, setSeed] = useState(4)
  const [points, setPoints] = useState<Point[]>(() => generate('poisson', 220, 4))

  const [progress, setProgress] = useState(1) // 0…1 reveal fraction
  const [playing, setPlaying] = useState(false)

  // ── Derived: the full curve, and the point tours for both families ──────────
  const fullPath = useMemo(() => curvePath(kind, order, CLIP), [kind, order])
  const hilbertOrder = useMemo(() => curveOrder(points, CLIP, SORT_ORDER, 'hilbert'), [points])
  const mortonOrder = useMemo(() => curveOrder(points, CLIP, SORT_ORDER, 'morton'), [points])
  const activeOrder = kind === 'hilbert' ? hilbertOrder : mortonOrder
  const tour = useMemo(() => tourPolyline(points, activeOrder), [points, activeOrder])

  const hLen = useMemo(() => tourLength(points, hilbertOrder), [points, hilbertOrder])
  const mLen = useMemo(() => tourLength(points, mortonOrder), [points, mortonOrder])
  const improvement = mLen > 0 ? (1 - hLen / mLen) * 100 : 0

  // ── Play: sweep the reveal head along the curve/tour ────────────────────────
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = 0
    const tick = (ts: number) => {
      if (last === 0) last = ts
      const dt = (ts - last) / 1000
      last = ts
      setProgress((p) => {
        const next = p + dt * 0.35
        return next >= 1 ? 0 : next
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  // ── Rendering ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || size.width === 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { width, height, dpr } = size
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const bg = ctx.createRadialGradient(width / 2, height * 0.42, 0, width / 2, height / 2, Math.max(width, height) * 0.75)
    bg.addColorStop(0, '#0e1525')
    bg.addColorStop(1, '#070a12')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, width, height)

    const w = width - PAD * 2
    const h = height - PAD * 2
    const toPx = (p: Point) => ({ x: PAD + p.x * w, y: PAD + p.y * h })

    // Grid lines for the current curve order.
    if (showGrid) {
      const side = 1 << order
      ctx.strokeStyle = 'rgba(148,163,200,0.08)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let i = 0; i <= side; i++) {
        const gx = PAD + (i / side) * w
        const gy = PAD + (i / side) * h
        ctx.moveTo(gx, PAD)
        ctx.lineTo(gx, PAD + h)
        ctx.moveTo(PAD, gy)
        ctx.lineTo(PAD + w, gy)
      }
      ctx.stroke()
    }

    if (view === 'curve') {
      const path = fullPath
      const shown = Math.max(1, Math.floor(path.length * progress))
      ctx.lineWidth = Math.max(1.2, 6 - order * 0.6)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (let i = 1; i < shown; i++) {
        const a = toPx(path[i - 1])
        const b = toPx(path[i])
        ctx.strokeStyle = ramp((i - 1) / (path.length - 1))
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
      // The moving head.
      if (shown >= 1 && shown <= path.length) {
        const head = toPx(path[Math.min(shown, path.length) - 1])
        ctx.beginPath()
        ctx.arc(head.x, head.y, 5, 0, Math.PI * 2)
        ctx.fillStyle = '#fff'
        ctx.fill()
      }
    } else {
      // Point tour: the cloud connected in curve order, revealed progressively.
      const shown = Math.max(1, Math.floor(tour.length * progress))
      if (showPoints) {
        for (let i = 0; i < points.length; i++) {
          const q = toPx(points[i])
          ctx.beginPath()
          ctx.arc(q.x, q.y, 2.4, 0, Math.PI * 2)
          ctx.fillStyle = 'rgba(200,212,240,0.4)'
          ctx.fill()
        }
      }
      ctx.lineWidth = 1.8
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (let i = 1; i < shown; i++) {
        const a = toPx(tour[i - 1])
        const b = toPx(tour[i])
        ctx.strokeStyle = ramp((i - 1) / Math.max(1, tour.length - 1))
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
      // Highlight visited points + the head.
      for (let i = 0; i < shown; i++) {
        const q = toPx(tour[i])
        ctx.beginPath()
        ctx.arc(q.x, q.y, i === shown - 1 ? 5 : 3, 0, Math.PI * 2)
        ctx.fillStyle = i === shown - 1 ? '#fff' : ramp(i / Math.max(1, tour.length - 1))
        ctx.fill()
      }
    }
  }, [ref, size, view, kind, order, fullPath, tour, points, progress, showGrid, showPoints])

  const regenerate = (nextSeed = seed) => setPoints(generate(dist, count, nextSeed))
  const reseed = () => {
    const next = seed + 1
    setSeed(next)
    regenerate(next)
  }

  const cells = 1 << (2 * order)

  return (
    <div className="studio">
      <div className="stage">
        <canvas ref={ref} className="stage__canvas" />
        <div className="stage__chips">
          <Stat label="curve" value={kind === 'hilbert' ? 'Hilbert' : 'Z-order'} />
          {view === 'curve' && <Stat label="cells" value={`${1 << order}×${1 << order} = ${cells}`} />}
          {view === 'tour' && <Stat label="points" value={points.length} />}
          {view === 'tour' && <Stat label="tour length" value={(kind === 'hilbert' ? hLen : mLen).toFixed(2)} />}
        </div>
        <p className="stage__hint">
          {view === 'curve'
            ? 'The curve threads every grid cell exactly once — raise the order to subdivide'
            : 'Points sorted along the curve; the connecting hops are the locality cost'}
        </p>
      </div>

      <aside className="sidebar">
        <Panel title="Curve" hint="space-filling">
          <Segmented<CurveKind>
            options={[
              { id: 'hilbert', label: 'Hilbert' },
              { id: 'morton', label: 'Z-order' },
            ]}
            value={kind}
            onChange={setKind}
          />
          <p className="muted">
            {kind === 'hilbert'
              ? 'The Hilbert curve is a recursively rotated “U”. Consecutive indices are always grid-neighbours, so it never jumps — nearby indices stay nearby in space.'
              : 'The Morton (Z-order) curve interleaves the bits of x and y. Trivial to compute, but its “Z” jumps mean two cells adjacent on the curve can be far apart in the plane.'}
          </p>
          <Segmented<ViewMode>
            options={[
              { id: 'curve', label: 'Full curve' },
              { id: 'tour', label: 'Point tour' },
            ]}
            value={view}
            onChange={setView}
          />
        </Panel>

        <Panel title="Playback">
          <div className="row">
            <Button variant="primary" onClick={() => setPlaying((p) => !p)}>
              {playing ? '❚❚ Pause' : '▶ Play'}
            </Button>
            <Button onClick={() => { setPlaying(false); setProgress(1) }}>Reset</Button>
          </div>
          <Slider label="Reveal" value={Math.round(progress * 100)} min={0} max={100} step={1}
            onChange={(v) => { setPlaying(false); setProgress(v / 100) }} />
          {view === 'curve' && (
            <Slider label="Order (grid = 2ⁿ)" value={order} min={1} max={7} step={1} onChange={setOrder} />
          )}
          <div className="layers">
            <Toggle label="Grid" swatch="rgba(148,163,200,0.6)" checked={showGrid} onChange={setShowGrid} />
            {view === 'tour' && (
              <Toggle label="All points" swatch="rgba(200,212,240,0.6)" checked={showPoints} onChange={setShowPoints} />
            )}
          </div>
        </Panel>

        {view === 'tour' && (
          <Panel title="Locality" hint="tour length ↓ better">
            <div className="metrics">
              <Stat label="Hilbert" value={hLen.toFixed(2)} />
              <Stat label="Z-order" value={mLen.toFixed(2)} />
              <Stat label="Hilbert win" value={`${improvement.toFixed(1)}%`} />
            </div>
            <p className="muted">
              Both curves sort the same cloud; the tour length sums the Euclidean hops between
              successive points. Hilbert’s jump-free order yields a shorter tour — it preserved
              2-D proximity better when collapsing to a 1-D sequence.
            </p>
          </Panel>
        )}

        <Panel title="Points" hint={`${points.length}`}>
          <Segmented<Distribution>
            options={[
              { id: 'poisson', label: 'Blue noise' },
              { id: 'uniform', label: 'Uniform' },
              { id: 'grid', label: 'Grid' },
            ]}
            value={dist}
            onChange={setDist}
          />
          <Slider label="Count" value={count} min={8} max={1200} step={1} onChange={setCount} />
          <div className="row">
            <Button variant="primary" onClick={() => regenerate()}>Generate</Button>
            <Button onClick={reseed}>New seed</Button>
          </div>
        </Panel>
      </aside>
    </div>
  )
}
