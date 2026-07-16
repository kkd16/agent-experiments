// The pluggable concurrency-control (CC) protocol layer.
//
// QueryForge already ships a full MVCC engine (`../concurrency`). This module is
// its counterpoint: a family of the *other* classic concurrency-control
// protocols — **Strict Two-Phase Locking**, **Optimistic CC (backward
// validation)** and **Basic Timestamp Ordering** — implemented from scratch
// against the *same* interleaved-schedule model, so the exact same schedule can
// be run through every protocol and compared side by side.
//
// The point is to make the textbook trade-off tangible: all of these protocols
// only ever admit **conflict-serializable** committed histories, but they get
// there in completely different ways — 2PL *blocks* (and can deadlock), OCC and
// T/O *abort* — and they differ in the *other* correctness properties (2PL and
// OCC are recoverable and cascadeless; basic T/O is neither: it permits dirty
// reads and so needs cascading rollback). A protocol-independent
// **conflict-serializability oracle** (`history.ts`) is the ground truth that
// verifies every protocol keeps its promise.
//
// Everything here is deliberately standalone (it depends only on the schedule
// model in `../concurrency/scenarios` and the `Val` type) so it can be reasoned
// about and tested in isolation, exactly like the MVCC engine it sits beside.

import type { Val } from '../concurrency/mvcc'

export type ProtocolId = 's2pl' | 'occ' | 'to' | 'mvcc'

/** A predicate (range) read: a label for the UI plus the membership test. */
export interface Predicate {
  label: string
  test: (v: Val) => boolean
}

/** Static, human-facing description of a protocol + its correctness promises. */
export interface ProtocolMeta {
  id: ProtocolId
  name: string
  /** short code for compact UI (e.g. "S2PL") */
  short: string
  family: 'pessimistic' | 'optimistic' | 'timestamp' | 'multiversion'
  tagline: string
  blurb: string
  /** how the protocol reacts to a conflict */
  conflictReaction: 'block' | 'abort'
  guarantees: {
    serializable: boolean
    recoverable: boolean
    cascadeless: boolean
    deadlockFree: boolean
  }
}

// --- the low-level access model used by the serializability oracle ----------

/** One data access (read or write of a logical item) that actually took effect,
 *  tagged with the executing transaction and a global execution sequence number.
 *  `item` may be a real row key **or** the synthetic `#index` guard that models
 *  a predicate / structural (insert/delete) access for phantom reasoning. */
export interface Access {
  txn: string
  kind: 'r' | 'w'
  item: string
  seq: number
}

/** The synthetic item every predicate read and every structural (insert/delete)
 *  write touches, so a predicate-vs-insert phantom shows up as an ordinary
 *  read/write conflict in the oracle and in every protocol's conflict handling. */
export const INDEX_GUARD = '#index'

// --- what an engine returns for one operation -------------------------------

/** The item(s) an operation touched, reported by the engine so the scheduler can
 *  build the global access log the oracle consumes. */
export interface Touch {
  kind: 'r' | 'w'
  item: string
}

export type EngineStep =
  | {
      status: 'ok'
      touched: Touch[]
      read?: { found: boolean; value: Val }
      rows?: { key: string; value: Val }[]
      note?: string
    }
  /** 2PL only: the operation must wait for the listed lock holders. */
  | { status: 'blocked'; waitsFor: string[]; note?: string }
  /** the protocol forces this transaction to abort (serialization failure). */
  | { status: 'abort'; reason: string }

export type TxnStatus = 'active' | 'committed' | 'aborted'

/** A single engine implementing one concurrency-control protocol. Methods are
 *  **non-throwing** — they return outcome objects so the scheduler can react to
 *  blocks and aborts, exactly like the MVCC store. */
export interface ProtocolEngine {
  readonly meta: ProtocolMeta
  seed(key: string, value: Val): void
  begin(label: string): void
  read(label: string, key: string): EngineStep
  readWhere(label: string, pred: Predicate): EngineStep
  write(label: string, key: string, value: Val): EngineStep
  del(label: string, key: string): EngineStep
  /** ok, or abort (e.g. OCC validation failure). */
  commit(label: string): EngineStep
  /** roll back and release; `cascade` receives any transactions that must abort
   *  transitively (basic T/O read-from a now-aborted writer). */
  abort(label: string, reason: string): string[]
  status(label: string): TxnStatus
  /** the final committed value of every live row. */
  committedRows(): { key: string; value: Val }[]
}
