// The counterexample shrinker. A random failing query over 2 tables × 20 rows with a
// deeply-nested predicate is almost useless to a human; a *minimal* one — the fewest
// rows and the simplest predicate that still trips the oracle — is a bug report you can
// paste and fix. This is delta-debugging (Zeller): repeatedly try a smaller variant and
// keep it whenever the failure survives, alternating row-removal and predicate-pruning
// until neither makes progress.

import type { FuzzSchema } from './schema'
import { simplerPreds } from './gen'
import { checkOn, type Counterexample, type FuzzInstance } from './oracles'

function cloneSchema(s: FuzzSchema): FuzzSchema {
  return {
    tables: s.tables.map((t) => ({
      name: t.name,
      cols: t.cols.map((c) => ({ ...c })),
      rows: t.rows.map((r) => r.slice()),
      indexed: t.indexed.slice(),
    })),
  }
}

/** Reduce rows in every table while the oracle still fails. */
function shrinkRows(schema: FuzzSchema, inst: FuzzInstance): boolean {
  let progressed = false
  for (const tbl of schema.tables) {
    let i = 0
    while (i < tbl.rows.length) {
      const removed = tbl.rows[i]
      tbl.rows.splice(i, 1)
      if (checkOn(schema, inst)) {
        progressed = true // failure survived without this row — keep it gone
      } else {
        tbl.rows.splice(i, 0, removed) // row was load-bearing — restore and move on
        i++
      }
    }
  }
  return progressed
}

/** Drop secondary indexes that aren't needed to reproduce. */
function shrinkIndexes(schema: FuzzSchema, inst: FuzzInstance): boolean {
  let progressed = false
  for (const tbl of schema.tables) {
    let i = 0
    while (i < tbl.indexed.length) {
      const removed = tbl.indexed[i]
      tbl.indexed.splice(i, 1)
      if (checkOn(schema, inst)) progressed = true
      else {
        tbl.indexed.splice(i, 0, removed)
        i++
      }
    }
  }
  return progressed
}

/** Replace the predicate with the simplest variant that still fails. */
function shrinkPred(schema: FuzzSchema, inst: FuzzInstance): boolean {
  let progressed = false
  for (;;) {
    let stepped = false
    for (const cand of simplerPreds(inst.pred)) {
      if (checkOn(schema, { ...inst, pred: cand })) {
        inst.pred = cand
        stepped = true
        progressed = true
        break
      }
    }
    if (!stepped) break
  }
  return progressed
}

export interface Shrunk {
  schema: FuzzSchema
  inst: FuzzInstance
  counterexample: Counterexample
}

/** Minimize a failing case. Returns the reduced schema + instance and the (re-checked)
 *  counterexample it still produces. */
export function shrink(schema: FuzzSchema, inst: FuzzInstance): Shrunk {
  const s = cloneSchema(schema)
  const i: FuzzInstance = { ...inst, projection: inst.projection.slice() }
  // Alternate passes until a full round makes no progress (a local minimum).
  for (let round = 0; round < 6; round++) {
    const a = shrinkPred(s, i)
    const b = shrinkRows(s, i)
    const c = shrinkIndexes(s, i)
    if (!a && !b && !c) break
  }
  const ce = checkOn(s, i)
  // checkOn must still fail here (every kept step re-verified it); fall back defensively.
  return { schema: s, inst: i, counterexample: ce ?? checkOn(schema, inst)! }
}
