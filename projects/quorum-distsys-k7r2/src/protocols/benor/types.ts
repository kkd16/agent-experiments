import type { NodeId } from '../../sim/types';

// Ben-Or's randomized asynchronous consensus (Michael Ben-Or, 1983 — "Another
// advantage of free choice").
//
// The FLP impossibility (1985) proves no *deterministic* protocol can guarantee
// consensus in an asynchronous system where even one process may crash. Ben-Or's
// answer: let processes flip coins. This is the crash-fault (fail-stop) version,
// which needs N > 2f. It agrees on a single bit with NO leader, NO stable storage
// and NO synchrony assumption — safety (Agreement + Validity) is deterministic and
// unconditional; only *termination* is probabilistic (it happens with probability
// 1, in expectation within a handful of rounds for a non-adversarial network).
//
// Each asynchronous round has two message phases:
//   Phase 1 (Report):  broadcast (1, r, x). Collect N−f. If > N/2 carry the same
//                      value v, the proposal is v, else ⊥. (> N/2 of the sample ⇒
//                      a global majority ⇒ at most one value is ever proposed.)
//   Phase 2 (Propose): broadcast (2, r, proposal). Collect N−f.
//                      • ≥ f+1 carry the same v ≠ ⊥  →  DECIDE v.
//                      • ≥ 1 carries some v ≠ ⊥       →  adopt x ← v.
//                      • all ⊥                        →  x ← coin flip.

export type Bit = 0 | 1;
/** ⊥ (no proposal) is encoded as -1 on the wire so payloads stay plain JSON. */
export type Proposal = Bit | -1;

/**
 * Ben-Or is fully self-driving from its initial inputs (which are passed to the
 * protocol factory), so it exposes no client commands. This placeholder keeps the
 * kernel's command generic well-typed.
 */
export type BenOrCommand = { type: 'noop' };

export interface BenOrState {
  /** This node's index into the (fixed) configuration. */
  configuration: NodeId[];
  replicaNumber: number;

  input: Bit; // the initial preference (for Validity)
  round: number; // current asynchronous round (1-based)
  estimate: Bit; // x — the current preferred value
  decided: Bit | null; // the decided value, or null if still undecided
  decidedRound: number | null;
  started: boolean; // whether this node has begun round 1

  /** Buffered phase-1 reports: round → (replicaNumber → bit). */
  reports: Record<string, Record<string, Bit>>;
  /** Buffered phase-2 proposals: round → (replicaNumber → proposal). */
  proposals: Record<string, Record<string, Proposal>>;
  /** Rounds for which we have already broadcast our phase-2 proposal. */
  proposed: Record<string, boolean>;
  /** Rounds for which we have already completed phase 2 and advanced. */
  advanced: Record<string, boolean>;

  /** UI: how the last coin came up (per round), and the last proposal we sent. */
  lastCoin: Bit | null;
  lastProposal: Proposal;
}

export interface BenOrConfig {
  /** A retry nudge so a node re-broadcasts its current phase if messages were lost. */
  retryMs: number;
}

export const DEFAULT_BENOR_CONFIG: BenOrConfig = { retryMs: 300 };

// --- message payloads ---

export interface Report {
  round: number;
  value: Bit;
  from: number;
}
export interface Propose {
  round: number;
  value: Proposal;
  from: number;
}

// --- helpers ---

/** N = 2f+1 ⇒ f crash faults tolerated; a phase waits for N−f messages. */
export const faultBudget = (n: number): number => Math.floor((n - 1) / 2);
export const waitFor = (n: number): number => n - faultBudget(n);

export const PROP_BOT: Proposal = -1;
export const propLabel = (p: Proposal): string => (p === -1 ? '⊥' : String(p));
