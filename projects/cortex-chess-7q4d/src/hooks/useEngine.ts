// Manages the search worker. Falls back to a synchronous main-thread search when
// Web Workers are unavailable (e.g. the sandboxed catalog thumbnail), so the app
// still works everywhere — just without live streaming in the fallback path.

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { parseFen, type SearchInfo } from '../engine'
import { Searcher } from '../engine'
import type { WorkerOut, SearchRequest } from '../engine/engine.worker'

export interface ThinkParams {
  fen: string
  history: bigint[]
  maxDepth: number
  maxTime: number
}

export interface EngineHandle {
  think: (params: ThinkParams, onInfo: (info: SearchInfo) => void) => Promise<SearchInfo>
  cancel: () => void
}

export function useEngine(): EngineHandle {
  const workerRef = useRef<Worker | null>(null)
  const fallbackRef = useRef<Searcher | null>(null)
  const resolveRef = useRef<((info: SearchInfo) => void) | null>(null)
  const infoRef = useRef<((info: SearchInfo) => void) | null>(null)

  // Try to create a worker once. If it throws (sandbox), we use the fallback.
  const ensureWorker = useCallback((): Worker | null => {
    if (workerRef.current) return workerRef.current
    try {
      const worker = new Worker(new URL('../engine/engine.worker.ts', import.meta.url), {
        type: 'module',
      })
      worker.onmessage = (e: MessageEvent<WorkerOut>) => {
        const msg = e.data
        if (msg.type === 'info') infoRef.current?.(msg.info)
        else if (msg.type === 'result') {
          const resolve = resolveRef.current
          resolveRef.current = null
          infoRef.current = null
          resolve?.(msg.info)
        }
      }
      worker.onerror = () => {
        // If the worker dies, drop it; the next think() uses the fallback.
        workerRef.current?.terminate()
        workerRef.current = null
      }
      workerRef.current = worker
      return worker
    } catch {
      return null
    }
  }, [])

  const think = useCallback(
    (params: ThinkParams, onInfo: (info: SearchInfo) => void): Promise<SearchInfo> => {
      const worker = ensureWorker()
      if (worker) {
        infoRef.current = onInfo
        return new Promise<SearchInfo>((resolve) => {
          resolveRef.current = resolve
          const req: SearchRequest = {
            type: 'search',
            fen: params.fen,
            history: params.history,
            maxDepth: params.maxDepth,
            maxTime: params.maxTime,
          }
          worker.postMessage(req)
        })
      }

      // Synchronous fallback. Runs on the UI thread, so info callbacks fire but
      // the page is blocked during the search; we keep the time budget small.
      if (!fallbackRef.current) fallbackRef.current = new Searcher()
      const pos = parseFen(params.fen)
      const result = fallbackRef.current.search(
        pos,
        { maxDepth: params.maxDepth, maxTime: params.maxTime, history: params.history },
        onInfo,
      )
      return Promise.resolve(result)
    },
    [ensureWorker],
  )

  // Cancelling means killing the worker mid-search (the search loop is otherwise
  // uninterruptible). A fresh worker is created lazily on the next think().
  const cancel = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate()
      workerRef.current = null
    }
    resolveRef.current = null
    infoRef.current = null
  }, [])

  useEffect(() => {
    return () => {
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [])

  return useMemo(() => ({ think, cancel }), [think, cancel])
}
