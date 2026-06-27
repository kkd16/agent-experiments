// The Dynamo replica protocol: a leaderless, always-writeable key/value store
// with tunable (N, R, W) quorums, sloppy quorums + hinted handoff, read repair,
// vector-clock conflict detection and anti-entropy — all on the shared kernel.
//
// There is no consensus here. A write goes to N replicas and the coordinator
// returns as soon as W acknowledge; a read gathers R replies and *reconciles*
// them with vector clocks, surfacing concurrent writes as siblings. Availability
// is bought with eventual consistency, and the invariants prove exactly what is
// (durability, causal correctness) and is not (linearizability) preserved.
import type { Message, NodeContext, Protocol } from '../../sim/types';
import { dynamoInvariants } from './invariants';
import {
  buildRing,
  isHomeReplica,
  preferenceList,
  sloppyPreferenceList,
  type RingNode,
} from './ring';
import {
  contextClock,
  mergeClocks,
  mergeVersions,
  reconcile,
  versionSetEq,
  clockStr,
  valuesStr,
  type DynamoCmd,
  type DynamoConfig,
  type DynamoState,
  type Version,
  type VersionSet,
  type PutMsg,
  type PutAckMsg,
  type GetMsg,
  type GetRespMsg,
  type ReadRepairMsg,
  type HintDeliverMsg,
  type HintAckMsg,
  type AntiEntropyMsg,
  type PongMsg,
  type ForwardMsg,
} from './types';

// One ring per cluster shape; memoized so handlers don't rebuild it constantly.
const ringCache = new Map<string, RingNode[]>();
function ringFor(all: readonly string[]): RingNode[] {
  const key = all.join(',');
  let r = ringCache.get(key);
  if (!r) {
    r = buildRing(all);
    ringCache.set(key, r);
  }
  return r;
}

export function createDynamo(config: DynamoConfig): Protocol<DynamoState, DynamoCmd> {
  // ---- liveness / failure detection -------------------------------------

  const isAlive = (s: DynamoState, self: string, id: string): boolean => {
    if (id === self) return true;
    const h = s.health[id];
    return h ? h.alive : true; // optimistic until proven dead
  };

  const aliveFn = (s: DynamoState, self: string) => (id: string) => isAlive(s, self, id);

  const evaluateHealth = (s: DynamoState, now: number) => {
    for (const id in s.health) {
      const h = s.health[id];
      h.alive = now - h.lastSeen <= config.deadAfter;
    }
  };

  // ---- storage helpers ---------------------------------------------------

  /** Merge versions into this node's durable replica store (kept reconciled). */
  const applyToStore = (s: DynamoState, key: string, versions: VersionSet) => {
    s.store[key] = mergeVersions(s.store[key] ?? [], versions);
  };

  /** What this node can answer a read with: its own replica plus any hinted data. */
  const readLocal = (s: DynamoState, key: string): VersionSet => {
    let vs = s.store[key] ?? [];
    for (const target in s.hints) {
      const h = s.hints[target][key];
      if (h) vs = mergeVersions(vs, h);
    }
    return vs;
  };

  // ---- coordinator: writes ----------------------------------------------

  const completePut = (ctx: NodeContext, s: DynamoState, reqId: number) => {
    const pp = s.pendingPuts[reqId];
    if (!pp || pp.done) return;
    pp.done = true;
    s.ackedFrontier[pp.key] = mergeClocks(s.ackedFrontier[pp.key] ?? {}, pp.version.clock);
    s.lastWrite = {
      key: pp.key,
      value: pp.version.value,
      clock: pp.version.clock,
      acks: pp.acks,
      sloppy: pp.sloppy,
      at: ctx.now,
    };
    s.note = `wrote ${pp.key}=${pp.version.value}`;
    ctx.clearTimer(`put:${reqId}`);
    ctx.log('commit', `PUT ${pp.key} acked by ${pp.acks}/${pp.need}${pp.sloppy ? ' [sloppy]' : ''}`);
  };

  const coordinatePut = (
    ctx: NodeContext,
    s: DynamoState,
    cmd: Extract<DynamoCmd, { type: 'put' }>,
  ) => {
    const ring = ringFor(ctx.all);
    const targets = sloppyPreferenceList(cmd.key, ring, s.cfg.n, aliveFn(s, ctx.self), config.sloppy);
    const sloppy = targets.some((t) => t.hintFor);

    // Build the new version. A read-modify-write inherits the current causal
    // context so it dominates (collapses) existing siblings; a *blind* write
    // ignores context, so it can fork a new sibling — the proliferation Dynamo
    // warns about. Either way this coordinator's own counter advances, keeping
    // its component monotonic.
    const cur = s.store[cmd.key] ?? [];
    const maxSelf = cur.reduce((m, v) => Math.max(m, v.clock[ctx.self] ?? 0), 0);
    const base = cmd.blind ? {} : contextClock(cur);
    const clock = { ...base, [ctx.self]: maxSelf + 1 };
    const version: Version = { value: cmd.value, clock, wrote: ctx.now, by: ctx.self };

    applyToStore(s, cmd.key, [version]); // the coordinator is itself a replica
    s.pendingPuts[cmd.reqId] = {
      reqId: cmd.reqId,
      key: cmd.key,
      version,
      acks: 1,
      need: s.cfg.w,
      done: false,
      sloppy,
      startedAt: ctx.now,
    };
    ctx.log('state', `PUT ${cmd.key}=${cmd.value} [${clockStr(clock)}] → {${targets.map((t) => t.node).join(',')}}`);

    for (const t of targets) {
      if (t.node === ctx.self) continue;
      const payload: PutMsg = {
        reqId: cmd.reqId,
        coordinator: ctx.self,
        key: cmd.key,
        version,
        hintFor: t.hintFor,
      };
      ctx.send(t.node, 'Put', payload);
    }
    const pp = s.pendingPuts[cmd.reqId];
    if (pp.acks >= pp.need) completePut(ctx, s, cmd.reqId); // W=1: done immediately
    if (!pp.done) ctx.setTimer(`put:${cmd.reqId}`, config.reqTimeout);
  };

  // ---- coordinator: reads -----------------------------------------------

  const completeGet = (ctx: NodeContext, s: DynamoState, reqId: number) => {
    const pg = s.pendingGets[reqId];
    if (!pg || pg.done) return;
    pg.done = true;
    let merged: VersionSet = [];
    for (const r of pg.responses) merged = mergeVersions(merged, r.versions);
    merged = reconcile(merged);
    s.lastRead = {
      key: pg.key,
      versions: merged,
      replies: pg.responses.length,
      conflict: merged.length > 1,
      at: ctx.now,
    };
    s.note = `read ${pg.key} → ${valuesStr(merged)}`;

    // Read repair: any replica that returned a stale/partial set is updated to
    // the reconciled result — the anti-entropy that rides on every read.
    for (const r of pg.responses) {
      if (versionSetEq(r.versions, merged)) continue;
      if (r.from === ctx.self) applyToStore(s, pg.key, merged);
      else {
        const payload: ReadRepairMsg = { key: pg.key, versions: merged };
        ctx.send(r.from, 'ReadRepair', payload);
      }
    }
    ctx.clearTimer(`get:${reqId}`);
    ctx.log(
      'commit',
      `GET ${pg.key} → ${valuesStr(merged)}${merged.length > 1 ? ` (${merged.length} siblings!)` : ''} from ${pg.responses.length}/${pg.need}`,
    );
  };

  const coordinateGet = (
    ctx: NodeContext,
    s: DynamoState,
    cmd: Extract<DynamoCmd, { type: 'get' }>,
  ) => {
    const ring = ringFor(ctx.all);
    const targets = sloppyPreferenceList(cmd.key, ring, s.cfg.n, aliveFn(s, ctx.self), config.sloppy);
    s.pendingGets[cmd.reqId] = {
      reqId: cmd.reqId,
      key: cmd.key,
      responses: [{ from: ctx.self, versions: readLocal(s, cmd.key) }],
      need: s.cfg.r,
      done: false,
      startedAt: ctx.now,
    };
    ctx.log('state', `GET ${cmd.key} → {${targets.map((t) => t.node).join(',')}}`);
    for (const t of targets) {
      if (t.node === ctx.self) continue;
      const payload: GetMsg = { reqId: cmd.reqId, coordinator: ctx.self, key: cmd.key };
      ctx.send(t.node, 'Get', payload);
    }
    const pg = s.pendingGets[cmd.reqId];
    if (pg.responses.length >= pg.need) completeGet(ctx, s, cmd.reqId); // R=1: done immediately
    if (!pg.done) ctx.setTimer(`get:${cmd.reqId}`, config.reqTimeout);
  };

  // ---- dispatch a (possibly forwarded) client command -------------------

  const dispatch = (ctx: NodeContext, s: DynamoState, cmd: DynamoCmd) => {
    const ring = ringFor(ctx.all);
    const home = preferenceList(cmd.key, ring, s.cfg.n);
    if (!home.includes(ctx.self)) {
      // Not a replica for this key — forward to the first reachable owner, as a
      // Dynamo load-balanced request is routed to a coordinator in the pref list.
      const target = home.find((h) => isAlive(s, ctx.self, h)) ?? home[0];
      const payload: ForwardMsg = { cmd };
      ctx.send(target, 'Forward', payload);
      ctx.log('info', `route ${cmd.type} ${cmd.key} → ${target}`);
      return;
    }
    if (cmd.type === 'put') coordinatePut(ctx, s, cmd);
    else coordinateGet(ctx, s, cmd);
  };

  // ---- the protocol ------------------------------------------------------

  const armTimers = (ctx: NodeContext) => {
    ctx.setTimer('ping', ctx.rng.int(config.pingInterval / 2, config.pingInterval));
    ctx.setTimer('handoff', ctx.rng.int(config.handoffInterval, config.handoffInterval * 2));
    ctx.setTimer('ae', ctx.rng.int(config.antiEntropyInterval, config.antiEntropyInterval * 2));
  };

  const resetVolatile = (ctx: NodeContext, s: DynamoState) => {
    s.pendingPuts = {};
    s.pendingGets = {};
    s.lastRead = null;
    s.lastWrite = null;
    s.health = {};
    for (const id of ctx.peers) s.health[id] = { lastSeen: ctx.now, alive: true };
  };

  return {
    name: 'Dynamo',

    invariants: dynamoInvariants,

    init(ctx) {
      const health: DynamoState['health'] = {};
      for (const id of ctx.peers) health[id] = { lastSeen: 0, alive: true };
      armTimers(ctx);
      return {
        id: ctx.self,
        store: {},
        hints: {},
        ackedFrontier: {},
        pendingPuts: {},
        pendingGets: {},
        lastRead: null,
        lastWrite: null,
        health,
        cfg: { n: config.n, r: config.r, w: config.w },
        note: '',
      };
    },

    onRestart(ctx, s) {
      resetVolatile(ctx, s);
      armTimers(ctx);
      ctx.log('info', `${ctx.self} recovered (disk intact: ${Object.keys(s.store).length} keys)`);
    },

    onCommand(ctx, s, cmd) {
      dispatch(ctx, s, cmd);
    },

    onTimer(ctx, s, name) {
      if (name === 'ping') {
        ctx.broadcast('Ping', () => ({ t: ctx.now }));
        evaluateHealth(s, ctx.now);
        ctx.setTimer('ping', config.pingInterval);
        return;
      }
      if (name === 'handoff') {
        for (const target in s.hints) {
          if (!isAlive(s, ctx.self, target)) continue;
          const keys = s.hints[target];
          for (const key in keys) {
            const payload: HintDeliverMsg = { key, versions: keys[key], target };
            ctx.send(target, 'HintDeliver', payload);
          }
        }
        ctx.setTimer('handoff', config.handoffInterval);
        return;
      }
      if (name === 'ae') {
        const ring = ringFor(ctx.all);
        const peers = ctx.peers.filter((p) => isAlive(s, ctx.self, p));
        const peer = ctx.rng.pick(peers);
        if (peer) {
          const data: Record<string, VersionSet> = {};
          for (const key in s.store) {
            if (isHomeReplica(key, ring, s.cfg.n, peer)) data[key] = s.store[key];
          }
          if (Object.keys(data).length > 0) {
            const payload: AntiEntropyMsg = { data };
            ctx.send(peer, 'AntiEntropy', payload);
          }
        }
        ctx.setTimer('ae', ctx.rng.int(config.antiEntropyInterval, config.antiEntropyInterval * 2));
        return;
      }
      if (name.startsWith('put:')) {
        const id = Number(name.slice(4));
        const pp = s.pendingPuts[id];
        if (pp && !pp.done) ctx.log('drop', `PUT ${pp.key} timed out at ${pp.acks}/${pp.need} acks`);
        return;
      }
      if (name.startsWith('get:')) {
        const id = Number(name.slice(4));
        const pg = s.pendingGets[id];
        if (pg && !pg.done) ctx.log('drop', `GET ${pg.key} timed out at ${pg.responses.length}/${pg.need}`);
        return;
      }
    },

    onMessage(ctx, s, msg: Message) {
      switch (msg.type) {
        case 'Ping': {
          const reply: PongMsg = { from: ctx.self };
          ctx.send(msg.from, 'Pong', reply);
          return;
        }
        case 'Pong': {
          const p = msg.payload as PongMsg;
          s.health[p.from] = { lastSeen: ctx.now, alive: true };
          return;
        }
        case 'Forward': {
          dispatch(ctx, s, (msg.payload as ForwardMsg).cmd);
          return;
        }
        case 'Put': {
          const p = msg.payload as PutMsg;
          let sloppy = false;
          if (p.hintFor && p.hintFor !== ctx.self) {
            const bucket = (s.hints[p.hintFor] ??= {});
            bucket[p.key] = mergeVersions(bucket[p.key] ?? [], [p.version]);
            sloppy = true;
            ctx.log('state', `hold hint ${p.key}=${p.version.value} for ${p.hintFor}`);
          } else {
            applyToStore(s, p.key, [p.version]);
          }
          const ack: PutAckMsg = { reqId: p.reqId, key: p.key, from: ctx.self, sloppy };
          ctx.send(p.coordinator, 'PutAck', ack);
          return;
        }
        case 'PutAck': {
          const a = msg.payload as PutAckMsg;
          const pp = s.pendingPuts[a.reqId];
          if (!pp || pp.done) return;
          pp.acks++;
          if (a.sloppy) pp.sloppy = true;
          if (pp.acks >= pp.need) completePut(ctx, s, a.reqId);
          return;
        }
        case 'Get': {
          const g = msg.payload as GetMsg;
          const reply: GetRespMsg = { reqId: g.reqId, key: g.key, versions: readLocal(s, g.key), from: ctx.self };
          ctx.send(g.coordinator, 'GetResp', reply);
          return;
        }
        case 'GetResp': {
          const r = msg.payload as GetRespMsg;
          const pg = s.pendingGets[r.reqId];
          if (!pg || pg.done) return;
          pg.responses.push({ from: r.from, versions: r.versions });
          if (pg.responses.length >= pg.need) completeGet(ctx, s, r.reqId);
          return;
        }
        case 'ReadRepair': {
          const m = msg.payload as ReadRepairMsg;
          applyToStore(s, m.key, m.versions);
          return;
        }
        case 'HintDeliver': {
          const m = msg.payload as HintDeliverMsg;
          applyToStore(s, m.key, m.versions);
          const ack: HintAckMsg = { key: m.key, from: ctx.self };
          ctx.send(msg.from, 'HintAck', ack);
          ctx.log('recv', `handoff ${m.key} from ${msg.from} absorbed`);
          return;
        }
        case 'HintAck': {
          const a = msg.payload as HintAckMsg;
          const bucket = s.hints[a.from];
          if (bucket) {
            delete bucket[a.key];
            if (Object.keys(bucket).length === 0) delete s.hints[a.from];
          }
          return;
        }
        case 'AntiEntropy': {
          const m = msg.payload as AntiEntropyMsg;
          const ring = ringFor(ctx.all);
          for (const key in m.data) {
            if (isHomeReplica(key, ring, s.cfg.n, ctx.self)) applyToStore(s, key, m.data[key]);
          }
          return;
        }
      }
    },
  };
}
