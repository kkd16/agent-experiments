// CNF-encoding back-end — the *oracle*. Every PB constraint is lowered to clauses with the
// project's existing Generalized Totalizer Encoding (`sat/cardinality.ts`) and handed to the
// from-scratch CDCL SAT solver. Because the totalizer is proven correct in the SAT harness,
// this gives an independent, trustworthy SAT/UNSAT verdict against which the native
// cutting-plane solver is continuously cross-checked — a different proof system (resolution
// over a clausal expansion) reaching the same answer.
//
// Lowering a single constraint  Σ aᵢ·ℓᵢ ≥ degree  uses the complement identity
//   Σ aᵢ·ℓᵢ ≥ degree   ⇔   Σ aᵢ·¬ℓᵢ ≤ (Σ aᵢ) − degree,
// i.e. an at-most bound over the *negated* literals, which is exactly what the totalizer
// encodes.

import { encodeGTE, atMostBound, PBBuilder } from '../sat/cardinality'
import { solve } from '../sat/solver'
import type { CNF } from '../sat/cnf'
import type { Pbc } from './constraint'
import type { PbInstance } from './instance'

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

function toNum(x: bigint, what: string): number {
  if (x > MAX_SAFE) throw new Error(`coefficient ${what}=${x} too large for the CNF encoder`)
  return Number(x)
}

export interface PbCnfResult {
  status: 'sat' | 'unsat' | 'unknown'
  model?: boolean[] // 1-based, restricted to the instance variables
  /** Total clauses emitted (a rough size readout for the UI). */
  clauses: number
  /** Auxiliary variables introduced by the totalizer. */
  auxVars: number
  /** Conflicts the resolution-based CDCL core spent — contrast this with the native solver. */
  conflicts: number
}

/** Append the clauses encoding one normal-form PB constraint into a {@link PBBuilder}. */
export function encodeConstraint(sink: PBBuilder, c: Pbc): void {
  if (c.isTriviallyTrue()) return
  const total = c.totalCoef()
  if (total < c.degree) {
    sink.add([]) // unsatisfiable: the empty clause
    return
  }
  // at-most bound over negated literals
  const bound = total - c.degree // Σ aᵢ¬ℓᵢ ≤ bound
  const terms = c.terms().map((t) => ({ lit: -t.lit, weight: toNum(t.coef, 'coef') }))
  const gte = encodeGTE(sink, terms)
  for (const lit of atMostBound(gte, toNum(bound, 'bound'))) sink.add([lit])
}

/** Encode a whole instance (hard constraints only) to a {@link CNF}, keeping var ids stable. */
export function encodeInstance(inst: PbInstance): { cnf: CNF; auxVars: number } {
  const sink = new PBBuilder(inst.numVars)
  for (const c of inst.constraints) encodeConstraint(sink, c)
  const cnf: CNF = { numVars: sink.numVars, clauses: sink.clauses }
  return { cnf, auxVars: sink.numVars - inst.numVars }
}

/** Solve an instance's feasibility through the CNF oracle. */
export function solveViaCnf(inst: PbInstance, maxConflicts = 2_000_000): PbCnfResult {
  const { cnf, auxVars } = encodeInstance(inst)
  const res = solve(cnf, { maxConflicts, restarts: true, minimize: true })
  const conflicts = res.stats.conflicts
  if (res.status === 'sat') {
    const model: boolean[] = new Array(inst.numVars + 1).fill(false)
    for (let v = 1; v <= inst.numVars; v++) model[v] = res.model![v]
    return { status: 'sat', model, clauses: cnf.clauses.length, auxVars, conflicts }
  }
  return { status: res.status, clauses: cnf.clauses.length, auxVars, conflicts }
}
