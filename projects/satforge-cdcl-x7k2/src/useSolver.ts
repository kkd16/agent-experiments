import { useCallback, useEffect, useRef, useState } from 'react'
import { solve } from './sat'
import type { CNF, SolverOptions, SolveResult } from './sat'
import type { SolveRequest, SolveResponse } from './worker/solver.worker'

export type SolveState =
  | { phase: 'idle' }
  | { phase: 'solving' }
  | { phase: 'done'; result: SolveResult; elapsed: number }
  | { phase: 'error'; message: string }

/**
 * Drives the solver, preferring a Web Worker so the UI never freezes. If a
 * worker can't be created (older browser, sandboxed iframe), it falls back to a
 * synchronous solve on the main thread.
 */
export function useSolver() {
  const [state, setState] = useState<SolveState>({ phase: 'idle' })
  const workerRef = useRef<Worker | null>(null)
  const startRef = useRef(0)

  // Lazily create the worker; tolerate environments where it throws.
  const getWorker = useCallback((): Worker | null => {
    if (workerRef.current) return workerRef.current
    try {
      const w = new Worker(new URL('./worker/solver.worker.ts', import.meta.url), { type: 'module' })
      workerRef.current = w
      return w
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    return () => {
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [])

  const run = useCallback(
    (cnf: CNF, opts: SolverOptions) => {
      startRef.current = performance.now()
      setState({ phase: 'solving' })
      const worker = getWorker()
      if (worker) {
        worker.onmessage = (ev: MessageEvent<SolveResponse>) => {
          const elapsed = performance.now() - startRef.current
          if (ev.data.ok) setState({ phase: 'done', result: ev.data.result, elapsed })
          else setState({ phase: 'error', message: ev.data.error })
        }
        worker.onerror = (e) => setState({ phase: 'error', message: e.message || 'worker error' })
        const req: SolveRequest = { cnf, opts }
        worker.postMessage(req)
      } else {
        // Synchronous fallback — defer a tick so the "solving" state paints.
        setTimeout(() => {
          try {
            const result = solve(cnf, opts)
            setState({ phase: 'done', result, elapsed: performance.now() - startRef.current })
          } catch (e) {
            setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
          }
        }, 10)
      }
    },
    [getWorker],
  )

  const reset = useCallback(() => setState({ phase: 'idle' }), [])

  return { state, run, reset }
}
