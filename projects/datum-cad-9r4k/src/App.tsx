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
import { solve } from './solver/solver'
import type { SolveResult } from './solver/solver'
import { analyzeDof } from './solver/dof'
import { analyzeConflicts } from './solver/conflicts'
import { runSelfTests } from './solver/selftest'
import type { TestResult } from './solver/selftest'
import { render } from './render/renderer'
import type { RenderState, TracePath } from './render/renderer'
import { pickEntity } from './render/picking'
import { frameBounds, screenToWorld, worldToScreen, clamp } from './render/view'
import type { View } from './render/view'
import { Toolbar, ConstraintPalette, InfoPanel, DriverBar, ValuePrompt, Diagnostics } from './ui/components'

type ToolId = 'select' | 'point' | 'line' | 'circle'

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
  const showConstraintsRef = useRef(true)
  const showGridRef = useRef(true)
  const cursorWorldRef = useRef<[number, number]>([0, 0])
  const driverRef = useRef<{ spec: DriverSpec; constraint: Constraint } | null>(null)
  const driverValueRef = useRef(0)
  const driverDirRef = useRef(1) // sweep direction for ping-pong (non-wrapping) drivers
  const tracesRef = useRef<Map<EntityId, [number, number][]>>(new Map())
  const traceTargetsRef = useRef<EntityId[]>([])
  const redundantRef = useRef<Set<EntityId>>(new Set())
  const lastTsRef = useRef(0)
  const dragRef = useRef<{ mode: 'none' | 'point' | 'pan'; id?: EntityId; lastX: number; lastY: number; pushed?: boolean }>({
    mode: 'none',
    lastX: 0,
    lastY: 0,
  })
  const pendingToolRef = useRef<{ startPoint: EntityId } | null>(null)
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
  const [driverValue, setDriverValue] = useState(0)
  const [driver, setDriver] = useState<DriverSpec | null>(null)
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
  useEffect(() => void (showConstraintsRef.current = showConstraints), [showConstraints])
  useEffect(() => void (showGridRef.current = showGrid), [showGrid])

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
      solve(built.sketch, {})
      const { w, h } = sizeRef.current
      viewRef.current = frameBounds(built.sketch.boundingBox(), w, h)
      setExampleId(id)
      setMessage(`Loaded “${exampleById(id).name}”.`)
      resetHistory()
      bump()
    },
    [bump, resetHistory],
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
      solveNow()
      const { w, h } = sizeRef.current
      viewRef.current = frameBounds(sketch.boundingBox(), w, h)
      setExampleId('')
      setMessage(label)
      resetHistory()
      bump()
    },
    [bump, resetHistory, solveNow],
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
    }
    const st: RenderState = {
      view: viewRef.current,
      selection: new Set(selectionRef.current),
      hover: hoverRef.current,
      pending: new Set(pendingToolRef.current ? [pendingToolRef.current.startPoint] : []),
      traces,
      dofStatus: status,
      redundant,
      showConstraints: showConstraintsRef.current,
      showGrid: showGridRef.current,
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
      if (playingRef.current && driver) {
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
        if (showTraceRef.current) {
          for (const id of traceTargetsRef.current) {
            const p = sketchRef.current.point(id)
            let arr = tracesRef.current.get(id)
            if (!arr) tracesRef.current.set(id, (arr = []))
            const last = arr[arr.length - 1]
            if (!last || Math.hypot(last[0] - p.x, last[1] - p.y) > 0.4) arr.push([p.x, p.y])
            if (arr.length > 4000) arr.shift()
          }
        }
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
      const circ = s.circle(c.entities[0])
      const ctr = s.point(circ.c)
      const [cx, cy] = worldToScreen(v, ctr.x, ctr.y)
      return [cx + Math.cos(-Math.PI / 4) * circ.r * v.scale, cy + Math.sin(-Math.PI / 4) * circ.r * v.scale]
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
  /* eslint-enable react-hooks/exhaustive-deps */

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
        selectionRef.current = []
        setSelection([])
      } else if (e.key === 'v' || e.key === '1') setTool('select')
      else if (e.key === 'p' || e.key === '2') setTool('point')
      else if (e.key === 'l' || e.key === '3') setTool('line')
      else if (e.key === 'c' || e.key === '4') setTool('circle')
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
          onRemoveConstraint={removeConstraint}
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
