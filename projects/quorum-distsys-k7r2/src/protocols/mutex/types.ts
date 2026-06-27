// Types for the Lamport mutual-exclusion lab — coordinating exclusive access to
// a shared resource with no lock server, using only logical clocks and messages.
//
// Lamport's 1978 algorithm (the worked example in "Time, Clocks, and the
// Ordering of Events") is the canonical use of **logical clocks**: every process
// keeps a Lamport clock, and requests to enter the critical section are totally
// ordered by `(timestamp, processId)`. A process enters the critical section when
//
//   1. its own request sits at the head of its request queue (the (ts,id)-minimum), and
//   2. it has received a message from *every* other process timestamped later than
//      its request — proof that no earlier request can still be in flight.
//
// Three message types drive it: REQUEST (broadcast on wanting in), REPLY
// (acknowledging a request), and RELEASE (broadcast on leaving). Mutual exclusion
// falls out of the total order — and, like Chandy–Lamport, it needs **FIFO
// channels**, so this protocol layers a per-channel sequence number + reorder
// buffer over the kernel's reordering network.
import type { NodeId } from '../../sim/types';

export interface MutexConfig {
  /** Mean time a process waits before it next wants the critical section. */
  thinkDelay: number;
  /** How long a process holds the critical section once it enters. */
  csDuration: number;
}

export const DEFAULT_MUTEX_CONFIG: MutexConfig = {
  thinkDelay: 220,
  csDuration: 140,
};

/** A queued request, ordered by (ts, id). */
export interface ReqEntry {
  ts: number;
  id: NodeId;
}

/** Buffered message awaiting its turn in a channel's FIFO order. */
export interface Buffered {
  kind: 'request' | 'reply' | 'release';
  ts: number;
}

export type MutexPhase = 'idle' | 'wanting' | 'held';

export interface MutexState {
  self: NodeId;
  /** Lamport logical clock. */
  clock: number;
  /** This node's request queue, kept sorted by (ts, id). */
  queue: ReqEntry[];
  phase: MutexPhase;
  /** Timestamp of this node's outstanding request (null when idle). */
  myReqTs: number | null;
  /** Whether this node is currently in the critical section. */
  inCS: boolean;
  /** Max timestamp seen in any message from each peer (the condition-2 witness). */
  lastTsFrom: Record<NodeId, number>;

  // ---- FIFO channel layer -------------------------------------------------
  outSeq: Record<NodeId, number>;
  inExpected: Record<NodeId, number>;
  inBuf: Record<NodeId, Record<number, Buffered>>;

  // ---- stats --------------------------------------------------------------
  /** How many times this node has entered the critical section. */
  entries: number;
  /** When the current request was made / CS entered (virtual ms), for fairness UI. */
  requestedAt: number | null;
  enteredAt: number | null;
  /** Longest time this node has ever waited from request to entry. */
  maxWait: number;
  note: string;
}

// ---- message payloads -----------------------------------------------------

export interface MutexMsg {
  seq: number;
  ts: number;
}

// ---- client commands ------------------------------------------------------

export type MutexCmd =
  /** Make this node want the critical section now. */
  | { type: 'request' }
  /** Force this node to leave the critical section now. */
  | { type: 'release' };

/** Compare two (ts,id) request entries. */
export function cmpReq(a: ReqEntry, b: ReqEntry): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
