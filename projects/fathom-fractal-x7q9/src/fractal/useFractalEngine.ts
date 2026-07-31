import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FractalRenderer } from '../webgl/renderer'
import type { FrameState } from '../webgl/renderer'
import { computeReferenceOrbit } from './refOrbit'
import { hpAddNumber, hpFromNumber, hpFromString, hpMul, hpToNumber, hpToString, type HP } from './hp'
import type { Bookmark, Engine, FractalFormula, HudInfo, RenderParams, Viewport } from './types'
import { COLOR_MODE_INDEX, FORMULAS, HOME, INITIAL_SPAN, formulaInfo, homeFor } from './types'
import { decodeView, encodeView } from './share'

const DF64_MIN_SCALE = 1e-14 // world units per pixel — the df64 precision floor
const PERTURB_MIN_SCALE = 1e-35 // float32 delta floor for the perturbation engine
const PERTURB_SPAN = 1e-9 // engage perturbation once the view is this narrow
const MAX_SPAN = 6.0

const DEFAULT_PARAMS: RenderParams = {
  maxIter: 320,
  autoIter: true,
  formula: 'mandelbrot',
  mode: 'mandelbrot',
  juliaX: -0.8,
  juliaY: 0.156,
  paletteId: 'nebula',
  colorScale: 0.035,
  colorOffset: 0.0,
  cycleSpeed: 0.0,
  aa: 1,
  de: false,
  deStrength: 4.0,
  colorMode: 'smooth',
  featureFreq: 6.0,
  interior: false,
  relief: false,
  lightAngle: 0.78,
  lightHeight: 1.2,
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)

export function recommendedIter(span: number): number {
  // Escape-time depth grows super-linearly with zoom: near a Misiurewicz point
  // like the seahorse, a 1e10 dive resolves in ~2k iterations but a 1e20 dive
  // needs ~12k before the boundary bands separate (measured against a headless
  // render). A quadratic in the magnification exponent fits both ends and keeps
  // shallow views cheap. The perturbation loop is plain float32, so even the
  // deepest counts stay tractable on a real GPU.
  const exp = Math.log10(Math.max(1, INITIAL_SPAN / span))
  return Math.round(clamp(400 + 60 * exp + 28 * exp * exp, 200, 30000))
}

const cloneViewport = (v: Viewport): Viewport => ({ cx: v.cx, cy: v.cy, span: v.span })

// Linear interpolation between two high-precision coordinates.
const lerpHP = (a: HP, b: HP, t: number): HP => a + hpMul(hpFromNumber(t), b - a)
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

type EngineActions = {
  reset: () => void
  applyBookmark: (b: Bookmark) => void
  seedJuliaFromCenter: () => void
  setMode: (mode: 'mandelbrot' | 'julia') => void
  setFormula: (formula: FractalFormula) => void
  zoomAtCenter: (factor: number) => void
  exportPng: () => void
  share: () => Promise<boolean>
  toggleDive: () => void
}

export function useFractalEngine() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<FractalRenderer | null>(null)
  const viewportRef = useRef<Viewport>(cloneViewport(HOME))
  const phaseRef = useRef(0)
  const rafRef = useRef(0)
  const lastFrameRef = useRef(0)
  const fpsRef = useRef(60)
  const animRef = useRef(0)
  // Signature of the currently uploaded reference orbit, to avoid recomputing it
  // when nothing that affects it has changed.
  const orbitKeyRef = useRef<{ cx: HP; cy: HP; maxIter: number; power: number; len: number } | null>(
    null,
  )
  const urlTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Progressive rendering: while the camera is moving we render at reduced
  // internal resolution (cheap), then re-render at full quality once it settles.
  // On a deep-zoom frame each pixel loops thousands of iterations, so cutting the
  // pixel count keeps drags and zooms interactive; the crisp frame lands ~1 tick
  // after you let go. `beginInteractRef` is wired up in the setup effect below.
  const beginInteractRef = useRef<(() => void) | null>(null)
  const markInteract = useCallback(() => beginInteractRef.current?.(), [])
  const diveRef = useRef(0)
  const stopDiveRef = useRef<(() => void) | null>(null)

  const [params, setParams] = useState<RenderParams>(() => {
    const decoded = decodeView(window.location.hash)
    return decoded ? { ...DEFAULT_PARAMS, ...decoded.params } : DEFAULT_PARAMS
  })
  const paramsRef = useRef(params)
  useEffect(() => {
    paramsRef.current = params
  }, [params])

  const [hud, setHud] = useState<HudInfo>({
    re: hpToString(HOME.cx, 6),
    im: hpToString(HOME.cy, 6),
    span: HOME.span,
    magnification: 1,
    maxIter: DEFAULT_PARAMS.maxIter,
    formula: 'mandelbrot',
    mode: 'mandelbrot',
    fps: 60,
    engine: 'df64',
    colorMode: DEFAULT_PARAMS.colorMode,
  })
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [refining, setRefining] = useState(false)
  const [diving, setDiving] = useState(false)

  const currentScale = useCallback(() => {
    const canvas = canvasRef.current
    const vp = viewportRef.current
    if (!canvas || canvas.width === 0) return vp.span
    return vp.span / canvas.width
  }, [])

  // The deep perturbation engine only applies to the parameter-plane power maps
  // (z^p + c), whose critical orbit starts at Z0 = 0. Every other formula — and
  // Julia mode — stays on the crisp-to-~1e13 df64 engine.
  const engineFor = useCallback((span: number, mode: string, formula: FractalFormula): Engine => {
    const r = rendererRef.current
    return mode === 'mandelbrot' &&
      formulaInfo(formula).perturbable &&
      span < PERTURB_SPAN &&
      !!r?.perturbationAvailable
      ? 'perturb'
      : 'df64'
  }, [])

  // Recompute + upload the reference orbit only when its inputs changed.
  const ensureOrbit = useCallback((cx: HP, cy: HP, maxIter: number, power: number): number => {
    const renderer = rendererRef.current
    if (!renderer) return 0
    const cur = orbitKeyRef.current
    if (cur && cur.cx === cx && cur.cy === cy && cur.maxIter === maxIter && cur.power === power)
      return cur.len
    const orb = computeReferenceOrbit(cx, cy, maxIter, power)
    renderer.setReferenceOrbit(orb.xs, orb.ys, orb.length)
    orbitKeyRef.current = { cx, cy, maxIter, power, len: orb.length }
    return orb.length
  }, [])

  const buildFrame = useCallback((): FrameState => {
    const vp = viewportRef.current
    const p = paramsRef.current
    const f = formulaInfo(p.formula)
    const maxIter = p.autoIter ? recommendedIter(vp.span) : p.maxIter
    const scale = currentScale()
    const perturbation = engineFor(vp.span, p.mode, p.formula) === 'perturb'
    const orbitLen = perturbation ? ensureOrbit(vp.cx, vp.cy, maxIter, f.power) : 0
    // DE + relief require the analytic escape derivative, which only exists for
    // the holomorphic power maps — gate them off elsewhere so the picture is
    // never shaded by a meaningless derivative.
    const shadeOk = f.holomorphic
    return {
      centerX: hpToNumber(vp.cx),
      centerY: hpToNumber(vp.cy),
      scale,
      maxIter,
      formula: f.glslIndex,
      power: f.power,
      mode: p.mode,
      juliaX: p.juliaX,
      juliaY: p.juliaY,
      colorScale: p.colorScale,
      colorOffset: p.colorOffset + phaseRef.current,
      aa: p.aa,
      paletteId: p.paletteId,
      de: p.de && shadeOk,
      deStrength: p.deStrength,
      colorMode: COLOR_MODE_INDEX[p.colorMode],
      featureFreq: p.featureFreq,
      interior: p.interior,
      relief: p.relief && shadeOk,
      lightAngle: p.lightAngle,
      lightHeight: p.lightHeight,
      perturbation,
      orbitLen,
    }
  }, [currentScale, engineFor, ensureOrbit])

  const renderNow = useCallback(() => {
    const renderer = rendererRef.current
    if (!renderer) return
    renderer.render(buildFrame())
    const now = performance.now()
    if (lastFrameRef.current) {
      const dt = now - lastFrameRef.current
      if (dt > 0) fpsRef.current = fpsRef.current * 0.9 + (1000 / dt) * 0.1
    }
    lastFrameRef.current = now
  }, [buildFrame])

  const schedule = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      renderNow()
    })
  }, [renderNow])

  const publishHud = useCallback(() => {
    const vp = viewportRef.current
    const p = paramsRef.current
    const digits = Math.round(clamp(-Math.log10(vp.span) + 5, 5, 60))
    setHud({
      re: hpToString(vp.cx, digits),
      im: hpToString(vp.cy, digits),
      span: vp.span,
      magnification: INITIAL_SPAN / vp.span,
      maxIter: p.autoIter ? recommendedIter(vp.span) : p.maxIter,
      formula: p.formula,
      mode: p.mode,
      fps: fpsRef.current,
      engine: engineFor(vp.span, p.mode, p.formula),
      colorMode: p.colorMode,
    })
  }, [engineFor])

  // Persist the current view to the URL hash (debounced) so it can be shared.
  const syncUrl = useCallback(() => {
    if (urlTimerRef.current) clearTimeout(urlTimerRef.current)
    urlTimerRef.current = setTimeout(() => {
      const hash = encodeView(viewportRef.current, paramsRef.current)
      history.replaceState(null, '', `#${hash}`)
    }, 350)
  }, [])

  const cancelAnim = useCallback(() => {
    if (animRef.current) {
      cancelAnimationFrame(animRef.current)
      animRef.current = 0
    }
  }, [])

  // Backing-pixel offset of a client point from the canvas centre (y up).
  const pixelOffset = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const dprX = canvas.width / rect.width
    const dprY = canvas.height / rect.height
    const fragX = (clientX - rect.left) * dprX
    const fragY = canvas.height - (clientY - rect.top) * dprY
    return { px: fragX - canvas.width / 2, py: fragY - canvas.height / 2 }
  }, [])

  // Deepest world-units-per-pixel we allow the camera to reach. Only the power
  // maps ride the perturbation engine to the float32 delta floor; anything else
  // clamps at the df64 precision floor so a zoom never dissolves into blocks.
  const minScale = useCallback(() => {
    const canPerturb =
      rendererRef.current?.perturbationAvailable &&
      formulaInfo(paramsRef.current.formula).perturbable
    return canPerturb ? PERTURB_MIN_SCALE : DF64_MIN_SCALE
  }, [])

  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const canvas = canvasRef.current
      if (!canvas) return
      stopDiveRef.current?.()
      cancelAnim()
      markInteract()
      const { px, py } = pixelOffset(clientX, clientY)
      const vp = viewportRef.current
      const scale = vp.span / canvas.width
      const minSpan = minScale() * canvas.width
      const newSpan = clamp(vp.span * factor, minSpan, MAX_SPAN)
      const newScale = newSpan / canvas.width
      // Keep the cursor's world point fixed: shift centre by px·(scale−newScale).
      // Both scales are tiny and nearly equal, but their difference is a clean
      // double, so the high-precision centre stays exact.
      vp.cx = hpAddNumber(vp.cx, px * (scale - newScale))
      vp.cy = hpAddNumber(vp.cy, py * (scale - newScale))
      vp.span = newSpan
      publishHud()
      schedule()
      syncUrl()
    },
    [pixelOffset, publishHud, schedule, syncUrl, cancelAnim, minScale, markInteract],
  )

  const zoomAtCenter = useCallback(
    (factor: number) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor)
    },
    [zoomAt],
  )

  // Smoothly fly from the current view to a target viewport (bookmarks, share).
  const flyTo = useCallback(
    (target: Viewport) => {
      cancelAnim()
      const start = cloneViewport(viewportRef.current)
      const logStart = Math.log(start.span)
      const logEnd = Math.log(target.span)
      const dur = 1050
      const t0 = performance.now()
      markInteract()
      const step = (now: number) => {
        const raw = Math.min(1, (now - t0) / dur)
        const u = easeInOut(raw)
        markInteract()
        const vp = viewportRef.current
        vp.cx = lerpHP(start.cx, target.cx, u)
        vp.cy = lerpHP(start.cy, target.cy, u)
        vp.span = Math.exp(logStart + (logEnd - logStart) * u)
        publishHud()
        renderNow()
        if (raw < 1) {
          animRef.current = requestAnimationFrame(step)
        } else {
          animRef.current = 0
          viewportRef.current = cloneViewport(target)
          publishHud()
          renderNow()
          syncUrl()
        }
      }
      animRef.current = requestAnimationFrame(step)
    },
    [publishHud, renderNow, syncUrl, cancelAnim, markInteract],
  )

  // --- one-time setup: renderer, resize observer, pointer + wheel handlers ---
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let renderer: FractalRenderer
    try {
      renderer = new FractalRenderer(canvas)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      queueMicrotask(() => setError(message))
      return
    }
    rendererRef.current = renderer

    // Restore a shared view from the URL hash, if present and valid.
    const decoded = decodeView(window.location.hash)
    if (decoded) viewportRef.current = decoded.viewport

    const dpr = () => Math.min(window.devicePixelRatio || 1, 2)
    // Progressive rendering: DRAFT_SCALE shrinks the backing store while the
    // camera moves (quarter the pixels at 0.5), then we snap back to full.
    const DRAFT_SCALE = 0.5
    const SETTLE_MS = 170
    let renderScale = 1
    let settleTimer: ReturnType<typeof setTimeout> | null = null

    const applyBacking = (scale: number) => {
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr() * scale))
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr() * scale))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        renderer.resize(w, h)
      }
    }
    const resize = () => {
      applyBacking(renderScale)
      publishHud()
      renderNow()
    }
    const settle = () => {
      settleTimer = null
      if (renderScale !== 1) {
        renderScale = 1
        applyBacking(1)
      }
      setRefining(false)
      renderNow()
    }
    // Called by every camera-moving interaction: drop to draft resolution now,
    // and (re)arm the timer that restores full quality once motion stops.
    const beginInteract = () => {
      if (renderScale !== DRAFT_SCALE) {
        renderScale = DRAFT_SCALE
        applyBacking(DRAFT_SCALE)
        setRefining(true)
      }
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = setTimeout(settle, SETTLE_MS)
    }
    beginInteractRef.current = beginInteract

    const kickoff = requestAnimationFrame(() => {
      resize()
      setReady(true)
    })
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const factor = Math.pow(1.0016, e.deltaY) // wheel up -> zoom in
      zoomAt(e.clientX, e.clientY, factor)
    }

    // --- pointer + pinch handling ---
    const active = new Map<number, { x: number; y: number }>()
    let dragging = false
    let lastX = 0
    let lastY = 0
    let pinchDist = 0
    let pinchCX = 0
    let pinchCY = 0

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' && e.button !== 0) return
      stopDiveRef.current?.()
      active.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (active.size === 2) {
        // begin pinch
        dragging = false
        const pts = [...active.values()]
        pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
        pinchCX = (pts[0].x + pts[1].x) / 2
        pinchCY = (pts[0].y + pts[1].y) / 2
        cancelAnim()
        return
      }
      if (e.shiftKey && paramsRef.current.mode === 'mandelbrot') {
        const { px, py } = pixelOffset(e.clientX, e.clientY)
        const scale = currentScale()
        const jx = hpToNumber(viewportRef.current.cx) + px * scale
        const jy = hpToNumber(viewportRef.current.cy) + py * scale
        viewportRef.current = cloneViewport(homeFor(paramsRef.current.formula, 'julia'))
        cancelAnim()
        setParams((p) => ({ ...p, mode: 'julia', juliaX: jx, juliaY: jy }))
        publishHud()
        return
      }
      dragging = true
      lastX = e.clientX
      lastY = e.clientY
      canvas.setPointerCapture(e.pointerId)
      canvas.style.cursor = 'grabbing'
      cancelAnim()
    }

    const onPointerMove = (e: PointerEvent) => {
      if (active.has(e.pointerId)) active.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (active.size === 2) {
        const pts = [...active.values()]
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
        const cx = (pts[0].x + pts[1].x) / 2
        const cy = (pts[0].y + pts[1].y) / 2
        if (pinchDist > 0 && dist > 0) {
          zoomAt(cx, cy, pinchDist / dist)
        }
        // pan by the midpoint drift
        const canvasW = canvas.width / canvas.clientWidth
        const canvasH = canvas.height / canvas.clientHeight
        const scale = currentScale()
        const vp = viewportRef.current
        vp.cx = hpAddNumber(vp.cx, -(cx - pinchCX) * canvasW * scale)
        vp.cy = hpAddNumber(vp.cy, (cy - pinchCY) * canvasH * scale)
        pinchDist = dist
        pinchCX = cx
        pinchCY = cy
        publishHud()
        schedule()
        syncUrl()
        return
      }
      if (!dragging) return
      beginInteract()
      const scale = currentScale()
      const dprX = canvas.width / canvas.clientWidth
      const dprY = canvas.height / canvas.clientHeight
      const vp = viewportRef.current
      vp.cx = hpAddNumber(vp.cx, -(e.clientX - lastX) * dprX * scale)
      vp.cy = hpAddNumber(vp.cy, (e.clientY - lastY) * dprY * scale)
      lastX = e.clientX
      lastY = e.clientY
      publishHud()
      schedule()
      syncUrl()
    }

    const onPointerUp = (e: PointerEvent) => {
      active.delete(e.pointerId)
      if (active.size < 2) pinchDist = 0
      dragging = false
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
      canvas.style.cursor = 'grab'
    }

    const onDoubleClick = (e: MouseEvent) => {
      e.preventDefault()
      zoomAt(e.clientX, e.clientY, 0.4)
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)
    canvas.addEventListener('dblclick', onDoubleClick)
    canvas.style.cursor = 'grab'

    return () => {
      cancelAnimationFrame(kickoff)
      if (settleTimer) clearTimeout(settleTimer)
      beginInteractRef.current = null
      ro.disconnect()
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('dblclick', onDoubleClick)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (animRef.current) cancelAnimationFrame(animRef.current)
      if (diveRef.current) cancelAnimationFrame(diveRef.current)
      rendererRef.current = null
      renderer.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-render whenever a non-camera parameter changes.
  useEffect(() => {
    if (!ready) return
    const id = requestAnimationFrame(() => {
      publishHud()
      renderNow()
      syncUrl()
    })
    return () => cancelAnimationFrame(id)
  }, [params, ready, publishHud, renderNow, syncUrl])

  // Palette / colour cycling loop, active only while cycleSpeed != 0.
  useEffect(() => {
    if (!ready || params.cycleSpeed === 0) return
    let raf = 0
    let prev = performance.now()
    const tick = (t: number) => {
      const dt = (t - prev) / 1000
      prev = t
      phaseRef.current = (phaseRef.current + params.cycleSpeed * dt) % 1000
      renderNow()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [ready, params.cycleSpeed, renderNow])

  // --- imperative actions exposed to the UI ---
  const reset = useCallback(() => {
    cancelAnim()
    const p = paramsRef.current
    viewportRef.current = cloneViewport(homeFor(p.formula, p.mode))
    phaseRef.current = 0
    publishHud()
    schedule()
    syncUrl()
  }, [publishHud, schedule, syncUrl, cancelAnim])

  const applyBookmark = useCallback(
    (b: Bookmark) => {
      const target: Viewport = {
        cx: hpFromString(b.centerX),
        cy: hpFromString(b.centerY),
        span: b.span,
      }
      const formula = b.formula ?? 'mandelbrot'
      const prev = paramsRef.current
      phaseRef.current = 0
      setParams((p) => ({
        ...p,
        formula,
        mode: b.mode,
        juliaX: b.juliaX ?? p.juliaX,
        juliaY: b.juliaY ?? p.juliaY,
        paletteId: b.paletteId ?? p.paletteId,
        de: b.de ?? p.de,
        colorMode: b.colorMode ?? p.colorMode,
        featureFreq: b.featureFreq ?? p.featureFreq,
        interior: b.interior ?? p.interior,
        relief: b.relief ?? p.relief,
      }))
      // A cinematic dive only reads well within one continuous plane; jump when
      // the formula or the mode changes (a morph between different sets is noise).
      const sameContext =
        b.mode === 'mandelbrot' && prev.mode === 'mandelbrot' && formula === prev.formula
      if (sameContext) {
        flyTo(target)
      } else {
        cancelAnim()
        viewportRef.current = cloneViewport(target)
        publishHud()
        schedule()
        syncUrl()
      }
    },
    [flyTo, publishHud, schedule, syncUrl, cancelAnim],
  )

  const seedJuliaFromCenter = useCallback(() => {
    const vp = viewportRef.current
    const jx = hpToNumber(vp.cx)
    const jy = hpToNumber(vp.cy)
    cancelAnim()
    viewportRef.current = cloneViewport(homeFor(paramsRef.current.formula, 'julia'))
    setParams((p) => ({ ...p, mode: 'julia', juliaX: jx, juliaY: jy }))
    publishHud()
    schedule()
  }, [publishHud, schedule, cancelAnim])

  const setMode = useCallback(
    (mode: 'mandelbrot' | 'julia') => {
      cancelAnim()
      viewportRef.current = cloneViewport(homeFor(paramsRef.current.formula, mode))
      phaseRef.current = 0
      setParams((p) => ({ ...p, mode }))
      publishHud()
      schedule()
    },
    [publishHud, schedule, cancelAnim],
  )

  // Switch the iteration formula, resetting to that formula's home camera and a
  // sensible default Julia constant so a mid-zoom switch never lands off-set.
  const setFormula = useCallback(
    (formula: FractalFormula) => {
      cancelAnim()
      const info = formulaInfo(formula)
      const mode = paramsRef.current.mode
      viewportRef.current = cloneViewport(homeFor(formula, mode))
      phaseRef.current = 0
      orbitKeyRef.current = null // force a fresh reference orbit for the new degree
      setParams((p) => ({ ...p, formula, juliaX: info.juliaCX, juliaY: info.juliaCY }))
      publishHud()
      schedule()
    },
    [publishHud, schedule, cancelAnim],
  )

  const exportPng = useCallback(async () => {
    const canvas = canvasRef.current
    const renderer = rendererRef.current
    if (!canvas || !renderer) return
    const oldW = canvas.width
    const oldH = canvas.height
    const factor = 2
    const w = Math.min(oldW * factor, 4096)
    const h = Math.min(oldH * factor, 4096)
    canvas.width = w
    canvas.height = h
    renderer.resize(w, h)
    renderer.render(buildFrame())
    await new Promise<void>((resolve) => {
      canvas.toBlob((blob) => {
        if (blob) {
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `fathom-${Date.now()}.png`
          a.click()
          URL.revokeObjectURL(url)
        }
        resolve()
      }, 'image/png')
    })
    canvas.width = oldW
    canvas.height = oldH
    renderer.resize(oldW, oldH)
    renderNow()
  }, [buildFrame, renderNow])

  const share = useCallback(async (): Promise<boolean> => {
    const hash = encodeView(viewportRef.current, paramsRef.current)
    const url = `${location.origin}${location.pathname}${location.search}#${hash}`
    history.replaceState(null, '', `#${hash}`)
    try {
      await navigator.clipboard.writeText(url)
      return true
    } catch {
      return false
    }
  }, [])

  const stopDive = useCallback(() => {
    if (diveRef.current) {
      cancelAnimationFrame(diveRef.current)
      diveRef.current = 0
    }
    setDiving(false)
  }, [])
  useEffect(() => {
    stopDiveRef.current = stopDive
  }, [stopDive])

  // Continuous cinematic zoom into the current centre, until stopped or the
  // engine's precision floor is reached. Renders at draft resolution for a
  // smooth dive, then settles crisp when it stops.
  const toggleDive = useCallback(() => {
    if (diveRef.current) {
      stopDive()
      return
    }
    cancelAnim()
    setDiving(true)
    const tick = () => {
      const canvas = canvasRef.current
      const vp = viewportRef.current
      const minSpan = minScale() * (canvas?.width ?? 1)
      if (vp.span <= minSpan * 1.02) {
        stopDive()
        renderNow()
        return
      }
      vp.span = Math.max(minSpan, vp.span * 0.985)
      markInteract()
      publishHud()
      renderNow()
      syncUrl()
      diveRef.current = requestAnimationFrame(tick)
    }
    diveRef.current = requestAnimationFrame(tick)
  }, [stopDive, cancelAnim, minScale, markInteract, publishHud, renderNow, syncUrl])

  const actions: EngineActions = useMemo(
    () => ({
      reset,
      applyBookmark,
      seedJuliaFromCenter,
      setMode,
      setFormula,
      zoomAtCenter,
      exportPng,
      share,
      toggleDive,
    }),
    [
      reset,
      applyBookmark,
      seedJuliaFromCenter,
      setMode,
      setFormula,
      zoomAtCenter,
      exportPng,
      share,
      toggleDive,
    ],
  )

  const setParam = useCallback(<K extends keyof RenderParams>(key: K, value: RenderParams[K]) => {
    setParams((p) => ({ ...p, [key]: value }))
  }, [])

  // Nudge the view by a fraction of the current span (keyboard panning).
  const panByFraction = useCallback(
    (fx: number, fy: number) => {
      const vp = viewportRef.current
      markInteract()
      vp.cx = hpAddNumber(vp.cx, fx * vp.span)
      vp.cy = hpAddNumber(vp.cy, fy * vp.span)
      publishHud()
      schedule()
      syncUrl()
    },
    [markInteract, publishHud, schedule, syncUrl],
  )

  // Keyboard navigation: arrows pan, +/- zoom, r resets. Ignored while typing.
  useEffect(() => {
    if (!ready) return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const step = e.shiftKey ? 0.3 : 0.12
      switch (e.key) {
        case 'ArrowLeft':
          panByFraction(-step, 0)
          break
        case 'ArrowRight':
          panByFraction(step, 0)
          break
        case 'ArrowUp':
          panByFraction(0, step)
          break
        case 'ArrowDown':
          panByFraction(0, -step)
          break
        case '+':
        case '=':
          zoomAtCenter(0.5)
          break
        case '-':
        case '_':
          zoomAtCenter(2)
          break
        case 'r':
        case 'R':
          reset()
          break
        case 'f':
        case 'F': {
          // f cycles the formula forward, Shift+F backward.
          const idx = FORMULAS.findIndex((f) => f.id === paramsRef.current.formula)
          const dir = e.shiftKey ? -1 : 1
          const next = FORMULAS[(idx + dir + FORMULAS.length) % FORMULAS.length]
          setFormula(next.id)
          break
        }
        default:
          return
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ready, panByFraction, zoomAtCenter, reset, setFormula])

  return { canvasRef, params, setParam, hud, error, ready, refining, diving, actions }
}
