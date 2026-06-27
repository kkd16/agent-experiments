// Types and the reconciliation core for the Dynamo lab.
//
// Dynamo (DeCandia et al., SOSP 2007) is the canonical *AP* store: it chooses
// availability over consistency, so it is the deliberate counterpoint to every
// consensus lab here. There is no leader and no single agreed order — instead a
// write is replicated to N nodes, a coordinator waits for only W acks, a read
// waits for only R, and divergent updates are reconciled with **vector clocks**.
// Everything interesting about Dynamo lives in those vector clocks, so they are
// the heart of this file.
import type { NodeId } from '../../sim/types';

// ---- vector clocks --------------------------------------------------------

/** A version vector: node id → the count of writes that node has coordinated for
 *  one object. It is the *causal fingerprint* of a value. */
export type VClock = Record<NodeId, number>;

export function cloneClock(c: VClock): VClock {
  return { ...c };
}

/** Componentwise max — the join of two clocks (their least common descendant). */
export function mergeClocks(a: VClock, b: VClock): VClock {
  const out: VClock = { ...a };
  for (const k in b) out[k] = Math.max(out[k] ?? 0, b[k]);
  return out;
}

/** `a` descends `b` (a ≥ b componentwise): a knows everything b knows. Equal clocks descend each other. */
export function descends(a: VClock, b: VClock): boolean {
  for (const k in b) {
    if ((a[k] ?? 0) < b[k]) return false;
  }
  return true;
}

export function clockEq(a: VClock, b: VClock): boolean {
  return descends(a, b) && descends(b, a);
}

/** Strictly dominates: descends and is not equal (a is causally newer than b). */
export function dominates(a: VClock, b: VClock): boolean {
  return descends(a, b) && !descends(b, a);
}

/** Neither clock descends the other — the two writes are causally concurrent.
 *  Concurrent versions are *siblings*: Dynamo keeps both and lets the app resolve them. */
export function concurrent(a: VClock, b: VClock): boolean {
  return !descends(a, b) && !descends(b, a);
}

export function clockStr(c: VClock): string {
  const ks = Object.keys(c).sort();
  if (ks.length === 0) return '∅';
  return ks.map((k) => `${k}:${c[k]}`).join(' ');
}

// ---- versioned values -----------------------------------------------------

/** One value of an object, tagged with the vector clock that produced it. */
export interface Version {
  value: string;
  clock: VClock;
  /** Wall-clock-ish stamp (virtual ms) of when this version was written — for the UI + LWW fallback. */
  wrote: number;
  /** The coordinator that produced this version (for colouring + provenance). */
  by: NodeId;
}

/** An object's value as Dynamo sees it: a *set of sibling versions* (an antichain
 *  under causal order). Almost always one version; more than one means an
 *  unresolved conflict the client must reconcile. */
export type VersionSet = Version[];

function versionKey(v: Version): string {
  return `${clockStr(v.clock)}=${v.value}`;
}

/**
 * Reconcile a bag of versions into Dynamo's canonical form: drop every version
 * strictly dominated by another, keeping only the causally-maximal ones. What
 * remains is a set of pairwise-concurrent **siblings**. This is THE operation the
 * whole store rests on — its correctness is exactly the Causality invariant.
 */
export function reconcile(versions: VersionSet): VersionSet {
  // De-duplicate identical (clock,value) pairs first so equal clocks with the
  // same value never appear twice (idempotent merge).
  const uniq = new Map<string, Version>();
  for (const v of versions) {
    const key = versionKey(v);
    const prev = uniq.get(key);
    if (!prev || v.wrote < prev.wrote) uniq.set(key, v); // deterministic tiebreak
  }
  const list = [...uniq.values()];
  const keep: Version[] = [];
  for (const v of list) {
    // Keep v unless some *other* version strictly dominates it.
    const dominatedByOther = list.some((w) => w !== v && dominates(w.clock, v.clock));
    if (!dominatedByOther) keep.push(v);
  }
  // Two distinct values with byte-identical clocks are a genuine (if rare)
  // collision; keep them as siblings but order deterministically.
  keep.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : clockStr(a.clock) < clockStr(b.clock) ? -1 : 1));
  return keep;
}

/** Merge two version sets (set union followed by reconciliation). Commutative,
 *  associative and idempotent — the property that makes anti-entropy converge. */
export function mergeVersions(a: VersionSet, b: VersionSet): VersionSet {
  return reconcile([...a, ...b]);
}

/** The causal context of an object: the join of all its sibling clocks. A
 *  read-modify-write uses this so the new version dominates everything it saw. */
export function contextClock(vs: VersionSet): VClock {
  let c: VClock = {};
  for (const v of vs) c = mergeClocks(c, v.clock);
  return c;
}

export function versionSetEq(a: VersionSet, b: VersionSet): boolean {
  if (a.length !== b.length) return false;
  const ak = a.map(versionKey).sort();
  const bk = b.map(versionKey).sort();
  return ak.every((k, i) => k === bk[i]);
}

export function valuesStr(vs: VersionSet): string {
  if (vs.length === 0) return '—';
  return vs.map((v) => v.value).join(' ⊕ ');
}

// ---- protocol state -------------------------------------------------------

/** What a node believes about a peer's liveness, from the ping/pong detector. */
export interface PeerHealth {
  /** Last virtual time we heard a pong from this peer. */
  lastSeen: number;
  alive: boolean;
}

/** A pending client write the coordinator is still gathering W acks for. */
export interface PendingPut {
  reqId: number;
  key: string;
  version: Version;
  acks: number; // including the coordinator's own local store
  need: number; // W
  done: boolean;
  /** Did this write land on any hint-holding substitute (a sloppy quorum)? */
  sloppy: boolean;
  startedAt: number;
}

/** A pending client read gathering R responses. */
export interface PendingGet {
  reqId: number;
  key: string;
  responses: { from: NodeId; versions: VersionSet }[];
  need: number; // R
  done: boolean;
  startedAt: number;
}

/** The outcome of the most recent client GET on this node (for the UI). */
export interface ReadResult {
  key: string;
  versions: VersionSet;
  replies: number;
  conflict: boolean;
  at: number;
}

/** The outcome of the most recent client PUT this node coordinated (for the UI). */
export interface WriteResult {
  key: string;
  value: string;
  clock: VClock;
  acks: number;
  sloppy: boolean; // did this write land on any hint-holder substitute?
  at: number;
}

export interface DynamoState {
  id: NodeId;

  // ---- durable storage (survives a crash — disk persists) ----------------
  /** This node's replica data: key → reconciled version set. */
  store: Record<string, VersionSet>;
  /** Data held on behalf of an unreachable home node: targetNode → key → versions. */
  hints: Record<NodeId, Record<string, VersionSet>>;
  /** Per-key componentwise-max clock of every write this node has *acknowledged*
   *  to a client. The durability invariant proves none of these is ever lost. */
  ackedFrontier: Record<string, VClock>;

  // ---- volatile coordinator bookkeeping (rebuilt; lost on crash) ---------
  pendingPuts: Record<number, PendingPut>;
  pendingGets: Record<number, PendingGet>;
  lastRead: ReadResult | null;
  lastWrite: WriteResult | null;

  // ---- failure detector --------------------------------------------------
  health: Record<NodeId, PeerHealth>;

  // ---- replicated config (identical on every node) -----------------------
  cfg: QuorumConfig;

  // ---- UI annotation -----------------------------------------------------
  note: string;
}

/** The three knobs that define Dynamo's consistency/availability trade-off. */
export interface QuorumConfig {
  /** Replication factor — how many nodes store each key. */
  n: number;
  /** Read quorum — replies a GET waits for. */
  r: number;
  /** Write quorum — acks a PUT waits for. */
  w: number;
}

export interface DynamoConfig extends QuorumConfig {
  /** Whether sloppy quorum + hinted handoff is enabled (vs. strict quorum). */
  sloppy: boolean;
  pingInterval: number;
  /** A peer unheard-from for this long is suspected dead. */
  deadAfter: number;
  antiEntropyInterval: number;
  handoffInterval: number;
  reqTimeout: number;
}

export const DEFAULT_DYNAMO_CONFIG: DynamoConfig = {
  n: 3,
  r: 2,
  w: 2,
  sloppy: true,
  pingInterval: 140,
  deadAfter: 360,
  antiEntropyInterval: 300,
  handoffInterval: 200,
  reqTimeout: 800,
};

// ---- message payloads -----------------------------------------------------

export interface PutMsg {
  reqId: number;
  coordinator: NodeId;
  key: string;
  version: Version;
  /** If set, the receiver is a *substitute* holding this for an unreachable home node. */
  hintFor?: NodeId;
}
export interface PutAckMsg {
  reqId: number;
  key: string;
  from: NodeId;
  sloppy: boolean;
}
export interface GetMsg {
  reqId: number;
  coordinator: NodeId;
  key: string;
}
export interface GetRespMsg {
  reqId: number;
  key: string;
  versions: VersionSet;
  from: NodeId;
}
export interface ReadRepairMsg {
  key: string;
  versions: VersionSet;
}
export interface HintDeliverMsg {
  key: string;
  versions: VersionSet;
  target: NodeId;
}
export interface HintAckMsg {
  key: string;
  from: NodeId;
}
export interface AntiEntropyMsg {
  data: Record<string, VersionSet>;
}
export interface PingMsg {
  t: number;
}
export interface PongMsg {
  from: NodeId;
}
export interface ForwardMsg {
  cmd: DynamoCmd;
}

// ---- client commands ------------------------------------------------------

export type DynamoCmd =
  | { type: 'put'; key: string; value: string; blind: boolean; reqId: number }
  | { type: 'get'; key: string; reqId: number };

// ---- quorum helpers -------------------------------------------------------

/** Does this configuration guarantee read/write quorum overlap (R + W > N)?
 *  When true, in the absence of failures a read sees the latest acked write. */
export function overlaps(cfg: QuorumConfig): boolean {
  return cfg.r + cfg.w > cfg.n;
}

export function consistencyLabel(cfg: QuorumConfig): string {
  if (cfg.r + cfg.w > cfg.n) return 'strong (R+W>N)';
  return 'eventual (R+W≤N)';
}
