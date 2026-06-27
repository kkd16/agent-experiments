// Chandy–Lamport invariants — the live proof that the snapshot is consistent.
//
//   1. Snapshot consistency — once a snapshot completes, the recorded global state
//      (every node's recorded balance + every recorded channel's in-flight money)
//      equals the conserved total. This is the whole point of Chandy–Lamport: the
//      photograph is a *real* global state the system passed through, even though
//      it was taken while money was moving and no node ever stopped. It would go
//      red the instant the marker/FIFO logic recorded an inconsistent cut.
//   2. FIFO channels honoured — every channel is being drained in strict sequence
//      order with nothing stuck behind the read pointer. FIFO is Chandy–Lamport's
//      precondition; this watches the reorder layer that provides it.
import type { InvariantResult, NodeView } from '../../sim/types';
import type { SnapState } from './types';

type View = NodeView<SnapState>;

export function snapInvariants(views: ReadonlyArray<View>): InvariantResult[] {
  const out: InvariantResult[] = [];
  const initialTotal = views.reduce((a, v) => a + v.state.initialBalance, 0);

  // The snapshot every node is (or last was) participating in.
  const activeId = views.reduce((m, v) => Math.max(m, v.state.snapId), 0);
  const participants = views.filter((v) => v.state.snapId === activeId && activeId > 0);
  const complete = activeId > 0 && views.every((v) => v.state.snapId === activeId && v.state.done);

  // 1. SNAPSHOT CONSISTENCY
  {
    if (!complete) {
      const doneCount = participants.filter((v) => v.state.done).length;
      out.push({
        name: 'Snapshot consistency',
        ok: true,
        detail: activeId === 0 ? 'no snapshot taken yet — press “Snapshot” to record a consistent global state' : `snapshot #${activeId} in progress (${doneCount}/${views.length} nodes have recorded)`,
      });
    } else {
      let stateSum = 0;
      let channelSum = 0;
      for (const v of views) {
        stateSum += v.state.recordedState ?? 0;
        for (const p of Object.keys(v.state.channelState)) channelSum += v.state.channelState[p];
      }
      const recorded = stateSum + channelSum;
      const ok = recorded === initialTotal;
      out.push({
        name: 'Snapshot consistency',
        ok,
        detail: ok
          ? `recorded total ${recorded} = conserved total ${initialTotal} (${stateSum} in nodes + ${channelSum} in channels) — a consistent global cut`
          : `recorded ${recorded} ≠ conserved ${initialTotal} (${stateSum} in nodes + ${channelSum} in channels) — the cut is inconsistent`,
      });
    }
  }

  // 2. FIFO CHANNELS HONOURED — nothing buffered below the read pointer.
  {
    let bad = '';
    outer: for (const v of views) {
      for (const from of Object.keys(v.state.inBuf)) {
        const expected = v.state.inExpected[from] ?? 0;
        for (const seqStr of Object.keys(v.state.inBuf[from])) {
          if (Number(seqStr) < expected) {
            bad = `${v.id} holds a stale message (seq ${seqStr} < expected ${expected}) from ${from}`;
            break outer;
          }
        }
      }
    }
    out.push({
      name: 'FIFO channels honoured',
      ok: !bad,
      detail: bad || 'every channel is drained in strict send order — the Chandy–Lamport precondition holds',
    });
  }

  return out;
}

export interface SnapGauge {
  trueTotal: number;
  conserved: number;
  inFlight: number;
  done: number;
  total: number;
  activeId: number;
  complete: boolean;
  recordedTotal: number | null;
}

/** A running summary (NOT a safety check) of the live computation + snapshot. */
export function snapGauge(views: ReadonlyArray<View>): SnapGauge {
  const conserved = views.reduce((a, v) => a + v.state.initialBalance, 0);
  const balances = views.reduce((a, v) => a + v.state.balance, 0);
  const inFlight = conserved - balances; // identity: balances + in-flight = conserved
  const activeId = views.reduce((m, v) => Math.max(m, v.state.snapId), 0);
  const participants = views.filter((v) => v.state.snapId === activeId && activeId > 0);
  const done = participants.filter((v) => v.state.done).length;
  const complete = activeId > 0 && views.every((v) => v.state.snapId === activeId && v.state.done);
  let recordedTotal: number | null = null;
  if (complete) {
    let sum = 0;
    for (const v of views) {
      sum += v.state.recordedState ?? 0;
      for (const p of Object.keys(v.state.channelState)) sum += v.state.channelState[p];
    }
    recordedTotal = sum;
  }
  return { trueTotal: balances, conserved, inFlight, done, total: views.length, activeId, complete, recordedTotal };
}
