// Orchestrates world generation for the UI. Heavy generation runs in a Web Worker so
// the studio stays interactive during slider drags; a synchronous fallback covers
// environments without workers (sandboxed thumbnails) and a watchdog guarantees a
// world even if a worker is silently blocked. Stale requests are ignored so rapid
// parameter changes never paint an out-of-date map.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorldMap, WorldParams } from '../core/types'
import { generateWorld } from '../core/generate'

export interface UseWorld {
  params: WorldParams
  setParams: (p: WorldParams) => void
  patch: (partial: Partial<WorldParams>) => void
  world: WorldMap | null
  generating: boolean
}

export function useWorld(initial: WorldParams): UseWorld {
  const [params, setParamsRaw] = useState<WorldParams>(initial)
  const [world, setWorld] = useState<WorldMap | null>(null)
  const [generating, setGenerating] = useState(true)
  const reqRef = useRef(0)
  const resolvedRef = useRef(-1)
  const workerRef = useRef<Worker | null>(null)
  const workerOk = useRef(true)

  // --- Spin up the worker once (best-effort) ---
  useEffect(() => {
    try {
      const w = new Worker(new URL('../core/worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = (e: MessageEvent<{ id: number; world?: WorldMap; error?: string }>) => {
        if (e.data.id !== reqRef.current) return
        if (e.data.world) setWorld(e.data.world)
        else if (e.data.error) console.error('worker generation failed', e.data.error)
        resolvedRef.current = e.data.id
        setGenerating(false)
      }
      w.onerror = () => {
        workerOk.current = false
      }
      workerRef.current = w
    } catch {
      workerOk.current = false
    }
    return () => {
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [])

  useEffect(() => {
    const id = ++reqRef.current

    const runSync = (): void => {
      try {
        const w = generateWorld(params)
        if (reqRef.current === id) {
          setWorld(w)
          resolvedRef.current = id
          setGenerating(false)
        }
      } catch (err) {
        console.error('world generation failed', err)
        resolvedRef.current = id
        if (reqRef.current === id) setGenerating(false)
      }
    }

    // Small debounce so a slider drag coalesces into one generation.
    const t = setTimeout(() => {
      const w = workerRef.current
      if (w && workerOk.current) {
        w.postMessage({ id, params })
      } else {
        runSync()
      }
    }, 60)

    // Watchdog: if a worker never answers (blocked/sandboxed), fall back to sync.
    const watchdog = setTimeout(() => {
      if (reqRef.current === id && resolvedRef.current !== id) {
        workerOk.current = false
        runSync()
      }
    }, 2500)

    return () => {
      clearTimeout(t)
      clearTimeout(watchdog)
    }
  }, [params])

  const setParams = useCallback((p: WorldParams): void => {
    setGenerating(true)
    setParamsRaw(p)
  }, [])

  const patch = useCallback((partial: Partial<WorldParams>): void => {
    setGenerating(true)
    setParamsRaw((prev) => ({ ...prev, ...partial }))
  }, [])

  return { params, setParams, patch, world, generating }
}
