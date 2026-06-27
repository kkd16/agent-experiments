// Types for the Snow* lab — metastable consensus by repeated random subsampling.
//
// The Snow family (Team Rocket, "Snowflake to Avalanche", 2018 — the consensus
// engine behind the Avalanche blockchain) is the odd one out among the protocols
// here. Raft, Paxos, EPaxos, PBFT and HotStuff all agree through **intersecting
// majority quorums**; ABD does atomic storage the same way; Dynamo trades
// agreement for availability. Snow* agrees a *completely different way* — and
// reaches only **probabilistic** safety, not the absolute safety the quorum
// protocols prove:
//
//   Every round, a node asks a small **random sample of `k` peers** for their
//   current opinion (a colour). If at least `α` of them (with α > k/2) name one
//   colour, that round "succeeds" for that colour. A node adopts a colour it sees
//   win, builds **confidence**, and **finalises** once it has seen `β` successful
//   rounds in a row. No quorum, no leader, no global view — yet a near-even split
//   **tips** to network-wide agreement, quickly and irreversibly. The system is
//   the textbook example of a **metastable** consensus.
//
// Three nested protocols, each adding exactly one mechanism over the last:
//   • Slush     — memoryless: for a fixed number of rounds, adopt any colour ≥ α.
//                 No finality. Shows the raw tipping dynamic.
//   • Snowflake — + a single confidence counter `cnt`; decide at `cnt ≥ β`.
//   • Snowball  — + per-colour confidence `d[·]`; the preference tracks argmax d,
//                 so transient noise can't flip a well-supported colour. The
//                 robust, Byzantine-tolerant variant Avalanche actually ships.
import type { NodeId } from '../../sim/types';

/** A colour is the value being agreed on. ⊥ (`null`) = no opinion yet. */
export type Colour = string;
export const NO_COLOUR = null;

/** The Snow variants, in increasing sophistication. */
export type Variant = 'slush' | 'snowflake' | 'snowball';

export interface SnowConfig {
  /** Sample size per round. */
  k: number;
  /** Quorum threshold within a sample; must satisfy α > k/2 for single-colour wins. */
  alpha: number;
  /** Consecutive successful rounds required to finalise (Snowflake/Snowball). */
  beta: number;
  /** Snow variant in force. */
  variant: Variant;
  /** Number of distinct colours in play (2 = the canonical binary demo). */
  colours: number;
  /** Slush only: total rounds to run before freezing (it never truly finalises). */
  slushRounds: number;
  /** Delay between a node's rounds (ms). */
  roundDelay: number;
  /** If a round's responses don't all arrive within this long, process what we have. */
  roundTimeout: number;
  /** Cap on each node's retained colour-change trail (for the over-time chart). */
  trailCap: number;
}

export const COLOURS: Colour[] = ['R', 'B', 'G'];

export const DEFAULT_SNOW_CONFIG: SnowConfig = {
  k: 6,
  alpha: 4,
  beta: 5,
  variant: 'snowball',
  colours: 2,
  slushRounds: 20,
  roundDelay: 60,
  roundTimeout: 320,
  trailCap: 200,
};

/** One entry in a node's opinion trail: it preferred `colour` from time `t`. */
export interface TrailPoint {
  t: number;
  colour: Colour | null;
}

/** A query round this node is currently running. */
export interface RoundRec {
  /** Round id (monotonic per node). */
  round: number;
  /** The peers sampled this round. */
  sampled: NodeId[];
  /** Responses received so far: peer → the colour it reported. */
  responses: Record<NodeId, Colour | null>;
}

export interface SnowState {
  self: NodeId;
  /** The node's current preferred colour (⊥ until it adopts one). */
  pref: Colour | null;
  /** The last colour that cleared the α threshold (drives the consecutive streak). */
  last: Colour | null;
  /** Consecutive-success counter (Snowflake/Snowball). */
  cnt: number;
  /** Per-colour accumulated confidence (Snowball). */
  d: Record<Colour, number>;
  /** The finalised colour, once `cnt ≥ β` (or ⊥ while still deciding). */
  decided: Colour | null;
  /** Monotonic round counter. */
  round: number;
  /** The in-flight round, if any. */
  active: RoundRec | null;
  /** How many query rounds this node has completed. */
  roundsDone: number;
  /** Whether this node's round loop is active (it has an opinion or was woken). */
  running: boolean;
  /** Slush: rounds remaining before it freezes. */
  slushLeft: number;
  /** A Byzantine node ignores the protocol and always answers `adversary`. */
  byzantine: boolean;
  /** The colour a Byzantine node reports (to try to stall honest convergence). */
  adversary: Colour | null;
  /** Capped opinion trail for the network-opinion-over-time chart. */
  trail: TrailPoint[];
  note: string;
}

// ---- message payloads -----------------------------------------------------

/** "What colour do you prefer?" — carries the querier's own colour (Slush bootstrap). */
export interface QueryMsg {
  round: number;
  /** The querier's current colour, used to colour an uncoloured responder. */
  colour: Colour | null;
}

/** The responder's current colour. */
export interface RespMsg {
  round: number;
  colour: Colour | null;
  from: NodeId;
}

// ---- client commands ------------------------------------------------------

export type SnowCmd =
  /** Seed a node's initial colour (an injected "transaction"). */
  | { type: 'seed'; colour: Colour }
  /** Make a node Byzantine (or honest again), answering `adversary` when lying. */
  | { type: 'byzantine'; on: boolean; adversary?: Colour }
  /** Kick a node into running rounds even if it has no opinion yet. */
  | { type: 'wake' };

/** A short human label for a colour (⊥ for none). */
export function colourStr(c: Colour | null): string {
  return c == null ? '⊥' : c;
}

/** The display name for a variant. */
export function variantName(v: Variant): string {
  return v === 'slush' ? 'Slush' : v === 'snowflake' ? 'Snowflake' : 'Snowball';
}
