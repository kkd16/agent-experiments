// Manages a search worker. Falls back to a synchronous main-thread search when
// Web Workers are unavailable (e.g. the sandboxed catalog thumbnail), so the app
// still works everywhere — just without live streaming in the fallback path.
//
// One worker handles one request at a time (search / analyze / evals). When the
// Analyze board needs live analysis *and* a background eval sweep at once, the
// component simply mounts two independent useEngine() instances.

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { parseFen, type SearchInfo, type MultiInfo } from '../engine'
import { Searcher } from '../engine'
import { verifyKbnk as verifyKbnkSync, type KbnkVerification } from '../engine/kbnk'
import type { WorkerOut, WorkerRequest } from '../engine/engine.worker'

export interface ThinkParams {
  fen: string
  history: bigint[]
  maxDepth: number
  maxTime: number
}

export interface EvalItem {
  fen: string
  history: bigint[]
}

export interface EngineHandle {
  think: (params: ThinkParams, onInfo: (info: SearchInfo) => void) => Promise<SearchInfo>
  analyze: (
    params: ThinkParams,
    multiPv: number,
    onInfo: (info: MultiInfo) => void,
  ) => Promise<MultiInfo>
  evalGame: (
    items: EvalItem[],
    opts: { maxDepth: number; maxTime: number },
    onProgress: (ply: number, score: number, done: number, total: number) => void,
  ) => Promise<number[]>
  verifyKbnk: (
    opts: { sample: number; games: number },
    onProgress: (frac: number, phase: string) => void,
  ) => Promise<KbnkVerification>
  cancel: () => void
}

export function useEngine(): EngineHandle {
  const workerRef = useRef<Worker | null>(null)
  const fallbackRef = useRef<Searcher | null>(null)
  // A single in-flight operation per worker: one resolver + one progress sink.
  const resolveRef = useRef<((value: never) => void) | null>(null)
  const infoRef = useRef<((arg: never) => void) | null>(null)

  const ensureWorker = useCallback((): Worker | null => {
    if (workerRef.current) return workerRef.current
    try {
      const worker = new Worker(new URL('../engine/engine.worker.ts', import.meta.url), {
        type: 'module',
      })
      worker.onmessage = (e: MessageEvent<WorkerOut>) => {
        const msg = e.data
        switch (msg.type) {
          case 'info':
          case 'multiinfo':
            ;(infoRef.current as ((a: unknown) => void) | null)?.(msg.info)
            break
          case 'evalprogress':
          case 'kbnkprogress':
            ;(infoRef.current as ((a: unknown) => void) | null)?.(msg)
            break
          case 'result':
          case 'multiresult': {
            const resolve = resolveRef.current as ((v: unknown) => void) | null
            resolveRef.current = null
            infoRef.current = null
            resolve?.(msg.info)
            break
          }
          case 'evaldone': {
            const resolve = resolveRef.current as ((v: unknown) => void) | null
            resolveRef.current = null
            infoRef.current = null
            resolve?.(msg.scores)
            break
          }
          case 'kbnkdone': {
            const resolve = resolveRef.current as ((v: unknown) => void) | null
            resolveRef.current = null
            infoRef.current = null
            resolve?.(msg.report)
            break
          }
        }
      }
      worker.onerror = () => {
        workerRef.current?.terminate()
        workerRef.current = null
      }
      workerRef.current = worker
      return worker
    } catch {
      return null
    }
  }, [])

  const post = useCallback(
    <T>(req: WorkerRequest, onInfo: ((arg: never) => void) | null, sync: () => T): Promise<T> => {
      const worker = ensureWorker()
      if (worker) {
        infoRef.current = onInfo
        return new Promise<T>((resolve) => {
          resolveRef.current = resolve as (value: never) => void
          worker.postMessage(req)
        })
      }
      return Promise.resolve(sync())
    },
    [ensureWorker],
  )

  const think = useCallback(
    (params: ThinkParams, onInfo: (info: SearchInfo) => void): Promise<SearchInfo> =>
      post(
        { type: 'search', ...params },
        onInfo as (a: never) => void,
        () => {
          if (!fallbackRef.current) fallbackRef.current = new Searcher()
          return fallbackRef.current.search(parseFen(params.fen), params, onInfo)
        },
      ),
    [post],
  )

  const analyze = useCallback(
    (params: ThinkParams, multiPv: number, onInfo: (info: MultiInfo) => void): Promise<MultiInfo> =>
      post(
        { type: 'analyze', ...params, multiPv },
        onInfo as (a: never) => void,
        () => {
          if (!fallbackRef.current) fallbackRef.current = new Searcher()
          return fallbackRef.current.searchMultiPv(parseFen(params.fen), params, multiPv, onInfo)
        },
      ),
    [post],
  )

  const evalGame = useCallback(
    (
      items: EvalItem[],
      opts: { maxDepth: number; maxTime: number },
      onProgress: (ply: number, score: number, done: number, total: number) => void,
    ): Promise<number[]> =>
      post(
        { type: 'evals', items, ...opts },
        ((m: { ply: number; score: number; done: number; total: number }) =>
          onProgress(m.ply, m.score, m.done, m.total)) as (a: never) => void,
        () => {
          if (!fallbackRef.current) fallbackRef.current = new Searcher()
          const scores: number[] = []
          for (let i = 0; i < items.length; i++) {
            const r = fallbackRef.current.search(parseFen(items[i].fen), {
              ...opts,
              history: items[i].history,
            })
            scores.push(r.score)
            onProgress(i, r.score, i + 1, items.length)
          }
          return scores
        },
      ),
    [post],
  )

  const verifyKbnk = useCallback(
    (
      opts: { sample: number; games: number },
      onProgress: (frac: number, phase: string) => void,
    ): Promise<KbnkVerification> =>
      post(
        { type: 'kbnk', ...opts },
        ((m: { frac: number; phase: string }) => onProgress(m.frac, m.phase)) as (a: never) => void,
        () => verifyKbnkSync(opts.sample, opts.games, onProgress),
      ),
    [post],
  )

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

  return useMemo(
    () => ({ think, analyze, evalGame, verifyKbnk, cancel }),
    [think, analyze, evalGame, verifyKbnk, cancel],
  )
}
