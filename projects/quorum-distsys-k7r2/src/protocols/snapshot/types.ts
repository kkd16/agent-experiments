// Types for the Chandy–Lamport lab — consistent global snapshots of a running
// distributed computation, taken *without stopping it*.
//
// Most labs here decide or store something. Chandy–Lamport (1985) solves a
// different problem entirely: how does one node take a photograph of the *whole*
// distributed system — every node's local state *and* every message in flight —
// that is **consistent** (a valid global state the system really passed through),
// even though there is no shared clock and the computation never pauses? That
// recorded global state is what you then test a **stable property** on: has the
// system deadlocked? terminated? lost money?
//
// The running computation here is a **conserved token economy**: every node holds
// a balance and continuously transfers random amounts to peers along directed
// channels. The global total never changes, but at any instant some of it is
// "in flight" in the channels. A naive snapshot (just ask everyone their balance)
// misses the in-flight money and reports the wrong total. Chandy–Lamport gets it
// exactly right by also recording channel contents — and the lab proves it: the
// recorded total always equals the true conserved total.
//
// The algorithm needs **FIFO channels**, so this protocol layers a per-channel
// sequence number + reorder buffer over the (reordering) kernel network, and the
// markers travel in that same FIFO stream — which is the whole trick.
import type { NodeId } from '../../sim/types';

export interface SnapConfig {
  /** Each node's starting balance; the conserved total is N × this. */
  initialBalance: number;
  /** Mean delay between a node's spontaneous transfers (ms). */
  txnDelay: number;
  /** Maximum fraction of its balance a node moves in one transfer. */
  maxTransferFrac: number;
}

export const DEFAULT_SNAP_CONFIG: SnapConfig = {
  initialBalance: 100,
  txnDelay: 90,
  maxTransferFrac: 0.4,
};

/** A message buffered awaiting its turn in a channel's FIFO order. */
export interface Buffered {
  kind: 'app' | 'marker';
  /** App: the transferred amount. */
  amount?: number;
  /** Marker: which snapshot it belongs to. */
  snapId?: number;
}

export interface SnapState {
  self: NodeId;
  /** The local state being snapshotted: this node's current balance. */
  balance: number;
  /** Constant — its share of the conserved total (for the consistency check). */
  initialBalance: number;
  /** Cumulative money sent / received (for the live conservation gauge). */
  sent: number;
  received: number;

  // ---- FIFO channel layer -------------------------------------------------
  /** Next outgoing sequence number per destination channel. */
  outSeq: Record<NodeId, number>;
  /** Next expected incoming sequence number per source channel. */
  inExpected: Record<NodeId, number>;
  /** Out-of-order arrivals held until their turn: source → seq → message. */
  inBuf: Record<NodeId, Record<number, Buffered>>;

  // ---- Chandy–Lamport recording ------------------------------------------
  /** The snapshot this node is currently participating in (0 = none). */
  snapId: number;
  /** Whether this node has recorded its own state for `snapId`. */
  recordedOwn: boolean;
  /** The balance captured when this node recorded its state. */
  recordedState: number | null;
  /** Recorded in-flight money per incoming channel (messages after own-state,
   *  before that channel's marker). */
  channelState: Record<NodeId, number>;
  /** Whether each incoming channel's recording has finished (its marker seen). */
  channelClosed: Record<NodeId, boolean>;
  /** True once own state recorded and every incoming channel closed. */
  done: boolean;
  /** When this node finished recording (virtual ms), for the UI. */
  doneAt: number | null;

  note: string;
}

// ---- message payloads -----------------------------------------------------

export interface AppMsg {
  seq: number;
  amount: number;
}
export interface MarkerMsg {
  seq: number;
  snapId: number;
}

// ---- client commands ------------------------------------------------------

export type SnapCmd =
  /** Start a fresh snapshot with this node as initiator. */
  | { type: 'snapshot' }
  /** Force a one-off transfer to a random peer (besides the automatic ones). */
  | { type: 'transfer' };
