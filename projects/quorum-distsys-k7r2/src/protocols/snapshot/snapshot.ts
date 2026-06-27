// Chandy–Lamport global snapshots over a conserved token economy.
//
// Two things run at once on every node:
//
//   1. The computation — a `tick` timer fires spontaneous transfers: move a
//      random slice of the balance to a random peer along its FIFO channel. The
//      global total is conserved; some of it lives "in flight" in the channels.
//
//   2. The snapshot — the Chandy–Lamport marker protocol:
//        • An initiator records its balance, sends a Marker on every outgoing
//          channel, and starts recording all incoming channels.
//        • On the FIRST marker it sees, a node records its balance, marks the
//          channel the marker arrived on as empty, starts recording its OTHER
//          incoming channels, and floods markers onward.
//        • A later marker on a channel CLOSES that channel's recording.
//        • Any app message that arrives on an open recording channel after the
//          node recorded its own state is added to that channel's recorded state
//          (it is in-flight money that crossed the cut).
//      A node is done when it has recorded its state and closed every incoming
//      channel; the snapshot is complete when all nodes are done.
//
// FIFO channels are a hard precondition, so every message (app AND marker) carries
// a per-channel sequence number and the receiver drains them strictly in order —
// that ordering between markers and app messages is exactly what makes the
// recorded cut consistent. See `invariants.ts` for the live proof.
import type { NodeContext, Message, Protocol } from '../../sim/types';
import {
  DEFAULT_SNAP_CONFIG,
  type SnapConfig,
  type SnapState,
  type SnapCmd,
  type AppMsg,
  type MarkerMsg,
  type Buffered,
} from './types';

export function createSnapshot(config: SnapConfig = DEFAULT_SNAP_CONFIG): Protocol<SnapState, SnapCmd> {
  /** Send a message on the FIFO channel to `to`, stamping the next sequence. */
  function fifoSend(ctx: NodeContext, s: SnapState, to: string, kind: 'app' | 'marker', extra: object): void {
    const seq = s.outSeq[to] ?? 0;
    s.outSeq[to] = seq + 1;
    ctx.send(to, kind === 'app' ? 'App' : 'Marker', { seq, ...extra });
  }

  /** A spontaneous transfer of a random slice of the balance to a random peer. */
  function doTransfer(ctx: NodeContext, s: SnapState): void {
    if (s.balance <= 0) return;
    const peer = ctx.rng.pick(ctx.peers);
    if (!peer) return;
    const cap = Math.max(1, Math.floor(s.balance * config.maxTransferFrac));
    const amount = ctx.rng.int(1, cap);
    s.balance -= amount;
    s.sent += amount;
    fifoSend(ctx, s, peer, 'app', { amount } as Omit<AppMsg, 'seq'>);
  }

  function armTick(ctx: NodeContext): void {
    ctx.setTimer('tick', config.txnDelay + ctx.rng.int(0, config.txnDelay));
  }

  /** Begin (or restart) a snapshot with this node as initiator. */
  function initiate(ctx: NodeContext, s: SnapState): void {
    const id = s.snapId + 1;
    resetRecording(s, id);
    s.recordedOwn = true;
    s.recordedState = s.balance;
    for (const p of ctx.peers) {
      s.channelState[p] = 0;
      s.channelClosed[p] = false; // record every incoming channel
    }
    s.note = `initiated snapshot #${id} @ balance ${s.balance}`;
    ctx.log('state', `initiated snapshot #${id} (recorded balance ${s.balance})`);
    for (const p of ctx.peers) fifoSend(ctx, s, p, 'marker', { snapId: id } as Omit<MarkerMsg, 'seq'>);
    checkDone(ctx, s);
  }

  /** Clear any prior recording and adopt snapshot `id`. */
  function resetRecording(s: SnapState, id: number): void {
    s.snapId = id;
    s.recordedOwn = false;
    s.recordedState = null;
    s.channelState = {};
    s.channelClosed = {};
    s.done = false;
    s.doneAt = null;
  }

  function onMarker(ctx: NodeContext, s: SnapState, from: string, snapId: number): void {
    if (snapId > s.snapId) {
      // A newer snapshot supersedes whatever this node was recording.
      resetRecording(s, snapId);
    } else if (snapId < s.snapId) {
      return; // a stale marker from a finished snapshot
    }

    if (!s.recordedOwn) {
      // First marker: record own state, close the arrival channel (empty),
      // open all others, and flood markers onward.
      s.recordedOwn = true;
      s.recordedState = s.balance;
      for (const p of ctx.peers) {
        s.channelState[p] = 0;
        s.channelClosed[p] = p === from; // the marker's own channel is empty
      }
      s.note = `recorded #${snapId} @ ${s.balance} (marker from ${from})`;
      ctx.log('state', `recorded snapshot #${snapId} @ balance ${s.balance}`);
      for (const p of ctx.peers) fifoSend(ctx, s, p, 'marker', { snapId } as Omit<MarkerMsg, 'seq'>);
    } else {
      // A subsequent marker closes that channel's recording.
      s.channelClosed[from] = true;
    }
    checkDone(ctx, s);
  }

  function checkDone(ctx: NodeContext, s: SnapState): void {
    if (s.done || !s.recordedOwn) return;
    const allClosed = ctx.peers.every((p) => s.channelClosed[p]);
    if (allClosed) {
      s.done = true;
      s.doneAt = ctx.now;
      const inflight = ctx.peers.reduce((a, p) => a + (s.channelState[p] ?? 0), 0);
      s.note = `snapshot #${s.snapId} complete: state ${s.recordedState} + ${inflight} in channels`;
      ctx.log('commit', `recorded local snapshot #${s.snapId}: ${s.recordedState} + ${inflight} in-flight`);
    }
  }

  /** Handle one in-order message drained from a channel's FIFO stream. */
  function handleInOrder(ctx: NodeContext, s: SnapState, from: string, m: Buffered): void {
    if (m.kind === 'app') {
      const amt = m.amount ?? 0;
      s.balance += amt;
      s.received += amt;
      // In-flight money crossing the cut: recorded only on an open channel after
      // this node has recorded its own state.
      if (s.recordedOwn && !s.channelClosed[from]) s.channelState[from] = (s.channelState[from] ?? 0) + amt;
    } else {
      onMarker(ctx, s, from, m.snapId ?? 0);
    }
  }

  /** Buffer an arrival and drain the channel in strict sequence order (FIFO). */
  function deliver(ctx: NodeContext, s: SnapState, from: string, seq: number, m: Buffered): void {
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
    name: 'Chandy–Lamport',

    init(ctx) {
      const outSeq: Record<string, number> = {};
      const inExpected: Record<string, number> = {};
      for (const p of ctx.peers) {
        outSeq[p] = 0;
        inExpected[p] = 0;
      }
      const s: SnapState = {
        self: ctx.self,
        balance: config.initialBalance,
        initialBalance: config.initialBalance,
        sent: 0,
        received: 0,
        outSeq,
        inExpected,
        inBuf: {},
        snapId: 0,
        recordedOwn: false,
        recordedState: null,
        channelState: {},
        channelClosed: {},
        done: false,
        doneAt: null,
        note: `balance ${config.initialBalance}`,
      };
      armTick(ctx);
      return s;
    },

    onRestart(ctx, s) {
      // A node never loses its balance/FIFO state here (we assume crash-stop is
      // rare and the snapshot just stalls); resume the computation.
      armTick(ctx);
      s.note = `restarted @ ${s.balance}`;
    },

    onTimer(ctx, s, name) {
      if (name === 'tick') {
        doTransfer(ctx, s);
        armTick(ctx);
      }
    },

    onCommand(ctx, s, cmd) {
      if (cmd.type === 'snapshot') initiate(ctx, s);
      else if (cmd.type === 'transfer') doTransfer(ctx, s);
    },

    onMessage(ctx, s, msg: Message) {
      if (msg.type === 'App') {
        const p = msg.payload as AppMsg;
        deliver(ctx, s, msg.from, p.seq, { kind: 'app', amount: p.amount });
      } else if (msg.type === 'Marker') {
        const p = msg.payload as MarkerMsg;
        deliver(ctx, s, msg.from, p.seq, { kind: 'marker', snapId: p.snapId });
      }
    },
  };
}
