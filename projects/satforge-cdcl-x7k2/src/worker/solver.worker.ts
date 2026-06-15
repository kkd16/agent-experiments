/// <reference lib="webworker" />
// Runs the CDCL solver off the main thread so the UI stays responsive on hard
// instances. Falls back to a synchronous solve in useSolver if workers are
// unavailable (e.g. the sandboxed catalog thumbnail).
import { solve } from '../sat'
import type { CNF, SolverOptions, SolveResult } from '../sat'

export interface SolveRequest {
  cnf: CNF
  opts: SolverOptions
}
export type SolveResponse = { ok: true; result: SolveResult } | { ok: false; error: string }

self.onmessage = (ev: MessageEvent<SolveRequest>) => {
  try {
    const { cnf, opts } = ev.data
    const result = solve(cnf, opts)
    const msg: SolveResponse = { ok: true, result }
    ;(self as DedicatedWorkerGlobalScope).postMessage(msg)
  } catch (e) {
    const msg: SolveResponse = { ok: false, error: e instanceof Error ? e.message : String(e) }
    ;(self as DedicatedWorkerGlobalScope).postMessage(msg)
  }
}
