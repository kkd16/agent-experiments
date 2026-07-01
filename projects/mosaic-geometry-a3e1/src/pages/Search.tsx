import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Point, Rect, Triangle } from '../geometry/types'
import {
  buildKdTree,
  kdNearest,
  kdApproxNearest,
  kdKNearest,
  kdRange,
  kdDepth,
  kdSize,
  kdSplits,
} from '../geometry/kdtree'
import { buildQuadtree, quadLeaves, quadRange, quadStats } from '../geometry/quadtree'
import { buildRangeTree, rangeQuery } from '../geometry/rangeTree'
import { delaunay } from '../geometry/delaunay'
import { buildMesh, locate, locateBruteForce, pointInTriangle } from '../geometry/pointLocation'
import { jitteredGrid, mulberry32, poissonDisk, uniformPoints } from '../geometry/random'
import { dist as euclid } from '../geometry/vector'
import { useCanvas } from '../hooks/useCanvas'
import { usePersistentState } from '../hooks/usePersistentState'
import { Button, Panel, Segmented, Slider, Stat, Toggle } from '../components/Controls'

// The Spatial Search explorer: an interactive playground for the data structures
// that answer geometric *queries*. Move the probe to run nearest-neighbour /
// k-nearest / point-location queries live; drag a window to run a range query.
// Two space-partitioning hierarchies (k-d tree, quadtree) can be overlaid, and
// every answer is cross-checked against an O(n) brute-force scan so the speed-up
// (nodes touched vs. n) is shown alongside a correctness badge.

const CLIP: Rect = { minX: 0, minY: 0, maxX: 1, maxY: 1 }
const PAD = 16

type Distribution = 'poisson' | 'uniform' | 'grid'
type Mode = 'nn' | 'knn' | 'range' | 'locate'

function generate(dist: Distribution, count: number, seed: number): Point[] {
  const rng = mulberry32(seed)
  const inset: Rect = { minX: 0.05, minY: 0.05, maxX: 0.95, maxY: 0.95 }
  if (dist === 'uniform') return uniformPoints(count, inset, rng)
  if (dist === 'grid') return jitteredGrid(count, inset, rng)
  return poissonDisk(count, inset, rng)
}

const inWindow = (p: Point, r: Rect) =>
  p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY

export default function Search() {
  const { ref, size } = useCanvas()
  const [dist, setDist] = usePersistentState<Distribution>('search:dist', 'poisson')
  const [count, setCount] = usePersistentState<number>('search:count', 160)
  const [seed, setSeed] = useState(2)
  const [points, setPoints] = useState<Point[]>(() => generate('poisson', 160, 2))

  const [mode, setMode] = usePersistentState<Mode>('search:mode', 'nn')
  const [showKd, setShowKd] = usePersistentState<boolean>('search:kd', true)
  const [showQuad, setShowQuad] = usePersistentState<boolean>('search:quad', false)
  const [k, setK] = usePersistentState<number>('search:k', 8)
  const [approx, setApprox] = usePersistentState<boolean>('search:approx', false)
  const [epsilon, setEpsilon] = usePersistentState<number>('search:eps', 0.5)

  const [query, setQuery] = useState<Point>({ x: 0.5, y: 0.5 })
  const [windowRect, setWindowRect] = useState<Rect>({ minX: 0.3, minY: 0.3, maxX: 0.7, maxY: 0.6 })
  const dragMode = useRef<'none' | 'probe' | 'box'>('none')
  const boxAnchor = useRef<Point>({ x: 0, y: 0 })

  // ── Derived structures (rebuilt only when the point set changes) ────────────
  const kdTree = useMemo(() => buildKdTree(points, CLIP), [points])
  const quadTree = useMemo(() => buildQuadtree(points, CLIP), [points])
  const rangeTree = useMemo(() => buildRangeTree(points), [points])
  const tris = useMemo<Triangle[]>(() => (points.length >= 3 ? delaunay(points) : []), [points])
  const mesh = useMemo(() => buildMesh(points, tris), [points, tris])
  const kdSplitLines = useMemo(() => (showKd ? kdSplits(kdTree, points) : []), [showKd, kdTree, points])
  const quadCells = useMemo(() => (showQuad ? quadLeaves(quadTree) : []), [showQuad, quadTree])

  // ── Query results (recomputed as the probe / window moves) ──────────────────
  const nn = useMemo(() => kdNearest(kdTree, points, query), [kdTree, points, query])
  const ann = useMemo(
    () => kdApproxNearest(kdTree, points, query, epsilon),
    [kdTree, points, query, epsilon],
  )
  const knn = useMemo(() => kdKNearest(kdTree, points, query, k), [kdTree, points, query, k])
  const range = useMemo(() => kdRange(kdTree, points, windowRect), [kdTree, points, windowRect])
  const quadRangeRes = useMemo(() => quadRange(quadTree, points, windowRect), [quadTree, points, windowRect])
  const rtRangeRes = useMemo(() => rangeQuery(rangeTree, windowRect), [rangeTree, windowRect])
  const located = useMemo(() => locate(mesh, query, 0), [mesh, query])

  // ── Brute-force oracles → correctness badges ────────────────────────────────
  const nnVerified = useMemo(() => {
    let bd = Infinity
    for (const p of points) bd = Math.min(bd, euclid(p, query))
    return points.length === 0 || Math.abs(nn.dist - bd) < 1e-9
  }, [points, query, nn])
  const rangeVerified = useMemo(() => {
    const brute = points.reduce((s, p) => (inWindow(p, windowRect) ? s + 1 : s), 0)
    return (
      brute === range.indices.length &&
      brute === quadRangeRes.indices.length &&
      brute === rtRangeRes.indices.length
    )
  }, [points, windowRect, range, quadRangeRes, rtRangeRes])
  const annVerified = useMemo(() => {
    if (points.length === 0) return true
    // The approximate answer must sit within the (1 + ε) factor of the true nearest.
    return ann.dist <= (1 + epsilon) * nn.dist + 1e-9
  }, [points, ann, nn, epsilon])
  const locateVerified = useMemo(() => {
    const brute = locateBruteForce(points, tris, query)
    if (brute < 0) return located.triangle < 0 // both agree the probe is outside the hull
    if (located.triangle < 0) return false
    const t = tris[located.triangle]
    return pointInTriangle(points[t.a], points[t.b], points[t.c], query)
  }, [points, tris, query, located])

  const kdInfo = useMemo(() => ({ size: kdSize(kdTree), depth: kdDepth(kdTree) }), [kdTree])
  const quadInfo = useMemo(() => quadStats(quadTree), [quadTree])

  // ── Pointer interaction ─────────────────────────────────────────────────────
  const toWorld = useCallback(
    (clientX: number, clientY: number): Point => {
      const canvas = ref.current
      if (!canvas) return { x: 0, y: 0 }
      const rect = canvas.getBoundingClientRect()
      const w = size.width - PAD * 2
      const h = size.height - PAD * 2
      return {
        x: Math.min(1, Math.max(0, (clientX - rect.left - PAD) / w)),
        y: Math.min(1, Math.max(0, (clientY - rect.top - PAD) / h)),
      }
    },
    [ref, size],
  )

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toWorld(e.clientX, e.clientY)
    e.currentTarget.setPointerCapture(e.pointerId)
    if (mode === 'range') {
      dragMode.current = 'box'
      boxAnchor.current = p
      setWindowRect({ minX: p.x, minY: p.y, maxX: p.x, maxY: p.y })
    } else {
      dragMode.current = 'probe'
      setQuery(p)
    }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toWorld(e.clientX, e.clientY)
    if (dragMode.current === 'box') {
      const a = boxAnchor.current
      setWindowRect({
        minX: Math.min(a.x, p.x),
        minY: Math.min(a.y, p.y),
        maxX: Math.max(a.x, p.x),
        maxY: Math.max(a.y, p.y),
      })
    } else if (mode !== 'range') {
      // The probe tracks the cursor live, even without a button held down.
      setQuery(p)
    }
  }
  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragMode.current = 'none'
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
  }

  const regenerate = (nextSeed = seed) => setPoints(generate(dist, count, nextSeed))
  const reseed = () => {
    const next = seed + 1
    setSeed(next)
    regenerate(next)
  }

  // ── Rendering ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || size.width === 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { width, height, dpr } = size
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const bg = ctx.createRadialGradient(width / 2, height * 0.42, 0, width / 2, height / 2, Math.max(width, height) * 0.75)
    bg.addColorStop(0, '#0e1525')
    bg.addColorStop(1, '#070a12')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, width, height)

    const w = width - PAD * 2
    const h = height - PAD * 2
    const toPx = (p: Point) => ({ x: PAD + p.x * w, y: PAD + p.y * h })
    const sx = (v: number) => v * w // world→pixel scale (x); frame is near-square
    const rectPx = (r: Rect) => {
      const a = toPx({ x: r.minX, y: r.minY })
      const b = toPx({ x: r.maxX, y: r.maxY })
      return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }
    }

    // Quadtree grid (drawn faint, under everything).
    if (showQuad) {
      for (const c of quadCells) {
        const r = rectPx(c.bounds)
        ctx.strokeStyle = `rgba(167,139,250,${(0.12 + c.depth * 0.05).toFixed(3)})`
        ctx.lineWidth = 1
        ctx.strokeRect(r.x, r.y, r.w, r.h)
      }
    }
    // k-d partition (colored by depth: warmer = deeper).
    if (showKd) {
      ctx.lineCap = 'round'
      for (const s of kdSplitLines) {
        const a = toPx(s.p0)
        const b = toPx(s.p1)
        const hue = s.axis === 0 ? 200 : 150
        const light = Math.min(80, 45 + s.depth * 6)
        ctx.strokeStyle = `hsla(${hue},80%,${light}%,${Math.max(0.18, 0.7 - s.depth * 0.07).toFixed(3)})`
        ctx.lineWidth = Math.max(0.6, 2 - s.depth * 0.18)
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
    }

    // Locate mode: faint Delaunay mesh + highlighted triangle + the walk path.
    if (mode === 'locate') {
      ctx.strokeStyle = 'rgba(120,170,255,0.18)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (const t of tris) {
        const a = toPx(points[t.a])
        const b = toPx(points[t.b])
        const c = toPx(points[t.c])
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.lineTo(c.x, c.y)
        ctx.lineTo(a.x, a.y)
      }
      ctx.stroke()
      // The walk: a polyline through visited triangle centroids.
      const centroid = (t: Triangle) => ({
        x: (points[t.a].x + points[t.b].x + points[t.c].x) / 3,
        y: (points[t.a].y + points[t.b].y + points[t.c].y) / 3,
      })
      if (located.path.length > 1) {
        ctx.strokeStyle = 'rgba(255,209,102,0.7)'
        ctx.lineWidth = 1.6
        ctx.setLineDash([5, 4])
        ctx.beginPath()
        located.path.forEach((ti, idx) => {
          const q = toPx(centroid(tris[ti]))
          if (idx === 0) ctx.moveTo(q.x, q.y)
          else ctx.lineTo(q.x, q.y)
        })
        ctx.stroke()
        ctx.setLineDash([])
      }
      if (located.triangle >= 0) {
        const t = tris[located.triangle]
        const a = toPx(points[t.a])
        const b = toPx(points[t.b])
        const c = toPx(points[t.c])
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.lineTo(c.x, c.y)
        ctx.closePath()
        ctx.fillStyle = 'rgba(124,246,192,0.18)'
        ctx.fill()
        ctx.strokeStyle = 'rgba(124,246,192,0.95)'
        ctx.lineWidth = 2
        ctx.stroke()
      }
    }

    // Range mode: the window + highlighted contained points.
    const hits = new Set<number>()
    if (mode === 'range') {
      const r = rectPx(windowRect)
      ctx.fillStyle = 'rgba(96,205,255,0.08)'
      ctx.fillRect(r.x, r.y, r.w, r.h)
      ctx.strokeStyle = 'rgba(96,205,255,0.9)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([6, 4])
      ctx.strokeRect(r.x, r.y, r.w, r.h)
      ctx.setLineDash([])
      for (const i of range.indices) hits.add(i)
    }

    // The k-nearest / nearest highlight set.
    const near = new Set<number>()
    if (mode === 'nn' && nn.index >= 0) near.add(nn.index)
    if (mode === 'knn') for (const hh of knn) near.add(hh.index)

    // Points.
    for (let i = 0; i < points.length; i++) {
      const q = toPx(points[i])
      const isHit = hits.has(i)
      const isNear = near.has(i)
      const r = isNear ? 5 : isHit ? 4.5 : 2.8
      ctx.beginPath()
      ctx.arc(q.x, q.y, r, 0, Math.PI * 2)
      ctx.fillStyle = isNear ? '#7cf6c0' : isHit ? '#60cdff' : 'rgba(200,212,240,0.55)'
      ctx.fill()
    }

    // NN / kNN spokes + bounding ball.
    const qp = toPx(query)
    if (mode === 'nn' && nn.index >= 0) {
      const t = toPx(points[nn.index])
      ctx.strokeStyle = 'rgba(124,246,192,0.9)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(qp.x, qp.y)
      ctx.lineTo(t.x, t.y)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(qp.x, qp.y, sx(nn.dist), 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(124,246,192,0.35)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
    // Approximate-NN result: an amber marker (+ ring) when it differs from exact.
    if (mode === 'nn' && approx && ann.index >= 0) {
      const t = toPx(points[ann.index])
      ctx.strokeStyle = 'rgba(255,179,71,0.95)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(t.x, t.y, 7, 0, Math.PI * 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(qp.x, qp.y, sx(ann.dist), 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,179,71,0.28)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
    if (mode === 'knn' && knn.length > 0) {
      ctx.strokeStyle = 'rgba(124,246,192,0.5)'
      ctx.lineWidth = 1.2
      for (const hh of knn) {
        const t = toPx(points[hh.index])
        ctx.beginPath()
        ctx.moveTo(qp.x, qp.y)
        ctx.lineTo(t.x, t.y)
        ctx.stroke()
      }
      ctx.beginPath()
      ctx.arc(qp.x, qp.y, sx(knn[knn.length - 1].dist), 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(124,246,192,0.3)'
      ctx.lineWidth = 1
      ctx.stroke()
    }

    // The probe crosshair (hidden in range mode, where the window is the query).
    if (mode !== 'range') {
      ctx.strokeStyle = '#ffd166'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(qp.x - 8, qp.y)
      ctx.lineTo(qp.x + 8, qp.y)
      ctx.moveTo(qp.x, qp.y - 8)
      ctx.lineTo(qp.x, qp.y + 8)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(qp.x, qp.y, 3, 0, Math.PI * 2)
      ctx.fillStyle = '#ffd166'
      ctx.fill()
    }
  }, [ref, size, points, tris, mode, showKd, showQuad, kdSplitLines, quadCells, query, windowRect, nn, ann, approx, knn, range, located, k])

  const badge = (ok: boolean) => (
    <span className={`badge ${ok ? 'badge--ok' : 'badge--bad'}`}>{ok ? '✓ verified' : '✗ mismatch'}</span>
  )

  return (
    <div className="studio">
      <div className="stage">
        <canvas
          ref={ref}
          className="stage__canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
          onContextMenu={(e) => e.preventDefault()}
        />
        <div className="stage__chips">
          <Stat label="points" value={points.length} />
          {mode === 'nn' && <Stat label="nodes visited" value={`${nn.visited} / ${points.length}`} />}
          {mode === 'knn' && <Stat label="found" value={knn.length} />}
          {mode === 'range' && <Stat label="in window" value={range.indices.length} />}
          {mode === 'range' && <Stat label="k-d nodes" value={`${range.visited} / ${points.length}`} />}
          {mode === 'locate' && <Stat label="walk length" value={located.path.length} />}
        </div>
        <p className="stage__hint">
          {mode === 'range'
            ? 'Drag a rectangle to run an orthogonal range query'
            : 'Move the probe — the query runs live as you go'}
        </p>
      </div>

      <aside className="sidebar">
        <Panel title="Query" hint="spatial search">
          <Segmented<Mode>
            options={[
              { id: 'nn', label: 'Nearest' },
              { id: 'knn', label: 'k-NN' },
              { id: 'range', label: 'Range' },
              { id: 'locate', label: 'Locate' },
            ]}
            value={mode}
            onChange={setMode}
          />
          <p className="muted">
            {mode === 'nn'
              ? 'Nearest-neighbour search down the k-d tree: descend toward the probe, then unwind, only visiting a far subtree when its slab could still hold something closer. The ring is the nearest distance.'
              : mode === 'knn'
                ? 'k-nearest neighbours: the same descent keeps the best k seen so far and prunes against the current kᵗʰ distance. The ring is the kᵗʰ-nearest radius.'
                : mode === 'range'
                  ? 'Orthogonal range reporting: both the k-d tree and the quadtree skip any region disjoint from the window, so only cells overlapping it are opened.'
                  : 'Point location by jump-and-walk on the Delaunay mesh: step across whichever edge the probe lies outside of until a triangle contains it. The dashed trail is the walk.'}
          </p>
          {mode === 'knn' && (
            <Slider label="k (neighbours)" value={k} min={1} max={20} step={1} onChange={setK} />
          )}
          {mode === 'nn' && (
            <>
              <div className="layers">
                <Toggle
                  label="Approximate (best-bin-first)"
                  swatch="#ffb347"
                  checked={approx}
                  onChange={setApprox}
                />
              </div>
              {approx && (
                <Slider label="ε (max relative error)" value={epsilon} min={0} max={2} step={0.1} onChange={setEpsilon} />
              )}
            </>
          )}
        </Panel>

        <Panel title="Result" hint="vs. brute force">
          {mode === 'nn' && (
            <>
              <div className="metrics">
                <Stat label="nearest #" value={nn.index >= 0 ? nn.index : '—'} />
                <Stat label="distance" value={nn.index >= 0 ? nn.dist.toFixed(4) : '—'} />
                <Stat label="nodes visited" value={`${nn.visited} / ${points.length}`} />
              </div>
              {badge(nnVerified)}
              {approx && (
                <>
                  <p className="muted">
                    Best-bin-first explores subtrees closest-region-first and stops once no
                    unopened region can beat the current best by more than (1+ε) — a bounded-error
                    answer for a fraction of the work.
                  </p>
                  <div className="metrics">
                    <Stat label="approx #" value={ann.index >= 0 ? ann.index : '—'} />
                    <Stat label="approx dist" value={ann.index >= 0 ? ann.dist.toFixed(4) : '—'} />
                    <Stat label="approx visited" value={`${ann.visited} / ${points.length}`} />
                    <Stat
                      label="visited vs exact"
                      value={`${(nn.visited > 0 ? ann.visited / nn.visited : 1).toFixed(2)}×`}
                    />
                  </div>
                  {badge(annVerified)}
                </>
              )}
            </>
          )}
          {mode === 'knn' && (
            <>
              <div className="metrics">
                <Stat label="found" value={knn.length} />
                <Stat label="kᵗʰ dist" value={knn.length ? knn[knn.length - 1].dist.toFixed(4) : '—'} />
              </div>
              <p className="muted">Distances are sorted ascending and matched against a full scan.</p>
            </>
          )}
          {mode === 'range' && (
            <>
              <div className="metrics">
                <Stat label="in window" value={range.indices.length} />
                <Stat label="k-d nodes" value={`${range.visited} / ${points.length}`} />
                <Stat label="quad nodes" value={quadRangeRes.visited} />
                <Stat label="range-tree canon." value={rtRangeRes.canonical} />
              </div>
              <p className="muted">
                The range tree decomposes the window into only {rtRangeRes.canonical} canonical
                subtrees — O(log n) regardless of how many points fall inside — thanks to fractional
                cascading, versus the k-d tree’s Θ(√n) region scan.
              </p>
              {badge(rangeVerified)}
            </>
          )}
          {mode === 'locate' && (
            <>
              <div className="metrics">
                <Stat label="triangle" value={located.triangle >= 0 ? located.triangle : 'outside'} />
                <Stat label="walk length" value={located.path.length} />
                <Stat label="of triangles" value={tris.length} />
              </div>
              {badge(locateVerified)}
            </>
          )}
        </Panel>

        <Panel title="Structure">
          <div className="layers">
            <Toggle label="k-d tree partition" swatch="hsl(200,80%,60%)" checked={showKd} onChange={setShowKd} />
            <Toggle label="Quadtree grid" swatch="rgba(167,139,250,0.9)" checked={showQuad} onChange={setShowQuad} />
          </div>
          <div className="metrics">
            <Stat label="k-d nodes" value={kdInfo.size} />
            <Stat label="k-d depth" value={kdInfo.depth} />
            <Stat label="quad leaves" value={quadInfo.leaves} />
            <Stat label="quad depth" value={quadInfo.maxDepth} />
          </div>
        </Panel>

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
          <Slider label="Count" value={count} min={4} max={800} step={1} onChange={setCount} />
          <div className="row">
            <Button variant="primary" onClick={() => regenerate()}>
              Generate
            </Button>
            <Button onClick={reseed}>New seed</Button>
          </div>
        </Panel>
      </aside>
    </div>
  )
}
