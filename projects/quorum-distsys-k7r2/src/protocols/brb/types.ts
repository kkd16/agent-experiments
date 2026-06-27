// Types for the Bracha reliable-broadcast lab — the foundational Byzantine
// broadcast primitive.
//
// PBFT and HotStuff replicate a *log* of commands. Underneath every such system
// sits a humbler, deeper primitive: **reliable broadcast** — one sender wants to
// deliver one message to everyone such that, even if the sender is a traitor that
// tells different nodes different things (it **equivocates**), the correct nodes
// still agree on a single outcome: either they all deliver the same value, or none
// delivers at all. Bracha's 1987 asynchronous algorithm does exactly this with
// N ≥ 3f+1 and two rounds of all-to-all amplification:
//
//   • SEND  — the sender sends the value to everyone (a traitor may equivocate).
//   • ECHO  — on the sender's value, each node echoes it. On **> (N+f)/2** echoes
//             of one value, a node is convinced enough of *that* value to go READY.
//   • READY — on **f+1** readies (proof one correct node went ready) a node also
//             goes ready (amplification); on **2f+1** readies it **delivers**.
//
// The echo quorum > (N+f)/2 is the crux: two different values can't both gather
// it, so correct nodes can never be split — Agreement holds even against an
// equivocating sender and f Byzantine echoers. Push the traitors past f and watch
// it break.
import type { NodeId } from '../../sim/types';

/** Largest number of Byzantine nodes tolerated: f = ⌊(N-1)/3⌋. */
export const faultBudget = (n: number): number => Math.floor((n - 1) / 3);
/** Echo quorum: strictly more than (N+f)/2. */
export const echoQuorum = (n: number, f: number): number => Math.floor((n + f) / 2) + 1;
/** Readies needed to amplify (one correct node is provably ready). */
export const readyAmplify = (f: number): number => f + 1;
/** Readies needed to deliver. */
export const readyDeliver = (f: number): number => 2 * f + 1;

export type Value = string;

export interface BrbConfig {
  /** The two values a traitor will try to split the cluster between. */
  values: [Value, Value];
}

export const DEFAULT_BRB_CONFIG: BrbConfig = { values: ['A', 'B'] };

export interface BrbState {
  self: NodeId;
  /** The designated broadcaster. */
  sender: NodeId;
  /** True if this node is a traitor (it may equivocate / fabricate). */
  byzantine: boolean;
  /** A Byzantine node acts (equivocates) once it has seen the instance start. */
  byzActed: boolean;

  /** The value this node ECHOed (null until it does), and whether it has. */
  echoSent: Value | null;
  /** The value this node went READY on (null until it does). */
  readySent: Value | null;
  /** The delivered value (null until 2f+1 readies). */
  delivered: Value | null;
  /** Whether this node has accepted a SEND from the sender already. */
  sawSend: boolean;

  /** Distinct senders of ECHO(value): value → node ids. */
  echoes: Record<Value, NodeId[]>;
  /** Distinct senders of READY(value): value → node ids. */
  readies: Record<Value, NodeId[]>;

  note: string;
}

// ---- message payloads -----------------------------------------------------

export interface BrbMsg {
  value: Value;
}

// ---- client commands ------------------------------------------------------

export type BrbCmd =
  /** Tell the sender to broadcast this value (honest sender → same to all). */
  | { type: 'broadcast'; value: Value }
  /** Make a node Byzantine (or honest again). */
  | { type: 'byzantine'; on: boolean };
