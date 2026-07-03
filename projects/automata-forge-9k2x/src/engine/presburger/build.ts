// The heart of the decision procedure: recursively compile a Presburger formula into the finite
// automaton over {0,1}ᵏ that recognizes exactly the LSBF encodings of its satisfying tuples.
//
// The recursion threads a **scope** — the ordered list of variable tracks currently live. The free
// variables of the whole formula are the base scope; each `∃x` / `∀x` *appends* x as a new track,
// compiles the body over the widened scope, then **projects that track away**. So the automaton at
// every node speaks the alphabet of exactly its live variables.
//
//   atom            → the carry/congruence automaton (atoms.ts)
//   ¬ / ∧ ∨ → ↔     → the DFA boolean algebra (complement / product)
//   ∃x              → projectExists(track of x)         (NFA → subset → 0-saturate)
//   ∀x              → ¬ ∃x ¬                            (the standard dual)
//
// Every node also records a **construction step** — its own minimized automaton plus the operation
// that produced it — so the UI can replay the build bottom-up.

import type { PDfa } from './automaton'
import { complement, product, projectExists, minimize } from './automaton'
import { buildLinear, buildCongruence, constDfa } from './atoms'
import type { Formula } from './formula'
import { diffCoeffs, showFormula, freeVars } from './formula'

export interface BuildStep {
  id: number
  op: string
  formula: string
  vars: string[]
  dfa: PDfa
  states: number
}

export interface BuildResult {
  dfa: PDfa
  steps: BuildStep[]
  vars: string[]
  /** Whether the top-level formula is a closed sentence (no free variables). */
  sentence: boolean
}

/** Align a variable→coefficient map to the current ordered scope (absent variables ⇒ 0). */
function alignCoeffs(coeffs: Record<string, number>, vars: string[]): number[] {
  const out = new Array(vars.length).fill(0)
  for (const [v, c] of Object.entries(coeffs)) {
    const idx = vars.indexOf(v)
    if (idx < 0) throw new Error(`variable ${v} is not in scope`)
    out[idx] = c
  }
  return out
}

export function compile(f: Formula): BuildResult {
  const fv = freeVars(f)
  const steps: BuildStep[] = []

  const emit = (op: string, sub: Formula, vars: string[], dfa: PDfa): PDfa => {
    const md = minimize(dfa)
    steps.push({ id: steps.length, op, formula: showFormula(sub), vars: [...vars], dfa: md, states: md.numStates })
    return md
  }

  const rec = (sub: Formula, vars: string[]): PDfa => {
    switch (sub.kind) {
      case 'true':
        return emit('⊤', sub, vars, constDfa(true, vars))
      case 'false':
        return emit('⊥', sub, vars, constDfa(false, vars))
      case 'cmp': {
        const coeffs = alignCoeffs(diffCoeffs(sub.left, sub.right), vars)
        const c = sub.right.c - sub.left.c
        return emit('atom', sub, vars, buildLinear(coeffs, sub.op, c, vars))
      }
      case 'div': {
        const coeffs = alignCoeffs(sub.term.coeffs, vars)
        let d = buildCongruence(coeffs, -sub.term.c, sub.divisor, vars)
        if (sub.neg) d = complement(d)
        return emit('atom', sub, vars, d)
      }
      case 'not':
        return emit('¬', sub, vars, complement(rec(sub.a, vars)))
      case 'and':
        return emit('∧', sub, vars, product('and', rec(sub.a, vars), rec(sub.b, vars)))
      case 'or':
        return emit('∨', sub, vars, product('or', rec(sub.a, vars), rec(sub.b, vars)))
      case 'imp':
        return emit('→', sub, vars, product('imp', rec(sub.a, vars), rec(sub.b, vars)))
      case 'iff':
        return emit('↔', sub, vars, product('iff', rec(sub.a, vars), rec(sub.b, vars)))
      case 'exists': {
        const nv = [...vars, sub.v]
        const inner = rec(sub.a, nv)
        return emit('∃' + sub.v, sub, vars, projectExists(inner, nv.length - 1))
      }
      case 'forall': {
        // ∀x φ  ≡  ¬ ∃x ¬φ
        const nv = [...vars, sub.v]
        const inner = rec(sub.a, nv)
        const proj = projectExists(complement(inner), nv.length - 1)
        return emit('∀' + sub.v, sub, vars, complement(proj))
      }
    }
  }

  const dfa = rec(f, fv)
  return { dfa, steps, vars: fv, sentence: fv.length === 0 }
}
