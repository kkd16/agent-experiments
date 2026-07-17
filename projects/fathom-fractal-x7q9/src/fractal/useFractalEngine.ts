import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FractalRenderer } from '../webgl/renderer'
import type { FrameState } from '../webgl/renderer'
import type { Bookmark, HudInfo, RenderParams, Viewport } from './types'
import { HOME, INITIAL_SPAN } from './types'

const MIN_SCALE = 1e-14 // world units per pixel — the df64 precision floor
const MAX_SPAN = 6.0
const JULIA_HOME: Viewport = { centerX: 0, centerY: 0, span: 3.2 }

const DEFAULT_PARAMS: RenderParams = {
  maxIter: 320,
  autoIter: true,
  mode: 'mandelbrot',
  juliaX: -0.8,
  juliaY: 0.156,
  paletteId: 'nebula',
  colorScale: 0.035,
  colorOffset: 0.0,
  cycleSpeed: 0.0,
  aa: 1,
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)

export function recommendedIter(span: number): number {
  // Escape-time depth grows with zoom: seahorse spirals a few e10 deep need
  // several thousand iterations before they resolve, so scale ~400 per decade
  // of magnification. The df64 loop stays comfortably real-time up here.
  const mag = INITIAL_SPAN / span
  return Math.round(clamp(400 + 400 * Math.log10(Math.max(1, mag)), 200, 6000))
}

type EngineActions = {
  reset: () => void
  applyBookmark: (b: Bookmark) => void
  seedJuliaFromCenter: () => void
  setMode: (mode: 'mandelbrot' | 'julia') => void
  zoomAtCenter: (factor: number) => void
  exportPng: () => void
}

export function useFractalEngine() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<FractalRenderer | null>(null)
  const viewportRef = useRef<Viewport>({ ...HOME })
  const phaseRef = useRef(0)
  const rafRef = useRef(0)
  const lastFrameRef = useRef(0)
  const fpsRef = useRef(60)

  const [params, setParams] = useState<RenderParams>(DEFAULT_PARAMS)
  const paramsRef = useRef(params)
  useEffect(() => {
    paramsRef.current = params
  }, [params])

  const [hud, setHud] = useState<HudInfo>({
    re: HOME.centerX,
    im: HOME.centerY,
    span: HOME.span,
    magnification: 1,
    maxIter: DEFAULT_PARAMS.maxIter,
    mode: 'mandelbrot',
    fps: 60,
  })
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  const currentScale = useCallback(() => {
    const canvas = canvasRef.current
    const vp = viewportRef.current
    if (!canvas || canvas.width === 0) return vp.span / 1
    return vp.span / canvas.width
  }, [])

  const buildFrame = useCallback((): FrameState => {
    const vp = viewportRef.current
    const p = paramsRef.current
    const maxIter = p.autoIter ? recommendedIter(vp.span) : p.maxIter
    return {
      centerX: vp.centerX,
      centerY: vp.centerY,
      scale: currentScale(),
      maxIter,
      mode: p.mode,
      juliaX: p.juliaX,
      juliaY: p.juliaY,
      colorScale: p.colorScale,
      colorOffset: p.colorOffset + phaseRef.current,
      aa: p.aa,
      paletteId: p.paletteId,
    }
  }, [currentScale])

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
    setHud({
      re: vp.centerX,
      im: vp.centerY,
      span: vp.span,
      magnification: INITIAL_SPAN / vp.span,
      maxIter: p.autoIter ? recommendedIter(vp.span) : p.maxIter,
      mode: p.mode,
      fps: fpsRef.current,
    })
  }, [])

  // Convert a client-space pointer position into world coordinates plus the
  // pixel offset from the canvas centre (needed to keep a point fixed on zoom).
  const pixelToWorld = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const dprX = canvas.width / rect.width
    const dprY = canvas.height / rect.height
    const fragX = (clientX - rect.left) * dprX
    const fragY = canvas.height - (clientY - rect.top) * dprY
    const scale = currentScale()
    const px = fragX - canvas.width / 2
    const py = fragY - canvas.height / 2
    const vp = viewportRef.current
    return { x: vp.centerX + px * scale, y: vp.centerY + py * scale, px, py }
  }, [currentScale])

  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const { x, y, px, py } = pixelToWorld(clientX, clientY)
      const vp = viewportRef.current
      const minSpan = MIN_SCALE * canvas.width
      const newSpan = clamp(vp.span * factor, minSpan, MAX_SPAN)
      const newScale = newSpan / canvas.width
      vp.centerX = x - px * newScale
      vp.centerY = y - py * newScale
      vp.span = newSpan
      publishHud()
      schedule()
    },
    [pixelToWorld, publishHud, schedule],
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

    const dpr = () => Math.min(window.devicePixelRatio || 1, 2)
    const resize = () => {
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr()))
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr()))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        renderer.resize(w, h)
      }
      publishHud()
      renderNow()
    }
    // Defer the first render + ready flag out of the effect body (so state
    // updates happen in a frame callback, not synchronously during commit).
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

    let dragging = false
    let lastX = 0
    let lastY = 0
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      if (e.shiftKey && paramsRef.current.mode === 'mandelbrot') {
        const { x, y } = pixelToWorld(e.clientX, e.clientY)
        viewportRef.current = { ...JULIA_HOME }
        setParams((p) => ({ ...p, mode: 'julia', juliaX: x, juliaY: y }))
        publishHud()
        return
      }
      dragging = true
      lastX = e.clientX
      lastY = e.clientY
      canvas.setPointerCapture(e.pointerId)
      canvas.style.cursor = 'grabbing'
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return
      const scale = currentScale()
      const dprX = canvas.width / canvas.clientWidth
      const dprY = canvas.height / canvas.clientHeight
      const vp = viewportRef.current
      vp.centerX -= (e.clientX - lastX) * dprX * scale
      vp.centerY += (e.clientY - lastY) * dprY * scale
      lastX = e.clientX
      lastY = e.clientY
      publishHud()
      schedule()
    }
    const onPointerUp = (e: PointerEvent) => {
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
      ro.disconnect()
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('dblclick', onDoubleClick)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rendererRef.current = null
      renderer.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-render whenever a non-camera parameter changes. The HUD/render updates
  // run in a frame callback rather than synchronously in the effect body.
  useEffect(() => {
    if (!ready) return
    const id = requestAnimationFrame(() => {
      publishHud()
      renderNow()
    })
    return () => cancelAnimationFrame(id)
  }, [params, ready, publishHud, renderNow])

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
    viewportRef.current =
      paramsRef.current.mode === 'julia' ? { ...JULIA_HOME } : { ...HOME }
    phaseRef.current = 0
    publishHud()
    schedule()
  }, [publishHud, schedule])

  const applyBookmark = useCallback(
    (b: Bookmark) => {
      viewportRef.current = { centerX: b.centerX, centerY: b.centerY, span: b.span }
      phaseRef.current = 0
      setParams((p) => ({
        ...p,
        mode: b.mode,
        juliaX: b.juliaX ?? p.juliaX,
        juliaY: b.juliaY ?? p.juliaY,
        paletteId: b.paletteId ?? p.paletteId,
      }))
      publishHud()
      schedule()
    },
    [publishHud, schedule],
  )

  const seedJuliaFromCenter = useCallback(() => {
    const vp = viewportRef.current
    const cx = vp.centerX
    const cy = vp.centerY
    viewportRef.current = { ...JULIA_HOME }
    setParams((p) => ({ ...p, mode: 'julia', juliaX: cx, juliaY: cy }))
    publishHud()
    schedule()
  }, [publishHud, schedule])

  const setMode = useCallback(
    (mode: 'mandelbrot' | 'julia') => {
      viewportRef.current = mode === 'julia' ? { ...JULIA_HOME } : { ...HOME }
      phaseRef.current = 0
      setParams((p) => ({ ...p, mode }))
      publishHud()
      schedule()
    },
    [publishHud, schedule],
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

  const actions: EngineActions = useMemo(
    () => ({ reset, applyBookmark, seedJuliaFromCenter, setMode, zoomAtCenter, exportPng }),
    [reset, applyBookmark, seedJuliaFromCenter, setMode, zoomAtCenter, exportPng],
  )

  const setParam = useCallback(<K extends keyof RenderParams>(key: K, value: RenderParams[K]) => {
    setParams((p) => ({ ...p, [key]: value }))
  }, [])

  return { canvasRef, params, setParam, hud, error, ready, actions }
}
