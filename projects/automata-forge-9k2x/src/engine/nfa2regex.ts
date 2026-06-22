// NFA → regular expression *directly*, without determinizing first.
//
// Subset construction can blow a small NFA up into an exponentially larger DFA before
// dfaToRegex ever runs. But Kleene's state-elimination doesn't care whether the machine is
// deterministic: a GNFA edge label is an arbitrary regex term, ε-edges and several symbol-edges
// between the same pair just become a union. So we build the GNFA straight from the ε-NFA's edge
// list and eliminate states on the (usually far smaller) original graph.

import type { Nfa, Sym } from './types'
import { emptyMatrix, EPS, litUnion, solveGnfa, union } from './regexTerm'

/** Reconstruct a regular expression from an ε-NFA by state elimination on the NFA itself. */
export function nfaToRegex(nfa: Nfa): string {
  const n = nfa.numStates
  const R = emptyMatrix(n)

  // Collapse parallel edges between the same ordered pair: an ε-edge contributes ε, symbol edges
  // contribute the union of their literals.
  const groups = new Map<string, { from: number; to: number; eps: boolean; syms: Sym[] }>()
  for (const e of nfa.edges) {
    const key = `${e.from}->${e.to}`
    let g = groups.get(key)
    if (!g) {
      g = { from: e.from, to: e.to, eps: false, syms: [] }
      groups.set(key, g)
    }
    if (e.sym === null) g.eps = true
    else g.syms.push(e.sym)
  }
  for (const g of groups.values()) {
    let term = litUnion(g.syms)
    if (g.eps) term = union(EPS, term)
    R[g.from][g.to] = union(R[g.from][g.to], term)
  }

  return solveGnfa(n, nfa.start, [nfa.accept], R)
}
