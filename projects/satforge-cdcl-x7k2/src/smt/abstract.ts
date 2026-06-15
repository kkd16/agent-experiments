// Boolean abstraction: turn the Boolean skeleton of a formula into CNF via a
// Tseitin transformation. Each *atom* (predicate / EUF equality / arithmetic
// relation) gets one Boolean variable; each compound connective gets a fresh
// variable defined by equivalence clauses. The theory atoms are what DPLL(T)
// hands to the theory solvers; the connective variables are invisible to them.

import type { Atom, Formula } from './term'

export interface Abstraction {
  numVars: number
  clauses: number[][]
  /** SAT variable (1-based) for each atom, keyed by atom id. */
  atomVar: Map<number, number>
  /** Reverse: SAT variable → atom (only for atom variables). */
  varAtom: Map<number, Atom>
  /** The asserted top-level literal. */
  rootLit: number
}

export function abstractFormula(root: Formula): Abstraction {
  let numVars = 0
  const clauses: number[][] = []
  const atomVar = new Map<number, number>()
  const varAtom = new Map<number, Atom>()
  const litMemo = new Map<number, number>() // formula id → defining literal
  let trueVar = 0

  const fresh = () => ++numVars
  const getTrue = () => {
    if (trueVar === 0) {
      trueVar = fresh()
      clauses.push([trueVar])
    }
    return trueVar
  }

  const atomLit = (a: Atom): number => {
    let v = atomVar.get(a.id)
    if (v === undefined) {
      v = fresh()
      atomVar.set(a.id, v)
      varAtom.set(v, a)
    }
    return v
  }

  const lit = (f: Formula): number => {
    switch (f.kind) {
      case 'const':
        return f.val ? getTrue() : -getTrue()
      case 'not':
        return -lit(f.arg)
      case 'pred':
      case 'eq':
      case 'arith':
        return atomLit(f)
    }
    // compound connective — memoize a defining variable
    const hit = litMemo.get(f.id)
    if (hit !== undefined) return hit
    const v = fresh()
    litMemo.set(f.id, v)
    switch (f.kind) {
      case 'and': {
        const ls = f.args.map(lit)
        for (const l of ls) clauses.push([-v, l]) // v → each
        clauses.push([v, ...ls.map((l) => -l)]) // all → v
        break
      }
      case 'or': {
        const ls = f.args.map(lit)
        clauses.push([-v, ...ls]) // v → ∨
        for (const l of ls) clauses.push([v, -l]) // each → v
        break
      }
      case 'iff': {
        const a = lit(f.a)
        const b = lit(f.b)
        clauses.push([-v, -a, b], [-v, a, -b], [v, -a, -b], [v, a, b])
        break
      }
      case 'ite': {
        const c = lit(f.c)
        const t = lit(f.t)
        const e = lit(f.e)
        clauses.push([-c, -v, t], [-c, v, -t], [c, -v, e], [c, v, -e])
        break
      }
    }
    return v
  }

  const rootLit = lit(root)
  clauses.push([rootLit]) // assert the formula
  return { numVars, clauses, atomVar, varAtom, rootLit }
}
