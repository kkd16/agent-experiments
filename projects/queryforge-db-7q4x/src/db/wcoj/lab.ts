// The Lab driver: run both engines on an instance and package everything the
// WCOJ Lab renders — the two answers (equal, by construction), the AGM bound and
// the fractional cover, the binary-join intermediate blow-up, and a
// per-variable **elimination trace** that shows the leapfrog intersecting the
// active relations one variable at a time.

import { formatValue, orderValues, type SqlValue } from '../types'
import { triejoin, chooseOrder, type Atom } from './triejoin'
import { binaryJoin } from './binary'
import { agmBound, fractionalCover } from './agm'
import { SortedTrie } from './trie'
import { LeapfrogJoin } from './leapfrog'
import { relation } from './relation'

export interface WcojReport {
  order: string[]
  outputSize: number
  opens: number
  agm: { bound: number; logBound: number; weights: number[] }
  cover: { rho: number; weights: number[] }
  binary: {
    maxIntermediate: number
    intermediates: Array<{ joined: string; size: number }>
  }
  /** How much bigger the biggest binary intermediate is than the true answer. */
  blowup: number
  atoms: Array<{ name: string; vars: string[]; size: number }>
  agree: boolean
}

/** Sorted, de-duplicated string keys for two answer sets, to compare equality. */
function answerKeys(rows: SqlValue[][]): string[] {
  return rows.map((r) => r.map((v) => formatValue(v)).join('')).sort()
}

export function wcojReport(atoms: Atom[]): WcojReport {
  const order = chooseOrder(atoms)
  const tj = triejoin(atoms, order)
  const bj = binaryJoin(atoms)
  const agm = agmBound(atoms)
  const cover = fractionalCover(atoms)

  const a = answerKeys(tj.rows)
  const b = answerKeys(bj.rows)
  const agree = a.length === b.length && a.every((x, i) => x === b[i])

  const outputSize = tj.rows.length
  return {
    order,
    outputSize,
    opens: tj.opens,
    agm: { bound: agm.bound, logBound: agm.logBound, weights: agm.weights },
    cover: { rho: cover.rho, weights: cover.weights },
    binary: {
      maxIntermediate: bj.maxIntermediate,
      intermediates: bj.intermediates.map((s) => ({ joined: s.joined, size: s.size })),
    },
    blowup: outputSize > 0 ? bj.maxIntermediate / outputSize : bj.maxIntermediate,
    atoms: atoms.map((at) => ({ name: at.name, vars: at.relation.vars, size: at.relation.size })),
    agree,
  }
}

export interface EliminationLevel {
  variable: string
  /** The atoms active at this variable and the candidate values each offers,
   *  at the *first* entry into this level (root context). */
  candidates: Array<{ atom: string; values: string[] }>
  /** The leapfrog intersection of those candidates (the surviving values). */
  intersection: string[]
}

/**
 * A didactic, root-context elimination trace: for each variable in order, show
 * every active relation's *distinct first-level values* and the leapfrog
 * intersection of them. (This is the intersection at the top of the search;
 * deeper levels narrow further.) Meant for small Lab instances.
 */
export function eliminationTrace(atoms: Atom[], order?: string[]): EliminationLevel[] {
  const varOrder = order ?? chooseOrder(atoms)
  const out: EliminationLevel[] = []
  for (const v of varOrder) {
    const active = atoms.filter((a) => a.relation.has(v))
    const candidates = active.map((a) => {
      // Distinct values of `v` in this atom (its first trie level once reordered
      // so `v` leads — but for display we just collect column values directly).
      const idx = a.relation.indexOf(v)
      const vals = Array.from(
        new Set(a.relation.tuples.map((t) => formatValue(t[idx]))),
      )
      // Sort by the engine order for a stable display.
      vals.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
      return { atom: a.name, values: vals }
    })
    // The leapfrog intersection over single-column tries on `v`.
    const iters = active.map((a) => new SortedTrie(relation([v], dedupColumn(a, v)), [v]).iterator())
    const lf = new LeapfrogJoin(iters)
    const inter = lf.collect().map((x) => formatValue(x))
    out.push({ variable: v, candidates, intersection: inter })
  }
  return out
}

/** Distinct one-column tuples of variable `v` from an atom, as a mini-relation. */
function dedupColumn(a: Atom, v: string): SqlValue[][] {
  const idx = a.relation.indexOf(v)
  const seen = new Set<string>()
  const out: SqlValue[][] = []
  for (const t of a.relation.tuples) {
    const key = formatValue(t[idx])
    if (!seen.has(key)) {
      seen.add(key)
      out.push([t[idx]])
    }
  }
  out.sort((x, y) => orderValues(x[0], y[0]))
  return out
}
