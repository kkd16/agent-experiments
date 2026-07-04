import type { NodeId } from '../../sim/types';

// Zab — the ZooKeeper Atomic Broadcast protocol (Junqueira, Reed & Serafini,
// "Zab: High-performance broadcast for primary-backup systems", DSN 2011), the
// consensus engine that keeps a ZooKeeper / (older) Kafka ensemble consistent.
//
// Zab is the fourth canonical crash-fault consensus protocol beside Raft, Paxos
// and Viewstamped Replication — and the one designed for the *primary-backup*
// pattern: a single elected leader turns each client write into an ordered
// transaction (a `zxid`), broadcasts it, and delivers it once a quorum has
// logged it. Its distinctive contract is **primary order** — the guarantee that
// state changes are delivered in the exact order the primary issued them, and
// that a new primary's changes follow every change from previous primaries that
// could have been delivered. Unlike VR it keeps a **durable log** on disk (here:
// state that survives a crash), so recovery is by log reconciliation, not replay
// from peers.
//
// The protocol runs in four phases on the shared kernel:
//   0. Fast Leader Election (FLE) — pick the peer with the most up-to-date log.
//   1. Discovery      — the prospective leader learns a new epoch and the newest
//                       history in a quorum (FOLLOWERINFO → NEWEPOCH → ACKEPOCH).
//   2. Synchronization — it forces that history onto a quorum (NEWLEADER →
//                       ACK-LD → UPTODATE), so every follower starts identical.
//   3. Broadcast      — normal operation (PROPOSE → ACK → COMMIT), the two-phase
//                       atomic broadcast that gives ZooKeeper its throughput.
//
// This file is the wire/state vocabulary shared by the protocol, its invariants,
// the lab UI and the self-tests.

/** A command applied to the replicated key/value state machine. */
export type ZabOp =
  | { op: 'set'; key: string; value: string }
  | { op: 'del'; key: string }
  | { op: 'noop' };

/**
 * A client request as it travels through the protocol. `clientId` +
 * `requestNumber` give Zab its at-most-once execution guarantee via the
 * per-server client table.
 */
export interface ZabRequest {
  clientId: string;
  requestNumber: number;
  op: ZabOp;
}

/**
 * A ZooKeeper transaction id: a 64-bit stamp split into a high `epoch` (which
 * primary issued it) and a low `counter` (its order within that epoch). The
 * lexicographic order (epoch, counter) is the *total order* Zab delivers in — a
 * new epoch strictly dominates every zxid of an older one, which is exactly how
 * primary order across leadership changes is enforced.
 */
export interface Zxid {
  epoch: number;
  counter: number;
}

export const ZERO_ZXID: Zxid = { epoch: 0, counter: 0 };

/** Lexicographic (epoch, counter) comparison: <0, 0, >0. */
export function cmpZxid(a: Zxid, b: Zxid): number {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  return a.counter - b.counter;
}

export const zxidEq = (a: Zxid, b: Zxid): boolean => a.epoch === b.epoch && a.counter === b.counter;

export const fmtZxid = (z: Zxid): string => `${z.epoch}:${z.counter}`;

/** One transaction in the replicated history (the log). */
export interface ZabTxn {
  zxid: Zxid;
  request: ZabRequest;
}

/** The reply the state machine produces for a delivered request. */
export interface ZabReply {
  requestNumber: number;
  /** The value read/written, or `null` for a delete / miss. */
  result: string | null;
}

/** Where a server is in the protocol. */
export type ZabPhase = 'election' | 'discovery' | 'synchronization' | 'broadcast';
/** How a server currently sees itself. `looking` = running an election. */
export type ZabRole = 'looking' | 'following' | 'leading';

/** A Fast-Leader-Election ballot: "I vote for `leader`, whose log is (epoch, zxid)". */
export interface Vote {
  leader: number; // serverId being voted for
  epoch: number; // that server's currentEpoch (peerEpoch)
  zxid: Zxid; // that server's last zxid
}

/** The client command surface the lab injects. */
export type ZabCommand =
  | { type: 'request'; clientId: string; requestNumber: number; op: ZabOp }
  /** Force this node to suspect the leader and start a fresh election (UI convenience). */
  | { type: 'elect' };

export interface ZabState {
  // --- configuration (fixed for this lab) ---
  configuration: NodeId[];
  serverId: number; // this node's index into `configuration`

  // --- durable state (survives a crash; ZooKeeper persists these on disk) ---
  acceptedEpoch: number; // last NEWEPOCH accepted (the paper's `f`)
  currentEpoch: number; // last NEWLEADER acknowledged (the paper's `f` after sync)
  history: ZabTxn[]; // the transaction log, ordered by zxid
  lastCommitted: number; // count of delivered (committed) transactions — a prefix of `history`
  kv: Record<string, string>; // the delivered state machine (replay of the committed prefix)
  clientTable: Record<string, ZabReply>; // clientId -> most recent reply (at-most-once)

  // --- volatile role / phase ---
  role: ZabRole;
  phase: ZabPhase;
  leader: number | null; // serverId this node currently follows (or leads, if === serverId)

  // --- election (FLE) volatile ---
  logicalClock: number; // election round
  vote: Vote; // this node's current ballot
  votes: Record<string, Vote>; // LOOKING ballots heard this round, keyed by voter serverId
  /**
   * Notifications from peers already FOLLOWING/LEADING, keyed by sender. A looking
   * node joins an established leader L only when a quorum of these back L *and* L
   * has confirmed itself (a LEADING self-vote) — which stops a crashed but
   * highest-ranked ex-leader from livelocking the election.
   */
  outOfElection: Record<string, { vote: Vote; state: ZabRole; from: number }>;
  /**
   * True while a "finalize" timer is pending: on first reaching a vote quorum we
   * wait a short window for the ballots to stabilise before concluding, so a
   * transient quorum can't split two nodes into rival leaders (ZK's finalizeWait).
   */
  finalizePending: boolean;

  // --- leader-only volatile (discovery / synchronization / broadcast) ---
  newEpoch: number; // the epoch this prospective leader is establishing
  followerInfo: Record<string, number>; // CEPOCH: serverId -> its acceptedEpoch
  ackEpoch: Record<string, AckEpoch>; // ACKEPOCH replies for history selection
  ackLeader: string[]; // serverIds that ACKed NEWLEADER
  proposalAcks: Record<string, string[]>; // zxid-key -> serverIds that ACKed the proposal
  followerAlive: Record<string, number>; // serverId -> virtual time we last heard from it
  counter: number; // low bits of the next zxid this leader will assign

  // --- follower-only volatile ---
  syncing: boolean; // mid-synchronization (adopted a NEWLEADER history, awaiting UPTODATE)
  /**
   * Proposals received out of zxid order (the kernel reorders messages; the real
   * protocol assumes FIFO channels). Buffered here until the gap before them
   * fills, then drained into `history` in order. Keyed by zxid.
   */
  pendingProposals: Record<string, ZabTxn>;
  /** Highest zxid the leader has told this follower is committed (via COMMIT / PING). */
  leaderCommitZxid: Zxid;

  // --- for the UI ---
  lastReply: ZabReply | null;
  timeoutMs: number;
}

export interface ZabConfig {
  /** Leader→follower heartbeat (PING) period, ms. */
  heartbeat: number;
  /** Base follower inactivity timeout before it starts an election, ms. */
  timeoutMin: number;
  timeoutMax: number;
  /** How long a leader waits without a quorum of live followers before stepping down, ms. */
  leaderTimeout: number;
  /** Election-ballot resend / discovery-and-sync retry period, ms. */
  electionTimeout: number;
}

export const DEFAULT_ZAB_CONFIG: ZabConfig = {
  heartbeat: 120,
  timeoutMin: 420,
  timeoutMax: 680,
  leaderTimeout: 520,
  electionTimeout: 160,
};

// --- message payloads ---

/** FLE notification: "here is my current ballot in round `round`." */
export interface VoteMsg {
  round: number;
  vote: Vote;
  from: number;
  /** Sender's role, so a looking node can defer to an already-established leader. */
  state: ZabRole;
}

/** Phase 1 — FOLLOWERINFO / CEPOCH: a follower tells the prospective leader its accepted epoch. */
export interface FollowerInfo {
  acceptedEpoch: number;
  from: number;
}

/** Phase 1 — NEWEPOCH: the leader proposes the new epoch number. */
export interface NewEpoch {
  epoch: number;
  from: number;
}

/** Phase 1 — ACKEPOCH: the follower accepts the epoch and reveals its full history for selection. */
export interface AckEpoch {
  epoch: number; // the newEpoch being acknowledged
  currentEpoch: number; // follower's currentEpoch (for the "most up to date" pick)
  lastZxid: Zxid;
  history: ZabTxn[];
  from: number;
}

/** Phase 2 — NEWLEADER: the leader forces the selected history onto a follower under `epoch`. */
export interface NewLeader {
  epoch: number;
  history: ZabTxn[];
  /**
   * How much of `history` the follower may deliver once synced: the whole log for
   * the initial epoch sync (the recovered history becomes committed), but only the
   * leader's committed prefix when syncing a learner mid-broadcast — its
   * uncommitted tail must wait for a normal COMMIT, never auto-deliver.
   */
  commitZxid: Zxid;
  from: number;
}

/** Phase 2 — ACK-LD: the follower has durably adopted the leader's history. */
export interface AckNewLeader {
  epoch: number;
  from: number;
}

/** Phase 2 — UPTODATE / COMMIT-LD: the follower may now deliver its synced history and serve. */
export interface UpToDate {
  epoch: number;
  from: number;
}

/** Phase 3 — PROPOSE: the leader broadcasts one transaction. */
export interface Propose {
  epoch: number;
  txn: ZabTxn;
  from: number;
}

/** Phase 3 — ACK: a follower has logged the proposal. */
export interface Ack {
  epoch: number;
  zxid: Zxid;
  from: number;
}

/** Phase 3 — COMMIT: the leader tells followers a zxid has reached a quorum. */
export interface CommitMsg {
  epoch: number;
  zxid: Zxid;
  from: number;
}

/** Leader→follower liveness heartbeat, carrying the current commit point. */
export interface Ping {
  epoch: number;
  lastCommittedZxid: Zxid;
  from: number;
}

/** Follower→leader heartbeat reply, so the leader can track a live quorum. */
export interface PingAck {
  epoch: number;
  from: number;
}

// --- helpers shared by the protocol, invariants, lab and self-tests ---

/** N = 2f+1 ⇒ f crash faults tolerated. */
export const faultBudget = (n: number): number => Math.floor((n - 1) / 2);

/** A quorum is f+1 servers (a simple majority). */
export const quorum = (n: number): number => faultBudget(n) + 1;

/** The last zxid in a history, or the zero zxid for an empty log. */
export const lastZxidOf = (history: ZabTxn[]): Zxid =>
  history.length ? history[history.length - 1].zxid : ZERO_ZXID;

/**
 * Fast Leader Election's total-order predicate: is ballot `a` "better" than the
 * current best `b`? Prefer the higher peer-epoch, then the higher last-zxid, then
 * the higher serverId — so the survivor with the most up-to-date log (ties broken
 * deterministically) always wins.
 */
export function betterVote(a: Vote, b: Vote): boolean {
  if (a.epoch !== b.epoch) return a.epoch > b.epoch;
  const c = cmpZxid(a.zxid, b.zxid);
  if (c !== 0) return c > 0;
  return a.leader > b.leader;
}

export function describeOp(op: ZabOp): string {
  if (op.op === 'set') return `${op.key}=${op.value}`;
  if (op.op === 'del') return `del ${op.key}`;
  return 'noop';
}

/** A stable string key for a zxid (used to tally proposal acks). */
export const zxidKey = (z: Zxid): string => `${z.epoch}.${z.counter}`;
