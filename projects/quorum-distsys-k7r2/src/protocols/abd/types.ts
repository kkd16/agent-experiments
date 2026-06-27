// Types for the ABD lab — a linearizable read/write register *without consensus*.
//
// ABD (Attiya, Bar-Noy & Dolev, JACM 1995) is the quiet counterpoint to every
// consensus lab here. Raft, Paxos, EPaxos and friends agree on a *total order of
// commands*; ABD shows that if all you need is a **linearizable (atomic)
// read/write register**, you don't need consensus at all — just majority
// quorums and two round trips. There is no leader and no log: each replica keeps
// one (value, tag) pair per key, every operation is coordinated by whichever node
// the client touched, and atomicity falls out of two ideas:
//
//   • A **tag** `(seq, writer)` totally orders writes. A writer first *reads* the
//     latest tag from a majority, then writes value under `(maxSeq+1, self)` to a
//     majority. Because any two majorities intersect, the new tag is strictly
//     above every completed write — so writes are globally ordered with no
//     coordination.
//   • A reader does the same first phase to find the highest (tag, value) in a
//     majority, then **writes it back** to a majority before returning it. That
//     write-back is the whole trick: it guarantees a value a read returns is
//     durable at a majority, so no later read can ever go *backwards* in time.
//
// The result is a multi-writer multi-reader atomic register, tolerant of any
// minority of crashes — and the lab proves it linearizable live, by recording the
// real-time operation history and checking the classic atomic-register condition
// on every render.
import type { NodeId } from '../../sim/types';

/** A logical timestamp: writes are totally ordered by `(seq, writer)`. */
export interface Tag {
  seq: number;
  node: NodeId;
}

/** ⊥ — the tag of a register that has never been written. */
export const BOTTOM: Tag = { seq: 0, node: '' };

export function cmpTag(a: Tag, b: Tag): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.node < b.node ? -1 : a.node > b.node ? 1 : 0;
}

export const tagEq = (a: Tag, b: Tag) => cmpTag(a, b) === 0;

export function tagStr(t: Tag): string {
  return t.node === '' ? '⊥' : `${t.seq}.${t.node}`;
}

/** One replica's stored register for a key. */
export interface Register {
  tag: Tag;
  value: string;
}

// ---- coordinator-side operation bookkeeping (volatile) --------------------

export type OpKind = 'read' | 'write';
export type OpPhase = 'query' | 'write';

export interface OpRec {
  id: string;
  kind: OpKind;
  key: string;
  /** For a write: the value to store. For a read: filled in after the query phase. */
  value: string;
  phase: OpPhase;
  startedAt: number;
  /** Phase-1 replies (tag,value) keyed by replica; includes the coordinator. */
  queryAcks: Record<NodeId, { tag: Tag; value: string }>;
  /** Phase-2 acks keyed by replica; includes the coordinator. */
  writeAcks: Record<NodeId, true>;
  /** The tag being written in phase 2 (a fresh one for a write, the read-back tag for a read). */
  tag: Tag;
}

/** A finished operation — the record the linearizability checker reasons over. */
export interface CompletedOp {
  id: string;
  kind: OpKind;
  key: string;
  /** The value written, or the value a read returned. */
  value: string;
  /** The tag written, or the tag a read returned/wrote-back. */
  tag: Tag;
  startedAt: number;
  finishedAt: number;
  coord: NodeId;
}

export interface AbdState {
  self: NodeId;
  /** The replica's register store (stable storage): key → (tag, value). */
  store: Record<string, Register>;
  /** Operations this node is currently coordinating (volatile). */
  pending: Record<string, OpRec>;
  /** Completed operations this node coordinated (the linearizability history). */
  history: CompletedOp[];
  opCounter: number;
  /** Monotonic floor on the seq numbers this node has issued, so two operations
   *  it coordinates concurrently can never collide on the same `(seq, node)` tag. */
  lastWriteSeq: number;
  note: string;
  reads: number;
  writes: number;
}

export interface AbdConfig {
  /** Re-broadcast the current phase after this long with no quorum (liveness after a heal). */
  retry: number;
  /** Cap on retained history per node. */
  historyCap: number;
}

export const DEFAULT_ABD_CONFIG: AbdConfig = {
  retry: 240,
  historyCap: 80,
};

// ---- message payloads -----------------------------------------------------

export interface QueryMsg {
  opId: string;
  key: string;
}
export interface QueryAckMsg {
  opId: string;
  key: string;
  tag: Tag;
  value: string;
  from: NodeId;
}
export interface WriteMsg {
  opId: string;
  key: string;
  tag: Tag;
  value: string;
}
export interface WriteAckMsg {
  opId: string;
  from: NodeId;
}

// ---- client commands ------------------------------------------------------

export type AbdCmd =
  | { type: 'write'; key: string; value: string }
  | { type: 'read'; key: string };
