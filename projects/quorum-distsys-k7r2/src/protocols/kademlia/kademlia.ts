// Kademlia — the XOR-metric distributed hash table.
//
// Node ids and keys share one m-bit space; closeness is XOR distance. Two ideas
// carry the whole protocol:
//
//   • **k-buckets** (routing.ts) — one bucket per bit, holding up to k live
//     contacts, biased toward long-lived nodes. A node learns contacts simply by
//     remembering the id of anyone it exchanges a message with, so the table
//     self-organises with no dedicated maintenance traffic.
//   • **Iterative parallel lookup** — to find the k nodes closest to a target the
//     *initiator itself* drives the search: it seeds a shortlist from its own
//     buckets, keeps α FIND_NODE probes in flight to the closest unqueried
//     contacts, folds every returned contact back into the shortlist, and stops
//     when the k closest nodes it has heard of have all answered and no unqueried
//     node is any closer. Each hop moves at least one bit closer to the target ⇒
//     O(log N) rounds. (Contrast Chord, whose lookup is *recursive* — forwarded
//     hop-by-hop with the answer returned to the origin.)
//
// FIND_VALUE piggybacks on the same machinery: a node holding the key short-
// circuits the search by returning the value; STORE runs a node lookup for the
// key and then places the pair on the resulting k closest nodes.
import type { NodeContext, Message, Protocol } from '../../sim/types';
import {
  DEFAULT_KADEMLIA_CONFIG,
  type KademliaConfig,
  type KademliaState,
  type KademliaCmd,
  type Lookup,
  type LookupKind,
  type FindReq,
  type FindRep,
  type StoreReq,
  type PingReq,
  type PongRep,
} from './types';
import { buildDirectory, xorDist, compareDist } from './xor';
import { makeTable, tableInsert, markSeen, evict, closest, allContacts } from './routing';

export function createKademlia(config: KademliaConfig = DEFAULT_KADEMLIA_CONFIG): Protocol<KademliaState, KademliaCmd> {
  const SIZE = 1 << config.m;
  const nameOf = (s: KademliaState, id: number): string | null => s.names[id] ?? null;

  // ---- learning contacts (the routing-table side) ------------------------

  /** Remember a contact; on a full bucket, ping the least-recently-seen head to
   *  decide whether to evict it in favour of the newcomer. */
  function touch(ctx: NodeContext, s: KademliaState, id: number): void {
    if (id === s.id || nameOf(s, id) === null) return;
    const res = tableInsert(s.rt, id);
    if (res.status === 'full') {
      // Don't ping the same head twice concurrently.
      const already = Object.values(s.pendingEvict).some((p) => p.lru === res.lru);
      if (already) return;
      const pid = s.reqSeq++;
      s.pendingEvict[pid] = { bucket: res.bucket, lru: res.lru, challenger: id };
      const nm = nameOf(s, res.lru);
      if (nm !== null) {
        ctx.send(nm, 'KPing', { pid, src: s.id } as PingReq);
        ctx.setTimer(`evict:${pid}`, config.rpcTimeout);
      }
    }
  }

  // ---- iterative lookup (the search side) --------------------------------

  function sortByDist(lk: Lookup): void {
    lk.shortlist.sort((a, b) => {
      const c = compareDist(lk.target, a, b);
      return c !== 0 ? c : a - b;
    });
  }

  /** The k closest ids that have already answered (status 'ok'), nearest first. */
  function okClosest(s: KademliaState, lk: Lookup): number[] {
    return lk.shortlist.filter((id) => lk.status[id] === 'ok').slice(0, s.k);
  }

  /** Keep α probes in flight to the closest unqueried contacts within the
   *  frontier; finish the lookup when the frontier has closed. */
  function pump(ctx: NodeContext, s: KademliaState, lk: Lookup): void {
    sortByDist(lk);
    while (lk.inflight < s.alpha) {
      const ok = okClosest(s, lk);
      const bound = ok.length >= s.k ? xorDist(lk.target, ok[s.k - 1]) : Infinity;
      const cand = lk.shortlist.find(
        (id) => lk.status[id] === 'unqueried' && id !== s.id && xorDist(lk.target, id) < bound,
      );
      if (cand === undefined) break;
      const nm = nameOf(s, cand);
      if (nm === null) {
        lk.status[cand] = 'dead';
        continue;
      }
      lk.status[cand] = 'pending';
      lk.inflight++;
      lk.rounds++;
      lk.path.push(cand);
      ctx.send(nm, 'KFind', { lid: lk.id, target: lk.target, kind: lk.kind, src: s.id } as FindReq);
      ctx.setTimer(`find:${lk.id}:${cand}`, config.rpcTimeout);
    }
    // Has the frontier closed? (nothing in flight and no queriable candidate)
    const ok = okClosest(s, lk);
    const bound = ok.length >= s.k ? xorDist(lk.target, ok[s.k - 1]) : Infinity;
    const more = lk.shortlist.some(
      (id) => lk.status[id] === 'unqueried' && id !== s.id && xorDist(lk.target, id) < bound,
    );
    if (lk.inflight === 0 && !more) finishLookup(ctx, s, lk);
  }

  function startLookup(
    ctx: NodeContext,
    s: KademliaState,
    target: number,
    kind: LookupKind,
    opts: { storeVal?: string } = {},
  ): void {
    const id = s.reqSeq++;
    const seed = [...new Set([s.id, ...closest(s.rt, target, Math.max(s.k, s.alpha) + 2)])];
    const status: Record<number, string> = {};
    for (const c of seed) status[c] = c === s.id ? 'ok' : 'unqueried';
    const lk: Lookup = {
      id,
      target,
      kind,
      shortlist: seed,
      status: status as Lookup['status'],
      inflight: 0,
      rounds: 0,
      value: null,
      storeVal: opts.storeVal,
      path: [],
      startedAt: ctx.now,
    };
    s.lookups[id] = lk;
    pump(ctx, s, lk);
  }

  function finishLookup(ctx: NodeContext, s: KademliaState, lk: Lookup): void {
    delete s.lookups[lk.id];
    const closestK = okClosest(s, lk);
    const found = lk.value !== null;
    if (lk.kind === 'join') {
      s.joined = true;
      s.note = `joined — self-lookup reached ${closestK.length} neighbours`;
      ctx.log('state', `joined the DHT (knows ${allContacts(s.rt).length} contacts)`);
      // Refresh the far buckets now that we have neighbours.
      scheduleRefresh(ctx);
      return;
    }
    if (lk.kind === 'store') {
      const value = lk.storeVal ?? '';
      for (const id of closestK) {
        const nm = nameOf(s, id);
        if (nm !== null && id !== s.id) ctx.send(nm, 'KStore', { key: lk.target, value, src: s.id } as StoreReq);
      }
      if (closestK.includes(s.id)) s.store[lk.target] = value;
      if (!s.originated.includes(lk.target)) s.originated.push(lk.target);
      s.lastResult = { kind: 'store', target: lk.target, closest: closestK, path: lk.path, value, found: true, rounds: lk.rounds, key: lk.target };
      s.note = `PUT key ${lk.target} → ${closestK.length} replicas`;
      ctx.log('commit', `stored key ${lk.target} on {${closestK.join(',')}}`);
      return;
    }
    if (lk.kind === 'value') {
      s.lastResult = { kind: 'value', target: lk.target, closest: closestK, path: lk.path, value: lk.value, found, rounds: lk.rounds, key: lk.target };
      s.note = found ? `GET key ${lk.target} → "${lk.value}" (${lk.rounds} probes)` : `GET key ${lk.target} → not found`;
      ctx.log(found ? 'commit' : 'info', found ? `value for ${lk.target} = "${lk.value}"` : `key ${lk.target} not found`);
      return;
    }
    // node lookup (background 'refresh'/'join' lookups don't disturb the UI result)
    if (lk.kind === 'node') {
      s.lastResult = { kind: 'node', target: lk.target, closest: closestK, path: lk.path, value: null, found: true, rounds: lk.rounds };
      s.note = `lookup ${lk.target} → k-closest {${closestK.join(',')}} (${lk.rounds} probes)`;
      ctx.log('commit', `k-closest to ${lk.target}: {${closestK.join(',')}} · ${lk.rounds} probes`);
    }
  }

  function onFindReply(ctx: NodeContext, s: KademliaState, rep: FindRep): void {
    const lk = s.lookups[rep.lid];
    ctx.clearTimer(`find:${rep.lid}:${rep.src}`);
    touch(ctx, s, rep.src);
    if (!lk) return; // stale (lookup already finished)
    if (lk.status[rep.src] === 'pending') lk.inflight = Math.max(0, lk.inflight - 1);
    lk.status[rep.src] = 'ok';
    if (rep.value !== null && lk.value === null && lk.kind === 'value') {
      // FIND_VALUE hit: short-circuit the whole search — later replies go stale.
      lk.value = rep.value;
      finishLookup(ctx, s, lk);
      return;
    }
    for (const c of rep.contacts) {
      touch(ctx, s, c);
      if (c !== s.id && !(c in lk.status)) {
        lk.status[c] = 'unqueried';
        lk.shortlist.push(c);
      }
    }
    pump(ctx, s, lk);
  }

  // ---- background maintenance --------------------------------------------

  function scheduleRefresh(ctx: NodeContext): void {
    ctx.setTimer('refresh', config.refreshInterval);
  }

  function armTimers(ctx: NodeContext): void {
    scheduleRefresh(ctx);
    ctx.setTimer('republish', config.republishInterval);
  }

  return {
    name: 'Kademlia DHT',

    init(ctx) {
      const names = buildDirectory(ctx.all, config.m);
      const id = Object.keys(names)
        .map(Number)
        .find((k) => names[k] === ctx.self)!;
      const s: KademliaState = {
        id,
        m: config.m,
        k: config.k,
        alpha: config.alpha,
        names,
        rt: makeTable(id, config.m, config.k),
        store: {},
        originated: [],
        joined: false,
        reqSeq: 0,
        lookups: {},
        pendingEvict: {},
        lastResult: null,
        note: 'init',
      };
      const bootstrap = ctx.all[0];
      if (ctx.self === bootstrap) {
        s.joined = true;
        s.note = 'bootstrap node (seed of the DHT)';
        armTimers(ctx);
      } else {
        ctx.setTimer('join', 30 + (id % 40));
      }
      return s;
    },

    onRestart(ctx, s) {
      // Routing state is volatile; stored key/value pairs persist across a crash.
      s.rt = makeTable(s.id, config.m, config.k);
      s.lookups = {};
      s.pendingEvict = {};
      s.joined = false;
      s.note = 'restarted — rejoining';
      const bootstrap = ctx.all[0];
      if (ctx.self === bootstrap) {
        s.joined = true;
        armTimers(ctx);
      } else {
        ctx.setTimer('join', 20);
      }
    },

    onCommand(ctx, s, cmd) {
      if (!s.joined && cmd.type !== 'refresh') {
        s.note = 'not yet joined';
        return;
      }
      switch (cmd.type) {
        case 'lookup': {
          const t = ((cmd.target % SIZE) + SIZE) % SIZE;
          ctx.log('state', `node lookup for ${t}`);
          startLookup(ctx, s, t, 'node');
          return;
        }
        case 'put': {
          const key = ((cmd.key % SIZE) + SIZE) % SIZE;
          ctx.log('state', `PUT key ${key} = "${cmd.value}"`);
          startLookup(ctx, s, key, 'store', { storeVal: cmd.value });
          return;
        }
        case 'get': {
          const key = ((cmd.key % SIZE) + SIZE) % SIZE;
          ctx.log('state', `GET key ${key}`);
          // Short-circuit if we hold it ourselves.
          if (s.store[key] !== undefined) {
            s.lastResult = { kind: 'value', target: key, closest: [s.id], path: [], value: s.store[key], found: true, rounds: 0, key };
            s.note = `GET key ${key} → "${s.store[key]}" (local)`;
            return;
          }
          startLookup(ctx, s, key, 'value');
          return;
        }
        case 'ping': {
          const nm = nameOf(s, cmd.to);
          if (nm !== null) {
            const pid = s.reqSeq++;
            ctx.send(nm, 'KPing', { pid, src: s.id } as PingReq);
          }
          return;
        }
        case 'refresh': {
          if (!s.joined) return;
          startLookup(ctx, s, s.id, 'refresh');
          return;
        }
      }
    },

    onTimer(ctx, s, name) {
      if (name === 'join') {
        if (s.joined) return;
        const bootstrap = ctx.all[0];
        const bid = Object.keys(s.names)
          .map(Number)
          .find((k) => s.names[k] === bootstrap);
        if (bid !== undefined && bid !== s.id) {
          touch(ctx, s, bid);
          startLookup(ctx, s, s.id, 'join'); // self-lookup populates buckets
        }
        ctx.setTimer('join', config.refreshInterval); // retry until joined
        return;
      }
      if (name === 'refresh') {
        ctx.setTimer('refresh', config.refreshInterval);
        if (!s.joined) return;
        // Refresh a random bucket by looking up a random id, plus keep self-neighbourhood fresh.
        startLookup(ctx, s, s.id, 'refresh');
        const rnd = ctx.rng.int(0, SIZE - 1);
        startLookup(ctx, s, rnd, 'refresh');
        return;
      }
      if (name === 'republish') {
        ctx.setTimer('republish', config.republishInterval);
        if (!s.joined) return;
        for (const key of s.originated) {
          const val = s.store[key];
          if (val !== undefined) startLookup(ctx, s, key, 'store', { storeVal: val });
        }
        return;
      }
      if (name.startsWith('find:')) {
        const [, lidStr, pidStr] = name.split(':');
        const lid = Number(lidStr);
        const pid = Number(pidStr);
        const lk = s.lookups[lid];
        if (!lk) return;
        if (lk.status[pid] === 'pending') {
          // The probe timed out *for this lookup* — try the next-closest contact.
          // We do NOT evict the peer from the routing table on a single missed
          // reply (a dropped packet ≠ a dead node); k-bucket eviction only ever
          // happens after a direct liveness ping fails during a full-bucket
          // replacement. This is what makes the α-parallel lookup loss-tolerant.
          lk.status[pid] = 'dead';
          lk.inflight = Math.max(0, lk.inflight - 1);
          pump(ctx, s, lk);
        }
        return;
      }
      if (name.startsWith('evict:')) {
        const pid = Number(name.split(':')[1]);
        const pend = s.pendingEvict[pid];
        if (pend) {
          // The least-recently-seen head never answered ⇒ evict it, admit the challenger.
          evict(s.rt, pend.lru, pend.challenger);
          delete s.pendingEvict[pid];
        }
        return;
      }
    },

    onMessage(ctx, s, msg: Message) {
      switch (msg.type) {
        case 'KFind': {
          const req = msg.payload as FindReq;
          touch(ctx, s, req.src);
          const contacts = closest(s.rt, req.target, s.k, [s.id]).filter((c) => c !== req.src);
          const value = req.kind === 'value' && s.store[req.target] !== undefined ? s.store[req.target] : null;
          const nm = nameOf(s, req.src);
          if (nm !== null) ctx.send(nm, 'KFindRep', { lid: req.lid, src: s.id, contacts, value } as FindRep);
          return;
        }
        case 'KFindRep': {
          onFindReply(ctx, s, msg.payload as FindRep);
          return;
        }
        case 'KStore': {
          const req = msg.payload as StoreReq;
          touch(ctx, s, req.src);
          s.store[req.key] = req.value;
          ctx.log('state', `STORE key ${req.key} = "${req.value}"`);
          return;
        }
        case 'KPing': {
          const req = msg.payload as PingReq;
          touch(ctx, s, req.src);
          const nm = nameOf(s, req.src);
          if (nm !== null) ctx.send(nm, 'KPong', { pid: req.pid, src: s.id } as PongRep);
          return;
        }
        case 'KPong': {
          const rep = msg.payload as PongRep;
          ctx.clearTimer(`evict:${rep.pid}`);
          const pend = s.pendingEvict[rep.pid];
          if (pend) {
            // The head is alive ⇒ keep it (move to tail), drop the challenger.
            markSeen(s.rt, pend.lru);
            delete s.pendingEvict[rep.pid];
          } else {
            markSeen(s.rt, rep.src);
          }
          return;
        }
      }
    },
  };
}
