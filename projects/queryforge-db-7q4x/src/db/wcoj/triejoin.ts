// The **Leapfrog Triejoin** driver — a full worst-case-optimal join over a
// conjunctive (natural-join) query. It eliminates variables one at a time in a
// fixed global order: at each variable it leapfrog-intersects exactly the
// relations that mention it, and for every common value it `open()`s those
// relations and recurses to the next variable. Total time is `O(AGM bound)` (up
// to a log) — provably the best any join algorithm can achieve on a cyclic query.
//
// A query is a set of atoms `R(x, y, …)`; the join's answer is every assignment
// of the query's variables that is simultaneously present in all atoms.

import type { SqlValue } from '../types'
import { SortedTrie, type TrieIterator } from './trie'
import { LeapfrogJoin } from './leapfrog'
import type { Relation } from './relation'

/** One atom of a conjunctive query: a relation bound to variable names. */
export interface Atom {
  /** A label for the Lab / traces (e.g. the SQL table name). */
  name: string
  relation: Relation
}

export interface TrieJoinResult {
  /** The global variable order actually used. */
  order: string[]
  /** Each answer, as a value per variable in `order`. */
  rows: SqlValue[][]
  /** Named answers (variable → value), convenient for tests / display. */
  bindings: Array<Record<string, SqlValue>>
  /** Number of leapfrog `open()`s performed (a proxy for work done). */
  opens: number
}

/** All variables appearing in the query, deduplicated, first-seen order. */
export function queryVariables(atoms: Atom[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const a of atoms) {
    for (const v of a.relation.vars) {
      if (!seen.has(v)) {
        seen.add(v)
        out.push(v)
      }
    }
  }
  return out
}

/**
 * A cheap, effective variable ordering heuristic: **most-constrained first** —
 * order variables by how many atoms mention them (descending), breaking ties by
 * first appearance. Intersecting the most-shared variable earliest prunes the
 * search fastest. (The join is correct under *any* order; only speed changes.)
 */
export function chooseOrder(atoms: Atom[]): string[] {
  const vars = queryVariables(atoms)
  const degree = new Map<string, number>()
  for (const v of vars) degree.set(v, atoms.filter((a) => a.relation.has(v)).length)
  return vars
    .map((v, i) => ({ v, i }))
    .sort((a, b) => degree.get(b.v)! - degree.get(a.v)! || a.i - b.i)
    .map((x) => x.v)
}

/** Run the leapfrog triejoin. If `order` is omitted, the heuristic chooses one. */
export function triejoin(atoms: Atom[], order?: string[]): TrieJoinResult {
  const varOrder = order ?? chooseOrder(atoms)

  // Build one sorted trie per atom, and the set of iterators active at each
  // global level (the atoms that mention that variable).
  const tries = atoms.map((a) => new SortedTrie(a.relation, varOrder))
  const iters = tries.map((t) => t.iterator())
  const activeAt: TrieIterator[][] = varOrder.map((v) =>
    iters.filter((_, i) => atoms[i].relation.has(v)),
  )

  const rows: SqlValue[][] = []
  const bindings: Array<Record<string, SqlValue>> = []
  const binding: SqlValue[] = new Array(varOrder.length).fill(null)
  let opens = 0

  const recurse = (gi: number): void => {
    if (gi === varOrder.length) {
      rows.push(binding.slice())
      const b: Record<string, SqlValue> = {}
      for (let i = 0; i < varOrder.length; i++) b[varOrder[i]] = binding[i]
      bindings.push(b)
      return
    }
    const active = activeAt[gi]
    // A variable with no atoms (shouldn't happen for a connected query) is free;
    // an empty active set means the leapfrog is immediately empty → no rows.
    const lf = new LeapfrogJoin(active.slice())
    lf.init()
    while (!lf.atEnd()) {
      binding[gi] = lf.key()
      for (const it of active) {
        it.open()
        opens++
      }
      recurse(gi + 1)
      for (const it of active) it.up()
      lf.next()
    }
    binding[gi] = null
  }

  if (varOrder.length === 0) {
    // The empty join (no variables): the answer is the single empty tuple iff
    // every atom is non-empty. Rare, but keep it total.
    if (atoms.every((a) => a.relation.size > 0)) {
      rows.push([])
      bindings.push({})
    }
  } else {
    recurse(0)
  }

  return { order: varOrder, rows, bindings, opens }
}
