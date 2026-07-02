// Shared machinery for the Insight engine: reasoning about the *structure* of a
// Boolean formula beyond a single SAT/UNSAT verdict.
//
// A great many of these algorithms (MUS/MCS extraction, MARCO enumeration,
// backbone hunting) reduce to the same primitive: "given a set of *soft* clauses,
// which of them may be switched on together, and which minimal switch-on sets are
// contradictory?" We answer that with **selector variables** on the very same CDCL
// core the rest of SatForge is built on:
//
//   • Each soft clause  C_i = (l1 ∨ … ∨ lk)  is augmented to  (l1 ∨ … ∨ lk ∨ ¬s_i),
//     where s_i is a fresh Boolean *selector*. Assuming s_i = true *enables* the
//     clause (it must now be satisfied); leaving s_i free lets the solver satisfy
//     the augmented clause trivially via ¬s_i, i.e. the clause is switched off.
//   • Checking whether a subset `seed ⊆ {0..m-1}` of soft clauses is jointly
//     satisfiable (together with the always-on *hard* clauses) is then a single
//     incremental `solveAssuming([s_i : i ∈ seed])` on ONE long-lived solver.
//   • When that is UNSAT, the solver hands back an *unsatisfiable core* — a subset
//     of the assumed selectors that already suffices for the contradiction. That
//     core seeds MUS extraction, turning a from-scratch analyzeFinal() walk into a
//     powerful structural tool.
//
// Everything here is exact and deterministic; the selftest module cross-checks it
// against a brute-force oracle over all 2^m subsets.

import type { CNF } from '../sat/cnf'
import { CdclSolver } from '../sat/solver'
import type { SolverOptions } from '../sat/solver'

/** A soft-constraint system: hard clauses that always hold, plus a labelled list
 *  of soft clauses that may be independently switched on or off. */
export interface SoftSystem {
  /** Number of *problem* variables (1..numVars). Selectors are allocated above this. */
  numVars: number
  /** Clauses that are always present (the invariant background theory). */
  hard: number[][]
  /** The soft clauses, addressed by index. A "subset" always means a set of these indices. */
  soft: number[][]
  /** Optional human labels for each soft clause (shown in the UI). */
  labels?: string[]
}

export type SatVerdict =
  | { sat: true; model: boolean[] }
  | { sat: false; core: number[] } // core ⊆ the queried seed (indices of soft clauses)

/**
 * A long-lived, incremental oracle over a {@link SoftSystem}. One augmented CNF is
 * built once; every `check(seed)` is an incremental assumption solve on the same
 * engine, so exploring thousands of subsets never rebuilds the clause database.
 */
export class SoftSolver {
  private solver: CdclSolver
  private selBase: number // selector for soft clause i is  (selBase + i)
  readonly m: number

  constructor(sys: SoftSystem, opts: SolverOptions = {}) {
    this.m = sys.soft.length
    this.selBase = sys.numVars + 1
    const clauses: number[][] = []
    for (const c of sys.hard) clauses.push(c.slice())
    for (let i = 0; i < sys.soft.length; i++) {
      clauses.push([...sys.soft[i], -(this.selBase + i)])
    }
    const cnf: CNF = { numVars: sys.numVars + this.m, clauses }
    // Deterministic, no restarts-based nondeterminism beyond the seeded RNG; keep the
    // trace off for speed. Assumption solving is repeatable across calls.
    this.solver = new CdclSolver(cnf, { ...opts, trace: false, proof: false })
  }

  private sel(i: number): number {
    return this.selBase + i
  }

  /** Is the hard theory together with exactly the soft clauses in `seed` satisfiable? */
  check(seed: Iterable<number>): SatVerdict {
    const assume: number[] = []
    for (const i of seed) assume.push(this.sel(i))
    const r = this.solver.solveAssuming(assume)
    if (r.status === 'sat') {
      // Project the model back onto the problem variables (drop selectors).
      return { sat: true, model: r.model! }
    }
    // Map the selector core back to soft-clause indices. `core` is a subset of the
    // assumed selector literals (positive), so decode via (lit - selBase).
    const core: number[] = []
    for (const lit of r.core ?? []) {
      const v = Math.abs(lit)
      const idx = v - this.selBase
      if (idx >= 0 && idx < this.m) core.push(idx)
    }
    // Guard: if the core came back empty (hard theory alone is UNSAT), report it as
    // the full seed so downstream shrinkers still behave.
    if (core.length === 0) return { sat: false, core: [...seed] }
    core.sort((a, b) => a - b)
    return { sat: false, core }
  }

  /** Convenience: is `seed` satisfiable? (discards model/core) */
  isSat(seed: Iterable<number>): boolean {
    return this.check(seed).sat
  }
}

/** Set helpers over soft-clause index sets, kept explicit for readability. */
export function complement(m: number, subset: Iterable<number>): number[] {
  const inSet = new Set(subset)
  const out: number[] = []
  for (let i = 0; i < m; i++) if (!inSet.has(i)) out.push(i)
  return out
}

export function fullSet(m: number): number[] {
  return Array.from({ length: m }, (_, i) => i)
}
