// The LSM amplification benchmark — the RUM trade-off, made measurable.
//
// Every storage engine pays in three currencies (the "RUM conjecture", Athanassoulis
// et al. 2016): **R**ead amplification (extra data touched per lookup), **U**pdate/write
// amplification (extra bytes written per user byte, from rewriting during compaction)
// and **M**emory/space amplification (extra storage held vs. the live data). You cannot
// minimize all three at once; a compaction strategy picks a point on the frontier.
// This bench runs the **same deterministic workload** through all three strategies and
// measures where each lands:
//   • **leveled** (LevelDB/RocksDB) — one sorted run per level: low read/space amp,
//     high write amp (data is rewritten every time a level absorbs a merge);
//   • **size-tiered** (Cassandra) — several runs per tier merged wholesale: low write
//     amp, high read/space amp (a key can sit in many overlapping runs at once);
//   • **lazy-leveled** (Dostoevsky) — tiered shallow, leveled at the largest level:
//     near-tiered writes with near-leveled reads/space.
// The load-bearing check is the differential one: whatever the amplification profile,
// **all three strategies must return byte-for-byte identical live data** for the same
// op stream — the trade-off is only ever in *cost*, never in *answers*.

import { LsmTree, type Strategy, type LsmConfig } from './tree'
import { compareKeys, type IndexKey } from '../storage/btree'
import { Rng } from '../fuzz/rng'

export interface StrategyResult {
  strategy: Strategy
  writeAmp: number
  spaceAmp: number
  avgReadTables: number // SSTables actually read per point lookup (measured read amp)
  avgReadSkips: number // tables skipped by Bloom/fence per lookup
  flushes: number
  compactions: number
  totalEntries: number
  liveKeys: number
  levels: number
  live: { key: IndexKey; value: unknown }[]
}

export interface BenchResult {
  ops: number
  probes: number
  identical: boolean // every strategy returned the same live state
  results: StrategyResult[]
}

const STRATEGIES: Strategy[] = ['leveled', 'tiered', 'lazy']

interface Op {
  del: boolean
  key: number
  val: number
}

/** Build one deterministic op stream so every strategy sees the identical
 *  workload. A Zipfian-ish key skew (squaring a uniform draw) makes overwrites
 *  and deletes cluster on hot keys — exactly where the strategies diverge. */
function buildStream(ops: number, domain: number, rng: Rng): Op[] {
  const stream: Op[] = []
  for (let i = 0; i < ops; i++) {
    const u = rng.next()
    const key = Math.floor(u * u * domain) // skew toward small keys
    if (rng.chance(0.25)) stream.push({ del: true, key, val: 0 })
    else stream.push({ del: false, key, val: rng.int(0, 1_000_000) })
  }
  return stream
}

export function runBench(ops = 3000, seed = 0xa11, config: Partial<LsmConfig> = {}): BenchResult {
  const domain = Math.max(64, Math.floor(ops / 6))
  const stream = buildStream(ops, domain, new Rng(seed))
  // A fixed probe set: half present-ish (small keys), half likely-absent (large).
  const probes: number[] = []
  const pr = new Rng(seed ^ 0x5151)
  const P = 400
  for (let i = 0; i < P; i++) probes.push(pr.chance(0.5) ? pr.int(0, domain) : pr.int(domain, domain * 3))

  const results: StrategyResult[] = []
  for (const strategy of STRATEGIES) {
    const tree = new LsmTree({
      strategy,
      memtableLimit: 24,
      blockSize: 8,
      fanout: 4,
      l0Trigger: 4,
      tierTrigger: 4,
      targetFileEntries: 24,
      seed,
      ...config,
    })
    for (const op of stream) {
      if (op.del) tree.del([op.key])
      else tree.put([op.key], op.val)
    }
    tree.flush()
    // Measure read amplification by replaying the probe set.
    let readTables = 0
    let readSkips = 0
    for (const k of probes) {
      const r = tree.get([k])
      readTables += r.tablesConsulted
      readSkips += r.bloomSkips + r.fenceSkips
    }
    const m = tree.metrics
    results.push({
      strategy,
      writeAmp: m.writeAmp,
      spaceAmp: m.spaceAmp,
      avgReadTables: readTables / probes.length,
      avgReadSkips: readSkips / probes.length,
      flushes: m.flushes,
      compactions: m.compactions,
      totalEntries: m.totalEntries,
      liveKeys: m.liveKeys,
      levels: tree.levels.length,
      live: tree.range(null, null),
    })
  }

  // Differential gate: every strategy must agree on the live state exactly.
  let identical = true
  const ref = results[0].live
  for (let s = 1; s < results.length; s++) {
    const l = results[s].live
    if (l.length !== ref.length) {
      identical = false
      break
    }
    for (let i = 0; i < l.length; i++) {
      if (compareKeys(l[i].key, ref[i].key) !== 0 || l[i].value !== ref[i].value) {
        identical = false
        break
      }
    }
    if (!identical) break
  }

  return { ops, probes: probes.length, identical, results }
}
