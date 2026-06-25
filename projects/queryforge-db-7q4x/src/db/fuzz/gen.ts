// The random *predicate* generator and a small predicate AST. Oracles are built by
// composing a predicate over a table with a few SQL templates, so we keep the
// predicate as a structured value (not a string): it renders to SQL, and — crucially
// for the shrinker — it can be structurally *simplified* (drop a conjunct, peel a NOT)
// while we re-check whether a counterexample survives.

import type { SqlValue } from '../types'
import type { Rng } from './rng'
import type { GCol, GColType, GTable } from './schema'
import { litSql } from './schema'

export type Pred =
  | { k: 'cmp'; col: string; op: '=' | '<>' | '<' | '<=' | '>' | '>='; val: SqlValue }
  | { k: 'null'; col: string; neg: boolean }
  | { k: 'between'; col: string; lo: SqlValue; hi: SqlValue }
  | { k: 'in'; col: string; vals: SqlValue[] }
  | { k: 'like'; col: string; pat: string }
  | { k: 'and'; l: Pred; r: Pred }
  | { k: 'or'; l: Pred; r: Pred }
  | { k: 'not'; p: Pred }
  | { k: 'lit'; val: boolean }

const CMP_OPS = ['=', '<>', '<', '<=', '>', '>='] as const

/** A plausible literal for a column — biased toward its data domain so predicates
 *  actually select some rows (but still occasionally out of range). */
function literalFor(rng: Rng, type: GColType): SqlValue {
  switch (type) {
    case 'INTEGER':
      return rng.int(-1, 7)
    case 'REAL':
      return rng.int(-1, 9) / 2
    case 'TEXT':
      return rng.pick(['a', 'b', 'c', 'ab', 'aa', 'z', ''])
    case 'BOOLEAN':
      return rng.chance()
  }
}

/** A single (leaf) predicate over one column. */
function genAtom(rng: Rng, cols: GCol[]): Pred {
  const col = rng.pick(cols)
  const choices: Array<() => Pred> = [
    () => ({ k: 'cmp', col: col.name, op: rng.pick(CMP_OPS), val: literalFor(rng, col.type) }),
    () => ({ k: 'null', col: col.name, neg: rng.chance() }),
    () => ({
      k: 'between',
      col: col.name,
      lo: literalFor(rng, col.type),
      hi: literalFor(rng, col.type),
    }),
    () => ({
      k: 'in',
      col: col.name,
      vals: Array.from({ length: rng.int(1, 3) }, () => literalFor(rng, col.type)),
    }),
  ]
  // LIKE only makes sense on TEXT.
  if (col.type === 'TEXT') {
    choices.push(() => ({ k: 'like', col: col.name, pat: rng.pick(['a%', '%a%', '_', 'a', '%']) }))
  }
  return rng.pick(choices)()
}

/** A random predicate tree of bounded depth (AND/OR/NOT over atoms). */
export function genPred(rng: Rng, cols: GCol[], depth = 0): Pred {
  if (depth >= 3 || rng.chance(0.45)) return genAtom(rng, cols)
  const r = rng.next()
  if (r < 0.35) return { k: 'and', l: genPred(rng, cols, depth + 1), r: genPred(rng, cols, depth + 1) }
  if (r < 0.7) return { k: 'or', l: genPred(rng, cols, depth + 1), r: genPred(rng, cols, depth + 1) }
  return { k: 'not', p: genPred(rng, cols, depth + 1) }
}

/** Render a predicate to SQL, qualifying column names with `alias.` when given. */
export function predToSql(p: Pred, alias = ''): string {
  const q = alias ? `${alias}.` : ''
  switch (p.k) {
    case 'cmp':
      return `${q}${p.col} ${p.op} ${litSql(p.val)}`
    case 'null':
      return `${q}${p.col} IS ${p.neg ? 'NOT NULL' : 'NULL'}`
    case 'between':
      return `${q}${p.col} BETWEEN ${litSql(p.lo)} AND ${litSql(p.hi)}`
    case 'in':
      return `${q}${p.col} IN (${p.vals.map(litSql).join(', ')})`
    case 'like':
      return `${q}${p.col} LIKE ${litSql(p.pat)}`
    case 'and':
      return `(${predToSql(p.l, alias)} AND ${predToSql(p.r, alias)})`
    case 'or':
      return `(${predToSql(p.l, alias)} OR ${predToSql(p.r, alias)})`
    case 'not':
      return `(NOT ${predToSql(p.p, alias)})`
    case 'lit':
      return p.val ? 'TRUE' : 'FALSE'
  }
}

/** All structurally-simpler predicates, for the delta-debugging shrinker. */
export function simplerPreds(p: Pred): Pred[] {
  const out: Pred[] = []
  switch (p.k) {
    case 'and':
    case 'or':
      out.push(p.l, p.r) // drop one side
      for (const l2 of simplerPreds(p.l)) out.push({ ...p, l: l2 })
      for (const r2 of simplerPreds(p.r)) out.push({ ...p, r: r2 })
      break
    case 'not':
      out.push(p.p) // peel the negation
      for (const p2 of simplerPreds(p.p)) out.push({ k: 'not', p: p2 })
      break
    case 'in':
      if (p.vals.length > 1) {
        for (let i = 0; i < p.vals.length; i++) {
          out.push({ ...p, vals: p.vals.filter((_, j) => j !== i) })
        }
      }
      break
    default:
      break
  }
  return out
}

/** A projection over a table: either `*`, or a random subset of the data columns
 *  (which — unlike the unique `id` — can contain duplicate rows, stressing the
 *  multiset semantics the oracles depend on). */
export function genProjection(rng: Rng, table: GTable): string[] {
  if (rng.chance(0.4) || table.cols.length === 0) return ['*']
  return rng.subset(table.cols.map((c) => c.name))
}
