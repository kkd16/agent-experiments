// Types + pure helpers for the Nakamoto lab — proof-of-work longest-chain
// consensus, the engine behind Bitcoin and the most famous distributed protocol
// in the world.
//
// Every other consensus lab here reaches agreement through **intersecting
// majority quorums** (Raft, Paxos, PBFT, HotStuff…) or **random subsampling**
// (Snow). Nakamoto agrees a completely different way and is the odd one out:
//
//   • There is no quorum, no leader election, no fixed membership, and no vote.
//   • Miners race to extend the chain; finding a block is a memoryless
//     **Poisson process** whose rate is a node's share of total hash power.
//   • Every node independently adopts the **heaviest chain it has seen** (here,
//     with constant difficulty, simply the longest). Two blocks found at nearly
//     the same time **fork** the chain; the fork resolves the moment one branch
//     out-races the other, and the losing branch's blocks become **orphans**.
//   • Safety is **probabilistic and eventual**: a block sinks deeper and deeper
//     as the chain grows on top of it, and the probability it is ever reverted
//     falls off exponentially with that depth — but it is never *zero*. An
//     adversary with a **majority of the hash power** can privately out-mine the
//     honest chain and release a longer one, reverting an already-"confirmed"
//     payment: the canonical **51% double-spend attack**.
//
// The ledger below is a tiny account model (balance + nonce) so a real
// double-spend can be staged and *watched*: the attacker pays a merchant on the
// public chain, the merchant waits `k` confirmations and ships, and then the
// attacker's secret longer chain — which pays the money to herself instead —
// reorgs the public one and the merchant is robbed.
import type { NodeId } from '../../sim/types';

export type { NodeId };

/** An account in the toy ledger. Miners (node ids) are *not* accounts — their
 *  block reward is minted separately (see {@link ledgerOf}). */
export type Account = string;

/** The user accounts that transact on the chain. */
export const USERS: Account[] = ['alice', 'bob', 'mallory', 'merchant', 'mallory2'];

/** Opening balances. The total across user accounts is conserved forever — only
 *  the (separately-tracked) coinbase reward ever mints new coins. */
export const INITIAL_BALANCE: Record<Account, number> = {
  alice: 60,
  bob: 60,
  mallory: 100,
  merchant: 0,
  mallory2: 0,
};

/** Sum of all opening user balances — the conservation invariant's target. */
export const USER_TOTAL = Object.values(INITIAL_BALANCE).reduce((a, b) => a + b, 0);

/** Coins minted to the miner of each (non-genesis) block. */
export const REWARD = 25;

/** A transaction: move `amount` from → to, valid only at the sender's `nonce`. */
export interface Tx {
  id: string;
  from: Account;
  to: Account;
  amount: number;
  /** The sender's account nonce this tx spends — two txs sharing a nonce are a
   *  double-spend; at most one can ever land in a single chain. */
  nonce: number;
  /** Optional human label surfaced in the UI (e.g. "pay merchant"). */
  tag?: string;
}

/** A block: a batch of txs linked to its parent by hash. With constant
 *  difficulty the chain's "weight" is just its height, so heaviest = longest. */
export interface Block {
  hash: string;
  parent: string;
  height: number;
  /** The node that mined it (the coinbase recipient); '' for genesis. */
  miner: NodeId;
  txs: Tx[];
  /** A cosmetic proof-of-work nonce (no real hashing — this is a simulator). */
  nonce: number;
  createdAt: number;
}

/** The one shared genesis block every node starts from. */
export const GENESIS: Block = { hash: 'genesis', parent: '', height: 0, miner: '', txs: [], nonce: 0, createdAt: 0 };

export interface AcctState {
  balance: number;
  nonce: number;
}
export type Ledger = Record<Account, AcctState>;

export function initialLedger(): Ledger {
  const l: Ledger = {};
  for (const a of USERS) l[a] = { balance: INITIAL_BALANCE[a] ?? 0, nonce: 0 };
  return l;
}

/** Whether `tx` is valid against ledger `l` (does not mutate). */
export function txValid(l: Ledger, tx: Tx): boolean {
  if (tx.amount <= 0) return false;
  if (tx.from === tx.to) return false;
  const from = l[tx.from];
  const to = l[tx.to];
  if (!from || !to) return false;
  if (tx.nonce !== from.nonce) return false;
  return from.balance >= tx.amount;
}

/** Apply `tx` to `l` in place if valid; return whether it was applied. */
export function applyTx(l: Ledger, tx: Tx): boolean {
  if (!txValid(l, tx)) return false;
  l[tx.from].balance -= tx.amount;
  l[tx.to].balance += tx.amount;
  l[tx.from].nonce += 1;
  return true;
}

/** The canonical chain from genesis up to `tip` (inclusive), or [] if `tip` is
 *  not connected to genesis in `blocks`. */
export function chainOf(blocks: Record<string, Block>, tip: string): Block[] {
  const out: Block[] = [];
  let cur: Block | undefined = blocks[tip] ?? (tip === 'genesis' ? GENESIS : undefined);
  let guard = 0;
  while (cur && guard++ < 1_000_000) {
    out.push(cur);
    if (cur.hash === 'genesis' || cur.parent === '') break;
    cur = blocks[cur.parent] ?? (cur.parent === 'genesis' ? GENESIS : undefined);
  }
  if (!out.length || out[out.length - 1].hash !== 'genesis') return [];
  out.reverse();
  return out;
}

/** Fold a chain into its ledger, returning the user ledger and the coins minted
 *  as block rewards along the way. Assumes the chain's blocks are valid. */
export function ledgerOf(blocks: Record<string, Block>, tip: string): { ledger: Ledger; minted: number } {
  const l = initialLedger();
  let minted = 0;
  const chain = chainOf(blocks, tip);
  for (const b of chain) {
    if (b.hash === 'genesis') continue;
    if (b.miner) minted += REWARD;
    for (const tx of b.txs) applyTx(l, tx);
  }
  return { ledger: l, minted };
}

/** Whether every tx of `block` applies cleanly, in order, against its parent's
 *  ledger (the block-validity rule — no in-chain double-spends). */
export function blockTxsValid(blocks: Record<string, Block>, block: Block): boolean {
  const { ledger } = ledgerOf(blocks, block.parent);
  for (const tx of block.txs) {
    if (!applyTx(ledger, tx)) return false;
  }
  return true;
}

/** Greedily pick up to `max` mempool txs that apply in sequence against
 *  `ledger` (advancing a copy as it goes, so nonces from one sender chain). */
export function selectTxs(mempool: Tx[], ledger: Ledger, max: number): Tx[] {
  const work: Ledger = {};
  for (const a of Object.keys(ledger)) work[a] = { ...ledger[a] };
  const out: Tx[] = [];
  for (const tx of mempool) {
    if (out.length >= max) break;
    if (applyTx(work, tx)) out.push(tx);
  }
  return out;
}

// ---- configuration --------------------------------------------------------

export interface NakConfig {
  /** Mean time (ms) for a power-1 miner to find a block. A node of power p finds
   *  blocks at mean interval `baseBlockMs / p`; the network's aggregate rate is
   *  the sum over all mining nodes, so more (or stronger) miners ⇒ faster blocks. */
  baseBlockMs: number;
  /** Maximum txs a miner packs into one block. */
  blockTxs: number;
  /** Confirmation depth: a block `k` deep below the tip is treated as final.
   *  Reverting a `k`-deep block is the safety failure the 51% attack causes. */
  k: number;
}

export const DEFAULT_NAK_CONFIG: NakConfig = {
  baseBlockMs: 2600,
  blockTxs: 3,
  k: 4,
};

// ---- per-node state -------------------------------------------------------

export interface NakState {
  self: NodeId;
  /** Every block connected to genesis that this node knows (its public store). */
  blocks: Record<string, Block>;
  /** The head of the heaviest chain this node has adopted. */
  tip: string;
  /** Blocks received whose parent isn't known yet, buffered until it arrives. */
  orphans: Record<string, Block>;
  /** Parent hashes we've already asked a peer for (so we ask once). */
  requested: Record<string, boolean>;
  /** An attacker's secretly-mined blocks, withheld from the network. */
  hidden: Record<string, Block>;
  /** The head of the attacker's private chain ('' until the first secret block). */
  privateTip: string;
  /** Pending transactions not yet mined into this node's chain. */
  mempool: Tx[];
  /** The conflicting tx an attacker mines privately (its half of a double-spend). */
  attackTx: Tx | null;
  /** Monotonic per-node counter that makes this node's block hashes unique. */
  seq: number;
  /** Relative hash power (mean block rate ∝ power). */
  power: number;
  /** Whether this node mines at all. */
  mining: boolean;
  /** A withholding (selfish/51%) miner: mines a private chain, releases on cue. */
  attacker: boolean;
  /** height → hash, recorded once a height is k-deep (finalised on this node). */
  finalized: Record<number, string>;
  /** Set true the instant a finalised (k-deep) block is ever replaced by a reorg. */
  reverted: boolean;
  revertedNote: string;
  /** How many blocks this node has mined (public + released). */
  blocksMined: number;
  note: string;
}

// ---- messages -------------------------------------------------------------

/** "Here is a block" — the gossip payload that floods the network. */
export interface BlockMsg {
  block: Block;
}
/** "I'm missing this ancestor, please send it." */
export interface GetBlockMsg {
  hash: string;
}

// ---- client commands ------------------------------------------------------

export type NakCmd =
  | { type: 'submitTx'; tx: Tx }
  | { type: 'setMining'; on: boolean }
  | { type: 'setAttacker'; on: boolean }
  | { type: 'setPower'; power: number }
  | { type: 'setAttackTx'; tx: Tx | null }
  | { type: 'release' }
  | { type: 'mineNow' };

// ---- small display helpers ------------------------------------------------

export function txStr(tx: Tx): string {
  return `${tx.from}→${tx.to} ${tx.amount}`;
}

/** A short hash label for the UI (miner + seq is already short, but genesis and
 *  long ids get trimmed). */
export function shortHash(h: string): string {
  if (h === 'genesis') return '⊥';
  return h.length > 8 ? h.slice(0, 8) : h;
}

/** The height of a hash within `blocks` (−1 if unknown; 0 for genesis). */
export function heightOf(blocks: Record<string, Block>, hash: string): number {
  if (hash === 'genesis') return 0;
  return blocks[hash]?.height ?? -1;
}
