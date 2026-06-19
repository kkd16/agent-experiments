/// <reference lib="webworker" />
// Runs solving and the heavier analyses (model counting, MUS extraction) off the
// main thread so the UI stays responsive. useSolver / tasks.ts fall back to a
// synchronous run if workers are unavailable (e.g. the sandboxed catalog thumbnail).
import { solve, countModels, findMus, solveMaxSat, compileDdnnf } from '../sat'
import type {
  CNF,
  SolverOptions,
  SolveResult,
  MusResult,
  MaxSatInstance,
  MaxSatResult,
  MaxSatOptions,
  Ddnnf,
  CompileStats,
} from '../sat'

export type WorkerRequest =
  | { op?: 'solve'; cnf: CNF; opts: SolverOptions }
  | { op: 'count'; cnf: CNF; budget: number }
  | { op: 'compile'; cnf: CNF; budget: number }
  | { op: 'mus'; cnf: CNF; budget: number; seed?: number[] }
  | { op: 'maxsat'; instance: MaxSatInstance; opts: MaxSatOptions }

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

export interface CompilePayload {
  ddnnf: Ddnnf | null
  stats: CompileStats
}

export type WorkerResponse =
  | { op: 'solve'; ok: true; result: SolveResult }
  | { op: 'count'; ok: true; payload: CountPayload }
  | { op: 'compile'; ok: true; payload: CompilePayload }
  | { op: 'mus'; ok: true; result: MusResult }
  | { op: 'maxsat'; ok: true; result: MaxSatResult }
  | { op: 'solve' | 'count' | 'compile' | 'mus' | 'maxsat'; ok: false; error: string }

// Legacy response shape consumed by useSolver (which only ever issues 'solve').
export type SolveResponse = { ok: true; result: SolveResult } | { ok: false; error: string }

const post = (msg: WorkerResponse) => (self as DedicatedWorkerGlobalScope).postMessage(msg)

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data
  const op = req.op ?? 'solve'
  try {
    if (op === 'count') {
      const r = countModels((req as { cnf: CNF }).cnf, { budget: (req as { budget: number }).budget })
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
    } else if (op === 'compile') {
      const r = compileDdnnf((req as { cnf: CNF }).cnf, { budget: (req as { budget: number }).budget })
      post({ op: 'compile', ok: true, payload: { ddnnf: r.ddnnf, stats: r.stats } })
    } else if (op === 'mus') {
      const r = req as { cnf: CNF; budget: number; seed?: number[] }
      const result = findMus(r.cnf, { budget: r.budget, seed: r.seed })
      post({ op: 'mus', ok: true, result })
    } else if (op === 'maxsat') {
      const r = req as { instance: MaxSatInstance; opts: MaxSatOptions }
      post({ op: 'maxsat', ok: true, result: solveMaxSat(r.instance, r.opts) })
    } else {
      const sreq = req as { cnf: CNF; opts: SolverOptions }
      const result = solve(sreq.cnf, sreq.opts)
      // Emit the legacy shape so existing useSolver keeps working unchanged.
      ;(self as DedicatedWorkerGlobalScope).postMessage({ ok: true, result } satisfies SolveResponse)
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    if (op === 'solve') (self as DedicatedWorkerGlobalScope).postMessage({ ok: false, error } satisfies SolveResponse)
    else post({ op, ok: false, error })
  }
}
