// Craig interpolation for propositional logic via McMillan's system: given an
// unsatisfiable conjunction A ∧ B, an interpolant I is a formula such that
//   (1) A ⟹ I,   (2) I ∧ B is unsatisfiable,   (3) vars(I) ⊆ vars(A) ∩ vars(B).
// McMillan's beautiful observation is that I can be read straight off any
// resolution refutation of A ∧ B by attaching a "partial interpolant" to every
// clause and combining them at each resolution step. The empty clause's partial
// interpolant is the interpolant. Interpolants are the engine of unbounded,
// SAT-based model checking (see modelcheck.ts).

import type { Formula } from './formula'
import { TRUE, FALSE, fvar, fnot, fand, for_, evalFormula, formulaVars } from './formula'
import { ProofSolver, type InputClause, type ProofNode } from './proofSolver'

export interface InterpolationResult {
  status: 'unsat'
  interpolant: Formula
  /** Variables shared between A and B (the interpolant's allowed vocabulary). */
  shared: number[]
  proofSize: number
}

export interface SatWitness {
  status: 'sat'
  model: boolean[]
}

const lit = (l: number): Formula => (l > 0 ? fvar(l) : fnot(fvar(-l)))

/**
 * Compute a Craig interpolant for the partitioned CNF (A-clauses, B-clauses).
 * Returns the interpolant when A ∧ B is unsat, or a satisfying model otherwise.
 */
export function interpolate(
  numVars: number,
  aClauses: number[][],
  bClauses: number[][],
): InterpolationResult | SatWitness {
  const clauses: InputClause[] = [
    ...aClauses.map((lits) => ({ lits, part: 'A' as const })),
    ...bClauses.map((lits) => ({ lits, part: 'B' as const })),
  ]
  const res = new ProofSolver(numVars, clauses).solve()
  if (res.status === 'sat') return { status: 'sat', model: res.model! }

  // Variable occurrence sides, computed from the original clause sets.
  const inA = new Set<number>()
  const inB = new Set<number>()
  for (const c of aClauses) for (const l of c) inA.add(Math.abs(l))
  for (const c of bClauses) for (const l of c) inB.add(Math.abs(l))
  const shared = [...inA].filter((v) => inB.has(v)).sort((a, b) => a - b)
  const isShared = (v: number) => inA.has(v) && inB.has(v)
  const isAlocal = (v: number) => inA.has(v) && !inB.has(v)

  const proof = res.proof!
  const memo = new Array<Formula | undefined>(proof.length)

  const partial = (id: number): Formula => {
    const cached = memo[id]
    if (cached) return cached
    const node: ProofNode = proof[id]
    let out: Formula
    if (node.kind === 'leaf') {
      if (node.part === 'B') {
        out = TRUE
      } else {
        // A-clause: disjunction of its literals whose variable is shared.
        const shareds = node.lits.filter((l) => isShared(Math.abs(l)))
        out = shareds.length === 0 ? FALSE : for_(...shareds.map(lit))
      }
    } else {
      const L = partial(node.left)
      const R = partial(node.right)
      out = isAlocal(node.pivot) ? for_(L, R) : fand(L, R)
    }
    memo[id] = out
    return out
  }

  const interpolant = partial(res.emptyNode!)
  return { status: 'unsat', interpolant, shared, proofSize: proof.length }
}

// ---- Verification (an independent, brute-force certificate) ----------------

export interface InterpolantCheck {
  vocabularyOk: boolean // vars(I) ⊆ shared
  aImpliesI: boolean // every model of A satisfies I
  iAndBUnsat: boolean // no model satisfies I ∧ B
  ok: boolean
}

const clauseSatBy = (clause: number[], assign: boolean[]): boolean =>
  clause.some((l) => (l > 0 ? assign[l] : !assign[-l]))

/**
 * Exhaustively verify the three defining properties of a Craig interpolant by
 * enumerating all assignments. Only for small instances (numVars ≤ ~20) — this
 * is the trusted oracle the self-test holds the proof-based interpolant against.
 */
export function checkInterpolant(
  numVars: number,
  aClauses: number[][],
  bClauses: number[][],
  interpolant: Formula,
  shared: Set<number>,
): InterpolantCheck {
  const ivars = formulaVars(interpolant)
  let vocabularyOk = true
  for (const v of ivars) if (!shared.has(v)) vocabularyOk = false

  let aImpliesI = true
  let iAndBUnsat = true
  const assign: boolean[] = new Array(numVars + 1).fill(false)
  const total = 1 << numVars
  for (let mask = 0; mask < total; mask++) {
    for (let v = 1; v <= numVars; v++) assign[v] = (mask & (1 << (v - 1))) !== 0
    const satA = aClauses.every((c) => clauseSatBy(c, assign))
    const satB = bClauses.every((c) => clauseSatBy(c, assign))
    const satI = evalFormula(interpolant, (v) => assign[v])
    if (satA && !satI) aImpliesI = false
    if (satI && satB) iAndBUnsat = false
  }
  return { vocabularyOk, aImpliesI, iAndBUnsat, ok: vocabularyOk && aImpliesI && iAndBUnsat }
}
