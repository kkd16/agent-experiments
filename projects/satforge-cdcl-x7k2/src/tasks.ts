// One-shot, off-thread analysis tasks (model counting and MUS extraction). Each call
// spins up a throwaway worker, awaits a single reply, and terminates it — so these
// never race with the persistent solve worker in useSolver. If workers are unavailable
// (older browsers, the sandboxed catalog thumbnail), we fall back to a synchronous run.
import { countModels, findMus, solveMaxSat } from './sat'
import type { MusResult, MaxSatInstance, MaxSatResult, MaxSatOptions } from './sat'
import type { WorkerRequest, WorkerResponse } from './worker/solver.worker'
import type { CNF } from './sat'

export interface CountTaskResult {
  count: bigint | null
  exact: boolean
  nodes: number
  cacheHits: number
  cacheSize: number
  timeMs: number
}

function makeWorker(): Worker | null {
  try {
    return new Worker(new URL('./worker/solver.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return null
  }
}

function runOnWorker<T>(req: WorkerRequest, parse: (r: WorkerResponse) => T): Promise<T> | null {
  const worker = makeWorker()
  if (!worker) return null
  return new Promise<T>((resolve, reject) => {
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      worker.terminate()
      const r = ev.data
      if (!r.ok) reject(new Error(r.error))
      else resolve(parse(r))
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message || 'worker error'))
    }
    worker.postMessage(req)
  })
}

export async function countModelsTask(cnf: CNF, budget = 400000): Promise<CountTaskResult> {
  const onWorker = runOnWorker<CountTaskResult>({ op: 'count', cnf, budget }, (r) => {
    if (r.op !== 'count' || !r.ok) throw new Error('unexpected response')
    const p = r.payload
    return {
      count: p.count === null ? null : BigInt(p.count),
      exact: p.exact,
      nodes: p.nodes,
      cacheHits: p.cacheHits,
      cacheSize: p.cacheSize,
      timeMs: p.timeMs,
    }
  })
  if (onWorker) {
    try {
      return await onWorker
    } catch {
      /* fall through to synchronous */
    }
  }
  const r = countModels(cnf, { budget })
  return { count: r.count, exact: r.exact, nodes: r.nodes, cacheHits: r.cacheHits, cacheSize: r.cacheSize, timeMs: r.timeMs }
}

export async function solveMaxSatTask(instance: MaxSatInstance, opts: MaxSatOptions): Promise<MaxSatResult> {
  const onWorker = runOnWorker<MaxSatResult>({ op: 'maxsat', instance, opts }, (r) => {
    if (r.op !== 'maxsat' || !r.ok) throw new Error('unexpected response')
    return r.result
  })
  if (onWorker) {
    try {
      return await onWorker
    } catch {
      /* fall through to synchronous */
    }
  }
  return solveMaxSat(instance, opts)
}

export async function findMusTask(cnf: CNF, budget = 300000, seed?: number[]): Promise<MusResult> {
  const onWorker = runOnWorker<MusResult>({ op: 'mus', cnf, budget, seed }, (r) => {
    if (r.op !== 'mus' || !r.ok) throw new Error('unexpected response')
    return r.result
  })
  if (onWorker) {
    try {
      return await onWorker
    } catch {
      /* fall through to synchronous */
    }
  }
  return findMus(cnf, { budget, seed })
}
