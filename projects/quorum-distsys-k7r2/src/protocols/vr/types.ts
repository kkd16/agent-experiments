import type { NodeId } from '../../sim/types';

// Viewstamped Replication (VR Revisited — Liskov & Cowling, 2012).
//
// VR is the third canonical crash-fault consensus protocol beside Raft and
// Paxos. Its distinctive move: it keeps NO durable state on disk. A primary
// (chosen deterministically as replica `view mod N`) drives normal operation;
// when it is suspected dead the cluster runs a *view change* to rotate to the
// next replica, reconstructing the log from a quorum of the survivors; and a
// replica that crashes and restarts runs an explicit *recovery* protocol to
// rebuild its state from its peers. This file is the wire/state vocabulary.

/** A command applied to the replicated key/value state machine. */
export type VrOp =
  | { op: 'set'; key: string; value: string }
  | { op: 'del'; key: string }
  | { op: 'noop' };

/**
 * A client request as it travels through the protocol. `clientId` + `requestNumber`
 * give VR its at-most-once guarantee via the per-replica client table.
 */
export interface VrRequest {
  clientId: string;
  requestNumber: number;
  op: VrOp;
}

/** One slot in the operation log. */
export interface VrLogEntry {
  /** The view in which this entry was first created by a primary. */
  view: number;
  request: VrRequest;
}

/** The reply the state machine produces for a committed request. */
export interface VrReply {
  requestNumber: number;
  /** The value read/written, or `null` for a delete / miss. */
  result: string | null;
}

export type VrStatus = 'normal' | 'view-change' | 'recovering';

/** The client command surface the lab injects (routed to the primary). */
export type VrCommand =
  | { type: 'request'; clientId: string; requestNumber: number; op: VrOp }
  /** Force this node to suspect the primary and start a view change (UI convenience). */
  | { type: 'timeout' };

export interface VrState {
  // --- configuration (fixed for this lab; reconfiguration is a separate protocol) ---
  configuration: NodeId[];
  replicaNumber: number; // this node's index into `configuration`

  // --- core VR state ---
  view: number; // current view-number
  status: VrStatus;
  opNumber: number; // index of the most recently added log entry (1-based; 0 = empty)
  commitNumber: number; // index of the most recently committed (and executed) op
  log: VrLogEntry[]; // log[i] holds op-number i+1
  kv: Record<string, string>; // the executed replicated state machine
  clientTable: Record<string, VrReply>; // clientId -> most recent reply (at-most-once)

  // --- primary-only volatile: highest op-number each replica has PrepareOk'd ---
  prepareOk: Record<NodeId, number>;

  // --- view-change volatile ---
  /** replicaNumbers heard from via StartViewChange for the current view. */
  startViewChange: number[];
  /** On the new primary: collected DoViewChange messages, keyed by replicaNumber (as a string). */
  doViewChange: Record<string, DoViewChange>;
  /** The last view in which this replica's status was `normal` (for DoViewChange selection). */
  lastNormalView: number;

  // --- recovery volatile ---
  recoveryNonce: number;
  recoveryResponses: Record<string, RecoveryResponse>;

  // --- for the UI ---
  lastReply: VrReply | null; // most recent reply the (primary) produced
  timeoutMs: number; // the most recently chosen primary-timeout (ms)
}

export interface VrConfig {
  /** Primary heartbeat (COMMIT) period, ms. */
  heartbeat: number;
  /** Base primary-inactivity timeout before a backup starts a view change, ms. */
  timeoutMin: number;
  timeoutMax: number;
  /** How long a stuck view change waits before escalating to the next view, ms. */
  viewChangeTimeout: number;
  /** Recovery-request resend period, ms. */
  recoveryTimeout: number;
}

export const DEFAULT_VR_CONFIG: VrConfig = {
  heartbeat: 120,
  timeoutMin: 380,
  timeoutMax: 620,
  viewChangeTimeout: 700,
  recoveryTimeout: 350,
};

// --- message payloads ---

export interface Prepare {
  view: number;
  entry: VrLogEntry;
  opNumber: number;
  commitNumber: number;
  from: number; // primary's replicaNumber
}

export interface PrepareOk {
  view: number;
  opNumber: number;
  from: number; // backup's replicaNumber
}

export interface Commit {
  view: number;
  commitNumber: number;
  from: number;
}

export interface StartViewChange {
  view: number;
  from: number;
}

export interface DoViewChange {
  view: number;
  log: VrLogEntry[];
  lastNormalView: number;
  opNumber: number;
  commitNumber: number;
  from: number;
}

export interface StartView {
  view: number;
  log: VrLogEntry[];
  opNumber: number;
  commitNumber: number;
}

export interface GetState {
  view: number;
  opNumber: number; // the requester's current op-number (wants everything after)
  from: number;
}

export interface NewState {
  view: number;
  afterOpNumber: number; // the log suffix begins at afterOpNumber+1
  suffix: VrLogEntry[];
  opNumber: number;
  commitNumber: number;
}

export interface Recovery {
  from: number;
  nonce: number;
}

export interface RecoveryResponse {
  view: number;
  nonce: number;
  from: number;
  /** Only the primary of `view` fills these in. */
  log: VrLogEntry[] | null;
  opNumber: number | null;
  commitNumber: number | null;
}

// --- helpers shared by the protocol, invariants, lab and self-tests ---

/** N = 2f+1 ⇒ f crash faults tolerated. */
export const faultBudget = (n: number): number => Math.floor((n - 1) / 2);

/** A write/agreement quorum is f+1 replicas (a simple majority). */
export const quorum = (n: number): number => faultBudget(n) + 1;

/** The deterministic primary for a view: replica `view mod N`. */
export const primaryOf = (view: number, config: NodeId[]): NodeId =>
  config[((view % config.length) + config.length) % config.length];

export const isPrimary = (s: VrState): boolean =>
  s.configuration[((s.view % s.configuration.length) + s.configuration.length) % s.configuration.length] ===
  s.configuration[s.replicaNumber];

export function describeOp(op: VrOp): string {
  if (op.op === 'set') return `${op.key}=${op.value}`;
  if (op.op === 'del') return `del ${op.key}`;
  return 'noop';
}
