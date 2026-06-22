// Step-by-step execution traces for both machine kinds, used to animate the simulator.

import type { Dfa, Nfa, Sym } from './types'
import type { Alphabet } from './alphabet'
import { symbolOf } from './alphabet'
import { epsilonClosure, indexNfa, move } from './nfa'

export interface SimStep {
  /** The input character just consumed (display form), or null for the initial configuration. */
  char: string | null
  /** Alphabet symbol it mapped to, or null for the initial configuration. */
  sym: Sym | null
  /** Active states after this step. A DFA has 0 or 1; an NFA can have many. */
  active: number[]
}

export interface SimResult {
  steps: SimStep[]
  accepted: boolean
  /** A DFA can get stuck if its diagram was pruned (a transition into a removed dead sink). */
  stuck: boolean
}

export function simulateNfa(nfa: Nfa, input: string, alpha: Alphabet): SimResult {
  const idx = indexNfa(nfa)
  let active = epsilonClosure([nfa.start], idx)
  const steps: SimStep[] = [{ char: null, sym: null, active: [...active].sort((a, b) => a - b) }]

  for (const ch of input) {
    const sym = symbolOf(ch, alpha)
    active = epsilonClosure(move(active, sym, idx), idx)
    steps.push({ char: ch, sym, active: [...active].sort((a, b) => a - b) })
  }
  return {
    steps,
    accepted: active.has(nfa.accept),
    stuck: active.size === 0,
  }
}

export function simulateDfa(dfa: Dfa, input: string, alpha: Alphabet): SimResult {
  let state: number | null = dfa.start
  const steps: SimStep[] = [{ char: null, sym: null, active: [dfa.start] }]
  let stuck = false

  for (const ch of input) {
    const sym = symbolOf(ch, alpha)
    if (state === null) {
      steps.push({ char: ch, sym, active: [] })
      continue
    }
    const symIdx = alpha.index.get(sym)!
    const next: number = dfa.trans[state][symIdx]
    if (next === undefined || next < 0) {
      state = null
      stuck = true
      steps.push({ char: ch, sym, active: [] })
    } else {
      state = next
      steps.push({ char: ch, sym, active: [state] })
    }
  }
  return {
    steps,
    accepted: state !== null && dfa.accepting.has(state),
    stuck,
  }
}
