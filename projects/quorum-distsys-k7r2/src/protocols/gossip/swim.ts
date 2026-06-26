// SWIM: Scalable Weakly-consistent Infection-style process group Membership.
//
// Each node periodically pings a random member; if no ack, it asks k other
// members to ping it indirectly; still nothing -> it marks the member *suspect*,
// and after a grace period *dead*. Membership changes ride along piggybacked on
// the normal traffic (epidemic / infection-style dissemination), and a node that
// hears itself suspected refutes by bumping its incarnation number. A separate
// "rumor" counter rides the same messages to visualize pure gossip spread.
import type { NodeContext, NodeId, Protocol } from '../../sim/types';

export type MemberStatus = 'alive' | 'suspect' | 'dead';
export interface MemberInfo {
  status: MemberStatus;
  inc: number;
}
interface Update {
  node: NodeId;
  status: MemberStatus;
  inc: number;
}

export interface SwimState {
  inc: number;
  members: Record<NodeId, MemberInfo>;
  buffer: { u: Update; ttl: number }[];
  rumor: number; // highest rumor id this node has heard
}

interface Carry {
  updates: Update[];
  rumor: number;
}
interface PingMsg extends Carry {
  reqBy: NodeId | null;
}
interface AckMsg extends Carry {
  target: NodeId;
  inc: number;
  reqBy: NodeId | null;
}
interface PingReqMsg extends Carry {
  target: NodeId;
}

export interface SwimConfig {
  period: number;
  ackTimeout: number;
  indirectTimeout: number;
  suspectTimeout: number;
  k: number;
  ttl: number;
  maxPiggyback: number;
}

export const DEFAULT_SWIM: SwimConfig = {
  period: 300,
  ackTimeout: 150,
  indirectTimeout: 200,
  suspectTimeout: 550,
  k: 2,
  ttl: 4,
  maxPiggyback: 6,
};

export function createSwim(config: SwimConfig = DEFAULT_SWIM): Protocol<SwimState, { type: 'rumor' }> {
  const bufferAdd = (s: SwimState, u: Update) => {
    s.buffer = s.buffer.filter((b) => b.u.node !== u.node);
    s.buffer.push({ u, ttl: config.ttl });
  };

  const carry = (s: SwimState): Carry => {
    const updates: Update[] = [];
    const keep: typeof s.buffer = [];
    for (const b of s.buffer) {
      if (updates.length < config.maxPiggyback) {
        updates.push(b.u);
        if (b.ttl - 1 > 0) keep.push({ u: b.u, ttl: b.ttl - 1 });
      } else keep.push(b);
    }
    s.buffer = keep;
    return { updates, rumor: s.rumor };
  };

  const applyCarry = (ctx: NodeContext, s: SwimState, c: Carry) => {
    if (c.rumor > s.rumor) {
      s.rumor = c.rumor;
      bufferAdd(s, { node: ctx.self, status: 'alive', inc: s.inc }); // keep self alive in the gossip too
    }
    for (const u of c.updates) applyUpdate(ctx, s, u);
  };

  const applyUpdate = (ctx: NodeContext, s: SwimState, u: Update) => {
    if (u.node === ctx.self) {
      if ((u.status === 'suspect' || u.status === 'dead') && u.inc >= s.inc) {
        s.inc = u.inc + 1; // refute: out-incarnate the rumor of our demise
        bufferAdd(s, { node: ctx.self, status: 'alive', inc: s.inc });
        ctx.log('state', `refuting suspicion → incarnation ${s.inc}`);
      }
      return;
    }
    const cur = s.members[u.node] ?? { status: 'alive', inc: -1 };
    if (cur.status === 'dead') return; // dead is terminal
    let apply: boolean;
    if (u.status === 'alive') apply = u.inc > cur.inc || (cur.status !== 'alive' && u.inc >= cur.inc);
    else if (u.status === 'suspect') apply = u.inc > cur.inc || (u.inc === cur.inc && cur.status === 'alive');
    else apply = true; // dead
    if (!apply) return;
    const next: MemberInfo = { status: u.status, inc: u.status === 'dead' ? cur.inc : u.inc };
    if (next.status === cur.status && next.inc === cur.inc) return;
    s.members[u.node] = next;
    bufferAdd(s, { node: u.node, status: next.status, inc: next.inc });
    if (u.status === 'alive') {
      ctx.clearTimer(`probe:${u.node}`);
      ctx.clearTimer(`dead:${u.node}`);
    }
    if (u.status !== 'alive') ctx.log('state', `${u.node} → ${u.status} (inc ${u.inc})`);
  };

  const aliveMembers = (ctx: NodeContext, s: SwimState): NodeId[] =>
    ctx.peers.filter((p) => (s.members[p]?.status ?? 'alive') !== 'dead');

  return {
    name: 'SWIM',

    init(ctx) {
      const members: Record<NodeId, MemberInfo> = {};
      for (const p of ctx.peers) members[p] = { status: 'alive', inc: 0 };
      ctx.setTimer('round', ctx.rng.int(config.period / 2, config.period));
      return { inc: 0, members, buffer: [], rumor: 0 };
    },

    onRestart(ctx, s) {
      s.inc += 1; // rejoin with a fresh incarnation so peers accept us as alive
      for (const p of ctx.peers) s.members[p] = s.members[p] ?? { status: 'alive', inc: 0 };
      bufferAdd(s, { node: ctx.self, status: 'alive', inc: s.inc });
      ctx.setTimer('round', config.period);
    },

    onCommand(ctx, s, cmd) {
      if (cmd.type === 'rumor') {
        s.rumor += 1;
        bufferAdd(s, { node: ctx.self, status: 'alive', inc: s.inc });
        ctx.log('state', `injected rumor #${s.rumor}`);
      }
    },

    onTimer(ctx, s, name) {
      if (name === 'round') {
        const targets = aliveMembers(ctx, s);
        const target = ctx.rng.pick(targets);
        if (target) {
          const msg: PingMsg = { ...carry(s), reqBy: null };
          ctx.send(target, 'ping', msg);
          ctx.setTimer(`ack:${target}`, config.ackTimeout);
        }
        ctx.setTimer('round', config.period);
        return;
      }
      const [kind, target] = name.split(':');
      if (!target) return;
      if (kind === 'ack') {
        // direct ping unanswered -> ask k members to probe indirectly
        const helpers = ctx.rng.sample(
          aliveMembers(ctx, s).filter((p) => p !== target),
          config.k,
        );
        for (const h of helpers) ctx.send(h, 'ping-req', { ...carry(s), target } as PingReqMsg);
        ctx.setTimer(`probe:${target}`, config.indirectTimeout);
      } else if (kind === 'probe') {
        const cur = s.members[target];
        if (cur && cur.status === 'alive') {
          s.members[target] = { status: 'suspect', inc: cur.inc };
          bufferAdd(s, { node: target, status: 'suspect', inc: cur.inc });
          ctx.log('state', `suspect ${target}`);
        }
        ctx.setTimer(`dead:${target}`, config.suspectTimeout);
      } else if (kind === 'dead') {
        const cur = s.members[target];
        if (cur && cur.status === 'suspect') {
          s.members[target] = { status: 'dead', inc: cur.inc };
          bufferAdd(s, { node: target, status: 'dead', inc: cur.inc });
          ctx.log('crash', `declared ${target} DEAD`);
        }
      }
    },

    onMessage(ctx, s, msg) {
      if (msg.type === 'ping') {
        const p = msg.payload as PingMsg;
        applyCarry(ctx, s, p);
        const ack: AckMsg = { ...carry(s), target: ctx.self, inc: s.inc, reqBy: p.reqBy };
        ctx.send(msg.from, 'ack', ack);
      } else if (msg.type === 'ping-req') {
        const p = msg.payload as PingReqMsg;
        applyCarry(ctx, s, p);
        const fwd: PingMsg = { ...carry(s), reqBy: msg.from };
        ctx.send(p.target, 'ping', fwd);
      } else if (msg.type === 'ack') {
        const p = msg.payload as AckMsg;
        applyCarry(ctx, s, p);
        if (p.reqBy && p.reqBy !== ctx.self) {
          // we were the indirect prober: relay the good news to the requester
          ctx.send(p.reqBy, 'ack', { ...carry(s), target: p.target, inc: p.inc, reqBy: null } as AckMsg);
        }
        // mark the acked node alive and stop chasing it
        applyUpdate(ctx, s, { node: p.target, status: 'alive', inc: p.inc });
        ctx.clearTimer(`ack:${p.target}`);
        ctx.clearTimer(`probe:${p.target}`);
        ctx.clearTimer(`dead:${p.target}`);
        if (s.members[p.target] && s.members[p.target].status === 'suspect') {
          s.members[p.target] = { status: 'alive', inc: p.inc };
        }
      }
    },

    invariants(nodes) {
      const up = nodes.filter((n) => n.up);
      const crashed = new Set(nodes.filter((n) => !n.up).map((n) => n.id));
      // Agreement: alive nodes share the same view of every member.
      let agree = true;
      for (const id of nodes.map((n) => n.id)) {
        const seen = new Set(up.map((n) => n.state.members[id]?.status ?? (n.id === id ? 'alive' : 'alive')));
        if (seen.size > 1) agree = false;
      }
      // Accuracy: nobody is believed dead unless they really crashed.
      let falseDeath = '';
      for (const n of up) {
        for (const [id, info] of Object.entries(n.state.members)) {
          if (info.status === 'dead' && !crashed.has(id)) falseDeath = `${n.id} thinks ${id} is dead, but it is alive`;
        }
      }
      return [
        {
          name: 'Eventual agreement',
          ok: agree,
          detail: agree ? 'all live nodes share one membership view' : 'views differ — dissemination still in flight',
        },
        {
          name: 'Detector accuracy',
          ok: !falseDeath,
          detail: falseDeath || 'no live, reachable node is wrongly declared dead',
        },
      ];
    },
  };
}
