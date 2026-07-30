// Binds the imperative WebGL Renderer to a React canvas and the scene state.
// The renderer is created once; scene changes are pushed in via setScene so the
// render loop keeps running uninterrupted.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { Scene } from '../scene/types'
import { Renderer } from '../gl/renderer'

export interface SppState {
  sample: number
  max: number
  accumulating: boolean
}

export interface RendererHandle {
  canvasRef: RefObject<HTMLCanvasElement | null>
  fps: number
  error: string | null
  spp: SppState
  getGlsl: () => string
  capturePng: () => string
}

export function useRenderer(scene: Scene): RendererHandle {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<Renderer | null>(null)
  const [fps, setFps] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [spp, setSpp] = useState<SppState>({ sample: 0, max: 0, accumulating: false })
  // Throttle spp updates so we don't re-render React every accumulation frame.
  const lastSpp = useRef<SppState>({ sample: -1, max: -1, accumulating: false })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let renderer: Renderer
    try {
      renderer = new Renderer(canvas, scene, {
        onFps: (f) => setFps(f),
        onError: (m) => setError(m),
        onSpp: (sample, max, accumulating) => {
          const prev = lastSpp.current
          // Only push updates on the first few samples then every 8th, plus the
          // converged frame — enough to animate the readout without churn.
          const converged = accumulating && sample >= max
          const boundary = sample <= 8 || sample % 8 === 0 || converged
          if (prev.accumulating === accumulating && prev.sample === sample) return
          if (!boundary && accumulating) {
            lastSpp.current = { sample, max, accumulating }
            return
          }
          const next = { sample, max, accumulating }
          lastSpp.current = next
          setSpp(next)
        },
      })
    } catch (e) {
      // Defer out of the effect body so we don't trigger a cascading render.
      const message = e instanceof Error ? e.message : String(e)
      queueMicrotask(() => setError(message))
      return
    }
    rendererRef.current = renderer
    renderer.resize()
    renderer.start()

    const ro = new ResizeObserver(() => renderer.resize())
    ro.observe(canvas)

    return () => {
      ro.disconnect()
      renderer.dispose()
      rendererRef.current = null
    }
    // The renderer intentionally ignores later `scene` identities here — updates
    // flow through the separate effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    rendererRef.current?.setScene(scene)
  }, [scene])

  const getGlsl = useCallback(() => rendererRef.current?.generatedGlsl ?? '', [])
  const capturePng = useCallback(() => rendererRef.current?.captureDataURL() ?? '', [])

  return { canvasRef, fps, error, spp, getGlsl, capturePng }
}
