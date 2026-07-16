// The shape of a completed protocol run: the per-step trace, the per-transaction
// outcome, the committed final state, and the oracle's serializability verdict —
// everything the lab renders and the self-tests assert against.

import type { Val } from '../concurrency/mvcc'
import type { Access, ProtocolId, ProtocolMeta } from './types'

export type { Access }

export type ProtocolStepStatus = 'begin' | 'ok' | 'blocked' | 'aborted' | 'committed' | 'noop'

export interface ProtocolStep {
  seq: number
  opIndex: number
  /** transaction label */
  t: string
  /** human-readable op, e.g. "read(price)" */
  op: string
  status: ProtocolStepStatus
  detail: string
  readValue?: Val
  found?: boolean
  rows?: { key: string; value: Val }[]
  blockedOn?: string
  abortReason?: string
}

export interface TxnOutcome {
  label: string
  status: 'active' | 'committed' | 'aborted'
  reason?: string
}

export interface RunMetrics {
  aborts: number
  deadlocks: number
  blocks: number
  committed: number
  validationFails: number
}

export interface ProtocolRunResult {
  protocol: ProtocolId
  meta: ProtocolMeta
  steps: ProtocolStep[]
  outcomes: TxnOutcome[]
  committedRows: { key: string; value: Val }[]
  /** is the committed projection conflict-serializable (per the oracle)? */
  serializable: boolean
  /** a witnessing cycle of labels when not serializable */
  cycle: string[] | null
  /** an equivalent serial order when serializable */
  order: string[] | null
  metrics: RunMetrics
  accessLog: Access[]
  verdict: string
  verdictKind: 'serializable' | 'nonserializable'
}
