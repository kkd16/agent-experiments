/// <reference lib="webworker" />
// Runs solving and the heavier analyses (model counting, MUS extraction) off the
// main thread so the UI stays responsive. useSolver / tasks.ts fall back to a
// synchronous run if workers are unavailable (e.g. the sandboxed catalog thumbnail).
import { solve, countModels, findMus } from '../sat'
import type { CNF, SolverOptions, SolveResult, MusResult } from '../sat'

export type WorkerRequest =
  | { op?: 'solve'; cnf: CNF; opts: SolverOptions }
  | { op: 'count'; cnf: CNF; budget: number }
  | { op: 'mus'; cnf: CNF; budget: number; seed?: number[] }

// Back-compat alias: the solve path is the original request shape.
export type SolveRequest = { cnf: CNF; opts: SolverOptions }

export interface CountPayload {
  count: string | null // BigInt serialized as a decimal string
  exact: boolean
  nodes: number
  cacheHits: number
  cacheSize: number
  timeMs: number
}

export type WorkerResponse =
  | { op: 'solve'; ok: true; result: SolveResult }
  | { op: 'count'; ok: true; payload: CountPayload }
  | { op: 'mus'; ok: true; result: MusResult }
  | { op: 'solve' | 'count' | 'mus'; ok: false; error: string }

// Legacy response shape consumed by useSolver (which only ever issues 'solve').
export type SolveResponse = { ok: true; result: SolveResult } | { ok: false; error: string }

const post = (msg: WorkerResponse) => (self as DedicatedWorkerGlobalScope).postMessage(msg)

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data
  const op = req.op ?? 'solve'
  try {
    if (op === 'count') {
      const r = countModels(req.cnf, { budget: (req as { budget: number }).budget })
      post({
        op: 'count',
        ok: true,
        payload: {
          count: r.count === null ? null : r.count.toString(),
          exact: r.exact,
          nodes: r.nodes,
          cacheHits: r.cacheHits,
          cacheSize: r.cacheSize,
          timeMs: r.timeMs,
        },
      })
    } else if (op === 'mus') {
      const r = req as { budget: number; seed?: number[] }
      const result = findMus(req.cnf, { budget: r.budget, seed: r.seed })
      post({ op: 'mus', ok: true, result })
    } else {
      const result = solve(req.cnf, (req as { opts: SolverOptions }).opts)
      // Emit the legacy shape so existing useSolver keeps working unchanged.
      ;(self as DedicatedWorkerGlobalScope).postMessage({ ok: true, result } satisfies SolveResponse)
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    if (op === 'solve') (self as DedicatedWorkerGlobalScope).postMessage({ ok: false, error } satisfies SolveResponse)
    else post({ op, ok: false, error })
  }
}
