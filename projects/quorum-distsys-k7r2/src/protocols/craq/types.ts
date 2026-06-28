// Types for the Chain Replication / CRAQ lab — strongly-consistent replication
// with a chain topology instead of a quorum.
//
// Chain Replication (van Renesse & Schneider, OSDI 2004) lines the replicas up in
// a total order HEAD → … → TAIL. Every *update* enters at the head and flows down
// the chain; the tail commits it and an acknowledgement flows back up. Every
// *query* is answered by the tail. Because all updates serialize through the same
// chain and reads come from the one tail, the object is **linearizable** — with no
// quorums and no leader election, only a small fault-tolerant *master* that owns
// the chain membership.
//
// CRAQ (Terrace & Freedman, USENIX ATC 2009) keeps that consistency while letting
// **every** replica answer reads (apportioned queries), so reads scale with the
// chain length. The trick: each node keeps several *versions* of an object, each
// marked **clean** (known-committed) or **dirty** (an update is propagating). A
// read of a clean object is answered locally; a read of a dirty object asks the
// tail for its latest committed version number and returns that — so a read is
// never served stale. This file is the data model for both.
import type { NodeId } from '../../sim/types';

// ---------------------------------------------------------------------------
// Chain configuration — owned by the master, leased to the replicas.
// ---------------------------------------------------------------------------

/**
 * The membership the master has decided on: an epoch (monotonic) and the ordered
 * chain of live replicas. The head is `chain[0]`, the tail `chain[chain.length-1]`.
 * Replicas only ever adopt a configuration with a strictly higher epoch.
 */
export interface ChainConfig {
  epoch: number;
  chain: NodeId[];
  /**
   * The virtual time at which this configuration becomes *committable*. The master
   * sets it one lease-period into the future, so by the time the new chain may
   * commit, every replica's lease under the *previous* config has provably expired
   * (it went passive) — the lease-based reconfiguration that keeps a partition from
   * letting an old chain serve a read that contradicts a new commit.
   */
  activeAt: number;
}

// ---------------------------------------------------------------------------
// Per-object storage: a small version list with a committed watermark.
// ---------------------------------------------------------------------------

/**
 * One stored version of an object. `clean` ⇔ `ver <= committed`. The optional
 * fields carry the originating write's identity down the chain so that whichever
 * node is the *commit point* (the tail) can record the completed write — even a
 * new tail force-committing an in-flight update after a takeover.
 */
export interface Version {
  ver: number;
  value: string;
  opId?: string;
  origin?: NodeId;
  startedAt?: number;
}

/** Per-write metadata threaded alongside a value. */
export interface WriteMeta {
  opId?: string;
  origin?: NodeId;
  startedAt?: number;
}

/**
 * Versions are numbered per key on a per-config *stride*, so two heads in two
 * different configurations can never assign the same version number — even after
 * a split head change, committed versions stay globally unique (no fork).
 */
export const VERSION_STRIDE = 1_000_000;
export const epochBase = (epoch: number) => epoch * VERSION_STRIDE;

/**
 * A replica's storage for one key. `versions` is kept sorted ascending and
 * de-duplicated by `ver`; everything at or below `committed` is *clean*
 * (known to have committed at the tail) and everything above it is *dirty*
 * (an update still propagating). The latest version is `versions[last]`.
 */
export interface KeyStore {
  versions: Version[];
  /** Highest version known clean. 0 ⇒ the object has no committed value yet. */
  committed: number;
}

export function emptyKeyStore(): KeyStore {
  return { versions: [], committed: 0 };
}

/** Highest version this store holds (0 if empty). */
export function maxVer(ks: KeyStore): number {
  return ks.versions.length ? ks.versions[ks.versions.length - 1].ver : 0;
}

/** True iff the latest version is above the committed watermark. */
export function isDirty(ks: KeyStore): boolean {
  return maxVer(ks) > ks.committed;
}

/** The value stored at a specific version, or '' if absent. */
export function valueAt(ks: KeyStore, ver: number): string {
  if (ver === 0) return '';
  const v = ks.versions.find((x) => x.ver === ver);
  return v ? v.value : '';
}

/** The latest (highest-version) value, or '' if empty. */
export function latestValue(ks: KeyStore): string {
  return ks.versions.length ? ks.versions[ks.versions.length - 1].value : '';
}

/** The committed (clean) value the tail would report. */
export function committedValue(ks: KeyStore): string {
  return valueAt(ks, ks.committed);
}

/**
 * Insert/overwrite a version (upstream is always authoritative, so a differing
 * value for an existing version replaces it — this resolves orphaned versions a
 * crashed head never finished propagating). Keeps the list sorted + de-duped.
 */
export function putVersion(ks: KeyStore, ver: number, value: string, meta?: WriteMeta): void {
  const i = ks.versions.findIndex((v) => v.ver === ver);
  if (i >= 0) {
    // Upstream wins on value, but never wipe known provenance with a message that
    // happens to omit it (e.g. an older code path) — merge, keeping what we have.
    const prev = ks.versions[i];
    ks.versions[i] = {
      ver,
      value,
      opId: meta?.opId ?? prev.opId,
      origin: meta?.origin ?? prev.origin,
      startedAt: meta?.startedAt ?? prev.startedAt,
    };
  } else {
    ks.versions.push({ ver, value, ...meta });
    ks.versions.sort((a, b) => a.ver - b.ver);
  }
}

/** The stored version record at a specific version, if present. */
export function versionAt(ks: KeyStore, ver: number): Version | undefined {
  return ks.versions.find((v) => v.ver === ver);
}

/** The highest version present that is ≤ `want` (or 0 if none) — a committed
 *  watermark must never point past a version we actually hold. */
export function highestHeldUpTo(ks: KeyStore, want: number): number {
  let hi = 0;
  for (const v of ks.versions) if (v.ver <= want && v.ver > hi) hi = v.ver;
  return hi;
}

/** Drop clean versions strictly below the watermark (keep the committed one). */
export function pruneBelowCommitted(ks: KeyStore): void {
  if (ks.committed <= 0) return;
  ks.versions = ks.versions.filter((v) => v.ver >= ks.committed);
}

// ---------------------------------------------------------------------------
// Coordinator-side bookkeeping (volatile).
// ---------------------------------------------------------------------------

/** A write the head is shepherding down the chain until the tail acks it. */
export interface PendingWrite {
  opId: string;
  key: string;
  value: string;
  ver: number;
  startedAt: number;
  /** The node a client contacted (recorded as the op's process lane). */
  origin: NodeId;
  retries: number;
}

/** A read parked while its coordinator waits for the tail's version reply. */
export interface PendingRead {
  opId: string;
  key: string;
  startedAt: number;
  retries: number;
}

/** A finished operation — the record the linearizability checker reasons over. */
export type OpKind = 'read' | 'write';

export interface CompletedOp {
  id: string;
  kind: OpKind;
  key: string;
  /** The value written, or the value a read returned. */
  value: string;
  /** The committed version number (a write's, or the version a read returned). */
  ver: number;
  startedAt: number;
  finishedAt: number;
  /** The node the client contacted. */
  coord: NodeId;
  /** For a read: did it answer locally (clean) or have to ask the tail (dirty)? */
  readPath?: 'clean' | 'dirty';
}

// ---------------------------------------------------------------------------
// Node state — one type for both the master and the replicas.
// ---------------------------------------------------------------------------

export type Role = 'master' | 'replica';

export interface CraqState {
  self: NodeId;
  role: Role;

  /** The configuration this node currently believes in. */
  config: ChainConfig;

  // ---- replica fields ----
  /** Stable storage: key → version list + committed watermark. */
  store: Record<string, KeyStore>;
  /** Head-side per-key version counter (next version to assign). */
  nextVer: Record<string, number>;
  /** Writes this node is coordinating as head (volatile). */
  pendingWrites: Record<string, PendingWrite>;
  /** Reads this node is coordinating, waiting on the tail (volatile). */
  pendingReads: Record<string, PendingRead>;
  /** Completed operations this node coordinated (the linearizability history). */
  history: CompletedOp[];
  /** Until when this replica's config lease is valid; past it, it goes passive. */
  leaseUntil: number;
  /**
   * True once this replica's state is current for its position in the live config.
   * A node that just joined, or whose predecessor changed, is *not ready* until a
   * state-transfer (Sync) arrives from its current predecessor — and a not-ready
   * node refuses to serve, so it can never answer a read with stale data.
   */
  ready: boolean;
  /** A new head collecting committed frontiers: chain members it has heard back from. */
  frontierAcks: Record<NodeId, true>;
  /** Until when this replica has confirmed chain currency (a recent Beat from upstream
   *  carrying a frontier it is caught up with). Past it, a non-head node stops serving:
   *  it may have been silently cut off from its predecessor and gone stale. */
  chainLeaseUntil: number;
  opCounter: number;
  reads: number;
  writes: number;
  cleanReads: number;
  dirtyReads: number;
  note: string;

  // ---- master fields ----
  /** Every replica id the master oversees (the static universe of replicas). */
  members: NodeId[];
  /** Last time the master heard a Pong from each member. */
  lastSeen: Record<string, number>;
  /** The master's working chain order (alive members, joiners appended at tail). */
  order: NodeId[];
}

export interface CraqConfig {
  /** Master heartbeat (Ping) interval. */
  hbInterval: number;
  /** A replica that hasn't heard from the master in this long goes passive. */
  leaseTimeout: number;
  /** The master removes a member it hasn't heard from for this long (> lease). */
  suspectTimeout: number;
  /** The head beats its committed frontier down the chain this often. */
  beatInterval: number;
  /** A non-head replica that hasn't seen a fresh in-frontier Beat for this long stops
   *  serving (it may be cut off from its predecessor). Must exceed `beatInterval`. */
  chainLeaseTimeout: number;
  /** Re-drive a stalled update/read after this long (covers drops). */
  retry: number;
  /** Give up on a pending write/read after this many retries (covers supersession). */
  maxRetries: number;
  /** Grace lease replicas hold at startup, before the first Ping. */
  initialGrace: number;
  /** Cap on retained completed-op history per node. */
  historyCap: number;
}

export const DEFAULT_CRAQ_CONFIG: CraqConfig = {
  hbInterval: 120,
  leaseTimeout: 420,
  suspectTimeout: 760,
  beatInterval: 100,
  chainLeaseTimeout: 360,
  retry: 200,
  maxRetries: 6,
  initialGrace: 720,
  historyCap: 80,
};

// ---------------------------------------------------------------------------
// Chain-position helpers (pure; derived from a config + node id).
// ---------------------------------------------------------------------------

/** The chain-position helpers only read the ordering, so they accept any object
 *  carrying a `chain` (a full config, or a lightweight `{ chain }` view). */
type ChainLike = { chain: NodeId[] };

export const isMaster = (s: CraqState) => s.role === 'master';
export const headOf = (c: ChainLike): NodeId | undefined => c.chain[0];
export const tailOf = (c: ChainLike): NodeId | undefined => c.chain[c.chain.length - 1];
export const inChain = (c: ChainLike, id: NodeId) => c.chain.includes(id);

export function succOf(c: ChainLike, id: NodeId): NodeId | undefined {
  const i = c.chain.indexOf(id);
  return i >= 0 && i < c.chain.length - 1 ? c.chain[i + 1] : undefined;
}
export function predOf(c: ChainLike, id: NodeId): NodeId | undefined {
  const i = c.chain.indexOf(id);
  return i > 0 ? c.chain[i - 1] : undefined;
}
export function chainPos(c: ChainLike, id: NodeId): number {
  return c.chain.indexOf(id);
}

// ---------------------------------------------------------------------------
// Message payloads.
// ---------------------------------------------------------------------------

/** master → replica: heartbeat carrying the current config (piggybacked). */
export interface PingMsg {
  epoch: number;
  chain: NodeId[];
  activeAt: number;
}
/** replica → master: liveness reply. */
export interface PongMsg {
  from: NodeId;
}
/** master → replica: an explicit configuration change (also carried on Pings). */
export interface ConfigMsg {
  epoch: number;
  chain: NodeId[];
  activeAt: number;
}
/** any → head: a client write, forwarded to the head to coordinate. */
export interface ClientWriteMsg {
  opId: string;
  key: string;
  value: string;
  origin: NodeId;
}
/** node → successor: an update flowing down the chain. */
export interface UpdateMsg {
  opId: string;
  key: string;
  value: string;
  ver: number;
  origin: NodeId;
  startedAt: number;
  epoch: number;
}
/** node → predecessor: a commit acknowledgement flowing back up. */
export interface AckMsg {
  opId: string;
  key: string;
  ver: number;
}
/** node → tail: "what is your latest committed version of this key?" (CRAQ). */
export interface VersionQueryMsg {
  opId: string;
  key: string;
  origin: NodeId;
}
/** tail → node: the committed (version, value) for a dirty read. */
export interface VersionReplyMsg {
  opId: string;
  key: string;
  ver: number;
  value: string;
}
/** predecessor → successor: state transfer after a reconfiguration. */
export interface SyncMsg {
  epoch: number;
  store: Record<string, KeyStore>;
}
/** successor → predecessor: "I joined the chain behind you — send me your state." */
export interface SyncReqMsg {
  epoch: number;
  from: NodeId;
}
/** new head → every chain member: "what is your committed frontier?" Committed data
 *  normally only flows down, so a freshly-installed head pulls it up to make sure it
 *  holds every committed version before it serves (no head-currency inversion). */
export interface FrontierReqMsg {
  epoch: number;
  from: NodeId;
}
/** chain member → head: my committed (version, value) for every key. */
export interface FrontierReplyMsg {
  epoch: number;
  from: NodeId;
  frontier: Record<string, { ver: number; value: string }>;
}
/** head → down the chain: a currency heartbeat carrying the head's committed
 *  frontier. A node behind it knows it is stale; a node that stops seeing them
 *  knows it may have been cut off — either way it stops serving. */
export interface BeatMsg {
  epoch: number;
  frontier: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Client commands.
// ---------------------------------------------------------------------------

export type CraqCmd =
  | { type: 'write'; key: string; value: string }
  | { type: 'read'; key: string };
