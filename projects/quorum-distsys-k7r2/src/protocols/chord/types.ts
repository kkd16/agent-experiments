// Types for the Chord DHT lab (Stoica, Morris, Karger, Kaashoek & Balakrishnan,
// SIGCOMM 2001). Chord places both nodes and keys on a circular m-bit identifier
// ring; a key is owned by its **successor** — the first node clockwise at or
// after the key. Each node keeps a **finger table** of m shortcuts (to the
// successor of id+2^i) so a lookup reaches the owner in O(log N) hops, and a
// periodic **stabilization** protocol keeps successor/predecessor pointers
// correct as nodes join and fail.
import type { NodeId } from '../../sim/types';

export interface ChordConfig {
  /** Identifier ring is [0, 2^m). m=8 ⇒ 256 positions — ample for ≤7 nodes. */
  m: number;
  /** Length of the maintained successor list (failover depth). */
  r: number;
  stabilizeInterval: number;
  fixFingersInterval: number;
  checkPredInterval: number;
  /** How long to wait for an RPC reply before declaring a pointer failed. */
  rpcTimeout: number;
}

export const DEFAULT_CHORD_CONFIG: ChordConfig = {
  m: 8,
  r: 3,
  stabilizeInterval: 220,
  fixFingersInterval: 130,
  checkPredInterval: 300,
  rpcTimeout: 260,
};

export type LookupPurpose = 'join' | 'finger' | 'user';

export interface ChordState {
  // ---- identity (persistent) --------------------------------------------
  id: number; // this node's ring id
  m: number;
  /** Ring-id → physical node name. A transport/DNS directory (every node has it);
   *  the *algorithm* still only uses ids it learns through messages. */
  names: Record<number, NodeId>;

  // ---- routing pointers --------------------------------------------------
  successorList: number[]; // successorList[0] is the immediate successor
  predecessor: number | null;
  finger: number[]; // finger[i] = successor(id + 2^i); length m

  // ---- lifecycle / bookkeeping ------------------------------------------
  joined: boolean;
  nextFinger: number; // round-robin index for fix_fingers
  awaitingStabilize: boolean; // a GetPredecessor RPC is outstanding
  awaitingPred: boolean; // a Ping to the predecessor is outstanding
  reqSeq: number;

  // ---- UI annotation -----------------------------------------------------
  /** The most recent *user* lookup routed through this node (origin), for the viz. */
  lastLookup: { key: number; owner: number; path: number[]; hops: number } | null;
  note: string;
}

// ---- message payloads -----------------------------------------------------

export interface FindSuccessor {
  key: number;
  origin: number;
  purpose: LookupPurpose;
  fingerIdx: number; // for 'finger' lookups
  reqId: number;
  hops: number;
  path: number[]; // ring ids visited so far (for the lookup-path viz)
}
export interface FoundSuccessor {
  key: number;
  succ: number;
  origin: number;
  purpose: LookupPurpose;
  fingerIdx: number;
  reqId: number;
  hops: number;
  path: number[];
}
export interface GetPredecessor {
  reqId: number;
}
export interface PredecessorInfo {
  pred: number | null;
  succList: number[];
  from: number;
}
export interface Notify {
  from: number;
}
export interface Ping {
  reqId: number;
}
export interface Pong {
  from: number;
}

export type ChordCmd =
  | { type: 'lookup'; key: number }
  | { type: 'join' };
