import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { Sketch } from './model/sketch'
import type { Constraint, EntityId, SketchData } from './model/types'
import { EXAMPLES, exampleById } from './model/examples'
import type { DriverSpec } from './model/examples'
import { applicableConstraints, findDuplicate } from './model/constraintRules'
import type { ConstraintOption, ValueKind } from './model/constraintRules'
import { autoConstrain } from './model/autoConstrain'
import { toJSONString, fromJSONString, encodeHash, decodeHash } from './model/persist'
import { sketchToSVG, sketchToDXF, motionProfileToCSV } from './model/export'
import { solve } from './solver/solver'
import type { SolveResult } from './solver/solver'
import { analyzeDof } from './solver/dof'
import { analyzeConflicts } from './solver/conflicts'
import { runSelfTests } from './solver/selftest'
import type { TestResult } from './solver/selftest'
import { computeKinematics, computeMotionProfile } from './solver/kinematics'
import { stepDynamics, evalDynamics, lumpedMasses, driverParamUnit, DEFAULT_DYN } from './solver/dynamics'
import type { DynState, DynParams } from './solver/dynamics'
import { render } from './render/renderer'
import type { RenderState, TracePath, MotionOverlay } from './render/renderer'
import type { MotionData, DynView, DynSample } from './ui/components'
import { pickEntity } from './render/picking'
import { frameBounds, screenToWorld, worldToScreen, clamp } from './render/view'
import type { View } from './render/view'
import { Toolbar, ConstraintPalette, InfoPanel, DriverBar, ValuePrompt, Diagnostics } from './ui/components'

type ToolId = 'select' | 'point' | 'line' | 'circle' | 'arc' | 'spline'

const TRACE_COLORS = ['#57e6c9', '#ffd166', '#c792ea']

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // --- mutable engine state (read inside the animation loop / pointer handlers)
  const sketchRef = useRef<Sketch>(new Sketch())
  const viewRef = useRef<View>({ ox: 400, oy: 300, scale: 2 })
  const sizeRef = useRef({ w: 800, h: 600 })
  const selectionRef = useRef<EntityId[]>([])
  const hoverRef = useRef<EntityId | null>(null)
  const toolRef = useRef<ToolId>('select')
  const playingRef = useRef(false)
  const showTraceRef = useRef(true)
  const showVelocityRef = useRef(false)
  const showAccelRef = useRef(false)
  const showConstraintsRef = useRef(true)
  const showGridRef = useRef(true)
  const cursorWorldRef = useRef<[number, number]>([0, 0])
  const driverRef = useRef<{ spec: DriverSpec; constraint: Constraint } | null>(null)
  const driverValueRef = useRef(0)
  const driverDirRef = useRef(1) // sweep direction for ping-pong (non-wrapping) drivers
  // --- dynamics (time-domain physics) ------------------------------------
  const dynOnRef = useRef(false)
  const dynStateRef = useRef<DynState>({ theta: 0, omega: 0 })
  const dynParamsRef = useRef<DynParams>({ ...DEFAULT_DYN })
  const dynMassRef = useRef<Map<EntityId, number> | null>(null)
  const dynUnitRef = useRef<'rad' | 'len'>('rad')
  const dynEnergyHistRef = useRef<DynSample[]>([])
  const tracesRef = useRef<Map<EntityId, [number, number][]>>(new Map())
  const traceTargetsRef = useRef<EntityId[]>([])
  const redundantRef = useRef<Set<EntityId>>(new Set())
  const highlightRef = useRef<Set<EntityId>>(new Set())
  const lastTsRef = useRef(0)
  const dragRef = useRef<{ mode: 'none' | 'point' | 'pan'; id?: EntityId; lastX: number; lastY: number; pushed?: boolean }>({
    mode: 'none',
    lastX: 0,
    lastY: 0,
  })
  const pendingToolRef = useRef<{ startPoint: EntityId } | null>(null)
  // Arc construction is a three-click gesture: center → start (sets radius) → end.
  const pendingArcRef = useRef<{ center: EntityId; start?: EntityId } | null>(null)
  // Spline construction is a four-click gesture, one per control point:
  // start → control-1 → control-2 → end.
  const pendingSplineRef = useRef<{ pts: EntityId[] } | null>(null)
  const historyRef = useRef<{ past: SketchData[]; future: SketchData[] }>({ past: [], future: [] })
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // --- React UI state ------------------------------------------------------
  const [tool, setTool] = useState<ToolId>('select')
  const [selection, setSelection] = useState<EntityId[]>([])
  const [rev, setRev] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [exampleId, setExampleId] = useState('four-bar')
  const [showConstraints, setShowConstraints] = useState(true)
  const [showGrid, setShowGrid] = useState(true)
  const [showTrace, setShowTrace] = useState(true)
  const [showVelocity, setShowVelocity] = useState(false)
  const [showAccel, setShowAccel] = useState(false)
  const [driverValue, setDriverValue] = useState(0)
  const [driver, setDriver] = useState<DriverSpec | null>(null)
  const [dynOn, setDynOn] = useState(false)
  const [dynParams, setDynParams] = useState<DynParams>({ ...DEFAULT_DYN })
  const [dynReadout, setDynReadout] = useState<{ T: number; V: number; E: number; I: number; omega: number; history: DynSample[] } | null>(null)
  const [valuePrompt, setValuePrompt] = useState<ConstraintOption | null>(null)
  const [editDim, setEditDim] = useState<{ constraintId: EntityId; option: ConstraintOption } | null>(null)
  const [solveInfo, setSolveInfo] = useState<SolveResult | null>(null)
  const [tests, setTests] = useState<TestResult[]>(() => runSelfTests())
  const [showTests, setShowTests] = useState(false)
  const [message, setMessage] = useState('')
  const [history, setHistory] = useState({ canUndo: false, canRedo: false })

  const bump = useCallback(() => setRev((r) => r + 1), [])

  // keep refs in sync with state
  useEffect(() => void (toolRef.current = tool), [tool])
  useEffect(() => void (selectionRef.current = selection), [selection])
  useEffect(() => void (playingRef.current = playing), [playing])
  useEffect(() => void (showTraceRef.current = showTrace), [showTrace])
  useEffect(() => void (showVelocityRef.current = showVelocity), [showVelocity])
  useEffect(() => void (showAccelRef.current = showAccel), [showAccel])
  useEffect(() => void (showConstraintsRef.current = showConstraints), [showConstraints])
  useEffect(() => void (showGridRef.current = showGrid), [showGrid])
  useEffect(() => void (dynOnRef.current = dynOn), [dynOn])

  // Loading a new sketch (or switching examples) leaves any running physics behind
  // so the freshly-loaded mechanism starts at rest. Called from the load paths.
  const stopDynamics = useCallback(() => {
    dynOnRef.current = false
    setDynOn(false)
    dynEnergyHistRef.current = []
    setDynReadout(null)
  }, [])

  // --- dynamics controls ---------------------------------------------------
  // Release the driver: seed the dynamical state from the current configuration
  // (at rest) and let the animation loop integrate the equation of motion.
  const enterDynamics = useCallback(() => {
    const drv = driverRef.current
    if (!drv) return
    const unit = driverParamUnit(sketchRef.current, drv.constraint.id)
    if (!unit) {
      setMessage('Dynamics needs an angle or distance driver.')
      return
    }
    dynUnitRef.current = unit
    dynMassRef.current = lumpedMasses(sketchRef.current, dynParamsRef.current)
    const theta = unit === 'rad' ? (driverValueRef.current * Math.PI) / 180 : driverValueRef.current
    dynStateRef.current = { theta, omega: 0 }
    dynEnergyHistRef.current = []
    const ev = evalDynamics(sketchRef.current, drv.constraint.id, dynMassRef.current, dynStateRef.current, dynParamsRef.current, unit, (s) => void solve(s, { maxIterations: 160 }))
    setDynReadout({ T: ev.T, V: ev.V, E: ev.E, I: ev.I, omega: 0, history: [] })
    dynOnRef.current = true
    setDynOn(true)
    setPlaying(true)
    setMessage('Released — the mechanism now runs under gravity. Tune gravity / mass / damping / torque live.')
  }, [])

  const exitDynamics = useCallback(() => {
    dynOnRef.current = false
    setDynOn(false)
    setPlaying(false)
    setMessage('Physics paused — the mechanism is held at its current pose.')
  }, [])

  const toggleDynamics = useCallback(() => {
    if (dynOnRef.current) exitDynamics()
    else enterDynamics()
  }, [enterDynamics, exitDynamics])

  // Bring the mechanism to rest at its current pose (zero θ̇) and clear the trace.
  const resetDynamics = useCallback(() => {
    dynStateRef.current = { theta: dynStateRef.current.theta, omega: 0 }
    dynEnergyHistRef.current = []
    setDynReadout((prev) => (prev ? { ...prev, T: 0, omega: 0, E: prev.V, history: [] } : prev))
  }, [])

  const updateDynParams = useCallback((patch: Partial<DynParams>) => {
    const next = { ...dynParamsRef.current, ...patch }
    dynParamsRef.current = next
    setDynParams(next)
    // Mass depends only on the density / base-mass sliders; recompute when they move.
    if (dynOnRef.current && (patch.density !== undefined || patch.baseMass !== undefined)) {
      dynMassRef.current = lumpedMasses(sketchRef.current, next)
    }
  }, [])

  // --- solving -------------------------------------------------------------
  const solveNow = useCallback((extraFixed?: Set<EntityId>) => {
    const res = solve(sketchRef.current, { extraFixed })
    setSolveInfo(res)
    return res
  }, [])

  // --- undo / redo ---------------------------------------------------------
  const MAX_HISTORY = 120
  const syncHistory = useCallback(() => {
    const h = historyRef.current
    setHistory({ canUndo: h.past.length > 0, canRedo: h.future.length > 0 })
  }, [])

  // Snapshot the current model *before* a mutation. Call at the top of every
  // structural edit; live drags and driver animation are intentionally excluded.
  const pushHistory = useCallback(() => {
    const h = historyRef.current
    h.past.push(sketchRef.current.toData())
    if (h.past.length > MAX_HISTORY) h.past.shift()
    h.future = []
    syncHistory()
  }, [syncHistory])

  const resetHistory = useCallback(() => {
    historyRef.current = { past: [], future: [] }
    syncHistory()
  }, [syncHistory])

  // Replace the live model with a saved snapshot, re-resolving the driver's
  // constraint reference (ids are stable across serialisation) so a driven
  // mechanism keeps working after an undo.
  const restoreData = useCallback(
    (data: SketchData) => {
      sketchRef.current = new Sketch(data)
      const d = driverRef.current
      if (d) {
        const c = sketchRef.current.constraints.find((k) => k.id === d.spec.constraintId)
        if (c) driverRef.current = { spec: d.spec, constraint: c }
        else {
          driverRef.current = null
          setDriver(null)
        }
      }
      tracesRef.current = new Map()
      selectionRef.current = []
      setSelection([])
      pendingToolRef.current = null
      pendingArcRef.current = null
      pendingSplineRef.current = null
      solveNow()
      bump()
    },
    [bump, solveNow],
  )

  const undo = useCallback(() => {
    const h = historyRef.current
    if (!h.past.length) return
    h.future.push(sketchRef.current.toData())
    restoreData(h.past.pop()!)
    syncHistory()
    setMessage('Undo.')
  }, [restoreData, syncHistory])

  const redo = useCallback(() => {
    const h = historyRef.current
    if (!h.future.length) return
    h.past.push(sketchRef.current.toData())
    restoreData(h.future.pop()!)
    syncHistory()
    setMessage('Redo.')
  }, [restoreData, syncHistory])

  // --- example loading -----------------------------------------------------
  const loadExample = useCallback(
    (id: string) => {
      const built = exampleById(id).build()
      sketchRef.current = built.sketch
      selectionRef.current = []
      setSelection([])
      pendingToolRef.current = null
      pendingArcRef.current = null
      pendingSplineRef.current = null
      tracesRef.current = new Map()
      traceTargetsRef.current = built.tracePoints ?? []
      driverDirRef.current = 1
      if (built.driver) {
        const c = built.sketch.constraints.find((k) => k.id === built.driver!.constraintId)!
        driverRef.current = { spec: built.driver, constraint: c }
        driverValueRef.current = built.driver.min
        c.value = built.driver.min
        setDriverValue(built.driver.min)
        setDriver(built.driver)
      } else {
        driverRef.current = null
        setDriver(null)
      }
      setPlaying(false)
      playingRef.current = false
      stopDynamics()
      solve(built.sketch, {})
      const { w, h } = sizeRef.current
      viewRef.current = frameBounds(built.sketch.boundingBox(), w, h)
      setExampleId(id)
      setMessage(`Loaded “${exampleById(id).name}”.`)
      resetHistory()
      bump()
    },
    [bump, resetHistory, stopDynamics],
  )

  // --- persistence: new / open / save / share -----------------------------
  // Adopt a raw sketch (from a file, a shared URL, or "New"). Any constraint
  // flagged as a driver is turned back into a scrubbable driver with a default
  // full-rotation range, so shared mechanisms stay animatable.
  const adoptSketch = useCallback(
    (sketch: Sketch, label: string) => {
      sketchRef.current = sketch
      selectionRef.current = []
      setSelection([])
      pendingToolRef.current = null
      pendingArcRef.current = null
      pendingSplineRef.current = null
      tracesRef.current = new Map()
      traceTargetsRef.current = []
      driverDirRef.current = 1
      const drvConstraint = sketch.constraints.find((c) => c.driver)
      if (drvConstraint) {
        const spec: DriverSpec = { constraintId: drvConstraint.id, min: 0, max: 360, period: 6, wrap: true, label: 'Driver', unit: '°' }
        driverRef.current = { spec, constraint: drvConstraint }
        driverValueRef.current = drvConstraint.value ?? 0
        setDriver(spec)
        setDriverValue(drvConstraint.value ?? 0)
      } else {
        driverRef.current = null
        setDriver(null)
      }
      setPlaying(false)
      playingRef.current = false
      stopDynamics()
      solveNow()
      const { w, h } = sizeRef.current
      viewRef.current = frameBounds(sketch.boundingBox(), w, h)
      setExampleId('')
      setMessage(label)
      resetHistory()
      bump()
    },
    [bump, resetHistory, solveNow, stopDynamics],
  )

  const newSketch = useCallback(() => adoptSketch(new Sketch(), 'New blank sketch.'), [adoptSketch])

  const saveSketch = useCallback(() => {
    const json = toJSONString(sketchRef.current.toData())
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'datum-sketch.json'
    a.click()
    URL.revokeObjectURL(url)
    setMessage('Saved sketch to a .json file.')
  }, [])

  const openSketchText = useCallback(
    (text: string) => {
      const data = fromJSONString(text)
      if (!data) {
        setMessage('That file isn’t a valid Datum sketch.')
        return
      }
      adoptSketch(new Sketch(data), 'Opened sketch from file.')
    },
    [adoptSketch],
  )

  const onOpenFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = '' // allow re-opening the same file
      if (!file) return
      file.text().then(openSketchText)
    },
    [openSketchText],
  )

  const shareSketch = useCallback(() => {
    const hash = `#s=${encodeHash(sketchRef.current.toData())}`
    const url = `${window.location.origin}${window.location.pathname}${window.location.search}${hash}`
    try {
      window.history.replaceState(null, '', hash)
    } catch {
      /* ignore — sandboxed thumbnail frames may block history */
    }
    const done = () => setMessage('Shareable link copied to clipboard.')
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => setMessage('Link is in the address bar — copy it to share.'))
    else setMessage('Link is in the address bar — copy it to share.')
  }, [])

  // initial load — deferred a frame so the canvas has laid out (and so we don't
  // fire a cascade of setState synchronously inside the mount effect). A shared
  // sketch in the URL fragment (#s=…) wins over the default demo.
  useEffect(() => {
    const shared = typeof window !== 'undefined' ? decodeHash(window.location.hash) : null
    const id = requestAnimationFrame(() => {
      if (shared) adoptSketch(new Sketch(shared), 'Loaded a shared sketch from the link.')
      else loadExample('four-bar')
    })
    return () => cancelAnimationFrame(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- canvas sizing -------------------------------------------------------
  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      sizeRef.current = { w: rect.width, h: rect.height }
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { w, h } = sizeRef.current
    const traces: TracePath[] = []
    let ci = 0
    for (const targ of traceTargetsRef.current) {
      const pts = tracesRef.current.get(targ)
      if (pts && pts.length) traces.push({ pts, color: TRACE_COLORS[ci % TRACE_COLORS.length] })
      ci++
    }
    const status = analyzeDof(sketchRef.current).status
    const redundant = redundantRef.current
    const pend = pendingToolRef.current
    const t = toolRef.current
    let preview: RenderState['preview'] = null
    if (pend && (t === 'line' || t === 'circle')) {
      const start = sketchRef.current.point(pend.startPoint)
      preview = { kind: t, from: [start.x, start.y], to: cursorWorldRef.current }
    } else if (t === 'arc' && pendingArcRef.current) {
      const pa = pendingArcRef.current
      const c = sketchRef.current.point(pa.center)
      if (pa.start === undefined) {
        // Radius rubber-band before the start point is placed.
        preview = { kind: 'line', from: [c.x, c.y], to: cursorWorldRef.current }
      } else {
        const s = sketchRef.current.point(pa.start)
        preview = { kind: 'arc', center: [c.x, c.y], from: [s.x, s.y], to: cursorWorldRef.current }
      }
    } else if (t === 'spline' && pendingSplineRef.current) {
      const ctrl = pendingSplineRef.current.pts.map((id) => {
        const p = sketchRef.current.point(id)
        return [p.x, p.y] as [number, number]
      })
      preview = { kind: 'spline', ctrl, to: cursorWorldRef.current }
    }
    // Live velocity / acceleration field overlay, computed exactly from the current
    // (solved) configuration via the constraint Jacobian. Only when a driver exists
    // and at least one field is shown — otherwise the arrays stay off the render state.
    let motion: MotionOverlay | null = null
    const drv = driverRef.current
    if (drv && (showVelocityRef.current || showAccelRef.current)) {
      const k = computeKinematics(sketchRef.current, drv.constraint.id)
      if (k.ok) {
        const tracer = traceTargetsRef.current[0] ?? null
        const tp = tracer !== null ? sketchRef.current.point(tracer) : null
        motion = {
          arrows: k.points.map((p) => ({ x: p.x, y: p.y, vx: p.vx, vy: p.vy, ax: p.ax, ay: p.ay })),
          showVelocity: showVelocityRef.current,
          showAccel: showAccelRef.current,
          tracer,
          tracerPos: tp ? [tp.x, tp.y] : null,
        }
      }
    }
    const st: RenderState = {
      view: viewRef.current,
      selection: new Set(selectionRef.current),
      hover: hoverRef.current,
      pending: new Set(
        pendingToolRef.current
          ? [pendingToolRef.current.startPoint]
          : pendingArcRef.current
            ? [pendingArcRef.current.center, ...(pendingArcRef.current.start !== undefined ? [pendingArcRef.current.start] : [])]
            : pendingSplineRef.current
              ? pendingSplineRef.current.pts
              : [],
      ),
      traces,
      dofStatus: status,
      redundant,
      highlight: highlightRef.current,
      showConstraints: showConstraintsRef.current,
      showGrid: showGridRef.current,
      motion,
      preview,
    }
    render(ctx, sketchRef.current, st, w, h)
  }, [])

  // --- animation + render loop --------------------------------------------
  useEffect(() => {
    let raf = 0
    const frame = (ts: number) => {
      const dt = lastTsRef.current ? Math.min((ts - lastTsRef.current) / 1000, 0.05) : 0
      lastTsRef.current = ts

      const driver = driverRef.current
      const appendTraces = () => {
        if (!showTraceRef.current) return
        for (const id of traceTargetsRef.current) {
          const p = sketchRef.current.point(id)
          let arr = tracesRef.current.get(id)
          if (!arr) tracesRef.current.set(id, (arr = []))
          const last = arr[arr.length - 1]
          if (!last || Math.hypot(last[0] - p.x, last[1] - p.y) > 0.4) arr.push([p.x, p.y])
          if (arr.length > 4000) arr.shift()
        }
      }
      if (playingRef.current && driver && dynOnRef.current && dynMassRef.current) {
        // Time-domain physics: integrate the Eksergian equation of motion. stepDynamics
        // marches (θ, θ̇) on the LIVE sketch (each RK4 stage warm-starts from the last
        // pose), leaving it solved at the new θ — exactly what we then draw.
        const unit = dynUnitRef.current
        const stepDt = Math.min(dt, 0.033)
        const r = stepDynamics(
          sketchRef.current,
          driver.constraint.id,
          dynMassRef.current,
          dynStateRef.current,
          dynParamsRef.current,
          unit,
          stepDt,
          (s) => void solve(s, { maxIterations: 120 }),
          4,
        )
        dynStateRef.current = r.state
        const val = unit === 'rad' ? (r.state.theta * 180) / Math.PI : r.state.theta
        driverValueRef.current = val
        const disp = unit === 'rad' ? ((val % 360) + 360) % 360 : val
        const hist = dynEnergyHistRef.current
        hist.push({ T: r.ev.T, V: r.ev.V, E: r.ev.E })
        if (hist.length > 240) hist.shift()
        setDriverValue(disp)
        setDynReadout({ T: r.ev.T, V: r.ev.V, E: r.ev.E, I: r.ev.I, omega: r.state.omega, history: hist.slice() })
        appendTraces()
      } else if (playingRef.current && driver) {
        const { spec } = driver
        const speed = ((spec.max - spec.min) / spec.period) * dt
        let val = driverValueRef.current + driverDirRef.current * speed
        if (spec.wrap) {
          while (val > spec.max) val -= spec.max - spec.min
          while (val < spec.min) val += spec.max - spec.min
        } else {
          // Non-wrapping drivers ping-pong between the endpoints — the natural
          // motion for a linkage with a limited range (e.g. Peaucellier's crank).
          if (val > spec.max) {
            val = spec.max
            driverDirRef.current = -1
          } else if (val < spec.min) {
            val = spec.min
            driverDirRef.current = 1
          }
        }
        driverValueRef.current = val
        driver.constraint.value = val
        const res = solve(sketchRef.current, {})
        setDriverValue(val)
        setSolveInfo(res)
        appendTraces()
      }
      draw()
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [draw])

  // --- pointer interaction -------------------------------------------------
  const eventScreen = (e: React.PointerEvent): [number, number] => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }
  const eventWorld = (e: React.PointerEvent): [number, number] => {
    const [sx, sy] = eventScreen(e)
    return screenToWorld(viewRef.current, sx, sy)
  }
  const snap = (v: number) => Math.round(v / 5) * 5

  const pointAt = (sx: number, sy: number, wx: number, wy: number): EntityId => {
    const hit = pickEntity(sketchRef.current, viewRef.current, sx, sy)
    if (hit !== null && sketchRef.current.get(hit)?.kind === 'point') return hit
    return sketchRef.current.addPoint(snap(wx), snap(wy)).id
  }

  const onPointerDown = (e: React.PointerEvent) => {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    const [sx, sy] = eventScreen(e)
    const [wx, wy] = eventWorld(e)
    const active = toolRef.current
    const hit = pickEntity(sketchRef.current, viewRef.current, sx, sy)

    if (e.button === 1 || e.button === 2) {
      dragRef.current = { mode: 'pan', lastX: e.clientX, lastY: e.clientY }
      return
    }

    if (active === 'select') {
      if (hit !== null) {
        const ent = sketchRef.current.get(hit)!
        if (e.shiftKey) {
          const cur = selectionRef.current.includes(hit)
            ? selectionRef.current.filter((x) => x !== hit)
            : [...selectionRef.current, hit]
          selectionRef.current = cur
          setSelection(cur)
        } else if (!selectionRef.current.includes(hit)) {
          selectionRef.current = [hit]
          setSelection([hit])
        }
        if (ent.kind === 'point') dragRef.current = { mode: 'point', id: hit, lastX: e.clientX, lastY: e.clientY, pushed: false }
      } else {
        if (!e.shiftKey) {
          selectionRef.current = []
          setSelection([])
        }
        dragRef.current = { mode: 'pan', lastX: e.clientX, lastY: e.clientY }
      }
      return
    }

    if (active === 'point') {
      pushHistory()
      sketchRef.current.addPoint(snap(wx), snap(wy))
      bump()
      return
    }

    if (active === 'line' || active === 'circle') {
      if (!pendingToolRef.current) pushHistory() // snapshot before the gesture creates anything
      const pid = pointAt(sx, sy, wx, wy)
      if (!pendingToolRef.current) {
        pendingToolRef.current = { startPoint: pid }
      } else {
        const start = pendingToolRef.current.startPoint
        if (active === 'line' && pid !== start) {
          sketchRef.current.addLine(start, pid)
        } else if (active === 'circle') {
          const c = sketchRef.current.point(start)
          const r = Math.max(2, Math.hypot(wx - c.x, wy - c.y))
          const circ = sketchRef.current.addCircle(start, r)
          if (sketchRef.current.get(pid)?.kind === 'point' && pid !== start) {
            sketchRef.current.addConstraint('pointOnCircle', [pid, circ.id])
          }
        }
        pendingToolRef.current = null
        bump()
      }
      return
    }

    if (active === 'arc') {
      if (!pendingArcRef.current) pushHistory() // snapshot before the gesture creates anything
      const pa = pendingArcRef.current
      if (!pa) {
        // Click 1 — the center.
        pendingArcRef.current = { center: pointAt(sx, sy, wx, wy) }
      } else if (pa.start === undefined) {
        // Click 2 — the start point, which sets the radius. Ignore a click back on
        // the center (zero radius) and wait for a distinct point.
        const pid = pointAt(sx, sy, wx, wy)
        if (pid !== pa.center) pendingArcRef.current = { center: pa.center, start: pid }
      } else {
        // Click 3 — the end point. Snap a freshly-created endpoint onto the circle
        // so the arc starts already valid; an existing point is used as-is and the
        // solver's intrinsic radius residual pulls it onto the circle.
        const center = sketchRef.current.point(pa.center)
        const start = sketchRef.current.point(pa.start)
        const r = Math.max(2, Math.hypot(start.x - center.x, start.y - center.y))
        const hit = pickEntity(sketchRef.current, viewRef.current, sx, sy)
        let endId: EntityId
        if (hit !== null && sketchRef.current.get(hit)?.kind === 'point' && hit !== pa.center) {
          endId = hit
        } else {
          const ang = Math.atan2(wy - center.y, wx - center.x)
          endId = sketchRef.current.addPoint(center.x + Math.cos(ang) * r, center.y + Math.sin(ang) * r).id
        }
        if (endId !== pa.start && endId !== pa.center) {
          sketchRef.current.addArc(pa.center, pa.start, endId, r)
          solveNow()
        }
        pendingArcRef.current = null
        bump()
      }
      return
    }

    if (active === 'spline') {
      if (!pendingSplineRef.current) pushHistory() // snapshot before the gesture creates anything
      const pid = pointAt(sx, sy, wx, wy)
      const cur = pendingSplineRef.current ?? { pts: [] }
      // Ignore an immediate repeat click on the same point (e.g. a double-tap).
      if (cur.pts[cur.pts.length - 1] !== pid) cur.pts.push(pid)
      pendingSplineRef.current = cur
      if (cur.pts.length === 4) {
        const [p0, c0, c1, p1] = cur.pts
        sketchRef.current.addSpline(p0, c0, c1, p1)
        solveNow()
        pendingSplineRef.current = null
      }
      bump()
      return
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const [sx, sy] = eventScreen(e)
    const [wx, wy] = screenToWorld(viewRef.current, sx, sy)
    cursorWorldRef.current = [wx, wy]
    const drag = dragRef.current

    if (drag.mode === 'pan') {
      const v = viewRef.current
      viewRef.current = { ...v, ox: v.ox + (e.clientX - drag.lastX), oy: v.oy + (e.clientY - drag.lastY) }
      drag.lastX = e.clientX
      drag.lastY = e.clientY
      return
    }
    if (drag.mode === 'point' && drag.id !== undefined) {
      if (!drag.pushed) {
        pushHistory() // snapshot the pre-drag position on the first move only
        drag.pushed = true
      }
      const p = sketchRef.current.point(drag.id)
      p.x = wx
      p.y = wy
      solve(sketchRef.current, { extraFixed: new Set([drag.id]) })
      return
    }
    const hit = pickEntity(sketchRef.current, viewRef.current, sx, sy)
    if (hit !== hoverRef.current) hoverRef.current = hit
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current
    if (drag.mode === 'point') {
      solveNow(new Set(drag.id !== undefined ? [drag.id] : []))
      bump()
    }
    dragRef.current = { mode: 'none', lastX: 0, lastY: 0 }
    ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
  }

  // Screen-space anchor near where a dimensional constraint's label is drawn, for
  // double-click hit-testing. Mirrors the renderer's dimension placement closely
  // enough to feel precise without duplicating its exact geometry.
  const dimensionAnchor = (c: Constraint): [number, number] | null => {
    const s = sketchRef.current
    const v = viewRef.current
    if (c.kind === 'distance') {
      const a = s.point(c.entities[0])
      const b = s.point(c.entities[1])
      return worldToScreen(v, (a.x + b.x) / 2, (a.y + b.y) / 2)
    }
    if (c.kind === 'radius' || c.kind === 'diameter') {
      const circ = s.circleLike(c.entities[0])
      const ctr = s.point(circ.c)
      const [cx, cy] = worldToScreen(v, ctr.x, ctr.y)
      let ang = -Math.PI / 4
      if (circ.kind === 'arc') {
        const g = s.arcGeom(circ)
        ang = -(g.a0 + g.sweep / 2)
      }
      return [cx + Math.cos(ang) * circ.r * v.scale, cy + Math.sin(ang) * circ.r * v.scale]
    }
    if (c.kind === 'angle') {
      const pivot = s.point(s.line(c.entities[1]).p1)
      return worldToScreen(v, pivot.x, pivot.y)
    }
    return null
  }

  const editDimensionAt = (sx: number, sy: number) => {
    let best: Constraint | null = null
    let bestD = 46
    for (const c of sketchRef.current.constraints) {
      const anchor = dimensionAnchor(c)
      if (!anchor) continue
      const d = Math.hypot(sx - anchor[0], sy - anchor[1])
      if (d < bestD) {
        bestD = d
        best = c
      }
    }
    if (!best) return
    const labels: Record<string, string> = { distance: 'Distance', radius: 'Radius', diameter: 'Diameter', angle: 'Angle' }
    setEditDim({
      constraintId: best.id,
      option: {
        kind: best.kind,
        label: `Edit ${labels[best.kind] ?? best.kind}`,
        symbol: '',
        value: best.kind as ValueKind,
        entities: [...best.entities],
        defaultValue: best.value ?? 0,
      },
    })
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    editDimensionAt(e.clientX - rect.left, e.clientY - rect.top)
  }

  const confirmEditDim = useCallback(
    (val: number) => {
      const edit = editDim
      if (!edit) return
      const c = sketchRef.current.constraints.find((k) => k.id === edit.constraintId)
      if (c) {
        pushHistory()
        c.value = val
        const res = solveNow()
        setMessage(res.converged ? `Updated ${edit.option.label.replace('Edit ', '').toLowerCase()} = ${val}.` : `Set value ${val} — could not be satisfied.`)
      }
      setEditDim(null)
      bump()
    },
    [editDim, bump, solveNow, pushHistory],
  )

  const onWheel = (e: React.WheelEvent) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const v = viewRef.current
    const factor = Math.exp(-e.deltaY * 0.0015)
    const newScale = clamp(v.scale * factor, 0.15, 60)
    const [wx, wy] = screenToWorld(v, sx, sy)
    viewRef.current = { scale: newScale, ox: sx - wx * newScale, oy: sy + wy * newScale }
  }

  // --- derived UI ----------------------------------------------------------
  // These read from the mutable sketch ref, so `rev` is included deliberately to
  // recompute whenever the sketch structure changes (the linter can't see that).
  /* eslint-disable react-hooks/exhaustive-deps */
  const options = useMemo(() => applicableConstraints(sketchRef.current, selection), [selection, rev])
  const dof = useMemo(() => analyzeDof(sketchRef.current), [rev])
  const conflicts = useMemo(() => analyzeConflicts(sketchRef.current), [rev])
  useEffect(() => void (redundantRef.current = conflicts.redundant), [conflicts])
  const constraintList = useMemo(() => sketchRef.current.constraints.slice(), [rev])
  const selectedEntities = useMemo(
    () => selection.map((id) => sketchRef.current.get(id)).filter((e): e is NonNullable<typeof e> => !!e),
    [selection, rev],
  )

  // The v(θ)/a(θ) motion profile of the tracer point across one full driver sweep.
  // Sweeping re-solves the mechanism at ~100 crank positions, so it is recomputed
  // only when the sketch structure (rev) or the driver changes — never per frame.
  const motionProfile = useMemo(() => {
    const d = driver
    const tracer = traceTargetsRef.current[0]
    if (!d || tracer === undefined) return null
    return computeMotionProfile(
      sketchRef.current,
      d.constraintId,
      tracer,
      { min: d.min, max: d.max },
      (deg) => (deg * Math.PI) / 180,
      (s) => void solve(s, { maxIterations: 120 }),
    )
  }, [rev, driver])

  // Live kinematics readout for the InfoPanel's Kinematics section. Recomputes as the
  // driver scrubs / animates (driverValue) so the tracer's speed and acceleration
  // track the motion; the expensive profile above is reused from its own memo.
  const motionData = useMemo<MotionData | null>(() => {
    const d = driver
    if (!d) return null
    const k = computeKinematics(sketchRef.current, d.constraintId)
    if (!k.ok) return null
    const tracer = traceTargetsRef.current[0]
    const pm = tracer !== undefined ? k.points.find((p) => p.id === tracer) : undefined
    const speedCoeff = pm ? Math.hypot(pm.vx, pm.vy) : 0
    const accelCoeff = pm ? Math.hypot(pm.ax, pm.ay) : 0
    const span = d.max - d.min || 1
    const perSec = span / d.period // driver units (deg or length) per second
    const omega = k.unit === 'rad' ? (perSec * Math.PI) / 180 : perSec
    return {
      unit: k.unit,
      tracerLabel: tracer !== undefined ? String(tracer) : '—',
      speedCoeff,
      accelCoeff,
      omega,
      driveGain: k.driveGain,
      nearDeadPoint: k.nearDeadPoint,
      currentFrac: (driverValue - d.min) / span,
      showVelocity,
      showAccel,
      onToggleVelocity: () => setShowVelocity((v) => !v),
      onToggleAccel: () => setShowAccel((v) => !v),
      profile: motionProfile,
    }
  }, [rev, driver, driverValue, showVelocity, showAccel, motionProfile])
  /* eslint-enable react-hooks/exhaustive-deps */

  // The Dynamics panel view-model. Only meaningful when a driver exists.
  const dynView = useMemo<DynView | null>(() => {
    if (!driver) return null
    const unit = driverParamUnit(sketchRef.current, driver.constraintId) ?? 'rad'
    return {
      on: dynOn,
      unit,
      params: dynParams,
      readout: dynReadout,
      onToggle: toggleDynamics,
      onReset: resetDynamics,
      onChange: updateDynParams,
    }
  }, [driver, dynOn, dynParams, dynReadout, toggleDynamics, resetDynamics, updateDynParams])

  // --- export --------------------------------------------------------------
  const downloadText = useCallback((filename: string, text: string, mime: string) => {
    const blob = new Blob([text], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [])

  const onExport = useCallback(
    (fmt: 'svg' | 'dxf' | 'csv') => {
      const s = sketchRef.current
      if (fmt === 'svg') {
        downloadText('datum-sketch.svg', sketchToSVG(s), 'image/svg+xml')
        setMessage('Exported the sketch as SVG.')
      } else if (fmt === 'dxf') {
        downloadText('datum-sketch.dxf', sketchToDXF(s), 'application/dxf')
        setMessage('Exported the sketch as DXF (LINE / CIRCLE / ARC).')
      } else if (fmt === 'csv') {
        if (!motionProfile) {
          setMessage('Drive a mechanism first — the CSV is its motion profile.')
          return
        }
        downloadText('datum-motion.csv', motionProfileToCSV(motionProfile), 'text/csv')
        setMessage('Exported the motion profile as CSV.')
      }
    },
    [downloadText, motionProfile],
  )

  // --- constraint actions --------------------------------------------------
  const applyOption = useCallback(
    (opt: ConstraintOption) => {
      if (opt.value) {
        setValuePrompt(opt)
        return
      }
      if (findDuplicate(sketchRef.current, opt.kind, opt.entities)) {
        setMessage('That constraint already exists.')
        return
      }
      pushHistory()
      sketchRef.current.addConstraint(opt.kind, opt.entities)
      const res = solveNow()
      setMessage(res.converged ? `Added ${opt.label}. Solved in ${res.iterations} iters.` : `Added ${opt.label} — system now over-constrained.`)
      selectionRef.current = []
      setSelection([])
      bump()
    },
    [bump, solveNow, pushHistory],
  )

  const confirmValue = useCallback(
    (val: number) => {
      const opt = valuePrompt
      if (!opt) return
      pushHistory()
      sketchRef.current.addConstraint(opt.kind, opt.entities, val)
      const res = solveNow()
      setMessage(res.converged ? `Added ${opt.label} = ${val}. Solved in ${res.iterations} iters.` : `Added ${opt.label} — could not be satisfied.`)
      setValuePrompt(null)
      selectionRef.current = []
      setSelection([])
      bump()
    },
    [valuePrompt, bump, solveNow, pushHistory],
  )

  const deleteSelected = useCallback(() => {
    if (!selectionRef.current.some((id) => sketchRef.current.get(id))) return
    pushHistory()
    for (const id of selectionRef.current) if (sketchRef.current.get(id)) sketchRef.current.removeEntity(id)
    selectionRef.current = []
    setSelection([])
    setMessage('Deleted selection.')
    bump()
  }, [bump, pushHistory])

  const removeConstraint = useCallback(
    (id: EntityId) => {
      pushHistory()
      sketchRef.current.removeConstraint(id)
      solveNow()
      bump()
    },
    [bump, solveNow, pushHistory],
  )

  const toggleAnchor = useCallback(() => {
    const hasPoint = selectionRef.current.some((id) => sketchRef.current.get(id)?.kind === 'point')
    if (!hasPoint) return
    pushHistory()
    for (const id of selectionRef.current) {
      const e = sketchRef.current.get(id)
      if (e?.kind === 'point') e.fixed = !e.fixed
    }
    solveNow()
    setMessage('Toggled anchor on selected point(s).')
    bump()
  }, [bump, solveNow, pushHistory])

  const reverseArc = useCallback(() => {
    const arcs = selectionRef.current.filter((id) => sketchRef.current.get(id)?.kind === 'arc')
    if (arcs.length === 0) return
    pushHistory()
    for (const id of arcs) sketchRef.current.reverseArc(id)
    setMessage('Reversed arc (minor ⇄ major).')
    bump()
  }, [bump, pushHistory])

  const runAutoConstrain = useCallback(() => {
    pushHistory()
    const res = autoConstrain(sketchRef.current)
    if (res.added === 0) {
      historyRef.current.past.pop() // nothing changed — don't leave an empty undo step
      syncHistory()
      setMessage('Auto-constrain found nothing new to infer.')
      return
    }
    const solveRes = solveNow()
    const parts = Object.entries(res.byKind).map(([k, n]) => `${n} ${k}`)
    setMessage(`Auto-constrained: added ${res.added} (${parts.join(', ')}). ${solveRes.converged ? 'Solved.' : 'Check conflicts.'}`)
    selectionRef.current = []
    setSelection([])
    bump()
  }, [bump, solveNow, pushHistory, syncHistory])

  const fitView = useCallback(() => {
    const { w, h } = sizeRef.current
    viewRef.current = frameBounds(sketchRef.current.boundingBox(), w, h)
  }, [])

  const clearTraces = useCallback(() => void (tracesRef.current = new Map()), [])

  // Hovering a constraint in the panel accents the geometry it governs (its
  // entities, plus the endpoints/centre of any line/circle it references).
  const setHoverConstraint = useCallback((id: EntityId | null) => {
    const set = new Set<EntityId>()
    if (id != null) {
      const c = sketchRef.current.constraints.find((k) => k.id === id)
      if (c)
        for (const eid of c.entities) {
          set.add(eid)
          const e = sketchRef.current.get(eid)
          if (e?.kind === 'line') {
            set.add(e.p1)
            set.add(e.p2)
          } else if (e?.kind === 'circle') set.add(e.c)
          else if (e?.kind === 'arc') {
            set.add(e.c)
            set.add(e.p1)
            set.add(e.p2)
          } else if (e?.kind === 'spline') {
            set.add(e.p0)
            set.add(e.c0)
            set.add(e.c1)
            set.add(e.p1)
          }
        }
    }
    highlightRef.current = set
  }, [])

  const scrubDriver = useCallback((val: number) => {
    const d = driverRef.current
    if (!d) return
    driverValueRef.current = val
    d.constraint.value = val
    const res = solve(sketchRef.current, {})
    setDriverValue(val)
    setSolveInfo(res)
  }, [])

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        redo()
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected()
      else if (e.key === 'Escape') {
        pendingToolRef.current = null
        pendingArcRef.current = null
        pendingSplineRef.current = null
        selectionRef.current = []
        setSelection([])
      } else if (e.key === 'v' || e.key === '1') setTool('select')
      else if (e.key === 'p' || e.key === '2') setTool('point')
      else if (e.key === 'l' || e.key === '3') setTool('line')
      else if (e.key === 'c' || e.key === '4') setTool('circle')
      else if (e.key === 'a' || e.key === '5') setTool('arc')
      else if (e.key === 's' || e.key === '6') setTool('spline')
      else if (e.key === 'f') fitView()
      else if (e.key === ' ' && driverRef.current) {
        e.preventDefault()
        setPlaying((p) => !p)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [deleteSelected, fitView, undo, redo])

  return (
    <div className="app">
      <Toolbar
        tool={tool}
        onTool={(t) => {
          setTool(t)
          pendingToolRef.current = null
          pendingArcRef.current = null
          pendingSplineRef.current = null
        }}
        exampleId={exampleId}
        examples={EXAMPLES}
        onExample={loadExample}
        showGrid={showGrid}
        onToggleGrid={() => setShowGrid((v) => !v)}
        showConstraints={showConstraints}
        onToggleConstraints={() => setShowConstraints((v) => !v)}
        onFit={fitView}
        onDiagnostics={() => setShowTests(true)}
        canUndo={history.canUndo}
        canRedo={history.canRedo}
        onUndo={undo}
        onRedo={redo}
        onAutoConstrain={runAutoConstrain}
        onNew={newSketch}
        onSave={saveSketch}
        onOpen={() => fileInputRef.current?.click()}
        onShare={shareSketch}
      />
      <div className="body">
        <div className="canvasWrap" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            className={`sketch tool-${tool}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={onDoubleClick}
            onWheel={onWheel}
            onContextMenu={(e) => e.preventDefault()}
          />
          <ConstraintPalette
            options={options}
            onApply={applyOption}
            onDelete={deleteSelected}
            onAnchor={toggleAnchor}
            onReverseArc={reverseArc}
            canReverseArc={selectedEntities.some((e) => e.kind === 'arc')}
            selectionCount={selection.length}
          />
          {message && <div className="statusToast">{message}</div>}
        </div>
        <InfoPanel
          dof={dof}
          solveInfo={solveInfo}
          selected={selectedEntities}
          constraints={constraintList}
          redundant={conflicts.redundant}
          motion={motionData}
          dynamics={dynView}
          canExportCsv={!!motionProfile}
          onExport={onExport}
          onRemoveConstraint={removeConstraint}
          onHoverConstraint={setHoverConstraint}
        />
      </div>
      {driver && (
        <DriverBar
          spec={driver}
          value={driverValue}
          playing={playing}
          onPlay={() => setPlaying((p) => !p)}
          onScrub={scrubDriver}
          showTrace={showTrace}
          onToggleTrace={() => setShowTrace((v) => !v)}
          onClearTrace={clearTraces}
        />
      )}
      {valuePrompt && <ValuePrompt option={valuePrompt} onConfirm={confirmValue} onCancel={() => setValuePrompt(null)} />}
      {editDim && <ValuePrompt option={editDim.option} onConfirm={confirmEditDim} onCancel={() => setEditDim(null)} />}
      {showTests && <Diagnostics tests={tests} onClose={() => setShowTests(false)} onRerun={() => setTests(runSelfTests())} />}
      <input ref={fileInputRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={onOpenFile} />
    </div>
  )
}
