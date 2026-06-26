// Core types shared by the kernel and every protocol.
import type { Rng } from './prng';

export type NodeId = string;

/** A message in flight between two nodes. Plain data so it can be snapshotted. */
export interface Message<P = unknown> {
  id: number;
  from: NodeId;
  to: NodeId;
  type: string;
  payload: P;
  sentAt: number;
  deliverAt: number;
}

/** A line in the structured event log shown in the timeline panel. */
export interface LogEntry {
  time: number;
  seq: number;
  node: NodeId;
  /** Coarse category, used for colour-coding: send/recv/timer/state/commit/info/drop/crash. */
  kind: string;
  text: string;
}

export interface InvariantResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * The capabilities a protocol handler has while running. Handlers mutate their
 * node `state` in place and emit effects through this context; the kernel turns
 * those into scheduled events.
 */
export interface NodeContext {
  /** This node's id. */
  self: NodeId;
  /** Every other node id in the cluster. */
  peers: NodeId[];
  /** All node ids including self. */
  all: NodeId[];
  /** Current virtual time (ms). */
  now: number;
  /** The one deterministic RNG (use it for *all* randomness). */
  rng: Rng;
  /** Send a message; the kernel applies network latency / drops / partitions. */
  send(to: NodeId, type: string, payload: unknown): void;
  /** Send the same message type to every peer. */
  broadcast(type: string, makePayload: (peer: NodeId) => unknown): void;
  /** (Re)arm a named timer to fire after `delay` ms; arming again cancels the old one. */
  setTimer(name: string, delay: number): void;
  /** Cancel a named timer if pending. */
  clearTimer(name: string): void;
  /** Append a line to the event log. */
  log(kind: string, text: string): void;
}

/**
 * A distributed protocol: how one node initializes, reacts to messages, timers
 * and client commands, recovers from a crash, and what global invariants its
 * cluster must satisfy. Every lab is an implementation of this interface.
 */
export interface Protocol<S, Cmd = unknown> {
  name: string;
  /** Build a fresh node; use ctx to arm initial timers. */
  init(ctx: NodeContext): S;
  onMessage(ctx: NodeContext, state: S, msg: Message): void;
  onTimer(ctx: NodeContext, state: S, name: string): void;
  /** Route an external client command to a node (the kernel picks the target). */
  onCommand?(ctx: NodeContext, state: S, cmd: Cmd): void;
  /** Reset volatile state after a restart (persistent state survives a crash). */
  onRestart?(ctx: NodeContext, state: S): void;
  /** Cluster-wide safety/consistency checks evaluated on every render. */
  invariants?(nodes: ReadonlyArray<NodeView<S>>): InvariantResult[];
}

/** A read-only view of one node, handed to invariant checkers and the UI. */
export interface NodeView<S> {
  id: NodeId;
  up: boolean;
  state: S;
}

/** Internal scheduled events (serializable — no closures). */
export type SimEvent =
  | { kind: 'deliver'; time: number; seq: number; message: Message }
  | { kind: 'timer'; time: number; seq: number; node: NodeId; name: string; gen: number };

export interface NodeRuntime<S> {
  id: NodeId;
  state: S;
  up: boolean;
  timers: Record<string, { fireAt: number; gen: number }>;
}

/** Everything needed to render the simulator and to restore it for time travel. */
export interface SimSnapshot<S> {
  time: number;
  step: number;
  nodes: NodeRuntime<S>[];
  inFlight: Message[];
  log: LogEntry[];
  blockedLinks: string[];
  metrics: SimMetrics;
}

export interface SimMetrics {
  messagesSent: number;
  messagesDelivered: number;
  messagesDropped: number;
  timersFired: number;
  steps: number;
}
