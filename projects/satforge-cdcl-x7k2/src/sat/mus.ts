// Minimal Unsatisfiable Subset (MUS) extraction.
//
// When a formula is UNSAT, the DRAT checker already hands back an *unsat core* — a
// subset of the original clauses sufficient to force the contradiction. But that core
// is only *sufficient*, not *minimal*: it may contain clauses you could drop and still
// be UNSAT. A MUS is an irreducible witness — an unsatisfiable subset every one of
// whose clauses is necessary (delete any single one and the remainder becomes SAT).
//
// We compute one with the classic deletion-based algorithm over the real CDCL solver:
//
//   M := all clauses
//   for each clause c in M:
//       if M \ {c} is UNSAT:  M := M \ {c}        (c was redundant — drop it)
//   return M
//
// Correctness: M stays UNSAT throughout. When we *keep* a clause c, the set we tested,
// M_t \ {c}, was SAT; since the final M ⊆ M_t and a subset of a satisfiable formula is
// satisfiable, M_final \ {c} is SAT too. So every clause of the result is necessary —
// M is a genuine MUS.

import type { CNF } from './cnf'
import { solve } from './solver'

export interface MusResult {
  /** Indices into the original cnf.clauses forming a minimal unsatisfiable subset. */
  core: number[]
  /** True iff every solver call was conclusive (so minimality is guaranteed). */
  minimal: boolean
  /** Number of subproblem solves performed. */
  solverCalls: number
  /** The starting clause count (for a reduction ratio in the UI). */
  total: number
  timeMs: number
}

export interface MusOptions {
  /** Conflict budget per subproblem solve (0 = unlimited). */
  budget?: number
  /** Optional starting subset (indices); defaults to all clauses. Lets us refine a DRAT core. */
  seed?: number[]
}

export function findMus(cnf: CNF, opts: MusOptions = {}): MusResult {
  const budget = opts.budget ?? 300000
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

  let calls = 0
  const statusOf = (indices: number[]): 'sat' | 'unsat' | 'unknown' => {
    calls++
    const sub: CNF = { numVars: cnf.numVars, clauses: indices.map((i) => cnf.clauses[i]) }
    return solve(sub, { maxConflicts: budget }).status
  }

  const total = cnf.clauses.length
  let minimal = true

  // Working core as a boolean membership mask + ordered index list.
  const inCore = new Array<boolean>(total)
  let order = (opts.seed && opts.seed.length > 0 ? opts.seed.slice() : cnf.clauses.map((_, i) => i)).filter(
    (i) => i >= 0 && i < total,
  )
  // dedupe seed indices
  const seenIdx = new Set<number>()
  order = order.filter((i) => (seenIdx.has(i) ? false : (seenIdx.add(i), true)))
  for (const i of order) inCore[i] = true

  // The starting set must itself be UNSAT for a MUS to exist.
  if (statusOf(order) !== 'unsat') {
    return { core: [], minimal: false, solverCalls: calls, total, timeMs: now() - start }
  }

  for (const idx of order) {
    if (!inCore[idx]) continue
    const reduced: number[] = []
    for (const j of order) if (j !== idx && inCore[j]) reduced.push(j)
    const st = statusOf(reduced)
    if (st === 'unsat') {
      inCore[idx] = false // clause idx is redundant — drop it permanently
    } else if (st === 'unknown') {
      minimal = false // can't certify necessity within budget; keep it conservatively
    }
    // st === 'sat' => idx is necessary; keep it
  }

  const core = order.filter((i) => inCore[i])
  return { core, minimal, solverCalls: calls, total, timeMs: now() - start }
}
