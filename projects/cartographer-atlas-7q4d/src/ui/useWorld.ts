// Orchestrates world generation for the UI. Generation is synchronous but can take
// tens of milliseconds, so any parameter change flips a `generating` flag (in the
// setter, not the effect) and the work is deferred one tick to let the spinner
// paint. Stale requests are ignored so rapid slider drags never paint an
// out-of-date world.

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

  useEffect(() => {
    const id = ++reqRef.current
    const t = setTimeout(() => {
      try {
        const w = generateWorld(params)
        if (reqRef.current === id) {
          setWorld(w)
          setGenerating(false)
        }
      } catch (err) {
        // Never let a bad parameter combination wedge the studio.
        console.error('world generation failed', err)
        if (reqRef.current === id) setGenerating(false)
      }
    }, 16)
    return () => clearTimeout(t)
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
