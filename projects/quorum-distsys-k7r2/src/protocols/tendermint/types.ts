// Types for the Tendermint lab — the gossip-based Byzantine-fault-tolerant
// consensus at the heart of ZooKeeper's successors, Cosmos and a whole
// generation of proof-of-stake chains (Buchman 2016; Buchman, Kwon & Milošević,
// "The latest gossip on BFT consensus", 2018).
//
// Tendermint is the BFT state-machine-replication protocol that decides ONE
// block per **height**, and it is the counterweight to the other three BFT labs
// here:
//
//   • PBFT carries an explicit, heavyweight *view-change* sub-protocol.
//   • HotStuff pipelines a 3-chain and funnels votes into a linear certificate.
//   • Streamlet throws away locks entirely and finalizes on a consecutive triple.
//   • Tendermint keeps a **lock** — and that lock is the whole story. It is the
//     protocol that made the safety-vs-liveness tension of partially-synchronous
//     BFT legible: a validator that has *seen a value get 2f+1 prevotes* LOCKS on
//     it and will not prevote anything else in a later round unless it sees an
//     even-later 2f+1 prevote (a *Proof-of-Lock-Change*). That single rule is
//     exactly what stops two rounds of the same height from deciding differently.
//
// Structure. Consensus for one height H climbs a ladder of **rounds** R = 0,1,2…,
// each round three **steps**:
//
//   PROPOSE.   The round's round-robin proposer = validators[(H+R) mod N]
//              broadcasts a value (a block). If it has a locked/valid value it
//              re-proposes *that* (tagging the round it became valid); otherwise
//              it draws a fresh block from its mempool.
//   PREVOTE.   Every validator prevotes for the proposal's id — but ONLY if the
//              proposal is valid AND (it holds no lock, OR the proposal is its
//              locked value, OR the proposal comes with a Proof-of-Lock from a
//              round later than its own lock). Otherwise it prevotes **nil**.
//              2f+1 prevotes for one value is a **Polka** (a proof of lock).
//   PRECOMMIT. On a Polka a validator LOCKS the value (lockedValue/lockedRound)
//              and precommits its id; on a Polka-for-nil it precommits nil.
//              2f+1 precommits for a value at ANY round **decides** it — the
//              block is committed at height H, forever, and the height advances.
//
// A round that produces no decision (silent proposer, split votes, a partition)
// simply times out — timeouts grow with the round so that, once the network is
// synchronous (after GST), some round has a correct proposer and enough time for
// its messages to land, and the height decides. That is Tendermint's liveness.
// SAFETY (no two correct validators decide differently at a height) needs only
// the two prevote rules + 2f+1 quorum intersection and holds under FULL asynchrony.
import type { NodeId } from '../../sim/types';

/** The number of Byzantine faults an N-node cluster tolerates: f = ⌊(N-1)/3⌋. */
export const faultBudget = (n: number): number => Math.floor((n - 1) / 3);

/** Quorum / "2f+1" threshold: a value needs ≥ 2f+1 (= n − f) distinct votes to
 *  form a Polka (prevotes) or to decide (precommits). */
export const quorum = (n: number): number => 2 * faultBudget(n) + 1;

/** The proposer of round R at height H — deterministic round-robin over (H+R).
 *  Public and rotating, so one faulty proposer is skipped after a single round.
 *  Height 0 is genesis and never runs consensus. */
export const proposerOf = (all: NodeId[], height: number, round: number): NodeId =>
  all[(((height + round) % all.length) + all.length) % all.length];

/** How a faulty validator misbehaves. `honest` follows the protocol exactly. */
export type FaultMode =
  | 'honest'
  /** Sends nothing it is responsible for. A silent *proposer* proposes no value,
   *  so its round times out to a nil-prevote and the ladder climbs to the next
   *  proposer; a silent *validator* withholds all votes. Harmless while ≤ f. */
  | 'silent'
  /** PROPOSER ATTACK: proposes two *different* values in the same round on the
   *  same height, one to each half of the validators — and double-prevotes both.
   *  The canonical equivocation. Quorum intersection makes it impossible for both
   *  to gather a 2f+1 Polka, so at most one locks and no two correct validators
   *  ever decide conflicting blocks. */
  | 'equivocate'
  /** VALIDATOR ATTACK: prevotes/precommits for a corrupted value id that matches
   *  no real block, trying to manufacture a bogus Polka. Every correct validator
   *  only counts votes whose id matches a block it holds, so these never count. */
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

/** The internally-generated empty command. A Tendermint proposer with nothing
 *  pending still proposes an (empty) block to keep the height decidable. */
export const NOOP: Command = { cid: '∅', op: { op: 'noop' } };

export function opStr(cmd: Command | null | undefined): string {
  if (!cmd) return '—';
  const o = cmd.op;
  if (o.op === 'noop') return '∅';
  if (o.op === 'set') return `${o.key}=${o.value}`;
  return `del ${o.key}`;
}

// ---- the value (block) ----------------------------------------------------

/**
 * One value proposed for a height: in Tendermint terms, a block. Its `id` is a
 * content hash — a value's identity is FROZEN when it is created, so that
 * re-proposing a locked/valid value in a later round refers to the *same* value
 * (that is what makes locking meaningful across rounds). We include the creating
 * proposer + round in the hash purely so two proposers' distinct blocks (even
 * two empty ones) get distinct ids; a re-proposal keeps the stored value verbatim.
 */
export interface Block {
  /** Content-addressed id: a stable hash of (height, roundCreated, proposer, cmd). */
  hash: string;
  /** The height this block is a candidate for. */
  height: number;
  /** The round in which this value was first created (part of its frozen identity). */
  round: number;
  /** Who first created it. A re-proposer may differ from this. */
  proposer: NodeId;
  /** The command it orders (an empty block flushes nothing but keeps liveness). */
  cmd: Command;
}

/** The distinguished "nil" vote id — a prevote/precommit for *no* value. */
export const NIL = 'nil';

export const GENESIS_HASH = 'genesis';

/** Deterministic content hash of a value's frozen identity. */
export function blockHash(height: number, round: number, proposer: NodeId, cmd: Command): string {
  const op = cmd.op;
  const body = op.op === 'set' ? `s:${op.key}=${op.value}` : op.op === 'del' ? `d:${op.key}` : 'n';
  return `h${height}r${round}#${proposer}:${cmd.cid}:${body}`;
}

/** valid(v): a value is well-formed iff its stated id matches its content. A
 *  'conflict' validator's forged id fails this, so its votes are worthless. */
export function validBlock(b: Block): boolean {
  return b.hash === blockHash(b.height, b.round, b.proposer, b.cmd);
}

// ---- a decided log entry (for the UI / invariants) ------------------------

export interface CommittedEntry {
  height: number;
  round: number;
  hash: string;
  cmd: Command;
  /** How this entry was decided: a local 2f+1-precommit commit, or an f+1
   *  block-sync certificate gossiped after a partition heal / restart. */
  via: 'commit' | 'sync';
}

/** The three steps of a Tendermint round. */
export type Step = 'propose' | 'prevote' | 'precommit';

// ---- replica state --------------------------------------------------------
//
// The variables map one-to-one onto Algorithm 1 of the Tendermint paper:
//   hp height · roundp round · stepp step · lockedValue/lockedRound ·
//   validValue/validRound · decision[]  — plus the received-message logs the
//   "upon 2f+1 …" rules quantify over, and the KV state machine.

export interface TendermintState {
  // ---- identity / fault model -------------------------------------------
  fault: FaultMode;

  // ---- the consensus state machine (Algorithm 1 variables) --------------
  /** Current height under decision (genesis is decided at height 0). */
  height: number;
  /** Current round within the height. */
  round: number;
  /** Current step within the round. */
  step: Step;
  /** The value this validator is LOCKED on (null = unlocked); its round. The
   *  lock is durable — a crash must never let a validator unlock and equivocate. */
  lockedValue: Block | null;
  lockedRound: number;
  /** The latest value this validator saw get a Polka, and the round it did — what
   *  an honest proposer re-proposes, tagged with `validRound`. */
  validValue: Block | null;
  validRound: number;

  // ---- received messages for the CURRENT height (round-scoped) ----------
  /** round → the proposal this validator accepted for that round (from the
   *  legitimate proposer). Stored as {block, validRound}. */
  proposals: Record<number, { block: Block; validRound: number }>;
  /** round → value id → set of validators seen prevoting it (the Polka tally). */
  prevotes: Record<number, Record<string, Record<NodeId, true>>>;
  /** round → value id → set of validators seen precommitting it. */
  precommits: Record<number, Record<string, Record<NodeId, true>>>;
  /** round → set of validators that sent ANY consensus message for it — powers
   *  the "f+1 messages from a higher round" catch-up rule. */
  roundSenders: Record<number, Record<NodeId, true>>;
  /** id → value body, learned from any proposal or vote (only well-formed ones).
   *  Lets us recognise a value we have 2f+1 precommits for even if we never got
   *  its formal proposal. Includes the genesis block. */
  blocks: Record<string, Block>;

  /** Guards for the "for the first time" upon-rules (per round of this height). */
  proposeEntered: Record<number, true>;
  timeoutPrevoteArmed: Record<number, true>;
  timeoutPrecommitArmed: Record<number, true>;
  lockFired: Record<number, true>;

  // ---- finality + the replicated state machine (durable) ----------------
  /** height → the decided block. Irrevocable. */
  decision: Record<number, Block>;
  /** Highest contiguously-executed decided height. */
  decidedHeight: number;
  /** The replicated key/value store: decided commands replayed in order. */
  kv: Record<string, string>;
  /** A flat decided log for the UI / invariants. */
  committed: CommittedEntry[];
  /** cid → true once executed (so a command is applied at most once). */
  executedCid: Record<string, true>;
  /** height → hash → set of validators that reported deciding it (block-sync). */
  sync: Record<number, Record<string, Record<NodeId, true>>>;

  // ---- request intake ---------------------------------------------------
  /** Client commands accepted but not yet decided. */
  pending: Command[];

  // ---- UI annotation ----------------------------------------------------
  note: string;
}

export interface TendermintConfig {
  /** Base propose-step timeout (ms). Grows by `timeoutDelta` per round. */
  timeoutPropose: number;
  /** Base prevote-step timeout (ms). */
  timeoutPrevote: number;
  /** Base precommit-step timeout (ms). */
  timeoutPrecommit: number;
  /** Per-round linear increase added to every step timeout (partial synchrony). */
  timeoutDelta: number;
  /** How often a validator gossips its decided watermark (drives block-sync). */
  syncPeriod: number;
}

export const DEFAULT_TENDERMINT_CONFIG: TendermintConfig = {
  timeoutPropose: 500,
  timeoutPrevote: 500,
  timeoutPrecommit: 500,
  timeoutDelta: 250,
  syncPeriod: 320,
};

// ---- message payloads -----------------------------------------------------

/** Client → all validators (multicast so whichever validator leads a round can
 *  pick the request up from its mempool). */
export interface RequestMsg {
  command: Command;
}

/** Proposer → all: "here is round R's value" (validRound = -1 for a fresh value,
 *  ≥ 0 when re-proposing a value that became valid in that earlier round). */
export interface ProposalMsg {
  height: number;
  round: number;
  block: Block;
  validRound: number;
}

/** Any validator → all: a prevote for a value id (or NIL) at (height, round). */
export interface PrevoteMsg {
  height: number;
  round: number;
  id: string;
  block?: Block; // body rides along so a peer that missed the proposal can learn it
  from: NodeId;
}

/** Any validator → all: a precommit for a value id (or NIL) at (height, round). */
export interface PrecommitMsg {
  height: number;
  round: number;
  id: string;
  block?: Block;
  from: NodeId;
}

/** Periodic gossip of how far a validator has decided (drives block-sync). */
export interface StatusMsg {
  from: NodeId;
  decidedHeight: number;
}

/** A reply shipping decided blocks a lagging peer is missing. */
export interface SyncMsg {
  from: NodeId;
  entries: Block[];
}

export type TendermintCmd =
  | { type: 'request'; command: Command }
  | { type: 'set-fault'; mode: FaultMode };
