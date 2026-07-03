// The relational model the worst-case-optimal join operates over.
//
// A `Relation` is a **set** of tuples over a named schema of *variables* (join
// attributes). It is deliberately tiny and independent of the SQL engine's
// catalog — the WCOJ pillar is standalone, exactly like `vectorized/*`,
// `ivm/*`, and `sketch/*` — but it reuses the engine's own total order
// (`orderValues`) and equality (`valuesEqual`) so that *every* value type the
// database supports (numbers, strings, DECIMAL, temporal, JSON, arrays, …)
// participates in a join, not just numbers.

import { orderValues, type SqlValue } from '../types'

export type Tuple = SqlValue[]

/** A total order over whole tuples, position by position (the engine's order). */
export function compareTuples(a: Tuple, b: Tuple): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const c = orderValues(a[i], b[i])
    if (c !== 0) return c
  }
  return a.length - b.length
}

export function tuplesEqual(a: Tuple, b: Tuple): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (orderValues(a[i], b[i]) !== 0) return false
  return true
}

/**
 * A relation over a schema of variable names. Tuples are stored as a *set*:
 * duplicates are removed at construction (a join over relations, in the WCOJ
 * model, is set-semantic — matching a SQL `SELECT DISTINCT`).
 */
export class Relation {
  /** The variable names, one per tuple column, in this relation's own order. */
  readonly vars: string[]
  /** The deduplicated tuples (not necessarily sorted; the trie sorts them). */
  readonly tuples: Tuple[]

  constructor(vars: string[], tuples: Tuple[]) {
    this.vars = vars
    // Deduplicate. The set is keyed on the engine's total order, so two tuples
    // that are *equal* under SQL semantics (e.g. DECIMAL 1.0 vs 1.00) collapse.
    const sorted = tuples.slice().sort(compareTuples)
    const out: Tuple[] = []
    for (const t of sorted) {
      if (t.length !== vars.length) {
        throw new Error(`relation over [${vars.join(',')}] got a ${t.length}-arity tuple`)
      }
      if (out.length === 0 || !tuplesEqual(out[out.length - 1], t)) out.push(t)
    }
    this.tuples = out
  }

  get arity(): number {
    return this.vars.length
  }
  get size(): number {
    return this.tuples.length
  }

  /** The index of a variable in this relation's schema, or -1. */
  indexOf(v: string): number {
    return this.vars.indexOf(v)
  }
  has(v: string): boolean {
    return this.vars.includes(v)
  }
}

/** Build a relation from rows of plain values, labelling the columns. */
export function relation(vars: string[], rows: Tuple[]): Relation {
  return new Relation(vars, rows)
}
