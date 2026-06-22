// Closure properties: regular languages are closed under reversal and complement, and both
// constructions are elementary on the automaton. These let the Build view show, for any machine
// you draw, the machine for the reversed language and the complement language.

import type { Dfa, Nfa, NfaEdge } from './types'
import { completeDfa } from './product'

/**
 * Reverse construction. Reverses every edge of a DFA, makes the old start the (single) accept,
 * and adds a fresh start with ε-edges into every old accepting state. The result is an ε-NFA whose
 * language is exactly the reversal { wᴿ : w ∈ L(dfa) } — feed it through subset construction to get
 * a reversed-language DFA. (Brzozowski's famous minimization is reverse-determinize twice.)
 */
export function reverseToNfa(dfa: Dfa): Nfa {
  const fresh = dfa.numStates // the new start state
  const edges: NfaEdge[] = []
  for (let s = 0; s < dfa.numStates; s++) {
    for (let c = 0; c < dfa.alphabet.length; c++) {
      const t = dfa.trans[s][c]
      if (t === undefined || t < 0) continue
      edges.push({ from: t, to: s, sym: dfa.alphabet[c] }) // reverse the edge
    }
  }
  for (const a of dfa.accepting) edges.push({ from: fresh, to: a, sym: null })
  return {
    numStates: dfa.numStates + 1,
    start: fresh,
    accept: dfa.start, // a string is accepted in reverse iff its reverse ended at dfa.start
    edges,
    alphabet: dfa.alphabet,
  }
}

/**
 * Complement: totalise the DFA over its alphabet (a trap absorbs missing transitions) and flip
 * accepting and non-accepting states. The result recognizes Σ* − L(dfa).
 */
export function complementDfa(dfa: Dfa): Dfa {
  const total = completeDfa(dfa)
  const accepting = new Set<number>()
  for (let s = 0; s < total.numStates; s++) {
    if (!total.accepting.has(s)) accepting.add(s)
  }
  return { ...total, accepting }
}
