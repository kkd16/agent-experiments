// Adapts QueryForge's existing MVCC engine (`../concurrency`) to the common
// `ProtocolRunResult` shape so it can stand as a fourth column beside Strict 2PL,
// OCC and Basic T/O in the head-to-head. MVCC is the odd one out — it keeps
// *versions* rather than a single value, so readers never block writers — and at
// SERIALIZABLE it reaches the same guarantee (serializability) by an entirely
// different route: Cahill's SSI, watching for dangerous rw-antidependency
// structures rather than ordering conflicts up front.

import { runScenario } from '../concurrency/runner'
import type { Scenario } from '../concurrency/scenarios'
import type { IsolationLevel } from '../concurrency/mvcc'
import type { ProtocolMeta } from './types'
import type { ProtocolRunResult, ProtocolStep, TxnOutcome } from './result'

export const MVCC_META: ProtocolMeta = {
  id: 'mvcc',
  name: 'Multi-Version CC (SSI)',
  short: 'MVCC',
  family: 'multiversion',
  tagline: 'snapshot reads + serializable snapshot isolation',
  blurb:
    'Every row is a chain of versions, so a reader never blocks a writer and vice-versa — each transaction reads a consistent snapshot. At SERIALIZABLE, Cahill’s SSI tracks read/write antidependencies and aborts a transaction when a dangerous structure forms, reaching serializability without ordering every conflict up front.',
  conflictReaction: 'abort',
  guarantees: { serializable: true, recoverable: true, cascadeless: true, deadlockFree: false },
}

export function runMvccAsProtocol(
  scenario: Scenario,
  level: IsolationLevel = 'SERIALIZABLE',
): ProtocolRunResult {
  const res = runScenario(scenario, level)

  const steps: ProtocolStep[] = res.steps.map((s) => ({
    seq: s.seq,
    opIndex: s.opIndex,
    t: s.t,
    op: s.op,
    status: s.status,
    detail: s.detail,
    readValue: s.readValue,
    found: s.found,
    rows: s.rows,
    blockedOn: s.blockedOn,
    abortReason: s.abortReason,
  }))

  // Derive per-transaction outcomes from the trace, in first-appearance order.
  const status = new Map<string, TxnOutcome['status']>()
  const reason = new Map<string, string>()
  const order: string[] = []
  for (const op of scenario.ops) {
    if (!status.has(op.t)) {
      status.set(op.t, 'active')
      order.push(op.t)
    }
  }
  for (const s of res.steps) {
    if (s.status === 'committed') status.set(s.t, 'committed')
    else if (s.status === 'aborted') {
      status.set(s.t, 'aborted')
      if (s.abortReason) reason.set(s.t, s.abortReason)
    }
  }
  const outcomes: TxnOutcome[] = order.map((l) => ({
    label: l,
    status: status.get(l) ?? 'active',
    reason: reason.get(l),
  }))

  const metrics = {
    aborts: res.aborts.length,
    deadlocks: res.aborts.filter((a) => a.reason === 'deadlock detected').length,
    blocks: res.steps.filter((s) => s.status === 'blocked').length,
    committed: outcomes.filter((o) => o.status === 'committed').length,
    validationFails: res.aborts.filter((a) => a.reason.includes('serialize')).length,
  }

  return {
    protocol: 'mvcc',
    meta: MVCC_META,
    steps,
    outcomes,
    committedRows: res.finalRows,
    serializable: res.serializable,
    cycle: res.cycle,
    order: null,
    metrics,
    accessLog: [],
    verdict: res.verdict,
    verdictKind: res.serializable ? 'serializable' : 'nonserializable',
  }
}
