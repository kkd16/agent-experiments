// A **binary-join reference**: a classical left-deep hash-join plan that joins
// two relations at a time, the way every textbook optimizer does. It serves two
// purposes for the WCOJ pillar:
//
//   1. a differential **oracle** — its answer set must equal the triejoin's, so
//      any triejoin bug is caught immediately;
//   2. a **blow-up meter** — it records the size of every intermediate result,
//      so the Lab can show the `N²` intermediate a worst-case-optimal join never
//      materialises on a cyclic query.
//
// The join order is greedy: repeatedly pick the next atom that shares the most
// variables with the accumulated result (a cheap connected order) — a fair,
// non-adversarial stand-in for a real planner.

import { hashKey, type SqlValue } from '../types'
import type { Atom } from './triejoin'
import { queryVariables } from './triejoin'

export interface BinaryJoinResult {
  /** The variable order of the output columns. */
  vars: string[]
  /** The answer rows (one value per `vars`). */
  rows: SqlValue[][]
  /** Size of the running result after each atom is joined in (steps). */
  intermediates: Array<{ joined: string; size: number; vars: string[] }>
  /** The largest intermediate — the number a WCOJ is proven never to exceed. */
  maxIntermediate: number
}

/** Greedy connected join order: maximise shared variables at each step. */
function joinOrder(atoms: Atom[]): number[] {
  const n = atoms.length
  if (n === 0) return []
  const used = new Array(n).fill(false)
  // Start from the smallest relation.
  let start = 0
  for (let i = 1; i < n; i++) if (atoms[i].relation.size < atoms[start].relation.size) start = i
  const order = [start]
  used[start] = true
  const cur = new Set(atoms[start].relation.vars)
  while (order.length < n) {
    let best = -1
    let bestShared = -1
    for (let i = 0; i < n; i++) {
      if (used[i]) continue
      const shared = atoms[i].relation.vars.filter((v) => cur.has(v)).length
      if (shared > bestShared || (shared === bestShared && best !== -1 && atoms[i].relation.size < atoms[best].relation.size)) {
        bestShared = shared
        best = i
      }
    }
    used[best] = true
    order.push(best)
    for (const v of atoms[best].relation.vars) cur.add(v)
  }
  return order
}

export function binaryJoin(atoms: Atom[]): BinaryJoinResult {
  const order = joinOrder(atoms)
  const allVars = queryVariables(atoms)
  const intermediates: BinaryJoinResult['intermediates'] = []

  if (order.length === 0) {
    return { vars: allVars, rows: [], intermediates, maxIntermediate: 0 }
  }

  // Running result: rows tagged with their variable list.
  let curVars = atoms[order[0]].relation.vars.slice()
  let curRows: SqlValue[][] = atoms[order[0]].relation.tuples.map((t) => t.slice())
  intermediates.push({ joined: atoms[order[0]].name, size: curRows.length, vars: curVars.slice() })

  for (let s = 1; s < order.length; s++) {
    const atom = atoms[order[s]]
    const rel = atom.relation
    const joinVars = rel.vars.filter((v) => curVars.includes(v))
    const curJoinIdx = joinVars.map((v) => curVars.indexOf(v))
    const relJoinIdx = joinVars.map((v) => rel.indexOf(v))
    // Extra variables the atom contributes.
    const extraVars = rel.vars.filter((v) => !curVars.includes(v))
    const extraIdx = extraVars.map((v) => rel.indexOf(v))

    // Hash the smaller side (the incoming atom) on the join key.
    const buckets = new Map<string, SqlValue[][]>()
    for (const t of rel.tuples) {
      const key = hashKey(relJoinIdx.map((i) => t[i]))
      let arr = buckets.get(key)
      if (!arr) buckets.set(key, (arr = []))
      arr.push(t)
    }
    const nextVars = curVars.concat(extraVars)
    const nextRows: SqlValue[][] = []
    for (const row of curRows) {
      const key = hashKey(curJoinIdx.map((i) => row[i]))
      const matches = buckets.get(key)
      if (!matches) continue
      for (const t of matches) {
        nextRows.push(row.concat(extraIdx.map((i) => t[i])))
      }
    }
    curVars = nextVars
    curRows = nextRows
    intermediates.push({ joined: atom.name, size: curRows.length, vars: curVars.slice() })
  }

  // Reorder columns to the canonical `allVars` order and dedupe.
  const perm = allVars.map((v) => curVars.indexOf(v))
  const seen = new Set<string>()
  const rows: SqlValue[][] = []
  for (const r of curRows) {
    const out = perm.map((i) => r[i])
    const k = hashKey(out)
    if (!seen.has(k)) {
      seen.add(k)
      rows.push(out)
    }
  }
  const maxIntermediate = intermediates.reduce((m, s) => Math.max(m, s.size), 0)
  return { vars: allVars, rows, intermediates, maxIntermediate }
}
