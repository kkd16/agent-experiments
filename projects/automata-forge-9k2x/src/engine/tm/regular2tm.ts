// The bridge *up* the hierarchy: every regular language is decidable, so any DFA — hence any regex,
// via the existing NFA → DFA → minimal-DFA pipeline — compiles to an equivalent Turing machine. The
// TM is the simplest possible kind: it never writes and only moves right, scanning the input once
// like a finite automaton with a read head. One TM state per DFA state; when the head reaches the
// first blank (end of input) it halts in `acc` iff the DFA state was accepting. This places the
// regular languages firmly inside the recursively-enumerable ones at the top of the hierarchy.

import type { Dfa, Sym } from '../types'
import { OTHER } from '../types'
import { parse } from '../parser'
import { deriveAlphabet } from '../alphabet'
import { buildNfa } from '../nfa'
import { subsetConstruction, minimizeDfa } from '../dfa'
import type { TuringMachine, TMTransition } from './machine'

/** Name DFA state `i` as a TM state: q0, q1, … */
const stateName = (i: number) => `q${i}`

/**
 * Convert a DFA to an equivalent read-only, move-right Turing machine. The OTHER sentinel (any
 * character the regex never named) becomes a `*` wildcard rule, so unseen characters route exactly
 * as the DFA would route them.
 */
export function dfaToTM(dfa: Dfa): TuringMachine {
  const transitions: TMTransition[] = []
  const usedStates = new Set<number>([dfa.start])
  const inputSeen = new Set<string>()
  const inputAlphabet: string[] = []

  const trap = dfa.trap
  for (let q = 0; q < dfa.numStates; q++) {
    if (q === trap) continue
    for (let si = 0; si < dfa.alphabet.length; si++) {
      const r = dfa.trans[q][si]
      if (r < 0 || r === trap) continue // pruned / trap transition: no rule ⇒ halt-reject
      const sym: Sym = dfa.alphabet[si]
      const read = sym === OTHER ? '*' : sym
      transitions.push({ state: stateName(q), read, next: stateName(r), write: read === '*' ? '*' : sym, move: 'R' })
      usedStates.add(q)
      usedStates.add(r)
      if (sym !== OTHER && !inputSeen.has(sym)) {
        inputSeen.add(sym)
        inputAlphabet.push(sym)
      }
    }
    // At end of input (blank), halt accepting iff this DFA state accepts.
    transitions.push({ state: stateName(q), read: '_', next: dfa.accepting.has(q) ? 'acc' : 'rej', write: '_', move: 'S' })
  }

  const states = [...usedStates].map(stateName)
  states.push('acc', 'rej')

  return {
    states,
    start: stateName(dfa.start),
    accept: 'acc',
    reject: 'rej',
    blank: '_',
    inputAlphabet,
    tapeAlphabet: [...inputAlphabet, '_'],
    transitions,
    note: 'read-only, move-right — a DFA in Turing-machine clothing',
  }
}

export interface RegexToTMResult {
  machine?: TuringMachine
  error?: string
}

/** Compile a regex all the way to a Turing machine via the NFA → DFA → minimal-DFA pipeline. */
export function regexToTM(regex: string): RegexToTMResult {
  const res = parse(regex)
  if (!res.ok) return { error: `regex error: ${res.error.message}` }
  const alpha = deriveAlphabet(res.ast)
  const nfa = buildNfa(res.ast, alpha)
  const dfa = minimizeDfa(subsetConstruction(nfa))
  return { machine: dfaToTM(dfa) }
}
