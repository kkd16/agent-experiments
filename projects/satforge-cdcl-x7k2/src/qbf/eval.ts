// Exact QBF semantics by recursive Shannon expansion over the prefix — an
// independent, obviously-correct oracle used to cross-check the real solver
// (RAReQS). Exponential in the number of *matrix-relevant* variables, so it is
// only invoked on small instances (the self-check battery, and the studio's
// "verified against brute force" badge).
//
// This is the QBF analog of SatForge's other independent oracles (the DRAT
// checker re-deriving UNSAT, the BFS oracle behind the model checker): the
// solver is only trusted because a second, dumber procedure agrees with it.

import type { QBF } from './qdimacs'

/**
 * Evaluate a QBF exactly. Returns its truth value, or `null` if it has more
 * matrix-relevant variables than `limitVars` (too large to brute-force).
 *
 * The quantifier game is played outermost-in: for an ∃ block the value is the
 * OR over all assignments to its (relevant) variables; for a ∀ block, the AND.
 * Both are short-circuited. Variables that never appear in the matrix cannot
 * change the value, so they are skipped entirely.
 */
export function evalQbf(qbf: QBF, limitVars = 24): boolean | null {
  const used = new Set<number>()
  for (const c of qbf.matrix) for (const l of c) used.add(Math.abs(l))

  // Each block restricted to the variables that actually occur in the matrix.
  const blocks = qbf.prefix
    .map((b) => ({ q: b.q, vars: b.vars.filter((v) => used.has(v)) }))
    .filter((b) => b.vars.length > 0)

  const total = blocks.reduce((s, b) => s + b.vars.length, 0)
  if (total > limitVars) return null

  // assign[v] ∈ {0,1} for every used variable once we reach a leaf.
  const assign = new Int8Array(qbf.numVars + 1)

  const evalMatrix = (): boolean => {
    for (const c of qbf.matrix) {
      let sat = false
      for (const l of c) {
        const v = Math.abs(l)
        if (l > 0 ? assign[v] === 1 : assign[v] === 0) {
          sat = true
          break
        }
      }
      if (!sat) return false
    }
    return true
  }

  const recBlock = (bi: number): boolean => {
    if (bi === blocks.length) return evalMatrix()
    const { q, vars } = blocks[bi]
    const k = vars.length

    // Enumerate all 2^k assignments to this block's variables, combining results
    // with OR (∃) or AND (∀), short-circuiting as soon as the outcome is fixed.
    const recVar = (vi: number): boolean => {
      if (vi === k) return recBlock(bi + 1)
      const v = vars[vi]
      assign[v] = 0
      const r0 = recVar(vi + 1)
      if (q === 'e' && r0) return true
      if (q === 'a' && !r0) return false
      assign[v] = 1
      const r1 = recVar(vi + 1)
      return q === 'e' ? r0 || r1 : r0 && r1
    }
    return recVar(0)
  }

  return recBlock(0)
}
