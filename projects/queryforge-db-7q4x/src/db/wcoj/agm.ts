// The **AGM bound** (Atserias–Grohe–Marx 2008) and the **fractional edge cover**.
//
// Model the query as a hypergraph: variables are vertices, atoms are hyperedges.
// A *fractional edge cover* assigns a weight `x_e ≥ 0` to each atom so that every
// variable is covered — `Σ_{e ∋ v} x_e ≥ 1`. Then the join's output size is
// **at most** `∏_e |R_e|^{x_e}` for *any* cover, and the AGM bound is the tightest
// such product. Minimising `Σ x_e` (unit weights) gives the *fractional cover
// number* `ρ*`; minimising `Σ x_e · log|R_e|` gives the size bound. Both are LPs
// solved by `solveGE`.

import { solveGE } from './simplex'
import type { Atom } from './triejoin'
import { queryVariables } from './triejoin'

/** Build the cover-constraint matrix: one row per variable, one column per atom. */
function coverMatrix(atoms: Atom[]): { A: number[][]; vars: string[] } {
  const vars = queryVariables(atoms)
  const A = vars.map((v) => atoms.map((a) => (a.relation.has(v) ? 1 : 0)))
  return { A, vars }
}

export interface FractionalCover {
  /** The weight assigned to each atom (same order as `atoms`). */
  weights: number[]
  /** `Σ x_e` — the fractional edge cover number `ρ*`. */
  rho: number
  feasible: boolean
}

/** Solve `min Σ x_e s.t. every variable covered` — the fractional cover number. */
export function fractionalCover(atoms: Atom[]): FractionalCover {
  const { A } = coverMatrix(atoms)
  const b = A.map(() => 1)
  const c = atoms.map(() => 1)
  const r = solveGE(A, b, c)
  if (r.status !== 'optimal') return { weights: atoms.map(() => 0), rho: Infinity, feasible: false }
  return { weights: r.x, rho: r.obj, feasible: true }
}

export interface AgmBound {
  /** The optimal weights minimising `Σ x_e log|R_e|`. */
  weights: number[]
  /** The bound itself: `∏ |R_e|^{x_e}` (a real; the true output ≤ ⌊this⌋). */
  bound: number
  /** `log₂` of the bound (the LP objective) — numerically safer to compare. */
  logBound: number
}

/**
 * The AGM output-size bound `∏ |R_e|^{x_e}`, minimised over fractional covers.
 * Empty relations (`|R_e| = 0`) force the output to 0, handled directly.
 */
export function agmBound(atoms: Atom[]): AgmBound {
  const sizes = atoms.map((a) => a.relation.size)
  if (sizes.some((s) => s === 0)) return { weights: atoms.map(() => 0), bound: 0, logBound: -Infinity }
  const { A } = coverMatrix(atoms)
  const b = A.map(() => 1)
  const c = sizes.map((s) => Math.log2(Math.max(s, 1)))
  const r = solveGE(A, b, c)
  if (r.status !== 'optimal') return { weights: atoms.map(() => 0), bound: Infinity, logBound: Infinity }
  return { weights: r.x, bound: Math.pow(2, r.obj), logBound: r.obj }
}
