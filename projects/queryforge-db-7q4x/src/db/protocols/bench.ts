// The concurrency-control benchmark — the counterpart to the LSM RUM benchmark.
//
// It runs the *same* deterministic stream of random schedules through every
// protocol across a **contention sweep** (shrinking the hot-set of keys the
// transactions fight over) and measures the block-vs-abort trade-off: how many
// transactions commit, and *why* the rest fail (deadlock, validation, cascade).
// The qualitative story it makes visible — and the self-tests assert — is that
// every protocol degrades as contention rises, but they degrade *differently*:
// locking trades throughput for blocking and the occasional deadlock; optimistic
// and timestamp ordering burn work on aborts that climb steeply under contention.

import { generateSchedule, runOne } from './compare'
import { PROTOCOL_ORDER } from './compare'
import type { ProtocolId } from './types'

export interface ProtocolBenchStat {
  protocol: ProtocolId
  started: number
  committed: number
  aborted: number
  deadlocks: number
  validationFails: number
  cascades: number
  blocks: number
  /** committed / started, in [0, 1] */
  commitRate: number
  /** aborted / started, in [0, 1] */
  abortRate: number
}

export interface BenchPoint {
  /** size of the shared key space (fewer keys ⇒ more contention) */
  keys: number
  /** a 0–1 contention index (1 = hottest) for charting */
  contention: number
  stats: ProtocolBenchStat[]
}

export interface BenchResult {
  points: BenchPoint[]
  config: { keySizes: number[]; txns: number; opsPerTxn: number; seeds: number }
}

export interface BenchOptions {
  keySizes?: number[]
  txns?: number
  opsPerTxn?: number
  seeds?: number
}

/** Run the full contention sweep. Fully deterministic in the seed range. */
export function runBenchmark(opts: BenchOptions = {}): BenchResult {
  const keySizes = opts.keySizes ?? [1, 2, 3, 5, 8]
  const txns = opts.txns ?? 4
  const opsPerTxn = opts.opsPerTxn ?? 6
  const seeds = opts.seeds ?? 150

  const points: BenchPoint[] = keySizes.map((keys) => {
    const acc = new Map<ProtocolId, ProtocolBenchStat>()
    for (const id of PROTOCOL_ORDER)
      acc.set(id, {
        protocol: id,
        started: 0,
        committed: 0,
        aborted: 0,
        deadlocks: 0,
        validationFails: 0,
        cascades: 0,
        blocks: 0,
        commitRate: 0,
        abortRate: 0,
      })

    for (let seed = 1; seed <= seeds; seed++) {
      // No explicit user aborts, so every failure is protocol-induced.
      const sc = generateSchedule(seed * 7 + keys, { txns, keys, opsPerTxn, abortRate: 0 })
      for (const id of PROTOCOL_ORDER) {
        const r = runOne(id, sc)
        const s = acc.get(id)!
        s.started += r.outcomes.length
        for (const o of r.outcomes) {
          if (o.status === 'committed') s.committed++
          else if (o.status === 'aborted') {
            s.aborted++
            if (o.reason === 'cascade abort') s.cascades++
          }
        }
        s.deadlocks += r.metrics.deadlocks
        s.validationFails += r.metrics.validationFails
        s.blocks += r.metrics.blocks
      }
    }

    for (const s of acc.values()) {
      s.commitRate = s.started ? s.committed / s.started : 0
      s.abortRate = s.started ? s.aborted / s.started : 0
    }
    // Contention index: keys=1 is hottest (1), larger key spaces cooler (→0).
    const contention = 1 / keys
    return { keys, contention, stats: PROTOCOL_ORDER.map((id) => acc.get(id)!) }
  })

  return { points, config: { keySizes, txns, opsPerTxn, seeds } }
}
