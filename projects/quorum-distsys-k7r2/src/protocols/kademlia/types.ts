// Types for the Kademlia DHT lab (Maymounkov & Mazières, IPTPS 2002) — the
// XOR-metric distributed hash table behind BitTorrent's Mainline DHT, IPFS,
// Ethereum's discv5 and Storj. Where Chord routes clockwise around a ring with
// a **recursive** lookup, Kademlia routes down a binary tree by XOR distance
// with an **iterative, parallel** lookup: the initiator itself drives α
// concurrent probes, keeping a shortlist of the k closest contacts it has heard
// of and repeatedly querying the closest still-unqueried ones until the frontier
// closes on the true k nearest nodes.
import type { NodeId } from '../../sim/types';

export interface KademliaConfig {
  /** Id space is [0, 2^m). m=8 ⇒ 256 positions — ample for ≤8 nodes. */
  m: number;
  /** k-bucket size = replication factor = result-set size (the "k" in k-closest). */
  k: number;
  /** Lookup concurrency: how many probes are kept in flight at once (Kademlia's α). */
  alpha: number;
  /** How long to wait for an RPC reply before declaring a contact dead. */
  rpcTimeout: number;
  /** Period of the background bucket-refresh lookup that keeps tables fresh. */
  refreshInterval: number;
  /** Period at which a node re-publishes (STOREs) the keys it originated. */
  republishInterval: number;
}

export const DEFAULT_KADEMLIA_CONFIG: KademliaConfig = {
  m: 8,
  k: 4,
  alpha: 3,
  rpcTimeout: 260,
  refreshInterval: 900,
  republishInterval: 1600,
};

export type LookupKind = 'node' | 'value' | 'join' | 'refresh' | 'store';

/** Per-candidate status inside one iterative lookup. */
export type CandStatus = 'unqueried' | 'pending' | 'ok' | 'dead';

/** A live k-bucket routing table (plain data so the kernel can snapshot it).
 *  `buckets[i]` is ordered least-recently-seen (head) → most-recently-seen
 *  (tail); a contact that answers is moved to the tail, so the head is always
 *  the eviction candidate. */
export interface RoutingTable {
  self: number;
  m: number;
  k: number;
  buckets: number[][];
}

/** One in-progress iterative lookup, owned by the initiator. */
export interface Lookup {
  id: number;
  target: number;
  kind: LookupKind;
  /** Every candidate id we have heard of for this lookup (incl. self). */
  shortlist: number[];
  status: Record<number, CandStatus>;
  inflight: number;
  rounds: number;
  /** For value lookups: the value once some node returns it. */
  value: string | null;
  /** For store lookups: the value to STORE at the resulting k-closest nodes. */
  storeVal?: string;
  /** Ids contacted, in order (for the lookup-path visualisation). */
  path: number[];
  startedAt: number;
}

/** The finished result of the most recent lookup a node initiated (for the UI). */
export interface LookupResult {
  kind: LookupKind;
  target: number;
  closest: number[];
  path: number[];
  value: string | null;
  found: boolean;
  rounds: number;
  key?: number;
}

export interface KademliaState {
  // ---- identity (persistent) --------------------------------------------
  id: number;
  m: number;
  k: number;
  alpha: number;
  /** id → physical node name (the transport directory; every node has it). */
  names: Record<number, NodeId>;

  // ---- routing + storage -------------------------------------------------
  rt: RoutingTable;
  /** key → value pairs this node is storing (persists across a crash). */
  store: Record<number, string>;
  /** keys this node originated (so it can re-publish them). */
  originated: number[];

  // ---- lifecycle / bookkeeping ------------------------------------------
  joined: boolean;
  reqSeq: number;
  lookups: Record<number, Lookup>;
  /** pingId → the eviction decision awaiting the pinged head's reply. */
  pendingEvict: Record<number, { bucket: number; lru: number; challenger: number }>;

  // ---- UI annotation -----------------------------------------------------
  lastResult: LookupResult | null;
  note: string;
}

// ---- message payloads -----------------------------------------------------

export interface FindReq {
  lid: number;
  target: number;
  kind: LookupKind;
  src: number; // sender's kad id (so the receiver can learn it)
}
export interface FindRep {
  lid: number;
  src: number;
  contacts: number[];
  value: string | null;
}
export interface StoreReq {
  key: number;
  value: string;
  src: number;
}
export interface PingReq {
  pid: number;
  src: number;
}
export interface PongRep {
  pid: number;
  src: number;
}

export type KademliaCmd =
  | { type: 'lookup'; target: number }
  | { type: 'put'; key: number; value: string }
  | { type: 'get'; key: number }
  | { type: 'ping'; to: number }
  | { type: 'refresh' };
