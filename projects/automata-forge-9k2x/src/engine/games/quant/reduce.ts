// Parity ⟶ mean-payoff: the reduction that ties this quantitative solver back to the qualitative
// Games mode's *already-proven* parity engine.
//
// Give the vertex of priority p the weight (−1)ᵖ · nᵖ, and put that weight on its out-edges. On any
// simple cycle the highest priority p* present contributes a term of magnitude ≥ nᵖ*, while all the
// strictly-lower-priority vertices together contribute < (n−1)·nᵖ*⁻¹ < nᵖ* — so the cycle's total
// (hence its mean) takes the sign (−1)ᵖ*. Player Even wins the parity play iff the highest priority
// seen infinitely often is even iff every optimally-reached cycle has positive mean iff ν(v) > 0.
// Because owners are preserved (Even = Max, Odd = Min), the two games have **identical** winning
// regions — a fact the Verify harness checks against Zielonka's solver vertex for vertex.

import type { Arena } from '../types'
import type { WArena, Player } from './types'
import type { WEdge } from './rational'

/** The signed weight a priority contributes: (−1)ᵖ · baseᵖ. */
export function priorityWeight(priority: number, base: number): number {
  const mag = Math.pow(base, priority)
  return priority % 2 === 0 ? mag : -mag
}

/** Reduce a parity arena to the equivalent mean-payoff arena (base = n makes the top priority dominate). */
export function parityToMeanPayoff(a: Arena): WArena {
  const n = a.n
  const base = n
  const vw = a.priority.map((p) => priorityWeight(p, base))
  const out: WEdge[][] = a.edges.map((es, v) => es.map((to) => ({ to, w: vw[v] })))
  return {
    n,
    owner: a.owner.map((o) => o as Player),
    out,
    labels: a.labels.slice(),
    pos: a.pos.map((p) => ({ ...p })),
  }
}

/** The per-vertex signed weight table (for display alongside the reduced arena). */
export function reductionWeights(a: Arena): number[] {
  return a.priority.map((p) => priorityWeight(p, a.n))
}
