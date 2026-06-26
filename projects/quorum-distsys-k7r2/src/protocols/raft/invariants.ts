// The Raft safety properties, checked across the whole cluster on every render.
// These are the guarantees the algorithm must NEVER violate, no matter what the
// network or the chaos driver does — if one ever shows red, Raft is broken.
//
// Care is taken so the checks are *exactly* Raft's guarantees and never raise a
// false alarm on legitimate transient states (e.g. a partitioned stale leader,
// or an uncommitted entry that will later be overwritten). Crashed nodes are not
// acting as leaders, so leader-related checks consider only live nodes.
//
// All comparisons are by *absolute* log index, so they stay correct once nodes
// compact their logs into snapshots at independent points (entry arrays then have
// different offsets). Two extra invariants guard the two newer features:
// Snapshot Agreement (compacted prefixes never disagree) and Single-Configuration
// (a membership change never leaves the cluster believing two final configs).
import type { InvariantResult, NodeView } from '../../sim/types';
import type { ClusterConfig, RaftLogEntry, RaftState } from './types';

const sameEntry = (a: RaftLogEntry, b: RaftLogEntry) =>
  a.term === b.term && JSON.stringify(a.cmd) === JSON.stringify(b.cmd);

const lastIdx = (s: RaftState) => s.snapshotIndex + s.log.length;
const entryAt = (s: RaftState, index: number): RaftLogEntry | undefined => {
  const i = index - s.snapshotIndex - 1;
  return i >= 0 && i < s.log.length ? s.log[i] : undefined;
};
const termAt = (s: RaftState, index: number): number => {
  if (index === s.snapshotIndex) return s.snapshotTerm;
  return entryAt(s, index)?.term ?? -1;
};
const configAsOf = (s: RaftState, upto: number): ClusterConfig => {
  for (let i = s.log.length - 1; i >= 0; i--) {
    const absIdx = s.snapshotIndex + i + 1;
    if (absIdx > upto) continue;
    const c = s.log[i].cmd;
    if (c.op === 'config') return { old: c.old, next: c.next };
  }
  return s.snapshotIndex > 0 ? s.snapshotConfig : s.bootstrap;
};

export function raftInvariants(nodes: ReadonlyArray<NodeView<RaftState>>): InvariantResult[] {
  const results: InvariantResult[] = [];
  const states = nodes.map((n) => n.state);
  const liveLeaders = nodes.filter((n) => n.up && n.state.role === 'leader');

  // 1. Election Safety — at most one (live) leader per term.
  {
    const leadersByTerm = new Map<number, string[]>();
    for (const n of liveLeaders) {
      const arr = leadersByTerm.get(n.state.currentTerm) ?? [];
      arr.push(n.id);
      leadersByTerm.set(n.state.currentTerm, arr);
    }
    const bad = [...leadersByTerm.entries()].filter(([, ids]) => ids.length > 1);
    results.push({
      name: 'Election Safety',
      ok: bad.length === 0,
      detail: bad.length ? `two leaders in term ${bad[0][0]}: ${bad[0][1].join(', ')}` : 'at most one leader per term',
    });
  }

  // 2. Log Matching — same (index, term) ⇒ identical prefix.
  {
    let violation = '';
    outer: for (let a = 0; a < states.length && !violation; a++) {
      for (let b = a + 1; b < states.length; b++) {
        const sa = states[a];
        const sb = states[b];
        const lo = Math.max(sa.snapshotIndex, sb.snapshotIndex) + 1;
        const hi = Math.min(lastIdx(sa), lastIdx(sb));
        let diverged = false;
        for (let idx = lo; idx <= hi; idx++) {
          const ea = entryAt(sa, idx);
          const eb = entryAt(sb, idx);
          if (!ea || !eb) break;
          if (!sameEntry(ea, eb)) diverged = true;
          else if (diverged && ea.term === eb.term) {
            violation = `nodes ${nodes[a].id}/${nodes[b].id} share term ${ea.term} at index ${idx} but diverge earlier`;
            break outer;
          }
        }
      }
    }
    results.push({
      name: 'Log Matching',
      ok: !violation,
      detail: violation || 'matching (index, term) implies identical history',
    });
  }

  // 3. State Machine Safety — committed entries never disagree across nodes.
  {
    let violation = '';
    outer: for (let a = 0; a < states.length && !violation; a++) {
      for (let b = a + 1; b < states.length; b++) {
        const sa = states[a];
        const sb = states[b];
        const hi = Math.min(sa.commitIndex, sb.commitIndex);
        const lo = Math.max(sa.snapshotIndex, sb.snapshotIndex) + 1;
        for (let idx = lo; idx <= hi; idx++) {
          const ea = entryAt(sa, idx);
          const eb = entryAt(sb, idx);
          if (ea && eb && !sameEntry(ea, eb)) {
            violation = `committed index ${idx} differs between ${nodes[a].id} and ${nodes[b].id}`;
            break outer;
          }
        }
      }
    }
    results.push({
      name: 'State Machine Safety',
      ok: !violation,
      detail: violation || 'no two nodes apply different commands at the same index',
    });
  }

  // 4. Leader Completeness — the highest-term live leader holds every committed
  //    entry. (A lower-term partitioned "stale" leader is intentionally excluded:
  //    it is not required to have entries committed by a newer term's majority.)
  {
    const top = liveLeaders.slice().sort((a, b) => b.state.currentTerm - a.state.currentTerm)[0];
    let violation = '';
    if (top) {
      const maxCommitted = Math.max(0, ...states.map((s) => s.commitIndex));
      for (let idx = 1; idx <= maxCommitted; idx++) {
        if (idx <= top.state.snapshotIndex) continue; // the leader holds it inside its snapshot
        const holder = nodes.find((n) => n.state.commitIndex >= idx && entryAt(n.state, idx));
        if (!holder) continue;
        const ref = entryAt(holder.state, idx)!;
        const own = entryAt(top.state, idx);
        if (!own || !sameEntry(own, ref)) {
          violation = `leader ${top.id} (term ${top.state.currentTerm}) missing committed index ${idx}`;
          break;
        }
      }
    }
    results.push({
      name: 'Leader Completeness',
      ok: !violation,
      detail: violation || 'the current leader contains all committed entries',
    });
  }

  // 5. Snapshot Agreement — compacted prefixes never disagree. Any two nodes must
  //    concur on the term at the lower of their two snapshot points, and identical
  //    snapshot indices must carry identical term and state-machine contents.
  {
    let violation = '';
    outer: for (let a = 0; a < states.length && !violation; a++) {
      for (let b = a + 1; b < states.length; b++) {
        const sa = states[a];
        const sb = states[b];
        const k = Math.min(sa.snapshotIndex, sb.snapshotIndex);
        if (k > 0) {
          const ta = sa.snapshotIndex === k ? sa.snapshotTerm : termAt(sa, k);
          const tb = sb.snapshotIndex === k ? sb.snapshotTerm : termAt(sb, k);
          if (ta >= 0 && tb >= 0 && ta !== tb) {
            violation = `${nodes[a].id}/${nodes[b].id} disagree on term at snapshot index ${k}`;
            break outer;
          }
        }
        if (sa.snapshotIndex === sb.snapshotIndex && sa.snapshotIndex > 0) {
          if (sa.snapshotTerm !== sb.snapshotTerm || JSON.stringify(sa.snapshotKv) !== JSON.stringify(sb.snapshotKv)) {
            violation = `${nodes[a].id}/${nodes[b].id} snapshots at #${sa.snapshotIndex} differ`;
            break outer;
          }
        }
      }
    }
    results.push({
      name: 'Snapshot Agreement',
      ok: !violation,
      detail: violation || 'compacted prefixes are identical wherever they overlap',
    });
  }

  // 6. Configuration Agreement — a membership change is replicated through the log
  //    like any other entry, so two nodes must agree on the active cluster
  //    configuration at every index they have *both committed*. (Propagation lag —
  //    one node already on Cnew while a slower one is still on Cold,new — is fine
  //    and is NOT a violation; we only compare the shared committed prefix.)
  {
    const cfgKey = (c: ClusterConfig) => `${[...c.old].sort().join('')}${c.next ? '|' + [...c.next].sort().join('') : ''}`;
    let violation = '';
    outer: for (let a = 0; a < states.length && !violation; a++) {
      for (let b = a + 1; b < states.length; b++) {
        const k = Math.min(states[a].commitIndex, states[b].commitIndex);
        const ca = configAsOf(states[a], k);
        const cb = configAsOf(states[b], k);
        if (cfgKey(ca) !== cfgKey(cb)) {
          violation = `${nodes[a].id}/${nodes[b].id} disagree on the configuration committed at #${k}`;
          break outer;
        }
      }
    }
    results.push({
      name: 'Configuration Agreement',
      ok: !violation,
      detail: violation || 'all nodes agree on the configuration of every commonly-committed index',
    });
  }

  return results;
}
