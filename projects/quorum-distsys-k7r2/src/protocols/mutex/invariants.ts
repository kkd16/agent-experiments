// Lamport mutual-exclusion invariants — the live safety proof.
//
//   1. Mutual exclusion — at most one process is in the critical section at any
//      instant. This is the whole point, and it holds because requests are served
//      in a single global (ts, id) order over FIFO channels.
//   2. Holder is the queue minimum — any process in the critical section holds the
//      (ts, id)-minimum request in its own queue. This is the local precondition
//      the algorithm checks before entering; if it ever failed for a holder, the
//      ordering logic would be broken.
import type { InvariantResult, NodeView } from '../../sim/types';
import { cmpReq, type MutexState } from './types';

type View = NodeView<MutexState>;

export function mutexInvariants(views: ReadonlyArray<View>): InvariantResult[] {
  const out: InvariantResult[] = [];

  // 1. MUTUAL EXCLUSION
  {
    const holders = views.filter((v) => v.up && v.state.inCS).map((v) => v.id);
    const ok = holders.length <= 1;
    out.push({
      name: 'Mutual exclusion',
      ok,
      detail: ok
        ? holders.length === 0
          ? 'no process is in the critical section'
          : `exactly one process holds the critical section (${holders[0]})`
        : `TWO processes are in the critical section at once: ${holders.join(', ')}`,
    });
  }

  // 2. HOLDER IS THE QUEUE MINIMUM
  {
    let bad = '';
    for (const v of views) {
      if (!v.up || !v.state.inCS) continue;
      const head = v.state.queue[0];
      if (!head || head.id !== v.id) {
        bad = `${v.id} is in the CS but its own request is not the queue minimum (head: ${head ? `${head.ts}.${head.id}` : 'empty'})`;
        break;
      }
      // sanity: queue is genuinely sorted
      for (let i = 1; i < v.state.queue.length; i++) {
        if (cmpReq(v.state.queue[i - 1], v.state.queue[i]) > 0) {
          bad = `${v.id}'s queue is out of (ts,id) order`;
          break;
        }
      }
      if (bad) break;
    }
    out.push({
      name: 'Holder is the queue minimum',
      ok: !bad,
      detail: bad || 'every critical-section holder is the (ts,id)-minimum of its own request queue',
    });
  }

  return out;
}

export interface MutexGauge {
  inCS: string | null;
  wanting: number;
  idle: number;
  totalEntries: number;
  maxWait: number;
}

/** A running summary (NOT a safety check): who holds it, who's waiting, fairness. */
export function mutexGauge(views: ReadonlyArray<View>): MutexGauge {
  const live = views.filter((v) => v.up);
  const holder = live.find((v) => v.state.inCS);
  return {
    inCS: holder ? holder.id : null,
    wanting: live.filter((v) => v.state.phase === 'wanting').length,
    idle: live.filter((v) => v.state.phase === 'idle').length,
    totalEntries: views.reduce((a, v) => a + v.state.entries, 0),
    maxWait: views.reduce((a, v) => Math.max(a, v.state.maxWait), 0),
  };
}
