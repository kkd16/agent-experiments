import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Point, Rect } from '../geometry/types'
import { computeGeometry } from '../geometry/compute'
import { lloydStep } from '../geometry/lloyd'
import { jitteredGrid, mulberry32, poissonDisk, uniformPoints } from '../geometry/random'
import { useCanvas } from '../hooks/useCanvas'
import { usePersistentState } from '../hooks/usePersistentState'
import { drawScene, type LayerToggles } from '../render/scene'
import { getScheme, SCHEMES } from '../render/palette'
import { Button, Panel, Segmented, Slider, Stat, Toggle } from '../components/Controls'

const CLIP: Rect = { minX: 0, minY: 0, maxX: 1, maxY: 1 }
const PAD = 14

type Distribution = 'poisson' | 'uniform' | 'grid'

const DEFAULT_LAYERS: LayerToggles = {
  voronoiFill: true,
  voronoiEdges: true,
  delaunay: false,
  circumcircles: false,
  hull: false,
  gabriel: false,
  mst: false,
  centroids: false,
  points: true,
}

function generate(dist: Distribution, count: number, seed: number): Point[] {
  const rng = mulberry32(seed)
  // Generate inside an inset rectangle so nothing sits exactly on the border.
  const inset: Rect = { minX: 0.04, minY: 0.04, maxX: 0.96, maxY: 0.96 }
  if (dist === 'uniform') return uniformPoints(count, inset, rng)
  if (dist === 'grid') return jitteredGrid(count, inset, rng)
  return poissonDisk(count, inset, rng)
}

export default function Studio() {
  const { ref, size } = useCanvas()
  const [points, setPoints] = useState<Point[]>(() => generate('poisson', 240, 1))
  const [layers, setLayers] = usePersistentState<LayerToggles>('layers', DEFAULT_LAYERS)
  const [schemeId, setSchemeId] = usePersistentState<string>('scheme', 'aurora')
  const [cellAlpha, setCellAlpha] = usePersistentState<number>('alpha', 0.92)
  const [dist, setDist] = usePersistentState<Distribution>('dist', 'poisson')
  const [count, setCount] = usePersistentState<number>('count', 240)
  const [seed, setSeed] = useState(1)

  const [hover, setHover] = useState(-1)
  const [selected, setSelected] = useState(-1)
  const [animating, setAnimating] = useState(false)
  const [relaxStats, setRelaxStats] = useState({ iterations: 0, movement: 0 })

  const dragRef = useRef(-1)
  const pointsRef = useRef(points)
  useEffect(() => {
    pointsRef.current = points
  }, [points])

  const scheme = getScheme(schemeId)
  const geometry = useMemo(
    () => computeGeometry(points, CLIP, { gabriel: layers.gabriel }),
    [points, layers.gabriel],
  )

  // ── Draw whenever anything visible changes ────────────────────────────────
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || size.width === 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    drawScene(
      ctx,
      {
        points,
        hull: geometry.hull,
        delaunayEdges: geometry.delaunayEdges,
        cells: geometry.cells,
        circumcircles: geometry.circumcircles,
        centroids: geometry.centroids,
        mst: geometry.mst,
        gabriel: geometry.gabriel,
        hover,
        selected,
      },
      { width: size.width, height: size.height, dpr: size.dpr, pad: PAD, scheme, layers, cellAlpha },
    )
  }, [ref, size, points, geometry, hover, selected, scheme, layers, cellAlpha])

  // ── Lloyd relaxation animation loop ───────────────────────────────────────
  useEffect(() => {
    if (!animating) return
    let raf = 0
    const tick = () => {
      const { sites, movement } = lloydStep(pointsRef.current, CLIP)
      setPoints(sites)
      setRelaxStats((s) => ({ iterations: s.iterations + 1, movement }))
      if (movement < 1e-4) {
        setAnimating(false)
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [animating])

  // ── Pointer interaction ───────────────────────────────────────────────────
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

  const nearestIndex = useCallback((p: Point, maxDistPx: number): number => {
    const pts = pointsRef.current
    const scaleX = size.width - PAD * 2
    const scaleY = size.height - PAD * 2
    let best = -1
    let bestD = (maxDistPx * maxDistPx) / (scaleX * scaleX || 1)
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i].x - p.x
      const dy = (pts[i].y - p.y) * (scaleY / (scaleX || 1))
      const d = dx * dx + dy * dy
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
  }, [size])

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toWorld(e.clientX, e.clientY)
    const hit = nearestIndex(p, 14)
    if (e.shiftKey || e.altKey || e.button === 2) {
      if (hit >= 0) {
        setPoints((prev) => prev.filter((_, i) => i !== hit))
        setSelected(-1)
      }
      return
    }
    if (hit >= 0) {
      dragRef.current = hit
      setSelected(hit)
      e.currentTarget.setPointerCapture(e.pointerId)
    } else {
      const newIndex = pointsRef.current.length
      setPoints((prev) => [...prev, p])
      dragRef.current = newIndex
      setSelected(newIndex)
      e.currentTarget.setPointerCapture(e.pointerId)
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toWorld(e.clientX, e.clientY)
    if (dragRef.current >= 0) {
      const idx = dragRef.current
      setPoints((prev) => prev.map((q, i) => (i === idx ? p : q)))
    } else {
      setHover(nearestIndex(p, 12))
    }
  }

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = -1
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* pointer already released */
    }
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  const regenerate = (nextSeed = seed) => {
    setAnimating(false)
    setRelaxStats({ iterations: 0, movement: 0 })
    setSelected(-1)
    setPoints(generate(dist, count, nextSeed))
  }
  const reseed = () => {
    const next = seed + 1
    setSeed(next)
    regenerate(next)
  }
  const relaxOnce = () => {
    const { sites, movement } = lloydStep(pointsRef.current, CLIP)
    setPoints(sites)
    setRelaxStats((s) => ({ iterations: s.iterations + 1, movement }))
  }
  const clearAll = () => {
    setAnimating(false)
    setPoints([])
    setSelected(-1)
    setRelaxStats({ iterations: 0, movement: 0 })
  }
  const savePng = () => {
    const canvas = ref.current
    if (!canvas) return
    try {
      const url = canvas.toDataURL('image/png')
      const a = document.createElement('a')
      a.href = url
      a.download = 'mosaic.png'
      a.click()
    } catch {
      /* tainted/sandboxed canvas — ignore */
    }
  }

  const setLayer = (key: keyof LayerToggles, v: boolean) => setLayers((p) => ({ ...p, [key]: v }))

  const diag = Math.SQRT2
  return (
    <div className="studio">
      <div className="stage">
        <canvas
          ref={ref}
          className="stage__canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerLeave={() => setHover(-1)}
          onContextMenu={(e) => e.preventDefault()}
        />
        <div className="stage__chips">
          <Stat label="points" value={points.length} />
          <Stat label="triangles" value={geometry.triangleCount} />
          <Stat label="cells" value={geometry.cells.length} />
          <Stat label="hull" value={geometry.hull.length} />
          <Stat label="compute" value={`${geometry.timings.total.toFixed(1)}ms`} />
        </div>
        <p className="stage__hint">
          Click empty space to add a point · drag to move · shift/right-click to delete
        </p>
      </div>

      <aside className="sidebar">
        <Panel title="Points" hint={`${points.length}`}>
          <Segmented<Distribution>
            options={[
              { id: 'poisson', label: 'Blue noise' },
              { id: 'uniform', label: 'Uniform' },
              { id: 'grid', label: 'Grid' },
            ]}
            value={dist}
            onChange={(d) => setDist(d)}
          />
          <Slider
            label="Count"
            value={count}
            min={3}
            max={1200}
            step={1}
            onChange={(v) => setCount(v)}
          />
          <div className="row">
            <Button variant="primary" onClick={() => regenerate()}>
              Generate
            </Button>
            <Button onClick={reseed}>New seed</Button>
            <Button variant="ghost" onClick={clearAll}>
              Clear
            </Button>
          </div>
        </Panel>

        <Panel title="Relaxation" hint="Lloyd / CVT">
          <p className="muted">
            Move every site to the centroid of its Voronoi cell. Iterating yields a centroidal
            Voronoi tessellation — even, organic spacing.
          </p>
          <div className="row">
            <Button variant="primary" onClick={() => setAnimating((a) => !a)} disabled={points.length < 2}>
              {animating ? 'Stop' : 'Animate'}
            </Button>
            <Button onClick={relaxOnce} disabled={points.length < 2 || animating}>
              Step
            </Button>
          </div>
          <div className="metrics">
            <Stat label="iterations" value={relaxStats.iterations} />
            <Stat label="mean move" value={relaxStats.movement.toFixed(5)} />
          </div>
        </Panel>

        <Panel title="Layers">
          <div className="layers">
            <Toggle label="Voronoi fill" checked={layers.voronoiFill} onChange={(v) => setLayer('voronoiFill', v)} />
            <Toggle label="Cell edges" checked={layers.voronoiEdges} onChange={(v) => setLayer('voronoiEdges', v)} />
            <Toggle
              label="Delaunay"
              swatch="rgba(120,170,255,0.9)"
              checked={layers.delaunay}
              onChange={(v) => setLayer('delaunay', v)}
            />
            <Toggle
              label="Circumcircles"
              checked={layers.circumcircles}
              onChange={(v) => setLayer('circumcircles', v)}
            />
            <Toggle
              label="Convex hull"
              swatch="rgba(150,190,255,0.9)"
              checked={layers.hull}
              onChange={(v) => setLayer('hull', v)}
            />
            <Toggle
              label="Gabriel graph"
              swatch="rgba(120,255,214,0.9)"
              checked={layers.gabriel}
              onChange={(v) => setLayer('gabriel', v)}
            />
            <Toggle
              label="Min. spanning tree"
              swatch="rgba(255,209,102,0.95)"
              checked={layers.mst}
              onChange={(v) => setLayer('mst', v)}
            />
            <Toggle label="Cell centroids" checked={layers.centroids} onChange={(v) => setLayer('centroids', v)} />
            <Toggle label="Sites" checked={layers.points} onChange={(v) => setLayer('points', v)} />
          </div>
        </Panel>

        <Panel title="Appearance">
          <div className="swatches">
            {SCHEMES.map((s) => (
              <button
                key={s.id}
                className={`swatch ${s.id === schemeId ? 'is-active' : ''}`}
                title={s.label}
                onClick={() => setSchemeId(s.id)}
                style={{
                  background: `linear-gradient(135deg, rgb(${s.ramp[0].join(',')}), rgb(${s.ramp[2].join(
                    ',',
                  )}))`,
                }}
              >
                <span>{s.label}</span>
              </button>
            ))}
          </div>
          <Slider
            label="Cell opacity"
            value={cellAlpha}
            min={0.15}
            max={1}
            step={0.01}
            onChange={(v) => setCellAlpha(v)}
            format={(v) => `${Math.round(v * 100)}%`}
          />
          <Button variant="ghost" onClick={savePng}>
            Save PNG
          </Button>
        </Panel>

        <Panel title="Metrics">
          <div className="metrics">
            <Stat label="MST length" value={`${(geometry.mstLength / diag).toFixed(3)}`} />
            <Stat label="Delaunay" value={`${geometry.timings.delaunay.toFixed(1)}ms`} />
            <Stat label="Voronoi" value={`${geometry.timings.voronoi.toFixed(1)}ms`} />
            <Stat label="edges" value={geometry.delaunayEdges.length} />
          </div>
        </Panel>
      </aside>
    </div>
  )
}
