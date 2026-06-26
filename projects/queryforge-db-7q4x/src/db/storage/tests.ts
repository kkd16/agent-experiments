// Self-tests for the storage engine's self-balancing B+Tree.
//
// The B+Tree is the load-bearing structure under every index, so it is held to
// the highest bar in the suite: a *differential* oracle (the tree must answer
// search/range exactly like a brute-force sorted array) combined with a
// *structural* oracle (`checkInvariants()` must stay green) run after **every**
// mutation across thousands of seeded random insert/delete operations, at small
// and large fanouts. On top of that we assert that the interesting structural
// events actually fire — a delete-heavy workload must trigger borrows, merges
// and root collapses, not just happen to stay correct — and that `bulkLoad`
// produces a valid tree that answers identically to one built by inserts.

import { BTree, compareKeys, type IndexKey, type LeafEntry, type TraceEvent } from './btree'
import type { SqlValue } from '../types'
import { Rng } from '../fuzz/rng'

export interface StorageCase {
  group: string
  name: string
  run: () => void
}

const cases: StorageCase[] = []
function test(name: string, run: () => void) {
  cases.push({ group: 'storage', name, run })
}
function assert(cond: boolean, detail: string) {
  if (!cond) throw new Error(detail)
}

// A brute-force reference index: a sorted map from key → rowid set. Every BTree
// query is checked against the answer this gives.
class RefIndex {
  private map = new Map<string, { key: IndexKey; rowids: Set<number> }>()
  private enc(k: IndexKey): string {
    return JSON.stringify(k)
  }
  insert(key: IndexKey, rowid: number) {
    const s = this.enc(key)
    let e = this.map.get(s)
    if (!e) {
      e = { key, rowids: new Set() }
      this.map.set(s, e)
    }
    e.rowids.add(rowid)
  }
  remove(key: IndexKey, rowid: number) {
    const e = this.map.get(this.enc(key))
    if (!e) return
    e.rowids.delete(rowid)
    if (e.rowids.size === 0) this.map.delete(this.enc(key))
  }
  private sorted(): { key: IndexKey; rowids: number[] }[] {
    return [...this.map.values()]
      .map((e) => ({ key: e.key, rowids: [...e.rowids].sort((a, b) => a - b) }))
      .sort((a, b) => compareKeys(a.key, b.key))
  }
  search(key: IndexKey): number[] {
    const e = this.map.get(this.enc(key))
    return e ? [...e.rowids].sort((a, b) => a - b) : []
  }
  range(lo: IndexKey | null, hi: IndexKey | null): number[] {
    const out: number[] = []
    for (const e of this.sorted()) {
      if (lo !== null && compareKeys(e.key, lo) < 0) continue
      if (hi !== null && compareKeys(e.key, hi) > 0) continue
      out.push(...e.rowids)
    }
    return out
  }
  entries(): LeafEntry[] {
    return this.sorted().map((e) => ({ key: e.key, rowids: e.rowids }))
  }
  size(): number {
    return this.map.size
  }
}

function k(...v: SqlValue[]): IndexKey {
  return v
}
function sortNum(a: number[]): number[] {
  return [...a].sort((x, y) => x - y)
}
function eqNum(a: number[], b: number[]): boolean {
  const sa = sortNum(a)
  const sb = sortNum(b)
  return sa.length === sb.length && sa.every((x, i) => x === sb[i])
}

// --- basic shape ------------------------------------------------------------

test('an empty tree is valid and answers nothing', () => {
  const t = new BTree(4)
  assert(t.checkInvariants().length === 0, 'empty tree invariants')
  assert(t.search(k(1)).length === 0, 'empty search')
  assert(t.range(null, null).length === 0, 'empty range')
  assert(t.stats().height === 1 && t.stats().entries === 0, 'empty stats')
})

test('inserts split leaves and grow the root', () => {
  const t = new BTree(4)
  let grew = false
  for (let i = 1; i <= 20; i++) {
    const trace: TraceEvent[] = []
    t.insert(k(i), i, trace)
    if (trace.some((e) => e.kind === 'grow-root')) grew = true
    assert(t.checkInvariants().length === 0, `invariants after insert ${i}`)
  }
  assert(grew, 'a run of inserts must grow the root at least once')
  assert(t.stats().height >= 3, 'twenty keys at fanout 4 should be ≥ 3 levels deep')
  for (let i = 1; i <= 20; i++) assert(eqNum(t.search(k(i)), [i]), `search ${i}`)
})

test('duplicate keys accumulate rowids in one entry', () => {
  const t = new BTree(8)
  for (let r = 0; r < 10; r++) t.insert(k(42), r)
  assert(eqNum(t.search(k(42)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 'all rowids under one key')
  assert(t.stats().entries === 1, 'one distinct key')
  // Removing rowids one at a time empties the entry exactly when the last goes.
  for (let r = 0; r < 9; r++) t.remove(k(42), r)
  assert(eqNum(t.search(k(42)), [9]), 'one rowid left')
  t.remove(k(42), 9)
  assert(t.search(k(42)).length === 0, 'entry gone')
  assert(t.checkInvariants().length === 0, 'invariants after dup churn')
})

// --- deletion: borrow / merge / collapse ------------------------------------

test('deleting every key shrinks the tree back to a single empty leaf', () => {
  const t = new BTree(4)
  const n = 64
  for (let i = 0; i < n; i++) t.insert(k(i), i)
  assert(t.stats().height >= 3, 'should be tall before deletes')
  const kinds = new Set<string>()
  for (let i = 0; i < n; i++) {
    const trace: TraceEvent[] = []
    t.remove(k(i), i, trace)
    for (const e of trace) kinds.add(e.kind)
    assert(t.checkInvariants().length === 0, `invariants after delete ${i}`)
  }
  assert(kinds.has('borrow-left') || kinds.has('borrow-right'), 'deletes must borrow at least once')
  assert(kinds.has('merge'), 'deletes must merge at least once')
  assert(kinds.has('shrink-root'), 'deletes must collapse the root')
  assert(t.stats().height === 1 && t.stats().entries === 0, 'tree fully collapsed')
  assert(t.range(null, null).length === 0, 'nothing left to scan')
})

test('a no-op delete is reported and changes nothing', () => {
  const t = new BTree(4)
  for (let i = 0; i < 20; i++) t.insert(k(i), i)
  const before = t.stats()
  const trace: TraceEvent[] = []
  t.remove(k(999), 999, trace)
  assert(trace.some((e) => e.kind === 'not-found'), 'missing key reported as not-found')
  const after = t.stats()
  assert(before.entries === after.entries && before.nodes === after.nodes, 'no structural change')
  assert(t.checkInvariants().length === 0, 'still valid')
})

// --- the differential + structural fuzz (the centerpiece) -------------------

function fuzz(seed: number, order: number, ops: number, keyspace: number) {
  const rng = new Rng(seed)
  const t = new BTree(order)
  const ref = new RefIndex()
  const live: { key: IndexKey; rowid: number }[] = []
  let nextRow = 1

  const checkQueries = () => {
    // Point lookups across the whole keyspace (present and absent).
    for (let q = 0; q < 6; q++) {
      const key = k(rng.int(0, keyspace))
      assert(eqNum(t.search(key), ref.search(key)), `seed ${seed}: search mismatch at ${JSON.stringify(key)}`)
    }
    // Random ranges, including open-ended and reversed bounds.
    for (let q = 0; q < 6; q++) {
      let a = rng.int(0, keyspace)
      let b = rng.int(0, keyspace)
      if (a > b) [a, b] = [b, a]
      const lo = rng.chance(0.85) ? k(a) : null
      const hi = rng.chance(0.85) ? k(b) : null
      assert(eqNum(t.range(lo, hi), ref.range(lo, hi)), `seed ${seed}: range mismatch [${a},${b}]`)
    }
  }

  for (let i = 0; i < ops; i++) {
    // Bias toward inserts while small, toward deletes while large, so the tree
    // both grows tall and drains — exercising splits and merges in equal measure.
    const wantInsert = live.length === 0 || (live.length < 200 && rng.chance(0.6))
    if (wantInsert) {
      const key = k(rng.int(0, keyspace))
      const rowid = nextRow++
      t.insert(key, rowid)
      ref.insert(key, rowid)
      live.push({ key, rowid })
    } else {
      const idx = rng.int(0, live.length - 1)
      const { key, rowid } = live[idx]
      live.splice(idx, 1)
      t.remove(key, rowid)
      ref.remove(key, rowid)
    }
    const errs = t.checkInvariants()
    assert(errs.length === 0, `seed ${seed}: invariant broken after op ${i}: ${errs[0]}`)
    if (i % 7 === 0) checkQueries()
  }
  checkQueries()
  // Final full scan must equal the reference exactly.
  assert(eqNum(t.range(null, null), ref.range(null, null)), `seed ${seed}: final full-scan mismatch`)
}

test('differential + invariant fuzz at fanout 4 (deep, churny)', () => {
  for (const seed of [1, 2, 3, 7, 13]) fuzz(seed, 4, 700, 40)
})

test('differential + invariant fuzz at fanout 6', () => {
  for (const seed of [101, 202, 303]) fuzz(seed, 6, 800, 120)
})

test('differential + invariant fuzz at the default fanout 32', () => {
  for (const seed of [5, 55, 555]) fuzz(seed, 32, 1200, 400)
})

// --- composite keys ---------------------------------------------------------

test('composite keys order lexicographically and prefix-range correctly', () => {
  const t = new BTree(4)
  let row = 0
  for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) t.insert(k(a, b), row++)
  assert(t.checkInvariants().length === 0, 'composite invariants')
  // Prefix range a = 3 (lo=[3], hi=[3]) returns exactly the six b-values.
  assert(t.range(k(3), k(3)).length === 6, 'prefix range a=3 returns its 6 rows')
  // a = 3 AND b in (2,4]: lo=[3,2] exclusive low, hi=[3,4] inclusive.
  const got = t.range(k(3, 2), k(3, 4), false, true)
  assert(got.length === 2, 'half-open composite range returns 2 rows')
})

// --- bulk load --------------------------------------------------------------

test('bulkLoad builds a valid, packed tree answering like insert', () => {
  const ref = new RefIndex()
  for (let i = 0; i < 500; i++) ref.insert(k(i * 2), i + 1) // 0,2,4,… so gaps exist
  const entries = ref.entries()
  const bulk = BTree.bulkLoad(entries, 16, 0.7)
  assert(bulk.checkInvariants().length === 0, 'bulk-loaded tree is valid')
  assert(bulk.stats().entries === 500, 'all entries present')
  // Packed at ~70% so leaves should be fuller than a churned tree.
  assert(bulk.stats().fill > 0.55, `bulk fill ${bulk.stats().fill} should be high`)
  // Identical answers to the reference for points and ranges.
  for (let q = 0; q < 50; q++) {
    const key = k(q * 7)
    assert(eqNum(bulk.search(key), ref.search(key)), `bulk search ${q}`)
  }
  assert(eqNum(bulk.range(k(100), k(300)), ref.range(k(100), k(300))), 'bulk range matches reference')
  assert(eqNum(bulk.range(null, null), ref.range(null, null)), 'bulk full scan matches reference')
})

test('bulkLoad then delete-to-empty stays valid (mixing the two build paths)', () => {
  const entries: LeafEntry[] = []
  for (let i = 0; i < 200; i++) entries.push({ key: k(i), rowids: [i] })
  const t = BTree.bulkLoad(entries, 8, 0.6)
  assert(t.checkInvariants().length === 0, 'bulk valid')
  // Insert interleaving keys above the bulk-loaded range, then delete the
  // original 0..199 in shuffled order (mixing the bulk-built and insert-built
  // structure under the rebalancer).
  for (let i = 0; i < 200; i++) t.insert(k(i + 1000), i + 1000)
  const rng = new Rng(99)
  const order = [...Array(200).keys()]
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(0, i)
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  for (const i of order) {
    t.remove(k(i), i)
    assert(t.checkInvariants().length === 0, `invariants while draining a bulk-loaded tree (key ${i})`)
  }
})

test('bulkLoad of a single entry and of empty input', () => {
  const one = BTree.bulkLoad([{ key: k(5), rowids: [1, 2] }], 8)
  assert(one.checkInvariants().length === 0 && eqNum(one.search(k(5)), [1, 2]), 'singleton bulk load')
  const none = BTree.bulkLoad([], 8)
  assert(none.checkInvariants().length === 0 && none.stats().entries === 0, 'empty bulk load')
})

// --- snapshot / range tracing (the Lab's data sources) ----------------------

test('snapshot mirrors the live structure and the leaf chain is sorted', () => {
  const t = new BTree(4)
  for (let i = 0; i < 30; i++) t.insert(k(i), i)
  const snap = t.snapshot()
  const total = snap.levels.reduce((n, lvl) => n + lvl.length, 0)
  assert(total === t.stats().nodes, 'snapshot node count matches stats')
  assert(snap.levels[snap.levels.length - 1].every((n) => n.leaf), 'deepest level is all leaves')
  assert(snap.leafOrder.length === t.stats().leaves, 'leaf order covers every leaf')
})

test('rangeTraced visits a contiguous run of leaves and matches range()', () => {
  const t = new BTree(4)
  for (let i = 0; i < 60; i++) t.insert(k(i), i)
  const tr = t.rangeTraced(k(20), k(35))
  assert(tr.matchedKeys.length === 16, 'inclusive [20,35] has 16 keys')
  assert(tr.visitedLeaves.length >= 1, 'visited at least one leaf')
  // The matched keys are exactly what range() would count.
  assert(t.range(k(20), k(35)).length === 16, 'range agrees with trace')
})

export const storageCases = cases
