// Brute-force reference solver — the ground truth the other back-ends are checked against.
//
// It enumerates all 2ⁿ assignments, so it is only used on small instances (n ≲ 22) and in
// the verification harness. Exhaustive, obviously-correct, shares no code with the clever
// solvers: exactly what a soundness oracle should be.

import type { PbInstance } from './instance'
import { feasible, objectiveValue } from './instance'

export interface BruteResult {
  status: 'sat' | 'unsat'
  model?: boolean[] // 1-based
  /** For an optimization instance: the optimal objective value (when status === 'sat'). */
  optimum?: bigint
  /** Number of feasible assignments (a free #SAT count, handy for cross-checks). */
  count: number
}

/** Decide feasibility (and, if the instance has an objective, find the optimum) by enumeration. */
export function bruteForce(inst: PbInstance): BruteResult {
  const n = inst.numVars
  if (n > 24) throw new Error(`bruteForce refuses n=${n} (> 24)`)
  let best: boolean[] | undefined
  let bestVal: bigint | undefined
  let first: boolean[] | undefined
  let count = 0
  const hasObj = (inst.objective?.length ?? 0) > 0 || inst.objConst !== undefined
  const total = 1 << n
  for (let m = 0; m < total; m++) {
    const val: boolean[] = new Array(n + 1).fill(false)
    for (let v = 1; v <= n; v++) val[v] = (m & (1 << (v - 1))) !== 0
    if (!feasible(inst, val)) continue
    count++
    if (!first) first = val.slice()
    if (hasObj) {
      const o = objectiveValue(inst, val)
      if (bestVal === undefined || o < bestVal) {
        bestVal = o
        best = val.slice()
      }
    }
  }
  if (count === 0) return { status: 'unsat', count: 0 }
  if (hasObj) return { status: 'sat', model: best, optimum: bestVal, count }
  return { status: 'sat', model: first, count }
}
