// Chord — a scalable peer-to-peer distributed hash table.
//
// Nodes and keys share a circular m-bit identifier space. A key is owned by its
// successor (first node clockwise ≥ the key). Two mechanisms make it work:
//
//   • **Finger table** — m shortcuts, finger[i] = successor(id + 2^i). A lookup
//     repeatedly jumps to the closest finger preceding the target, halving the
//     remaining distance each hop ⇒ O(log N) hops to the owner.
//   • **Stabilization** — a periodic protocol (stabilize / notify / fix_fingers
//     / check_predecessor) that keeps successor & predecessor pointers correct
//     as nodes join and fail, healing the ring without any central coordinator.
//
// Lookups here are *recursive*: the query is forwarded hop-by-hop and the answer
// is returned straight to the origin, carrying the path it travelled (the viz).
import type { NodeContext, Message, Protocol } from '../../sim/types';
import {
  DEFAULT_CHORD_CONFIG,
  type ChordConfig,
  type ChordState,
  type ChordCmd,
  type FindSuccessor,
  type FoundSuccessor,
  type GetPredecessor,
  type PredecessorInfo,
  type Notify,
  type Ping,
  type Pong,
  type LookupPurpose,
} from './types';
import { buildDirectory, inOpen, inOpenClosed } from './ring';

export function createChord(config: ChordConfig = DEFAULT_CHORD_CONFIG): Protocol<ChordState, ChordCmd> {
  const SIZE = 1 << config.m;

  const succ = (s: ChordState): number => s.successorList[0] ?? s.id;
  const nameOf = (s: ChordState, id: number): string | null => s.names[id] ?? null;

  function armTimers(ctx: NodeContext): void {
    ctx.setTimer('stabilize', config.stabilizeInterval);
    ctx.setTimer('fixfingers', config.fixFingersInterval);
    ctx.setTimer('checkpred', config.checkPredInterval);
  }

  /** finger[i] = successor(id + 2^i). The closest finger preceding `key`. */
  function closestPreceding(s: ChordState, key: number): number {
    for (let i = config.m - 1; i >= 0; i--) {
      const f = s.finger[i];
      if (f !== undefined && f !== s.id && inOpen(f, s.id, key)) return f;
    }
    // Fall back to the successor list (still better than nothing).
    for (let i = s.successorList.length - 1; i >= 0; i--) {
      const sc = s.successorList[i];
      if (sc !== undefined && sc !== s.id && inOpen(sc, s.id, key)) return sc;
    }
    return s.id;
  }

  function sendFound(ctx: NodeContext, s: ChordState, to: number, msg: FoundSuccessor): void {
    const target = nameOf(s, to);
    if (target === null) return;
    if (to === s.id) {
      handleFound(ctx, s, msg); // answering our own query
      return;
    }
    ctx.send(target, 'FoundSuccessor', msg);
  }

  /** Either answer find_successor(key) locally or forward it one hop. */
  function routeFindSuccessor(ctx: NodeContext, s: ChordState, req: FindSuccessor): void {
    const sc = succ(s);
    const path = [...req.path, s.id];
    // A key equal to our own id is owned by us.
    if (req.key === s.id) {
      sendFound(ctx, s, req.origin, { key: req.key, succ: s.id, origin: req.origin, purpose: req.purpose, fingerIdx: req.fingerIdx, reqId: req.reqId, hops: req.hops, path });
      return;
    }
    // Singleton ring, or key falls in (self, successor]: the successor owns it.
    if (sc === s.id || inOpenClosed(req.key, s.id, sc)) {
      sendFound(ctx, s, req.origin, {
        key: req.key,
        succ: sc,
        origin: req.origin,
        purpose: req.purpose,
        fingerIdx: req.fingerIdx,
        reqId: req.reqId,
        hops: req.hops,
        path,
      });
      return;
    }
    const next = closestPreceding(s, req.key);
    if (next === s.id || req.hops > 2 * config.m + 6) {
      // No closer node known (or loop guard): answer with our successor.
      sendFound(ctx, s, req.origin, {
        key: req.key,
        succ: sc,
        origin: req.origin,
        purpose: req.purpose,
        fingerIdx: req.fingerIdx,
        reqId: req.reqId,
        hops: req.hops,
        path,
      });
      return;
    }
    const target = nameOf(s, next);
    if (target === null) {
      sendFound(ctx, s, req.origin, { key: req.key, succ: sc, origin: req.origin, purpose: req.purpose, fingerIdx: req.fingerIdx, reqId: req.reqId, hops: req.hops, path });
      return;
    }
    ctx.send(target, 'FindSuccessor', { ...req, hops: req.hops + 1, path });
  }

  /** Begin a find_successor from this node (origin = self). */
  function startFind(ctx: NodeContext, s: ChordState, key: number, purpose: LookupPurpose, fingerIdx = 0): void {
    routeFindSuccessor(ctx, s, {
      key,
      origin: s.id,
      purpose,
      fingerIdx,
      reqId: s.reqSeq++,
      hops: 0,
      path: [],
    });
  }

  function handleFound(ctx: NodeContext, s: ChordState, m: FoundSuccessor): void {
    if (m.purpose === 'join') {
      if (!s.joined) {
        s.successorList = [m.succ];
        s.joined = true;
        s.note = `joined: successor = ${m.succ}`;
        ctx.log('state', `joined ring — successor ${m.succ}`);
        armTimers(ctx); // start stabilizing immediately
      }
    } else if (m.purpose === 'finger') {
      s.finger[m.fingerIdx] = m.succ;
    } else {
      // user lookup resolved
      s.lastLookup = { key: m.key, owner: m.succ, path: [...m.path, m.succ], hops: m.hops };
      s.note = `lookup ${m.key} → owner ${m.succ} (${m.hops} hops)`;
      ctx.log('commit', `key ${m.key} owned by ${m.succ} · ${m.hops} hops`);
    }
  }

  return {
    name: 'Chord DHT',

    init(ctx) {
      const names = buildDirectory(ctx.all, config.m);
      const id = Object.keys(names)
        .map(Number)
        .find((k) => names[k] === ctx.self)!;
      const bootstrap = ctx.all[0];
      const s: ChordState = {
        id,
        m: config.m,
        names,
        successorList: [id],
        predecessor: null,
        finger: new Array(config.m).fill(id),
        joined: false,
        nextFinger: 0,
        awaitingStabilize: false,
        awaitingPred: false,
        reqSeq: 0,
        lastLookup: null,
        note: 'init',
      };
      if (ctx.self === bootstrap) {
        // Form the initial one-node ring. predecessor stays null so the first
        // notify() is accepted (a self-predecessor would block every notify).
        s.joined = true;
        s.note = 'bootstrap (singleton ring)';
        armTimers(ctx);
      } else {
        // Join through the bootstrap after a small stagger.
        ctx.setTimer('join', 30 + (id % 40));
      }
      return s;
    },

    onRestart(ctx, s) {
      // A restarted node rejoins from scratch (its routing state is volatile).
      s.successorList = [s.id];
      s.predecessor = null;
      s.finger = new Array(config.m).fill(s.id);
      s.joined = false;
      s.awaitingStabilize = false;
      s.awaitingPred = false;
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
      if (cmd.type === 'lookup') {
        if (!s.joined) {
          s.note = 'not yet joined';
          return;
        }
        ctx.log('state', `lookup key ${cmd.key}`);
        startFind(ctx, s, ((cmd.key % SIZE) + SIZE) % SIZE, 'user');
        return;
      }
      if (cmd.type === 'join') {
        const bootstrap = ctx.all[0];
        const bid = Object.keys(s.names)
          .map(Number)
          .find((k) => s.names[k] === bootstrap);
        if (bid !== undefined) ctx.send(bootstrap, 'FindSuccessor', { key: s.id, origin: s.id, purpose: 'join', fingerIdx: 0, reqId: s.reqSeq++, hops: 0, path: [] } as FindSuccessor);
      }
    },

    onTimer(ctx, s, name) {
      switch (name) {
        case 'join': {
          if (s.joined) return; // joined (timers already armed by handleFound)
          const bootstrap = ctx.all[0];
          ctx.send(bootstrap, 'FindSuccessor', { key: s.id, origin: s.id, purpose: 'join', fingerIdx: 0, reqId: s.reqSeq++, hops: 0, path: [] } as FindSuccessor);
          ctx.setTimer('join', config.stabilizeInterval); // retry until joined
          return;
        }
        case 'stabilize': {
          ctx.setTimer('stabilize', config.stabilizeInterval);
          if (!s.joined) {
            ctx.setTimer('join', 10);
            return;
          }
          // A probe is already outstanding — let its timeout resolve first, so a
          // lost reply can't be masked by re-arming the timeout every round
          // (which would starve successor-failure detection).
          if (s.awaitingStabilize) return;
          const sc = succ(s);
          if (sc === s.id) {
            // We think we're alone. In Chord the interval (n, n) is the whole
            // ring, so a lone node adopts its own predecessor as its successor —
            // this is what lets the very first node bootstrap a real cycle as
            // others join. (Equivalent to GetPredecessor against ourselves.)
            if (s.predecessor !== null && s.predecessor !== s.id) {
              s.successorList = [s.predecessor];
              const nm = nameOf(s, s.predecessor);
              if (nm !== null) ctx.send(nm, 'Notify', { from: s.id } as Notify);
            }
            return;
          }
          const target = nameOf(s, sc);
          if (target === null) {
            advanceSuccessor(s);
            return;
          }
          s.awaitingStabilize = true;
          ctx.send(target, 'GetPredecessor', { reqId: s.reqSeq++ } as GetPredecessor);
          ctx.setTimer('succtimeout', config.rpcTimeout);
          return;
        }
        case 'succtimeout': {
          if (s.awaitingStabilize) {
            // The successor never answered — assume it failed; drop to the next.
            s.awaitingStabilize = false;
            advanceSuccessor(s);
            s.note = `successor failed → ${succ(s)}`;
            ctx.log('crash', `successor failed; now ${succ(s)}`);
          }
          return;
        }
        case 'fixfingers': {
          ctx.setTimer('fixfingers', config.fixFingersInterval);
          if (!s.joined) return;
          s.nextFinger = (s.nextFinger + 1) % config.m;
          const start = (s.id + (1 << s.nextFinger)) % SIZE;
          startFind(ctx, s, start, 'finger', s.nextFinger);
          return;
        }
        case 'checkpred': {
          ctx.setTimer('checkpred', config.checkPredInterval);
          if (s.awaitingPred) return; // a ping is already outstanding
          if (s.predecessor === null || s.predecessor === s.id) return;
          const target = nameOf(s, s.predecessor);
          if (target === null) {
            s.predecessor = null;
            return;
          }
          s.awaitingPred = true;
          ctx.send(target, 'Ping', { reqId: s.reqSeq++ } as Ping);
          ctx.setTimer('predtimeout', config.rpcTimeout);
          return;
        }
        case 'predtimeout': {
          if (s.awaitingPred) {
            s.awaitingPred = false;
            s.note = `predecessor ${s.predecessor} failed`;
            s.predecessor = null;
          }
          return;
        }
      }
    },

    onMessage(ctx, s, msg: Message) {
      switch (msg.type) {
        case 'FindSuccessor': {
          if (!s.joined && msg.from !== undefined) {
            // Not part of the ring yet: bounce to our (only) successor / self.
          }
          routeFindSuccessor(ctx, s, msg.payload as FindSuccessor);
          return;
        }
        case 'FoundSuccessor': {
          handleFound(ctx, s, msg.payload as FoundSuccessor);
          return;
        }
        case 'GetPredecessor': {
          ctx.send(msg.from, 'PredecessorInfo', {
            pred: s.predecessor,
            succList: s.successorList.slice(0, config.r),
            from: s.id,
          } as PredecessorInfo);
          return;
        }
        case 'PredecessorInfo': {
          const p = msg.payload as PredecessorInfo;
          if (!s.awaitingStabilize) return;
          s.awaitingStabilize = false;
          ctx.clearTimer('succtimeout');
          const sc = succ(s);
          // If our successor knows a closer predecessor, adopt it.
          if (p.pred !== null && p.pred !== s.id && inOpen(p.pred, s.id, sc)) {
            s.successorList = [p.pred, ...s.successorList];
          }
          // Rebuild the successor list: [successor, ...successor's list].
          const merged = [succ(s), ...p.succList].filter((x, i, a) => a.indexOf(x) === i && x !== s.id);
          s.successorList = merged.length ? merged.slice(0, config.r) : [s.id];
          // Tell our successor we may be its predecessor.
          const scName = nameOf(s, succ(s));
          if (scName !== null) ctx.send(scName, 'Notify', { from: s.id } as Notify);
          return;
        }
        case 'Notify': {
          const n = (msg.payload as Notify).from;
          if (s.predecessor === null || s.predecessor === s.id || inOpen(n, s.predecessor, s.id)) {
            s.predecessor = n;
          }
          return;
        }
        case 'Ping': {
          ctx.send(msg.from, 'Pong', { from: s.id } as Pong);
          return;
        }
        case 'Pong': {
          s.awaitingPred = false;
          ctx.clearTimer('predtimeout');
          return;
        }
      }
    },
  };

  function advanceSuccessor(s: ChordState): void {
    s.successorList.shift();
    if (s.successorList.length === 0) s.successorList = [s.id];
  }
}
