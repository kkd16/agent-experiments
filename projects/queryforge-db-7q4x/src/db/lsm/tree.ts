// The Log-Structured Merge tree — QueryForge's second storage engine.
//
// The B+Tree (src/db/storage) is a *read-optimized, update-in-place* structure:
// a write finds the leaf and mutates it, so a point read is one root-to-leaf
// descent but a write pays a random I/O and, under churn, split/merge
// rebalancing. The LSM is its mirror image — the *write-optimized* structure
// behind LevelDB, RocksDB, Cassandra, ScyllaDB, HBase and SQLite4. It never
// updates data in place. Every write is an append:
//
//   1. it lands in an in-memory ordered **memtable** (a skip list);
//   2. a full memtable is **flushed**, sequentially, to an immutable, sorted
//      **SSTable** at level 0 — turning random writes into one big sequential one;
//   3. background **compaction** merges SSTables down a hierarchy of levels,
//      reconciling overwrites and deletions and keeping the read cost bounded.
//
// The price is read and space amplification (a key may live in several tables at
// once, newest shadowing oldest), which Bloom filters, fence pointers and a
// sparse per-block index claw back. A **monotonic sequence number** on every
// entry gives a total "newest wins" order across all levels, and a **tombstone**
// is how a delete travels — a marker that shadows older data until it reaches the
// bottom level, where, with nothing left below to hide, it is finally dropped.
//
// Two compaction strategies are built, the two the field actually uses:
//   • **leveled** (LevelDB/RocksDB): each level ≥ L1 is a single sorted,
//     non-overlapping run; a level that overflows merges one table into the
//     overlapping key range of the next. Low read/space amp, higher write amp.
//   • **size-tiered** (Cassandra): each tier collects several similar-sized runs
//     and, when enough pile up, merges them into one larger run a tier down. Low
//     write amp, higher read/space amp.
//
// This is a standalone engine (like wcoj/, ivm/, sketch/): a from-scratch model,
// a differential + invariant self-test group, and an interactive Lab. It runs
// over the engine's own `IndexKey`/`compareKeys`, so it orders every SQL type.

import { compareKeys, type IndexKey } from '../storage/btree'
import { SkipList, estimateBytes, type Entry, type SkipSnapshot } from './skiplist'
import { SSTable } from './sstable'

export type Strategy = 'leveled' | 'tiered' | 'lazy'

export interface LsmConfig {
  memtableLimit: number // entries before the active memtable flushes
  blockSize: number // entries per SSTable block
  fpr: number // target Bloom false-positive rate
  fanout: number // level/tier size multiplier
  l0Trigger: number // #L0 tables that forces an L0→L1 compaction (leveled)
  tierTrigger: number // #tables in a tier that forces a merge (tiered)
  targetFileEntries: number // entries per output SSTable during compaction
  strategy: Strategy
  seed: number
}

export const DEFAULT_CONFIG: LsmConfig = {
  memtableLimit: 32,
  blockSize: 8,
  fpr: 0.01,
  fanout: 4,
  l0Trigger: 4,
  tierTrigger: 4,
  targetFileEntries: 32,
  strategy: 'leveled',
  seed: 0x1e5,
}

/** What happened at one table (or the memtable) during a lookup — drives the
 *  Lab's read-path visualization. */
export type ProbeOutcome = 'memtable-hit' | 'fence-skip' | 'bloom-skip' | 'read-miss' | 'read-hit'
export interface ProbeStep {
  level: number // -1 = memtable
  tableId: number // 0 for the memtable
  outcome: ProbeOutcome
}

export interface GetResult {
  found: boolean
  value?: unknown
  // Read-amplification accounting for one lookup:
  tablesConsulted: number // SSTables whose block was actually read
  bloomSkips: number // SSTables the Bloom filter let us skip
  fenceSkips: number // SSTables the fence pointers let us skip
  hitLevel: number // -1 memtable, else level index; -2 not found
  path: ProbeStep[] // the ordered probe sequence
}

export interface LsmMetrics {
  writes: number
  deletes: number
  flushes: number
  compactions: number
  bytesFlushed: number // user data written by flushes
  bytesCompacted: number // data rewritten by compaction merges
  writeAmp: number // total bytes written / user bytes flushed
  spaceAmp: number // bytes on disk / live bytes
  liveKeys: number
  totalEntries: number // entries across all SSTables (incl. shadowed + tombstones)
  levelSizes: number[] // entry count per level
  levelTables: number[] // #SSTables per level
}

/** One human-readable line describing what an operation did, for the Lab. */
export interface TraceLine {
  kind: 'put' | 'del' | 'flush' | 'compact' | 'get' | 'reset'
  text: string
}

export class LsmTree {
  cfg: LsmConfig
  mem: SkipList
  /** levels[0] = L0. For leveled, levels[n≥1] is one sorted non-overlapping run
   *  (kept ascending by minKey). For tiered, each entry is a tier of overlapping
   *  runs (kept newest-first). */
  levels: SSTable[][] = [[]]
  private seq = 0
  private bytesWrittenTotal = 0 // flush + compaction outputs
  metrics: LsmMetrics
  trace: TraceLine[] = []
  private compactPtr: number[] = [] // round-robin table pick per level (leveled)

  constructor(cfg: Partial<LsmConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg }
    this.mem = new SkipList(this.cfg.seed)
    this.metrics = this.emptyMetrics()
  }

  private emptyMetrics(): LsmMetrics {
    return {
      writes: 0,
      deletes: 0,
      flushes: 0,
      compactions: 0,
      bytesFlushed: 0,
      bytesCompacted: 0,
      writeAmp: 1,
      spaceAmp: 1,
      liveKeys: 0,
      totalEntries: 0,
      levelSizes: [0],
      levelTables: [0],
    }
  }

  // ---- write path -------------------------------------------------------

  put(key: IndexKey, value: unknown): void {
    this.mem.put({ key, seq: ++this.seq, value, tombstone: false })
    this.metrics.writes++
    this.pushTrace({ kind: 'put', text: `put ${fmtKey(key)} (seq ${this.seq})` })
    this.maybeFlush()
  }

  del(key: IndexKey): void {
    this.mem.put({ key, seq: ++this.seq, value: null, tombstone: true })
    this.metrics.deletes++
    this.pushTrace({ kind: 'del', text: `delete ${fmtKey(key)} → tombstone (seq ${this.seq})` })
    this.maybeFlush()
  }

  private maybeFlush(): void {
    if (this.mem.size >= this.cfg.memtableLimit) this.flush()
  }

  /** Seal the active memtable into a fresh L0 SSTable (one sequential write),
   *  then run compaction to restore the level budgets. Safe to call with an
   *  empty memtable (no-op). */
  flush(): void {
    if (this.mem.size === 0) return
    const run = this.mem.entries() // already sorted, one entry per key
    const table = new SSTable(run, this.cfg.blockSize, this.cfg.fpr)
    // Newest flush is the freshest data → front of L0 (recency order).
    this.levels[0].unshift(table)
    this.mem = new SkipList(this.cfg.seed ^ (this.metrics.flushes + 1))
    this.metrics.flushes++
    this.metrics.bytesFlushed += table.bytes
    this.bytesWrittenTotal += table.bytes
    this.pushTrace({ kind: 'flush', text: `flush memtable → L0 SSTable #${table.id} (${table.count} entries)` })
    this.compact()
    this.refreshMetrics()
  }

  // ---- compaction -------------------------------------------------------

  /** Does any level at or below `startLevel` hold a table overlapping the key
   *  range [min, max]? This is LevelDB's `IsBaseLevelForKey` generalized to a
   *  range: a tombstone being merged into level `to` can be **dropped** exactly
   *  when there is no older data for its keys anywhere below — i.e. no deeper
   *  overlap — because with nothing left to shadow, the marker has done its job.
   *  Precise, per-key-range reclamation (not a coarse "only at the global bottom"
   *  rule), so a deleted key range is reclaimed as soon as it bottoms out locally. */
  private anyOverlapAtOrBelow(startLevel: number, min: IndexKey, max: IndexKey): boolean {
    for (let i = startLevel; i < this.levels.length; i++) {
      for (const t of this.levels[i]) if (t.overlaps(min, max)) return true
    }
    return false
  }

  /** Index of the deepest level that currently holds any data. */
  private deepestNonEmpty(): number {
    let d = 0
    for (let i = 0; i < this.levels.length; i++) if (this.levels[i].length) d = i
    return d
  }

  private rangeOf(tables: SSTable[]): [IndexKey, IndexKey] {
    let min = tables[0].minKey
    let max = tables[0].maxKey
    for (const t of tables) {
      if (compareKeys(t.minKey, min) < 0) min = t.minKey
      if (compareKeys(t.maxKey, max) > 0) max = t.maxKey
    }
    return [min, max]
  }

  private entriesAt(level: number): number {
    return this.levels[level].reduce((n, t) => n + t.count, 0)
  }

  /** Entry budget for a level (leveled): L1 holds fanout memtables' worth, each
   *  deeper level fanout× more. */
  private levelCapacity(level: number): number {
    return this.cfg.memtableLimit * this.cfg.fanout * Math.pow(this.cfg.fanout, level - 1)
  }

  private ensureLevel(n: number): void {
    while (this.levels.length <= n) this.levels.push([])
    while (this.compactPtr.length <= n) this.compactPtr.push(0)
  }

  compact(): void {
    if (this.cfg.strategy === 'leveled') this.compactLeveled()
    else if (this.cfg.strategy === 'lazy') this.compactLazy()
    else this.compactTiered()
  }

  /** **Lazy leveling** (Dayan & Idreos, *Dostoevsky*, SIGMOD 2018): tier every
   *  level *except the largest*, which is leveled (a single sorted run). Because
   *  the deepest level holds the overwhelming majority of the data, keeping just
   *  it leveled buys almost all of leveling's point-read and space-amplification
   *  win, while the shallow tiered levels keep tiering's low write amplification —
   *  a point on the read/write/space frontier that Pareto-dominates both pure
   *  strategies for many workloads. Mechanically it is the tiered loop, but a
   *  merge *into the current deepest level* combines with that level's existing
   *  run (leveled) instead of stacking a new overlapping run beside it (tiered). */
  private compactLazy(): void {
    let guard = 0
    for (;;) {
      if (guard++ > 10000) break
      let acted = false
      const deepest = this.deepestNonEmpty()
      for (let n = 0; n < this.levels.length; n++) {
        // The deepest level (≥ L1) is *leveled* — one sorted run, possibly split
        // across several non-overlapping SSTable files. It must NOT be tiered on
        // file count (those files are one run); it only pushes down when it
        // outgrows its size budget, exactly like a leveled level.
        const isDeepestLeveled = n === deepest && n >= 1
        if (!isDeepestLeveled && this.levels[n].length >= this.cfg.tierTrigger) {
          this.ensureLevel(n + 1)
          const to = n + 1
          const tier = this.levels[n]
          const [tmin, tmax] = this.rangeOf(tier)
          let runs: Entry[][]
          let built: SSTable[]
          if (to >= deepest) {
            // Merge into the (new or current) largest level → fold into its single
            // run so it stays leveled (non-overlapping, newest reconciled).
            runs = [...tier.map((t) => t.all()), ...this.levels[to].map((t) => t.all())]
            const drop = !this.anyOverlapAtOrBelow(to + 1, tmin, tmax)
            built = this.splitIntoTables(mergeRuns(runs, drop))
            this.levels[to] = built.sort((a, b) => compareKeys(a.minKey, b.minKey))
          } else {
            // Merge into a shallower level → stack ONE new run (tiered).
            runs = tier.map((t) => t.all())
            const drop = !this.anyOverlapAtOrBelow(to, tmin, tmax)
            built = this.buildRun(mergeRuns(runs, drop))
            this.levels[to] = [...built, ...this.levels[to]]
          }
          this.levels[n] = []
          this.accountCompaction(runs, built, n, to)
          acted = true
          break
        }
        // The leveled bottom outgrew its budget → push its whole run down one
        // level (it stays a single leveled run at the new deepest).
        if (isDeepestLeveled && this.entriesAt(n) > this.levelCapacity(n)) {
          this.ensureLevel(n + 1)
          const runs = this.levels[n].map((t) => t.all())
          const [tmin, tmax] = this.rangeOf(this.levels[n])
          const drop = !this.anyOverlapAtOrBelow(n + 2, tmin, tmax)
          const built = this.splitIntoTables(mergeRuns(runs, drop))
          this.levels[n] = []
          this.levels[n + 1] = built.sort((a, b) => compareKeys(a.minKey, b.minKey))
          this.accountCompaction(runs, built, n, n + 1)
          acted = true
          break
        }
      }
      if (!acted) break
    }
  }

  private compactLeveled(): void {
    let guard = 0
    for (;;) {
      if (guard++ > 10000) break
      // 1) L0 → L1 when too many L0 files pile up.
      if (this.levels[0].length >= this.cfg.l0Trigger) {
        this.mergeL0IntoL1()
        continue
      }
      // 2) Any level ≥ 1 over its entry budget → push one table down.
      let acted = false
      for (let n = 1; n < this.levels.length; n++) {
        if (this.levels[n].length && this.entriesAt(n) > this.levelCapacity(n)) {
          this.mergeLevelDown(n)
          acted = true
          break
        }
      }
      if (!acted) break
    }
  }

  private mergeL0IntoL1(): void {
    this.ensureLevel(1)
    const l0 = this.levels[0]
    let min = l0[0].minKey
    let max = l0[0].maxKey
    for (const t of l0) {
      if (compareKeys(t.minKey, min) < 0) min = t.minKey
      if (compareKeys(t.maxKey, max) > 0) max = t.maxKey
    }
    const overlap = this.levels[1].filter((t) => t.overlaps(min, max))
    const keep = this.levels[1].filter((t) => !t.overlaps(min, max))
    // Reclaim tombstones for this key range if no older data lives below L1.
    const drop = !this.anyOverlapAtOrBelow(2, min, max)
    // Runs newest→oldest so, though the merge reconciles by seq, ordering is tidy.
    const runs = [...l0.map((t) => t.all()), ...overlap.map((t) => t.all())]
    const merged = mergeRuns(runs, drop)
    const built = this.splitIntoTables(merged)
    this.levels[1] = [...keep, ...built].sort((a, b) => compareKeys(a.minKey, b.minKey))
    this.levels[0] = []
    this.accountCompaction(runs, built, 0, 1)
  }

  private mergeLevelDown(n: number): void {
    this.ensureLevel(n + 1)
    // Round-robin the table we push down, so compaction sweeps the level evenly.
    const ptr = this.compactPtr[n] % this.levels[n].length
    const t = this.levels[n][ptr]
    this.compactPtr[n] = ptr + 1
    const overlap = this.levels[n + 1].filter((x) => x.overlaps(t.minKey, t.maxKey))
    const keep = this.levels[n + 1].filter((x) => !x.overlaps(t.minKey, t.maxKey))
    const drop = !this.anyOverlapAtOrBelow(n + 2, t.minKey, t.maxKey)
    const runs = [t.all(), ...overlap.map((x) => x.all())]
    const merged = mergeRuns(runs, drop)
    const built = this.splitIntoTables(merged)
    this.levels[n] = this.levels[n].filter((x) => x !== t)
    this.levels[n + 1] = [...keep, ...built].sort((a, b) => compareKeys(a.minKey, b.minKey))
    this.accountCompaction(runs, built, n, n + 1)
  }

  private compactTiered(): void {
    let guard = 0
    for (;;) {
      if (guard++ > 10000) break
      let acted = false
      for (let n = 0; n < this.levels.length; n++) {
        if (this.levels[n].length >= this.cfg.tierTrigger) {
          this.ensureLevel(n + 1)
          const tier = this.levels[n]
          const runs = tier.map((t) => t.all())
          // A tier merges wholesale into one bigger run one tier down. Because
          // tiered runs *overlap*, the destination tier's existing (older) runs
          // could still shadow — so a tombstone is reclaimable only if no run at
          // or below the destination tier overlaps its key range.
          const [tmin, tmax] = this.rangeOf(tier)
          const drop = !this.anyOverlapAtOrBelow(n + 1, tmin, tmax)
          const merged = mergeRuns(runs, drop)
          // A tiered merge yields ONE run (a single SSTable, Cassandra-style), so
          // the destination reaches `tierTrigger` only after that many separate
          // merges land — never by a single merge's own file split (which would
          // re-trigger endlessly). Runs grow geometrically down the tiers.
          const built = this.buildRun(merged)
          this.levels[n] = []
          // Newest run to the front of the next tier (recency order for reads).
          this.levels[n + 1] = [...built, ...this.levels[n + 1]]
          this.accountCompaction(runs, built, n, n + 1)
          acted = true
          break
        }
      }
      if (!acted) break
    }
  }

  /** A full **major compaction** (RocksDB's `CompactRange` over everything):
   *  seal the memtable, then merge every SSTable across every level into a single
   *  sorted run. Because this run sits at the bottom of the world, **every**
   *  tombstone and every shadowed version is dropped — afterwards the tree holds
   *  exactly one entry per live key. It reclaims all space at the cost of one big
   *  rewrite, which is why engines run it manually rather than continuously. */
  majorCompaction(): void {
    this.flush()
    const runs: Entry[][] = []
    for (const level of this.levels) for (const t of level) runs.push(t.all())
    if (runs.length === 0) return
    const merged = mergeRuns(runs, true)
    const built = this.splitIntoTables(merged)
    const inEntries = runs.reduce((n, r) => n + r.length, 0)
    this.levels = [[], built]
    this.compactPtr = []
    let outBytes = 0
    for (const t of built) outBytes += t.bytes
    this.metrics.compactions++
    this.metrics.bytesCompacted += outBytes
    this.bytesWrittenTotal += outBytes
    this.pushTrace({
      kind: 'compact',
      text: `major compaction: merged everything → ${built.length} table(s), ${merged.length} live entries (reclaimed ${inEntries - merged.length})`,
    })
    this.refreshMetrics()
  }

  private splitIntoTables(entries: Entry[]): SSTable[] {
    const out: SSTable[] = []
    for (let i = 0; i < entries.length; i += this.cfg.targetFileEntries) {
      out.push(new SSTable(entries.slice(i, i + this.cfg.targetFileEntries), this.cfg.blockSize, this.cfg.fpr))
    }
    return out
  }

  /** A single-SSTable **run** — a tiered merge's output. One file so it counts as
   *  one run against `tierTrigger` (a run split into many files would re-trigger
   *  its own tier endlessly). */
  private buildRun(entries: Entry[]): SSTable[] {
    return entries.length ? [new SSTable(entries, this.cfg.blockSize, this.cfg.fpr)] : []
  }

  private accountCompaction(inputs: Entry[][], outputs: SSTable[], from: number, to: number): void {
    this.metrics.compactions++
    let outBytes = 0
    for (const t of outputs) outBytes += t.bytes
    this.metrics.bytesCompacted += outBytes
    this.bytesWrittenTotal += outBytes
    const inEntries = inputs.reduce((n, r) => n + r.length, 0)
    const outEntries = outputs.reduce((n, t) => n + t.count, 0)
    this.pushTrace({
      kind: 'compact',
      text: `compact L${from}→L${to}: ${inEntries} entries in ${inputs.length} runs → ${outEntries} in ${outputs.length} tables${
        outEntries < inEntries ? ` (reclaimed ${inEntries - outEntries})` : ''
      }`,
    })
  }

  // ---- read path --------------------------------------------------------

  /** Point lookup — newest version wins, a tombstone reads as not-found. Walks
   *  the tree newest→oldest and returns the first hit; because every write is
   *  newer than anything already flushed below it, the first hit is the newest
   *  version by construction. Bloom filters and fence pointers skip tables that
   *  can't hold the key, which is what keeps read amplification low. */
  get(key: IndexKey): GetResult {
    let tables = 0
    let bloom = 0
    let fence = 0
    const path: ProbeStep[] = []
    // Active memtable (always the freshest).
    const m = this.mem.get(key)
    if (m) {
      path.push({ level: -1, tableId: 0, outcome: 'memtable-hit' })
      return this.resolve(m, -1, tables, bloom, fence, path)
    }
    // Levels, newest first.
    for (let n = 0; n < this.levels.length; n++) {
      const level = this.levels[n]
      if (n === 0 || this.cfg.strategy !== 'leveled') {
        // Possibly-overlapping runs (all of tiered; every tiered level of lazy) —
        // probe each, newest first. A non-overlapping level answers with ≤1 hit.
        for (const t of level) {
          const r = t.get(key)
          if (r.filtered) {
            bloom++
            path.push({ level: n, tableId: t.id, outcome: 'bloom-skip' })
          } else if (r.scanned === 0 && !r.entry) {
            fence++
            path.push({ level: n, tableId: t.id, outcome: 'fence-skip' })
          } else {
            tables++
            path.push({ level: n, tableId: t.id, outcome: r.entry ? 'read-hit' : 'read-miss' })
          }
          if (r.entry) return this.resolve(r.entry, n, tables, bloom, fence, path)
        }
      } else {
        // Leveled level ≥ 1: sorted, non-overlapping → at most one candidate,
        // found by binary search on fence pointers.
        const t = this.findLeveledTable(level, key)
        if (t) {
          const r = t.get(key)
          if (r.filtered) {
            bloom++
            path.push({ level: n, tableId: t.id, outcome: 'bloom-skip' })
          } else {
            tables++
            path.push({ level: n, tableId: t.id, outcome: r.entry ? 'read-hit' : 'read-miss' })
          }
          if (r.entry) return this.resolve(r.entry, n, tables, bloom, fence, path)
        }
      }
    }
    return { found: false, tablesConsulted: tables, bloomSkips: bloom, fenceSkips: fence, hitLevel: -2, path }
  }

  private findLeveledTable(level: SSTable[], key: IndexKey): SSTable | undefined {
    let lo = 0
    let hi = level.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      const t = level[mid]
      if (compareKeys(key, t.minKey) < 0) hi = mid - 1
      else if (compareKeys(key, t.maxKey) > 0) lo = mid + 1
      else return t
    }
    return undefined
  }

  private resolve(e: Entry, level: number, tables: number, bloom: number, fence: number, path: ProbeStep[]): GetResult {
    return e.tombstone
      ? { found: false, tablesConsulted: tables, bloomSkips: bloom, fenceSkips: fence, hitLevel: level, path }
      : { found: true, value: e.value, tablesConsulted: tables, bloomSkips: bloom, fenceSkips: fence, hitLevel: level, path }
  }

  /** Range read over [lo, hi] (bounds optional), ascending, deduplicated to the
   *  newest version per key with tombstones removed — the classic LSM merging
   *  iterator across the memtable and every SSTable. */
  range(lo: IndexKey | null, hi: IndexKey | null): { key: IndexKey; value: unknown }[] {
    const runs: Entry[][] = [this.mem.range(lo, hi)]
    for (const level of this.levels) for (const t of level) runs.push(t.range(lo, hi))
    const merged = mergeRuns(runs, true) // drop tombstones — a range read never sees deletions
    return merged.map((e) => ({ key: e.key, value: e.value }))
  }

  // ---- metrics & introspection -----------------------------------------

  private refreshMetrics(): void {
    const live = this.range(null, null)
    let totalEntries = 0
    let liveBytes = 0
    let diskBytes = 0
    const levelSizes: number[] = []
    const levelTables: number[] = []
    for (const level of this.levels) {
      let e = 0
      for (const t of level) {
        e += t.count
        totalEntries += t.count
        diskBytes += t.bytes
      }
      levelSizes.push(e)
      levelTables.push(level.length)
    }
    for (const { key, value } of live) liveBytes += estimateBytes({ key, seq: 0, value, tombstone: false })
    this.metrics.liveKeys = live.length
    this.metrics.totalEntries = totalEntries
    this.metrics.levelSizes = levelSizes
    this.metrics.levelTables = levelTables
    this.metrics.writeAmp = this.metrics.bytesFlushed > 0 ? this.bytesWrittenTotal / this.metrics.bytesFlushed : 1
    this.metrics.spaceAmp = liveBytes > 0 ? diskBytes / liveBytes : 1
  }

  private pushTrace(line: TraceLine): void {
    this.trace.push(line)
    if (this.trace.length > 400) this.trace.shift()
  }

  snapshot(): LsmSnapshot {
    return {
      memtable: this.mem.snapshot(),
      memSize: this.mem.size,
      memLimit: this.cfg.memtableLimit,
      strategy: this.cfg.strategy,
      levels: this.levels.map((level, i) =>
        level.map((t) => ({
          id: t.id,
          count: t.count,
          minKey: t.minKey,
          maxKey: t.maxKey,
          bytes: t.bytes,
          bloomFill: t.bloom.fillRatio(),
          bloomFpr: t.bloom.estimatedFpr(),
          bloomBits: t.bloom.m,
          blocks: t.blocks.length,
          hasTombstones: t.hasTombstones,
          level: i,
        })),
      ),
      metrics: { ...this.metrics },
    }
  }

  /** Prove the structure is a valid LSM after a mutation. Returns null if valid,
   *  else the first violation found — the differential self-tests run this after
   *  every flush/compaction. */
  checkInvariants(): string | null {
    for (let n = 0; n < this.levels.length; n++) {
      const level = this.levels[n]
      for (const t of level) {
        // Each SSTable is internally sorted and its sparse index/fences agree.
        let prev: IndexKey | null = null
        for (const e of t.all()) {
          if (prev && compareKeys(prev, e.key) >= 0) return `L${n} table #${t.id}: entries not strictly ascending`
          prev = e.key
        }
        for (let i = 1; i < t.index.length; i++) {
          if (compareKeys(t.index[i - 1].firstKey, t.index[i].firstKey) >= 0)
            return `L${n} table #${t.id}: sparse index not monotone`
        }
        if (t.count > 0) {
          if (compareKeys(t.minKey, t.all()[0].key) !== 0) return `L${n} table #${t.id}: minKey fence wrong`
          if (compareKeys(t.maxKey, t.all()[t.count - 1].key) !== 0) return `L${n} table #${t.id}: maxKey fence wrong`
        }
        // Bloom filter: no false negatives for the keys it actually holds.
        for (const e of t.all()) {
          if (!t.mayContain(e.key)) return `L${n} table #${t.id}: fence excludes a present key`
          if (t.get(e.key).entry === undefined) return `L${n} table #${t.id}: point-get missed a present key`
        }
      }
      // Leveled ≥ L1: tables sorted by key and strictly non-overlapping.
      // Lazy: the *deepest* level is leveled (one sorted, non-overlapping run);
      // shallower levels are tiered (no constraint).
      const leveledHere =
        (this.cfg.strategy === 'leveled' && n >= 1) ||
        (this.cfg.strategy === 'lazy' && n === this.deepestNonEmpty() && n >= 1)
      if (leveledHere) {
        for (let i = 1; i < level.length; i++) {
          if (compareKeys(level[i - 1].maxKey, level[i].minKey) >= 0)
            return `L${n}: tables overlap or are unsorted (#${level[i - 1].id}, #${level[i].id})`
        }
      }
    }
    return null
  }

  reset(): void {
    this.mem = new SkipList(this.cfg.seed)
    this.levels = [[]]
    this.seq = 0
    this.bytesWrittenTotal = 0
    this.compactPtr = []
    this.metrics = this.emptyMetrics()
    this.trace = [{ kind: 'reset', text: 'empty tree' }]
  }
}

// ---- the merging iterator (shared by range reads and compaction) --------

/** k-way merge of key-sorted runs (each one entry per key) into a single
 *  key-sorted run holding, for every key, the entry with the **highest seq**
 *  (newest wins). When `dropTombstones` is set, a key whose winner is a
 *  tombstone is omitted entirely — used by range reads (deletions are invisible)
 *  and by compaction *at the bottom level* (no older data left to shadow). */
export function mergeRuns(runs: Entry[][], dropTombstones: boolean): Entry[] {
  const cursors = runs.map(() => 0)
  const out: Entry[] = []
  for (;;) {
    // Find the smallest current key across all runs.
    let minKey: IndexKey | null = null
    for (let r = 0; r < runs.length; r++) {
      if (cursors[r] < runs[r].length) {
        const k = runs[r][cursors[r]].key
        if (minKey === null || compareKeys(k, minKey) < 0) minKey = k
      }
    }
    if (minKey === null) break
    // Among all runs positioned at minKey, take the newest (max seq); advance all.
    let winner: Entry | null = null
    for (let r = 0; r < runs.length; r++) {
      if (cursors[r] < runs[r].length && compareKeys(runs[r][cursors[r]].key, minKey) === 0) {
        const e = runs[r][cursors[r]]
        if (winner === null || e.seq > winner.seq) winner = e
        cursors[r]++
      }
    }
    if (winner && !(dropTombstones && winner.tombstone)) out.push(winner)
  }
  return out
}

// ---- Lab snapshot types --------------------------------------------------

export interface TableView {
  id: number
  count: number
  minKey: IndexKey
  maxKey: IndexKey
  bytes: number
  bloomFill: number
  bloomFpr: number
  bloomBits: number
  blocks: number
  hasTombstones: boolean
  level: number
}
export interface LsmSnapshot {
  memtable: SkipSnapshot
  memSize: number
  memLimit: number
  strategy: Strategy
  levels: TableView[][]
  metrics: LsmMetrics
}

function fmtKey(k: IndexKey): string {
  return k.length === 1 ? String(k[0]) : `(${k.join(', ')})`
}
