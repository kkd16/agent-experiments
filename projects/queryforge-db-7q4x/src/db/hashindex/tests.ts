// Self-tests for the dynamic hashing access methods (extendible & linear).
//
// Both are held to the same bar as the B+Tree and the LSM tree: a *differential*
// oracle (every lookup and the full key set must match a brute-force reference
// map) combined with a *structural* oracle (`checkInvariants()` — the
// directory/bucket coupling for extendible, the address-function agreement for
// linear) run after **every** mutation across thousands of seeded random
// insert/delete operations at several bucket capacities. On top of that we assert
// the interesting structural events actually fire — a growing load *must* double
// the directory / bump the level, and a draining one *must* merge buckets and
// halve / step the level down, not merely happen to stay correct. Finally the two
// independent structures are cross-checked against each other, and the hash's
// low-bit distribution (which both route on) is sanity-checked.

import { ExtendibleHash } from './extendible'
import { LinearHash } from './linear'
import { hashKey } from './hash'
import { compareKeys, type IndexKey } from '../storage/btree'
import type { SqlValue } from '../types'
import { Rng } from '../fuzz/rng'

export interface HashIndexCase {
  group: string
  name: string
  run: () => void
}

const cases: HashIndexCase[] = []
function test(name: string, run: () => void) {
  cases.push({ group: 'hashindex', name, run })
}
function assert(cond: boolean, detail: string) {
  if (!cond) throw new Error(detail)
}

function k(...v: SqlValue[]): IndexKey {
  return v
}

// A brute-force reference: key → set of row ids. Every hash-index answer is
// checked against what this gives.
class Ref {
  private map = new Map<string, { key: IndexKey; rowids: Set<number> }>()
  private enc(key: IndexKey): string {
    return JSON.stringify(key)
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
  lookup(key: IndexKey): number[] {
    const e = this.map.get(this.enc(key))
    return e ? [...e.rowids].sort((a, b) => a - b) : []
  }
  entries(): { key: IndexKey; rowids: number[] }[] {
    return [...this.map.values()]
      .map((e) => ({ key: e.key, rowids: [...e.rowids].sort((a, b) => a - b) }))
      .sort((a, b) => compareKeys(a.key, b.key))
  }
  size(): number {
    return this.map.size
  }
}

function sameArr(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function sameEntries(a: { key: IndexKey; rowids: number[] }[], b: { key: IndexKey; rowids: number[] }[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (compareKeys(a[i].key, b[i].key) !== 0) return false
    if (!sameArr(a[i].rowids, b[i].rowids)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Extendible hashing — differential + structural, after every op.
// ---------------------------------------------------------------------------
test('extendible: differential + invariants across random ops', () => {
  for (const cap of [1, 2, 3, 4, 8]) {
    const rng = new Rng(0xe1 + cap * 131)
    const eh = new ExtendibleHash(cap)
    const ref = new Ref()
    const live: { key: IndexKey; rowid: number }[] = []
    for (let step = 0; step < 2500; step++) {
      if (live.length === 0 || rng.chance(0.62)) {
        const key = k(rng.int(0, 80))
        const rowid = rng.int(0, 4000)
        eh.insert(key, rowid)
        ref.insert(key, rowid)
        if (!live.some((l) => compareKeys(l.key, key) === 0 && l.rowid === rowid)) live.push({ key, rowid })
      } else {
        const j = rng.int(0, live.length - 1)
        const { key, rowid } = live[j]
        eh.remove(key, rowid)
        ref.remove(key, rowid)
        live.splice(j, 1)
      }
      const errs = eh.checkInvariants()
      assert(errs.length === 0, `cap ${cap} step ${step}: invariant — ${errs[0]}`)
      const probe = k(rng.int(0, 80))
      assert(sameArr(eh.lookup(probe), ref.lookup(probe)), `cap ${cap} step ${step}: lookup mismatch`)
    }
    assert(sameEntries(eh.entries(), ref.entries()), `cap ${cap}: full entries mismatch`)
    assert(eh.size() === ref.size(), `cap ${cap}: size mismatch ${eh.size()} vs ${ref.size()}`)
  }
})

test('extendible: growth doubles the directory and splits buckets', () => {
  const eh = new ExtendibleHash(2)
  for (let i = 0; i < 400; i++) eh.insert(k(i), i)
  const s = eh.stats()
  assert(s.doublings > 0, 'a load of 400 keys at capacity 2 must double the directory')
  assert(s.splits > 0, 'buckets must split')
  assert(s.buckets > 1, 'more than one bucket after growth')
  assert(s.globalDepth >= 1, 'global depth grew')
  // every key still findable
  for (let i = 0; i < 400; i++) assert(sameArr(eh.lookup(k(i)), [i]), `key ${i} lost after growth`)
  assert(eh.checkInvariants().length === 0, 'valid after growth')
})

test('extendible: draining merges buckets and halves the directory back to one', () => {
  const eh = new ExtendibleHash(2)
  const keys: number[] = []
  for (let i = 0; i < 300; i++) {
    eh.insert(k(i), i)
    keys.push(i)
  }
  const grown = eh.stats()
  assert(grown.globalDepth >= 2, 'index grew deep before draining')
  for (const i of keys) {
    eh.remove(k(i), i)
    assert(eh.checkInvariants().length === 0, `invalid while draining at key ${i}`)
  }
  const s = eh.stats()
  assert(s.merges > 0, 'draining must merge buckets')
  assert(s.halvings > 0, 'draining must halve the directory')
  assert(s.keys === 0, 'empty after draining all keys')
  assert(s.globalDepth === 0 && s.buckets === 1, 'a fully drained index collapses to depth 0, one bucket')
})

test('extendible: non-unique keys keep a row-id set', () => {
  const eh = new ExtendibleHash(2)
  for (const r of [7, 3, 9, 1]) eh.insert(k(42), r)
  assert(sameArr(eh.lookup(k(42)), [1, 3, 7, 9]), 'all rows under one key, sorted')
  eh.remove(k(42), 3)
  assert(sameArr(eh.lookup(k(42)), [1, 7, 9]), 'one row removed, key survives')
  assert(eh.checkInvariants().length === 0, 'valid')
})

// ---------------------------------------------------------------------------
// Linear hashing — differential + structural, after every op.
// ---------------------------------------------------------------------------
test('linear: differential + invariants across random ops', () => {
  for (const cap of [1, 2, 4, 8]) {
    const rng = new Rng(0x11 + cap * 977)
    const lh = new LinearHash({ base: 2, capacity: cap, splitThreshold: 0.8, mergeThreshold: 0.35 })
    const ref = new Ref()
    const live: { key: IndexKey; rowid: number }[] = []
    for (let step = 0; step < 2500; step++) {
      if (live.length === 0 || rng.chance(0.62)) {
        const key = k(rng.int(0, 80))
        const rowid = rng.int(0, 4000)
        lh.insert(key, rowid)
        ref.insert(key, rowid)
        if (!live.some((l) => compareKeys(l.key, key) === 0 && l.rowid === rowid)) live.push({ key, rowid })
      } else {
        const j = rng.int(0, live.length - 1)
        const { key, rowid } = live[j]
        lh.remove(key, rowid)
        ref.remove(key, rowid)
        live.splice(j, 1)
      }
      const errs = lh.checkInvariants()
      assert(errs.length === 0, `cap ${cap} step ${step}: invariant — ${errs[0]}`)
      const probe = k(rng.int(0, 80))
      assert(sameArr(lh.lookup(probe), ref.lookup(probe)), `cap ${cap} step ${step}: lookup mismatch`)
    }
    assert(sameEntries(lh.entries(), ref.entries()), `cap ${cap}: full entries mismatch`)
  }
})

test('linear: growth splits round-robin and bumps the level', () => {
  const lh = new LinearHash({ base: 2, capacity: 4, splitThreshold: 0.8 })
  for (let i = 0; i < 500; i++) lh.insert(k(i), i)
  const s = lh.stats()
  assert(s.splits > 0, 'inserts past the load threshold must split')
  assert(s.level >= 1, 'enough growth must complete a round and bump the level')
  assert(s.buckets === s.base * (1 << s.level) + s.next, 'bucket count matches base·2^L + next')
  for (let i = 0; i < 500; i++) assert(sameArr(lh.lookup(k(i)), [i]), `key ${i} lost after growth`)
  assert(lh.checkInvariants().length === 0, 'valid after growth')
})

test('linear: draining contracts buckets and steps the level down', () => {
  const lh = new LinearHash({ base: 2, capacity: 4, splitThreshold: 0.8, mergeThreshold: 0.35 })
  const keys: number[] = []
  for (let i = 0; i < 500; i++) {
    lh.insert(k(i), i)
    keys.push(i)
  }
  const grown = lh.stats()
  assert(grown.level >= 1, 'grew past level 0 before draining')
  for (const i of keys) {
    lh.remove(k(i), i)
    assert(lh.checkInvariants().length === 0, `invalid while draining at key ${i}`)
  }
  const s = lh.stats()
  assert(s.merges > 0, 'draining must contract buckets')
  assert(s.keys === 0, 'empty after draining')
  assert(s.buckets === s.base, 'a fully drained index shrinks back to its base bucket count')
  assert(s.level === 0 && s.next === 0, 'level and split pointer return to zero')
})

test('linear: overflow chains form and are still fully searchable', () => {
  // A tiny capacity + a high split threshold forces overflow before splitting.
  const lh = new LinearHash({ base: 2, capacity: 2, splitThreshold: 0.95 })
  for (let i = 0; i < 60; i++) lh.insert(k(i), i)
  const s = lh.stats()
  assert(s.overflowKeys > 0, 'small capacity + high threshold should produce overflow')
  for (let i = 0; i < 60; i++) assert(sameArr(lh.lookup(k(i)), [i]), `overflowed key ${i} not found`)
  assert(lh.checkInvariants().length === 0, 'valid despite overflow')
})

// ---------------------------------------------------------------------------
// Cross-checks and hash quality.
// ---------------------------------------------------------------------------
test('extendible and linear agree with each other on the same workload', () => {
  const rng = new Rng(0xc0ffee)
  const eh = new ExtendibleHash(3)
  const lh = new LinearHash({ base: 2, capacity: 3 })
  const keys = new Set<number>()
  for (let i = 0; i < 1500; i++) {
    const key = rng.int(0, 200)
    eh.insert(k(key), key)
    lh.insert(k(key), key)
    keys.add(key)
  }
  for (const key of keys) {
    assert(sameArr(eh.lookup(k(key)), lh.lookup(k(key))), `disagree on key ${key}`)
  }
  assert(sameEntries(eh.entries(), lh.entries()), 'full entry sets disagree')
})

test('composite (multi-column) keys hash and route correctly', () => {
  const eh = new ExtendibleHash(2)
  const ref = new Ref()
  const rng = new Rng(0xabcd)
  for (let i = 0; i < 800; i++) {
    const key = k(rng.int(0, 10), 'r' + rng.int(0, 10))
    eh.insert(key, i)
    ref.insert(key, i)
    assert(eh.checkInvariants().length === 0, `invalid at composite step ${i}`)
  }
  assert(sameEntries(eh.entries(), ref.entries()), 'composite-key entries mismatch')
})

test('hash low-bit distribution is well spread (no clustering)', () => {
  // The tables route on the *low* bits, so those must be near-uniform. Bucket
  // 4096 sequential keys into 64 low-bit classes; a good avalanche keeps every
  // class within a healthy band of the expected 64.
  const counts = new Array(64).fill(0)
  for (let i = 0; i < 4096; i++) counts[hashKey(k(i)) & 63]++
  const expected = 4096 / 64
  let chi = 0
  for (const c of counts) chi += ((c - expected) * (c - expected)) / expected
  // 63 dof: a chi-square this side of ~110 is comfortably non-degenerate.
  assert(chi < 110, `low bits cluster (chi-square ${chi.toFixed(1)})`)
  for (const c of counts) assert(c > 0, 'every low-bit class is populated')
})

export const hashIndexCases = cases
