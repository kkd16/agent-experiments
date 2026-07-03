// A direct, independent evaluator for Presburger formulas — the ground truth the automaton is graded
// against. It shares no machinery with the automata construction: it just interprets the AST over an
// assignment of naturals, with quantifiers ranging over a bounded domain [0, qbound). For the
// quantifier-free fragment the evaluation is exact; for quantifiers it is exact whenever a witness (if
// one exists) fits under `qbound`, which the self-tests are careful to arrange.

import type { Formula, LinTerm } from './formula'
import { freeVars } from './formula'

export type Env = Record<string, number>

function evalTerm(t: LinTerm, env: Env): number {
  let s = t.c
  for (const [v, c] of Object.entries(t.coeffs)) s += c * (env[v] ?? 0)
  return s
}

export interface EvalOpts {
  /** Quantifier domain is [0, qbound). */
  qbound: number
}

export function evalFormula(f: Formula, env: Env, opts: EvalOpts): boolean {
  switch (f.kind) {
    case 'true':
      return true
    case 'false':
      return false
    case 'cmp': {
      const l = evalTerm(f.left, env)
      const r = evalTerm(f.right, env)
      switch (f.op) {
        case 'le':
          return l <= r
        case 'lt':
          return l < r
        case 'ge':
          return l >= r
        case 'gt':
          return l > r
        case 'eq':
          return l === r
        case 'ne':
          return l !== r
      }
      return false
    }
    case 'div': {
      const v = evalTerm(f.term, env)
      const m = Math.abs(f.divisor)
      const divides = m !== 0 && ((v % m) + m) % m === 0
      return f.neg ? !divides : divides
    }
    case 'not':
      return !evalFormula(f.a, env, opts)
    case 'and':
      return evalFormula(f.a, env, opts) && evalFormula(f.b, env, opts)
    case 'or':
      return evalFormula(f.a, env, opts) || evalFormula(f.b, env, opts)
    case 'imp':
      return !evalFormula(f.a, env, opts) || evalFormula(f.b, env, opts)
    case 'iff':
      return evalFormula(f.a, env, opts) === evalFormula(f.b, env, opts)
    case 'exists': {
      for (let v = 0; v < opts.qbound; v++) {
        if (evalFormula(f.a, { ...env, [f.v]: v }, opts)) return true
      }
      return false
    }
    case 'forall': {
      for (let v = 0; v < opts.qbound; v++) {
        if (!evalFormula(f.a, { ...env, [f.v]: v }, opts)) return false
      }
      return true
    }
  }
}

/** Convenience: evaluate a formula over a tuple of values for its free variables (in the given order). */
export function evalTuple(f: Formula, vars: string[], tuple: number[], qbound: number): boolean {
  const env: Env = {}
  vars.forEach((v, i) => (env[v] = tuple[i] ?? 0))
  return evalFormula(f, env, { qbound })
}

/** Truth of a closed sentence, quantifiers over [0, qbound). */
export function evalSentence(f: Formula, qbound: number): boolean {
  return evalFormula(f, {}, { qbound })
}

export { freeVars }
