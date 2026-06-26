// A CRDT replica protocol: every node holds a replica of one CRDT and runs
// anti-entropy — it eagerly pushes its state to peers on a local edit and, on a
// timer, gossips its state to a random peer to repair after partitions. Because
// the CRDT merge is commutative/idempotent, the replicas converge no matter how
// the network reorders, drops or delays the sync messages.
import type { InvariantResult, NodeView, Protocol } from '../../sim/types';
import { CRDT_SPECS, type CrdtKind, type CrdtOp, type CrdtSpec } from './crdts';

export interface CrdtNodeState {
  kind: CrdtKind;
  data: unknown;
  lamport: number;
}

interface SyncPayload {
  data: unknown;
  lamport: number;
}

export interface CrdtConfig {
  gossipInterval: number;
}

export function createCrdtProtocol(
  kind: CrdtKind,
  config: CrdtConfig = { gossipInterval: 220 },
): Protocol<CrdtNodeState, CrdtOp> {
  const spec = CRDT_SPECS[kind];
  const clockOf = (s: CrdtNodeState) => () => {
    s.lamport += 1;
    return s.lamport;
  };

  return {
    name: `CRDT:${kind}`,

    init(ctx) {
      ctx.setTimer('gossip', ctx.rng.int(config.gossipInterval, config.gossipInterval * 2));
      return { kind, data: spec.init(), lamport: 0 };
    },

    onRestart(ctx) {
      ctx.setTimer('gossip', ctx.rng.int(config.gossipInterval, config.gossipInterval * 2));
    },

    onCommand(ctx, s, op) {
      spec.apply(s.data, op, ctx.self, clockOf(s));
      ctx.log('state', `${op.id}${op.arg !== undefined ? ` ${op.arg}` : ''} → ${spec.value(s.data)}`);
      ctx.broadcast('sync', () => ({ data: structuredClone(s.data), lamport: s.lamport }) as SyncPayload);
    },

    onTimer(ctx, s, name) {
      if (name !== 'gossip') return;
      const peer = ctx.rng.pick(ctx.peers);
      if (peer) ctx.send(peer, 'sync', { data: structuredClone(s.data), lamport: s.lamport } as SyncPayload);
      ctx.setTimer('gossip', ctx.rng.int(config.gossipInterval, config.gossipInterval * 2));
    },

    onMessage(ctx, s, msg) {
      if (msg.type !== 'sync') return;
      const p = msg.payload as SyncPayload;
      const before = spec.value(s.data);
      s.data = spec.merge(s.data, p.data);
      s.lamport = Math.max(s.lamport, p.lamport);
      const after = spec.value(s.data);
      if (before !== after) ctx.log('recv', `merged ← ${msg.from}: ${after}`);
    },

    invariants(nodes: ReadonlyArray<NodeView<CrdtNodeState>>): InvariantResult[] {
      const up = nodes.filter((n) => n.up);
      const values = up.map((n) => spec.value(n.state.data));
      const allEqual = values.every((v) => v === values[0]);
      return [
        {
          name: 'Strong eventual consistency',
          ok: allEqual,
          detail: allEqual
            ? `all ${up.length} replicas agree: ${values[0] ?? '—'}`
            : 'replicas differ — they converge once sync messages drain',
        },
      ];
    },
  };
}

export function crdtSpec(kind: CrdtKind): CrdtSpec<unknown> {
  return CRDT_SPECS[kind];
}
