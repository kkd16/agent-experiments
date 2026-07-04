// Zab's safety properties, checked across the whole cluster on every render. If
// one ever shows red under crashes, partitions, leader elections and epoch
// changes, Zab is broken.
//
// The checks are written to be exactly Zab's guarantees and to never false-alarm
// on legitimate transient states — a server mid-election, a follower mid-sync, or
// a lagging replica (whose *committed* prefix is still a prefix of everyone
// else's, even while its uncommitted tail differs).
import type { InvariantResult, NodeView } from '../../sim/types';
import { cmpZxid, describeOp, fmtZxid, type ZabState, type ZabTxn, type Zxid } from './types';

const sameReq = (a: ZabTxn, b: ZabTxn) =>
  a.request.clientId === b.request.clientId &&
  a.request.requestNumber === b.request.requestNumber &&
  JSON.stringify(a.request.op) === JSON.stringify(b.request.op);

/** Replay a server's committed prefix into a fresh key/value map. */
function replayCommitted(s: ZabState): Record<string, string> {
  const kv: Record<string, string> = {};
  for (let i = 0; i < Math.min(s.lastCommitted, s.history.length); i++) {
    const op = s.history[i].request.op;
    if (op.op === 'set') kv[op.key] = op.value;
    else if (op.op === 'del') delete kv[op.key];
  }
  return kv;
}

export function zabInvariants(nodes: ReadonlyArray<NodeView<ZabState>>): InvariantResult[] {
  const results: InvariantResult[] = [];
  const states = nodes.map((n) => n.state);

  // 1. Agreement / Total Order (the core safety property) — every committed
  //    transaction is identified by its zxid, and any two servers that have
  //    committed that zxid committed the *same* transaction. Equivalently, the
  //    committed histories are prefix-consistent: they never disagree at a shared
  //    committed index. (Uncommitted tails may differ during recovery.)
  {
    const byZxid = new Map<string, { txn: ZabTxn; id: string }>();
    let violation = '';
    outer: for (let a = 0; a < states.length; a++) {
      const s = states[a];
      const hi = Math.min(s.lastCommitted, s.history.length);
      for (let i = 0; i < hi; i++) {
        const txn = s.history[i];
        const key = fmtZxid(txn.zxid);
        const prev = byZxid.get(key);
        if (prev && !sameReq(prev.txn, txn)) {
          violation = `committed ${key} differs: ${nodes[a].id} has ${describeOp(txn.request.op)} but ${prev.id} has ${describeOp(prev.txn.request.op)}`;
          break outer;
        }
        if (!prev) byZxid.set(key, { txn, id: nodes[a].id });
      }
    }
    results.push({
      name: 'Agreement (total order)',
      ok: !violation,
      detail: violation || 'every committed zxid maps to one transaction on all servers',
    });
  }

  // 2. Primary Order — each server delivers transactions in strictly increasing
  //    zxid order, so a new primary's epoch dominates all earlier ones. A red here
  //    means a delivered log went backwards in (epoch, counter).
  {
    let violation = '';
    for (const n of nodes) {
      const s = n.state;
      let prev: Zxid | null = null;
      const hi = Math.min(s.lastCommitted, s.history.length);
      for (let i = 0; i < hi; i++) {
        const z = s.history[i].zxid;
        if (prev && cmpZxid(z, prev) <= 0) {
          violation = `${n.id}: committed ${fmtZxid(prev)} then ${fmtZxid(z)} (not increasing)`;
          break;
        }
        prev = z;
      }
      if (violation) break;
    }
    results.push({
      name: 'Primary Order',
      ok: !violation,
      detail: violation || 'every server delivered zxids in strictly increasing (epoch, counter) order',
    });
  }

  // 3. Leader Uniqueness — at most one server is actively leading (broadcast phase)
  //    in any epoch. Two leaders in one epoch would be a split brain.
  {
    const leadersByEpoch = new Map<number, string[]>();
    for (const n of nodes) {
      const s = n.state;
      if (!n.up || s.role !== 'leading' || s.phase !== 'broadcast') continue;
      const arr = leadersByEpoch.get(s.currentEpoch) ?? [];
      arr.push(n.id);
      leadersByEpoch.set(s.currentEpoch, arr);
    }
    const bad = [...leadersByEpoch.entries()].find(([, ids]) => ids.length > 1);
    results.push({
      name: 'Leader Uniqueness',
      ok: !bad,
      detail: bad ? `two leaders in epoch ${bad[0]}: ${bad[1].join(', ')}` : 'at most one broadcasting leader per epoch',
    });
  }

  // 4. Execution Safety — each server's state machine is exactly the deterministic
  //    replay of its own committed history. Delivery never runs ahead of, or
  //    diverges from, the agreed order.
  {
    let violation = '';
    for (const n of nodes) {
      const want = replayCommitted(n.state);
      if (JSON.stringify(want) !== JSON.stringify(n.state.kv)) {
        violation = `${n.id}'s state machine disagrees with the replay of its committed log`;
        break;
      }
    }
    results.push({
      name: 'Execution Safety',
      ok: !violation,
      detail: violation || 'every server applied exactly its committed prefix, in order',
    });
  }

  // 5. Log Well-Formed — committed ≤ |history|, and history zxids strictly increase
  //    everywhere (even in the uncommitted tail). A cheap structural guard.
  {
    let violation = '';
    for (const n of nodes) {
      const s = n.state;
      if (s.lastCommitted > s.history.length) {
        violation = `${n.id}: committed ${s.lastCommitted} > |history| ${s.history.length}`;
        break;
      }
      for (let i = 1; i < s.history.length; i++) {
        if (cmpZxid(s.history[i].zxid, s.history[i - 1].zxid) <= 0) {
          violation = `${n.id}: history zxids not increasing at #${i} (${fmtZxid(s.history[i - 1].zxid)} → ${fmtZxid(s.history[i].zxid)})`;
          break;
        }
      }
      if (violation) break;
    }
    results.push({
      name: 'Log Well-Formed',
      ok: !violation,
      detail: violation || 'committed ≤ |history| and zxids strictly increase on every server',
    });
  }

  return results;
}
