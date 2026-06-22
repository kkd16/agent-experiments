// DFA → regular expression by the state-elimination method (GNFA / Kleene's theorem).
//
// We add a fresh start and accept state, label every edge with a regular-expression *term*,
// then rip out the original states one at a time (see solveGnfa in regexTerm.ts). The term
// algebra's smart constructors keep the output readable instead of exploding into parentheses.

import type { Dfa, Sym } from './types'
import { emptyMatrix, litUnion, solveGnfa, union } from './regexTerm'

/**
 * Reconstruct a regular expression from a DFA. Works on a partial DFA too (pruned dead sinks
 * just contribute no edges). Returns ∅ for the empty language and ε for {ε}.
 */
export function dfaToRegex(dfa: Dfa): string {
  const n = dfa.numStates
  const R = emptyMatrix(n)

  // Merge each DFA transition into an edge label (group target -> symbols already in trans).
  for (let s = 0; s < n; s++) {
    const bySym: Map<number, Sym[]> = new Map()
    for (let c = 0; c < dfa.alphabet.length; c++) {
      const t = dfa.trans[s][c]
      if (t === undefined || t < 0) continue
      const arr = bySym.get(t)
      if (arr) arr.push(dfa.alphabet[c])
      else bySym.set(t, [dfa.alphabet[c]])
    }
    for (const [t, syms] of bySym) R[s][t] = union(R[s][t], litUnion(syms))
  }

  return solveGnfa(n, dfa.start, dfa.accepting, R)
}
