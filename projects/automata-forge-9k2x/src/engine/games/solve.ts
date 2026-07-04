// One entry point that solves a game by its condition and returns the solution *with* its
// certificate, so every panel in the view can show "solved — and here's the proof".

import type { Arena, Condition, Solution } from './types'
import { solveReachability, solveSafety } from './reachability'
import { solveBuchi } from './buchi'
import { solveParity } from './parity'
import {
  certifyParity,
  certifyReachability,
  certifySafety,
  type Certificate,
} from './certify'
import { effectivePriority } from './types'

export interface Solved {
  solution: Solution
  certificate: Certificate
}

/** The parity priorities a condition induces (Büchi ⇒ 2 on accepting, 1 elsewhere). */
export function conditionPriorities(a: Arena, cond: Condition): number[] {
  return a.priority.map((_, v) => effectivePriority(a, cond, v))
}

export function solveGame(a: Arena, cond: Condition): Solved {
  switch (cond) {
    case 'reachability': {
      const solution = solveReachability(a, a.accent)
      return { solution, certificate: certifyReachability(a, a.accent, solution) }
    }
    case 'safety': {
      const solution = solveSafety(a, a.accent)
      return { solution, certificate: certifySafety(a, a.accent, solution) }
    }
    case 'buchi': {
      const solution = solveBuchi(a, a.accent)
      return { solution, certificate: certifyParity(a, conditionPriorities(a, 'buchi'), solution) }
    }
    case 'parity': {
      const solution = solveParity(a)
      return { solution, certificate: certifyParity(a, a.priority, solution) }
    }
  }
}
