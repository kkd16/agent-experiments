// Vector clocks — the classic mechanism for capturing causality (Lamport's
// happened-before) in a distributed system. Each node keeps a vector of
// per-node counters: it bumps its own on every local event, stamps outgoing
// messages with its vector, and on receipt takes the component-wise max before
// bumping its own. Two events are causally ordered iff one vector dominates the
// other; otherwise they are concurrent.
import type { NodeId, Protocol } from '../../sim/types';

export type Vec = Record<NodeId, number>;

export interface VcEvent {
  id: string; // `${node}:${ownCount}` — globally unique
  node: NodeId;
  kind: 'internal' | 'send' | 'recv';
  vc: Vec;
  t: number;
  peer?: NodeId;
  srcId?: string; // for recv: the id of the matching send event
}

export interface VcState {
  vc: Vec;
  events: VcEvent[];
}

export type VcCmd = { type: 'internal' } | { type: 'send'; to: NodeId };

interface VcMsg {
  vc: Vec;
  srcId: string;
}

export interface VcConfig {
  tick: number;
  pInternal: number;
}

const DEFAULT: VcConfig = { tick: 360, pInternal: 0.4 };

function bump(vc: Vec, self: NodeId): void {
  vc[self] = (vc[self] ?? 0) + 1;
}

function record(s: VcState, ev: Omit<VcEvent, 'id' | 'vc'> & { self: NodeId }): VcEvent {
  const { self, ...rest } = ev;
  const e: VcEvent = { id: `${self}:${s.vc[self]}`, vc: { ...s.vc }, ...rest };
  s.events.push(e);
  return e;
}

export function createVClock(config: VcConfig = DEFAULT): Protocol<VcState, VcCmd> {
  const doSend = (
    ctx: { self: NodeId; now: number; send: (to: NodeId, t: string, p: unknown) => void },
    s: VcState,
    to: NodeId,
  ) => {
    bump(s.vc, ctx.self);
    const e = record(s, { self: ctx.self, node: ctx.self, kind: 'send', t: ctx.now, peer: to });
    ctx.send(to, 'msg', { vc: { ...s.vc }, srcId: e.id } as VcMsg);
  };

  return {
    name: 'VectorClock',

    init(ctx) {
      const vc: Vec = {};
      for (const id of ctx.all) vc[id] = 0;
      ctx.setTimer('tick', ctx.rng.int(config.tick / 2, config.tick));
      return { vc, events: [] };
    },

    onRestart(ctx) {
      ctx.setTimer('tick', config.tick);
    },

    onCommand(ctx, s, cmd) {
      if (cmd.type === 'internal') {
        bump(s.vc, ctx.self);
        record(s, { self: ctx.self, node: ctx.self, kind: 'internal', t: ctx.now });
        ctx.log('state', `internal event ${ctx.self}:${s.vc[ctx.self]}`);
      } else {
        doSend(ctx, s, cmd.to);
        ctx.log('send', `message → ${cmd.to}`);
      }
    },

    onTimer(ctx, s, name) {
      if (name !== 'tick') return;
      if (ctx.rng.chance(config.pInternal)) {
        bump(s.vc, ctx.self);
        record(s, { self: ctx.self, node: ctx.self, kind: 'internal', t: ctx.now });
      } else {
        const to = ctx.rng.pick(ctx.peers);
        if (to) doSend(ctx, s, to);
      }
      ctx.setTimer('tick', ctx.rng.int(config.tick / 2, config.tick));
    },

    onMessage(ctx, s, msg) {
      if (msg.type !== 'msg') return;
      const p = msg.payload as VcMsg;
      for (const k of Object.keys(p.vc)) s.vc[k] = Math.max(s.vc[k] ?? 0, p.vc[k]);
      bump(s.vc, ctx.self);
      record(s, { self: ctx.self, node: ctx.self, kind: 'recv', t: ctx.now, peer: msg.from, srcId: p.srcId });
    },

    invariants(nodes) {
      const all: VcEvent[] = nodes.flatMap((n) => n.state.events);
      const byId = new Map(all.map((e) => [e.id, e]));
      let bad = '';
      for (const e of all) {
        if (e.kind === 'recv' && e.srcId) {
          const src = byId.get(e.srcId);
          if (src && !dominatesOrEqual(e.vc, src.vc)) bad = `recv ${e.id} does not causally follow its send`;
        }
      }
      return [
        {
          name: 'Causal delivery',
          ok: !bad,
          detail: bad || 'every receive vector dominates the vector of its send',
        },
      ];
    },
  };
}

/** a ≥ b component-wise. */
export function dominatesOrEqual(a: Vec, b: Vec): boolean {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((a[k] ?? 0) < (b[k] ?? 0)) return false;
  }
  return true;
}

export type Relation = 'before' | 'after' | 'concurrent' | 'same';

export function relate(a: Vec, b: Vec): Relation {
  const ab = dominatesOrEqual(b, a); // a <= b  -> a before b
  const ba = dominatesOrEqual(a, b); // b <= a  -> a after b
  if (ab && ba) return 'same';
  if (ab) return 'before';
  if (ba) return 'after';
  return 'concurrent';
}

export function fmtVec(vc: Vec, order: NodeId[]): string {
  return `[${order.map((id) => vc[id] ?? 0).join(',')}]`;
}
