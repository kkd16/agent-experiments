// The Viewstamped Replication safety properties, checked across the whole cluster
// on every render. If one ever shows red under crashes, partitions and view
// changes, VR is broken.
//
// The checks are written to be *exactly* VR's guarantees and to never false-alarm
// on legitimate transient states — a replica mid view-change, a lagging backup, or
// a replica still recovering (which holds no committed state and is skipped by the
// commit-prefix comparisons because its commitNumber is 0).
import type { InvariantResult, NodeView } from '../../sim/types';
import { describeOp, primaryOf, type VrLogEntry, type VrState } from './types';

const sameEntry = (a: VrLogEntry, b: VrLogEntry) =>
  a.request.clientId === b.request.clientId &&
  a.request.requestNumber === b.request.requestNumber &&
  JSON.stringify(a.request.op) === JSON.stringify(b.request.op);

/** Replay a replica's committed prefix into a fresh key/value map. */
function replayCommitted(s: VrState): Record<string, string> {
  const kv: Record<string, string> = {};
  for (let i = 0; i < Math.min(s.commitNumber, s.log.length); i++) {
    const op = s.log[i].request.op;
    if (op.op === 'set') kv[op.key] = op.value;
    else if (op.op === 'del') delete kv[op.key];
  }
  return kv;
}

export function vrInvariants(nodes: ReadonlyArray<NodeView<VrState>>): InvariantResult[] {
  const results: InvariantResult[] = [];
  const states = nodes.map((n) => n.state);

  // 1. Agreement (the core safety property) — any two replicas agree on every
  //    committed log entry. Comparisons run only over the shared committed prefix
  //    (indices ≤ min of the two commit-numbers); uncommitted tails may legitimately
  //    differ during a view change.
  {
    let violation = '';
    outer: for (let a = 0; a < states.length && !violation; a++) {
      for (let b = a + 1; b < states.length; b++) {
        const sa = states[a];
        const sb = states[b];
        const hi = Math.min(sa.commitNumber, sb.commitNumber, sa.log.length, sb.log.length);
        for (let i = 0; i < hi; i++) {
          if (!sameEntry(sa.log[i], sb.log[i])) {
            violation = `committed op #${i + 1} differs between ${nodes[a].id} (${describeOp(sa.log[i].request.op)}) and ${nodes[b].id} (${describeOp(sb.log[i].request.op)})`;
            break outer;
          }
        }
      }
    }
    results.push({
      name: 'Agreement',
      ok: !violation,
      detail: violation || 'all replicas agree on every committed op-number',
    });
  }

  // 2. Execution Safety — each replica's executed state machine is exactly the
  //    deterministic replay of its own committed log. Execution never runs ahead of,
  //    or diverges from, the agreed order.
  {
    let violation = '';
    for (const n of nodes) {
      const want = replayCommitted(n.state);
      if (JSON.stringify(want) !== JSON.stringify(n.state.kv)) {
        // A recovering replica is mid-rebuild; its kv is allowed to be empty.
        if (n.state.status === 'recovering') continue;
        violation = `${n.id}'s state machine disagrees with the replay of its committed log`;
        break;
      }
    }
    results.push({
      name: 'Execution Safety',
      ok: !violation,
      detail: violation || 'every replica applied exactly its committed prefix, in order',
    });
  }

  // 3. Primary Uniqueness — at most one replica per view believes it is the primary
  //    and is in normal status. (Structurally guaranteed by primary = view mod N; a
  //    red here would mean the deterministic mapping was violated.)
  {
    const primariesByView = new Map<number, string[]>();
    for (const n of nodes) {
      if (!n.up || n.state.status !== 'normal') continue;
      if (primaryOf(n.state.view, n.state.configuration) === n.id) {
        const arr = primariesByView.get(n.state.view) ?? [];
        arr.push(n.id);
        primariesByView.set(n.state.view, arr);
      }
    }
    const bad = [...primariesByView.entries()].find(([, ids]) => ids.length > 1);
    results.push({
      name: 'Primary Uniqueness',
      ok: !bad,
      detail: bad ? `two primaries in view ${bad[0]}: ${bad[1].join(', ')}` : 'at most one normal primary per view',
    });
  }

  // 4. Log Well-Formed — commit-number ≤ op-number ≤ |log|, and committed entries
  //    are actually present. A cheap structural guard that catches indexing bugs.
  {
    let violation = '';
    for (const n of nodes) {
      const s = n.state;
      if (s.commitNumber > s.opNumber) {
        violation = `${n.id}: commit ${s.commitNumber} > op ${s.opNumber}`;
        break;
      }
      if (s.opNumber > s.log.length) {
        violation = `${n.id}: op ${s.opNumber} > log length ${s.log.length}`;
        break;
      }
    }
    results.push({
      name: 'Log Well-Formed',
      ok: !violation,
      detail: violation || 'commit ≤ op ≤ |log| on every replica',
    });
  }

  return results;
}
