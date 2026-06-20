// A pseudo-Boolean problem instance: a conjunction of PB constraints over variables
// 1..numVars, plus an optional linear objective to MINIMIZE. This is the shared currency
// between the encoders, the three solving back-ends (brute force, CNF oracle, native
// cutting-plane solver) and the studio UI.

import { Pbc, type SignedTerm } from './constraint'

export interface PbInstance {
  /** Variables are 1..numVars. */
  numVars: number
  /** Hard constraints; the conjunction must hold. */
  constraints: Pbc[]
  /** Optional objective `objConst + Σ coefᵢ·ℓᵢ` to **minimize** (coefficients may be signed). */
  objective?: SignedTerm[]
  /** Constant term of the objective. */
  objConst?: bigint
  /** Optional human-readable label per variable (1-based; index 0 unused). */
  labels?: string[]
  /** A one-line description for the UI. */
  note?: string
}

/** The objective value of a complete model `value[v] ∈ {true,false}` (1-based). */
export function objectiveValue(inst: PbInstance, value: boolean[]): bigint {
  let s = inst.objConst ?? 0n
  for (const t of inst.objective ?? []) {
    const v = Math.abs(t.lit)
    const truth = t.lit > 0 ? value[v] : !value[v]
    if (truth) s += t.coef
  }
  return s
}

/** Does `value` satisfy every constraint? */
export function feasible(inst: PbInstance, value: boolean[]): boolean {
  for (const c of inst.constraints) if (!c.satisfiedBy(value)) return false
  return true
}

/** Default variable label `xN` unless the instance supplies one. */
export function labelOf(inst: PbInstance, v: number): string {
  return inst.labels?.[v] ?? `x${v}`
}

/** Deep-ish clone (constraints cloned, objective shared since it is immutable input). */
export function cloneInstance(inst: PbInstance): PbInstance {
  return {
    numVars: inst.numVars,
    constraints: inst.constraints.map((c) => c.clone()),
    objective: inst.objective,
    objConst: inst.objConst,
    labels: inst.labels,
    note: inst.note,
  }
}

/** Build an instance from raw constraints (helper for encoders / tests). */
export function makeInstance(numVars: number, constraints: Pbc[], extra: Partial<PbInstance> = {}): PbInstance {
  return { numVars, constraints, ...extra }
}
