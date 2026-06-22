// The bridge *down* the hierarchy: every regular language is context-free. Concretely, a DFA turns
// into a **right-linear** grammar — one nonterminal per state, a rule q → a r for each transition
// q --a--> r, and q → ε for each accepting state. Right-linear grammars generate exactly the regular
// languages, so this lets a regex (compiled through the existing NFA→DFA pipeline) be carried into
// the context-free tools and cross-checked.

import type { Dfa, Sym } from '../types'
import { OTHER } from '../types'
import { parse } from '../parser'
import { deriveAlphabet } from '../alphabet'
import { buildNfa } from '../nfa'
import { subsetConstruction, minimizeDfa } from '../dfa'
import type { Grammar, Production } from './grammar'

/** The terminal symbol used in the grammar for the "any other character" sentinel. */
const OTHER_TERM = '∗'

const termOf = (s: Sym): string => (s === OTHER ? OTHER_TERM : s)

/** Name DFA state `i` as a grammar nonterminal: A, B, … Z, then A1, B1, … */
function stateName(i: number): string {
  const letter = String.fromCharCode(65 + (i % 26))
  const wrap = Math.floor(i / 26)
  return wrap === 0 ? letter : `${letter}${wrap}`
}

/**
 * Convert a DFA to an equivalent right-linear grammar. The trap state (a non-accepting sink) is
 * dropped: transitions into it are simply omitted, which keeps the grammar readable without
 * changing the language.
 */
export function dfaToRightLinear(dfa: Dfa): Grammar {
  const names = Array.from({ length: dfa.numStates }, (_, i) => stateName(i))
  const trap = dfa.trap
  const productions: Production[] = []
  const used = new Set<number>([dfa.start])

  for (let q = 0; q < dfa.numStates; q++) {
    if (q === trap) continue
    for (let si = 0; si < dfa.alphabet.length; si++) {
      const r = dfa.trans[q][si]
      if (r < 0 || r === trap) continue // -1 = pruned dead-sink transition
      productions.push({ lhs: names[q], rhs: [termOf(dfa.alphabet[si]), names[r]] })
      used.add(q)
      used.add(r)
    }
    if (dfa.accepting.has(q)) productions.push({ lhs: names[q], rhs: [] })
  }

  // Nonterminals: every reachable, non-trap state, start first.
  const nts = [dfa.start, ...[...used].filter((q) => q !== dfa.start)]
    .filter((q) => q !== trap)
    .map((q) => names[q])
  const ntSet = new Set(nts)
  const terms: string[] = []
  const tSeen = new Set<string>()
  for (const p of productions) {
    for (const s of p.rhs) {
      if (!ntSet.has(s) && !tSeen.has(s)) {
        tSeen.add(s)
        terms.push(s)
      }
    }
  }

  return { start: names[dfa.start], nonterminals: nts, terminals: terms, productions }
}

export interface RegexToCfgResult {
  grammar?: Grammar
  /** A parse/compile error message, if the regex was invalid. */
  error?: string
}

/** Compile a regex all the way to a right-linear grammar via the NFA → DFA → minimal-DFA pipeline. */
export function regexToRightLinear(regex: string): RegexToCfgResult {
  const res = parse(regex)
  if (!res.ok) return { error: `regex error: ${res.error.message}` }
  const alpha = deriveAlphabet(res.ast)
  const nfa = buildNfa(res.ast, alpha)
  const dfa = minimizeDfa(subsetConstruction(nfa)) // already dead-sink-pruned (partial)
  return { grammar: dfaToRightLinear(dfa) }
}
