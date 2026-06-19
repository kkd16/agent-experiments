// React glue: owns the renderer, runs the requestAnimationFrame loop, wires up
// pointer/scroll input to the orbit camera and a ResizeObserver to the internal
// framebuffer resolution. Settings are read through refs so changing a control
// never tears down the animation loop.
import { useEffect, useRef, useState } from 'react'
import { Renderer } from './renderer.ts'
import type { RenderSettings } from './renderer.ts'
import { PRESETS } from '../scene/scene.ts'

export interface EngineStats {
  fps: number
  ms: number
  trianglesIn: number
  trianglesDrawn: number
  pixelsFilled: number
  width: number
  height: number
}

const INITIAL: EngineStats = {
  fps: 0, ms: 0, trianglesIn: 0, trianglesDrawn: 0, pixelsFilled: 0, width: 0, height: 0,
}

export function useEngine(
  settings: RenderSettings,
  presetKey: string,
  resolutionScale: number,
): {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  stats: EngineStats
  resetCamera: () => void
} {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const rendererRef = useRef<Renderer | null>(null)
  const settingsRef = useRef(settings)
  const scaleRef = useRef(resolutionScale)
  const [stats, setStats] = useState<EngineStats>(INITIAL)

  // keep the loop's view of the controls current without restarting it
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])
  useEffect(() => {
    scaleRef.current = resolutionScale
  }, [resolutionScale])

  useEffect(() => {
    rendererRef.current?.setScene(PRESETS[presetKey]())
  }, [presetKey])

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    // Desired backing-store size from the container's CSS size × the quality
    // scale (>1 supersamples, <1 upsamples), clamped so the buffer stays sane.
    const desiredSize = (): [number, number] => [
      Math.min(1920, Math.max(64, Math.floor(container.clientWidth * scaleRef.current))),
      Math.min(1200, Math.max(64, Math.floor(container.clientHeight * scaleRef.current))),
    ]

    const [initW, initH] = desiredSize()
    const renderer = new Renderer(initW, initH, PRESETS.showcase())
    rendererRef.current = renderer
    canvas.width = initW
    canvas.height = initH

    // Reconcile framebuffer + canvas backing size each frame — this covers both
    // container resizes and quality-slider changes with no extra listeners.
    const syncSize = (): void => {
      const [w, h] = desiredSize()
      if (w !== renderer.fb.width || h !== renderer.fb.height) {
        renderer.resize(w, h)
        canvas.width = w
        canvas.height = h
      }
    }

    // ── input ──────────────────────────────────────────────────────────────
    let dragging = false
    let lastX = 0
    let lastY = 0
    const onDown = (e: PointerEvent): void => {
      dragging = true
      lastX = e.clientX
      lastY = e.clientY
      canvas.setPointerCapture(e.pointerId)
    }
    const onMove = (e: PointerEvent): void => {
      if (!dragging) return
      const dx = e.clientX - lastX
      const dy = e.clientY - lastY
      lastX = e.clientX
      lastY = e.clientY
      renderer.camera.rotate(dx * 0.006, dy * 0.006)
    }
    const onUp = (e: PointerEvent): void => {
      dragging = false
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
    }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      renderer.camera.zoom(Math.exp(e.deltaY * 0.0012))
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    // ── loop ───────────────────────────────────────────────────────────────
    let raf = 0
    let prev = performance.now()
    let fpsAccum = 0
    let fpsCount = 0
    let lastReport = prev
    let frameMs = 0

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame)
      let dt = (now - prev) / 1000
      prev = now
      if (dt > 0.1) dt = 0.1 // clamp after tab switches

      syncSize()
      const t0 = performance.now()
      const s = renderer.render(dt, settingsRef.current)
      renderer.present(ctx)
      frameMs = performance.now() - t0

      fpsAccum += dt
      fpsCount++
      if (now - lastReport > 250) {
        setStats({
          fps: fpsCount / fpsAccum,
          ms: frameMs,
          trianglesIn: s.trianglesIn,
          trianglesDrawn: s.trianglesDrawn,
          pixelsFilled: s.pixelsFilled,
          width: renderer.fb.width,
          height: renderer.fb.height,
        })
        fpsAccum = 0
        fpsCount = 0
        lastReport = now
      }
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [])

  const resetCamera = (): void => {
    rendererRef.current?.camera.reset()
  }

  return { canvasRef, containerRef, stats, resetCamera }
}
