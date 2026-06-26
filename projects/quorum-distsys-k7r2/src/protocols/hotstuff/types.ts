// Types for the HotStuff lab — the *modern* Byzantine-fault-tolerant consensus
// protocol (Yin, Malkhi, Reiter, Gueta & Abraham, PODC 2019), the engine behind
// Diem/Libra and a generation of BFT blockchains.
//
// HotStuff lives in the same fault model as PBFT — up to f Byzantine replicas
// out of N = 3f + 1, safety by quorum intersection on 2f+1 certificates — but it
// is built very differently, and the contrast is the whole point of this lab:
//
//   • LINEAR communication. PBFT's PREPARE and COMMIT phases are all-to-all
//     (O(N²) messages per decision). HotStuff routes every vote to a single
//     *leader* who aggregates 2f+1 of them into one **quorum certificate (QC)**;
//     the next proposal carries that QC to everyone. Each phase is O(N).
//   • ROTATING leaders. The leader changes **every view** (round-robin), so no
//     replica is ever a bottleneck or a long-lived target, and a faulty leader
//     costs exactly one view. PBFT keeps a primary until it is suspected.
//   • A 3-CHAIN commit rule. Where PBFT runs three explicit phases per request,
//     **chained HotStuff** *pipelines* them: every block plays one phase for each
//     of its three predecessors, so one vote round per block does the work of a
//     whole phase. A block commits the instant a chain of three QCs with
//     consecutive views forms on top of it.
//
// This is the chained/streamlined variant — the one people mean by "HotStuff".
import type { NodeId } from '../../sim/types';

/** The number of Byzantine faults an N-node cluster tolerates: f = ⌊(N-1)/3⌋. */
export const faultBudget = (n: number): number => Math.floor((n - 1) / 3);

/** Certificate / quorum size: a QC needs 2f + 1 distinct votes (= n − f). */
export const quorum = (n: number): number => 2 * faultBudget(n) + 1;

/** The leader (proposer) of a view — pure round-robin, so it rotates every view. */
export const leaderOf = (all: NodeId[], view: number): NodeId =>
  all[((view % all.length) + all.length) % all.length];

/** How a faulty replica misbehaves. `honest` nodes follow the protocol exactly. */
export type FaultMode =
  | 'honest'
  /** Sends nothing it is responsible for. A silent *leader* proposes no block, so
   *  its view stalls and the pacemaker rotates to the next leader; a silent
   *  *backup* withholds its votes (harmless while faulty ≤ f). */
  | 'silent'
  /** LEADER ATTACK: proposes two *different* blocks at the same view, sending one
   *  to half the backups and a conflicting one to the rest — the canonical
   *  equivocation attack. HotStuff must never let two honest replicas commit
   *  conflicting blocks; with faulty ≤ f the split simply denies either block a
   *  2f+1 quorum, so no QC forms and the view times out. */
  | 'equivocate'
  /** BACKUP ATTACK: votes for a corrupted block hash that matches no real
   *  proposal, trying to manufacture a bogus QC. The aggregating leader only
   *  counts votes whose hash matches a block it actually proposed, so these
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

/** The internally-generated empty command used to keep the pipeline flowing. */
export const NOOP: Command = { cid: '∅', op: { op: 'noop' } };

export function opStr(cmd: Command | null | undefined): string {
  if (!cmd) return '—';
  const o = cmd.op;
  if (o.op === 'noop') return '∅';
  if (o.op === 'set') return `${o.key}=${o.value}`;
  return `del ${o.key}`;
}

// ---- the block tree + quorum certificates ---------------------------------

/**
 * A **quorum certificate**: cryptographic proof (modelled here as a counted set
 * of distinct voters) that 2f+1 replicas voted for `block` in view `view`. A QC
 * is the single object that carries agreement from one view to the next — the
 * mechanism that makes HotStuff's communication linear.
 */
export interface QC {
  /** The view in which the certified block was proposed. */
  view: number;
  /** The hash of the certified block. */
  block: string;
  /** The distinct replicas whose votes formed it (for display / audit). */
  voters: NodeId[];
}

/**
 * One block in the replicated chain. Blocks form a tree (each points at its
 * `parent`); the committed blocks form the single agreed chain. Every block
 * carries a `justify` QC — the certificate for an earlier block — and that is
 * what threads the three pipelined phases together.
 */
export interface Block {
  /** Content-addressed id: a stable hash of (view, parent, proposer, command). */
  hash: string;
  /** The view this block was proposed in (leader = all[view % N]). */
  view: number;
  /** Distance from genesis (genesis = 0). */
  height: number;
  /** The parent block's hash (the block this one extends). */
  parent: string;
  /** Who proposed it. */
  proposer: NodeId;
  /** The command it orders (a no-op flushes the pipeline). */
  cmd: Command;
  /** The QC this block carries forward — certifies some earlier block. */
  justify: QC;
}

export const GENESIS_HASH = 'genesis';

/** The genesis QC (self-certifying view 0) every replica starts from. */
export function genesisQC(): QC {
  return { view: 0, block: GENESIS_HASH, voters: [] };
}

/** The genesis block: height 0, view 0, its own justify (a harmless self-loop). */
export function genesisBlock(): Block {
  return { hash: GENESIS_HASH, view: 0, height: 0, parent: '', proposer: '∅', cmd: NOOP, justify: genesisQC() };
}

/** Deterministic content hash of a block's identity. */
export function blockHash(view: number, parent: string, proposer: NodeId, cmd: Command): string {
  const op = cmd.op;
  const body = op.op === 'set' ? `s:${op.key}=${op.value}` : op.op === 'del' ? `d:${op.key}` : 'n';
  return `b${view}@${parent.slice(0, 8)}#${proposer}:${cmd.cid}:${body}`;
}

// ---- a committed log entry (for the UI / invariants) ----------------------

export interface CommittedEntry {
  height: number;
  view: number;
  hash: string;
  cmd: Command;
  /** How this entry became final: a local 3-chain, or an f+1 catch-up certificate. */
  via: 'chain' | 'catchup';
}

// ---- replica state --------------------------------------------------------

export interface HsState {
  // ---- identity / fault model -------------------------------------------
  fault: FaultMode;

  // ---- pacemaker --------------------------------------------------------
  /** The view this replica currently believes is active. */
  curView: number;
  /** The highest view this replica has issued a proposal for (≤ curView). */
  proposedView: number;
  /** The view this replica has already broadcast a TIMEOUT for (−1 = none). */
  timedOutView: number;
  /** Consecutive view-timeouts without progress (drives exponential backoff). */
  timeoutStreak: number;

  // ---- the block tree (durable) -----------------------------------------
  /** hash → block, the part of the tree this replica knows. Old blocks are pruned. */
  blocks: Record<string, Block>;

  // ---- the three safety variables (durable across a crash) --------------
  /** qcHigh / genericQC: the highest QC this replica has seen. New proposals extend it. */
  qcHigh: QC;
  /** lockedQC: the head of the highest 2-chain. A replica will not vote against a
   *  block that conflicts with this unless shown a strictly newer QC (safety). */
  lockedView: number;
  lockedHash: string;
  lockedHeight: number;
  /** vheight: the height of the last block this replica voted for (vote once per height). */
  vheight: number;

  // ---- the committed state machine (durable) ----------------------------
  /** Highest committed height (every height ≤ it is committed too). */
  bExecHeight: number;
  /** Hash of the highest committed block (the executed chain's tip). */
  bExecHash: string;
  /** The replicated key/value store: the committed commands replayed in order. */
  kv: Record<string, string>;
  /** A flat committed log for the UI / invariants. */
  committed: CommittedEntry[];
  /** cid → true once executed (so a command is applied at most once). */
  executedCid: Record<string, true>;

  // ---- leader-side vote aggregation -------------------------------------
  /** view → blockHash → set of distinct voters (the QC being assembled). */
  votes: Record<number, Record<string, Record<NodeId, true>>>;
  /** Views for which this replica (as that view's vote-collector) already made a QC. */
  formedQC: Record<number, true>;

  // ---- pacemaker timeout aggregation ------------------------------------
  /** view → (from → its highQC), the TIMEOUTs collected toward a timeout certificate. */
  timeouts: Record<number, Record<NodeId, QC>>;

  // ---- finality bookkeeping ---------------------------------------------
  /** height → hash, marked final by a 3-chain or a catch-up certificate, awaiting in-order execution. */
  decided: Record<number, string>;
  /** height → hash → set of replicas that reported committing it (catch-up). */
  catchup: Record<number, Record<string, Record<NodeId, true>>>;

  // ---- request intake ---------------------------------------------------
  /** Client commands accepted but not yet seen committed. */
  pending: Command[];

  // ---- UI annotation ----------------------------------------------------
  note: string;
  /** Per-render scratch: whether the latest decide came from a fresh 3-chain. */
  lastCommitHeight: number;
}

export interface HsConfig {
  /** Base pacemaker timeout (ms) before a replica suspects the current leader. */
  viewTimeout: number;
  /** How often a replica gossips its committed watermark (drives catch-up). */
  syncPeriod: number;
}

export const DEFAULT_HOTSTUFF_CONFIG: HsConfig = {
  viewTimeout: 900,
  syncPeriod: 300,
};

// ---- message payloads -----------------------------------------------------

/** Client → all replicas (multicast so any replica can drive / detect a dead leader). */
export interface RequestMsg {
  command: Command;
}

/** Leader → all backups: "I propose this block in my view". */
export interface ProposeMsg {
  block: Block;
}

/** Backup → the view's leader: "I vote for `block` in `view`". (Linear: the
 *  leader aggregates the 2f+1 votes into a QC and disseminates it below.) */
export interface VoteMsg {
  view: number;
  block: string;
  from: NodeId;
}

/** Leader → all: a freshly-formed quorum certificate, the linear hand-off that
 *  lets the next view's leader propose on top of it and every replica advance. */
export interface QCMsg {
  qc: QC;
}

/** Replica → all: "I have given up on view `view`; here is my highest QC." */
export interface TimeoutMsg {
  view: number;
  highQC: QC;
  from: NodeId;
}

/** Periodic gossip of how far a replica has committed (drives catch-up). */
export interface StatusMsg {
  from: NodeId;
  bExecHeight: number;
}

/** A reply shipping committed blocks a lagging peer is missing. */
export interface CatchupMsg {
  from: NodeId;
  entries: Block[];
}

export type HsCmd =
  | { type: 'request'; command: Command }
  | { type: 'set-fault'; mode: FaultMode };
