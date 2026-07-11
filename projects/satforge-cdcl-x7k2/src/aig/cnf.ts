// Tseitin encoding of an AIG into CNF — the bridge from *circuits* to *clauses*
// that lets the project's own CDCL solver serve as the AIG's proof oracle.
//
// One fresh Boolean variable is minted per node. For an AND gate `y = a·b` the
// classic three clauses assert the definition exactly:
//
//     (¬y ∨ a)  (¬y ∨ b)  (y ∨ ¬a ∨ ¬b)
//
// i.e. y→a, y→b, and (a∧b)→y. The constant node gets its own variable clamped to
// false by a unit clause, so a fanin that is the constant literal is handled by the
// same `dl()` path as any other literal with no special-casing at the call sites.

import type { CNF } from '../sat/cnf'
import { Aig, litNode, litInv } from './aig'

export interface AigCnf {
  cnf: CNF
  /** DIMACS variable per AIG node (index by node number). */
  varOf: Int32Array
  /** Map an AIG literal to its signed DIMACS literal. */
  dl(lit: number): number
}

/** Tseitin-encode the whole AIG. Every node gets a variable; the constant is clamped. */
export function tseitin(aig: Aig): AigCnf {
  const N = aig.numNodes
  const varOf = new Int32Array(N)
  const clauses: number[][] = []
  let nv = 0

  varOf[0] = ++nv
  clauses.push([-varOf[0]]) // constant node ≡ false
  for (let i = 1; i < N; i++) varOf[i] = ++nv

  const dl = (lit: number): number => {
    const v = varOf[litNode(lit)]
    return litInv(lit) ? -v : v
  }

  for (let i = 1; i < N; i++) {
    if (aig.isPI[i]) continue
    const y = varOf[i]
    const a = dl(aig.fanin0[i])
    const b = dl(aig.fanin1[i])
    clauses.push([-y, a])
    clauses.push([-y, b])
    clauses.push([y, -a, -b])
  }

  return { cnf: { numVars: nv, clauses }, varOf, dl }
}
