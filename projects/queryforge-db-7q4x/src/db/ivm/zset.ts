// Z-sets — the algebraic substrate of incremental view maintenance.
//
// A *Z-set* (after the DBSP model, Budiu et al., "DBSP: Automatic Incremental
// View Maintenance for Rich Query Languages", VLDB 2023) is a collection where
// every tuple carries an integer *weight*. A weight of +n means "this row is
// present with multiplicity n"; a negative weight means "this row is being
// retracted n times". An ordinary SQL bag (a multiset — what a non-DISTINCT
// SELECT returns) is exactly a Z-set whose weights are all ≥ 0; a *delta* (the
// change a base-table mutation makes to a view) is a Z-set with mixed signs.
//
// The whole point: relational operators (σ filter, π project, ⋈ join) become
// linear (or bilinear) maps over Z-sets, so the *change* to a query's output
// can be computed from the *change* to its inputs without recomputing the whole
// query. This file is the value layer; `dataflow.ts` builds the operators on it.
//
// Tuples are keyed by the engine's canonical `hashKey`, so every first-class
// value the engine supports — decimals, temporals, JSON, arrays, tsvectors —
// collapses duplicates correctly and identically to the rest of the engine.

import { hashKey } from '../types'
import type { Row } from '../catalog'

export interface ZSetEntry {
  /** The tuple. Never mutated in place once stored. */
  row: Row
  /** Its integer weight (multiplicity); the map never holds a zero-weight key. */
  weight: number
}

/** A weighted bag of rows. Zero-weight tuples are eagerly pruned so that two
 *  Z-sets are equal iff their backing maps are equal key-for-key. */
export class ZSet {
  private readonly m = new Map<string, ZSetEntry>()

  /** Number of distinct tuples currently held (regardless of weight). */
  get distinctSize(): number {
    return this.m.size
  }

  isEmpty(): boolean {
    return this.m.size === 0
  }

  /** Add `weight` copies of `row` (default +1). Prunes the key when it hits 0. */
  add(row: Row, weight = 1): void {
    if (weight === 0) return
    const k = hashKey(row)
    const cur = this.m.get(k)
    if (!cur) {
      this.m.set(k, { row, weight })
      return
    }
    const w = cur.weight + weight
    if (w === 0) this.m.delete(k)
    else cur.weight = w
  }

  /** The weight of `row` (0 if absent). */
  weightOf(row: Row): number {
    return this.m.get(hashKey(row))?.weight ?? 0
  }

  entries(): IterableIterator<ZSetEntry> {
    return this.m.values()
  }

  /** Fold every (positive-weight) copy of every tuple into a flat bag of rows —
   *  the materialized contents of a view. Negative weights would mean the Z-set
   *  is not a valid bag; we surface that loudly rather than silently dropping it. */
  toRows(): Row[] {
    const out: Row[] = []
    for (const e of this.m.values()) {
      if (e.weight < 0) {
        throw new Error(`ZSet.toRows: tuple has negative weight ${e.weight} — not a valid bag`)
      }
      for (let i = 0; i < e.weight; i++) out.push(e.row)
    }
    return out
  }

  /** A deep-ish copy (entries are fresh; rows are shared, treated immutable). */
  clone(): ZSet {
    const z = new ZSet()
    for (const e of this.m.values()) z.m.set(hashKey(e.row), { row: e.row, weight: e.weight })
    return z
  }

  /** this += other (mutating). */
  addZSet(other: ZSet): void {
    for (const e of other.m.values()) this.add(e.row, e.weight)
  }

  /** A new Z-set with every weight multiplied by `k` (k = -1 negates / retracts). */
  scale(k: number): ZSet {
    const z = new ZSet()
    if (k !== 0) for (const e of this.m.values()) z.m.set(hashKey(e.row), { row: e.row, weight: e.weight * k })
    return z
  }

  /** Build a Z-set from a plain bag of rows, each at weight `weight` (default +1). */
  static fromRows(rows: Iterable<Row>, weight = 1): ZSet {
    const z = new ZSet()
    for (const r of rows) z.add(r, weight)
    return z
  }
}

/** Multiset (bag) equality of two row collections, using the canonical hash.
 *  Order-independent — the right notion of equality for an unordered view. */
export function bagEqual(a: Iterable<Row>, b: Iterable<Row>): boolean {
  const counts = new Map<string, number>()
  let na = 0
  for (const r of a) {
    counts.set(hashKey(r), (counts.get(hashKey(r)) ?? 0) + 1)
    na++
  }
  let nb = 0
  for (const r of b) {
    const k = hashKey(r)
    const c = counts.get(k)
    if (c === undefined) return false
    if (c === 1) counts.delete(k)
    else counts.set(k, c - 1)
    nb++
  }
  return na === nb && counts.size === 0
}

/** A human-readable count of how the two bags differ (for test diagnostics). */
export function bagDiff(a: Row[], b: Row[]): { onlyA: number; onlyB: number } {
  const counts = new Map<string, number>()
  for (const r of a) counts.set(hashKey(r), (counts.get(hashKey(r)) ?? 0) + 1)
  for (const r of b) counts.set(hashKey(r), (counts.get(hashKey(r)) ?? 0) - 1)
  let onlyA = 0
  let onlyB = 0
  for (const v of counts.values()) {
    if (v > 0) onlyA += v
    else if (v < 0) onlyB += -v
  }
  return { onlyA, onlyB }
}
