// An exhaustive integer oracle used to certify the Omega test. It enumerates
// every point of a finite box and tests the raw constraints — no shared code
// with the decision procedure, so agreement is real evidence. When the system
// itself bounds every variable into the box, the box IS the whole feasible
// region and this oracle is a *complete* check of both SAT and UNSAT verdicts.

import { evalLin } from './lin'
import type { Cons } from './omega'

export interface BruteResult {
  sat: boolean
  model?: Map<number, bigint>
}

export function bruteForce(constraints: Cons[], numVars: number, lo: bigint, hi: bigint): BruteResult {
  const assign = new Array<bigint>(numVars).fill(lo)
  const model = new Map<number, bigint>()
  const span = hi - lo + 1n
  if (span <= 0n) return { sat: false }
  // Total points = span^numVars; callers keep this tiny.
  let total = 1n
  for (let k = 0; k < numVars; k++) total *= span
  for (let idx = 0n; idx < total; idx++) {
    let rem = idx
    for (let k = 0; k < numVars; k++) {
      const d = rem % span
      assign[k] = lo + d
      rem /= span
    }
    model.clear()
    for (let k = 0; k < numVars; k++) model.set(k, assign[k])
    let ok = true
    for (const c of constraints) {
      const v = evalLin(c.lin, model)
      if (c.op === 'eq' ? v !== 0n : v < 0n) {
        ok = false
        break
      }
    }
    if (ok) return { sat: true, model: new Map(model) }
  }
  return { sat: false }
}
