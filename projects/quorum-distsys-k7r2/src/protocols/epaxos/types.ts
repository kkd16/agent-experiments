// Types for the EPaxos (Egalitarian Paxos) lab.
//
// EPaxos (Moraru, Andersen & Kaminsky, SOSP 2013) is consensus with **no
// leader**. Every replica may propose commands directly into its own slice of a
// shared instance space; the protocol orders only the commands that actually
// *interfere* (don't commute), recording the partial order as a **dependency
// graph** that every replica later linearises identically by finding strongly
// connected components.
//
// The objects below are the protocol's stable storage. Two things are sacred for
// safety:
//   1. A per-instance **ballot**, so a failed command-leader's instance can be
//      recovered by explicit Prepare exactly like single-decree Paxos.
//   2. The committed `(cmd, deps, seq)` triple: once an instance commits, every
//      replica must commit the *same* triple — that is the consensus each
//      instance reaches, and the spine of every safety invariant.
import type { NodeId } from '../../sim/types';

// ---------------------------------------------------------------------------
// Commands and interference
// ---------------------------------------------------------------------------

/** A command for the replicated key/value store. `noop` fills recovered gaps. */
export type Command =
  | { op: 'set'; key: string; value: string; cid: string }
  | { op: 'del'; key: string; cid: string }
  | { op: 'noop' };

/** The key a command touches, or null for a no-op (touches nothing). */
export function keyOf(c: Command): string | null {
  return c.op === 'noop' ? null : c.key;
}

/**
 * Do two commands **interfere** (fail to commute)? EPaxos only orders
 * interfering commands; everything else may execute in any order on any replica
 * and still converge. Here two writes interfere iff they touch the same key.
 */
export function cmdInterferes(a: Command, b: Command): boolean {
  const ka = keyOf(a);
  const kb = keyOf(b);
  if (ka === null || kb === null) return false;
  return ka === kb;
}

export function cmdEq(a: Command | null, b: Command | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.op !== b.op) return false;
  if (a.op === 'noop' || b.op === 'noop') return a.op === b.op;
  if (a.op === 'set' && b.op === 'set') return a.key === b.key && a.value === b.value && a.cid === b.cid;
  if (a.op === 'del' && b.op === 'del') return a.key === b.key && a.cid === b.cid;
  return false;
}

export function cmdStr(c: Command | null): string {
  if (c === null) return '—';
  if (c.op === 'noop') return 'no-op';
  if (c.op === 'set') return `${c.key}=${c.value}`;
  return `del ${c.key}`;
}

// ---------------------------------------------------------------------------
// Instance identity
// ---------------------------------------------------------------------------

/** Every command lives in instance `owner.index` — `owner`'s private sub-log. */
export function instKey(owner: NodeId, index: number): string {
  return `${owner}.${index}`;
}

export function ownerOf(key: string): NodeId {
  return key.slice(0, key.lastIndexOf('.'));
}

export function indexOf(key: string): number {
  return Number(key.slice(key.lastIndexOf('.') + 1));
}

// ---------------------------------------------------------------------------
// Per-instance ballots (for explicit-prepare recovery)
// ---------------------------------------------------------------------------

/**
 * A per-instance ballot. The **default ballot** is `{ b: 0, node: owner }` — the
 * one the instance's owner uses for ordinary PreAccept/Accept. A recovering
 * replica bumps `b` and stamps its own id, giving a total order with no ties,
 * exactly as in single-decree Paxos.
 */
export interface Ballot {
  b: number;
  node: NodeId;
}

export function cmpBallot(x: Ballot, y: Ballot): number {
  if (x.b !== y.b) return x.b - y.b;
  return x.node < y.node ? -1 : x.node > y.node ? 1 : 0;
}

export const ballotEq = (x: Ballot, y: Ballot) => cmpBallot(x, y) === 0;

export const defaultBallot = (owner: NodeId): Ballot => ({ b: 0, node: owner });

export const isDefaultBallot = (bal: Ballot) => bal.b === 0;

export function ballotStr(b: Ballot): string {
  return `${b.b}.${b.node}`;
}

// ---------------------------------------------------------------------------
// Dependency sets
// ---------------------------------------------------------------------------

/** A dependency set is a sorted, de-duplicated array of instance keys. */
export type Deps = string[];

export function normDeps(d: Iterable<string>): Deps {
  return [...new Set(d)].sort();
}

export function depsEq(a: Deps, b: Deps): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function unionDeps(a: Deps, b: Deps): Deps {
  return normDeps([...a, ...b]);
}

// ---------------------------------------------------------------------------
// Instance records (stable storage)
// ---------------------------------------------------------------------------

export type Status = 'preaccepted' | 'accepted' | 'committed' | 'executed';

export const STATUS_RANK: Record<Status, number> = {
  preaccepted: 0,
  accepted: 1,
  committed: 2,
  executed: 3,
};

/** What every replica persists about one instance. */
export interface Instance {
  owner: NodeId;
  index: number;
  cmd: Command | null;
  deps: Deps;
  seq: number;
  status: Status;
  /** Highest ballot this replica has promised for the instance (acceptor n_p). */
  ballot: Ballot;
  /** The ballot at which `cmd/deps/seq` were last (pre)accepted (acceptor n_a). */
  acceptedBallot: Ballot;
}

// ---------------------------------------------------------------------------
// Leader / recovery bookkeeping (volatile)
// ---------------------------------------------------------------------------

/** A reply collected during Phase 1 (PreAccept) for an instance we lead. */
export interface PaReply {
  deps: Deps;
  seq: number;
}

/** State for an instance this node is currently driving as command leader. */
export interface LeaderRec {
  phase: 'preaccept' | 'accept';
  /** True when this is a recovery round: the PreAccept phase re-gathers conflicts
   *  over a *majority* and always proceeds to Accept (never fast-commits). */
  recovery: boolean;
  ballot: Ballot;
  cmd: Command;
  deps: Deps;
  seq: number;
  /** The fast quorum we sent the default-ballot PreAccept to (includes self). */
  fast: NodeId[];
  /** PreAccept replies, keyed by replica. */
  pa: Record<NodeId, PaReply>;
  /** Accept acks, keyed by replica. */
  acc: Record<NodeId, boolean>;
}

/** One PrepareOK reply gathered during recovery. */
export interface PrepareReply {
  from: NodeId;
  /** The acceptor's record for the instance, or null if it had never seen it. */
  cmd: Command | null;
  deps: Deps;
  seq: number;
  status: Status;
  acceptedBallot: Ballot;
}

/** State for an instance this node is recovering via explicit Prepare. */
export interface RecoverRec {
  ballot: Ballot;
  replies: Record<NodeId, PrepareReply>;
  decided: boolean;
}

// ---------------------------------------------------------------------------
// Node state
// ---------------------------------------------------------------------------

export interface EPaxosState {
  self: NodeId;
  /** All known instances (stable storage): instKey → Instance. */
  inst: Record<string, Instance>;
  /** Next free index in our own instance space. */
  nextIndex: number;

  /** Execution: the order in which we have applied instances + the resulting KV. */
  executedOrder: string[];
  executed: Record<string, boolean>;
  kv: Record<string, string>;

  // ---- volatile leader / recovery state (rebuilt after a crash) ----------
  lead: Record<string, LeaderRec>;
  recover: Record<string, RecoverRec>;
  /** Instances with a pending `recover:` timer, so the periodic tick doesn't
   *  perpetually re-arm (and thereby starve) it before it can fire. */
  recoverArmed: Record<string, boolean>;
  /** Client commands queued before we placed them in an instance. */
  pending: Command[];

  /** A short human note for the inspector. */
  note: string;
  /** Counters surfaced in the UI: how many commits took each path. */
  fastCommits: number;
  slowCommits: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EPaxosConfig {
  /** How long the command leader waits for a fast quorum before going slow. */
  fastTimeout: number;
  /** How long a committed-but-blocked instance waits before recovering a dep. */
  recoverTimeout: number;
  /** Background tick that retries execution + flushes pending commands. */
  tick: number;
}

export const DEFAULT_EPAXOS_CONFIG: EPaxosConfig = {
  fastTimeout: 220,
  recoverTimeout: 360,
  tick: 140,
};

/** Tolerable failures F for an N-replica cluster (N = 2F+1). */
export const faultBudget = (n: number): number => Math.floor((n - 1) / 2);

/** Classic / slow-path quorum: a simple majority, F+1. */
export const slowQuorum = (n: number): number => faultBudget(n) + 1;

/**
 * Fast-path quorum size, `F + ⌊(F+1)/2⌋` (Moraru et al.). For N=3 and N=5 this
 * equals the simple majority; the fast quorum only grows past the majority at
 * N≥7, which is exactly when EPaxos's commit latency beats a leader's.
 */
export const fastQuorum = (n: number): number => {
  const f = faultBudget(n);
  return f + Math.floor((f + 1) / 2);
};

// ---------------------------------------------------------------------------
// Message payloads
// ---------------------------------------------------------------------------

export interface PreAcceptMsg {
  key: string;
  owner: NodeId;
  index: number;
  ballot: Ballot;
  cmd: Command;
  deps: Deps;
  seq: number;
}
export interface PreAcceptOkMsg {
  key: string;
  ballot: Ballot;
  ok: boolean;
  /** On reject: the acceptor's higher promised ballot. */
  promised: Ballot;
  deps: Deps;
  seq: number;
  from: NodeId;
}
export interface AcceptMsg {
  key: string;
  owner: NodeId;
  index: number;
  ballot: Ballot;
  cmd: Command;
  deps: Deps;
  seq: number;
}
export interface AcceptOkMsg {
  key: string;
  ballot: Ballot;
  ok: boolean;
  promised: Ballot;
  from: NodeId;
}
export interface CommitMsg {
  key: string;
  owner: NodeId;
  index: number;
  cmd: Command;
  deps: Deps;
  seq: number;
}
export interface PrepareMsg {
  key: string;
  owner: NodeId;
  index: number;
  ballot: Ballot;
  from: NodeId;
}
/** Anti-entropy catch-up: "here is how far I've committed each owner's log;
 *  send me any committed instances I'm missing above those watermarks". */
export interface SyncMsg {
  have: Record<NodeId, number>;
}
export interface PrepareOkMsg {
  key: string;
  ballot: Ballot;
  ok: boolean;
  promised: Ballot;
  /** The acceptor's record, or null if it had no record for this instance. */
  rec: {
    cmd: Command | null;
    deps: Deps;
    seq: number;
    status: Status;
    acceptedBallot: Ballot;
  } | null;
  from: NodeId;
}

// ---------------------------------------------------------------------------
// Client commands (lab → kernel)
// ---------------------------------------------------------------------------

export type EPaxosCmd =
  | { type: 'propose'; target: NodeId; cmd: Command }
  | { type: 'recover'; key: string }; // force this node to recover an instance
