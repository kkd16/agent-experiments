// Types for the PBFT (Practical Byzantine Fault Tolerance) lab.
//
// Every other consensus protocol in Quorum assumes the *crash-fault* model: a
// node is either honest-and-up or dead. PBFT (Castro & Liskov, OSDI '99) drops
// that assumption. A faulty replica can do **anything** — stay silent, send
// different messages to different peers (equivocate), lie about what it has
// seen, or vote for values that were never proposed. The remarkable result is
// that a cluster of **N = 3f + 1** replicas still reaches agreement and executes
// requests in one total order as long as **at most f** of them are Byzantine.
//
// The safety mechanism is *quorum intersection*. Two quorums of 2f+1 replicas
// out of 3f+1 must overlap in at least f+1 nodes, and that overlap contains at
// least one honest node — which will never vouch for two conflicting things. So
// no two conflicting requests can both gather a quorum. The three message
// phases (PRE-PREPARE → PREPARE → COMMIT) turn that one idea into a working
// state-machine-replication protocol.
//
// Messages here are authenticated: the kernel stamps every message's `from`, so
// a faulty node can lie about the *content* of its own messages but cannot forge
// a message that appears to come from another node — exactly PBFT's assumption.
import type { NodeId } from '../../sim/types';

/** The number of Byzantine faults an N-node cluster tolerates: f = ⌊(N-1)/3⌋. */
export const faultBudget = (n: number): number => Math.floor((n - 1) / 3);

/** Quorum size in PBFT: a "certificate" needs 2f + 1 distinct replicas. */
export const quorum = (n: number): number => 2 * faultBudget(n) + 1;

/** How a faulty replica misbehaves. `honest` nodes follow the protocol exactly. */
export type FaultMode =
  | 'honest'
  /** Sends nothing it is responsible for — a silent/crashed-looking node. A silent
   *  primary forces a view change; a silent backup withholds its prepares/commits. */
  | 'silent'
  /** PRIMARY ATTACK: assigns the *same* sequence number to two *different* requests,
   *  sending one digest to half the backups and a conflicting one to the rest. This
   *  is the canonical Byzantine attack on ordering — PBFT must still never let two
   *  honest replicas execute different requests at that sequence number. */
  | 'equivocate'
  /** BACKUP ATTACK: votes (PREPARE / COMMIT) for a corrupted digest that matches no
   *  real pre-prepare — trying to manufacture a bogus quorum. Honest replicas ignore
   *  any vote whose digest doesn't match, so this is harmless while faulty ≤ f. */
  | 'conflict';

/** A single command applied to the replicated key/value state machine. */
export type KvOp =
  | { op: 'set'; key: string; value: string }
  | { op: 'del'; key: string }
  | { op: 'noop' };

/** A client request: an operation plus a unique client id (for de-duplication). */
export interface ClientRequest {
  cid: string;
  op: KvOp;
}

/** The internally-generated filler used to plug a gap during a view change. */
export const NOOP_REQUEST: ClientRequest = { cid: '∅', op: { op: 'noop' } };
export const NOOP_DIGEST = 'noop';

/**
 * The cryptographic digest of a request, modelled as a stable string. Honest
 * replicas bind every PREPARE / COMMIT to this digest, so a vote for a different
 * request simply doesn't count toward a certificate.
 */
export function digestOf(req: ClientRequest): string {
  if (req.op.op === 'noop') return NOOP_DIGEST;
  if (req.op.op === 'set') return `set|${req.op.key}|${req.op.value}|${req.cid}`;
  return `del|${req.op.key}|${req.cid}`;
}

export function opStr(req: ClientRequest | null): string {
  if (!req) return '—';
  const o = req.op;
  if (o.op === 'noop') return 'no-op';
  if (o.op === 'set') return `${o.key}=${o.value}`;
  return `del ${o.key}`;
}

/** A prepared certificate carried inside a VIEW-CHANGE message (see §4.4 of the paper). */
export interface PreparedProof {
  seq: number;
  view: number;
  digest: string;
  request: ClientRequest;
}

// ---- per-sequence-number agreement record --------------------------------

/**
 * One slot in the replicated log: the agreement state for a single sequence
 * number in the *current* view. Prepares/commits are stored as `from → digest`
 * so out-of-order arrivals (a PREPARE before its PRE-PREPARE) and Byzantine
 * digest mismatches are both handled by simply counting matches against
 * `slot.digest`.
 */
export interface Slot {
  /** The view this slot's pre-prepare belongs to. */
  view: number;
  /** The digest this replica accepted for this sequence number. */
  digest: string;
  /** The request body, once known (from a PRE-PREPARE or NEW-VIEW). */
  request: ClientRequest | null;
  /** node → the digest it claimed to PREPARE (only matching ones count). */
  prepares: Record<NodeId, string>;
  /** node → the digest it claimed to COMMIT (only matching ones count). */
  commits: Record<NodeId, string>;
  /** A valid PRE-PREPARE for (view, seq, digest) has been accepted. */
  preprepared: boolean;
  /** prepared-local: pre-prepared + 2f matching PREPAREs from distinct replicas. */
  prepared: boolean;
  /** committed-local: prepared + 2f+1 matching COMMITs from distinct replicas. */
  committed: boolean;
  /** Whether this replica has already broadcast its own PREPARE / COMMIT. */
  sentPrepare: boolean;
  sentCommit: boolean;
}

export interface PbftState {
  // ---- identity / fault model -------------------------------------------
  /** This replica's misbehaviour mode (honest unless the user flips it). */
  fault: FaultMode;

  // ---- view / leadership ------------------------------------------------
  /** The current view number; the primary is `all[view % N]`. */
  view: number;
  /** True while this replica has given up on the current primary and is
   *  collecting a NEW-VIEW for a higher view. Normal-phase messages are paused. */
  inViewChange: boolean;
  /** The view this replica is currently trying to move to. */
  targetView: number;

  // ---- replicated log ---------------------------------------------------
  /** seq → agreement slot for the current view. */
  log: Record<number, Slot>;
  /** The next sequence number the primary will assign. */
  nextSeq: number;
  /** seq → the digest this replica has *executed* (durable, cross-view history). */
  executed: Record<number, string>;
  /** Highest sequence number executed such that every seq ≤ it is executed too. */
  lastExec: number;
  /** The replicated state machine. */
  kv: Record<string, string>;
  /** A flat, human-readable execution log for the UI. */
  execLog: { seq: number; digest: string; summary: string }[];

  // ---- request bookkeeping ----------------------------------------------
  /** digest → request body, for every request this replica has heard of. */
  requests: Record<string, ClientRequest>;
  /** Client requests this replica has accepted but not yet seen executed. */
  pending: ClientRequest[];
  /** Whether a request (view-change) timer is currently armed. Kept in step with
   *  `pending` so the timer is started once per outstanding request and never
   *  reset by unrelated message traffic (which would mask a dead primary). */
  vcArmed: boolean;
  /** cid → true once executed (so a request is applied at most once). */
  executedCid: Record<string, true>;

  // ---- state catch-up (lets a lagging / restarted replica converge) -----
  /** seq → digest → set of replicas that reported executing it. A digest backed
   *  by f+1 distinct reports is safe to adopt (≥1 reporter is honest). */
  catchup: Record<number, Record<string, Record<NodeId, true>>>;

  // ---- view-change collection (new-primary side) ------------------------
  /** targetView → (from → its VIEW-CHANGE message). */
  viewChanges: Record<number, Record<NodeId, ViewChange>>;
  /** Highest view for which this replica has already issued a NEW-VIEW (as primary). */
  newViewSent: number;

  // ---- UI annotation ----------------------------------------------------
  note: string;
}

export interface PbftConfig {
  /** Base view-change timeout (ms); backs off as the view climbs. */
  requestTimeout: number;
  /** How long to wait for a NEW-VIEW before escalating to the next view. */
  newViewTimeout: number;
}

export const DEFAULT_PBFT_CONFIG: PbftConfig = {
  requestTimeout: 800,
  newViewTimeout: 1100,
};

// ---- message payloads -----------------------------------------------------

/** Client → all replicas (the client multicasts so backups can detect a dead primary). */
export interface RequestMsg {
  request: ClientRequest;
}

/** Primary → backups: "in view v, sequence number n is assigned to request d". */
export interface PrePrepare {
  view: number;
  seq: number;
  digest: string;
  request: ClientRequest;
}

/** Backup → all: "I accept (v, n, d)". */
export interface PrepareMsg {
  view: number;
  seq: number;
  digest: string;
  from: NodeId;
}

/** All → all: "(v, n, d) is prepared at me". */
export interface CommitMsg {
  view: number;
  seq: number;
  digest: string;
  from: NodeId;
}

/** A replica that gives up on the primary broadcasts this with its prepared certs. */
export interface ViewChange {
  newView: number;
  from: NodeId;
  /** Prepared certificates this replica holds, so the next primary preserves them. */
  prepared: PreparedProof[];
  /** Highest sequence number this replica has executed (its "checkpoint"). */
  lastExec: number;
}

/** The new primary's authoritative re-proposal of the log for the new view. */
export interface NewView {
  view: number;
  /** The set of VIEW-CHANGE messages that justify this NEW-VIEW. */
  viewChanges: ViewChange[];
  /** The re-proposed pre-prepares: per slot, the carried-over or no-op request. */
  preprepares: { seq: number; digest: string; request: ClientRequest }[];
}

/** Periodic gossip of how far a replica has executed (drives catch-up). */
export interface StatusMsg {
  from: NodeId;
  lastExec: number;
}

/** A reply that ships executed decisions a lagging peer is missing. */
export interface CatchupMsg {
  from: NodeId;
  entries: { seq: number; digest: string; request: ClientRequest }[];
}

export type PbftCmd =
  | { type: 'request'; request: ClientRequest }
  | { type: 'set-fault'; mode: FaultMode };
