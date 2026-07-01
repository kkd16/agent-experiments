import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Circle, Edge, Point, Rect } from '../geometry/types'
import { computeGeometry } from '../geometry/compute'
import { constrainedDelaunay } from '../geometry/constrained'
import { lloydStep } from '../geometry/lloyd'
import {
  powerCells,
  powerLloydStep,
  regularTriangulationEdges,
  hiddenSites,
  radicalCircle,
  type WeightedSite,
} from '../geometry/power'
import { farthestCells, farthestEdges, farthestOwners } from '../geometry/farthest'
import {
  yaoGraph,
  thetaGraph,
  greedySpanner,
  dilation,
  thetaBound,
  type Dilation,
} from '../geometry/spanner'
import { wspdSpanner, wspdSpannerBound } from '../geometry/wspd'
import { jitteredGrid, mulberry32, poissonDisk, uniformPoints } from '../geometry/random'
import { alphaShape, alphaForSlider, circumRadii } from '../geometry/alphaShape'
import { refineDelaunay, type RefineResult } from '../geometry/refine'
import {
  buildShareUrl,
  parsePointsText,
  pointsToText,
  readSharedPoints,
} from '../geometry/pointset'
import { useCanvas } from '../hooks/useCanvas'
import { usePersistentState } from '../hooks/usePersistentState'
import { drawScene, type LayerToggles, type MeasureToggles } from '../render/scene'
import { getScheme, SCHEMES } from '../render/palette'
import { Button, Panel, Segmented, Slider, Stat, TextArea, Toggle } from '../components/Controls'

const CLIP: Rect = { minX: 0, minY: 0, maxX: 1, maxY: 1 }
const PAD = 14
const DIAG = Math.SQRT2 // normalize lengths so the frame diagonal reads as 1.0

type Distribution = 'poisson' | 'uniform' | 'grid'
type SpannerType = 'yao' | 'theta' | 'greedy' | 'wspd'

// Greedy spanner is O(n³)-ish (a Dijkstra per candidate pair), so cap it; Yao/Θ
// are O(n²) and run on the full set without trouble.
const GREEDY_CAP = 120

const DEFAULT_LAYERS: LayerToggles = {
  voronoiFill: true,
  voronoiEdges: true,
  delaunay: false,
  circumcircles: false,
  hull: false,
  gabriel: false,
  rng: false,
  nng: false,
  urquhart: false,
  beta: false,
  knn: false,
  spanner: false,
  alpha: false,
  convexLayers: false,
  mst: false,
  refine: false,
  cdt: false,
  power: false,
  regular: false,
  radical: false,
  farthest: false,
  centroids: false,
  points: true,
}

const DEFAULT_MEASURE: MeasureToggles = {
  closest: false,
  diameter: false,
  width: false,
  mec: false,
  lec: false,
}

function generate(dist: Distribution, count: number, seed: number): Point[] {
  const rng = mulberry32(seed)
  // Generate inside an inset rectangle so nothing sits exactly on the border.
  const inset: Rect = { minX: 0.04, minY: 0.04, maxX: 0.96, maxY: 0.96 }
  if (dist === 'uniform') return uniformPoints(count, inset, rng)
  if (dist === 'grid') return jitteredGrid(count, inset, rng)
  return poissonDisk(count, inset, rng)
}

const initialPoints = (): Point[] => {
  if (typeof window !== 'undefined') {
    try {
      const shared = readSharedPoints(window.location.hash)
      if (shared) return shared
    } catch {
      /* malformed share token — ignore */
    }
  }
  return generate('poisson', 240, 1)
}

const fmt = (v: number) => (v / DIAG).toFixed(3)

export default function Studio() {
  const { ref, size } = useCanvas()
  const [points, setPoints] = useState<Point[]>(initialPoints)
  const [layers, setLayers] = usePersistentState<LayerToggles>('layers', DEFAULT_LAYERS)
  const [measure, setMeasure] = usePersistentState<MeasureToggles>('measure', DEFAULT_MEASURE)
  const [alphaT, setAlphaT] = usePersistentState<number>('alphaT', 0.45)
  const [betaVal, setBetaVal] = usePersistentState<number>('betaVal', 1.5)
  const [kVal, setKVal] = usePersistentState<number>('kVal', 3)
  const [angleBound, setAngleBound] = usePersistentState<number>('angleBound', 20)
  const [spannerType, setSpannerType] = usePersistentState<SpannerType>('spannerType', 'theta')
  const [spannerCones, setSpannerCones] = usePersistentState<number>('spannerCones', 8)
  const [spannerT, setSpannerT] = usePersistentState<number>('spannerT', 2)
  const [spannerS, setSpannerS] = usePersistentState<number>('spannerS', 6)
  const [schemeId, setSchemeId] = usePersistentState<string>('scheme', 'aurora')
  const [cellAlpha, setCellAlpha] = usePersistentState<number>('alpha', 0.92)
  const [dist, setDist] = usePersistentState<Distribution>('dist', 'poisson')
  const [count, setCount] = usePersistentState<number>('count', 240)
  const [seed, setSeed] = useState(1)

  const [hover, setHover] = useState(-1)
  const [selected, setSelected] = useState(-1)
  const [animating, setAnimating] = useState(false)
  const [relaxStats, setRelaxStats] = useState({ iterations: 0, movement: 0 })
  const [alphaSweeping, setAlphaSweeping] = useState(false)
  // The refined mesh is bound to the exact point array it was built from; since
  // every site edit produces a new array, reference equality detects staleness.
  const [refineState, setRefineState] = useState<{ res: RefineResult; for: Point[] } | null>(null)
  const [refining, setRefining] = useState(false)
  const refineResult = refineState && refineState.for === points ? refineState.res : null
  // Constraint segments (index pairs) for the constrained Delaunay triangulation.
  const [constraints, setConstraints] = useState<Edge[]>([])
  const [constraintMode, setConstraintMode] = useState(false)
  const [anchor, setAnchor] = useState(-1) // first endpoint picked while adding a constraint

  // Per-site weights for the power (Laguerre) diagram, stored as *unit* values in
  // [0,1]; the effective power weight is unit × spread, so the spread slider
  // rescales every site live without re-randomizing.
  const [weights, setWeights] = useState<number[]>([])
  const [weightSpread, setWeightSpread] = usePersistentState<number>('weightSpread', 0.02)
  const [weightSeed, setWeightSeed] = useState(1)
  const [powerAnimating, setPowerAnimating] = useState(false)

  const [importText, setImportText] = useState('')
  const [flash, setFlash] = useState('')

  const dragRef = useRef(-1)
  const pointsRef = useRef(points)
  useEffect(() => {
    pointsRef.current = points
  }, [points])

  const scheme = getScheme(schemeId)
  const needProximity = layers.rng || layers.nng || layers.urquhart
  const geometry = useMemo(
    () =>
      computeGeometry(points, CLIP, {
        gabriel: layers.gabriel,
        proximity: needProximity,
        layers: layers.convexLayers,
        beta: layers.beta,
        betaValue: betaVal,
        knn: layers.knn,
        k: kVal,
      }),
    [points, layers.gabriel, needProximity, layers.convexLayers, layers.beta, betaVal, layers.knn, kVal],
  )

  // Constrained Delaunay: recomputed only when its layer is on and constraints exist.
  const cdtResult = useMemo(() => {
    if (!layers.cdt || constraints.length === 0 || points.length < 3) return null
    const valid = constraints.filter((c) => c.a < points.length && c.b < points.length && c.a !== c.b)
    return constrainedDelaunay(points, valid)
  }, [layers.cdt, constraints, points])

  // Alpha shape is parameterized by the slider, so it recomputes independently of
  // the main geometry pass (which is keyed on the point set + heavy-layer flags).
  const alphaRadii = useMemo(
    () => (layers.alpha ? circumRadii(points, geometry.triangles) : []),
    [layers.alpha, points, geometry.triangles],
  )
  const alphaValue = useMemo(() => alphaForSlider(alphaRadii, alphaT), [alphaRadii, alphaT])
  const alphaResult = useMemo(
    () => (layers.alpha ? alphaShape(points, geometry.triangles, alphaValue) : null),
    [layers.alpha, points, geometry.triangles, alphaValue],
  )

  // Weighted sites (effective weight = unit × spread) and the power diagram.
  // Weights are read with a `?? 0` fallback, so the array need not be kept exactly
  // in step with the point count — new sites simply default to weight 0.
  const weightedSites = useMemo<WeightedSite[]>(
    () => points.map((p, i) => ({ x: p.x, y: p.y, w: (weights[i] ?? 0) * weightSpread })),
    [points, weights, weightSpread],
  )
  const needPower = layers.power || layers.regular || layers.radical
  const powerData = useMemo(() => {
    if (!needPower || points.length === 0) return null
    const cells = powerCells(weightedSites, CLIP)
    const radical = layers.radical
      ? (weightedSites.map(radicalCircle).filter(Boolean) as Circle[])
      : []
    return {
      cells,
      regular: layers.regular ? regularTriangulationEdges(weightedSites, cells) : [],
      radical,
      hidden: hiddenSites(cells),
    }
  }, [needPower, weightedSites, layers.regular, layers.radical, points.length])

  // Geometric spanner over the sites (Yao / Θ / greedy) with its realized dilation.
  const spannerData = useMemo(() => {
    if (!layers.spanner || points.length < 2) return null
    let edges: Edge[]
    let capped = false
    if (spannerType === 'greedy') {
      if (points.length > GREEDY_CAP) {
        capped = true
        edges = []
      } else edges = greedySpanner(points, spannerT)
    } else if (spannerType === 'yao') edges = yaoGraph(points, spannerCones)
    else if (spannerType === 'wspd') edges = wspdSpanner(points, spannerS)
    else edges = thetaGraph(points, spannerCones)
    const dil: Dilation | null = edges.length ? dilation(points, edges) : null
    return { edges, dilation: dil, capped }
  }, [layers.spanner, points, spannerType, spannerCones, spannerT, spannerS])

  // Farthest-point Voronoi diagram (the inside-out twin), with the MEC link.
  const farthestData = useMemo(() => {
    if (!layers.farthest || points.length < 3) return null
    const cells = farthestCells(points, CLIP)
    return { edges: farthestEdges(cells), owners: farthestOwners(cells), mec: geometry.mec }
  }, [layers.farthest, points, geometry.mec])

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
        rng: geometry.rng,
        nng: geometry.nng,
        urquhart: geometry.urquhart,
        beta: geometry.beta,
        knn: geometry.knn,
        spanner: spannerData ? spannerData.edges : [],
        layers: geometry.layers,
        alpha: alphaResult,
        refine:
          layers.refine && refineResult
            ? {
                points: refineResult.points,
                triangles: refineResult.triangles,
                steinerStart: refineResult.steinerStart,
              }
            : null,
        cdt: layers.cdt && cdtResult ? { triangles: cdtResult.triangles, edges: cdtResult.edges } : null,
        power: needPower ? powerData : null,
        farthest: layers.farthest ? farthestData : null,
        closest: geometry.closest,
        diameter: geometry.diameter,
        width: geometry.width,
        mec: geometry.mec,
        lec: geometry.lec,
        hover,
        selected,
      },
      { width: size.width, height: size.height, dpr: size.dpr, pad: PAD, scheme, layers, measure, cellAlpha },
    )
  }, [ref, size, points, geometry, alphaResult, refineResult, cdtResult, powerData, farthestData, spannerData, needPower, hover, selected, scheme, layers, measure, cellAlpha])

  // ── Alpha-shape sweep: grow the eraser radius 0→1 so holes visibly close ────
  useEffect(() => {
    if (!alphaSweeping) return
    let raf = 0
    const tick = () => {
      let done = false
      setAlphaT((t) => {
        const next = t + 0.012
        if (next >= 1) {
          done = true
          return 1
        }
        return next
      })
      if (done) {
        setAlphaSweeping(false)
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [alphaSweeping, setAlphaT])

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

  // ── Power-Lloyd relaxation: settle sites to their power-cell centroids ──────
  const weightsRef = useRef(weights)
  useEffect(() => {
    weightsRef.current = weights
  }, [weights])
  useEffect(() => {
    if (!powerAnimating) return
    let raf = 0
    const tick = () => {
      const sites: WeightedSite[] = pointsRef.current.map((p, i) => ({
        x: p.x,
        y: p.y,
        w: (weightsRef.current[i] ?? 0) * weightSpread,
      }))
      const { sites: next, movement } = powerLloydStep(sites, CLIP)
      setPoints(next.map((s) => ({ x: s.x, y: s.y })))
      if (movement < 1e-4) {
        setPowerAnimating(false)
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [powerAnimating, weightSpread])

  // Transient confirmation message for copy actions.
  useEffect(() => {
    if (!flash) return
    const id = window.setTimeout(() => setFlash(''), 1600)
    return () => window.clearTimeout(id)
  }, [flash])

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
    // Constraint mode: click two existing points to pin a constraint segment.
    if (constraintMode && !(e.shiftKey || e.altKey || e.button === 2)) {
      if (hit < 0) {
        setAnchor(-1)
        setSelected(-1)
        return
      }
      if (anchor < 0) {
        setAnchor(hit)
        setSelected(hit)
      } else if (hit !== anchor) {
        const a = Math.min(anchor, hit)
        const b = Math.max(anchor, hit)
        setConstraints((prev) =>
          prev.some((c) => c.a === a && c.b === b) ? prev : [...prev, { a, b }],
        )
        setLayers((pl) => ({ ...pl, cdt: true }))
        setAnchor(-1)
        setSelected(-1)
      }
      return
    }
    if (e.shiftKey || e.altKey || e.button === 2) {
      if (hit >= 0) {
        // Removing a point shifts indices, so any constraints are dropped.
        setPoints((prev) => prev.filter((_, i) => i !== hit))
        setSelected(-1)
        setConstraints([])
        setAnchor(-1)
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
  const clearConstraints = () => {
    setConstraints([])
    setAnchor(-1)
  }
  const regenerate = (nextSeed = seed) => {
    setAnimating(false)
    setPowerAnimating(false)
    setWeights([])
    setRelaxStats({ iterations: 0, movement: 0 })
    setSelected(-1)
    clearConstraints()
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
    setPowerAnimating(false)
    setWeights([])
    setPoints([])
    setSelected(-1)
    clearConstraints()
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

  const copy = (text: string, label: string) => {
    try {
      navigator.clipboard?.writeText(text)
      setFlash(label)
    } catch {
      setFlash('copy blocked')
    }
  }
  const copyCoords = () => copy(pointsToText(points), 'Coordinates copied')
  const copyLink = () => copy(buildShareUrl(points), 'Share link copied')
  const applyImport = () => {
    const parsed = parsePointsText(importText)
    if (parsed.length === 0) {
      setFlash('No coordinates found')
      return
    }
    setAnimating(false)
    setPowerAnimating(false)
    setWeights([])
    setSelected(-1)
    clearConstraints()
    setRelaxStats({ iterations: 0, movement: 0 })
    setPoints(parsed)
    setFlash(`Imported ${parsed.length} points`)
  }

  const runRefine = () => {
    if (points.length < 3) return
    setRefining(true)
    // Defer so the "Refining…" label paints before the (synchronous) solve runs.
    window.setTimeout(() => {
      const res = refineDelaunay(points, { minAngleDeg: angleBound, maxSteiner: 1500 })
      setRefineState({ res, for: points })
      setLayers((p) => ({ ...p, refine: true }))
      setRefining(false)
      setFlash(
        res.hitCap
          ? `Refined to ${res.minAngleAfter.toFixed(1)}° (budget reached)`
          : `Refined: ${res.minAngleBefore.toFixed(1)}° → ${res.minAngleAfter.toFixed(1)}°`,
      )
    }, 16)
  }

  const setLayer = (key: keyof LayerToggles, v: boolean) => setLayers((p) => ({ ...p, [key]: v }))
  const setMeas = (key: keyof MeasureToggles, v: boolean) => setMeasure((p) => ({ ...p, [key]: v }))

  // ── Weight actions (power diagram) ─────────────────────────────────────────
  const randomizeWeights = () => {
    const next = weightSeed + 1
    setWeightSeed(next)
    const rng = mulberry32(next)
    setWeights(points.map(() => rng()))
    setLayers((p) => ({ ...p, power: true }))
  }
  const resetWeights = () => setWeights(points.map(() => 0))
  const setSiteWeight = (i: number, v: number) =>
    setWeights((w) => {
      const next = w.slice()
      while (next.length < points.length) next.push(0)
      next[i] = v
      return next
    })

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
        {flash && <div className="stage__flash">{flash}</div>}
        <p className="stage__hint">
          {constraintMode
            ? anchor < 0
              ? 'Constraint mode: click the first endpoint of a segment to pin'
              : 'Now click the second endpoint to pin the constraint edge'
            : 'Click empty space to add a point · drag to move · shift/right-click to delete'}
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
              label="Convex layers"
              swatch="rgba(150,190,255,0.7)"
              checked={layers.convexLayers}
              onChange={(v) => setLayer('convexLayers', v)}
            />
            <Toggle
              label="Alpha shape"
              swatch="rgba(124,246,192,0.95)"
              checked={layers.alpha}
              onChange={(v) => setLayer('alpha', v)}
            />
            <Toggle
              label="Gabriel graph"
              swatch="rgba(120,255,214,0.9)"
              checked={layers.gabriel}
              onChange={(v) => setLayer('gabriel', v)}
            />
            <Toggle
              label="Relative-neighborhood"
              swatch="rgba(244,114,182,0.9)"
              checked={layers.rng}
              onChange={(v) => setLayer('rng', v)}
            />
            <Toggle
              label="Nearest-neighbor"
              swatch="rgba(96,205,255,0.95)"
              checked={layers.nng}
              onChange={(v) => setLayer('nng', v)}
            />
            <Toggle
              label="Urquhart graph"
              swatch="rgba(190,242,100,0.9)"
              checked={layers.urquhart}
              onChange={(v) => setLayer('urquhart', v)}
            />
            <Toggle
              label="β-skeleton"
              swatch="rgba(251,146,140,0.95)"
              checked={layers.beta}
              onChange={(v) => setLayer('beta', v)}
            />
            <Toggle
              label="k-nearest graph"
              swatch="rgba(167,139,250,0.95)"
              checked={layers.knn}
              onChange={(v) => setLayer('knn', v)}
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
          {layers.beta && (
            <Slider
              label="β  (1 = Gabriel · 2 = RNG)"
              value={betaVal}
              min={1}
              max={3}
              step={0.05}
              onChange={(v) => setBetaVal(v)}
              format={(v) => v.toFixed(2)}
            />
          )}
          {layers.knn && (
            <Slider
              label="k  (neighbours per site)"
              value={kVal}
              min={1}
              max={12}
              step={1}
              onChange={(v) => setKVal(v)}
            />
          )}
          {layers.alpha && (
            <>
              <Slider
                label="Alpha (eraser radius)"
                value={alphaT}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => setAlphaT(v)}
                format={(v) => `${Math.round(v * 100)}%`}
              />
              <Button onClick={() => { setAlphaT(0); setAlphaSweeping(true) }} disabled={alphaSweeping}>
                {alphaSweeping ? 'Sweeping…' : 'Sweep α'}
              </Button>
            </>
          )}
        </Panel>

        <Panel title="Measure" hint="single shapes">
          <div className="layers">
            <Toggle
              label="Closest pair"
              swatch="rgba(182,255,107,0.95)"
              checked={measure.closest}
              onChange={(v) => setMeas('closest', v)}
            />
            <Toggle
              label="Diameter (farthest pair)"
              swatch="rgba(255,209,102,0.95)"
              checked={measure.diameter}
              onChange={(v) => setMeas('diameter', v)}
            />
            <Toggle
              label="Minimum width"
              swatch="rgba(150,215,255,0.95)"
              checked={measure.width}
              onChange={(v) => setMeas('width', v)}
            />
            <Toggle
              label="Min. enclosing circle"
              swatch="rgba(124,246,192,0.95)"
              checked={measure.mec}
              onChange={(v) => setMeas('mec', v)}
            />
            <Toggle
              label="Largest empty circle"
              swatch="rgba(255,180,90,0.95)"
              checked={measure.lec}
              onChange={(v) => setMeas('lec', v)}
            />
          </div>
          <div className="metrics">
            <Stat label="closest" value={geometry.closest ? fmt(geometry.closest.dist) : '—'} />
            <Stat label="diameter" value={geometry.diameter ? fmt(geometry.diameter.dist) : '—'} />
            <Stat label="min width" value={geometry.width ? fmt(geometry.width.width) : '—'} />
            <Stat label="MEC r" value={geometry.mec ? fmt(geometry.mec.r) : '—'} />
            <Stat label="LEC r" value={geometry.lec ? fmt(geometry.lec.circle.r) : '—'} />
            <Stat label="hull area" value={geometry.hullArea.toFixed(3)} />
          </div>
        </Panel>

        <Panel title="Mesh" hint="Ruppert">
          <p className="muted">
            Quality meshing by Delaunay refinement: split encroached boundary edges and insert
            circumcenters of skinny triangles until every angle clears the bound. Inserted
            (Steiner) points show as amber dots.
          </p>
          <Slider
            label="Min. angle bound"
            value={angleBound}
            min={5}
            max={28}
            step={1}
            onChange={(v) => setAngleBound(v)}
            format={(v) => `${v}°`}
          />
          <div className="row">
            <Button variant="primary" onClick={runRefine} disabled={points.length < 3 || refining}>
              {refining ? 'Refining…' : 'Refine mesh'}
            </Button>
            <Toggle label="Show" checked={layers.refine} onChange={(v) => setLayer('refine', v)} />
          </div>
          {refineResult && (
            <div className="metrics">
              <Stat label="min angle" value={`${refineResult.minAngleBefore.toFixed(1)}°→${refineResult.minAngleAfter.toFixed(1)}°`} />
              <Stat label="Steiner" value={refineResult.points.length - refineResult.steinerStart} />
              <Stat label="triangles" value={refineResult.triangles.length} />
            </div>
          )}
        </Panel>

        <Panel title="Constraints" hint="CDT">
          <p className="muted">
            Constrained Delaunay: force chosen segments to be edges (via Lawson edge-flips), then
            restore Delaunay everywhere else. Pinned edges show in magenta.
          </p>
          <div className="row">
            <Button
              variant={constraintMode ? 'primary' : 'default'}
              onClick={() => { setConstraintMode((m) => !m); setAnchor(-1) }}
              disabled={points.length < 3}
            >
              {constraintMode ? 'Picking…' : 'Add constraint'}
            </Button>
            <Toggle label="Show CDT" checked={layers.cdt} onChange={(v) => setLayer('cdt', v)} />
          </div>
          <div className="row">
            <Button variant="ghost" onClick={clearConstraints} disabled={constraints.length === 0}>
              Clear constraints
            </Button>
          </div>
          <div className="metrics">
            <Stat label="constraints" value={constraints.length} />
            <Stat label="enforced" value={cdtResult ? `${cdtResult.inserted}/${cdtResult.requested}` : '—'} />
            <Stat label="triangles" value={cdtResult ? cdtResult.triangles.length : '—'} />
          </div>
        </Panel>

        <Panel title="Weighted" hint="power / Laguerre">
          <p className="muted">
            Give each site a weight and Voronoi becomes a <strong>power (Laguerre) diagram</strong>:
            cells split by radical axes, heavy sites swelling, outweighed ones vanishing (drawn as
            hollow rings). The dual is the regular (weighted Delaunay) triangulation.
          </p>
          <div className="layers">
            <Toggle label="Power cells" checked={layers.power} onChange={(v) => setLayer('power', v)} />
            <Toggle
              label="Regular triangulation"
              swatch="rgba(255,170,90,0.9)"
              checked={layers.regular}
              onChange={(v) => setLayer('regular', v)}
            />
            <Toggle
              label="Radical circles (√w)"
              swatch="rgba(255,180,90,0.6)"
              checked={layers.radical}
              onChange={(v) => setLayer('radical', v)}
            />
          </div>
          <Slider
            label="Weight spread"
            value={weightSpread}
            min={0}
            max={0.08}
            step={0.002}
            onChange={(v) => setWeightSpread(v)}
            format={(v) => v.toFixed(3)}
          />
          <div className="row">
            <Button variant="primary" onClick={randomizeWeights} disabled={points.length === 0}>
              Randomize weights
            </Button>
            <Button variant="ghost" onClick={resetWeights} disabled={points.length === 0}>
              Reset
            </Button>
          </div>
          {selected >= 0 && selected < points.length && (
            <Slider
              label={`Weight · site #${selected}`}
              value={weights[selected] ?? 0}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => setSiteWeight(selected, v)}
              format={(v) => `${Math.round(v * 100)}%`}
            />
          )}
          <div className="row">
            <Button
              variant={powerAnimating ? 'primary' : 'default'}
              onClick={() => setPowerAnimating((a) => !a)}
              disabled={points.length < 2}
            >
              {powerAnimating ? 'Stop' : 'Power-Lloyd'}
            </Button>
          </div>
          <div className="metrics">
            <Stat label="hidden sites" value={powerData ? powerData.hidden.length : '—'} />
            <Stat label="regular edges" value={powerData ? powerData.regular.length : '—'} />
          </div>
        </Panel>

        <Panel title="Farthest-point" hint="Voronoi twin">
          <p className="muted">
            The farthest-point Voronoi diagram — each region keyed to its <em>farthest</em> site.
            Only convex-hull vertices own a cell, the diagram is a tree, and the smallest-enclosing
            circle's centre sits on it (shown dashed).
          </p>
          <Toggle
            label="Show diagram"
            swatch="rgba(96,205,255,0.95)"
            checked={layers.farthest}
            onChange={(v) => setLayer('farthest', v)}
          />
          <div className="metrics">
            <Stat label="cells (= hull)" value={farthestData ? farthestData.owners.length : '—'} />
            <Stat label="MEC r" value={geometry.mec ? fmt(geometry.mec.r) : '—'} />
          </div>
        </Panel>

        <Panel title="Spanners" hint="t-spanners">
          <p className="muted">
            Sparse graphs that still approximate every distance. A <strong>t-spanner</strong> keeps each
            pair's shortest path within t× the straight line; the realized <em>dilation</em> is measured
            by all-pairs shortest path. Θ and Yao split directions into cones; greedy adds edges
            shortest-first only where the graph can't already get within t; <strong>WSPD</strong> draws
            one edge per well-separated pair for a linear-size t-spanner.
          </p>
          <Toggle
            label="Show spanner"
            swatch="rgba(255,176,32,0.9)"
            checked={layers.spanner}
            onChange={(v) => setLayer('spanner', v)}
          />
          <Segmented<SpannerType>
            options={[
              { id: 'theta', label: 'Θ-graph' },
              { id: 'yao', label: 'Yao' },
              { id: 'greedy', label: 'Greedy' },
              { id: 'wspd', label: 'WSPD' },
            ]}
            value={spannerType}
            onChange={setSpannerType}
          />
          {spannerType === 'greedy' ? (
            <Slider
              label="t  (target stretch)"
              value={spannerT}
              min={1.1}
              max={4}
              step={0.1}
              onChange={(v) => setSpannerT(v)}
              format={(v) => `${v.toFixed(1)}×`}
            />
          ) : spannerType === 'wspd' ? (
            <Slider
              label="s  (separation)"
              value={spannerS}
              min={4.5}
              max={12}
              step={0.5}
              onChange={(v) => setSpannerS(v)}
              format={(v) => v.toFixed(1)}
            />
          ) : (
            <Slider label="cones (k)" value={spannerCones} min={4} max={16} step={1} onChange={(v) => setSpannerCones(v)} />
          )}
          <div className="metrics">
            <Stat label="edges" value={spannerData ? spannerData.edges.length : '—'} />
            <Stat label="dilation" value={spannerData?.dilation ? spannerData.dilation.stretch.toFixed(3) : '—'} />
            <Stat
              label={spannerType === 'theta' ? 'Θ bound' : spannerType === 'wspd' ? 't bound' : 'connected'}
              value={
                spannerType === 'theta'
                  ? thetaBound(spannerCones).toFixed(2)
                  : spannerType === 'wspd'
                    ? wspdSpannerBound(spannerS).toFixed(2)
                    : spannerData?.dilation
                      ? spannerData.dilation.connected
                        ? 'yes'
                        : 'no'
                      : '—'
              }
            />
          </div>
          {spannerData?.capped && (
            <p className="muted">Greedy is limited to ≤{GREEDY_CAP} points (it's O(n³)); lower the count to build it.</p>
          )}
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

        <Panel title="Share & import">
          <p className="muted">
            Copy a link that reconstructs this exact point set, export the coordinates, or paste your
            own (any delimiters — out-of-range values are fit into the frame).
          </p>
          <div className="row">
            <Button variant="primary" onClick={copyLink} disabled={points.length === 0}>
              Copy link
            </Button>
            <Button onClick={copyCoords} disabled={points.length === 0}>
              Copy coords
            </Button>
          </div>
          <TextArea
            value={importText}
            onChange={setImportText}
            rows={4}
            placeholder={'Paste coordinates, e.g.\n0.2, 0.3\n0.8 0.6\n120 340 …'}
          />
          <Button onClick={applyImport} disabled={importText.trim().length === 0}>
            Import points
          </Button>
        </Panel>

        <Panel title="Metrics">
          <div className="metrics">
            <Stat label="MST length" value={fmt(geometry.mstLength)} />
            <Stat label="hull perim." value={fmt(geometry.hullPerimeter)} />
            <Stat label="Delaunay" value={`${geometry.timings.delaunay.toFixed(1)}ms`} />
            <Stat label="Voronoi" value={`${geometry.timings.voronoi.toFixed(1)}ms`} />
            <Stat label="edges" value={geometry.delaunayEdges.length} />
          </div>
        </Panel>
      </aside>
    </div>
  )
}
