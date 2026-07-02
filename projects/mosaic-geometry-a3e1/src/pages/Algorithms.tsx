import { useEffect, useMemo, useState } from 'react'
import type { Point, Rect } from '../geometry/types'
import { convexHullSteps, type HullStep } from '../geometry/convexHull'
import { delaunaySteps, type DelaunaySnapshot } from '../geometry/delaunay'
import { mecSteps, type MecSnapshot } from '../geometry/enclosingCircle'
import { fortune, beachIntervals, parabolaY, type FortuneSnapshot } from '../geometry/fortune'
import { quickHullSteps, type QuickHullStep } from '../geometry/quickhull'
import { buildKdTree, kdBuildSteps, type KdBuildStep } from '../geometry/kdtree'
import { quadBuildSteps, type QuadBuildStep } from '../geometry/quadtree'
import {
  powerCellSteps,
  radicalCircle,
  type PowerCellStep,
  type WeightedSite,
} from '../geometry/power'
import { bentleyOttmann, type Segment, type SweepStep } from '../geometry/segments'
import { mulberry32, poissonDisk, uniformPoints } from '../geometry/random'
import { useCanvas } from '../hooks/useCanvas'
import { Button, Panel, Segmented, Slider } from '../components/Controls'

type Algo = 'hull' | 'quickhull' | 'delaunay' | 'mec' | 'fortune' | 'power' | 'kdtree' | 'quadtree' | 'bentley'
const PAD = 28
const CLIP: Rect = { minX: 0, minY: 0, maxX: 1, maxY: 1 }
const GEN_RECT: Rect = { minX: 0.08, minY: 0.1, maxX: 0.92, maxY: 0.92 }

function makePoints(algo: Algo, seed: number): Point[] {
  const rng = mulberry32(seed)
  // The enclosing-circle trace reads best on a loose scatter; the others on blue noise.
  if (algo === 'mec') return uniformPoints(12, GEN_RECT, rng)
  if (algo === 'fortune') return uniformPoints(11, GEN_RECT, rng)
  if (algo === 'power') return uniformPoints(9, GEN_RECT, rng)
  if (algo === 'quickhull') return uniformPoints(16, GEN_RECT, rng)
  if (algo === 'kdtree') return uniformPoints(20, GEN_RECT, rng)
  if (algo === 'quadtree') return uniformPoints(24, GEN_RECT, rng)
  return poissonDisk(algo === 'hull' ? 14 : 18, GEN_RECT, rng)
}

// A deterministic bundle of segments in general position for the sweep demo.
function makeSegments(seed: number): Segment[] {
  const rng = mulberry32(seed * 131 + 7)
  const segs: Segment[] = []
  const n = 8
  for (let i = 0; i < n; i++) {
    const a = { x: 0.08 + rng() * 0.84, y: 0.1 + rng() * 0.8 }
    const ang = rng() * Math.PI
    const len = 0.35 + rng() * 0.4
    const b = { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len }
    segs.push({ a, b: { x: Math.min(0.95, Math.max(0.05, b.x)), y: Math.min(0.95, Math.max(0.05, b.y)) } })
  }
  return segs
}

// Deterministic weighted sites for the power-cell demo, plus the target cell
// (the site nearest the centroid — most likely to give a nicely bounded cell).
function makeWeightedSites(points: Point[], seed: number): { sites: WeightedSite[]; target: number } {
  const rng = mulberry32(seed * 97 + 13)
  const sites = points.map((p) => ({ x: p.x, y: p.y, w: rng() * 0.02 }))
  let cx = 0
  let cy = 0
  for (const p of points) {
    cx += p.x
    cy += p.y
  }
  cx /= points.length || 1
  cy /= points.length || 1
  let target = 0
  let best = Infinity
  for (let i = 0; i < points.length; i++) {
    const d = (points[i].x - cx) ** 2 + (points[i].y - cy) ** 2
    if (d < best) {
      best = d
      target = i
    }
  }
  return { sites, target }
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
  const mecStepList = useMemo<MecSnapshot[]>(
    () => (algo === 'mec' ? mecSteps(points, seed) : []),
    [algo, points, seed],
  )
  const fortuneSteps = useMemo<FortuneSnapshot[]>(
    () => (algo === 'fortune' ? fortune(points, true).steps : []),
    [algo, points],
  )
  const quickSteps = useMemo<QuickHullStep[]>(
    () => (algo === 'quickhull' ? quickHullSteps(points) : []),
    [algo, points],
  )
  const weighted = useMemo(
    () => (algo === 'power' ? makeWeightedSites(points, seed) : { sites: [], target: -1 }),
    [algo, points, seed],
  )
  const powerSteps = useMemo<PowerCellStep[]>(
    () => (algo === 'power' ? powerCellSteps(weighted.sites, CLIP, weighted.target) : []),
    [algo, weighted],
  )
  const kdSteps = useMemo<KdBuildStep[]>(
    () => (algo === 'kdtree' ? kdBuildSteps(buildKdTree(points, CLIP), points) : []),
    [algo, points],
  )
  const quadSteps = useMemo<QuadBuildStep[]>(
    () => (algo === 'quadtree' ? quadBuildSteps(points, CLIP) : []),
    [algo, points],
  )
  const boSegs = useMemo<Segment[]>(() => (algo === 'bentley' ? makeSegments(seed) : []), [algo, seed])
  const bo = useMemo(
    () => (algo === 'bentley' ? bentleyOttmann(boSegs, true) : { intersections: [], steps: [] as SweepStep[] }),
    [algo, boSegs],
  )
  const total =
    algo === 'hull'
      ? hullSteps.length
      : algo === 'quickhull'
        ? quickSteps.length
        : algo === 'delaunay'
          ? delSteps.length
          : algo === 'mec'
            ? mecStepList.length
            : algo === 'power'
              ? powerSteps.length
              : algo === 'kdtree'
                ? kdSteps.length
                : algo === 'quadtree'
                  ? quadSteps.length
                  : algo === 'bentley'
                    ? bo.steps.length
                    : fortuneSteps.length
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
    else if (algo === 'quickhull') drawQuickHullStep(ctx, quickSteps[clamped], points, toPx)
    else if (algo === 'delaunay') drawDelaunayStep(ctx, delSteps[clamped], toPx)
    else if (algo === 'mec') drawMecStep(ctx, mecStepList[clamped], toPx, w)
    else if (algo === 'power') drawPowerStep(ctx, powerSteps[clamped], weighted.sites, weighted.target, toPx, w)
    else if (algo === 'kdtree') drawKdBuildStep(ctx, kdSteps[clamped], points, toPx)
    else if (algo === 'quadtree') drawQuadBuildStep(ctx, quadSteps[clamped], points, toPx)
    else if (algo === 'bentley') drawBentleyStep(ctx, bo.steps, clamped, boSegs, toPx, PAD, w, h)
    else drawFortuneStep(ctx, fortuneSteps[clamped], points, PAD, w, h)
  }, [ref, size, algo, hullSteps, quickSteps, delSteps, mecStepList, powerSteps, weighted, kdSteps, quadSteps, fortuneSteps, bo, boSegs, clamped, points])

  const note =
    algo === 'hull'
      ? hullSteps[clamped]?.note
      : algo === 'quickhull'
        ? quickSteps[clamped]?.note
        : algo === 'delaunay'
          ? delSteps[clamped]?.note
          : algo === 'mec'
            ? mecStepList[clamped]?.note
            : algo === 'power'
              ? powerSteps[clamped]?.note
              : algo === 'kdtree'
                ? kdSteps[clamped]?.note
                : algo === 'quadtree'
                  ? quadSteps[clamped]?.note
                  : algo === 'bentley'
                    ? bentleyNote(bo.steps[clamped])
                    : fortuneSteps[clamped]?.note
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
              { id: 'quickhull', label: 'Quickhull' },
              { id: 'delaunay', label: 'Delaunay' },
              { id: 'mec', label: 'Enclosing circle' },
              { id: 'fortune', label: 'Fortune sweep' },
              { id: 'power', label: 'Power cell' },
              { id: 'kdtree', label: 'k-d tree' },
              { id: 'quadtree', label: 'Quadtree' },
              { id: 'bentley', label: 'Bentley–Ottmann' },
            ]}
            value={algo}
            onChange={changeAlgo}
          />
          <p className="muted">
            {algo === 'hull'
              ? "Andrew's monotone chain: sort by x, then sweep building lower and upper hulls, popping any point that would make a right turn."
              : algo === 'quickhull'
                ? 'Quickhull: anchor on the two extreme-x points, then on each side recurse on the point farthest from the edge — it must be a hull vertex — discarding everything inside the triangle it forms.'
                : algo === 'delaunay'
                  ? 'Bowyer-Watson: insert points into a super-triangle one by one, carve out the triangles whose circumcircle is violated, and retriangulate the cavity.'
                  : algo === 'mec'
                    ? "Welzl's algorithm: walk the shuffled points keeping the smallest circle seen so far. When a point falls outside, rebuild the circle with that point pinned to its boundary."
                    : algo === 'power'
                      ? 'Power (Laguerre) cell: each weighted site’s cell is the intersection of half-planes across its radical axes. Watch one cell get clipped by each neighbour in turn, nearest first.'
                      : algo === 'kdtree'
                        ? 'k-d tree: recursively split the points at the median along an axis that alternates with depth (x, then y, then x…). Each cut halves a region; the result is a balanced tree whose every node owns a slab of the plane — the structure that makes nearest-neighbour and range queries prune.'
                        : algo === 'quadtree'
                          ? 'Point-region quadtree: insert points one at a time; whenever a cell holds more than its capacity, it divides into four equal quadrants. Space (not the data) drives the split, so the grid is fine where points cluster and coarse where they are sparse.'
                          : algo === 'bentley'
                            ? "Bentley–Ottmann: a vertical line sweeps left to right through the segments; the status (right) holds the segments it currently crosses, ordered by height. Only neighbours in that order can cross next, so each endpoint or crossing re-tests just a couple of pairs — O((n+k) log n) instead of the O(n²) all-pairs scan. Yellow rings are crossings already found."
                            : "Fortune's sweep: a line descends the plane; the beach line of parabolas (each equidistant from a site and the line) tracks the emerging Voronoi diagram. Site events split arcs; circle events pinch one out, fixing a Voronoi vertex."}
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
            ) : algo === 'quickhull' ? (
              <>
                <li><i className="dot dot--hull" /> hull boundary so far</li>
                <li><i className="dot dot--active" /> farthest point (new apex)</li>
                <li><i className="dot dot--cavity" /> points outside the current edge</li>
              </>
            ) : algo === 'power' ? (
              <>
                <li><i className="dot dot--mesh" /> the cell so far</li>
                <li><i className="dot dot--active" /> the target site</li>
                <li><i className="dot dot--cavity" /> neighbour being clipped against</li>
              </>
            ) : algo === 'delaunay' ? (
              <>
                <li><i className="dot dot--mesh" /> current triangulation</li>
                <li><i className="dot dot--active" /> inserted point</li>
                <li><i className="dot dot--cavity" /> cavity (circumcircle violated)</li>
              </>
            ) : algo === 'mec' ? (
              <>
                <li><i className="dot dot--mesh" /> current enclosing circle</li>
                <li><i className="dot dot--active" /> point being tested</li>
                <li><i className="dot dot--hull" /> boundary support points</li>
              </>
            ) : algo === 'kdtree' ? (
              <>
                <li><i className="dot dot--mesh" /> cuts committed so far</li>
                <li><i className="dot dot--active" /> median point at this split</li>
                <li><i className="dot dot--hull" /> region being divided</li>
              </>
            ) : algo === 'quadtree' ? (
              <>
                <li><i className="dot dot--mesh" /> quadtree cells</li>
                <li><i className="dot dot--active" /> point just inserted</li>
                <li><i className="dot dot--cavity" /> cell that just subdivided</li>
              </>
            ) : (
              <>
                <li><i className="dot dot--hull" /> beach line (parabolic arcs)</li>
                <li><i className="dot dot--active" /> event site</li>
                <li><i className="dot dot--cavity" /> pending circle event</li>
                <li><i className="dot dot--mesh" /> Voronoi vertex found</li>
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

function drawMecStep(
  ctx: CanvasRenderingContext2D,
  s: MecSnapshot | undefined,
  toPx: (p: Point) => Point,
  scale: number,
) {
  if (!s) return
  const isSupport = (p: Point) => s.support.some((q) => q.x === p.x && q.y === p.y)

  // The working circle — tinted gold on the step where it was just rebuilt.
  const center = toPx({ x: s.circle.x, y: s.circle.y })
  ctx.beginPath()
  ctx.arc(center.x, center.y, Math.max(0, s.circle.r * scale), 0, Math.PI * 2)
  ctx.fillStyle = s.rebuilt ? 'rgba(255,209,102,0.08)' : 'rgba(124,246,192,0.06)'
  ctx.fill()
  ctx.strokeStyle = s.rebuilt ? 'rgba(255,209,102,0.9)' : 'rgba(124,246,192,0.85)'
  ctx.lineWidth = 2
  ctx.stroke()

  // Points, in shuffled scan order: faint until processed, bright once seen.
  for (let i = 0; i < s.order.length; i++) {
    const q = toPx(s.order[i])
    const processed = i < s.processed
    const current = i === s.current
    const support = isSupport(s.order[i])
    ctx.beginPath()
    ctx.arc(q.x, q.y, current ? 7 : support ? 6 : 4, 0, Math.PI * 2)
    ctx.fillStyle = current ? '#7cf6c0' : support ? '#9cc0ff' : processed ? '#f4f7ff' : 'rgba(150,160,200,0.4)'
    ctx.fill()
    if (support) {
      ctx.beginPath()
      ctx.arc(q.x, q.y, 9, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(156,192,255,0.8)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }
  // Centre marker.
  ctx.beginPath()
  ctx.arc(center.x, center.y, 2.5, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.fill()
}

function drawFortuneStep(
  ctx: CanvasRenderingContext2D,
  s: FortuneSnapshot | undefined,
  pts: Point[],
  pad: number,
  w: number,
  h: number,
) {
  if (!s) return
  // Flip y so larger world-y is higher on screen — the canonical Fortune picture,
  // with the sweep descending and parabolas opening upward off their sites.
  const toPx = (p: Point) => ({ x: pad + p.x * w, y: pad + (1 - p.y) * h })
  const sweepScreenY = pad + (1 - s.sweepY) * h

  // Pending circle events: faint circumcircles with their bottom (event) point.
  for (const c of s.circles) {
    const ctr = toPx({ x: c.x, y: c.y })
    ctx.beginPath()
    ctx.arc(ctr.x, ctr.y, Math.max(0, c.r * w), 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255,107,107,0.25)'
    ctx.lineWidth = 1
    ctx.stroke()
    const bottom = toPx({ x: c.x, y: c.y - c.r })
    ctx.beginPath()
    ctx.arc(bottom.x, bottom.y, 2.5, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,107,107,0.7)'
    ctx.fill()
  }

  // Beach line: each arc's parabola over the stretch where it is the lowest.
  if (s.arcSites.length > 0 && Number.isFinite(s.sweepY)) {
    const intervals = beachIntervals(pts, s.arcSites, s.sweepY, 0, 1)
    ctx.strokeStyle = 'rgba(156,192,255,0.9)'
    ctx.lineWidth = 2
    for (const iv of intervals) {
      if (iv.hi - iv.lo < 1e-4) continue
      ctx.beginPath()
      const steps = 64
      let started = false
      for (let k = 0; k <= steps; k++) {
        const x = iv.lo + ((iv.hi - iv.lo) * k) / steps
        let wy = parabolaY(pts[iv.site], s.sweepY, x)
        wy = Math.max(-1, Math.min(2, wy)) // clamp degenerate blow-ups
        const q = toPx({ x, y: wy })
        if (!started) {
          ctx.moveTo(q.x, q.y)
          started = true
        } else ctx.lineTo(q.x, q.y)
      }
      ctx.stroke()
    }
  }

  // The sweep line.
  if (Number.isFinite(s.sweepY)) {
    ctx.beginPath()
    ctx.moveTo(pad, sweepScreenY)
    ctx.lineTo(pad + w, sweepScreenY)
    ctx.strokeStyle = 'rgba(124,246,192,0.7)'
    ctx.lineWidth = 1.5
    ctx.setLineDash([6, 5])
    ctx.stroke()
    ctx.setLineDash([])
  }

  // Voronoi vertices fixed so far.
  ctx.fillStyle = 'rgba(255,209,102,0.95)'
  for (const v of s.vertices) {
    const q = toPx(v)
    ctx.beginPath()
    ctx.arc(q.x, q.y, 2.6, 0, Math.PI * 2)
    ctx.fill()
  }

  // Sites: faint until the sweep has passed them, bright once processed.
  for (let i = 0; i < pts.length; i++) {
    const q = toPx(pts[i])
    const processed = !Number.isFinite(s.sweepY) || pts[i].y >= s.sweepY - 1e-9
    const active = i === s.active
    ctx.beginPath()
    ctx.arc(q.x, q.y, active ? 7 : 4, 0, Math.PI * 2)
    ctx.fillStyle = active ? '#7cf6c0' : processed ? '#f4f7ff' : 'rgba(150,160,200,0.4)'
    ctx.fill()
  }
}

function drawQuickHullStep(
  ctx: CanvasRenderingContext2D,
  s: QuickHullStep | undefined,
  pts: Point[],
  toPx: (p: Point) => Point,
) {
  if (!s) return
  const outside = new Set(s.outside)
  const [pI, qI] = s.edge

  // The active edge being expanded — a bold amber baseline.
  if (pI >= 0 && qI >= 0) {
    const a = toPx(pts[pI])
    const b = toPx(pts[qI])
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.strokeStyle = 'rgba(255,209,102,0.8)'
    ctx.lineWidth = 1.6
    ctx.setLineDash([6, 5])
    ctx.stroke()
    ctx.setLineDash([])
    // The split into two new edges through the chosen apex.
    if (s.apex >= 0) {
      const c = toPx(pts[s.apex])
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(c.x, c.y)
      ctx.lineTo(b.x, b.y)
      ctx.strokeStyle = 'rgba(124,246,192,0.7)'
      ctx.lineWidth = 1.4
      ctx.stroke()
    }
  }

  // The committed hull boundary so far (a growing convex polyline / polygon).
  if (s.boundary.length >= 2) {
    ctx.beginPath()
    s.boundary.forEach((idx, k) => {
      const v = toPx(pts[idx])
      if (k === 0) ctx.moveTo(v.x, v.y)
      else ctx.lineTo(v.x, v.y)
    })
    ctx.closePath()
    ctx.strokeStyle = 'rgba(150,190,255,0.9)'
    ctx.lineWidth = 2
    ctx.stroke()
  }

  const onHull = new Set(s.boundary)
  for (let i = 0; i < pts.length; i++) {
    const v = toPx(pts[i])
    const isApex = i === s.apex
    const isOut = outside.has(i)
    ctx.beginPath()
    ctx.arc(v.x, v.y, isApex ? 7 : 4, 0, Math.PI * 2)
    ctx.fillStyle = isApex
      ? '#7cf6c0'
      : onHull.has(i)
        ? '#9cc0ff'
        : isOut
          ? '#ff8a8a'
          : 'rgba(150,160,200,0.45)'
    ctx.fill()
  }
}

function drawPowerStep(
  ctx: CanvasRenderingContext2D,
  s: PowerCellStep | undefined,
  sites: WeightedSite[],
  target: number,
  toPx: (p: Point) => Point,
  scale: number,
) {
  if (!s) return

  // Faint radical circles (√w) so the weights are visible.
  ctx.lineWidth = 1
  for (const site of sites) {
    const rc = radicalCircle(site)
    if (!rc) continue
    const c = toPx({ x: rc.x, y: rc.y })
    ctx.beginPath()
    ctx.arc(c.x, c.y, rc.r * scale, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255,180,90,0.22)'
    ctx.stroke()
  }

  // The current radical axis being clipped against.
  if (s.line) {
    const a = toPx(s.line[0])
    const b = toPx(s.line[1])
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.strokeStyle = 'rgba(255,107,107,0.7)'
    ctx.lineWidth = 1.5
    ctx.setLineDash([6, 5])
    ctx.stroke()
    ctx.setLineDash([])
  }

  // The cell polygon so far.
  if (s.poly.length >= 3) {
    ctx.beginPath()
    s.poly.forEach((p, k) => {
      const v = toPx(p)
      if (k === 0) ctx.moveTo(v.x, v.y)
      else ctx.lineTo(v.x, v.y)
    })
    ctx.closePath()
    ctx.fillStyle = 'rgba(124,246,192,0.12)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(124,246,192,0.85)'
    ctx.lineWidth = 2
    ctx.stroke()
  }

  // Sites: the target bright, the current neighbour red, the rest plain.
  for (let i = 0; i < sites.length; i++) {
    const v = toPx({ x: sites[i].x, y: sites[i].y })
    const isTarget = i === target
    const isAgainst = i === s.against
    ctx.beginPath()
    ctx.arc(v.x, v.y, isTarget ? 7 : isAgainst ? 6 : 4, 0, Math.PI * 2)
    ctx.fillStyle = isTarget ? '#7cf6c0' : isAgainst ? '#ff8a8a' : '#f4f7ff'
    ctx.fill()
    if (isTarget) {
      ctx.beginPath()
      ctx.arc(v.x, v.y, 10, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(124,246,192,0.6)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }
}

function drawKdBuildStep(
  ctx: CanvasRenderingContext2D,
  s: KdBuildStep | undefined,
  pts: Point[],
  toPx: (p: Point) => Point,
) {
  if (!s) return
  // The region this node is about to divide — a soft highlight.
  const a = toPx({ x: s.region.minX, y: s.region.minY })
  const b = toPx({ x: s.region.maxX, y: s.region.maxY })
  ctx.fillStyle = 'rgba(150,190,255,0.07)'
  ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y)
  ctx.strokeStyle = 'rgba(150,190,255,0.5)'
  ctx.lineWidth = 1.2
  ctx.setLineDash([4, 4])
  ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y)
  ctx.setLineDash([])

  // Every cut committed so far (cumulative), coloured by depth.
  ctx.lineCap = 'round'
  for (const cut of s.placed) {
    const p0 = toPx(cut.p0)
    const p1 = toPx(cut.p1)
    const isNew = s.split && cut === s.split
    const hue = cut.axis === 0 ? 200 : 150
    ctx.strokeStyle = isNew ? '#7cf6c0' : `hsla(${hue},80%,${Math.min(80, 50 + cut.depth * 6)}%,0.55)`
    ctx.lineWidth = isNew ? 2.6 : Math.max(0.8, 2 - cut.depth * 0.2)
    ctx.beginPath()
    ctx.moveTo(p0.x, p0.y)
    ctx.lineTo(p1.x, p1.y)
    ctx.stroke()
  }

  // Points, with the median pivot for this step highlighted.
  for (let i = 0; i < pts.length; i++) {
    const q = toPx(pts[i])
    const isPivot = i === s.pivot
    ctx.beginPath()
    ctx.arc(q.x, q.y, isPivot ? 6.5 : 3.5, 0, Math.PI * 2)
    ctx.fillStyle = isPivot ? '#7cf6c0' : '#f4f7ff'
    ctx.fill()
  }
}

function drawQuadBuildStep(
  ctx: CanvasRenderingContext2D,
  s: QuadBuildStep | undefined,
  pts: Point[],
  toPx: (p: Point) => Point,
) {
  if (!s) return
  // The quadtree grid so far, cell borders tinted by depth.
  for (const c of s.cells) {
    const a = toPx({ x: c.bounds.minX, y: c.bounds.minY })
    const b = toPx({ x: c.bounds.maxX, y: c.bounds.maxY })
    ctx.strokeStyle = `rgba(167,139,250,${(0.18 + c.depth * 0.06).toFixed(3)})`
    ctx.lineWidth = 1
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y)
  }
  // The cell that just split, flashed in red.
  if (s.subdivided) {
    const a = toPx({ x: s.subdivided.minX, y: s.subdivided.minY })
    const b = toPx({ x: s.subdivided.maxX, y: s.subdivided.maxY })
    ctx.strokeStyle = 'rgba(255,107,107,0.8)'
    ctx.lineWidth = 2
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y)
  }
  // Points inserted up to (and including) this step; the newest highlighted.
  for (let i = 0; i <= s.inserted && i < pts.length; i++) {
    const q = toPx(pts[i])
    const isNew = i === s.inserted
    ctx.beginPath()
    ctx.arc(q.x, q.y, isNew ? 6.5 : 3.5, 0, Math.PI * 2)
    ctx.fillStyle = isNew ? '#7cf6c0' : '#f4f7ff'
    ctx.fill()
  }
}

function bentleyNote(s: SweepStep | undefined): string {
  if (!s) return ''
  const at = `sweep x = ${s.x.toFixed(3)}, ${s.status.length} in status`
  if (s.kind === 'left') return `Left endpoint reached — insert the segment into the status. ${at}.`
  if (s.kind === 'right') return `Right endpoint reached — remove the segment; its old neighbours become adjacent and are tested. ${at}.`
  return s.found
    ? `Crossing event — a new intersection is reported and the two segments swap order. ${at}.`
    : `Crossing event (already reported) — swap the two segments' order. ${at}.`
}

function drawBentleyStep(
  ctx: CanvasRenderingContext2D,
  steps: SweepStep[],
  clamped: number,
  segs: Segment[],
  toPx: (p: Point) => { x: number; y: number },
  pad: number,
  w: number,
  h: number,
) {
  const s = steps[clamped]
  if (!s) return
  const active = new Set(s.status)

  // All segments: faint by default, brighter if currently on the sweep-line status.
  for (let i = 0; i < segs.length; i++) {
    const a = toPx(segs[i].a)
    const b = toPx(segs[i].b)
    ctx.strokeStyle = active.has(i) ? 'rgba(156,192,255,0.95)' : 'rgba(120,140,180,0.35)'
    ctx.lineWidth = active.has(i) ? 2.4 : 1.2
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }

  // The vertical sweep line.
  const sx = pad + s.x * w
  ctx.strokeStyle = 'rgba(255,209,102,0.8)'
  ctx.lineWidth = 1.4
  ctx.setLineDash([5, 4])
  ctx.beginPath()
  ctx.moveTo(sx, pad)
  ctx.lineTo(sx, pad + h)
  ctx.stroke()
  ctx.setLineDash([])

  // Status order labels down the sweep line (bottom → top of the ordering).
  ctx.fillStyle = 'rgba(255,209,102,0.55)'
  ctx.font = '600 10px ui-sans-serif, system-ui'
  s.status.forEach((segIdx, k) => {
    ctx.fillText(`${k}`, sx + 4, pad + 14 + k * 12)
    void segIdx
  })

  // Intersections reported up to and including this step; the newest one flares.
  for (let i = 0; i <= clamped; i++) {
    const f = steps[i].found
    if (!f) continue
    const q = toPx(f)
    const isNew = i === clamped
    ctx.beginPath()
    ctx.arc(q.x, q.y, isNew ? 7 : 4, 0, Math.PI * 2)
    ctx.fillStyle = isNew ? 'rgba(255,209,102,0.95)' : 'rgba(255,209,102,0.6)'
    ctx.fill()
    if (isNew) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }
}
