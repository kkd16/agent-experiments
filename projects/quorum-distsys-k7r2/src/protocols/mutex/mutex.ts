// Lamport's distributed mutual-exclusion algorithm on the kernel.
//
// Each process keeps a Lamport clock and a request queue ordered by (ts, id).
//
//   • want CS:  clock++; stamp a request; enqueue it; broadcast REQUEST.
//   • on REQUEST(ts) from j:  enqueue {ts, j}; send REPLY.
//   • on REPLY / RELEASE from j:  (RELEASE removes j's request from the queue).
//   • enter CS when  my request is the (ts,id)-minimum of my queue  AND  I have
//     heard from every other process with a timestamp later than my request.
//   • leave CS:  clock++; dequeue my request; broadcast RELEASE.
//
// Mutual exclusion follows from the global (ts, id) total order — but only if
// channels are FIFO, so every message rides a per-channel sequence number and is
// delivered strictly in order (see `deliver`). The Lamport clock advances on
// every local event and jumps to max(local, received)+1 on every receive.
import type { NodeContext, Message, Protocol } from '../../sim/types';
import {
  DEFAULT_MUTEX_CONFIG,
  cmpReq,
  type MutexConfig,
  type MutexState,
  type MutexCmd,
  type MutexMsg,
  type Buffered,
  type ReqEntry,
} from './types';

export function createMutex(config: MutexConfig = DEFAULT_MUTEX_CONFIG): Protocol<MutexState, MutexCmd> {
  /** Send on the FIFO channel to `to`, stamping the event timestamp `ts` + the
   *  next channel sequence. A *broadcast* is ONE logical event, so the caller
   *  bumps the clock once and passes the same `ts` to every recipient — otherwise
   *  the recipients would disagree on the request's timestamp and the global
   *  (ts,id) order (and thus mutual exclusion) would break. */
  function fifoSend(s: MutexState, ctx: NodeContext, to: string, type: 'Request' | 'Reply' | 'Release', ts: number): void {
    const seq = s.outSeq[to] ?? 0;
    s.outSeq[to] = seq + 1;
    ctx.send(to, type, { seq, ts } as MutexMsg);
  }

  function enqueue(s: MutexState, e: ReqEntry): void {
    s.queue = s.queue.filter((q) => q.id !== e.id); // one outstanding request per node
    s.queue.push(e);
    s.queue.sort(cmpReq);
  }

  function dequeue(s: MutexState, id: string): void {
    s.queue = s.queue.filter((q) => q.id !== id);
  }

  function wantCS(ctx: NodeContext, s: MutexState): void {
    if (s.phase !== 'idle') return;
    s.clock++;
    s.myReqTs = s.clock;
    s.phase = 'wanting';
    s.requestedAt = ctx.now;
    enqueue(s, { ts: s.myReqTs, id: ctx.self });
    s.note = `wants CS (req ts ${s.myReqTs})`;
    ctx.log('state', `requests CS @ ts ${s.myReqTs}`);
    for (const p of ctx.peers) fifoSend(s, ctx, p, 'Request', s.myReqTs); // one event, one ts
    tryEnter(ctx, s);
  }

  function tryEnter(ctx: NodeContext, s: MutexState): void {
    if (s.phase !== 'wanting' || s.myReqTs == null) return;
    const head = s.queue[0];
    if (!head || head.id !== ctx.self) return; // not the (ts,id)-minimum
    // Condition 2: a later message from every other process.
    for (const p of ctx.peers) if ((s.lastTsFrom[p] ?? -1) <= s.myReqTs) return;
    s.phase = 'held';
    s.inCS = true;
    s.enteredAt = ctx.now;
    s.entries++;
    if (s.requestedAt != null) s.maxWait = Math.max(s.maxWait, ctx.now - s.requestedAt);
    s.note = `IN CRITICAL SECTION (ts ${s.myReqTs})`;
    ctx.log('commit', `enters CS (waited ${s.requestedAt != null ? ctx.now - s.requestedAt : 0}ms)`);
    ctx.setTimer('exit', config.csDuration);
  }

  function leaveCS(ctx: NodeContext, s: MutexState): void {
    if (!s.inCS) return;
    dequeue(s, ctx.self);
    s.inCS = false;
    s.phase = 'idle';
    s.myReqTs = null;
    s.requestedAt = null;
    s.enteredAt = null;
    s.note = 'released CS';
    ctx.log('state', 'releases CS');
    s.clock++; // releasing is one event
    for (const p of ctx.peers) fifoSend(s, ctx, p, 'Release', s.clock);
    ctx.setTimer('think', config.thinkDelay + ctx.rng.int(0, config.thinkDelay));
  }

  function recvClock(s: MutexState, ts: number): void {
    s.clock = Math.max(s.clock, ts) + 1;
  }

  function handleInOrder(ctx: NodeContext, s: MutexState, from: string, m: Buffered): void {
    recvClock(s, m.ts);
    s.lastTsFrom[from] = Math.max(s.lastTsFrom[from] ?? -1, m.ts);
    if (m.kind === 'request') {
      enqueue(s, { ts: m.ts, id: from });
      s.clock++; // replying is one event
      fifoSend(s, ctx, from, 'Reply', s.clock);
    } else if (m.kind === 'release') {
      dequeue(s, from);
    }
    tryEnter(ctx, s);
  }

  /** Buffer an arrival and drain the channel strictly in sequence order (FIFO). */
  function deliver(ctx: NodeContext, s: MutexState, from: string, seq: number, m: Buffered): void {
    if (!s.inBuf[from]) s.inBuf[from] = {};
    s.inBuf[from][seq] = m;
    let next = s.inExpected[from] ?? 0;
    while (s.inBuf[from][next]) {
      const msg = s.inBuf[from][next];
      delete s.inBuf[from][next];
      next++;
      handleInOrder(ctx, s, from, msg);
    }
    s.inExpected[from] = next;
  }

  return {
    name: 'Lamport Mutex',

    init(ctx) {
      const outSeq: Record<string, number> = {};
      const inExpected: Record<string, number> = {};
      const lastTsFrom: Record<string, number> = {};
      for (const p of ctx.peers) {
        outSeq[p] = 0;
        inExpected[p] = 0;
        lastTsFrom[p] = -1;
      }
      const s: MutexState = {
        self: ctx.self,
        clock: 0,
        queue: [],
        phase: 'idle',
        myReqTs: null,
        inCS: false,
        lastTsFrom,
        outSeq,
        inExpected,
        inBuf: {},
        entries: 0,
        requestedAt: null,
        enteredAt: null,
        maxWait: 0,
        note: 'idle',
      };
      ctx.setTimer('think', config.thinkDelay + ctx.rng.int(0, config.thinkDelay));
      return s;
    },

    onRestart(ctx, s) {
      // Drop any half-finished request; resume thinking.
      if (s.inCS || s.phase !== 'idle') {
        dequeue(s, ctx.self);
        s.inCS = false;
        s.phase = 'idle';
        s.myReqTs = null;
        s.clock++;
        for (const p of ctx.peers) fifoSend(s, ctx, p, 'Release', s.clock);
      }
      s.note = 'restarted';
      ctx.setTimer('think', config.thinkDelay);
    },

    onTimer(ctx, s, name) {
      if (name === 'think') {
        wantCS(ctx, s);
        if (s.phase === 'idle') ctx.setTimer('think', config.thinkDelay + ctx.rng.int(0, config.thinkDelay));
      } else if (name === 'exit') {
        leaveCS(ctx, s);
      }
    },

    onCommand(ctx, s, cmd) {
      if (cmd.type === 'request') wantCS(ctx, s);
      else if (cmd.type === 'release') leaveCS(ctx, s);
    },

    onMessage(ctx, s, msg: Message) {
      const p = msg.payload as MutexMsg;
      const kind = msg.type === 'Request' ? 'request' : msg.type === 'Reply' ? 'reply' : 'release';
      deliver(ctx, s, msg.from, p.seq, { kind, ts: p.ts });
    },
  };
}
