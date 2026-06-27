// Manages a search worker. Falls back to a synchronous main-thread search when
// Web Workers are unavailable (e.g. the sandboxed catalog thumbnail), so the app
// still works everywhere — just without live streaming in the fallback path.
//
// One worker handles one request at a time (search / analyze / evals). When the
// Analyze board needs live analysis *and* a background eval sweep at once, the
// component simply mounts two independent useEngine() instances.

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { parseFen, generateLegal, inCheck, MATE, type SearchInfo, type MultiInfo } from '../engine'
import { Searcher, deserializeNnue, quantize, type NnueBlob } from '../engine'
import { mctsSearch as mctsSearchSync, type MctsOptions, type MctsResult } from '../engine'
import { verifyKbnk as verifyKbnkSync, type KbnkVerification } from '../engine/kbnk'
import { verifyGtb as verifyGtbSync, type GtbVerification } from '../engine/gtb'
import { verifyWdl as verifyWdlSync, type WdlVerification } from '../engine/wdltb'
import { verifyPawnTb as verifyPawnTbSync, type PawnTbVerification } from '../engine/pawntb'
import type { NodeAnalysis } from '../engine/review'
import type { WorkerOut, WorkerRequest } from '../engine/engine.worker'

export interface ThinkParams {
  fen: string
  history: bigint[]
  maxDepth: number
  maxTime: number
  softTime?: number
  maxNodes?: number
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
  verifyGtb: (
    opts: { id: string; sample: number; games: number },
    onProgress: (frac: number, phase: string) => void,
  ) => Promise<GtbVerification>
  verifyWdl: (
    opts: { id: string; sample: number; games: number },
    onProgress: (frac: number, phase: string) => void,
  ) => Promise<WdlVerification>
  verifyPawnTb: (
    opts: { sample: number; games: number },
    onProgress: (frac: number, phase: string) => void,
  ) => Promise<PawnTbVerification>
  // Analyse every node of a game (top-2 lines per position) for the review model.
  reviewGame: (
    items: EvalItem[],
    opts: { maxDepth: number; maxTime: number },
    onProgress: (done: number, total: number) => void,
  ) => Promise<NodeAnalysis[]>
  // Install (blob) or remove (null) the NNUE evaluation for subsequent searches.
  // Pass `useQuant` to run the net quantized (int16/int8) in play.
  setNnue: (blob: NnueBlob | null, useQuant?: boolean) => void
  // Run an AlphaZero-style PUCT Monte-Carlo Tree Search; streams visit snapshots.
  mcts: (
    fen: string,
    opt: MctsOptions,
    onProgress: (result: MctsResult) => void,
  ) => Promise<MctsResult>
  cancel: () => void
}

export function useEngine(): EngineHandle {
  const workerRef = useRef<Worker | null>(null)
  const fallbackRef = useRef<Searcher | null>(null)
  // A single in-flight operation per worker: one resolver + one progress sink.
  const resolveRef = useRef<((value: never) => void) | null>(null)
  const infoRef = useRef<((arg: never) => void) | null>(null)
  // The currently-installed NNUE (if any), reapplied whenever a worker is created.
  const nnueRef = useRef<NnueBlob | null>(null)
  // Whether the installed NNUE should run quantized (int16/int8) in play.
  const nnueQuantRef = useRef<boolean>(false)

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
          case 'gtbprogress':
          case 'wdlprogress':
          case 'pawntbprogress':
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
          case 'kbnkdone':
          case 'gtbdone':
          case 'wdldone':
          case 'pawntbdone': {
            const resolve = resolveRef.current as ((v: unknown) => void) | null
            resolveRef.current = null
            infoRef.current = null
            resolve?.(msg.report)
            break
          }
          case 'reviewprogress':
            ;(infoRef.current as ((a: unknown) => void) | null)?.(msg)
            break
          case 'mctsprogress':
            ;(infoRef.current as ((a: unknown) => void) | null)?.(msg.result)
            break
          case 'mctsdone': {
            const resolve = resolveRef.current as ((v: unknown) => void) | null
            resolveRef.current = null
            infoRef.current = null
            resolve?.(msg.result)
            break
          }
          case 'reviewdone': {
            const resolve = resolveRef.current as ((v: unknown) => void) | null
            resolveRef.current = null
            infoRef.current = null
            resolve?.(msg.nodes)
            break
          }
        }
      }
      worker.onerror = () => {
        workerRef.current?.terminate()
        workerRef.current = null
      }
      workerRef.current = worker
      // Reapply any installed NNUE to the freshly-created worker.
      if (nnueRef.current)
        worker.postMessage({ type: 'setnnue', blob: nnueRef.current, quantize: nnueQuantRef.current })
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

  const reviewGame = useCallback(
    (
      items: EvalItem[],
      opts: { maxDepth: number; maxTime: number },
      onProgress: (done: number, total: number) => void,
    ): Promise<NodeAnalysis[]> =>
      post(
        { type: 'review', items, ...opts },
        ((m: { done: number; total: number }) => onProgress(m.done, m.total)) as (a: never) => void,
        () => {
          if (!fallbackRef.current) fallbackRef.current = new Searcher()
          const s = fallbackRef.current
          const out: NodeAnalysis[] = []
          for (let i = 0; i < items.length; i++) {
            const pos = parseFen(items[i].fen)
            if (generateLegal(pos).length === 0) {
              const mated = inCheck(pos, pos.turn)
              out.push({ score: mated ? -MATE : 0, mate: mated ? -1 : null, bestPv: [], secondScore: null, secondMate: null })
            } else {
              const r = s.searchMultiPv(pos, { ...opts, history: items[i].history }, 2)
              const l0 = r.lines[0]
              const l1 = r.lines[1]
              out.push({
                score: l0?.score ?? 0,
                mate: l0?.mate ?? null,
                bestPv: l0?.pv ?? [],
                secondScore: l1?.score ?? null,
                secondMate: l1?.mate ?? null,
              })
            }
            onProgress(i + 1, items.length)
          }
          return out
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

  const verifyGtb = useCallback(
    (
      opts: { id: string; sample: number; games: number },
      onProgress: (frac: number, phase: string) => void,
    ): Promise<GtbVerification> =>
      post(
        { type: 'gtb', ...opts },
        ((m: { frac: number; phase: string }) => onProgress(m.frac, m.phase)) as (a: never) => void,
        () => verifyGtbSync(opts.id, { sample: opts.sample, games: opts.games }, onProgress),
      ),
    [post],
  )

  const verifyWdl = useCallback(
    (
      opts: { id: string; sample: number; games: number },
      onProgress: (frac: number, phase: string) => void,
    ): Promise<WdlVerification> =>
      post(
        { type: 'wdl', ...opts },
        ((m: { frac: number; phase: string }) => onProgress(m.frac, m.phase)) as (a: never) => void,
        () => verifyWdlSync(opts.id, { sample: opts.sample, games: opts.games }, onProgress),
      ),
    [post],
  )

  const verifyPawnTb = useCallback(
    (
      opts: { sample: number; games: number },
      onProgress: (frac: number, phase: string) => void,
    ): Promise<PawnTbVerification> =>
      post(
        { type: 'pawntb', ...opts },
        ((m: { frac: number; phase: string }) => onProgress(m.frac, m.phase)) as (a: never) => void,
        () => verifyPawnTbSync({ sample: opts.sample, games: opts.games }, onProgress),
      ),
    [post],
  )

  const mcts = useCallback(
    (fen: string, opt: MctsOptions, onProgress: (result: MctsResult) => void): Promise<MctsResult> =>
      post(
        { type: 'mcts', fen, opt },
        onProgress as (a: never) => void,
        () => {
          // Main-thread fallback (sandboxed thumbnail): run synchronously. Use the
          // installed float net when the MCTS value source asks for it.
          const weights = opt.evalSource === 'nnue' && nnueRef.current ? deserializeNnue(nnueRef.current) : null
          return mctsSearchSync(fen, opt, weights, onProgress)
        },
      ),
    [post],
  )

  const setNnue = useCallback(
    (blob: NnueBlob | null, useQuant = false) => {
      nnueRef.current = blob
      nnueQuantRef.current = useQuant
      const worker = ensureWorker()
      if (worker) worker.postMessage({ type: 'setnnue', blob, quantize: useQuant })
      // Keep the synchronous fallback in sync too.
      if (!fallbackRef.current) fallbackRef.current = new Searcher()
      if (blob && useQuant) fallbackRef.current.setQuantEvaluator(quantize(deserializeNnue(blob)))
      else fallbackRef.current.setEvaluator(blob ? deserializeNnue(blob) : null)
    },
    [ensureWorker],
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
    () => ({ think, analyze, evalGame, reviewGame, verifyKbnk, verifyGtb, verifyWdl, verifyPawnTb, mcts, setNnue, cancel }),
    [think, analyze, evalGame, reviewGame, verifyKbnk, verifyGtb, verifyWdl, verifyPawnTb, mcts, setNnue, cancel],
  )
}
