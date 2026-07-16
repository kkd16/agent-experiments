// The head-to-head: run one scenario through every concurrency-control protocol,
// plus a deterministic random-schedule generator used by the self-tests to fuzz
// each protocol against the serializability oracle.

import type { Scenario, ScheduleOp } from '../concurrency/scenarios'
import type { IsolationLevel, Val } from '../concurrency/mvcc'
import { runProtocol } from './scheduler'
import { runMvccAsProtocol, MVCC_META } from './mvccAdapter'
import { TwoPhaseLockEngine, S2PL_META } from './lock2pl'
import { OptimisticEngine, OCC_META } from './occ'
import { TimestampEngine, TO_META } from './timestamp'
import type { ProtocolEngine, ProtocolId, ProtocolMeta } from './types'
import type { ProtocolRunResult } from './result'

/** The lock-free / lock-based engines this driver can construct fresh per run. */
export function makeEngine(id: Exclude<ProtocolId, 'mvcc'>): ProtocolEngine {
  switch (id) {
    case 's2pl':
      return new TwoPhaseLockEngine()
    case 'occ':
      return new OptimisticEngine()
    case 'to':
      return new TimestampEngine()
  }
}

export const PROTOCOL_METAS: ProtocolMeta[] = [S2PL_META, OCC_META, TO_META, MVCC_META]
export const PROTOCOL_ORDER: ProtocolId[] = ['s2pl', 'occ', 'to', 'mvcc']

/** Run a single protocol against a scenario. */
export function runOne(
  id: ProtocolId,
  scenario: Scenario,
  mvccLevel: IsolationLevel = 'SERIALIZABLE',
): ProtocolRunResult {
  if (id === 'mvcc') return runMvccAsProtocol(scenario, mvccLevel)
  return runProtocol(makeEngine(id), scenario)
}

/** Run every protocol against one scenario, in display order. */
export function runAll(
  scenario: Scenario,
  mvccLevel: IsolationLevel = 'SERIALIZABLE',
): ProtocolRunResult[] {
  return PROTOCOL_ORDER.map((id) => runOne(id, scenario, mvccLevel))
}

// --- deterministic random schedule generator (for fuzzing the oracle) -------

/** mulberry32 — a tiny, fast, seedable PRNG (deterministic across workers). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface GenOptions {
  txns?: number
  keys?: number
  opsPerTxn?: number
  /** probability a transaction ends with an explicit abort rather than commit */
  abortRate?: number
}

/**
 * Generate a random-but-legal interleaved schedule over a few integer rows. Each
 * transaction gets a private op list (reads/writes over shared keys, ending in
 * commit or abort); the lists are merged by repeatedly advancing a random still-
 * running transaction, which preserves each transaction's program order while
 * interleaving them arbitrarily. Fully determined by `seed`.
 */
export function generateSchedule(seed: number, opts: GenOptions = {}): Scenario {
  const rnd = mulberry32(seed)
  const nT = opts.txns ?? 3
  const nK = opts.keys ?? 3
  const perT = opts.opsPerTxn ?? 4
  const abortRate = opts.abortRate ?? 0.15
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]

  const keys = Array.from({ length: nK }, (_, i) => String.fromCharCode(97 + i)) // a, b, c…
  const initial = keys.map((key) => ({ key, value: (Math.floor(rnd() * 5) + 1) as Val }))

  // Per-transaction op lists (each already ordered, ending in commit/abort).
  const perTxn: ScheduleOp[][] = []
  for (let ti = 0; ti < nT; ti++) {
    const t = `T${ti + 1}`
    const ops: ScheduleOp[] = [{ t, kind: 'begin' }]
    const n = 1 + Math.floor(rnd() * perT)
    for (let k = 0; k < n; k++) {
      const key = pick(keys)
      if (rnd() < 0.5) ops.push({ t, kind: 'read', key })
      else ops.push({ t, kind: 'write', key, value: (Math.floor(rnd() * 9) + 1) as Val })
    }
    ops.push({ t, kind: rnd() < abortRate ? 'abort' : 'commit' })
    perTxn.push(ops)
  }

  // Merge, always advancing some transaction that still has ops.
  const cursors = perTxn.map(() => 0)
  const ops: ScheduleOp[] = []
  const remaining = () => perTxn.filter((list, i) => cursors[i] < list.length)
  while (remaining().length) {
    let i = Math.floor(rnd() * perTxn.length)
    while (cursors[i] >= perTxn[i].length) i = (i + 1) % perTxn.length
    ops.push(perTxn[i][cursors[i]++])
  }

  return {
    id: `gen-${seed}`,
    title: `random schedule #${seed}`,
    tagline: 'generated',
    blurb: '',
    initial,
    ops,
    lesson: '',
    anomalyAt: [],
  }
}
