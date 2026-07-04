// Types for the Streamlet lab — the *textbook* Byzantine-fault-tolerant
// consensus protocol (Benjamin Chan & Elaine Shi, "Streamlet: Textbook
// Streamlined Blockchains", 2020).
//
// Streamlet is the deliberate opposite of HotStuff: same fault model (up to
// f Byzantine out of N = 3f+1, safety by quorum intersection on 2f+1 votes),
// but pared down until almost nothing is left. There is
//
//   • NO pacemaker, NO view-change sub-protocol, NO leader timeouts, NO locks,
//     NO "highest-QC" bookkeeping. The three-variable safety machine HotStuff
//     carries (qcHigh / lockedQC / vheight) simply does not exist here.
//   • ONE rule to propose: extend the *longest notarized chain* you have seen.
//   • ONE rule to vote:     vote for the epoch leader's proposal iff it extends
//     a longest notarized chain in your view — and at most once per epoch.
//   • ONE rule to finalize:  if a notarized chain ever contains **three adjacent
//     blocks with consecutive epoch numbers** (e, e+1, e+2), the middle block —
//     and the entire chain before it — is final, forever.
//
// That is the whole protocol. Time is sliced into synchronized **epochs**; each
// epoch has a public round-robin leader; a block is **notarized** once it
// collects 2f+1 votes; a chain is notarized when all its blocks are. Safety
// (no two honest nodes finalize conflicting blocks) holds under *complete
// asynchrony* — arbitrary delays, drops and reordering — resting only on the
// two voting rules and 2f+1 quorum intersection. Synchrony is needed only for
// *liveness*: once the network delivers within an epoch, three honest leaders in
// a row finalize a block. This lab makes that contrast with HotStuff visible:
// the same guarantees, a fraction of the moving parts, at the cost of all-to-all
// (O(N²)) vote dissemination instead of HotStuff's linear certificate hand-off.
import type { NodeId } from '../../sim/types';

/** The number of Byzantine faults an N-node cluster tolerates: f = ⌊(N-1)/3⌋. */
export const faultBudget = (n: number): number => Math.floor((n - 1) / 3);

/** Notarization threshold: a block needs ≥ 2f+1 (= ⌈2N/3⌉, = n − f) distinct votes. */
export const quorum = (n: number): number => 2 * faultBudget(n) + 1;

/** The leader (proposer) of an epoch — pure round-robin, public and rotating. In
 *  the paper the leader is H(epoch) mod n; a seeded permutation would do equally
 *  well. Round-robin keeps it legible and still rotates a faulty leader out in
 *  one epoch. Epoch 0 is genesis and has no leader. */
export const leaderOf = (all: NodeId[], epoch: number): NodeId =>
  all[((epoch % all.length) + all.length) % all.length];

/** How a faulty replica misbehaves. `honest` nodes follow the protocol exactly. */
export type FaultMode =
  | 'honest'
  /** Sends nothing it is responsible for. A silent *leader* proposes no block, so
   *  its epoch simply produces nothing and the next epoch's leader carries on; a
   *  silent *backup* withholds its votes (harmless while faulty ≤ f). No timeout
   *  or view-change is needed — a dead epoch just passes. */
  | 'silent'
  /** LEADER ATTACK: proposes two *different* blocks at the same epoch on the same
   *  parent, sending one to half the backups and a conflicting one to the rest —
   *  and double-votes for both. The canonical equivocation attack. Quorum
   *  intersection makes it impossible for both to gather 2f+1 votes, so at most
   *  one notarizes and no two honest replicas ever finalize conflicting blocks. */
  | 'equivocate'
  /** BACKUP ATTACK: votes for a corrupted block hash that matches no real
   *  proposal, trying to manufacture a bogus notarization. Every honest replica
   *  only counts votes whose hash matches a block it actually holds, so these
   *  votes never count — harmless while faulty ≤ f. */
  | 'conflict';

/** A single command applied to the replicated key/value state machine. */
export type KvOp =
  | { op: 'set'; key: string; value: string }
  | { op: 'del'; key: string }
  | { op: 'noop' };

/** A client request: an operation plus a unique client id (for de-duplication). */
export interface Command {
  cid: string;
  op: KvOp;
}

/** The internally-generated empty command. Streamlet leaders propose an empty
 *  block whenever they have nothing pending, because finalization needs three
 *  *adjacent* blocks — empty blocks keep the pipeline flowing and are normal. */
export const NOOP: Command = { cid: '∅', op: { op: 'noop' } };

export function opStr(cmd: Command | null | undefined): string {
  if (!cmd) return '—';
  const o = cmd.op;
  if (o.op === 'noop') return '∅';
  if (o.op === 'set') return `${o.key}=${o.value}`;
  return `del ${o.key}`;
}

// ---- the block tree -------------------------------------------------------

/**
 * One block in the replicated tree. Blocks link by `parent`; the notarized
 * blocks form notarized chains, and the finalized prefix is the single agreed
 * log. Unlike HotStuff a Streamlet block carries **no certificate** — a block is
 * just its content, and notarization lives entirely in each replica's counted
 * vote set. `epoch` is the crucial field: finalization is a statement purely
 * about three consecutive `epoch` numbers along a chain.
 */
export interface Block {
  /** Content-addressed id: a stable hash of (epoch, parent, proposer, command). */
  hash: string;
  /** The epoch this block was proposed in (leader = all[epoch % N]). */
  epoch: number;
  /** Distance from genesis (genesis = 0). Also the block's chain length. */
  height: number;
  /** The parent block's hash (the block this one extends). */
  parent: string;
  /** Who proposed it. */
  proposer: NodeId;
  /** The command it orders (an empty block flushes the pipeline). */
  cmd: Command;
}

export const GENESIS_HASH = 'genesis';

/** The genesis block: epoch 0, height 0. It is notarized by definition. */
export function genesisBlock(): Block {
  return { hash: GENESIS_HASH, epoch: 0, height: 0, parent: '', proposer: '∅', cmd: NOOP };
}

/** Deterministic content hash of a block's identity. */
export function blockHash(epoch: number, parent: string, proposer: NodeId, cmd: Command): string {
  const op = cmd.op;
  const body = op.op === 'set' ? `s:${op.key}=${op.value}` : op.op === 'del' ? `d:${op.key}` : 'n';
  return `b${epoch}@${parent.slice(0, 8)}#${proposer}:${cmd.cid}:${body}`;
}

// ---- a finalized log entry (for the UI / invariants) ----------------------

export interface CommittedEntry {
  height: number;
  epoch: number;
  hash: string;
  cmd: Command;
  /** How this entry became final: a local consecutive-epoch triple, or an f+1
   *  catch-up certificate gossiped after a partition heal / restart. */
  via: 'triple' | 'catchup';
}

// ---- replica state --------------------------------------------------------

export interface StreamletState {
  // ---- identity / fault model -------------------------------------------
  fault: FaultMode;

  // ---- the synchronized epoch clock -------------------------------------
  /** The epoch this replica currently believes is active (driven by the shared
   *  clock — every node advances epochs together, which is exactly Streamlet's
   *  synchronized-epoch assumption). */
  epoch: number;

  // ---- the block tree (durable) -----------------------------------------
  /** hash → block, the part of the tree this replica knows. Old blocks pruned. */
  blocks: Record<string, Block>;
  /** hash → set of distinct voters seen for that block (the notarization tally). */
  votes: Record<string, Record<NodeId, true>>;
  /** hash → true once this replica has seen ≥ 2f+1 votes for the block. */
  notarized: Record<string, true>;
  /** epoch → the block hash this replica voted for in that epoch (one per epoch,
   *  durable so a crash can never make an honest node double-vote). */
  votedInEpoch: Record<number, string>;

  // ---- finality + the replicated state machine (durable) ----------------
  /** height → hash, finalized (irrevocable) blocks awaiting in-order execution. */
  finalized: Record<number, string>;
  /** Highest finalized+executed height (every height ≤ it is executed too). */
  finalHeight: number;
  /** Hash of the highest executed block (the executed chain's tip). */
  finalHash: string;
  /** The replicated key/value store: the finalized commands replayed in order. */
  kv: Record<string, string>;
  /** A flat finalized log for the UI / invariants. */
  committed: CommittedEntry[];
  /** cid → true once executed (so a command is applied at most once). */
  executedCid: Record<string, true>;
  /** height → hash → set of replicas that reported finalizing it (catch-up). */
  catchup: Record<number, Record<string, Record<NodeId, true>>>;

  // ---- request intake ---------------------------------------------------
  /** Client commands accepted but not yet seen finalized. */
  pending: Command[];

  // ---- UI annotation ----------------------------------------------------
  note: string;
  /** Per-render scratch: whether the latest finalize came from a fresh triple. */
  lastFinalHeight: number;
}

export interface StreamletConfig {
  /** Epoch length (ms). The whole cluster advances epochs on this shared beat.
   *  Must comfortably exceed a proposal + a vote round-trip so a block can
   *  notarize before the next epoch's leader proposes on top of it. */
  epochLen: number;
  /** How often a replica gossips its finalized watermark (drives catch-up). */
  syncPeriod: number;
}

export const DEFAULT_STREAMLET_CONFIG: StreamletConfig = {
  epochLen: 700,
  syncPeriod: 320,
};

// ---- message payloads -----------------------------------------------------

/** Client → all replicas (multicast so any epoch leader can pick it up). */
export interface RequestMsg {
  command: Command;
}

/** Leader → all backups: "here is my epoch's block". */
export interface ProposeMsg {
  block: Block;
}

/** Any replica → all: "I vote for this block". Votes are broadcast to everyone —
 *  Streamlet has no leader-aggregation, so every node tallies notarization for
 *  itself. The block body rides along so a peer that missed the proposal (a drop
 *  or a brief partition) can still learn the block and count the vote. */
export interface VoteMsg {
  block: Block;
  from: NodeId;
}

/** Periodic gossip of how far a replica has finalized (drives catch-up). */
export interface StatusMsg {
  from: NodeId;
  finalHeight: number;
}

/** A reply shipping finalized blocks a lagging peer is missing. */
export interface CatchupMsg {
  from: NodeId;
  entries: Block[];
}

export type StreamletCmd =
  | { type: 'request'; command: Command }
  | { type: 'set-fault'; mode: FaultMode };
