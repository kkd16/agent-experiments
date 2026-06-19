/// <reference lib="webworker" />
// Runs the Solver Lab benchmark off the main thread, streaming one progress
// message per (config × instance) cell so the studio's progress bar and live
// results update smoothly. SolverLab falls back to a chunked main-thread run if
// a worker can't be created (older browsers, the sandboxed catalog thumbnail).
import { generateSuite, benchSteps, configById } from '../sat'
import type { BenchConfig, SuiteSpec, BenchBudget, RunResult } from '../sat'

export interface LabRequest {
  configIds: string[]
  suite: SuiteSpec
  budget: BenchBudget
}

export interface InstanceMeta {
  id: string
  family: string
  label: string
  expected?: 'sat' | 'unsat'
}

export type LabResponse =
  | { type: 'meta'; instances: InstanceMeta[]; total: number }
  | { type: 'progress'; result: RunResult; index: number; total: number }
  | { type: 'done' }
  | { type: 'error'; error: string }

const post = (msg: LabResponse) => (self as DedicatedWorkerGlobalScope).postMessage(msg)

self.onmessage = (ev: MessageEvent<LabRequest>) => {
  const req = ev.data
  try {
    const configs = req.configIds
      .map((id) => configById(id))
      .filter((c): c is BenchConfig => !!c)
    const instances = generateSuite(req.suite)
    post({
      type: 'meta',
      instances: instances.map((i) => ({ id: i.id, family: i.family, label: i.label, expected: i.expected })),
      total: configs.length * instances.length,
    })
    for (const step of benchSteps(configs, instances, req.budget)) {
      post({ type: 'progress', result: step.result, index: step.index, total: step.total })
    }
    post({ type: 'done' })
  } catch (e) {
    post({ type: 'error', error: e instanceof Error ? e.message : String(e) })
  }
}
