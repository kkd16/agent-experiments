// Types for the Multi-Paxos lab.
//
// Paxos is built on one idea — a totally-ordered, globally-unique **ballot**
// (proposal number) — and two message round-trips (Prepare/Promise, then
// Accept/Accepted). Everything else (Multi-Paxos, leader election, catch-up) is
// scaffolding around that core. The acceptor state below is the protocol's
// *stable storage*: it must survive a crash, because Paxos's safety theorem
// depends on an acceptor never forgetting what it has promised or accepted.
import type { NodeId } from '../../sim/types';

/**
 * A Paxos proposal number. Compared lexicographically by `(n, node)` so it is a
 * total order with no ties — two proposers that pick the same counter `n` still
 * get distinct, ordered ballots because their node ids differ. `null` means ⊥
 * (lower than every real ballot).
 */
export interface Ballot {
  n: number;
  node: NodeId;
}

/** Compare two ballots; `null` is ⊥. Returns <0, 0 or >0. */
export function cmpBallot(a: Ballot | null, b: Ballot | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (a.n !== b.n) return a.n - b.n;
  return a.node < b.node ? -1 : a.node > b.node ? 1 : 0;
}

export const ballotEq = (a: Ballot | null, b: Ballot | null) => cmpBallot(a, b) === 0;

export function ballotStr(b: Ballot | null): string {
  return b === null ? '⊥' : `${b.n}.${b.node}`;
}

/** A value the cluster is trying to agree on: one command for the replicated KV. */
export type PaxosValue =
  | { op: 'set'; key: string; value: string; cid: string }
  | { op: 'del'; key: string; cid: string }
  | { op: 'noop' };

/** Deep value equality (the chosen-value comparison the safety proof rests on). */
export function valueEq(a: PaxosValue | null, b: PaxosValue | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.op !== b.op) return false;
  if (a.op === 'noop' || b.op === 'noop') return a.op === b.op;
  if (a.op === 'set' && b.op === 'set') return a.key === b.key && a.value === b.value && a.cid === b.cid;
  if (a.op === 'del' && b.op === 'del') return a.key === b.key && a.cid === b.cid;
  return false;
}

export function valueStr(v: PaxosValue | null): string {
  if (v === null) return '—';
  if (v.op === 'noop') return 'no-op';
  if (v.op === 'set') return `${v.key}=${v.value}`;
  return `del ${v.key}`;
}

/** Per-slot acceptor record (part of stable storage). */
export interface AcceptorSlot {
  acceptedBallot: Ballot | null;
  acceptedValue: PaxosValue | null;
}

export type Role = 'idle' | 'preparing' | 'leader';

export interface PaxosState {
  // ---- acceptor: STABLE storage (survives a crash) -----------------------
  /** n_p — the highest ballot this node has promised; covers every slot (Multi-Paxos). */
  minProposal: Ballot | null;
  /** n_a / v_a per slot index. */
  slots: Record<number, AcceptorSlot>;

  // ---- learner: decisions this node knows are chosen (also stable) -------
  chosen: Record<number, PaxosValue>;
  /** Highest slot index this node has ever seen any activity for (for the UI / gap fill). */
  maxSlot: number;

  // ---- replicated state machine (rebuilt from `chosen`) ------------------
  kv: Record<string, string>;
  /** Highest slot index applied to `kv` such that every slot ≤ it is chosen. */
  applied: number;

  // ---- proposer / leader: VOLATILE (rebuilt by re-running Phase 1) -------
  role: Role;
  /** The ballot this node is currently proposing under. */
  myBallot: Ballot | null;
  /** Who we currently believe leads (from heartbeats), for the UI + forwarding. */
  leaderId: NodeId | null;
  /** Phase-1 promises collected this round: node → its reported accepted slots. */
  promises: Record<NodeId, Record<number, { ballot: Ballot; value: PaxosValue }>>;
  /** Whether a node has promised this round (covers empty promises too). */
  promised: Record<NodeId, boolean>;
  /** Phase-2 acks per slot: slot → (node → true). */
  accepts: Record<number, Record<NodeId, boolean>>;
  /** The value the leader is driving into each slot this term. */
  proposing: Record<number, PaxosValue>;
  /** Next free slot the leader will assign a brand-new client value to. */
  nextSlot: number;
  /** Client values queued before this node had a slot/leadership to place them. */
  pending: PaxosValue[];

  // ---- leadership / election --------------------------------------------
  electionTimeout: number;
  lastLeaderContact: number;
  /** Teaching toggle: a leader that has gone silent (stops heartbeating) without crashing. */
  hbOff: boolean;

  // ---- UI annotation -----------------------------------------------------
  note: string;
}

export interface PaxosConfig {
  electionMin: number;
  electionMax: number;
  heartbeat: number;
  /** When false, every node uses the *same* timeout (electionMin) — reproduces the
   *  dueling-proposer livelock so it can be watched, then fixed by turning it on. */
  randomizedBackoff: number; // 1 = on, 0 = off (number so it round-trips through the URL hash)
}

export const DEFAULT_PAXOS_CONFIG: PaxosConfig = {
  electionMin: 320,
  electionMax: 640,
  heartbeat: 130,
  randomizedBackoff: 1,
};

// ---- message payloads -----------------------------------------------------

export interface Prepare {
  ballot: Ballot;
}
export interface Promise {
  ballot: Ballot; // the ballot being promised to (echoes Prepare.ballot)
  promised: Ballot | null; // the acceptor's minProposal (so a proposer learns if it's superseded)
  accepted: Record<number, { ballot: Ballot; value: PaxosValue }>; // accepted values, per slot
  from: NodeId;
}
export interface Accept {
  ballot: Ballot;
  slot: number;
  value: PaxosValue;
}
export interface Accepted {
  ballot: Ballot; // ballot the acceptor accepted (echoes Accept.ballot on success)
  slot: number;
  ok: boolean;
  promised: Ballot | null; // on rejection: the acceptor's higher minProposal
  from: NodeId;
}
export interface Chosen {
  slot: number;
  value: PaxosValue;
}
export interface Heartbeat {
  ballot: Ballot; // the leader's ballot
  leader: NodeId;
  /** Compact catch-up: all slots the leader knows are chosen (clusters here are tiny). */
  chosen: Record<number, PaxosValue>;
}
export interface Forward {
  value: PaxosValue;
}

export type PaxosCmd =
  | { type: 'propose'; value: PaxosValue }
  | { type: 'prepare' } // force this node to start Phase 1 now (UI: "force election")
  | { type: 'heartbeat-disable'; on: boolean };
