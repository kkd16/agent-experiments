// Self-tests for the LSM storage engine.
//
// The LSM is the second load-bearing storage structure in the engine, so it is
// held to the same bar as the B+Tree: a *differential* oracle (the tree must
// answer point and range reads exactly like a brute-force last-write-wins
// reference map) combined with a *structural* oracle (`checkInvariants()` must
// stay green) run after **every** mutation, across thousands of seeded random
// put/delete sequences, under both compaction strategies. On top of that we
// prove the pieces individually — the skip list against a sorted reference, the
// Bloom filter's zero-false-negatives guarantee and its false-positive bound,
// the SSTable's block index/fences, the merging iterator's newest-wins
// reconciliation — and that the interesting events actually fire (flushes,
// multi-level compaction, tombstones reaching the bottom level and being
// reclaimed, a newer write shadowing an older one buried deep in the tree).

import { compareKeys, type IndexKey } from '../storage/btree'
import { hashKey } from '../types'
import { Rng } from '../fuzz/rng'
import { SkipList, type Entry } from './skiplist'
import { BloomFilter } from './bloom'
import { SSTable, resetSSTableIds } from './sstable'
import { LsmTree, mergeRuns, type Strategy } from './tree'
import { runBench } from './bench'

export interface LsmCase {
  group: string
  name: string
  run: () => void
}

const cases: LsmCase[] = []
function test(name: string, run: () => void) {
  cases.push({ group: 'lsm', name, run })
}
function assert(cond: boolean, detail: string) {
  if (!cond) throw new Error(detail)
}

// A brute-force reference store: last-write-wins with real deletion. Every LSM
// read is checked against the answer this gives.
class RefMap {
  private m = new Map<string, { key: IndexKey; value: unknown }>()
  put(key: IndexKey, value: unknown) {
    this.m.set(hashKey(key), { key, value })
  }
  del(key: IndexKey) {
    this.m.delete(hashKey(key))
  }
  get(key: IndexKey): { found: boolean; value?: unknown } {
    const e = this.m.get(hashKey(key))
    return e ? { found: true, value: e.value } : { found: false }
  }
  range(lo: IndexKey | null, hi: IndexKey | null): { key: IndexKey; value: unknown }[] {
    return [...this.m.values()]
      .filter((e) => (!lo || compareKeys(e.key, lo) >= 0) && (!hi || compareKeys(e.key, hi) <= 0))
      .sort((a, b) => compareKeys(a.key, b.key))
  }
  get size() {
    return this.m.size
  }
}

// ---- skip list ----------------------------------------------------------

test('skiplist: differential vs sorted reference across random ops', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const rng = new Rng(seed * 7)
    const sl = new SkipList(seed)
    const ref = new Map<number, Entry>()
    let s = 0
    for (let op = 0; op < 2000; op++) {
      const k = rng.int(0, 120)
      const e: Entry = { key: [k], seq: ++s, value: k * 2, tombstone: rng.chance(0.15) }
      sl.put(e)
      ref.set(k, e)
      if (op % 50 === 0) {
        // Point reads agree.
        for (let q = 0; q <= 120; q += 7) {
          const got = sl.get([q])
          const want = ref.get(q)
          assert(!!got === !!want, `skiplist get presence mismatch key ${q}`)
          if (got && want) assert(got.seq === want.seq, `skiplist stale entry for key ${q}`)
        }
      }
    }
    // Ordered scan is sorted and matches the reference set exactly.
    const entries = sl.entries()
    for (let i = 1; i < entries.length; i++)
      assert(compareKeys(entries[i - 1].key, entries[i].key) < 0, 'skiplist entries not strictly sorted')
    assert(entries.length === ref.size, `skiplist size ${entries.length} vs ref ${ref.size}`)
    for (const e of entries) assert(ref.get(e.key[0] as number)!.seq === e.seq, 'skiplist entry mismatch')
  }
})

test('skiplist: range queries match the reference', () => {
  const rng = new Rng(99)
  const sl = new SkipList(3)
  const ref: number[] = []
  let s = 0
  for (let i = 0; i < 400; i++) {
    const k = rng.int(0, 500)
    if (!ref.includes(k)) ref.push(k)
    sl.put({ key: [k], seq: ++s, value: k, tombstone: false })
  }
  ref.sort((a, b) => a - b)
  for (let t = 0; t < 40; t++) {
    const lo = rng.int(0, 500)
    const hi = rng.int(lo, 500)
    const got = sl.range([lo], [hi]).map((e) => e.key[0] as number)
    const want = ref.filter((k) => k >= lo && k <= hi)
    assert(JSON.stringify(got) === JSON.stringify(want), `skiplist range [${lo},${hi}] mismatch`)
  }
})

// ---- bloom filter -------------------------------------------------------

test('bloom: zero false negatives, false-positive rate within bound', () => {
  for (const fpr of [0.01, 0.05, 0.1]) {
    const rng = new Rng(Math.round(fpr * 1000) + 1)
    const n = 2000
    const bf = new BloomFilter(n, fpr)
    const present = new Set<string>()
    for (let i = 0; i < n; i++) {
      const s = `key-${rng.int(0, 1_000_000)}`
      present.add(s)
      bf.add(s)
    }
    // No false negatives — ever.
    for (const s of present) assert(bf.mightContain(s), 'bloom false negative')
    // Measured FPR over absent keys is within a slack factor of the target.
    let fp = 0
    let trials = 0
    for (let i = 0; i < 20000; i++) {
      const s = `absent-${i}`
      if (present.has(s)) continue
      trials++
      if (bf.mightContain(s)) fp++
    }
    const measured = fp / trials
    assert(measured <= fpr * 3 + 0.01, `bloom FPR ${measured.toFixed(4)} exceeds target ${fpr}`)
  }
})

// ---- SSTable ------------------------------------------------------------

test('sstable: point get, range and fences match a sorted run', () => {
  resetSSTableIds()
  const rng = new Rng(1234)
  const keys = [...new Set(Array.from({ length: 300 }, () => rng.int(0, 2000)))].sort((a, b) => a - b)
  const run: Entry[] = keys.map((k, i) => ({ key: [k], seq: i + 1, value: k * 10, tombstone: false }))
  const sst = new SSTable(run, 8, 0.01)
  assert(compareKeys(sst.minKey, [keys[0]]) === 0, 'minKey fence wrong')
  assert(compareKeys(sst.maxKey, [keys[keys.length - 1]]) === 0, 'maxKey fence wrong')
  // Every present key is found; every absent key is not.
  for (const k of keys) {
    const r = sst.get([k])
    assert(r.entry !== undefined && r.entry.value === k * 10, `sstable missed present key ${k}`)
  }
  const keySet = new Set(keys)
  for (let k = 0; k <= 2000; k += 13) {
    if (keySet.has(k)) continue
    assert(sst.get([k]).entry === undefined, `sstable found absent key ${k}`)
  }
  // Range queries.
  for (let t = 0; t < 30; t++) {
    const lo = rng.int(0, 2000)
    const hi = rng.int(lo, 2000)
    const got = sst.range([lo], [hi]).map((e) => e.key[0] as number)
    const want = keys.filter((k) => k >= lo && k <= hi)
    assert(JSON.stringify(got) === JSON.stringify(want), `sstable range [${lo},${hi}] mismatch`)
  }
})

// ---- merging iterator ---------------------------------------------------

test('mergeRuns: newest seq wins, tombstones drop only when asked', () => {
  const runs: Entry[][] = [
    [
      { key: [1], seq: 10, value: 'a-new', tombstone: false },
      { key: [3], seq: 11, value: null, tombstone: true },
    ],
    [
      { key: [1], seq: 2, value: 'a-old', tombstone: false },
      { key: [2], seq: 3, value: 'b', tombstone: false },
      { key: [3], seq: 4, value: 'c', tombstone: false },
    ],
  ]
  const keep = mergeRuns(runs, false)
  assert(keep.length === 3, 'mergeRuns keep count')
  assert(keep[0].key[0] === 1 && keep[0].value === 'a-new', 'newest did not win')
  assert(keep[2].key[0] === 3 && keep[2].tombstone, 'tombstone should be kept')
  const drop = mergeRuns(runs, true)
  assert(drop.length === 2 && drop.every((e) => e.key[0] !== 3), 'tombstone should be dropped')
  assert(drop[0].value === 'a-new', 'newest did not win with drop')
})

// ---- the tree: differential + invariants under both strategies ----------

function differentialWorkload(strategy: Strategy, seed: number, ops: number) {
  resetSSTableIds()
  const rng = new Rng(seed)
  const tree = new LsmTree({ strategy, memtableLimit: 12, blockSize: 4, fanout: 3, l0Trigger: 3, tierTrigger: 3, targetFileEntries: 12, seed })
  const ref = new RefMap()
  const domain = 80
  for (let op = 0; op < ops; op++) {
    const k: IndexKey = [rng.int(0, domain)]
    if (rng.chance(0.72)) {
      const v = rng.int(0, 1_000_000)
      tree.put(k, v)
      ref.put(k, v)
    } else {
      tree.del(k)
      ref.del(k)
    }
    // Structural oracle after every mutation.
    const bad = tree.checkInvariants()
    assert(bad === null, `[${strategy} seed ${seed}] invariant broken at op ${op}: ${bad}`)
    // Point-read oracle on a spread of probe keys.
    if (op % 11 === 0) {
      for (let q = 0; q <= domain; q += 5) {
        const got = tree.get([q])
        const want = ref.get([q])
        assert(
          got.found === want.found && (!got.found || got.value === want.value),
          `[${strategy} seed ${seed}] get(${q}) mismatch at op ${op}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`,
        )
      }
    }
  }
  // Full range scan matches the reference exactly.
  const got = tree.range(null, null)
  const want = ref.range(null, null)
  assert(got.length === want.length, `[${strategy} seed ${seed}] live count ${got.length} vs ref ${want.length}`)
  for (let i = 0; i < got.length; i++) {
    assert(compareKeys(got[i].key, want[i].key) === 0, `[${strategy} seed ${seed}] range key mismatch at ${i}`)
    assert(got[i].value === want[i].value, `[${strategy} seed ${seed}] range value mismatch at key ${got[i].key[0]}`)
  }
  // Bounded range reads too.
  for (let t = 0; t < 25; t++) {
    const lo = rng.int(0, domain)
    const hi = rng.int(lo, domain)
    const g = tree.range([lo], [hi])
    const w = ref.range([lo], [hi])
    assert(g.length === w.length, `[${strategy} seed ${seed}] bounded range [${lo},${hi}] count`)
    for (let i = 0; i < g.length; i++)
      assert(compareKeys(g[i].key, w[i].key) === 0 && g[i].value === w[i].value, 'bounded range mismatch')
  }
  return tree
}

test('tree: leveled differential + invariants across seeds', () => {
  for (let seed = 1; seed <= 5; seed++) differentialWorkload('leveled', seed * 13 + 1, 900)
})

test('tree: size-tiered differential + invariants across seeds', () => {
  for (let seed = 1; seed <= 5; seed++) differentialWorkload('tiered', seed * 17 + 3, 900)
})

test('tree: lazy-leveled differential + invariants across seeds', () => {
  for (let seed = 1; seed <= 5; seed++) differentialWorkload('lazy', seed * 19 + 5, 900)
})

test('tree: lazy leveling keeps the deepest level a single sorted run', () => {
  resetSSTableIds()
  const rng = new Rng(31337)
  const tree = new LsmTree({ strategy: 'lazy', memtableLimit: 10, blockSize: 4, fanout: 3, tierTrigger: 3, targetFileEntries: 10, seed: 2 })
  let sawShallowTier = false
  for (let op = 0; op < 1400; op++) {
    const k: IndexKey = [rng.int(0, 120)]
    if (rng.chance(0.72)) tree.put(k, rng.int(0, 9999))
    else tree.del(k)
    assert(tree.checkInvariants() === null, `lazy invariant broke at op ${op}`)
    // The deepest non-empty level must be a non-overlapping sorted run (leveled);
    // record whether shallower levels ever hold several runs (tiered).
    let deepest = 0
    for (let i = 0; i < tree.levels.length; i++) if (tree.levels[i].length) deepest = i
    // The deepest *leveled* level (≥ L1) is one sorted, non-overlapping run. (L0
    // is always tiered/overlapping, even when it is momentarily the deepest.)
    if (deepest >= 1) {
      for (let i = 1; i < tree.levels[deepest].length; i++) {
        assert(
          compareKeys(tree.levels[deepest][i - 1].maxKey, tree.levels[deepest][i].minKey) < 0,
          `lazy deepest level L${deepest} is not a sorted non-overlapping run`,
        )
      }
    }
    for (let lv = 1; lv < deepest; lv++) if (tree.levels[lv].length >= 2) sawShallowTier = true
  }
  assert(deepestIsMostData(tree), 'lazy: the deepest level should hold most of the data')
  assert(sawShallowTier, 'lazy: expected shallow levels to tier (hold multiple runs) at some point')
})

function deepestIsMostData(tree: LsmTree): boolean {
  let deepest = 0
  for (let i = 0; i < tree.levels.length; i++) if (tree.levels[i].length) deepest = i
  let deep = 0
  let total = 0
  for (let i = 0; i < tree.levels.length; i++) {
    const e = tree.levels[i].reduce((n, t) => n + t.count, 0)
    total += e
    if (i === deepest) deep = e
  }
  return total === 0 || deep >= total * 0.4
}

// ---- interesting events actually fire ------------------------------------

test('tree: multi-level compaction and tombstone reclamation fire', () => {
  const tree = differentialWorkload('leveled', 424242, 1500)
  assert(tree.metrics.flushes > 10, `expected many flushes, got ${tree.metrics.flushes}`)
  assert(tree.metrics.compactions > 5, `expected compactions, got ${tree.metrics.compactions}`)
  assert(tree.levels.length >= 3, `expected a multi-level tree, got ${tree.levels.length} levels`)
  assert(tree.metrics.writeAmp > 1, `expected write amplification > 1, got ${tree.metrics.writeAmp}`)
  // The stored entry count must not run away: compaction reconciles overwrites
  // and drops tombstones at the bottom, so total on-disk entries stays a small
  // multiple of the live set.
  assert(
    tree.metrics.totalEntries <= tree.metrics.liveKeys * 4 + 60,
    `space blow-up: ${tree.metrics.totalEntries} entries for ${tree.metrics.liveKeys} live keys`,
  )
})

test('tree: tombstones are reclaimed by compaction (major compaction is exact)', () => {
  resetSSTableIds()
  const tree = new LsmTree({ strategy: 'leveled', memtableLimit: 8, blockSize: 4, fanout: 2, l0Trigger: 2, targetFileEntries: 8, seed: 5 })
  for (let k = 0; k < 200; k++) tree.put([k], k)
  tree.flush()
  const beforeDeletes = tree.metrics.totalEntries
  assert(beforeDeletes >= 200, 'sanity: had all keys stored before deletes')
  // Delete a big chunk and overwrite the rest, so the tree is full of tombstones
  // and shadowed versions.
  for (let k = 0; k < 120; k++) tree.del([k])
  for (let k = 120; k < 200; k++) tree.put([k], k * 100) // overwrite → old versions shadowed
  tree.flush()
  // Correctness first: deletes are invisible, overwrites take the new value.
  for (let k = 0; k < 120; k++) assert(!tree.get([k]).found, `deleted key ${k} resurfaced`)
  for (let k = 120; k < 200; k++) assert(tree.get([k]).value === k * 100, `overwrite lost for key ${k}`)
  // Before major compaction, tombstones + shadowed versions inflate the store.
  const live = tree.range(null, null).length
  assert(live === 80, `expected 80 live keys, got ${live}`)
  // A major compaction reclaims EVERYTHING: exactly one entry per live key, no
  // tombstones, no shadows.
  tree.majorCompaction()
  assert(tree.checkInvariants() === null, 'major compaction left an invalid tree')
  assert(tree.metrics.liveKeys === 80, `major compaction changed the live set: ${tree.metrics.liveKeys}`)
  assert(tree.metrics.totalEntries === 80, `major compaction did not reclaim: ${tree.metrics.totalEntries} entries for 80 live keys`)
  for (let k = 0; k < 120; k++) assert(!tree.get([k]).found, `deleted key ${k} came back after major compaction`)
  for (let k = 120; k < 200; k++) assert(tree.get([k]).value === k * 100, `value wrong after major compaction for ${k}`)
  // And ordinary (incremental) compaction does reclaim space as it runs — the
  // store never grows without bound relative to the live set under churn.
  const t2 = new LsmTree({ strategy: 'leveled', memtableLimit: 8, blockSize: 4, fanout: 2, l0Trigger: 2, targetFileEntries: 8, seed: 9 })
  for (let round = 0; round < 6; round++) for (let k = 0; k < 100; k++) t2.put([k], round * 1000 + k)
  t2.flush()
  assert(t2.metrics.totalEntries <= t2.metrics.liveKeys * 3 + 30, `incremental compaction let the store blow up: ${t2.metrics.totalEntries} for ${t2.metrics.liveKeys} live`)
})

test('tree: a newer write shadows an older version buried deep in the tree', () => {
  resetSSTableIds()
  const tree = new LsmTree({ strategy: 'leveled', memtableLimit: 6, blockSize: 3, fanout: 2, l0Trigger: 2, targetFileEntries: 6, seed: 7 })
  tree.put([42], 'old')
  // Bury key 42 deep by writing lots of other keys and compacting.
  for (let k = 100; k < 300; k++) tree.put([k], k)
  tree.flush()
  assert(tree.get([42]).value === 'old', 'buried key lost before overwrite')
  assert((tree.get([42]).hitLevel ?? -1) >= 1, 'key 42 should be below L0 by now')
  // Overwrite in the fresh memtable; the shallow, newer version must win.
  tree.put([42], 'new')
  assert(tree.get([42]).value === 'new', 'newer shallow write did not shadow the deep old one')
  // And a delete of the deep key wins too.
  tree.del([42])
  assert(!tree.get([42]).found, 'delete did not shadow the deep old version')
  assert(!tree.range([42], [42]).some((r) => compareKeys(r.key, [42]) === 0), 'range saw a deleted deep key')
})

test('tree: Bloom filters and fences skip most tables on an absent-key probe', () => {
  resetSSTableIds()
  const tree = new LsmTree({ strategy: 'leveled', memtableLimit: 16, blockSize: 4, fanout: 3, l0Trigger: 3, targetFileEntries: 16, seed: 3 })
  for (let k = 0; k < 600; k++) tree.put([k * 2], k) // only even keys present
  tree.flush()
  let totalTables = 0
  for (const level of tree.levels) totalTables += level.length
  assert(totalTables >= 3, `expected several tables, got ${totalTables}`)
  // Probe absent (odd) keys: the reads must skip tables via Bloom/fences rather
  // than read every one.
  let consulted = 0
  let skips = 0
  const probes = 200
  for (let i = 0; i < probes; i++) {
    const r = tree.get([2 * i + 1])
    assert(!r.found, 'odd key should be absent')
    consulted += r.tablesConsulted
    skips += r.bloomSkips + r.fenceSkips
  }
  // Far fewer block reads than the naive "every table, every probe".
  assert(consulted < totalTables * probes * 0.5, `read amplification too high: ${consulted} block reads`)
  assert(skips > 0, 'expected some Bloom/fence skips')
})

test('tree: composite (multi-column) keys order and reconcile correctly', () => {
  resetSSTableIds()
  const rng = new Rng(555)
  const tree = new LsmTree({ strategy: 'leveled', memtableLimit: 10, blockSize: 4, seed: 9 })
  const ref = new RefMap()
  for (let op = 0; op < 500; op++) {
    const key: IndexKey = [rng.int(0, 9), rng.pick(['x', 'y', 'z'])]
    if (rng.chance(0.7)) {
      const v = op
      tree.put(key, v)
      ref.put(key, v)
    } else {
      tree.del(key)
      ref.del(key)
    }
    assert(tree.checkInvariants() === null, `composite invariant broke at op ${op}`)
  }
  const got = tree.range(null, null)
  const want = ref.range(null, null)
  assert(got.length === want.length, 'composite live count mismatch')
  for (let i = 0; i < got.length; i++)
    assert(compareKeys(got[i].key, want[i].key) === 0 && got[i].value === want[i].value, 'composite range mismatch')
})

// ---- the amplification benchmark ----------------------------------------

test('bench: all three strategies return byte-identical live state', () => {
  for (const seed of [0xa11, 0xb22, 0xc33, 0xd44]) {
    const r = runBench(2500, seed)
    assert(r.identical, `bench seed ${seed.toString(16)}: strategies disagreed on live state`)
    // Sanity: the workload actually exercised the tree.
    for (const s of r.results) {
      assert(s.flushes > 5, `bench seed ${seed.toString(16)}: too few flushes (${s.strategy})`)
      assert(s.compactions > 0, `bench seed ${seed.toString(16)}: no compaction (${s.strategy})`)
    }
  }
})

test('bench: amplification profile matches the RUM trade-off', () => {
  // Aggregate over several seeds so the qualitative ordering is robust to noise.
  const agg: Record<string, { w: number; r: number; sp: number; n: number }> = {
    leveled: { w: 0, r: 0, sp: 0, n: 0 },
    tiered: { w: 0, r: 0, sp: 0, n: 0 },
    lazy: { w: 0, r: 0, sp: 0, n: 0 },
  }
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const r = runBench(3000, seed * 101 + 7)
    assert(r.identical, `bench seed ${seed}: strategies disagreed`)
    for (const s of r.results) {
      const a = agg[s.strategy]
      a.w += s.writeAmp
      a.r += s.avgReadTables
      a.sp += s.spaceAmp
      a.n++
      assert(s.writeAmp >= 1, `${s.strategy}: writeAmp < 1`)
      assert(s.spaceAmp >= 1, `${s.strategy}: spaceAmp < 1`)
      assert(s.avgReadTables >= 0, `${s.strategy}: negative read amp`)
    }
  }
  const mean = (a: { w: number; r: number; sp: number; n: number }) => ({ w: a.w / a.n, r: a.r / a.n, sp: a.sp / a.n })
  const lv = mean(agg.leveled)
  const ti = mean(agg.tiered)
  const lz = mean(agg.lazy)
  // Write amp: tiered writes least, leveled most (leveled rewrites a level on
  // every absorbed merge). Lazy sits at or below leveled.
  assert(ti.w <= lv.w + 1e-9, `expected tiered writeAmp (${ti.w.toFixed(2)}) ≤ leveled (${lv.w.toFixed(2)})`)
  assert(lz.w <= lv.w + 1e-9, `expected lazy writeAmp (${lz.w.toFixed(2)}) ≤ leveled (${lv.w.toFixed(2)})`)
  // Read amp: tiered reads the most tables per lookup (overlapping runs);
  // leveled the fewest. Lazy is no worse than tiered.
  assert(lv.r <= ti.r + 1e-9, `expected leveled readAmp (${lv.r.toFixed(2)}) ≤ tiered (${ti.r.toFixed(2)})`)
  assert(lz.r <= ti.r + 1e-9, `expected lazy readAmp (${lz.r.toFixed(2)}) ≤ tiered (${ti.r.toFixed(2)})`)
  // Space amp: leveled reclaims the most (single run per level), tiered the least.
  assert(lv.sp <= ti.sp + 1e-9, `expected leveled spaceAmp (${lv.sp.toFixed(2)}) ≤ tiered (${ti.sp.toFixed(2)})`)
})

export const lsmCases = cases
